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

type fakeConsole struct {
	commands []string
	output   string
	err      error
}

func (c *fakeConsole) Run(_ context.Context, command string) (string, error) {
	c.commands = append(c.commands, command)
	return c.output, c.err
}

const testAdminPassword = "correct horse"

func newTestAdmin(t *testing.T) (*adminAPI, *fakeConsole, *time.Time) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "de_dust2.bsp"), []byte("BSP"), 0o644); err != nil {
		t.Fatal(err)
	}
	console := &fakeConsole{}
	a := newAdminAPI(testAdminPassword, console, actionEnv{mapsDir: dir})
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }
	a.logf = func(string, ...any) {}
	return a, console, &now
}

type adminRequest struct {
	method, path, body string
	remote             string
	header             map[string]string
	cookie             *http.Cookie
}

func (a *adminAPI) do(req adminRequest) *httptest.ResponseRecorder {
	method := req.method
	if method == "" {
		method = http.MethodPost
	}
	r := httptest.NewRequest(method, "http://cs.example"+req.path, strings.NewReader(req.body))
	if method == http.MethodPost {
		r.Header.Set("Content-Type", "application/json")
	}
	r.RemoteAddr = "203.0.113.7:4000"
	if req.remote != "" {
		r.RemoteAddr = req.remote
	}
	for k, v := range req.header {
		r.Header.Set(k, v)
	}
	if req.cookie != nil {
		r.AddCookie(req.cookie)
	}
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, r)
	return rec
}

func login(t *testing.T, a *adminAPI, password, remote string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"password": password})
	return a.do(adminRequest{path: "/admin/login", body: string(body), remote: remote})
}

func sessionCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == adminSessionCookie {
			return c
		}
	}
	t.Fatalf("no %s cookie in %v", adminSessionCookie, rec.Header())
	return nil
}

