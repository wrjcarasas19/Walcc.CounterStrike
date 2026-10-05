package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Maps are served over HTTP instead of the engine's in-game download, which
// pushes large fragmented transfers through Netchan_TransmitBits and has
// crashed this server before.
const mapsPrefix = "/maps/"

var mapNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

type mapInfo struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type hashedMap struct {
	size    int64
	modTime time.Time
	sha256  string
}

type mapsHandler struct {
	dir string

	mu     sync.Mutex
	hashes map[string]hashedMap // by map name
}

func newMapsHandler(dir string) *mapsHandler {
	return &mapsHandler{dir: dir, hashes: map[string]hashedMap{}}
}

func (h *mapsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, mapsPrefix)
	if name == "index.json" {
		h.serveIndex(w)
		return
	}
	base, ok := strings.CutSuffix(name, ".bsp")
	if !ok || !mapNamePattern.MatchString(base) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, filepath.Join(h.dir, base+".bsp"))
}

func (h *mapsHandler) serveIndex(w http.ResponseWriter) {
	maps, err := h.list()
	if err != nil {
		log.Errorf("Failed to list maps: %v", err)
		http.Error(w, "Failed to list maps", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(maps)
}

// list returns every .bsp in the maps directory. Hashes are cached until a
// file's size or modification time changes, so maps added to a mounted
// volume show up without a restart.
func (h *mapsHandler) list() ([]mapInfo, error) {
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []mapInfo{}, nil
		}
		return nil, err
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	maps := []mapInfo{}
	seen := map[string]bool{}
	for _, entry := range entries {
		base, ok := strings.CutSuffix(entry.Name(), ".bsp")
		if !ok || entry.IsDir() || !mapNamePattern.MatchString(base) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		cached, ok := h.hashes[base]
		if !ok || cached.size != info.Size() || !cached.modTime.Equal(info.ModTime()) {
			sum, err := hashFile(filepath.Join(h.dir, entry.Name()))
			if err != nil {
				log.Warnf("Failed to hash map %s: %v", entry.Name(), err)
				continue
			}
			cached = hashedMap{size: info.Size(), modTime: info.ModTime(), sha256: sum}
			h.hashes[base] = cached
		}
		seen[base] = true
		maps = append(maps, mapInfo{Name: base, Size: cached.size, SHA256: cached.sha256})
	}
	for name := range h.hashes {
		if !seen[name] {
			delete(h.hashes, name)
		}
	}
	sort.Slice(maps, func(i, j int) bool { return maps[i].Name < maps[j].Name })
	return maps, nil
}

func hashFile(name string) (string, error) {
	f, err := os.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sum := sha256.New()
	if _, err := io.Copy(sum, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}
