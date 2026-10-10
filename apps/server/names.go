package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Claimed names (plan E.1/E.2). A player can claim a name; the browser
// gets a device token in the wc_player cookie and a recovery code is shown
// once, which signs in other browsers. Only SHA-256 hashes of both are kept,
// in the claims and devices tables of leaderboard.db (statsdb.go migration
// 3). Names are matched by nameKey (case, spaces, colour codes and the
// engine's " (1)" suffix don't matter). One name per device; a name can have
// several devices. With the database off every /names/ path is 404.
//
//	GET  /names/me                 {"name": "..."} or {} for this cookie
//	GET  /names/status?name=...    {"claimed": bool, "mine": bool}
//	POST /names/claim   {"name"}   sets the cookie -> {"name", "code"}
//	POST /names/signin  {"name", "code"}            -> {"name"}
//	POST /names/release {}         forgets this device -> {}
//	POST /names/release {"all": true, "code", "name"?}
//	                               releases the claim -> {"released": "..."}
//
// Errors are {"error": "<code>", "message": "..."}: 400 invalid_name /
// invalid_code / bad_request, 403 wrong_code, 409 taken / device_has_name
// (with "name": the device's name) / no_claim, 429 rate_limited /
// locked_out / too_many_claims (with Retry-After).
//
// POSTs must be same-origin JSON like the admin API (checkPost). Every
// /names/ path is rate limited per address (statusRate); wrong codes have
// their own lockout (namesMaxWrongCodes per namesCodeLockout), and one
// address can claim namesMaxClaims names per namesClaimWindow. Addresses are
// the TCP peer (clientKey), with the same reverse proxy caveat as the admin
// login.
//
// Internal API for the game side (E.3/E.4/E.5): deviceTokenHash reads the
// cookie of a request; statsDB.deviceClaim, ownsClaim, claimByKey,
// claimedNames and releaseClaim answer from the tables; nameKey and
// claimNameProblem are the name rules.

const (
	namesCookie       = "wc_player"
	namesCookieMaxAge = 365 * 24 * 60 * 60
	// nameMaxBytes is the engine's limit (cl->name is 32 bytes).
	nameMaxBytes = 31
	// deviceTokenBytes of crypto/rand, base64url without padding in the
	// cookie (43 characters).
	deviceTokenBytes = 32
	// recoveryCodeBytes of crypto/rand make recoveryCodeLen Crockford
	// base32 characters (80 bits).
	recoveryCodeBytes  = 10
	recoveryCodeLen    = 16
	namesMaxWrongCodes = 5
	namesCodeLockout   = 5 * time.Minute
	namesMaxClaims     = 5
	namesClaimWindow   = time.Hour
	namesTimeout       = 3 * time.Second
)

// crockford is Crockford's base32 alphabet (no I, L, O, U).
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

var (
	nameColourCode  = regexp.MustCompile(`\^[0-9]`)
	nameDupSuffix   = regexp.MustCompile(` \([0-9]+\)$`)
	reservedPlayerN = regexp.MustCompile(`^player [0-9]+$`)
)

// nameKey is what names are matched by: invalid UTF-8 becomes U+FFFD, the
// engine's colour codes ^0-^9 are removed (repeatedly), % & and every
// space become one space, format and control characters are dropped,
// spaces are collapsed and trimmed, letters are lowercased, one trailing
// " (<digits>)" (the engine's duplicate-name suffix) is dropped and a
// leading # becomes * (what ReGameDLL does to a name change).
func nameKey(name string) string {
	s := strings.ToValidUTF8(name, "\ufffd")
	for {
		t := nameColourCode.ReplaceAllString(s, "")
		if t == s {
			break
		}
		s = t
	}
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '%' || r == '&' || unicode.IsSpace(r):
			return ' '
		case unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Cc, r):
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	s = strings.ToLower(s)
	s = nameDupSuffix.ReplaceAllString(s, "")
	if strings.HasPrefix(s, "#") {
		s = "*" + s[1:]
	}
	return s
}

// reservedNameKey says whether a key can't be claimed: the engine's and the
// page's default names and the names E.4 renames impostors to.
func reservedNameKey(key string) bool {
	switch key {
	case "console", "unnamed", "player":
		return true
	}
	return reservedPlayerN.MatchString(key) || strings.HasSuffix(key, " (guest)")
}

// trimName trims what the engine trims from a name.
func trimName(name string) string {
	return strings.Trim(name, " \t\r\n")
}

