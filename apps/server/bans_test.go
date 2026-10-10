package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAddressKey(t *testing.T) {
	for host, want := range map[string]string{
		"203.0.113.7":            "203.0.113.7",
		"::ffff:203.0.113.7":     "203.0.113.7",
		"2001:db8:1:2:3:4:5:6":   "2001:db8:1:2::/64",
		"2001:0db8:0001:0002::1": "2001:db8:1:2::/64",
		"not-an-ip":              "not-an-ip",
	} {
		if got := addressKey(host); got != want {
			t.Errorf("addressKey(%q) = %q, want %q", host, got, want)
		}
	}
}

func TestNormalizeBanAddress(t *testing.T) {
	for address, want := range map[string]string{
		"203.0.113.7":             "203.0.113.7",
		"::ffff:203.0.113.7":      "203.0.113.7",
		"2001:db8:1:2::/64":       "2001:db8:1:2::/64",
		"2001:db8:1:2:a:b:c:d/64": "2001:db8:1:2::/64",
	} {
		if got, ok := normalizeBanAddress(address); !ok || got != want {
			t.Errorf("normalizeBanAddress(%q) = %q, %v; want %q", address, got, ok, want)
		}
	}
	for _, address := range []string{
		"", "x", "203.0.113", "203.0.113.7/32", "203.0.113.0/24", "2001:db8::1",
		"2001:db8::/48", "2001:db8::/128", "203.0.113.7;quit", " 203.0.113.7",
	} {
		if got, ok := normalizeBanAddress(address); ok {
			t.Errorf("normalizeBanAddress(%q) accepted as %q", address, got)
		}
	}
}

func TestBanListAddMatchRemove(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", bansFile)
	l, err := loadBanList(path)
	if err != nil {
		t.Fatal(err)
	}
	if l.banned("203.0.113.7") || len(l.list()) != 0 {
		t.Fatal("new list isn't empty")
	}
	at := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	for i, address := range []string{"203.0.113.7", "2001:db8:1:2::/64"} {
		added, err := l.add(banEntry{Address: address, Name: "p", BannedAt: at.Add(time.Duration(i) * time.Minute)})
		if err != nil || !added {
			t.Fatalf("add %s = %v, %v", address, added, err)
		}
	}
	if added, err := l.add(banEntry{Address: "203.0.113.7", Name: "again", BannedAt: at}); added || err != nil {
		t.Fatalf("second add = %v, %v", added, err)
	}
	for key, want := range map[string]bool{
		"203.0.113.7":                 true,
		"203.0.113.8":                 false,
		addressKey("2001:db8:1:2::9"): true,
		addressKey("2001:db8:1:3::9"): false,
	} {
		if got := l.banned(key); got != want {
			t.Errorf("banned(%q) = %v, want %v", key, got, want)
		}
	}
	// Newest first; the second add kept the first name.
	got := l.list()
	if len(got) != 2 || got[0].Address != "2001:db8:1:2::/64" || got[1].Name != "p" {
		t.Fatalf("list = %+v", got)
	}

	if removed, err := l.remove("203.0.113.7"); !removed || err != nil {
		t.Fatalf("remove = %v, %v", removed, err)
	}
	if removed, err := l.remove("203.0.113.7"); removed || err != nil {
		t.Fatalf("second remove = %v, %v", removed, err)
	}
	if l.banned("203.0.113.7") {
		t.Fatal("still banned after remove")
	}

	var none *banList
	if none.banned("203.0.113.7") || len(none.list()) != 0 {
		t.Fatal("nil list bans someone")
	}
}

func TestBanListPersists(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	path := filepath.Join(dir, bansFile)
	l, _ := loadBanList(path)
	at := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	l.add(banEntry{Address: "203.0.113.7", Name: `Odd "name" ✓`, BannedAt: at})
	l.add(banEntry{Address: "198.51.100.1", Name: "other", BannedAt: at})
	l.remove("198.51.100.1")

	again, err := loadBanList(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := l.list(); !reflect.DeepEqual(again.list(), want) || len(want) != 1 {
		t.Fatalf("reloaded %+v, want %+v", again.list(), want)
	}
	// Only the file itself is left behind (no temporary files).
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != bansFile {
		t.Fatalf("data dir has %v", entries)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), `"address": "203.0.113.7"`) {
		t.Fatalf("file = %s", data)
	}

	// Addresses in the file are normalized on load.
	os.WriteFile(path, []byte(`{"bans":[{"address":"2001:db8:1:2::5/64","name":"x"}]}`), 0o600)
	again, err = loadBanList(path)
	if err != nil || !again.banned("2001:db8:1:2::/64") {
		t.Fatalf("hand-written file: %v, %+v", err, again.list())
	}
}

func TestBanListBrokenFileIsKept(t *testing.T) {
	for name, content := range map[string]string{
		"not json":    "{bans",
		"bad address": `{"bans":[{"address":"203.0.113.0/24"}]}`,
	} {
		path := filepath.Join(t.TempDir(), bansFile)
		os.WriteFile(path, []byte(content), 0o600)
		l, err := loadBanList(path)
		if err == nil {
			t.Errorf("%s: no error", name)
		}
		if _, err := l.add(banEntry{Address: "203.0.113.7"}); err == nil {
			t.Errorf("%s: add accepted", name)
		}
		if data, _ := os.ReadFile(path); string(data) != content {
			t.Errorf("%s: file overwritten with %s", name, data)
		}
	}
}

func TestBanListSaveFailureKeepsMemory(t *testing.T) {
	dir := t.TempDir()
	// The data "directory" is a file, so saving fails.
	blocker := filepath.Join(dir, "data")
	os.WriteFile(blocker, nil, 0o600)
	l, _ := loadBanList(filepath.Join(blocker, bansFile))
	if added, err := l.add(banEntry{Address: "203.0.113.7"}); added || err == nil {
		t.Fatalf("add = %v, %v", added, err)
	}
	if l.banned("203.0.113.7") {
		t.Fatal("ban kept although it wasn't saved")
	}
}

func TestWebsocketRefusesBannedAddress(t *testing.T) {
	old := bans
	t.Cleanup(func() { bans = old })
	bans, _ = loadBanList(filepath.Join(t.TempDir(), bansFile))
	bans.add(banEntry{Address: "203.0.113.7"})
	bans.add(banEntry{Address: "2001:db8:1:2::/64"})

	for remote, want := range map[string]int{
		"203.0.113.7:4000":         http.StatusForbidden,
		"[2001:db8:1:2::77]:4000":  http.StatusForbidden,
		"[::ffff:203.0.113.7]:400": http.StatusForbidden,
		// Not banned: the request goes on to the upgrade, which fails
		// without WebSocket headers (400), before any WebRTC setup.
		"203.0.113.8:4000":        http.StatusBadRequest,
		"[2001:db8:1:3::77]:4000": http.StatusBadRequest,
	} {
		r := httptest.NewRequest(http.MethodGet, "http://cs.example/websocket", nil)
		r.RemoteAddr = remote
		rec := httptest.NewRecorder()
		websocketHandler(rec, r)
		if rec.Code != want {
			t.Errorf("%s = %d, want %d", remote, rec.Code, want)
		}
	}
}
