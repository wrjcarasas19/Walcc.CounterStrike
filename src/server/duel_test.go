package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func getDuel(h http.Handler, method, a, b, remote string) *httptest.ResponseRecorder {
	q := url.Values{}
	q.Set("a", a)
	q.Set("b", b)
	r := httptest.NewRequest(method, "http://cs.example/duel?"+q.Encode(), nil)
	r.RemoteAddr = remote
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

type fakeDuel struct {
	kills map[duelPair]int64
	err   error
	calls int
}

func (f *fakeDuel) duel(_ context.Context, a, b string) (int64, int64, error) {
	f.calls++
	return f.kills[duelPair{a, b}], f.kills[duelPair{b, a}], f.err
}

func newTestDuel(f *fakeDuel) (*duelHandler, *time.Time) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	h := &duelHandler{
		duel:    f.duel,
		ttl:     leaderboardCacheTTL,
		limiter: newRateLimiter(statusRate, statusBurst),
		now:     func() time.Time { return now },
		logf:    func(string, ...any) {},
	}
	return h, &now
}

func TestDuelHandler(t *testing.T) {
	f := &fakeDuel{kills: map[duelPair]int64{{"Walter", "Ann"}: 14, {"Ann", "Walter"}: 22}}
	h, now := newTestDuel(f)
	w := getDuel(h, http.MethodGet, "Ann", "Walter", "203.0.113.7:4000")
	if w.Code != http.StatusOK || w.Body.String() != `{"aKills":22,"bKills":14}` {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	for k, v := range map[string]string{"Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"} {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}

	// The other order comes from the same cache entry, swapped.
	if w := getDuel(h, http.MethodGet, "Walter", "Ann", "203.0.113.8:4000"); w.Body.String() != `{"aKills":14,"bKills":22}` {
		t.Errorf("swapped: %s", w.Body)
	}
	if f.calls != 1 {
		t.Errorf("%d queries within the TTL", f.calls)
	}
	// Another pair is its own query; unknown names are 0 – 0.
	if w := getDuel(h, http.MethodGet, "Walter", "Nobody <b>", "203.0.113.8:4000"); w.Code != http.StatusOK || w.Body.String() != `{"aKills":0,"bKills":0}` {
		t.Errorf("unknown: %d %s", w.Code, w.Body)
	}
	if f.calls != 2 {
		t.Errorf("%d queries for two pairs", f.calls)
	}
	*now = now.Add(leaderboardCacheTTL)
	f.kills[duelPair{"Walter", "Ann"}]++
	if w := getDuel(h, http.MethodGet, "Walter", "Ann", "203.0.113.8:4000"); w.Body.String() != `{"aKills":15,"bKills":22}` {
		t.Errorf("after the TTL: %s", w.Body)
	}

	// A failure is a 503, cached too.
	f.err = errors.New("disk on fire")
	*now = now.Add(leaderboardCacheTTL)
	calls := f.calls
	for i := 0; i < 2; i++ {
		if w := getDuel(h, http.MethodGet, "Walter", "Ann", "203.0.113.8:4000"); w.Code != http.StatusServiceUnavailable {
			t.Errorf("failure: %d", w.Code)
		}
	}
	if f.calls != calls+1 {
		t.Errorf("%d queries, failure not cached", f.calls-calls)
	}
	f.err = nil
	*now = now.Add(leaderboardCacheTTL)

	// Names: both needed, up to statsNameMax bytes; no query for a bad one.
	calls = f.calls
	long := strings.Repeat("x", statsNameMax)
	for _, c := range [][2]string{{"", "Ann"}, {"Ann", ""}, {long + "x", "Ann"}, {"Ann", long + "x"}} {
		if w := getDuel(h, http.MethodGet, c[0], c[1], "203.0.113.9:4000"); w.Code != http.StatusBadRequest {
			t.Errorf("a=%q b=%q: %d", c[0], c[1], w.Code)
		}
	}
	if f.calls != calls {
		t.Errorf("queried for bad names")
	}
	if w := getDuel(h, http.MethodGet, long, "Ann", "203.0.113.9:4000"); w.Code != http.StatusOK {
		t.Errorf("name of %d bytes: %d", statsNameMax, w.Code)
	}

	if w := getDuel(h, http.MethodPost, "Walter", "Ann", "203.0.113.9:4000"); w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
		t.Errorf("POST: %d", w.Code)
	}
	if w := getDuel(h, http.MethodHead, "Walter", "Ann", "203.0.113.9:4000"); w.Code != http.StatusOK || w.Body.Len() != 0 {
		t.Errorf("HEAD: %d %q", w.Code, w.Body)
	}
}