// claimNameProblem says why name (already trimmed) can't be claimed, or ""
// if it can.
func claimNameProblem(name string) string {
	switch {
	case !utf8.ValidString(name):
		return "the name isn't valid UTF-8"
	case len(name) == 0 || len(name) > nameMaxBytes:
		return fmt.Sprintf("the name must be 1 to %d bytes", nameMaxBytes)
	case strings.ContainsAny(name, "\"\\;"):
		return `the name can't contain " \ or ;`
	case strings.Contains(name, ".."):
		return "the name can't contain .."
	case strings.ContainsRune(name, utf8.RuneError):
		return "the name can't contain U+FFFD"
	case strings.IndexFunc(name, func(r rune) bool { return unicode.Is(unicode.Cc, r) }) >= 0:
		return "the name can't contain control characters"
	}
	key := nameKey(name)
	if key == "" {
		return "the name has nothing but colour codes and spaces"
	}
	if reservedNameKey(key) {
		return "that name is reserved"
	}
	return ""
}

// hashSecret is how tokens and codes are stored: hex SHA-256.
func hashSecret(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// newDeviceToken returns a cookie value and its hash.
func newDeviceToken() (value, hash string, err error) {
	b := make([]byte, deviceTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), hashSecret(b), nil
}

// parseDeviceToken checks a cookie value and returns its hash. Anything but
// 43 base64url characters (32 bytes) is ignored without hashing.
func parseDeviceToken(value string) (string, bool) {
	if len(value) != base64.RawURLEncoding.EncodedLen(deviceTokenBytes) {
		return "", false
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(b) != deviceTokenBytes {
		return "", false
	}
	return hashSecret(b), true
}

// deviceTokenHash is the hash of the request's wc_player cookie, if it has
// a well-formed one. E.3 calls it on the game WebSocket.
func deviceTokenHash(r *http.Request) (string, bool) {
	c, err := r.Cookie(namesCookie)
	if err != nil {
		return "", false
	}
	return parseDeviceToken(c.Value)
}

// newRecoveryCode returns recoveryCodeLen canonical characters (format
// them with formatRecoveryCode).
func newRecoveryCode() (string, error) {
	b := make([]byte, recoveryCodeBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return encodeCrockford(b), nil
}

func encodeCrockford(b []byte) string {
	var out strings.Builder
	var acc uint64
	bits := 0
	for _, x := range b {
		acc = acc<<8 | uint64(x)
		bits += 8
		for bits >= 5 {
			out.WriteByte(crockford[(acc>>(bits-5))&31])
			bits -= 5
		}
	}
	if bits > 0 {
		out.WriteByte(crockford[(acc<<(5-bits))&31])
	}
	return out.String()
}

// formatRecoveryCode shows a canonical code as XXXX-XXXX-XXXX-XXXX.
func formatRecoveryCode(code string) string {
	var out strings.Builder
	for i := 0; i < len(code); i += 4 {
		if i > 0 {
			out.WriteByte('-')
		}
		out.WriteString(code[i:min(i+4, len(code))])
	}
	return out.String()
}

// canonicalRecoveryCode reads a code as typed: any case, dashes and spaces
// ignored, O read as 0 and I, L as 1.
func canonicalRecoveryCode(input string) (string, bool) {
	if len(input) > 64 {
		return "", false
	}
	var out strings.Builder
	for _, r := range strings.ToUpper(input) {
		switch {
		case r == '-' || unicode.IsSpace(r):
			continue
		case r == 'O':
			r = '0'
		case r == 'I' || r == 'L':
			r = '1'
		}
		if r >= utf8.RuneSelf || !strings.ContainsRune(crockford, r) {
			return "", false
		}
		out.WriteRune(r)
	}
	if out.Len() != recoveryCodeLen {
		return "", false
	}
	return out.String(), true
}

// codeMatches compares a canonical code with a stored hash in constant time.
func codeMatches(code, hash string) bool {
	given := hashSecret([]byte(code))
	return subtle.ConstantTimeCompare([]byte(given), []byte(hash)) == 1
}

// Storage (the claims and devices tables).

// nameClaim is one claimed name.
type nameClaim struct {
	Key      string // nameKey(Name)
	Name     string // the spelling it was claimed as
	CodeHash string
	Created  time.Time
}

var (
	errNameTaken = errors.New("the name is already claimed")
	// errNoClaim: the name isn't claimed (any more).
	errNoClaim = errors.New("the name isn't claimed")
	// errAlreadySignedIn: the device already has this name.
	errAlreadySignedIn = errors.New("this device already has the name")
)

// deviceHasNameError: the device already has another name.
type deviceHasNameError struct {
	Name string
}

func (e *deviceHasNameError) Error() string {
	return "this device already has the name " + e.Name
}

func scanClaim(row *sql.Row) (nameClaim, bool, error) {
	var c nameClaim
	var created int64
	err := row.Scan(&c.Key, &c.Name, &c.CodeHash, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nameClaim{}, false, nil
	}
	if err != nil {
		return nameClaim{}, false, err
	}
	c.Created = time.Unix(created, 0)
	return c, true, nil
}

// claimByKey returns the claim on a name key (isClaimed: ok).
func (s *statsDB) claimByKey(ctx context.Context, key string) (nameClaim, bool, error) {
	return scanClaim(s.db.QueryRowContext(ctx,
		`SELECT name_key, name, code_hash, created FROM claims WHERE name_key = ?`, key))
}

// deviceClaim returns the claim a device (by token hash) is signed in to.
func (s *statsDB) deviceClaim(ctx context.Context, tokenHash string) (nameClaim, bool, error) {
	return scanClaim(s.db.QueryRowContext(ctx, `
SELECT c.name_key, c.name, c.code_hash, c.created
FROM devices d JOIN claims c ON c.name_key = d.name_key
WHERE d.token_hash = ?`, tokenHash))
}

// ownsClaim says whether the device (by token hash) is signed in to the
// claim on key. E.3/E.4's check when tallying a claimed name.
func (s *statsDB) ownsClaim(ctx context.Context, tokenHash, key string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM devices d JOIN claims c ON c.name_key = d.name_key
WHERE d.token_hash = ? AND d.name_key = ?`, tokenHash, key).Scan(&n)
	return n > 0, err
}

// claimedNames maps every claimed key to its claimed spelling.
func (s *statsDB) claimedNames(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name_key, name FROM claims`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := map[string]string{}
	for rows.Next() {
		var key, name string
		if err := rows.Scan(&key, &name); err != nil {
			return nil, err
		}
		names[key] = name
	}
	return names, rows.Err()
}

// deviceKeyTx is the name key oldHash is signed in to ("" for none).
func deviceKeyTx(ctx context.Context, tx *sql.Tx, oldHash string) (string, error) {
	if oldHash == "" {
		return "", nil
	}
	var key string
	err := tx.QueryRowContext(ctx, `
SELECT d.name_key FROM devices d JOIN claims c ON c.name_key = d.name_key
WHERE d.token_hash = ?`, oldHash).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return key, err
}

func claimNameTx(ctx context.Context, tx *sql.Tx, key string) (string, error) {
	var name string
	err := tx.QueryRowContext(ctx, `SELECT name FROM claims WHERE name_key = ?`, key).Scan(&name)
	return name, err
}

// createClaim claims c.Name for the device newHash, in one transaction.
// oldHash is the device's current token hash ("" if none): a device that
// already has a name gets *deviceHasNameError, or errNameTaken if it is
// this one. A name claimed first by someone else is errNameTaken.
func (s *statsDB) createClaim(ctx context.Context, c nameClaim, oldHash, newHash string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	has, err := deviceKeyTx(ctx, tx, oldHash)
	if err != nil {
		return err
	}
	if has == c.Key {
		return errNameTaken
	}
	if has != "" {
		name, err := claimNameTx(ctx, tx, has)
		if err != nil {
			return err
		}
		return &deviceHasNameError{Name: name}
	}
	res, err := tx.ExecContext(ctx, `
INSERT INTO claims (name_key, name, code_hash, created) VALUES (?, ?, ?, ?)
ON CONFLICT (name_key) DO NOTHING`, c.Key, c.Name, c.CodeHash, now.Unix())
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return errNameTaken
	}
	// A stale row of oldHash (its claim was released) goes too.
	if oldHash != "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM devices WHERE token_hash = ?`, oldHash); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO devices (token_hash, name_key, created, last_seen) VALUES (?, ?, ?, ?)`,
		newHash, c.Key, now.Unix(), now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// addDevice signs the device newHash in to the claim on key (the code was
// checked by the caller). oldHash as for createClaim: *deviceHasNameError
// for another name, errAlreadySignedIn for this one. errNoClaim if the
// claim was released meanwhile.
func (s *statsDB) addDevice(ctx context.Context, key, oldHash, newHash string, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	has, err := deviceKeyTx(ctx, tx, oldHash)
	if err != nil {
		return err
	}
	if has == key {
		return errAlreadySignedIn
	}
	if has != "" {
		name, err := claimNameTx(ctx, tx, has)
		if err != nil {
			return err
		}
		return &deviceHasNameError{Name: name}
	}
	if _, err := claimNameTx(ctx, tx, key); errors.Is(err, sql.ErrNoRows) {
		return errNoClaim
	} else if err != nil {
		return err
	}
	if oldHash != "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM devices WHERE token_hash = ?`, oldHash); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO devices (token_hash, name_key, created, last_seen) VALUES (?, ?, ?, ?)`,
		newHash, key, now.Unix(), now.Unix()); err != nil {
		return err
	}
	return tx.Commit()
}

// touchDevice records that the device was seen.
func (s *statsDB) touchDevice(ctx context.Context, tokenHash string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE devices SET last_seen = ? WHERE token_hash = ?`, now.Unix(), tokenHash)
	return err
}

// removeDevice forgets one device; its claim stays.
func (s *statsDB) removeDevice(ctx context.Context, tokenHash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM devices WHERE token_hash = ?`, tokenHash)
	return err
}

// releaseClaim deletes the claim on key and all its devices, and returns
// the claimed spelling (ok false if it wasn't claimed). The leaderboard row
// is kept. Used by /names/release with the code and by E.5's admin action.
func (s *statsDB) releaseClaim(ctx context.Context, key string) (string, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	name, err := claimNameTx(ctx, tx, key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM devices WHERE name_key = ?`, key); err != nil {
		return "", false, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM claims WHERE name_key = ?`, key); err != nil {
		return "", false, err
	}
	return name, true, tx.Commit()
}

// HTTP.

type namesHandler struct {
	db      *statsDB
	limiter *rateLimiter
	// codes counts wrong recovery codes (separate from the admin login).
	codes *loginLimiter
	// claims counts successful claims per address.
	claims *loginLimiter
	now    func() time.Time
	logf   func(format string, args ...any)
}

func newNamesHandler(db *statsDB) *namesHandler {
	return &namesHandler{
		db:      db,
		limiter: newRateLimiter(statusRate, statusBurst),
		codes:   newLoginLimiter(namesMaxWrongCodes, namesCodeLockout),
		claims:  newLoginLimiter(namesMaxClaims, namesClaimWindow),
		now:     time.Now,
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "names: "+format+"\n", args...)
		},
	}
}

