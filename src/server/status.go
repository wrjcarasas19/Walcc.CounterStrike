package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// GET /status.json is the lobby status on the login page: map, players,
// max players, time left and next map. Anyone can read it (it is what a
// server browser shows), banned addresses included.
//
// The data comes from the engine's own server queries, asked the same way
// console.go asks rcon: Go hands the engine a connectionless packet from an
// address no player has (queryAddr) and catches the answer in the sendto
// callback. No rcon is involved, so it works without ADMIN_PASSWORD, needs
// no rcon password, and the engine logs nothing (sv_log_outofband is 0).
// Xash3D FWGS (sv_query.c) answers these without a challenge:
//
//   - "TSource Engine Query" (A2S_INFO) -> 'I': map, player count (bots
//     included), max players. The engine tokenizes the packet before
//     comparing, so the name has to be sent quoted to stay one word.
//   - 'U' (A2S_PLAYER) -> 'D': name, frags and connection time of every
//     client; bots (FCL_FAKECLIENT, YaPB included) have time -1. No team.
//     Not answered at all with no players, sv_password set, or
//     sv_expose_player_list 0.
//   - 'V' (A2S_RULES) -> 'E': every FCVAR_SERVER cvar, which includes
//     mp_timelimit, AMX Mod X's amx_timeleft ("MM:SS", updated every 0.8 s
//     by timeleft.amxx) and amx_nextmap.
//
// Answers are cached for statusCacheTTL and concurrent requests share one
// engine query, so the engine sees at most three small packets per
// statusCacheTTL however many people watch the login page. Each address is
// also rate limited (statusRate, like the login lockout: the TCP peer, not
// X-Forwarded-For).

// queryAddr is the fake address server queries come from (see consoleAddr).
var queryAddr = [4]byte{254, 0, 0, 2}

const (
	statusCacheTTL = 2 * time.Second
	// statusQueryTimeout is how long one query waits for the engine. A map
	// change keeps the engine busy for longer; the request then fails and
	// the page keeps what it showed.
	statusQueryTimeout = 1500 * time.Millisecond
	// statusRate requests per second per address, in bursts of statusBurst.
	// The login page asks every 5 seconds; behind a reverse proxy everyone
	// shares one address, so this is generous (the cache protects the
	// engine, this only bounds the work per address).
	statusRate  = 5
	statusBurst = 20
)

var (
	infoRequest    = []byte(oobHeader + `"TSource Engine Query"` + "\x00")
	playersRequest = []byte(oobHeader + "U\x00")
	rulesRequest   = []byte(oobHeader + "V\x00")
)

// Reply types.
const (
	infoReply    = 'I'
	playersReply = 'D'
	rulesReply   = 'E'
)

var errBadReply = errors.New("malformed reply")

// serverStatus is the /status.json body.
type serverStatus struct {
	Map string `json:"map"`
	// PlayerCount counts everyone connected, bots included, like the
	// scoreboard.
	PlayerCount int            `json:"playerCount"`
	MaxPlayers  int            `json:"maxPlayers"`
	Bots        int            `json:"bots"`
	Players     []statusPlayer `json:"players"`
	// TimeLimit is mp_timelimit in minutes (0 = no limit), nil if unknown.
	TimeLimit *float64 `json:"timeLimit"`
	// TimeLeft is in seconds; nil with no time limit or without AMX Mod X.
	TimeLeft *int `json:"timeLeft"`
	// NextMap is amx_nextmap ("" without AMX Mod X).
	NextMap string `json:"nextMap,omitempty"`
}

type statusPlayer struct {
	Name  string `json:"name"`
	Frags int    `json:"frags"`
	Bot   bool   `json:"bot,omitempty"`
}

// statusSource reads the server's status from the engine.
type statusSource interface {
	status(ctx context.Context) (serverStatus, error)
}

// engineQuery asks the engine one server query at a time.
type engineQuery struct {
	mu sync.Mutex
	// send queues a packet for the engine (as if it came from queryAddr).
	send    func(ctx context.Context, data []byte) error
	replies chan []byte
}

func newEngineQuery(send func(ctx context.Context, data []byte) error) *engineQuery {
	return &engineQuery{send: send, replies: make(chan []byte, 16)}
}

// queueQueryPacket hands data to the engine as a packet from queryAddr.
func queueQueryPacket(ctx context.Context, data []byte) error {
	return queuePacketFrom(ctx, queryAddr, data)
}

// deliver takes a packet the engine sent to queryAddr. It is called on the
// engine thread; data is only valid during the call.
func (q *engineQuery) deliver(data []byte) {
	if len(data) < len(oobHeader)+1 || !bytes.HasPrefix(data, []byte(oobHeader)) {
		return
	}
	select {
	case q.replies <- append([]byte(nil), data...):
	default:
		// Nobody is waiting (a query timed out); ask drains the rest.
	}
}

