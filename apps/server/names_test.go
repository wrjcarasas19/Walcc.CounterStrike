package main

import (
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNameKey(t *testing.T) {
	for _, tc := range []struct {
		names []string
		key   string
	}{
		{[]string{"Walter", " walter ", "WALTER", "^1Wal^7ter", "^^11Walter", "Wal\u200bter", "Walter\u00a0", "Walter (1)", "Walter (12)", "\tWalter\n", "Wal\u00adter", "\ufeffWalter"}, "walter"},
		{[]string{"Wal  ter", "Wal\u00a0ter", "Wal%ter"}, "wal ter"},
		{[]string{"Tom & Jerry", "Tom   Jerry", "Tom&Jerry"}, "tom jerry"},
		{[]string{"#Walter", "*walter", "#WALTER (2)"}, "*walter"},
		{[]string{"Ünal", "ÜNAL"}, "ünal"},
		{[]string{"Walter (guest)"}, "walter (guest)"},
		{[]string{"^1", "", "  ", "^1^2", "\u200b"}, ""},
		{[]string{"Walter (1) (2)"}, "walter (1)"},
		{[]string{"(1)"}, "(1)"},
		{[]string{"\xffWalter"}, "\ufffdwalter"},
		{[]string{"^", "^ "}, "^"},
		{[]string{"^A", "^a"}, "^a"},
	} {
		for _, name := range tc.names {
			if got := nameKey(name); got != tc.key {
				t.Errorf("nameKey(%q) = %q, want %q", name, got, tc.key)
			}
		}
	}
	// Not caught (README): other scripts' look-alikes and fullwidth letters.
	for _, name := range []string{"W\u0430lter", "\uff37alter"} {
		if nameKey(name) == "walter" {
			t.Errorf("nameKey(%q) = walter: expected a different key", name)
		}
	}
}

func TestClaimNameProblem(t *testing.T) {
	ok := []string{"Walter", "Wal ter", "^1Walter", "Ünal", "Tom & Jerry", "#Walter", "Player One", "Players 2",
		strings.Repeat("a", 31), strings.Repeat("ü", 15) + "a", "Walter (1x)", "Guest", "a.b.c"}
	for _, name := range ok {
		if p := claimNameProblem(name); p != "" {
			t.Errorf("claimNameProblem(%q) = %q, want ok", name, p)
		}
	}
	bad := []string{"", strings.Repeat("a", 32), strings.Repeat("ü", 16), "Wal\"ter", `Wal\ter`, "Wal;ter",
		"Wal..ter", "Wal\x01ter", "Wal\x7fter", "\xffWalter", "Wal\ufffdter", "^1", "^1^2 ", "console", "CONSOLE",
		"unnamed", "Player", "player", "Player 12", "player 3 (1)", "Walter (guest)", "^1Walter (Guest)"}
	for _, name := range bad {
		if p := claimNameProblem(name); p == "" {
			t.Errorf("claimNameProblem(%q) = ok, want a problem", name)
		}
	}
}

func TestRecoveryCodes(t *testing.T) {
	if got := encodeCrockford(make([]byte, 10)); got != "0000000000000000" {
		t.Errorf("zeros = %q", got)
	}
	if got := encodeCrockford([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}); got != "ZZZZZZZZZZZZZZZZ" {
		t.Errorf("ones = %q", got)
	}
	// 0x08 0x42 = 00001 00001 00001 0(0000): the bits come out in order.
	if got := encodeCrockford([]byte{0x08, 0x42}); got != "1110" {
		t.Errorf("0842 = %q", got)
	}
	shape := regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$`)
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		code, err := newRecoveryCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(code) != recoveryCodeLen || seen[code] {
			t.Fatalf("code %q (repeat %v)", code, seen[code])
		}
		seen[code] = true
		shown := formatRecoveryCode(code)
		if !shape.MatchString(shown) {
			t.Fatalf("shown %q", shown)
		}
		if back, ok := canonicalRecoveryCode(strings.ToLower(shown)); !ok || back != code {
			t.Fatalf("canonical(%q) = %q, %v", strings.ToLower(shown), back, ok)
		}
	}
	for input, want := range map[string]string{
		"KJ7Q-M2XP-9WRT-4HCD":     "KJ7QM2XP9WRT4HCD",
		"kj7q m2xp 9wrt 4hcd":     "KJ7QM2XP9WRT4HCD",
		" KJ7QM2XP9WRT4HCD ":      "KJ7QM2XP9WRT4HCD",
		"OOOO-IIII-LLLL-oooo":     "0000111111110000",
		"kj7q-m2xp-9wrt-4hcd\t\n": "KJ7QM2XP9WRT4HCD",
	} {
		if got, ok := canonicalRecoveryCode(input); !ok || got != want {
			t.Errorf("canonical(%q) = %q, %v, want %q", input, got, ok, want)
		}
	}
	for _, input := range []string{"", "KJ7Q-M2XP-9WRT-4HC", "KJ7Q-M2XP-9WRT-4HCDE", "KJ7Q-M2XP-9WRT-4HCU", "KJ7Q-M2XP-9WRT-4HC!",
		"KJ7Q-M2XP-9WRT-4HCÜ", strings.Repeat("-", 100) + "KJ7QM2XP9WRT4HCD"} {
		if got, ok := canonicalRecoveryCode(input); ok {
			t.Errorf("canonical(%q) = %q, want invalid", input, got)
		}
	}

	h := hashSecret([]byte("KJ7QM2XP9WRT4HCD"))
	if len(h) != 64 || h != hashSecret([]byte("KJ7QM2XP9WRT4HCD")) || h == hashSecret([]byte("KJ7QM2XP9WRT4HCE")) {
		t.Errorf("hash %q", h)
	}
	if !codeMatches("KJ7QM2XP9WRT4HCD", h) || codeMatches("KJ7QM2XP9WRT4HCE", h) || codeMatches("KJ7QM2XP9WRT4HCD", "") {
		t.Error("codeMatches")
	}
}

func TestDeviceTokens(t *testing.T) {
	value, hash, err := newDeviceToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 43 || len(hash) != 64 {
		t.Fatalf("token %q hash %q", value, hash)
	}
	if got, ok := parseDeviceToken(value); !ok || got != hash {
		t.Errorf("parse = %q, %v", got, ok)
	}
	other, _, _ := newDeviceToken()
	if other == value {
		t.Error("two tokens alike")
	}
	for _, bad := range []string{"", "abc", value + "=", value[:42], value[:42] + "+", value[:42] + "/", strings.Repeat("A", 42) + "B"} {
		if _, ok := parseDeviceToken(bad); ok {
			t.Errorf("parse(%q) ok", bad)
		}
	}
}

// namesTest drives a namesHandler through Server with a fake clock.
type namesTest struct {
	t   *testing.T
	db  *statsDB
	h   *namesHandler
	s   *Server
	now time.Time
	log []string
}

func newNamesTest(t *testing.T) *namesTest {
	t.Helper()
	db, err := openStatsDB(filepath.Join(t.TempDir(), leaderboardFile))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	nt := &namesTest{t: t, db: db, now: time.Unix(1791000000, 0)}
	nt.h = newNamesHandler(db)
	nt.h.limiter = newRateLimiter(1000, 1000)
	var mu sync.Mutex
	nt.h.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return nt.now
	}
	nt.h.logf = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		nt.log = append(nt.log, format)
	}
	nt.s = &Server{names: nt.h}
	return nt
}

// browser is one browser: its address and its wc_player cookie.
type browser struct {
	addr   string
	cookie string
	header map[string]string
	https  bool
}

type namesResponse struct {
	code   int
	body   map[string]any
	cookie *http.Cookie
	header http.Header
}

func (nt *namesTest) do(b *browser, method, path, body string) namesResponse {
	nt.t.Helper()
	var req *http.Request
	if body != "" || method == http.MethodPost {
		req = httptest.NewRequest(method, "http://cs.example"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://cs.example")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
	} else {
		req = httptest.NewRequest(method, "http://cs.example"+path, nil)
	}
	req.RemoteAddr = b.addr + ":5000"
	if b.cookie != "" {
		req.AddCookie(&http.Cookie{Name: namesCookie, Value: b.cookie})
	}
	if b.https {
		req.TLS = &tls.ConnectionState{}
	}
	for k, v := range b.header {
		if v == "" {
			req.Header.Del(k)
		} else {
			req.Header.Set(k, v)
		}
	}
	rec := httptest.NewRecorder()
	nt.s.ServeHTTP(rec, req)
	res := namesResponse{code: rec.Code, header: rec.Header()}
	if rec.Header().Get("Content-Type") == "application/json" {
		if err := json.Unmarshal(rec.Body.Bytes(), &res.body); err != nil {
			nt.t.Fatalf("%s %s: %v: %s", method, path, err, rec.Body)
		}
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == namesCookie {
			res.cookie = c
			if c.MaxAge < 0 {
				b.cookie = ""
			} else {
				b.cookie = c.Value
			}
		}
	}
	return res
}

func (nt *namesTest) claim(b *browser, name string) namesResponse {
	nt.t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name})
	return nt.do(b, http.MethodPost, "/names/claim", string(body))
}

func (nt *namesTest) signin(b *browser, name, code string) namesResponse {
	nt.t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name, "code": code})
	return nt.do(b, http.MethodPost, "/names/signin", string(body))
}

func (nt *namesTest) me(b *browser) string {
	nt.t.Helper()
	res := nt.do(b, http.MethodGet, "/names/me", "")
	if res.code != http.StatusOK {
		nt.t.Fatalf("me = %d %v", res.code, res.body)
	}
	name, _ := res.body["name"].(string)
	return name
}

func (nt *namesTest) status(b *browser, name string) (claimed, mine bool) {
	nt.t.Helper()
	res := nt.do(b, http.MethodGet, "/names/status?name="+strings.ReplaceAll(name, " ", "%20"), "")
	if res.code != http.StatusOK {
		nt.t.Fatalf("status = %d %v", res.code, res.body)
	}
	return res.body["claimed"] == true, res.body["mine"] == true
}

func mustCode(t *testing.T, res namesResponse) string {
	t.Helper()
	if res.code != http.StatusOK {
		t.Fatalf("claim = %d %v", res.code, res.body)
	}
	code, _ := res.body["code"].(string)
	if len(code) != 19 {
		t.Fatalf("code %q", code)
	}
	return code
}

func expectError(t *testing.T, what string, res namesResponse, status int, code string) {
	t.Helper()
	if res.code != status || res.body["error"] != code {
		t.Errorf("%s = %d %v, want %d %s", what, res.code, res.body, status, code)
	}
}

func TestNamesClaim(t *testing.T) {
	nt := newNamesTest(t)
	a := &browser{addr: "203.0.113.1"}
	b := &browser{addr: "203.0.113.2"}
	if name := nt.me(a); name != "" {
		t.Fatalf("me before claiming = %q", name)
	}
	if claimed, mine := nt.status(a, "Walter"); claimed || mine {
		t.Fatal("unclaimed name claimed")
	}

	res := nt.claim(a, "  Walter ")
	mustCode(t, res)
	if res.body["name"] != "Walter" {
		t.Errorf("claimed name %v, want the trimmed spelling", res.body["name"])
	}
	c := res.cookie
	if c == nil || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.Secure ||
		c.MaxAge != 365*24*3600 || len(c.Value) != 43 {
		t.Fatalf("cookie %+v", c)
	}
	if name := nt.me(a); name != "Walter" {
		t.Errorf("me = %q", name)
	}
	for _, name := range []string{"Walter", "walter", "^1WALTER", "Walter (1)"} {
		if claimed, mine := nt.status(a, name); !claimed || !mine {
			t.Errorf("status(%q) for the owner = %v %v", name, claimed, mine)
		}
		if claimed, mine := nt.status(b, name); !claimed || mine {
			t.Errorf("status(%q) for someone else = %v %v", name, claimed, mine)
		}
	}
	if claimed, _ := nt.status(b, "Walt"); claimed {
		t.Error("Walt claimed")
	}
	for _, name := range []string{"Walter", " WALTER", "^1Wal^7ter", "Wal\u200bter", "Walter (3)"} {
		expectError(t, "claim "+name, nt.claim(b, name), http.StatusConflict, "taken")
	}
	if b.cookie != "" {
		t.Error("a refused claim set a cookie")
	}
	// The owner claiming its own name again: taken (it's theirs: status says so).
	expectError(t, "claim own name", nt.claim(a, "walter"), http.StatusConflict, "taken")

	// Stored: hashes only.
	var codeHash, tokenHash string
	if err := nt.db.db.QueryRow(`SELECT code_hash FROM claims WHERE name_key = 'walter'`).Scan(&codeHash); err != nil {
		t.Fatal(err)
	}
	if err := nt.db.db.QueryRow(`SELECT token_hash FROM devices WHERE name_key = 'walter'`).Scan(&tokenHash); err != nil {
		t.Fatal(err)
	}
	code, _ := canonicalRecoveryCode(res.body["code"].(string))
	if codeHash != hashSecret([]byte(code)) || strings.Contains(codeHash, code) {
		t.Errorf("code hash %q", codeHash)
	}
	if want, _ := parseDeviceToken(a.cookie); tokenHash != want {
		t.Errorf("token hash %q, want %q", tokenHash, want)
	}

	// Bad bodies and names.
	for name, problem := range map[string]string{
		"":                      "invalid_name",
		"Player 3":              "invalid_name",
		"Walter (guest)":        "invalid_name",
		"Wal;ter":               "invalid_name",
		strings.Repeat("x", 32): "invalid_name",
	} {
		expectError(t, "claim "+name, nt.claim(b, name), http.StatusBadRequest, problem)
	}
	expectError(t, "not JSON", nt.do(b, http.MethodPost, "/names/claim", "name=x"), http.StatusBadRequest, "bad_request")
	expectError(t, "too big", nt.do(b, http.MethodPost, "/names/claim", `{"name":"`+strings.Repeat("a", 5000)+`"}`),
		http.StatusRequestEntityTooLarge, "bad_request")
}

func TestNamesCookieSecure(t *testing.T) {
	nt := newNamesTest(t)
	for i, b := range []*browser{
		{addr: "203.0.113.1", https: true},
		{addr: "203.0.113.2", header: map[string]string{"X-Forwarded-Proto": "https"}},
		{addr: "203.0.113.3", header: map[string]string{"X-Forwarded-Proto": "HTTPS"}},
	} {
		res := nt.claim(b, []string{"Ann", "Bob", "Cid"}[i])
		mustCode(t, res)
		if !res.cookie.Secure || !res.cookie.HttpOnly || res.cookie.SameSite != http.SameSiteStrictMode {
			t.Errorf("browser %d: cookie %+v", i, res.cookie)
		}
		// Renewed by /names/me with the same flags.
		res = nt.do(b, http.MethodGet, "/names/me", "")
		if res.cookie == nil || !res.cookie.Secure || res.cookie.MaxAge != namesCookieMaxAge {
			t.Errorf("browser %d: renewed cookie %+v", i, res.cookie)
		}
	}
	plain := &browser{addr: "203.0.113.4", header: map[string]string{"X-Forwarded-Proto": "http"}}
	if res := nt.claim(plain, "Dan"); res.cookie == nil || res.cookie.Secure {
		t.Errorf("plain http cookie %+v", res.cookie)
	}
}

func TestNamesSameOrigin(t *testing.T) {
	nt := newNamesTest(t)
	for what, header := range map[string]map[string]string{
		"cross-origin": {"Origin": "http://evil.example"},
		"cross-site":   {"Sec-Fetch-Site": "cross-site"},
		"same-site":    {"Sec-Fetch-Site": "same-site"},
	} {
		b := &browser{addr: "203.0.113.1", header: header}
		for _, path := range []string{"/names/claim", "/names/signin", "/names/release"} {
			if res := nt.do(b, http.MethodPost, path, `{"name":"Walter"}`); res.code != http.StatusForbidden {
				t.Errorf("%s %s = %d", what, path, res.code)
			}
		}
	}
	if res := nt.do(&browser{addr: "203.0.113.1", header: map[string]string{"Content-Type": "text/plain"}},
		http.MethodPost, "/names/claim", `{"name":"Walter"}`); res.code != http.StatusUnsupportedMediaType {
		t.Errorf("text/plain = %d", res.code)
	}
	if res := nt.do(&browser{addr: "203.0.113.1"}, http.MethodGet, "/names/claim", ""); res.code != http.StatusMethodNotAllowed {
		t.Errorf("GET claim = %d", res.code)
	}
	if res := nt.do(&browser{addr: "203.0.113.1"}, http.MethodPost, "/names/me", `{}`); res.code != http.StatusMethodNotAllowed {
		t.Errorf("POST me = %d", res.code)
	}
	// Non-browser clients (no Origin, no Sec-Fetch-Site) are fine.
	b := &browser{addr: "203.0.113.1", header: map[string]string{"Origin": "", "Sec-Fetch-Site": ""}}
	mustCode(t, nt.claim(b, "Walter"))
	if claimed, _ := nt.status(&browser{addr: "203.0.113.9"}, "Walter"); !claimed {
		t.Error("not claimed")
	}
}

func TestNamesSigninAndDevices(t *testing.T) {
	nt := newNamesTest(t)
	a := &browser{addr: "203.0.113.1"}
	a2 := &browser{addr: "198.51.100.1"}
	code := mustCode(t, nt.claim(a, "Walter"))

	// Typed sloppily: lower case, spaces, O for 0.
	typed := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(code, "-", " "), "0", "O"))
	res := nt.signin(a2, "walter", typed)
	if res.code != http.StatusOK || res.body["name"] != "Walter" || res.cookie == nil || a2.cookie == "" || a2.cookie == a.cookie {
		t.Fatalf("signin = %d %v %+v", res.code, res.body, res.cookie)
	}
	if nt.me(a2) != "Walter" || nt.me(a) != "Walter" {
		t.Error("both devices should have Walter")
	}
	// Again to the name it has: 200, the same cookie kept, no code needed.
	before := a2.cookie
	if res := nt.signin(a2, "WALTER", "x"); res.code != http.StatusOK || a2.cookie != before {
		t.Errorf("signin again = %d %v", res.code, res.body)
	}

	// One name per device.
	b := &browser{addr: "203.0.113.2"}
	annCode := mustCode(t, nt.claim(b, "Ann"))
	res = nt.claim(a, "Bob")
	expectError(t, "second claim", res, http.StatusConflict, "device_has_name")
	if res.body["name"] != "Walter" {
		t.Errorf("device_has_name name %v", res.body["name"])
	}
	res = nt.signin(a, "Ann", annCode)
	expectError(t, "signin to another name", res, http.StatusConflict, "device_has_name")
	if nt.me(a) != "Walter" {
		t.Error("device switched name")
	}
	if claimed, _ := nt.status(b, "Bob"); claimed {
		t.Error("Bob claimed by a refused claim")
	}

	// A wrong code doesn't sign in; an unclaimed name is a wrong code too.
	c := &browser{addr: "203.0.113.3"}
	expectError(t, "wrong code", nt.signin(c, "Walter", annCode), http.StatusForbidden, "wrong_code")
	expectError(t, "unclaimed", nt.signin(c, "Nobody", code), http.StatusForbidden, "wrong_code")
	expectError(t, "malformed code", nt.signin(c, "Walter", "1234"), http.StatusBadRequest, "invalid_code")
	expectError(t, "no name", nt.signin(c, "^1", code), http.StatusBadRequest, "invalid_name")
	if c.cookie != "" || nt.me(c) != "" {
		t.Error("c signed in")
	}
}

func TestNamesWrongCodeLockout(t *testing.T) {
	nt := newNamesTest(t)
	owner := &browser{addr: "203.0.113.1"}
	code := mustCode(t, nt.claim(owner, "Walter"))
	wrong := "0000-0000-0000-0000"
	b := &browser{addr: "198.51.100.7"}
	// Malformed codes aren't counted.
	for i := 0; i < 10; i++ {
		expectError(t, "malformed", nt.signin(b, "Walter", "nope"), http.StatusBadRequest, "invalid_code")
	}
	for i := 1; i < namesMaxWrongCodes; i++ {
		expectError(t, "wrong code", nt.signin(b, "Walter", wrong), http.StatusForbidden, "wrong_code")
	}
	// Release with a wrong code counts too: the 5th locks out.
	res := nt.do(b, http.MethodPost, "/names/release", `{"all":true,"name":"Walter","code":"`+wrong+`"}`)
	expectError(t, "5th wrong code", res, http.StatusTooManyRequests, "locked_out")
	if res.header.Get("Retry-After") != "300" {
		t.Errorf("Retry-After %q", res.header.Get("Retry-After"))
	}
	// Locked: even the right code is refused, for sign-in and release.
	nt.now = nt.now.Add(4 * time.Minute)
	res = nt.signin(b, "Walter", code)
	expectError(t, "locked signin", res, http.StatusTooManyRequests, "locked_out")
	if res.header.Get("Retry-After") != "60" {
		t.Errorf("Retry-After %q", res.header.Get("Retry-After"))
	}
	expectError(t, "locked release", nt.do(b, http.MethodPost, "/names/release", `{"all":true,"name":"Walter","code":"`+code+`"}`),
		http.StatusTooManyRequests, "locked_out")
	// Other addresses aren't locked, and an IPv6 /64 counts as one.
	if res := nt.signin(&browser{addr: "198.51.100.8"}, "Walter", code); res.code != http.StatusOK {
		t.Errorf("other address = %d", res.code)
	}
	v6 := func(host string) *browser { return &browser{addr: "[" + host + "]"} }
	for i := 0; i < namesMaxWrongCodes; i++ {
		nt.signin(v6("2001:db8::"+string(rune('1'+i))), "Walter", wrong)
	}
	expectError(t, "same /64", nt.signin(v6("2001:db8::99"), "Walter", code), http.StatusTooManyRequests, "locked_out")
	// The admin login limiter is a different one.
	if nt.h.codes == nil || nt.h.codes == nt.h.claims {
		t.Error("limiters shared")
	}
	// After the lockout the right code works.
	nt.now = nt.now.Add(time.Minute)
	if res := nt.signin(b, "Walter", code); res.code != http.StatusOK {
		t.Errorf("after the lockout = %d %v", res.code, res.body)
	}
}

func TestNamesClaimLimit(t *testing.T) {
	nt := newNamesTest(t)
	names := []string{"A1", "A2", "A3", "A4", "A5", "A6"}
	for i, name := range names[:namesMaxClaims] {
		// A refused or invalid claim doesn't count.
		nt.claim(&browser{addr: "203.0.113.1"}, "Player 1")
		if i > 0 {
			nt.claim(&browser{addr: "203.0.113.1"}, names[0])
		}
		mustCode(t, nt.claim(&browser{addr: "203.0.113.1"}, name))
		nt.now = nt.now.Add(time.Minute)
	}
	res := nt.claim(&browser{addr: "203.0.113.1"}, names[5])
	expectError(t, "6th claim", res, http.StatusTooManyRequests, "too_many_claims")
	if res.header.Get("Retry-After") != "3540" { // locked an hour from the 5th claim, a minute ago
		t.Errorf("Retry-After %q", res.header.Get("Retry-After"))
	}
	mustCode(t, nt.claim(&browser{addr: "203.0.113.2"}, names[5]))
	nt.now = nt.now.Add(time.Hour)
	mustCode(t, nt.claim(&browser{addr: "203.0.113.1"}, "A7"))
}

func TestNamesRelease(t *testing.T) {
	nt := newNamesTest(t)
	a := &browser{addr: "203.0.113.1"}
	a2 := &browser{addr: "203.0.113.2"}
	code := mustCode(t, nt.claim(a, "Walter"))
	if res := nt.signin(a2, "Walter", code); res.code != http.StatusOK {
		t.Fatal(res.body)
	}

	// Release this device: the cookie goes, the claim stays.
	old := a.cookie
	res := nt.do(a, http.MethodPost, "/names/release", `{}`)
	if res.code != http.StatusOK || res.cookie == nil || res.cookie.MaxAge >= 0 || a.cookie != "" {
		t.Fatalf("release device = %d %v %+v", res.code, res.body, res.cookie)
	}
	if nt.me(a) != "" || nt.me(a2) != "Walter" {
		t.Error("after releasing a device")
	}
	if claimed, _ := nt.status(a, "Walter"); !claimed {
		t.Error("claim gone with the device")
	}
	// The old cookie is stale: {} and an expired cookie.
	stale := &browser{addr: "203.0.113.1", cookie: old}
	res = nt.do(stale, http.MethodGet, "/names/me", "")
	if len(res.body) != 0 || res.cookie == nil || res.cookie.MaxAge >= 0 {
		t.Errorf("stale me = %v %+v", res.body, res.cookie)
	}
	// Releasing without a device is fine.
	if res := nt.do(&browser{addr: "203.0.113.3"}, http.MethodPost, "/names/release", `{}`); res.code != http.StatusOK || res.cookie != nil {
		t.Errorf("release nothing = %d %+v", res.code, res.cookie)
	}
	// The code still signs a released device back in.
	if res := nt.signin(a, "Walter", code); res.code != http.StatusOK {
		t.Fatal(res.body)
	}

	// Release all: needs the right code; the name defaults to this device's.
	expectError(t, "release all, wrong code", nt.do(a, http.MethodPost, "/names/release", `{"all":true,"code":"0000-0000-0000-0000"}`),
		http.StatusForbidden, "wrong_code")
	expectError(t, "release all, no name", nt.do(&browser{addr: "203.0.113.4"}, http.MethodPost, "/names/release", `{"all":true,"code":"`+code+`"}`),
		http.StatusBadRequest, "invalid_name")
	res = nt.do(a, http.MethodPost, "/names/release", `{"all":true,"code":"`+code+`"}`)
	if res.code != http.StatusOK || res.body["released"] != "Walter" || a.cookie != "" {
		t.Fatalf("release all = %d %v", res.code, res.body)
	}
	if claimed, _ := nt.status(a, "Walter"); claimed {
		t.Error("still claimed")
	}
	// Other devices get {} next time.
	if nt.me(a2) != "" || a2.cookie != "" {
		t.Error("other device kept the name")
	}
	var devices int
	if err := nt.db.db.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&devices); err != nil || devices != 0 {
		t.Errorf("devices left %d, %v", devices, err)
	}
	// The name is free for the next claim (and the old code is dead).
	b := &browser{addr: "203.0.113.5"}
	newCode := mustCode(t, nt.claim(b, "walter"))
	expectError(t, "old code", nt.signin(a, "Walter", code), http.StatusForbidden, "wrong_code")

	// Release all with only the code, from a browser with no device; and
	// from a browser with another name, which keeps its own.
	c := &browser{addr: "203.0.113.6"}
	mustCode(t, nt.claim(c, "Ann"))
	res = nt.do(c, http.MethodPost, "/names/release", `{"all":true,"name":"WALTER","code":"`+newCode+`"}`)
	if res.code != http.StatusOK || res.body["released"] != "walter" || res.cookie != nil {
		t.Fatalf("release other name = %d %v %+v", res.code, res.body, res.cookie)
	}
	if nt.me(c) != "Ann" || nt.me(b) != "" {
		t.Error("after releasing from another device")
	}
}

func TestNamesStaleAndBadCookies(t *testing.T) {
	nt := newNamesTest(t)
	for _, value := range []string{"garbage", strings.Repeat("A", 43)} {
		b := &browser{addr: "203.0.113.1", cookie: value}
		res := nt.do(b, http.MethodGet, "/names/me", "")
		if res.code != http.StatusOK || len(res.body) != 0 || res.cookie == nil || res.cookie.MaxAge >= 0 {
			t.Errorf("me with %q = %d %v %+v", value, res.code, res.body, res.cookie)
		}
	}
	// A stale but well-formed cookie can claim: it gets a new token.
	b := &browser{addr: "203.0.113.1", cookie: strings.Repeat("A", 43)}
	mustCode(t, nt.claim(b, "Walter"))
	if b.cookie == strings.Repeat("A", 43) || nt.me(b) != "Walter" {
		t.Error("claim with a stale cookie")
	}
	if res := nt.do(b, http.MethodGet, "/names/status", ""); res.code != http.StatusBadRequest {
		t.Errorf("status without a name = %d", res.code)
	}
	if res := nt.do(b, http.MethodGet, "/names/status?name="+strings.Repeat("a", 65), ""); res.code != http.StatusBadRequest {
		t.Errorf("status with a long name = %d", res.code)
	}
	if claimed, mine := nt.status(b, "^1"); claimed || mine {
		t.Error("empty key claimed")
	}
}

// Two claims of the same name at once: one wins, the others get 409.
func TestNamesClaimRace(t *testing.T) {
	nt := newNamesTest(t)
	const n = 16
	var wg sync.WaitGroup
	codes := make([]int, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			b := &browser{addr: "203.0.113." + strconv.Itoa(10+i)}
			name := []string{"Walter", "walter", " WALTER", "^1Walter"}[i%4]
			codes[i] = nt.claim(b, name).code
		}(i)
	}
	close(start)
	wg.Wait()
	won := 0
	for _, code := range codes {
		switch code {
		case http.StatusOK:
			won++
		case http.StatusConflict:
		default:
			t.Errorf("claim = %d", code)
		}
	}
	if won != 1 {
		t.Errorf("%d claims won, want 1 (%v)", won, codes)
	}
	var claims, devices int
	nt.db.db.QueryRow(`SELECT COUNT(*) FROM claims`).Scan(&claims)
	nt.db.db.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&devices)
	if claims != 1 || devices != 1 {
		t.Errorf("%d claims, %d devices", claims, devices)
	}

	// The same at the storage level, with a second connection pool on the
	// same file (as another process would be).
	path := filepath.Join(t.TempDir(), leaderboardFile)
	db1, err := openStatsDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db1.Close()
	db2, err := openStatsDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			db := []*statsDB{db1, db2}[i%2]
			_, hash, _ := newDeviceToken()
			errs[i] = db.createClaim(context.Background(), nameClaim{Key: "ann", Name: "Ann", CodeHash: "h"}, "", hash, time.Now())
		}(i)
	}
	wg.Wait()
	won = 0
	for _, err := range errs {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, errNameTaken):
			t.Errorf("createClaim: %v", err)
		}
	}
	if won != 1 {
		t.Errorf("%d storage claims won", won)
	}
}

func TestNamesRateLimitAndRouting(t *testing.T) {
	nt := newNamesTest(t)
	nt.h.limiter = newRateLimiter(statusRate, statusBurst)
	b := &browser{addr: "203.0.113.1"}
	for i := 0; i < statusBurst; i++ {
		if res := nt.do(b, http.MethodGet, "/names/me", ""); res.code != http.StatusOK {
			t.Fatalf("request %d = %d", i, res.code)
		}
	}
	res := nt.do(b, http.MethodGet, "/names/status?name=x", "")
	expectError(t, "over the rate", res, http.StatusTooManyRequests, "rate_limited")
	if res.header.Get("Retry-After") == "" {
		t.Error("no Retry-After")
	}
	if res := nt.do(&browser{addr: "203.0.113.2"}, http.MethodGet, "/names/me", ""); res.code != http.StatusOK {
		t.Errorf("other address = %d", res.code)
	}
	if res := nt.do(&browser{addr: "203.0.113.3"}, http.MethodGet, "/names/nope", ""); res.code != http.StatusNotFound {
		t.Errorf("unknown path = %d", res.code)
	}
	if res := nt.do(&browser{addr: "203.0.113.3"}, http.MethodGet, "/names/me", ""); res.header.Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control %q", res.header.Get("Cache-Control"))
	}

	// Database off: every /names/ path is 404.
	off := &Server{}
	for _, path := range []string{"/names/me", "/names/status?name=x", "/names/claim", "/names/signin", "/names/release"} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			rec := httptest.NewRecorder()
			off.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(`{}`)))
			if rec.Code != http.StatusNotFound {
				t.Errorf("%s %s with the database off = %d", method, path, rec.Code)
			}
		}
	}
}

// The internal API E.3-E.5 use.
func TestNamesInternalAPI(t *testing.T) {
	nt := newNamesTest(t)
	ctx := context.Background()
	a := &browser{addr: "203.0.113.1"}
	mustCode(t, nt.claim(a, "^1Walter"))
	mustCode(t, nt.claim(&browser{addr: "203.0.113.2"}, "Ann"))

	req := httptest.NewRequest(http.MethodGet, "/websocket", nil)
	req.AddCookie(&http.Cookie{Name: namesCookie, Value: a.cookie})
	hash, ok := deviceTokenHash(req)
	if !ok {
		t.Fatal("no token hash")
	}
	if _, ok := deviceTokenHash(httptest.NewRequest(http.MethodGet, "/websocket", nil)); ok {
		t.Error("token hash without a cookie")
	}
	c, ok, err := nt.db.deviceClaim(ctx, hash)
	if err != nil || !ok || c.Key != "walter" || c.Name != "^1Walter" || !c.Created.Equal(nt.now) {
		t.Errorf("deviceClaim = %+v %v %v", c, ok, err)
	}
	if own, err := nt.db.ownsClaim(ctx, hash, "walter"); err != nil || !own {
		t.Errorf("ownsClaim walter = %v %v", own, err)
	}
	if own, _ := nt.db.ownsClaim(ctx, hash, "ann"); own {
		t.Error("owns ann")
	}
	if _, ok, _ := nt.db.claimByKey(ctx, nameKey("WALTER (1)")); !ok {
		t.Error("walter not claimed")
	}
	if _, ok, _ := nt.db.claimByKey(ctx, "bob"); ok {
		t.Error("bob claimed")
	}
	names, err := nt.db.claimedNames(ctx)
	if err != nil || len(names) != 2 || names["walter"] != "^1Walter" || names["ann"] != "Ann" {
		t.Errorf("claimedNames = %v %v", names, err)
	}
	// The admin release (E.5).
	if name, ok, err := nt.db.releaseClaim(ctx, "walter"); err != nil || !ok || name != "^1Walter" {
		t.Errorf("releaseClaim = %q %v %v", name, ok, err)
	}
	if _, ok, _ := nt.db.releaseClaim(ctx, "walter"); ok {
		t.Error("released twice")
	}
	if own, _ := nt.db.ownsClaim(ctx, hash, "walter"); own {
		t.Error("owns a released claim")
	}
	// Re-claimed by someone else: the old device doesn't own it.
	mustCode(t, nt.claim(&browser{addr: "203.0.113.3"}, "walter"))
	if own, _ := nt.db.ownsClaim(ctx, hash, "walter"); own {
		t.Error("old device owns the new claim")
	}
	if _, ok, _ := nt.db.deviceClaim(ctx, hash); ok {
		t.Error("old device has a claim")
	}
}

// A database from before claimed names (user_version 2) gets the tables;
// its totals and duels are kept.
func TestStatsDBMigratesPreClaimsDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), leaderboardFile)
	old, err := sql.Open("sqlite3", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(statsSchemaV0 + `
ALTER TABLE players ADD COLUMN gg_wins INTEGER NOT NULL DEFAULT 0;
CREATE TABLE duels (
	killer TEXT NOT NULL,
	victim TEXT NOT NULL,
	kills INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (killer, victim)
);
INSERT INTO duels (killer, victim, kills) VALUES ('Walter', 'Ann', 3);
PRAGMA user_version = 2;`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	ft := &followerTest{t: t}
	ft.open(path)
	if v := statsUserVersion(t, ft.db); v != len(statsMigrations) || v < 3 {
		t.Errorf("user_version %d, want %d", v, len(statsMigrations))
	}
	ft.expect(map[string]playerTotals{"Walter": {Kills: 5, Deaths: 2, Headshots: 1, Rounds: 3}})
	ft.expectDuels(map[duelPair]int64{{"Walter", "Ann"}: 3})
	ctx := context.Background()
	if err := ft.db.createClaim(ctx, nameClaim{Key: "walter", Name: "Walter", CodeHash: "h"}, "", "t", time.Unix(5, 0)); err != nil {
		t.Fatal(err)
	}
	// Opened again: the CREATE TABLEs don't run twice, the claim is kept.
	ft.open(path)
	if own, err := ft.db.ownsClaim(ctx, "t", "walter"); err != nil || !own {
		t.Errorf("ownsClaim after reopening = %v %v", own, err)
	}
	ft.expectDuels(map[duelPair]int64{{"Walter", "Ann"}: 3})
}
