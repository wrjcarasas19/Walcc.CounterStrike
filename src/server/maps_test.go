package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestMapsHandler(t *testing.T) {
	dir := t.TempDir()
	bsp := []byte("BSP map data")
	if err := os.WriteFile(filepath.Join(dir, "de_custom.bsp"), bsp, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "de_custom.txt"), []byte("notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := newMapsHandler(dir)

	get := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		return rec
	}

	rec := get("/maps/index.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("index status = %d", rec.Code)
	}
	var maps []mapInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &maps); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(bsp)
	want := mapInfo{Name: "de_custom", Size: int64(len(bsp)), SHA256: hex.EncodeToString(sum[:])}
	if len(maps) != 1 || maps[0] != want {
		t.Fatalf("index = %+v, want [%+v]", maps, want)
	}

	rec = get("/maps/de_custom.bsp")
	if rec.Code != http.StatusOK || rec.Body.String() != string(bsp) {
		t.Fatalf("map status = %d, body = %q", rec.Code, rec.Body.String())
	}

	for _, target := range []string{
		"/maps/de_custom.txt",
		"/maps/missing.bsp",
		"/maps/..%2Fsecret.bsp",
		"/maps/sub/de_custom.bsp",
	} {
		if rec := get(target); rec.Code != http.StatusNotFound {
			t.Errorf("%s status = %d, want 404", target, rec.Code)
		}
	}
}

func TestMapsHandlerMissingDir(t *testing.T) {
	h := newMapsHandler(filepath.Join(t.TempDir(), "missing"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maps/index.json", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "[]\n" {
		t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
	}
}
