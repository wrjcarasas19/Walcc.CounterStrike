package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseBotQuota(t *testing.T) {
	for raw, want := range map[string]int{"": 0, "0": 0, "6": 6, "06": 6, "32": 32} {
		got, ok := parseBotQuota(raw)
		if !ok || got != want {
			t.Errorf("parseBotQuota(%q) = %d, %v; want %d, true", raw, got, ok, want)
		}
	}
}

func TestParseBotQuotaRejectsBadValues(t *testing.T) {
	for _, raw := range []string{"33", "99", "100", "-1", "+6", " 6", "6 ", "6.0", "1e1", "six", "6;quit", "0x6"} {
		got, ok := parseBotQuota(raw)
		if ok || got != 0 {
			t.Errorf("parseBotQuota(%q) = %d, %v; want 0, false", raw, got, ok)
		}
	}
}

const yapbCfgSample = `//
// Specifies the number bots to be added to the game.
// Default: "9", Min: "0", Max: "32"
yb_quota "0"

// Specifies the type of quota.
yb_quota_mode "normal"

// Number of players to match if yb_quota_mode set to 'match'
yb_quota_match "0"
yb_quota_adding_interval "0.1"
`

func TestSetBotQuotaFill(t *testing.T) {
	got := string(setBotQuota([]byte(yapbCfgSample), 6))
	want := `//
// Specifies the number bots to be added to the game.
// Default: "9", Min: "0", Max: "32"
yb_quota "6"

// Specifies the type of quota.
yb_quota_mode "fill"

// Number of players to match if yb_quota_mode set to 'match'
yb_quota_match "0"
yb_quota_adding_interval "0.1"
`
	if got != want {
		t.Fatalf("setBotQuota() =\n%s\nwant\n%s", got, want)
	}
}

func TestSetBotQuotaZeroIsNormalMode(t *testing.T) {
	filled := setBotQuota([]byte(yapbCfgSample), 6)
	if got := string(setBotQuota(filled, 0)); got != yapbCfgSample {
		t.Fatalf("setBotQuota(0) =\n%s\nwant\n%s", got, yapbCfgSample)
	}
}

func TestSetBotQuotaAddsMissingLines(t *testing.T) {
	got := string(setBotQuota([]byte(`yb_difficulty "3"`), 4))
	want := "yb_difficulty \"3\"\nyb_quota \"4\"\nyb_quota_mode \"fill\"\n"
	if got != want {
		t.Fatalf("setBotQuota() = %q, want %q", got, want)
	}
}

func TestWriteBotQuota(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, yapbConfPath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(yapbCfgSample), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := writeBotQuota(base, 6); err != nil {
		t.Fatalf("writeBotQuota() error = %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := setBotQuota([]byte(yapbCfgSample), 6); string(got) != string(want) {
		t.Fatalf("file =\n%s\nwant\n%s", got, want)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %v, want 0640", info.Mode().Perm())
	}
}

func TestWriteBotQuotaMissingFile(t *testing.T) {
	if err := writeBotQuota(t.TempDir(), 6); err == nil {
		t.Fatal("writeBotQuota() with no yapb.cfg should fail")
	}
}
