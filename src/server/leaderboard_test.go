package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func getLeaderboard(h http.Handler, method, remote string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://cs.example/leaderboard", nil)
	r.RemoteAddr = remote
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

type fakeTop struct {
	rows  []leaderboardRow
	err   error
	calls int
	limit int
}

func (f *fakeTop) top(_ context.Context, limit int) ([]leaderboardRow, error) {
	f.calls++
	f.limit = limit
	return f.rows, f.err
}

func newTestLeaderboard(f *fakeTop) (*leaderboardHandler, *time.Time) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	h := &leaderboardHandler{
		top:     f.top,
		ttl:     leaderboardCacheTTL,
		limiter: newRateLimiter(statusRate, statusBurst),
		now:     func() time.Time { return now },
		logf:    func(string, ...any) {},
	}
	return h, &now
}

func TestLeaderboardEntries(t *testing.T) {
	got := leaderboardEntries([]leaderboardRow{
		{Name: "Walter", playerTotals: playerTotals{Kills: 10, Deaths: 3, Headshots: 4, Rounds: 7}},
		{Name: "Ann", playerTotals: playerTotals{Kills: 2, Deaths: 0, Headshots: 0}},
		{Name: "Cy", playerTotals: playerTotals{Kills: 0, Deaths: 5}},
	})
	pct := func(n int64) *int64 { return &n }
	want := []leaderboardEntry{
		{Rank: 1, Name: "Walter", Kills: 10, Deaths: 3, KD: 3.33, Headshots: 4, HeadshotPct: pct(40), Rounds: 7},
		{Rank: 2, Name: "Ann", Kills: 2, KD: 2, HeadshotPct: pct(0)},
		{Rank: 3, Name: "Cy", Deaths: 5, KD: 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

func TestLeaderboardHandler(t *testing.T) {
	f := &fakeTop{rows: []leaderboardRow{
		{Name: `<img src=x onerror=alert(1)>`, playerTotals: playerTotals{Kills: 3, Deaths: 1, Headshots: 1}},
		{Name: "Bob", playerTotals: playerTotals{Deaths: 2}},
	}}
	h, now := newTestLeaderboard(f)
	w := getLeaderboard(h, http.MethodGet, "203.0.113.7:4000")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d %s", w.Code, w.Body)
	}
	for k, v := range map[string]string{"Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"} {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	body := w.Body.String()
	if strings.Contains(body, "<img") {
		t.Errorf("name not escaped: %s", body)
	}
	want := `{"players":[{"rank":1,"name":"` + "\\u003cimg src=x onerror=alert(1)\\u003e" + `","kills":3,"deaths":1,"kd":3,"headshots":1,"headshotPercent":33,"rounds":0},` +
		`{"rank":2,"name":"Bob","kills":0,"deaths":2,"kd":0,"headshots":0,"headshotPercent":null,"rounds":0}],"bots":false}`
	if body != want {
		t.Errorf("body\n%s\nwant\n%s", body, want)
	}
	if f.limit != leaderboardSize {
		t.Errorf("asked for %d rows", f.limit)
	}

	// Cached for the TTL.
	getLeaderboard(h, http.MethodGet, "203.0.113.8:4000")
	if f.calls != 1 {
		t.Errorf("%d queries within the TTL", f.calls)
	}
	*now = now.Add(leaderboardCacheTTL)
	getLeaderboard(h, http.MethodGet, "203.0.113.8:4000")
	if f.calls != 2 {
		t.Errorf("%d queries after the TTL", f.calls)
	}

	// A failure is a 503, cached too.
	f.err = errors.New("disk on fire")
	*now = now.Add(leaderboardCacheTTL)
	for i := 0; i < 2; i++ {
		if w := getLeaderboard(h, http.MethodGet, "203.0.113.8:4000"); w.Code != http.StatusServiceUnavailable {
			t.Errorf("failure: %d", w.Code)
		}
	}
	if f.calls != 3 {
		t.Errorf("%d queries, failure not cached", f.calls)
	}

	if w := getLeaderboard(h, http.MethodPost, "203.0.113.8:4000"); w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
		t.Errorf("POST: %d", w.Code)
	}
	f.err = nil
	*now = now.Add(leaderboardCacheTTL)
	if w := getLeaderboard(h, http.MethodHead, "203.0.113.8:4000"); w.Code != http.StatusOK || w.Body.Len() != 0 {
		t.Errorf("HEAD: %d %q", w.Code, w.Body)
	}
}

func TestLeaderboardRateLimit(t *testing.T) {
	h, _ := newTestLeaderboard(&fakeTop{})
	ok, limited := 0, 0
	for i := 0; i < statusBurst+5; i++ {
		w := getLeaderboard(h, http.MethodGet, "203.0.113.7:4000")
		switch w.Code {
		case http.StatusOK:
			ok++
		case http.StatusTooManyRequests:
			limited++
			if w.Header().Get("Retry-After") == "" {
				t.Error("no Retry-After")
			}
		}
	}
	if ok != statusBurst || limited != 5 {
		t.Errorf("%d ok, %d limited", ok, limited)
	}
	if w := getLeaderboard(h, http.MethodGet, "203.0.113.9:4000"); w.Code != http.StatusOK {
		t.Errorf("other address: %d", w.Code)
	}
}

func TestServerRoutesLeaderboard(t *testing.T) {
	h, _ := newTestLeaderboard(&fakeTop{rows: []leaderboardRow{{Name: "Walter"}}})
	if w := getLeaderboard(&Server{leaderboard: h}, http.MethodGet, "203.0.113.7:4000"); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Walter") {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if w := getLeaderboard(&Server{}, http.MethodGet, "203.0.113.7:4000"); w.Code != http.StatusNotFound {
		t.Fatalf("no leaderboard: %d", w.Code)
	}
}

// From the log file to the JSON, with the real database.
func TestLeaderboardFromLogs(t *testing.T) {
	ft := newFollowerTest(t)
	ft.write("L1006000.log", fileStart("L1006000.log")+
		logLine(`"Walter<7><ID_1><CT>" triggered "wc_headshot" against "Ann<8><ID_2><TERRORIST>" with "ak47"`)+
		logLine(killWalterAnn)+
		logLine(killWalterAnn)+
		logLine(`"Gilroy<3><BOT><TERRORIST>" killed "Walter<7><ID_1><CT>" with "usp"`)+
		logLine(killAnnWalter))
	ft.scan()
	h := newLeaderboardHandler(ft.db, false)
	w := getLeaderboard(h, http.MethodGet, "203.0.113.7:4000")
	var got leaderboardBody
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Players) != 2 || got.Players[0].Name != "Walter" || got.Players[0].Kills != 2 || got.Players[0].Deaths != 2 ||
		got.Players[0].KD != 1 || *got.Players[0].HeadshotPct != 50 || got.Players[1].Name != "Ann" {
		t.Errorf("got %s", w.Body)
	}
}

func TestOpenStatsDBUnwritable(t *testing.T) {
	// DATA_DIR is a regular file: no folder, no database.
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if db, err := openStatsDB(filepath.Join(file, leaderboardFile)); err == nil {
		db.Close()
		t.Error("opened a database under a regular file")
	}
}

func TestParseLeaderboardBots(t *testing.T) {
	for raw, want := range map[string][2]bool{"": {false, true}, "0": {false, true}, "1": {true, true}, "yes": {false, false}, " 1": {false, false}} {
		include, ok := parseLeaderboardBots(raw)
		if include != want[0] || ok != want[1] {
			t.Errorf("parseLeaderboardBots(%q) = %v, %v", raw, include, ok)
		}
	}
}

func TestWithGameLogging(t *testing.T) {
	got := withGameLogging([]string{"./xash", "+rcon_password", "pw", "+map de_dust2"})
	want := []string{"./xash", "+log", "on", "+mp_logecho", "0", "+rcon_password", "pw", "+map de_dust2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q", got)
	}
}