func TestDuelCacheBounded(t *testing.T) {
	f := &fakeDuel{}
	h, now := newTestDuel(f)
	for i := 0; i < duelCacheMax*2; i++ {
		h.get("Walter", strings.Repeat("a", i%statsNameMax)+string(rune('A'+i/statsNameMax)))
		if i == duelCacheMax {
			*now = now.Add(leaderboardCacheTTL)
		}
	}
	if len(h.cache) > duelCacheMax {
		t.Errorf("%d cached pairs", len(h.cache))
	}
}

func TestDuelRateLimit(t *testing.T) {
	h, _ := newTestDuel(&fakeDuel{})
	ok, limited := 0, 0
	for i := 0; i < statusBurst+5; i++ {
		switch getDuel(h, http.MethodGet, "Walter", "Ann", "203.0.113.7:4000").Code {
		case http.StatusOK:
			ok++
		case http.StatusTooManyRequests:
			limited++
		}
	}
	if ok != statusBurst || limited != 5 {
		t.Errorf("%d ok, %d limited", ok, limited)
	}
}

func TestServerRoutesDuel(t *testing.T) {
	h, _ := newTestDuel(&fakeDuel{kills: map[duelPair]int64{{"Walter", "Ann"}: 3}})
	if w := getDuel(&Server{duel: h}, http.MethodGet, "Walter", "Ann", "203.0.113.7:4000"); w.Code != http.StatusOK || w.Body.String() != `{"aKills":3,"bKills":0}` {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	// Database off: 404, like /leaderboard.
	if w := getDuel(&Server{}, http.MethodGet, "Walter", "Ann", "203.0.113.7:4000"); w.Code != http.StatusNotFound {
		t.Fatalf("no database: %d", w.Code)
	}
}

// From the log file to the JSON, with the real database.
func TestDuelFromLogs(t *testing.T) {
	ft := newFollowerTest(t)
	ft.write("L1006000.log", fileStart("L1006000.log")+
		logLine(killWalterAnn)+
		logLine(killWalterAnn)+
		logLine(killAnnWalter)+
		logLine(`"Ann<8><ID_2><TERRORIST>" changed name to "Anna"`)+
		logLine(`"Walter<7><ID_1><CT>" killed "Anna<8><ID_2><TERRORIST>" with "ak47"`))
	ft.scan()
	h := newDuelHandler(ft.db)
	if w := getDuel(h, http.MethodGet, "Ann", "Walter", "203.0.113.7:4000"); w.Body.String() != `{"aKills":1,"bKills":2}` {
		t.Errorf("Ann v Walter: %d %s", w.Code, w.Body)
	}
	if w := getDuel(h, http.MethodGet, "Walter", "Anna", "203.0.113.7:4000"); w.Body.String() != `{"aKills":1,"bKills":0}` {
		t.Errorf("Walter v Anna: %d %s", w.Code, w.Body)
	}
}

// A claimed name in any spelling is looked up under the claimed spelling;
// other names as typed.
func TestDuelHandlerClaimedNames(t *testing.T) {
	db, err := openStatsDB(filepath.Join(t.TempDir(), leaderboardFile))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	now := time.Unix(1791000000, 0)
	if err := db.commit(ctx, "L1007001.log", logFileRecord{Fingerprint: "f", Offset: 1}, nil, map[duelPair]int64{
		{Killer: "Walter", Victim: "Ann"}: 3,
		{Killer: "Ann", Victim: "Walter"}: 1,
		{Killer: "walter", Victim: "Ann"}: 5,
	}, now); err != nil {
		t.Fatal(err)
	}
	h := newDuelHandler(db)
	h.limiter = newRateLimiter(1000, 1000)
	check := func(a, b, want string) {
		t.Helper()
		if w := getDuel(h, http.MethodGet, a, b, "203.0.113.7:4000"); w.Code != http.StatusOK || w.Body.String() != want {
			t.Errorf("%s vs %s: %d %s, want %s", a, b, w.Code, w.Body, want)
		}
	}
	check("walter", "Ann", `{"aKills":5,"bKills":0}`)
	if err := db.createClaim(ctx, nameClaim{Key: "walter", Name: "Walter", CodeHash: "x"}, "", "hash-a", now); err != nil {
		t.Fatal(err)
	}
	h.cache = nil
	for _, a := range []string{"walter", "Walter", "^1WALTER (1)", " Walter "} {
		check(a, "Ann", `{"aKills":3,"bKills":1}`)
		check("Ann", a, `{"aKills":1,"bKills":3}`)
	}
	check("Walter (guest)", "Ann", `{"aKills":0,"bKills":0}`)
}
