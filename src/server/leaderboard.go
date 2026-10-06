package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// GET /leaderboard is the top players by kills since the leaderboard
// database was created (statsdb.go, filled by statsfollow.go). Names are
// whatever players typed: nothing is verified, anyone can play under any
// name and add to its totals.
//
// Like /status.json it is cached (leaderboardCacheTTL; the database only
// changes when the follower reads new log lines) and rate limited per
// address.

const (
	leaderboardSize     = 20
	leaderboardCacheTTL = 5 * time.Second
	leaderboardTimeout  = 3 * time.Second
)

type leaderboardEntry struct {
	Rank      int     `json:"rank"`
	Name      string  `json:"name"`
	Kills     int64   `json:"kills"`
	Deaths    int64   `json:"deaths"`
	KD        float64 `json:"kd"` // kills / max(1, deaths), 2 decimals
	Headshots int64   `json:"headshots"`
	// HeadshotPct is headshot kills / kills in percent (whole number), null
	// with no kills.
	HeadshotPct *int64 `json:"headshotPercent"`
	Rounds      int64  `json:"rounds"`
}

type leaderboardBody struct {
	Players []leaderboardEntry `json:"players"`
	// Bots says whether bots are listed (LEADERBOARD_BOTS).
	Bots bool `json:"bots"`
}

func leaderboardEntries(rows []leaderboardRow) []leaderboardEntry {
	list := make([]leaderboardEntry, 0, len(rows))
	for i, r := range rows {
		e := leaderboardEntry{
			Rank:      i + 1,
			Name:      r.Name,
			Kills:     r.Kills,
			Deaths:    r.Deaths,
			KD:        math.Round(float64(r.Kills)/math.Max(1, float64(r.Deaths))*100) / 100,
			Headshots: r.Headshots,
			Rounds:    r.Rounds,
		}
		if r.Kills > 0 {
			pct := int64(math.Round(float64(r.Headshots) * 100 / float64(r.Kills)))
			e.HeadshotPct = &pct
		}
		list = append(list, e)
	}
	return list
}

type leaderboardHandler struct {
	top     func(ctx context.Context, limit int) ([]leaderboardRow, error)
	bots    bool
	ttl     time.Duration
	limiter *rateLimiter
	now     func() time.Time
	logf    func(format string, args ...any)

	mu        sync.Mutex // held during a fetch: one query for everyone
	body      []byte     // nil after a failure
	fetchedAt time.Time
}

func newLeaderboardHandler(db *statsDB, bots bool) *leaderboardHandler {
	return &leaderboardHandler{
		top:     db.top,
		bots:    bots,
		ttl:     leaderboardCacheTTL,
		limiter: newRateLimiter(statusRate, statusBurst),
		now:     time.Now,
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "leaderboard: "+format+"\n", args...)
		},
	}
}

func (h *leaderboardHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSONError(w, http.StatusMethodNotAllowed, "use GET")
		return
	}
	if wait, ok := h.limiter.allow(clientKey(r), h.now()); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
		writeJSONError(w, http.StatusTooManyRequests, "too many requests")
		return
	}
	body := h.get()
	if body == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "the leaderboard isn't available")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

// get returns the cached JSON or queries the database (a failure is cached
// too). The query is a quick indexed read, so callers simply wait on mu.
func (h *leaderboardHandler) get() []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.fetchedAt.IsZero() && h.now().Sub(h.fetchedAt) < h.ttl {
		return h.body
	}
	ctx, cancel := context.WithTimeout(context.Background(), leaderboardTimeout)
	defer cancel()
	h.body, h.fetchedAt = nil, h.now()
	rows, err := h.top(ctx, leaderboardSize)
	if err != nil {
		h.logf("%v", err)
		return nil
	}
	body, err := json.Marshal(leaderboardBody{Players: leaderboardEntries(rows), Bots: h.bots})
	if err != nil {
		h.logf("%v", err)
		return nil
	}
	h.body = body
	return body
}

// parseLeaderboardBots reads LEADERBOARD_BOTS: "1" lists bots too, "" or "0"
// leaves them out (their victims' deaths and the kills humans make on them
// still count).
func parseLeaderboardBots(raw string) (include, ok bool) {
	switch raw {
	case "", "0":
		return false, true
	case "1":
		return true, true
	}
	return false, false
}

// withGameLogging adds the start arguments that make the engine write the
// log files the leaderboard reads: "log on" (logging stays on over map
// changes; mp_logfile is 1 by default, a new file per map) and
// "mp_logecho 0" (don't repeat every log line in the console output).
func withGameLogging(args []string) []string {
	if len(args) == 0 {
		return args
	}
	out := make([]string, 0, len(args)+4)
	out = append(out, args[0], "+log", "on", "+mp_logecho", "0")
	return append(out, args[1:]...)
}
