package main

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// Vite emits content-hashed file names under /assets/.
	assetsPrefix     = "/assets/"
	immutableCaching = "public, max-age=31536000, immutable"

	maxGzipFileSize  = 64 << 20
	maxGzipTotalSize = 256 << 20
)

var compressibleExts = map[string]bool{
	".css":  true,
	".html": true,
	".js":   true,
	".json": true,
	".so":   true, // the wasm game library
	".svg":  true,
	".wasm": true,
}

type gzipFile struct {
	data        []byte
	contentType string
	modTime     time.Time
}

// staticHandler serves the client build. Compressible files are gzipped once
// at startup and served from memory to clients that accept gzip.
type staticHandler struct {
	files   http.Handler
	gzipped map[string]gzipFile // by URL path
}

func newStaticHandler(dir string) *staticHandler {
	h := &staticHandler{
		files:   http.FileServer(noListingFS{http.Dir(dir)}),
		gzipped: map[string]gzipFile{},
	}
	total := 0
	err := filepath.WalkDir(dir, func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !compressibleExts[filepath.Ext(name)] {
			return err
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxGzipFileSize || total+int(info.Size()) > maxGzipTotalSize {
			return err
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		if _, err := zw.Write(raw); err != nil {
			return err
		}
		if err := zw.Close(); err != nil {
			return err
		}
		if buf.Len() >= len(raw) {
			return nil
		}
		rel, err := filepath.Rel(dir, name)
		if err != nil {
			return err
		}
		urlPath := "/" + filepath.ToSlash(rel)
		if urlPath == "/index.html" {
			// FileServer serves index.html at "/" and redirects its own path.
			urlPath = "/"
		}
		// Detect the type now; sniffing the gzipped bytes would give x-gzip.
		contentType := mime.TypeByExtension(filepath.Ext(name))
		if contentType == "" {
			contentType = http.DetectContentType(raw)
		}
		h.gzipped[urlPath] = gzipFile{data: buf.Bytes(), contentType: contentType, modTime: info.ModTime()}
		total += buf.Len()
		return nil
	})
	if err != nil {
		log.Warnf("Failed to precompress static files: %v", err)
	}
	return h
}

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Error responses drop Cache-Control (net/http since Go 1.23).
	if strings.HasPrefix(r.URL.Path, assetsPrefix) {
		w.Header().Set("Cache-Control", immutableCaching)
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}

	name := r.URL.Path
	if name == "/" {
		name = "/index.html"
	}
	if !compressibleExts[path.Ext(name)] {
		h.files.ServeHTTP(w, r)
		return
	}
	w.Header().Add("Vary", "Accept-Encoding")

	// Exact match on the raw path: anything unusual goes to FileServer. Range
	// requests get the identity encoding so byte offsets match the file.
	gz, ok := h.gzipped[r.URL.Path]
	if !ok || r.Header.Get("Range") != "" || !acceptsGzip(r.Header.Get("Accept-Encoding")) {
		h.files.ServeHTTP(w, r)
		return
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Content-Type", gz.contentType)
	// ServeContent omits Content-Length when Content-Encoding is set.
	w.Header().Set("Content-Length", strconv.Itoa(len(gz.data)))
	http.ServeContent(w, r, name, gz.modTime, bytes.NewReader(gz.data))
}

// acceptsGzip reports whether an Accept-Encoding header allows gzip; an
// explicit gzip entry takes precedence over "*".
func acceptsGzip(header string) bool {
	gzipQ, anyQ := -1.0, -1.0
	for _, part := range strings.Split(header, ",") {
		coding, params, _ := strings.Cut(part, ";")
		coding = strings.ToLower(strings.TrimSpace(coding))
		if coding != "gzip" && coding != "*" {
			continue
		}
		q := 1.0
		for _, param := range strings.Split(params, ";") {
			key, value, _ := strings.Cut(strings.TrimSpace(param), "=")
			if strings.EqualFold(key, "q") {
				if v, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
					q = v
				}
			}
		}
		if coding == "gzip" {
			gzipQ = q
		} else {
			anyQ = q
		}
	}
	return gzipQ > 0 || (gzipQ < 0 && anyQ > 0)
}

// noListingFS hides directories without an index.html, so FileServer returns
// 404 instead of a directory listing.
type noListingFS struct {
	fs http.FileSystem
}

func (n noListingFS) Open(name string) (http.File, error) {
	f, err := n.fs.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if info.IsDir() {
		index, err := n.fs.Open(path.Join(name, "index.html"))
		if err != nil {
			f.Close()
			return nil, os.ErrNotExist
		}
		index.Close()
	}
	return f, nil
}
