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

// GET /duel?a=<name>&b=<name> is the all-time head-to-head of two player
// names: {"aKills": how many times a killed b, "bKills": b killed a}. Only
// enemy kills count, from the duels table (statsdb.go, filled by
// statsfollow.go with the leaderboard's rules); names are exact, as typed in
// the game, up to statsNameMax bytes, except that a claimed name (names.go)
// in any spelling with the same key ("walter", "Walter (1)") is looked up
// under the claimed spelling, where the follower puts its owner's kills.
// Unknown names are 0 – 0.
//
// Like /leaderboard it is cached (per pair, leaderboardCacheTTL) and rate
// limited per address.

// duelCacheMax pairs are cached; past that, expired ones are dropped, and if
// all are fresh the cache starts over.
const duelCacheMax = 512

type duelBody struct {
	AKills int64 `json:"aKills"`
	BKills int64 `json:"bKills"`
}

type duelCached struct {
	body      *duelBody // nil after a failure
	fetchedAt time.Time
}

type duelHandler struct {
	duel    func(ctx context.Context, a, b string) (aKills, bKills int64, err error)
	ttl     time.Duration
	limiter *rateLimiter
	now     func() time.Time
	logf    func(format string, args ...any)

	mu    sync.Mutex // held during a fetch: one query at a time
	cache map[duelPair]duelCached
}

func newDuelHandler(db *statsDB) *duelHandler {
	return &duelHandler{
		duel: func(ctx context.Context, a, b string) (int64, int64, error) {
			a, err := claimedRowName(ctx, db, a)
			if err != nil {
				return 0, 0, err
			}
			b, err = claimedRowName(ctx, db, b)
			if err != nil {
				return 0, 0, err
			}
			return db.duel(ctx, a, b)
		},
		ttl:     leaderboardCacheTTL,
		limiter: newRateLimiter(statusRate, statusBurst),
		now:     time.Now,
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "duel: "+format+"\n", args...)
		},
	}
}

// claimedRowName is the row name the follower uses for name: the claimed
// spelling if name's key is claimed, name otherwise.
func claimedRowName(ctx context.Context, db *statsDB, name string) (string, error) {
	key := nameKey(name)
	if key == "" {
		return name, nil
	}
	c, ok, err := db.claimByKey(ctx, key)
	if err != nil || !ok {
		return name, err
	}
	return c.Name, nil
}

func (h *duelHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
	q := r.URL.Query()
	a, b := q.Get("a"), q.Get("b")
	if a == "" || b == "" || len(a) > statsNameMax || len(b) > statsNameMax {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("a and b must be player names of 1 to %d bytes", statsNameMax))
		return
	}
	d := h.get(a, b)
	if d == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "head-to-head isn't available")
		return
	}
	body, err := json.Marshal(d)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "encoding failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

// get returns the cached counts for a and b or queries the database (a
// failure is cached too). The pair is cached once for both orders.
func (h *duelHandler) get(a, b string) *duelBody {
	key, swap := duelPair{Killer: a, Victim: b}, false
	if b < a {
		key, swap = duelPair{Killer: b, Victim: a}, true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	c, ok := h.cache[key]
	if !ok || now.Sub(c.fetchedAt) >= h.ttl {
		h.makeRoom(now)
		c = duelCached{fetchedAt: now}
		ctx, cancel := context.WithTimeout(context.Background(), leaderboardTimeout)
		aKills, bKills, err := h.duel(ctx, key.Killer, key.Victim)
		cancel()
		if err != nil {
			h.logf("%v", err)
		} else {
			c.body = &duelBody{AKills: aKills, BKills: bKills}
		}
		h.cache[key] = c
	}
	if c.body == nil {
		return nil
	}
	if swap {
		return &duelBody{AKills: c.body.BKills, BKills: c.body.AKills}
	}
	return c.body
}

// makeRoom keeps the cache under duelCacheMax entries. Called with mu held.
func (h *duelHandler) makeRoom(now time.Time) {
	if h.cache == nil {
		h.cache = map[duelPair]duelCached{}
	}
	if len(h.cache) < duelCacheMax {
		return
	}
	for k, c := range h.cache {
		if now.Sub(c.fetchedAt) >= h.ttl {
			delete(h.cache, k)
		}
	}
	if len(h.cache) >= duelCacheMax {
		h.cache = map[duelPair]duelCached{}
	}
}