// ask sends request and returns the body (after the type byte) of the
// first reply of type want.
func (q *engineQuery) ask(ctx context.Context, request []byte, want byte) ([]byte, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	// Late answers to a query that timed out.
	for len(q.replies) > 0 {
		<-q.replies
	}
	if err := q.send(ctx, request); err != nil {
		return nil, err
	}
	for {
		select {
		case reply := <-q.replies:
			if reply[len(oobHeader)] == want {
				return reply[len(oobHeader)+1:], nil
			}
		case <-ctx.Done():
			return nil, errConsoleTimeout
		}
	}
}

// status implements statusSource with the three queries.
func (q *engineQuery) status(ctx context.Context) (serverStatus, error) {
	var st serverStatus
	body, err := q.askTimeout(ctx, infoRequest, infoReply)
	if err != nil {
		return st, fmt.Errorf("server info: %w", err)
	}
	info, err := parseInfoReply(body)
	if err != nil {
		return st, fmt.Errorf("server info: %w", err)
	}
	st.Map, st.PlayerCount, st.MaxPlayers, st.Bots = info.Map, info.Players, info.MaxPlayers, info.Bots
	st.Players = []statusPlayer{}
	// The engine doesn't answer the player query with nobody on the
	// server, so don't wait for it then. If it doesn't answer otherwise
	// (sv_password, sv_expose_player_list 0, everyone just left), the page
	// gets the counts without names.
	if info.Players > 0 {
		if body, err := q.askTimeout(ctx, playersRequest, playersReply); err == nil {
			if players, err := parsePlayersReply(body); err == nil {
				st.Players = players
			}
		}
	}
	if body, err := q.askTimeout(ctx, rulesRequest, rulesReply); err == nil {
		applyRules(&st, parseRulesReply(body))
	}
	return st, nil
}

func (q *engineQuery) askTimeout(ctx context.Context, request []byte, want byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, statusQueryTimeout)
	defer cancel()
	return q.ask(ctx, request, want)
}

// replyReader reads the little-endian fields of a query reply.
type replyReader struct {
	data []byte
	err  error
}

func (r *replyReader) take(n int) []byte {
	if r.err != nil || len(r.data) < n {
		r.err = errBadReply
		return nil
	}
	b := r.data[:n]
	r.data = r.data[n:]
	return b
}

func (r *replyReader) byte() int {
	if b := r.take(1); b != nil {
		return int(b[0])
	}
	return 0
}

func (r *replyReader) int32() int32 {
	if b := r.take(4); b != nil {
		return int32(binary.LittleEndian.Uint32(b))
	}
	return 0
}

func (r *replyReader) float32() float32 {
	if b := r.take(4); b != nil {
		return math.Float32frombits(binary.LittleEndian.Uint32(b))
	}
	return 0
}

func (r *replyReader) string() string {
	if r.err != nil {
		return ""
	}
	i := bytes.IndexByte(r.data, 0)
	if i < 0 {
		r.err = errBadReply
		return ""
	}
	s := string(r.data[:i])
	r.data = r.data[i+1:]
	return s
}

type infoReplyData struct {
	Map                       string
	Players, MaxPlayers, Bots int
}

// parseInfoReply reads an 'I' reply (after the type byte): protocol,
// hostname, map, game folder, game name, app id (short), players, max
// players, bots, ...
func parseInfoReply(body []byte) (infoReplyData, error) {
	r := &replyReader{data: body}
	var info infoReplyData
	r.byte()   // protocol
	r.string() // hostname
	info.Map = r.string()
	r.string() // game folder
	r.string() // game name
	r.take(2)  // app id
	info.Players = r.byte()
	info.MaxPlayers = r.byte()
	info.Bots = r.byte()
	if r.err != nil {
		return infoReplyData{}, r.err
	}
	if info.Map == "" {
		return infoReplyData{}, errBadReply
	}
	return info, nil
}

// parsePlayersReply reads a 'D' reply (after the type byte): a count, then
// per player an index, the name, frags (int32) and connection time (float;
// -1 for bots).
func parsePlayersReply(body []byte) ([]statusPlayer, error) {
	r := &replyReader{data: body}
	count := r.byte()
	players := make([]statusPlayer, 0, count)
	for i := 0; i < count; i++ {
		r.byte() // index
		name := r.string()
		frags := r.int32()
		duration := r.float32()
		if r.err != nil {
			return nil, r.err
		}
		players = append(players, statusPlayer{Name: name, Frags: int(frags), Bot: duration < 0})
	}
	return players, nil
}

// parseRulesReply reads an 'E' reply (after the type byte): a count
// (short), then name/value pairs. The engine builds it in a fixed buffer
// and stops writing when that is full, so a cut-off reply keeps what was
// read.
func parseRulesReply(body []byte) map[string]string {
	r := &replyReader{data: body}
	rules := map[string]string{}
	count := 0
	if b := r.take(2); b != nil {
		count = int(binary.LittleEndian.Uint16(b))
	}
	for i := 0; i < count; i++ {
		name := r.string()
		value := r.string()
		if r.err != nil {
			break
		}
		rules[name] = value
	}
	return rules
}

