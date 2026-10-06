package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The admin API lets the F4 menu run admin actions without the browser ever
// knowing the rcon password. It is on only when ADMIN_PASSWORD is set; with
// it unset every /admin/ path is 404 and the menu falls back to rcon.
//
//	GET  /admin/session  {"loggedIn": bool}
//	POST /admin/login    {"password": "..."} -> session cookie
//	POST /admin/logout   clears the cookie
//	POST /admin/command  one typed action (admin_actions.go)
//	                     -> {"output": "<what the engine printed>"}
//
// The session is a cookie signed with a key made at startup (so a restart
// logs everyone out): HttpOnly, SameSite=Strict, Path=/admin/, Secure when
// the page came over https, valid for adminSessionTTL.
//
// Requests that change something must be JSON (a cross-site form can't send
// that without a CORS preflight, which this server never answers) and, when
// the browser says where they come from (Origin, Sec-Fetch-Site), come from
// this host. SameSite=Strict keeps the cookie off cross-site requests too.
//
// Wrong passwords are counted per remote address: adminMaxFailures in a row
// lock that address out for adminLockout. The address is the TCP peer
// (r.RemoteAddr), like the WebSocket limits in sfu.go: X-Forwarded-For is
// not trusted, since anyone can send it. Behind a reverse proxy every
// client shares the proxy's address, so one person guessing locks everyone
// out of logging in (not out of the game). IPv6 addresses are counted per
// /64, since one host usually gets a whole /64.

const (
	adminSessionCookie = "cs_admin"
	adminSessionTTL    = 8 * time.Hour
	adminMaxFailures   = 5
	adminLockout       = 5 * time.Minute
	// adminMinPassword is the shortest ADMIN_PASSWORD the server accepts.
	adminMinPassword = 8
	adminMaxBody     = 4 << 10
	// adminCommandTimeout covers a map change, which the engine runs before
	// it answers.
	adminCommandTimeout = 20 * time.Second
)

// consoleRunner runs one engine command and returns what it printed.
type consoleRunner interface {
	Run(ctx context.Context, command string) (string, error)
}

type adminAPI struct {
	password [sha256.Size]byte
	key      []byte
	console  consoleRunner
	env      actionEnv
	limiter  *loginLimiter
	now      func() time.Time
	// logf writes the audit log (stderr; the pion logger hides warnings).
	logf func(format string, args ...any)
}

// adminPasswordProblem says why password can't be used, or "" if it can.
func adminPasswordProblem(password string) string {
	if len(password) < adminMinPassword {
		return fmt.Sprintf("shorter than %d characters", adminMinPassword)
	}
	if len(password) > 256 {
		return "longer than 256 characters"
	}
	return ""
}

func newAdminAPI(password string, console consoleRunner, env actionEnv) *adminAPI {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(err)
	}
	return &adminAPI{
		password: sha256.Sum256([]byte(password)),
		key:      key,
		console:  console,
		env:      env,
		limiter:  newLoginLimiter(adminMaxFailures, adminLockout),
		now:      time.Now,
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "admin: "+format+"\n", args...)
		},
	}
}

func (a *adminAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/admin/session":
		if r.Method != http.MethodGet {
			writeJSONError(w, http.StatusMethodNotAllowed, "use GET")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"loggedIn": a.loggedIn(r)})
	case "/admin/login":
		if a.checkPost(w, r) {
			a.login(w, r)
		}
	case "/admin/logout":
		if a.checkPost(w, r) {
			http.SetCookie(w, a.cookie(r, "", -1))
			writeJSON(w, http.StatusOK, map[string]bool{"loggedIn": false})
		}
	case "/admin/command":
		if !a.checkPost(w, r) {
			return
		}
		if !a.loggedIn(r) {
			writeJSONError(w, http.StatusUnauthorized, "not logged in")
			return
		}
		a.command(w, r)
	default:
		http.NotFound(w, r)
	}
}

// checkPost refuses anything but a same-origin JSON POST.
func (a *adminAPI) checkPost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "use POST")
		return false
	}
	if !sameOrigin(r) {
		writeJSONError(w, http.StatusForbidden, "cross-origin request")
		return false
	}
	if media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || media != "application/json" {
		writeJSONError(w, http.StatusUnsupportedMediaType, "the body must be application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, adminMaxBody)
	return true
}

// sameOrigin accepts requests whose Origin (if sent) is this host and whose
// Sec-Fetch-Site (if sent) isn't cross-site. Non-browser clients send
// neither. ALLOWED_ORIGINS doesn't apply here.
func sameOrigin(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host != "" && strings.EqualFold(u.Host, r.Host)
}

func (a *adminAPI) login(w http.ResponseWriter, r *http.Request) {
	client := clientKey(r)
	now := a.now()
	if wait, locked := a.limiter.locked(client, now); locked {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds()+0.999)))
		writeJSONError(w, http.StatusTooManyRequests, "too many wrong passwords: try again later")
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "the body must be {\"password\": \"...\"}")
		return
	}
	given := sha256.Sum256([]byte(body.Password))
	if subtle.ConstantTimeCompare(given[:], a.password[:]) != 1 {
		if a.limiter.fail(client, now) {
			a.logf("%s: %d wrong passwords, locked out for %v", client, adminMaxFailures, adminLockout)
			w.Header().Set("Retry-After", strconv.Itoa(int(adminLockout.Seconds())))
			writeJSONError(w, http.StatusTooManyRequests, "too many wrong passwords: try again later")
			return
		}
		a.logf("%s: wrong password", client)
		writeJSONError(w, http.StatusUnauthorized, "wrong password")
		return
	}
	a.limiter.succeed(client)
	a.logf("%s: logged in", client)
	http.SetCookie(w, a.cookie(r, a.newSession(now), int(adminSessionTTL.Seconds())))
	writeJSON(w, http.StatusOK, map[string]bool{"loggedIn": true})
}

