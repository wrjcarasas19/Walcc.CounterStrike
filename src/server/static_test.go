package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAcceptsGzip(t *testing.T) {
	cases := map[string]bool{
		"":                      false,
		"gzip":                  true,
		"gzip, deflate, br":     true,
		"br;q=1.0, GZIP;q=0.5":  true,
		"gzip;q=0":              false,
		"identity":              false,
		"*":                     true,
		"gzip;q=0, *":           false,
		"deflate, *;q=0.1":      true,
		"gzip; q=0.000, br":     false,
		"x-gzip, deflate":       false,
		"gzip;level=1;q=0.8":    true,
		"compress, *;q=0, gzip": true,
	}
	for header, want := range cases {
		if got := acceptsGzip(header); got != want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", header, got, want)
		}
	}
}

func TestStaticHandler(t *testing.T) {
	dir := t.TempDir()
	js := []byte(strings.Repeat("console.log('hello');\n", 200))
	index := []byte("<!doctype html>" + strings.Repeat("<p>hi</p>", 100))
	mustWrite(t, filepath.Join(dir, "index.html"), index)
	mustWrite(t, filepath.Join(dir, "assets", "index-abc.js"), js)
	mustWrite(t, filepath.Join(dir, "favicon.ico"), []byte{0, 1, 2})
	wasm := append([]byte("\x00asm\x01\x00\x00\x00"), make([]byte, 4096)...)
	mustWrite(t, filepath.Join(dir, "assets", "game-abc.so"), wasm)
	h := newStaticHandler(dir)

	get := func(target string, header http.Header) *http.Response {
		r := httptest.NewRequest(http.MethodGet, target, nil)
		for k, v := range header {
			r.Header[k] = v
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Result()
	}
	gzipHeader := http.Header{"Accept-Encoding": {"gzip"}}

	res := get("/", nil)
	if res.StatusCode != http.StatusOK || res.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("/: status %d, Cache-Control %q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
	if body, _ := io.ReadAll(res.Body); !bytes.Equal(body, index) {
		t.Fatal("/ did not serve index.html")
	}

	res = get("/assets/index-abc.js", nil)
	if res.StatusCode != http.StatusOK || res.Header.Get("Cache-Control") != immutableCaching ||
		res.Header.Get("Content-Encoding") != "" {
		t.Fatalf("asset: status %d, headers %v", res.StatusCode, res.Header)
	}

	for _, target := range []string{"/", "/assets/index-abc.js"} {
		res = get(target, gzipHeader)
		if res.Header.Get("Content-Encoding") != "gzip" || res.Header.Get("Vary") != "Accept-Encoding" {
			t.Fatalf("%s gzip: headers %v", target, res.Header)
		}
		if !strings.HasPrefix(res.Header.Get("Content-Type"), map[string]string{"/": "text/html", "/assets/index-abc.js": "text/javascript"}[target]) {
			t.Fatalf("%s gzip: Content-Type %q", target, res.Header.Get("Content-Type"))
		}
		if res.ContentLength <= 0 {
			t.Fatalf("%s gzip: no Content-Length", target)
		}
		zr, err := gzip.NewReader(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(zr)
		want := map[string][]byte{"/": index, "/assets/index-abc.js": js}[target]
		if !bytes.Equal(body, want) {
			t.Fatalf("%s gzip: body differs", target)
		}
	}

	// No extension type: both encodings get the sniffed type of the raw file.
	for _, header := range []http.Header{nil, gzipHeader} {
		res = get("/assets/game-abc.so", header)
		if ct := res.Header.Get("Content-Type"); ct != "application/wasm" {
			t.Fatalf(".so (%v): Content-Type %q", header, ct)
		}
	}

	res = get("/assets/index-abc.js", http.Header{"Accept-Encoding": {"gzip"}, "Range": {"bytes=0-9"}})
	if res.StatusCode != http.StatusPartialContent || res.Header.Get("Content-Encoding") != "" {
		t.Fatalf("range: status %d, headers %v", res.StatusCode, res.Header)
	}
	if body, _ := io.ReadAll(res.Body); !bytes.Equal(body, js[:10]) {
		t.Fatalf("range: body %q", body)
	}

	res = get("/favicon.ico", gzipHeader)
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Encoding") != "" {
		t.Fatalf("favicon: status %d, headers %v", res.StatusCode, res.Header)
	}

	for _, target := range []string{"/assets/missing.js", "/missing.txt", "/assets/", "/assets"} {
		res = get(target, gzipHeader)
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404", target, res.StatusCode)
		}
		if cc := res.Header.Get("Cache-Control"); cc != "" {
			t.Fatalf("%s: 404 has Cache-Control %q", target, cc)
		}
	}
}

func mustWrite(t *testing.T, name string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, data, 0o644); err != nil {
		t.Fatal(err)
	}
}
