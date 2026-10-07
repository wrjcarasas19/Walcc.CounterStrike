package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

// The claimed-names actions of the admin API (the claims themselves are in
// names.go), for the "Claimed names" list in the F4 Players tab:
//
//	{"action":"claims"}                        -> {"output", "claims": [...]}
//	{"action":"release_claim","name":"Walter"} releases the claim -> same
//
// Releasing deletes the claim and every browser signed in to it; the
// leaderboard row is kept and goes to whoever claims the name next. The
// name is matched like everywhere else (nameKey), so "walter" releases
// "Walter". These run in Go, not in the engine (no console command).

// claimEntry is one claimed name as the admin API lists it.
type claimEntry struct {
	Name    string    `json:"name"`
	Created time.Time `json:"created"`
	// Devices is how many browsers are signed in to it.
	Devices int `json:"devices"`
	// LastSeen is the latest GET /names/me of any of them (zero: never).
	LastSeen time.Time `json:"lastSeen"`
}

// claimList is every claim, oldest first.
func (s *statsDB) claimList(ctx context.Context) ([]claimEntry, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT c.name, c.created, COUNT(d.token_hash), COALESCE(MAX(d.last_seen), 0)
FROM claims c LEFT JOIN devices d ON d.name_key = c.name_key
GROUP BY c.name_key ORDER BY c.created, c.name_key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []claimEntry{}
	for rows.Next() {
		var e claimEntry
		var created, seen int64
		if err := rows.Scan(&e.Name, &created, &e.Devices, &seen); err != nil {
			return nil, err
		}
		e.Created = time.Unix(created, 0).UTC()
		if seen > 0 {
			e.LastSeen = time.Unix(seen, 0).UTC()
		}
		list = append(list, e)
	}
	return list, rows.Err()
}

var nameActions = map[string]actionSpec{
	"claims": {prepare: func(actionFields, actionEnv) (actionRunner, error) {
		return func(ctx context.Context, a *adminAPI, _ string) (actionResult, error) {
			return a.claimsResult(ctx, "")
		}, nil
	}},
	"release_claim": {fields: []string{"name"}, prepare: func(f actionFields, _ actionEnv) (actionRunner, error) {
		raw, err := f.string("name")
		if err != nil {
			return nil, err
		}
		key := nameKey(trimName(raw))
		if key == "" || len(raw) > statsNameMax {
			return nil, errors.New("name: not a name that can be claimed")
		}
		return func(ctx context.Context, a *adminAPI, client string) (actionResult, error) {
			if a.env.claims == nil {
				return actionResult{}, refuse(http.StatusServiceUnavailable, "claimed names aren't available")
			}
			name, ok, err := a.env.claims.releaseClaim(ctx, key)
			if err != nil {
				a.logf("%s: release_claim %q: %v", client, raw, err)
				return actionResult{}, refuse(http.StatusInternalServerError, "couldn't release the name: %v", err)
			}
			out := fmt.Sprintf("%s wasn't claimed\n", raw)
			if ok {
				a.logf("%s: released the claim on %q", client, name)
				out = fmt.Sprintf("Released %s. Its leaderboard row is kept.\n", name)
			}
			return a.claimsResult(ctx, out)
		}, nil
	}},
}

// claimsResult is output plus the current claim list.
func (a *adminAPI) claimsResult(ctx context.Context, output string) (actionResult, error) {
	if a.env.claims == nil {
		return actionResult{Output: output}, refuse(http.StatusServiceUnavailable, "claimed names aren't available")
	}
	list, err := a.env.claims.claimList(ctx)
	if err != nil {
		return actionResult{Output: output}, refuse(http.StatusInternalServerError, "couldn't read the claimed names: %v", err)
	}
	return actionResult{Output: output, Claims: list}, nil
}