func TestAdminLogin(t *testing.T) {
	a, _, _ := newTestAdmin(t)

	rec := a.do(adminRequest{method: http.MethodGet, path: "/admin/session"})
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"loggedIn":false}` {
		t.Fatalf("session before login = %d %s", rec.Code, rec.Body)
	}

	if rec := login(t, a, "wrong password", ""); rec.Code != http.StatusUnauthorized || len(rec.Result().Cookies()) != 0 {
		t.Fatalf("wrong password = %d, cookies %v", rec.Code, rec.Result().Cookies())
	}

	rec = login(t, a, testAdminPassword, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("login = %d %s", rec.Code, rec.Body)
	}
	c := sessionCookie(t, rec)
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/admin/" || c.Secure ||
		c.MaxAge != int(adminSessionTTL.Seconds()) {
		t.Fatalf("cookie = %+v", c)
	}
	if strings.Contains(c.Value, testAdminPassword) {
		t.Fatal("cookie contains the password")
	}

	rec = a.do(adminRequest{method: http.MethodGet, path: "/admin/session", cookie: c})
	if strings.TrimSpace(rec.Body.String()) != `{"loggedIn":true}` {
		t.Fatalf("session after login = %s", rec.Body)
	}

	rec = a.do(adminRequest{path: "/admin/logout", body: "{}", cookie: c})
	if out := sessionCookie(t, rec); rec.Code != http.StatusOK || out.MaxAge >= 0 || out.Value != "" {
		t.Fatalf("logout = %d, cookie %+v", rec.Code, out)
	}
}

func TestAdminCookieSecureOverHTTPS(t *testing.T) {
	a, _, _ := newTestAdmin(t)
	rec := a.do(adminRequest{
		path:   "/admin/login",
		body:   `{"password":"` + testAdminPassword + `"}`,
		header: map[string]string{"X-Forwarded-Proto": "https"},
	})
	if c := sessionCookie(t, rec); !c.Secure {
		t.Fatalf("cookie over https = %+v", c)
	}
}

func TestAdminSessionSigning(t *testing.T) {
	a, _, now := newTestAdmin(t)
	value := a.newSession(*now)
	if !a.validSession(value, *now) {
		t.Fatal("fresh session is invalid")
	}
	if a.validSession(value, now.Add(adminSessionTTL)) {
		t.Fatal("session valid after its expiry")
	}
	expiry, rest, _ := strings.Cut(value, ".")
	for name, forged := range map[string]string{
		"later expiry":  "9" + expiry + "." + rest,
		"no signature":  value[:strings.LastIndexByte(value, '.')],
		"bad signature": value[:len(value)-2] + "xx",
		"empty":         "",
		"garbage":       "a.b.c",
	} {
		if a.validSession(forged, *now) {
			t.Errorf("%s: forged session accepted", name)
		}
	}
	other, _, _ := newTestAdmin(t)
	if other.validSession(value, *now) {
		t.Fatal("session from another process key accepted")
	}

	// An expired cookie is refused by the API too.
	c := &http.Cookie{Name: adminSessionCookie, Value: value}
	*now = now.Add(adminSessionTTL + time.Second)
	if rec := a.do(adminRequest{path: "/admin/command", body: `{"action":"restart"}`, cookie: c}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("expired session command = %d", rec.Code)
	}
}

func TestAdminLockout(t *testing.T) {
	a, _, now := newTestAdmin(t)
	const attacker = "198.51.100.9:5000"

	for i := 1; i < adminMaxFailures; i++ {
		if rec := login(t, a, "guess", attacker); rec.Code != http.StatusUnauthorized {
			t.Fatalf("wrong password %d = %d", i, rec.Code)
		}
	}
	rec := login(t, a, "guess", attacker)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "300" {
		t.Fatalf("wrong password %d = %d, Retry-After %q", adminMaxFailures, rec.Code, rec.Header().Get("Retry-After"))
	}
	// Even the right password is refused while locked out, from any port.
	if rec := login(t, a, testAdminPassword, "198.51.100.9:6000"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("right password while locked = %d", rec.Code)
	}
	// Other addresses aren't affected.
	if rec := login(t, a, testAdminPassword, "203.0.113.8:1"); rec.Code != http.StatusOK {
		t.Fatalf("other address = %d", rec.Code)
	}

	*now = now.Add(adminLockout - time.Second)
	if rec := login(t, a, testAdminPassword, attacker); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("1 s before the end = %d", rec.Code)
	}
	*now = now.Add(time.Second)
	if rec := login(t, a, testAdminPassword, attacker); rec.Code != http.StatusOK {
		t.Fatalf("after the lockout = %d", rec.Code)
	}
}

func TestAdminLockoutCountsRecentFailures(t *testing.T) {
	a, _, now := newTestAdmin(t)
	// Wrong passwords more than adminLockout apart never add up.
	for i := 0; i < 2*adminMaxFailures; i++ {
		if rec := login(t, a, "guess", ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("spread-out wrong password %d = %d", i, rec.Code)
		}
		*now = now.Add(adminLockout)
	}
	// A success clears the count.
	for i := 0; i < adminMaxFailures-1; i++ {
		login(t, a, "guess", "")
	}
	login(t, a, testAdminPassword, "")
	if rec := login(t, a, "guess", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("after a success = %d", rec.Code)
	}
}

func TestAdminLockoutIPv6Prefix(t *testing.T) {
	a, _, _ := newTestAdmin(t)
	for i := 0; i < adminMaxFailures; i++ {
		// A different address in the same /64 each time.
		login(t, a, "guess", "[2001:db8:1:2::"+string(rune('a'+i))+"]:443")
	}
	if rec := login(t, a, testAdminPassword, "[2001:db8:1:2::ffff]:443"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("same /64 = %d", rec.Code)
	}
	if rec := login(t, a, testAdminPassword, "[2001:db8:1:3::1]:443"); rec.Code != http.StatusOK {
		t.Fatalf("other /64 = %d", rec.Code)
	}
}

func TestAdminCommand(t *testing.T) {
	a, console, _ := newTestAdmin(t)
	c := sessionCookie(t, login(t, a, testAdminPassword, ""))
	console.output = "ok\n"

	rec := a.do(adminRequest{path: "/admin/command", body: `{"action":"kick","userid":3}`, cookie: c})
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"output":"ok\n"}` {
		t.Fatalf("kick = %d %s", rec.Code, rec.Body)
	}
	if want := []string{"kick #3"}; !reflect.DeepEqual(console.commands, want) {
		t.Fatalf("commands = %q, want %q", console.commands, want)
	}

	console.commands = nil
	console.err = errors.New("timeout")
	rec = a.do(adminRequest{path: "/admin/command", body: `{"action":"say","text":"hi"}`, cookie: c})
	if rec.Code != http.StatusGatewayTimeout || len(console.commands) != 1 {
		t.Fatalf("console error = %d, commands %q", rec.Code, console.commands)
	}
}