var timeLeftPattern = regexp.MustCompile(`^([0-9]{1,5}):([0-5][0-9])$`)

// applyRules fills the time limit, time left and next map from the cvars.
func applyRules(st *serverStatus, rules map[string]string) {
	if v, err := strconv.ParseFloat(rules["mp_timelimit"], 64); err == nil && v >= 0 && !math.IsInf(v, 0) {
		st.TimeLimit = &v
	}
	if m := timeLeftPattern.FindStringSubmatch(rules["amx_timeleft"]); m != nil && st.TimeLimit != nil && *st.TimeLimit > 0 {
		minutes, _ := strconv.Atoi(m[1])
		seconds, _ := strconv.Atoi(m[2])
		left := minutes*60 + seconds
		st.TimeLeft = &left
	}
	if name := rules["amx_nextmap"]; len(name) <= 64 && mapNamePattern.MatchString(name) {
		st.NextMap = name
	}
}

// statusHandler serves /status.json from a cache.
type statusHandler struct {
	source  statusSource
	ttl     time.Duration
	limiter *rateLimiter
	now     func() time.Time

	mu        sync.Mutex
	body      []byte // JSON, or nil after a failure
	fetchedAt time.Time
	inflight  chan struct{}
	logf      func(format string, args ...any)
}

func newStatusHandler(source statusSource) *statusHandler {
	return &statusHandler{
		source:  source,
		ttl:     statusCacheTTL,
		limiter: newRateLimiter(statusRate, statusBurst),
		now:     time.Now,
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "status: "+format+"\n", args...)
		},
	}
}

func (h *statusHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
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
	body, err := h.get(r.Context())
	if err != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "the game server didn't answer")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write(body)
	}
}

var errStatusUnavailable = errors.New("status unavailable")

// get returns the cached JSON, or runs one query for everyone waiting. A
// failure is cached too, so a busy engine isn't asked again at once.
func (h *statusHandler) get(ctx context.Context) ([]byte, error) {
	for {
		h.mu.Lock()
		if !h.fetchedAt.IsZero() && h.now().Sub(h.fetchedAt) < h.ttl {
			body := h.body
			h.mu.Unlock()
			if body == nil {
				return nil, errStatusUnavailable
			}
			return body, nil
		}
		if wait := h.inflight; wait != nil {
			h.mu.Unlock()
			select {
			case <-wait:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		done := make(chan struct{})
		h.inflight = done
		h.mu.Unlock()

		// Not the request's context: others are waiting for this query.
		body, err := h.fetch()

		h.mu.Lock()
		h.body, h.fetchedAt, h.inflight = body, h.now(), nil
		h.mu.Unlock()
		close(done)
		if err != nil {
			return nil, err
		}
		return body, nil
	}
}

func (h *statusHandler) fetch() ([]byte, error) {
	// Three queries, each with its own statusQueryTimeout.
	ctx, cancel := context.WithTimeout(context.Background(), 4*statusQueryTimeout)
	defer cancel()
	st, err := h.source.status(ctx)
	if err != nil {
		h.logf("%v", err)
		return nil, err
	}
	if st.Players == nil {
		st.Players = []statusPlayer{}
	}
	body, err := json.Marshal(st)
	if err != nil {
		return nil, err
	}
	return body, nil
}

// rateLimiter is a token bucket per address.
type rateLimiter struct {
	mu      sync.Mutex
	rate    float64 // tokens per second
	burst   float64
	buckets map[string]*tokenBucket
}

type tokenBucket struct {
	tokens float64
	last   time.Time
}

func newRateLimiter(rate, burst float64) *rateLimiter {
	return &rateLimiter{rate: rate, burst: burst, buckets: map[string]*tokenBucket{}}
}

// allow takes a token for key, or says how long until there is one.
func (l *rateLimiter) allow(key string, now time.Time) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[key]
	if b == nil {
		l.prune(now)
		b = &tokenBucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = math.Min(l.burst, b.tokens+elapsed*l.rate)
	}
	b.last = now
	if b.tokens < 1 {
		return time.Duration((1 - b.tokens) / l.rate * float64(time.Second)), false
	}
	b.tokens--
	return 0, true
}

// prune forgets addresses whose bucket has filled up again, so the map
// can't grow without bound.
func (l *rateLimiter) prune(now time.Time) {
	if len(l.buckets) < 1024 {
		return
	}
	full := time.Duration(l.burst / l.rate * float64(time.Second))
	for key, b := range l.buckets {
		if now.Sub(b.last) >= full {
			delete(l.buckets, key)
		}
	}
}
