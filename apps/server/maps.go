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
// crashed this server before. So are the files a map's maps/<map>.res lists
// (models, sounds, skies), under filesPrefix, and the ones sharedResList
// lists for every map.
const (
	mapsPrefix  = "/maps/"
	filesPrefix = mapsPrefix + "files/"
	// Files every map needs, such as replaced player models; written by the
	// Dockerfile player-models stage. Relative to the game directory.
	sharedResList = "resources.res"
)

var (
	mapNamePattern      = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)
	resourcePathPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$`)
	// Only game assets: a .res can't make the server hand out configs.
	resourceExtensions = map[string]bool{
		".bmp": true, ".mdl": true, ".mp3": true, ".spr": true,
		".tga": true, ".wad": true, ".wav": true,
	}
)

type mapInfo struct {
	Name      string         `json:"name"`
	Size      int64          `json:"size"`
	SHA256    string         `json:"sha256"`
	Resources []resourceInfo `json:"resources,omitempty"`
}

// resourceInfo is a file a map needs besides its .bsp. Path is relative to
// the game directory (models/x.mdl).
type resourceInfo struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type hashedFile struct {
	size    int64
	modTime time.Time
	sha256  string
}

type mapsHandler struct {
	dir string // the game directory (cstrike); maps are in its maps folder

	mu     sync.Mutex
	hashes map[string]hashedFile // by path relative to dir
}

func newMapsHandler(gameDir string) *mapsHandler {
	return &mapsHandler{dir: gameDir, hashes: map[string]hashedFile{}}
}

func (h *mapsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if path, ok := strings.CutPrefix(r.URL.Path, filesPrefix); ok {
		h.serveResource(w, r, path)
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
	http.ServeFile(w, r, filepath.Join(h.dir, "maps", base+".bsp"))
}

// serveResource serves a file only while a map's .res lists it.
func (h *mapsHandler) serveResource(w http.ResponseWriter, r *http.Request, path string) {
	maps, err := h.list()
	if err != nil {
		log.Errorf("Failed to list maps: %v", err)
		http.Error(w, "Failed to list maps", http.StatusInternalServerError)
		return
	}
	for _, m := range maps {
		for _, res := range m.Resources {
			if res.Path == path {
				w.Header().Set("Cache-Control", "no-cache")
				w.Header().Set("Content-Type", "application/octet-stream")
				http.ServeFile(w, r, filepath.Join(h.dir, filepath.FromSlash(path)))
				return
			}
		}
	}
	http.NotFound(w, r)
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

// list returns every .bsp in the maps directory, with the files its .res
// and sharedResList list that the server has. Hashes are cached until a file's size or
// modification time changes, so maps added to a mounted volume show up
// without a restart.
func (h *mapsHandler) list() ([]mapInfo, error) {
	entries, err := os.ReadDir(filepath.Join(h.dir, "maps"))
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
	shared := h.readResList(sharedResList)
	for _, entry := range entries {
		base, ok := strings.CutSuffix(entry.Name(), ".bsp")
		if !ok || entry.IsDir() || !mapNamePattern.MatchString(base) {
			continue
		}
		cached, ok := h.hashLocked("maps/"+entry.Name(), seen)
		if !ok {
			continue
		}
		m := mapInfo{Name: base, Size: cached.size, SHA256: cached.sha256}
		listed := map[string]bool{}
		for _, path := range append(h.readResList("maps/"+base+".res"), shared...) {
			if listed[path] {
				continue
			}
			listed[path] = true
			if res, ok := h.hashLocked(path, seen); ok {
				m.Resources = append(m.Resources, resourceInfo{Path: path, Size: res.size, SHA256: res.sha256})
			}
		}
		maps = append(maps, m)
	}
	for path := range h.hashes {
		if !seen[path] {
			delete(h.hashes, path)
		}
	}
	sort.Slice(maps, func(i, j int) bool { return maps[i].Name < maps[j].Name })
	return maps, nil
}

// hashLocked returns the size and hash of a regular file under the game
// directory, from the cache when the file hasn't changed. h.mu is held.
func (h *mapsHandler) hashLocked(path string, seen map[string]bool) (hashedFile, bool) {
	name := filepath.Join(h.dir, filepath.FromSlash(path))
	info, err := os.Stat(name)
	if err != nil || !info.Mode().IsRegular() {
		return hashedFile{}, false
	}
	cached, ok := h.hashes[path]
	if !ok || cached.size != info.Size() || !cached.modTime.Equal(info.ModTime()) {
		sum, err := hashFile(name)
		if err != nil {
			log.Warnf("Failed to hash %s: %v", path, err)
			return hashedFile{}, false
		}
		cached = hashedFile{size: info.Size(), modTime: info.ModTime(), sha256: sum}
		h.hashes[path] = cached
	}
	seen[path] = true
	return cached, true
}

// readResList returns the asset paths in the .res file at resList (one per
// line, relative to the game directory, // comments), skipping anything that
// isn't a plain relative path with an extension in resourceExtensions.
func (h *mapsHandler) readResList(resList string) []string {
	data, err := os.ReadFile(filepath.Join(h.dir, filepath.FromSlash(resList)))
	if err != nil {
		return nil
	}
	var paths []string
	added := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		path := strings.ReplaceAll(strings.Trim(strings.TrimSpace(line), `"`), `\`, "/")
		if path == "" || added[path] || !resourcePathPattern.MatchString(path) ||
			!resourceExtensions[strings.ToLower(filepath.Ext(path))] {
			continue
		}
		added[path] = true
		paths = append(paths, path)
	}
	return paths
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