func TestAdminCommandRefused(t *testing.T) {
	a, console, _ := newTestAdmin(t)
	c := sessionCookie(t, login(t, a, testAdminPassword, ""))
	valid := `{"action":"restart"}`

	for _, tc := range []struct {
		name string
		req  adminRequest
		want int
	}{
		{"no session", adminRequest{body: valid}, http.StatusUnauthorized},
		{"forged session", adminRequest{body: valid, cookie: &http.Cookie{Name: adminSessionCookie, Value: "1.2.3"}}, http.StatusUnauthorized},
		{"GET", adminRequest{method: http.MethodGet, cookie: c}, http.StatusMethodNotAllowed},
		{"form post", adminRequest{body: valid, cookie: c, header: map[string]string{"Content-Type": "application/x-www-form-urlencoded"}}, http.StatusUnsupportedMediaType},
		{"text/plain", adminRequest{body: valid, cookie: c, header: map[string]string{"Content-Type": "text/plain"}}, http.StatusUnsupportedMediaType},
		{"other origin", adminRequest{body: valid, cookie: c, header: map[string]string{"Origin": "http://evil.example"}}, http.StatusForbidden},
		{"cross-site fetch", adminRequest{body: valid, cookie: c, header: map[string]string{"Sec-Fetch-Site": "cross-site"}}, http.StatusForbidden},
		{"unknown action", adminRequest{body: `{"action":"rcon","command":"quit"}`, cookie: c}, http.StatusBadRequest},
		{"too big", adminRequest{body: `{"action":"say","text":"` + strings.Repeat("a", adminMaxBody) + `"}`, cookie: c}, http.StatusRequestEntityTooLarge},
	} {
		tc.req.path = "/admin/command"
		if rec := a.do(tc.req); rec.Code != tc.want {
			t.Errorf("%s = %d, want %d (%s)", tc.name, rec.Code, tc.want, rec.Body)
		}
	}
	if len(console.commands) != 0 {
		t.Fatalf("refused requests ran %q", console.commands)
	}

	ok := a.do(adminRequest{path: "/admin/command", body: valid, cookie: c, header: map[string]string{
		"Origin":         "http://cs.example",
		"Sec-Fetch-Site": "same-origin",
		"Content-Type":   "application/json; charset=utf-8",
	}})
	if ok.Code != http.StatusOK {
		t.Fatalf("same-origin browser request = %d %s", ok.Code, ok.Body)
	}
	// Login is a POST like the others.
	if rec := a.do(adminRequest{path: "/admin/login", body: `{"password":"` + testAdminPassword + `"}`, header: map[string]string{"Origin": "http://evil.example"}}); rec.Code != http.StatusForbidden {
		t.Fatalf("cross-origin login = %d", rec.Code)
	}
}

func TestAdminDisabled(t *testing.T) {
	s := &Server{}
	for _, path := range []string{"/admin/session", "/admin/login", "/admin/command"} {
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s with the API off = %d, want 404", path, rec.Code)
		}
	}
}

func TestAdminPasswordProblem(t *testing.T) {
	for password, ok := range map[string]bool{
		"":                       false,
		"short":                  false,
		"exactly8":               true,
		"a long pass phrase":     true,
		strings.Repeat("x", 257): false,
	} {
		if got := adminPasswordProblem(password) == ""; got != ok {
			t.Errorf("adminPasswordProblem(%q) ok = %v, want %v", password, got, ok)
		}
	}
}