func namesError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

func retryAfter(w http.ResponseWriter, wait time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
}

func (h *namesHandler) cookie(r *http.Request, value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     namesCookie,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   httpsRequest(r),
		SameSite: http.SameSiteStrictMode,
	}
}

func (h *namesHandler) setCookie(w http.ResponseWriter, r *http.Request, value string) {
	http.SetCookie(w, h.cookie(r, value, namesCookieMaxAge))
}

func (h *namesHandler) clearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, h.cookie(r, "", -1))
}

func (h *namesHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if wait, ok := h.limiter.allow(clientKey(r), h.now()); !ok {
		retryAfter(w, wait)
		namesError(w, http.StatusTooManyRequests, "rate_limited", "too many requests")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), namesTimeout)
	defer cancel()
	r = r.WithContext(ctx)
	switch r.URL.Path {
	case "/names/me", "/names/status":
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			namesError(w, http.StatusMethodNotAllowed, "bad_request", "use GET")
			return
		}
		if r.URL.Path == "/names/me" {
			h.me(w, r)
		} else {
			h.status(w, r)
		}
	case "/names/claim", "/names/signin", "/names/release":
		if !checkPost(w, r) {
			return
		}
		var body struct {
			Name string `json:"name"`
			Code string `json:"code"`
			All  bool   `json:"all"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				namesError(w, http.StatusRequestEntityTooLarge, "bad_request", "body too large")
				return
			}
			namesError(w, http.StatusBadRequest, "bad_request", "the body must be a JSON object")
			return
		}
		switch r.URL.Path {
		case "/names/claim":
			h.claim(w, r, body.Name)
		case "/names/signin":
			h.signin(w, r, body.Name, body.Code)
		default:
			h.release(w, r, body.All, body.Name, body.Code)
		}
	default:
		http.NotFound(w, r)
	}
}

func (h *namesHandler) dbError(w http.ResponseWriter, err error) {
	h.logf("%v", err)
	namesError(w, http.StatusInternalServerError, "unavailable", "the names database isn't available")
}

// device is the request's device: its token hash and the claim it is
// signed in to, if any.
func (h *namesHandler) device(r *http.Request) (hash string, c nameClaim, ok bool, err error) {
	hash, valid := deviceTokenHash(r)
	if !valid {
		return "", nameClaim{}, false, nil
	}
	c, ok, err = h.db.deviceClaim(r.Context(), hash)
	return hash, c, ok, err
}

func (h *namesHandler) me(w http.ResponseWriter, r *http.Request) {
	hash, c, ok, err := h.device(r)
	if err != nil {
		h.dbError(w, err)
		return
	}
	if !ok {
		if _, err := r.Cookie(namesCookie); err == nil {
			// Malformed, or its device or claim is gone.
			h.clearCookie(w, r)
		}
		writeJSON(w, http.StatusOK, struct{}{})
		return
	}
	if err := h.db.touchDevice(r.Context(), hash, h.now()); err != nil {
		h.dbError(w, err)
		return
	}
	cookie, _ := r.Cookie(namesCookie)
	h.setCookie(w, r, cookie.Value)
	writeJSON(w, http.StatusOK, map[string]string{"name": c.Name})
}

func (h *namesHandler) status(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" || len(name) > statsNameMax {
		namesError(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("name must be 1 to %d bytes", statsNameMax))
		return
	}
	key := nameKey(name)
	result := struct {
		Claimed bool `json:"claimed"`
		Mine    bool `json:"mine"`
	}{}
	if key != "" {
		_, claimed, err := h.db.claimByKey(r.Context(), key)
		if err != nil {
			h.dbError(w, err)
			return
		}
		result.Claimed = claimed
		if hash, ok := deviceTokenHash(r); claimed && ok {
			if result.Mine, err = h.db.ownsClaim(r.Context(), hash, key); err != nil {
				h.dbError(w, err)
				return
			}
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *namesHandler) deviceHasName(w http.ResponseWriter, name string) {
	writeJSON(w, http.StatusConflict, map[string]string{
		"error":   "device_has_name",
		"message": "this browser already has the name " + name + ": release this device first",
		"name":    name,
	})
}

func (h *namesHandler) claim(w http.ResponseWriter, r *http.Request, name string) {
	client := clientKey(r)
	now := h.now()
	name = trimName(name)
	if problem := claimNameProblem(name); problem != "" {
		namesError(w, http.StatusBadRequest, "invalid_name", problem)
		return
	}
	if wait, locked := h.claims.locked(client, now); locked {
		retryAfter(w, wait)
		namesError(w, http.StatusTooManyRequests, "too_many_claims", "too many names claimed from this address: try again later")
		return
	}
	code, err := newRecoveryCode()
	if err != nil {
		h.dbError(w, err)
		return
	}
	value, newHash, err := newDeviceToken()
	if err != nil {
		h.dbError(w, err)
		return
	}
	oldHash, _ := deviceTokenHash(r)
	c := nameClaim{Key: nameKey(name), Name: name, CodeHash: hashSecret([]byte(code))}
	err = h.db.createClaim(r.Context(), c, oldHash, newHash, now)
	var hasName *deviceHasNameError
	switch {
	case errors.As(err, &hasName):
		h.deviceHasName(w, hasName.Name)
		return
	case errors.Is(err, errNameTaken):
		namesError(w, http.StatusConflict, "taken", "that name is already claimed")
		return
	case err != nil:
		h.dbError(w, err)
		return
	}
	h.claims.fail(client, now)
	h.logf("%s: claimed %q", client, name)
	h.setCookie(w, r, value)
	writeJSON(w, http.StatusOK, map[string]string{"name": name, "code": formatRecoveryCode(code)})
}

// checkCode checks a recovery code for the claim on key, counting wrong
// ones (an unclaimed name counts as a wrong code too). It writes the error
// and returns false if the code isn't right.
func (h *namesHandler) checkCode(w http.ResponseWriter, r *http.Request, key, input string) (nameClaim, bool) {
	client := clientKey(r)
	now := h.now()
	if wait, locked := h.codes.locked(client, now); locked {
		retryAfter(w, wait)
		namesError(w, http.StatusTooManyRequests, "locked_out", "too many wrong codes: try again later")
		return nameClaim{}, false
	}
	code, ok := canonicalRecoveryCode(input)
	if !ok {
		namesError(w, http.StatusBadRequest, "invalid_code", fmt.Sprintf("a recovery code is %d letters and digits", recoveryCodeLen))
		return nameClaim{}, false
	}
	c, claimed, err := h.db.claimByKey(r.Context(), key)
	if err != nil {
		h.dbError(w, err)
		return nameClaim{}, false
	}
	if claimed && codeMatches(code, c.CodeHash) {
		return c, true
	}
	if h.codes.fail(client, now) {
		h.logf("%s: %d wrong codes, locked out for %v", client, namesMaxWrongCodes, namesCodeLockout)
		retryAfter(w, namesCodeLockout)
		namesError(w, http.StatusTooManyRequests, "locked_out", "too many wrong codes: try again later")
		return nameClaim{}, false
	}
	h.logf("%s: wrong code for %q", client, key)
	namesError(w, http.StatusForbidden, "wrong_code", "wrong name or recovery code")
	return nameClaim{}, false
}

func (h *namesHandler) signin(w http.ResponseWriter, r *http.Request, name, code string) {
	name = trimName(name)
	key := nameKey(name)
	if key == "" || len(name) > statsNameMax {
		namesError(w, http.StatusBadRequest, "invalid_name", "give the claimed name")
		return
	}
	oldHash, has, hasOK, err := h.device(r)
	if err != nil {
		h.dbError(w, err)
		return
	}
	if hasOK {
		if has.Key != key {
			h.deviceHasName(w, has.Name)
			return
		}
		cookie, _ := r.Cookie(namesCookie)
		h.setCookie(w, r, cookie.Value)
		writeJSON(w, http.StatusOK, map[string]string{"name": has.Name})
		return
	}
	c, ok := h.checkCode(w, r, key, code)
	if !ok {
		return
	}
	value, newHash, err := newDeviceToken()
	if err != nil {
		h.dbError(w, err)
		return
	}
	err = h.db.addDevice(r.Context(), key, oldHash, newHash, h.now())
	var hasName *deviceHasNameError
	switch {
	case errors.As(err, &hasName):
		h.deviceHasName(w, hasName.Name)
		return
	case errors.Is(err, errAlreadySignedIn):
		// A sign-in of this device raced this one.
		writeJSON(w, http.StatusOK, map[string]string{"name": c.Name})
		return
	case errors.Is(err, errNoClaim):
		namesError(w, http.StatusConflict, "no_claim", "that name was released meanwhile")
		return
	case err != nil:
		h.dbError(w, err)
		return
	}
	h.logf("%s: signed in to %q", clientKey(r), c.Name)
	h.setCookie(w, r, value)
	writeJSON(w, http.StatusOK, map[string]string{"name": c.Name})
}

func (h *namesHandler) release(w http.ResponseWriter, r *http.Request, all bool, name, code string) {
	hash, has, hasOK, err := h.device(r)
	if err != nil {
		h.dbError(w, err)
		return
	}
	if !all {
		if hash != "" {
			if err := h.db.removeDevice(r.Context(), hash); err != nil {
				h.dbError(w, err)
				return
			}
		}
		if _, err := r.Cookie(namesCookie); err == nil {
			h.clearCookie(w, r)
		}
		if hasOK {
			h.logf("%s: released a device of %q", clientKey(r), has.Name)
		}
		writeJSON(w, http.StatusOK, struct{}{})
		return
	}
	key := nameKey(trimName(name))
	if name == "" && hasOK {
		key = has.Key
	}
	if key == "" || len(name) > statsNameMax {
		namesError(w, http.StatusBadRequest, "invalid_name", "give the claimed name")
		return
	}
	if _, ok := h.checkCode(w, r, key, code); !ok {
		return
	}
	released, ok, err := h.db.releaseClaim(r.Context(), key)
	if err != nil {
		h.dbError(w, err)
		return
	}
	if !ok {
		namesError(w, http.StatusConflict, "no_claim", "that name was released meanwhile")
		return
	}
	if hasOK && has.Key == key {
		h.clearCookie(w, r)
	}
	h.logf("%s: released %q", clientKey(r), released)
	writeJSON(w, http.StatusOK, map[string]string{"released": released})
}
