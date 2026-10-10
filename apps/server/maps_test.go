package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMapsHandler(t *testing.T) {
	gameDir := t.TempDir()
	dir := filepath.Join(gameDir, "maps")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	bsp := []byte("BSP map data")
	if err := os.WriteFile(filepath.Join(dir, "de_custom.bsp"), bsp, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "de_custom.txt"), []byte("notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := newMapsHandler(gameDir)

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
	if len(maps) != 1 || !reflect.DeepEqual(maps[0], want) {
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

func TestMapsHandlerResources(t *testing.T) {
	gameDir := t.TempDir()
	files := map[string]string{
		"maps/de_res.bsp":     "BSP",
		"models/res/a.mdl":    "model",
		"gfx/env/skyup.tga":   "sky",
		"server.cfg":          "rcon_password secret",
		"models/unlisted.mdl": "other",
		"maps/de_res.res": "// comment\r\n" +
			"models/res/a.mdl\r\n" +
			"gfx\\env\\skyup.tga // sky\n" +
			"sound/missing.wav\n" +
			"server.cfg\n" +
			"../secret.wav\n" +
			"/abs.wav\n" +
			"models/res/a.mdl\n",
	}
	for name, data := range files {
		path := filepath.Join(gameDir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := newMapsHandler(gameDir)

	get := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
		return rec
	}
	resource := func(path string) resourceInfo {
		sum := sha256.Sum256([]byte(files[path]))
		return resourceInfo{Path: path, Size: int64(len(files[path])), SHA256: hex.EncodeToString(sum[:])}
	}

	var maps []mapInfo
	if err := json.Unmarshal(get("/maps/index.json").Body.Bytes(), &maps); err != nil {
		t.Fatal(err)
	}
	want := []resourceInfo{resource("models/res/a.mdl"), resource("gfx/env/skyup.tga")}
	if len(maps) != 1 || !reflect.DeepEqual(maps[0].Resources, want) {
		t.Fatalf("index = %+v, want resources %+v", maps, want)
	}

	if rec := get("/maps/files/models/res/a.mdl"); rec.Code != http.StatusOK || rec.Body.String() != "model" {
		t.Fatalf("resource status = %d, body = %q", rec.Code, rec.Body.String())
	}
	for _, target := range []string{
		"/maps/files/server.cfg",
		"/maps/files/models/unlisted.mdl",
		"/maps/files/sound/missing.wav",
		"/maps/files/maps/de_res.bsp",
		"/maps/files/../server.cfg",
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