func (a *adminAPI) command(w http.ResponseWriter, r *http.Request) {
	action, err := parseAdminAction(r.Body, a.env)
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "body too large")
			return
		}
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if action.run != nil {
		a.runAction(w, r, action)
		return
	}
	a.logf("%s: %s: %s", clientKey(r), action.name, strings.Join(action.commands, "; "))
	var output strings.Builder
	for _, command := range action.commands {
		ctx, cancel := context.WithTimeout(r.Context(), adminCommandTimeout)
		out, err := a.console.Run(ctx, command)
		cancel()
		output.WriteString(out)
		if err != nil {
			a.logf("%s: %s: %v", clientKey(r), command, err)
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{
				"error":  "the game server didn't answer",
				"output": output.String(),
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": output.String()})
}

// runAction runs an action that has a runner (the bans).
func (a *adminAPI) runAction(w http.ResponseWriter, r *http.Request, action adminAction) {
	client := clientKey(r)
	ctx, cancel := context.WithTimeout(r.Context(), adminCommandTimeout)
	defer cancel()
	result, err := action.run(ctx, a, client)
	if err == nil {
		writeJSON(w, http.StatusOK, result)
		return
	}
	var refused *actionError
	if errors.As(err, &refused) {
		writeJSON(w, refused.status, map[string]string{"error": refused.message, "output": result.Output})
		return
	}
	a.logf("%s: %s: %v", client, action.name, err)
	writeJSON(w, http.StatusGatewayTimeout, map[string]string{
		"error":  "the game server didn't answer",
		"output": result.Output,
	})
}

// Sessions are "<expiry unix seconds>.<random>.<HMAC-SHA256 of both>".

func (a *adminAPI) newSession(now time.Time) string {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	payload := strconv.FormatInt(now.Add(adminSessionTTL).Unix(), 10) + "." + hex.EncodeToString(nonce)
	return payload + "." + a.sign(payload)
}

func (a *adminAPI) sign(payload string) string {
	mac := hmac.New(sha256.New, a.key)
	mac.Write([]byte("admin-session\x00" + payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *adminAPI) validSession(value string, now time.Time) bool {
	cut := strings.LastIndexByte(value, '.')
	if cut < 0 {
		return false
	}
	payload, sig := value[:cut], value[cut+1:]
	if !hmac.Equal([]byte(sig), []byte(a.sign(payload))) {
		return false
	}
	expiry, _, ok := strings.Cut(payload, ".")
	if !ok {
		return false
	}
	unix, err := strconv.ParseInt(expiry, 10, 64)
	return err == nil && now.Unix() < unix
}

func (a *adminAPI) loggedIn(r *http.Request) bool {
	c, err := r.Cookie(adminSessionCookie)
	return err == nil && a.validSession(c.Value, a.now())
}

func (a *adminAPI) cookie(r *http.Request, value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     adminSessionCookie,
		Value:    value,
		Path:     "/admin/",
		MaxAge:   maxAge,
		HttpOnly: true,
		// Behind a TLS-terminating proxy the request itself is plain HTTP.
		// Trusting the header here can only make the cookie stricter.
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		SameSite: http.SameSiteStrictMode,
	}
}

// clientKey is the address wrong passwords are counted under.
// It is also the address bans are keyed by (bans.go).
func clientKey(r *http.Request) string {
	return addressKey(remoteHost(r))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// loginLimiter counts wrong passwords per address. maxFailures in a row,
// each less than lockout after the previous one, lock the address out for
// lockout.
type loginLimiter struct {
	mu          sync.Mutex
	maxFailures int
	lockout     time.Duration
	entries     map[string]*loginEntry
}

type loginEntry struct {
	failures    int
	last        time.Time
	lockedUntil time.Time
}

func newLoginLimiter(maxFailures int, lockout time.Duration) *loginLimiter {
	return &loginLimiter{maxFailures: maxFailures, lockout: lockout, entries: map[string]*loginEntry{}}
}

// locked returns how long key is still locked out.
func (l *loginLimiter) locked(key string, now time.Time) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e := l.entries[key]; e != nil && now.Before(e.lockedUntil) {
		return e.lockedUntil.Sub(now), true
	}
	return 0, false
}

// fail counts a wrong password and reports whether it locked key out.
func (l *loginLimiter) fail(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(now)
	e := l.entries[key]
	if e == nil {
		e = &loginEntry{}
		l.entries[key] = e
	}
	if now.Sub(e.last) >= l.lockout {
		e.failures = 0
	}
	e.failures++
	e.last = now
	if e.failures < l.maxFailures {
		return false
	}
	e.failures = 0
	e.lockedUntil = now.Add(l.lockout)
	return true
}

func (l *loginLimiter) succeed(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

// prune forgets addresses that are neither locked nor counting, so the map
// can't grow without bound.
func (l *loginLimiter) prune(now time.Time) {
	if len(l.entries) < 1024 {
		return
	}
	for key, e := range l.entries {
		if now.Sub(e.last) >= l.lockout && !now.Before(e.lockedUntil) {
			delete(l.entries, key)
		}
	}
}
