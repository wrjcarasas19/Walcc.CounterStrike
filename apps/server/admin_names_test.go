package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

type claimsResponse struct {
	Output string       `json:"output"`
	Error  string       `json:"error"`
	Claims []claimEntry `json:"claims"`
}

func claimsCommand(t *testing.T, a *adminAPI, c *http.Cookie, body string) (int, claimsResponse) {
	t.Helper()
	rec := a.do(adminRequest{path: "/admin/command", body: body, cookie: c, remote: testAdminAddress})
	var resp claimsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("%s: %v (%s)", body, err, rec.Body)
	}
	return rec.Code, resp
}

func newClaimsTestAdmin(t *testing.T, db *statsDB) (*adminAPI, *scriptConsole, *http.Cookie) {
	t.Helper()
	console := &scriptConsole{outputs: map[string]string{}, errs: map[string]error{}}
	a := newAdminAPI(testAdminPassword, console, actionEnv{mapsDir: t.TempDir(), claims: db})
	a.logf = func(string, ...any) {}
	c := sessionCookie(t, login(t, a, testAdminPassword, testAdminAddress))
	return a, console, c
}

func TestAdminReleaseClaim(t *testing.T) {
	nt := newNamesTest(t)
	owner := &browser{addr: "198.51.100.1"}
	second := &browser{addr: "198.51.100.2"}
	res := nt.claim(owner, "Walter")
	if res.code != http.StatusOK {
		t.Fatalf("claim: %d %v", res.code, res.body)
	}
	code := res.body["code"].(string)
	if res := nt.signin(second, "Walter", code); res.code != http.StatusOK {
		t.Fatalf("signin: %d %v", res.code, res.body)
	}
	nt.now = nt.now.Add(time.Hour)
	nt.me(second)
	if res := nt.claim(&browser{addr: "198.51.100.3"}, "Ann"); res.code != http.StatusOK {
		t.Fatalf("claim Ann: %d", res.code)
	}

	// The leaderboard marks the claimed row, and keeps it after release.
	db := nt.db
	if _, err := db.db.Exec(`INSERT INTO players (name, kills) VALUES ('Walter', 5), ('walter', 2)`); err != nil {
		t.Fatal(err)
	}
	board := newLeaderboardHandler(db, false)
	board.ttl = 0
	marks := func() map[string]bool {
		t.Helper()
		w := getLeaderboard(board, http.MethodGet, "203.0.113.9:4000")
		var body leaderboardBody
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		got := map[string]bool{}
		for _, p := range body.Players {
			got[p.Name] = p.Claimed
		}
		return got
	}
	if got := marks(); !reflect.DeepEqual(got, map[string]bool{"Walter": true, "walter": false}) {
		t.Fatalf("leaderboard before release: %v", got)
	}

	a, console, c := newClaimsTestAdmin(t, db)
	status, resp := claimsCommand(t, a, c, `{"action":"claims"}`)
	if status != http.StatusOK || len(resp.Claims) != 2 {
		t.Fatalf("claims = %d %+v", status, resp)
	}
	walter := resp.Claims[0]
	if walter.Name != "Walter" || walter.Devices != 2 || !walter.LastSeen.Equal(nt.now) || !walter.Created.Equal(nt.now.Add(-time.Hour)) {
		t.Errorf("Walter = %+v", walter)
	}
	if resp.Claims[1].Name != "Ann" || resp.Claims[1].Devices != 1 {
		t.Errorf("Ann = %+v", resp.Claims[1])
	}

	// Any spelling with the same key releases it.
	status, resp = claimsCommand(t, a, c, `{"action":"release_claim","name":" WALTER "}`)
	if status != http.StatusOK || !strings.Contains(resp.Output, "Released Walter") {
		t.Fatalf("release = %d %+v", status, resp)
	}
	if len(resp.Claims) != 1 || resp.Claims[0].Name != "Ann" {
		t.Errorf("claims after release = %+v", resp.Claims)
	}
	if len(console.commands) != 0 {
		t.Errorf("engine commands: %q", console.commands)
	}
	// Both browsers lost the name; the row is kept, without the mark.
	for _, b := range []*browser{owner, second} {
		if name := nt.me(b); name != "" {
			t.Errorf("%s still has %q", b.addr, name)
		}
	}
	if got := marks(); !reflect.DeepEqual(got, map[string]bool{"Walter": false, "walter": false}) {
		t.Errorf("leaderboard after release: %v", got)
	}
	// Someone else can claim it now, and gets the row's mark.
	if res := nt.claim(&browser{addr: "198.51.100.4"}, "walter"); res.code != http.StatusOK {
		t.Fatalf("re-claim: %d %v", res.code, res.body)
	}
	if got := marks(); !reflect.DeepEqual(got, map[string]bool{"Walter": false, "walter": true}) {
		t.Errorf("leaderboard after re-claim: %v", got)
	}

	// Releasing a name that isn't claimed is not an error.
	status, resp = claimsCommand(t, a, c, `{"action":"release_claim","name":"Nobody"}`)
	if status != http.StatusOK || !strings.Contains(resp.Output, "wasn't claimed") || len(resp.Claims) != 2 {
		t.Errorf("release unclaimed = %d %+v", status, resp)
	}

	// No claims: an empty list (the field is left out, never null).
	if _, err := db.db.Exec(`DELETE FROM claims`); err != nil {
		t.Fatal(err)
	}
	rec := a.do(adminRequest{path: "/admin/command", body: `{"action":"claims"}`, cookie: c, remote: testAdminAddress})
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "claims") {
		t.Errorf("empty claims = %d %s", rec.Code, rec.Body)
	}
}

func TestAdminReleaseClaimRefused(t *testing.T) {
	nt := newNamesTest(t)
	a, _, c := newClaimsTestAdmin(t, nt.db)
	for _, body := range []string{
		`{"action":"release_claim"}`,
		`{"action":"release_claim","name":""}`,
		`{"action":"release_claim","name":"^1"}`,
		`{"action":"release_claim","name":7}`,
		`{"action":"release_claim","name":"` + strings.Repeat("a", statsNameMax+1) + `"}`,
		`{"action":"release_claim","name":"Walter","all":true}`,
		`{"action":"claims","name":"Walter"}`,
	} {
		if status, resp := claimsCommand(t, a, c, body); status != http.StatusBadRequest {
			t.Errorf("%s = %d %+v", body, status, resp)
		}
	}

	// Without the database: 503, not a timeout.
	off, _, offCookie := newClaimsTestAdmin(t, nil)
	for _, body := range []string{`{"action":"claims"}`, `{"action":"release_claim","name":"Walter"}`} {
		if status, resp := claimsCommand(t, off, offCookie, body); status != http.StatusServiceUnavailable {
			t.Errorf("no db: %s = %d %+v", body, status, resp)
		}
	}

	// Logged out: refused before running.
	rec := a.do(adminRequest{path: "/admin/command", body: `{"action":"release_claim","name":"Walter"}`, remote: testAdminAddress})
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("logged out = %d", rec.Code)
	}
}
