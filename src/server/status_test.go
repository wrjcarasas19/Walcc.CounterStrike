package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// replyWriter builds query replies the way the engine's MSG_Write* do
// (little endian, strings with a 0 byte).
type replyWriter struct{ bytes.Buffer }

func newReply(kind byte) *replyWriter {
	w := &replyWriter{}
	w.WriteString(oobHeader)
	w.WriteByte(kind)
	return w
}

func (w *replyWriter) b(v int) *replyWriter { w.WriteByte(byte(v)); return w }
func (w *replyWriter) s(v string) *replyWriter {
	w.WriteString(v)
	w.WriteByte(0)
	return w
}
func (w *replyWriter) short(v int) *replyWriter {
	_ = binary.Write(w, binary.LittleEndian, uint16(v))
	return w
}
func (w *replyWriter) long(v int32) *replyWriter {
	_ = binary.Write(w, binary.LittleEndian, v)
	return w
}
func (w *replyWriter) float(v float32) *replyWriter {
	_ = binary.Write(w, binary.LittleEndian, math.Float32bits(v))
	return w
}

// infoReplyPacket is SV_SourceQuery_Details' answer.
func infoReplyPacket(mapName string, players, max, bots int) []byte {
	w := newReply('I').b(48).s("My CS 1.6 Web Server").s(mapName).s("cstrike").s("Counter-Strike").
		short(0).b(players).b(max).b(bots).b('d').b('l').b(0).b(0).s("0.21")
	return w.Bytes()
}

type testPlayer struct {
	name     string
	frags    int32
	duration float32
}

// playersReplyPacket is SV_SourceQuery_Players' answer.
func playersReplyPacket(players ...testPlayer) []byte {
	w := newReply('D').b(len(players))
	for i, p := range players {
		w.b(i).s(p.name).long(p.frags).float(p.duration)
	}
	return w.Bytes()
}

// rulesReplyPacket is SV_SourceQuery_Rules' answer.
func rulesReplyPacket(pairs ...string) []byte {
	w := newReply('E').short(len(pairs) / 2)
	for _, s := range pairs {
		w.s(s)
	}
	return w.Bytes()
}

func body(packet []byte) []byte { return packet[len(oobHeader)+1:] }

func TestParseInfoReply(t *testing.T) {
	got, err := parseInfoReply(body(infoReplyPacket("de_dust2", 5, 16, 3)))
	if err != nil {
		t.Fatal(err)
	}
	if want := (infoReplyData{Map: "de_dust2", Players: 5, MaxPlayers: 16, Bots: 3}); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	full := body(infoReplyPacket("de_dust2", 5, 16, 3))
	for _, cut := range []int{0, 5, 30, 50, 52} {
		if _, err := parseInfoReply(full[:cut]); err == nil {
			t.Errorf("cut at %d: no error", cut)
		}
	}
	if _, err := parseInfoReply(body(infoReplyPacket("", 0, 16, 0))); err == nil {
		t.Error("empty map name accepted")
	}
}

func TestParsePlayersReply(t *testing.T) {
	packet := playersReplyPacket(
		testPlayer{"Walter", 12, 301.5},
		testPlayer{`<b>"Bot"</b> \ ;`, -2, -1},
		testPlayer{"", 0, 0.25},
	)
	got, err := parsePlayersReply(body(packet))
	if err != nil {
		t.Fatal(err)
	}
	want := []statusPlayer{
		{Name: "Walter", Frags: 12},
		{Name: `<b>"Bot"</b> \ ;`, Frags: -2, Bot: true},
		{Name: "", Frags: 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if _, err := parsePlayersReply(body(packet)[:20]); err == nil {
		t.Error("cut-off reply accepted")
	}
	if got, err := parsePlayersReply([]byte{0}); err != nil || len(got) != 0 {
		t.Errorf("empty list: %v, %v", got, err)
	}
}

func TestParseRulesReply(t *testing.T) {
	packet := rulesReplyPacket("mp_timelimit", "30", "amx_timeleft", "12:07", "amx_nextmap", "de_aztec", "sv_password", "0")
	want := map[string]string{"mp_timelimit": "30", "amx_timeleft": "12:07", "amx_nextmap": "de_aztec", "sv_password": "0"}
	if got := parseRulesReply(body(packet)); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// The engine stops writing when its buffer is full, but the count says
	// how many it meant to send.
	cut := body(packet)[:len(body(packet))-12]
	got := parseRulesReply(cut)
	if len(got) != 3 || got["amx_nextmap"] != "de_aztec" {
		t.Fatalf("cut-off reply: %v", got)
	}
	if got := parseRulesReply(nil); len(got) != 0 {
		t.Fatalf("empty reply: %v", got)
	}
}

func TestApplyRules(t *testing.T) {
	intp := func(v int) *int { return &v }
	floatp := func(v float64) *float64 { return &v }
	tests := []struct {
		rules    map[string]string
		limit    *float64
		left     *int
		nextMap  string
		testName string
	}{
		{map[string]string{"mp_timelimit": "30", "amx_timeleft": "12:07", "amx_nextmap": "de_aztec"}, floatp(30), intp(727), "de_aztec", "AMXX"},
		{map[string]string{"mp_timelimit": "0", "amx_timeleft": "00:00", "amx_nextmap": "de_aztec"}, floatp(0), nil, "de_aztec", "no time limit"},
		{map[string]string{"mp_timelimit": "2.5", "amx_timeleft": "120:00"}, floatp(2.5), intp(7200), "", "long"},
		{map[string]string{"mp_timelimit": "30"}, floatp(30), nil, "", "no AMXX"},
		{map[string]string{"mp_timelimit": "-1", "amx_timeleft": "1:00"}, nil, nil, "", "bad limit"},
		{map[string]string{"mp_timelimit": "30", "amx_timeleft": "1:75", "amx_nextmap": "de dust"}, floatp(30), nil, "", "bad values"},
		{map[string]string{"mp_timelimit": "30", "amx_nextmap": strings.Repeat("a", 65)}, floatp(30), nil, "", "long map name"},
		{map[string]string{}, nil, nil, "", "nothing"},
	}
	for _, tt := range tests {
		var st serverStatus
		applyRules(&st, tt.rules)
		if !reflect.DeepEqual(st.TimeLimit, tt.limit) || !reflect.DeepEqual(st.TimeLeft, tt.left) || st.NextMap != tt.nextMap {
			t.Errorf("%s: got limit %v left %v next %q", tt.testName, st.TimeLimit, st.TimeLeft, st.NextMap)
		}
	}
}

// fakeQueryEngine answers queries like the engine, on another goroutine.
type fakeQueryEngine struct {
	mu      sync.Mutex
	asked   []string
	answers map[byte][][]byte
	q       *engineQuery
}

func newFakeQueryEngine(answers map[byte][][]byte) *fakeQueryEngine {
	e := &fakeQueryEngine{answers: answers}
	e.q = newEngineQuery(e.send)
	return e
}

func (e *fakeQueryEngine) send(_ context.Context, data []byte) error {
	var kind byte
	switch {
	case bytes.Equal(data, infoRequest):
		kind = 'I'
	case bytes.Equal(data, playersRequest):
		kind = 'U'
	case bytes.Equal(data, rulesRequest):
		kind = 'V'
	default:
		return errors.New("unexpected request")
	}
	e.mu.Lock()
	e.asked = append(e.asked, string(kind))
	replies := e.answers[kind]
	e.mu.Unlock()
	go func() {
		for _, r := range replies {
			e.q.deliver(r)
		}
	}()
	return nil
}

func (e *fakeQueryEngine) requests() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return strings.Join(e.asked, "")
}

func TestEngineQueryStatus(t *testing.T) {
	e := newFakeQueryEngine(map[byte][][]byte{
		'I': {infoReplyPacket("de_dust2", 2, 16, 1)},
		// A stray print packet first: ignored.
		'U': {[]byte(printPrefix + "x"), playersReplyPacket(testPlayer{"Walter", 3, 60}, testPlayer{"[POD]Bot", 1, -1})},
		'V': {rulesReplyPacket("mp_timelimit", "30", "amx_timeleft", "29:58", "amx_nextmap", "de_inferno")},
	})
	st, err := e.q.status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	limit, left := 30.0, 1798
	want := serverStatus{
		Map: "de_dust2", PlayerCount: 2, MaxPlayers: 16, Bots: 1,
		Players:   []statusPlayer{{Name: "Walter", Frags: 3}, {Name: "[POD]Bot", Frags: 1, Bot: true}},
		TimeLimit: &limit, TimeLeft: &left, NextMap: "de_inferno",
	}
	if !reflect.DeepEqual(st, want) {
		t.Fatalf("got %+v, want %+v", st, want)
	}
	if got := e.requests(); got != "IUV" {
		t.Fatalf("requests %q", got)
	}
}

func TestEngineQueryEmptyServer(t *testing.T) {
	// The engine doesn't answer the player query on an empty server, so it
	// isn't asked.
	e := newFakeQueryEngine(map[byte][][]byte{
		'I': {infoReplyPacket("de_aztec", 0, 16, 0)},
		'V': {rulesReplyPacket("mp_timelimit", "0")},
	})
	st, err := e.q.status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Map != "de_aztec" || st.PlayerCount != 0 || st.Players == nil || len(st.Players) != 0 || st.TimeLeft != nil {
		t.Fatalf("got %+v", st)
	}
	if got := e.requests(); got != "IV" {
		t.Fatalf("requests %q", got)
	}
}

func TestEngineQueryPartialAnswers(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for query timeouts")
	}
	// No player list (sv_password) and no rules: counts only.
	e := newFakeQueryEngine(map[byte][][]byte{'I': {infoReplyPacket("de_dust2", 4, 16, 0)}})
	start := time.Now()
	st, err := e.q.status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.PlayerCount != 4 || len(st.Players) != 0 || st.TimeLimit != nil {
		t.Fatalf("got %+v", st)
	}
	if elapsed := time.Since(start); elapsed > 3*statusQueryTimeout {
		t.Fatalf("took %v", elapsed)
	}

	// No info answer: an error.
	e = newFakeQueryEngine(map[byte][][]byte{})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := e.q.status(ctx); !errors.Is(err, errConsoleTimeout) {
		t.Fatalf("got %v", err)
	}
}

func TestEngineQueryDropsLateReplies(t *testing.T) {
	q := newEngineQuery(func(context.Context, []byte) error { return nil })
	// A late info reply from an earlier, timed-out query.
	q.deliver(infoReplyPacket("de_old", 1, 16, 0))
	q.send = func(context.Context, []byte) error {
		go q.deliver(infoReplyPacket("de_new", 1, 16, 0))
		return nil
	}
	got, err := q.ask(context.Background(), infoRequest, infoReply)
	if err != nil {
		t.Fatal(err)
	}
	if info, _ := parseInfoReply(got); info.Map != "de_new" {
		t.Fatalf("got %q", info.Map)
	}
	// Too short or not out-of-band: ignored.
	q.deliver([]byte(oobHeader))
	q.deliver([]byte("Dxxxxx"))
	if len(q.replies) != 0 {
		t.Fatal("bad packets queued")
	}
}

// fakeStatusSource counts calls; gate (if set) holds each call until closed.
type fakeStatusSource struct {
	mu    sync.Mutex
	calls int
	st    serverStatus
	err   error
	gate  chan struct{}
}

func (s *fakeStatusSource) status(ctx context.Context) (serverStatus, error) {
	s.mu.Lock()
	s.calls++
	gate := s.gate
	s.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return serverStatus{}, ctx.Err()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st, s.err
}

func (s *fakeStatusSource) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func newTestStatus(source statusSource) (*statusHandler, *time.Time) {
	h := newStatusHandler(source)
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	h.now = func() time.Time { return now }
	h.logf = func(string, ...any) {}
	return h, &now
}

func getStatus(h http.Handler, remote string, header map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, "http://cs.example/status.json", nil)
	r.RemoteAddr = remote
	for k, v := range header {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestStatusHandler(t *testing.T) {
	left, limit := 600, 30.0
	source := &fakeStatusSource{st: serverStatus{
		Map: "de_dust2", PlayerCount: 2, MaxPlayers: 16, Bots: 1,
		Players:   []statusPlayer{{Name: `<img src=x onerror=alert(1)>`, Frags: 5}, {Name: "Bot", Frags: 0, Bot: true}},
		TimeLimit: &limit, TimeLeft: &left, NextMap: "de_aztec",
	}}
	h, _ := newTestStatus(source)
	w := getStatus(h, "203.0.113.7:4000", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q", ct)
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("headers %v", w.Header())
	}
	raw := w.Body.String()
	if strings.Contains(raw, "<img") {
		t.Errorf("name not escaped: %s", raw)
	}
	want := `{"map":"de_dust2","playerCount":2,"maxPlayers":16,"bots":1,"players":[{"name":"\u003cimg src=x onerror=alert(1)\u003e","frags":5},{"name":"Bot","frags":0,"bot":true}],"timeLimit":30,"timeLeft":600,"nextMap":"de_aztec"}`
	if raw != want {
		t.Errorf("body\n%s\nwant\n%s", raw, want)
	}
	var decoded serverStatus
	if err := json.Unmarshal(w.Body.Bytes(), &decoded); err != nil || decoded.Players[0].Name != `<img src=x onerror=alert(1)>` {
		t.Errorf("decoded %+v, %v", decoded, err)
	}
}

func TestStatusHandlerNullsAndEmptyList(t *testing.T) {
	h, _ := newTestStatus(&fakeStatusSource{st: serverStatus{Map: "de_dust2", MaxPlayers: 16}})
	w := getStatus(h, "203.0.113.7:4000", nil)
	want := `{"map":"de_dust2","playerCount":0,"maxPlayers":16,"bots":0,"players":[],"timeLimit":null,"timeLeft":null}`
	if w.Body.String() != want {
		t.Fatalf("got %s", w.Body)
	}
}

func TestStatusHandlerCaches(t *testing.T) {
	source := &fakeStatusSource{st: serverStatus{Map: "de_dust2"}}
	h, now := newTestStatus(source)
	for i := 0; i < 10; i++ {
		if w := getStatus(h, "203.0.113.7:4000", nil); w.Code != http.StatusOK {
			t.Fatalf("status %d", w.Code)
		}
		*now = now.Add(150 * time.Millisecond)
	}
	if got := source.count(); got != 1 {
		t.Fatalf("%d queries within the cache time", got)
	}
	*now = now.Add(statusCacheTTL)
	source.mu.Lock()
	source.st.Map = "de_aztec"
	source.mu.Unlock()
	w := getStatus(h, "203.0.113.7:4000", nil)
	if source.count() != 2 || !strings.Contains(w.Body.String(), "de_aztec") {
		t.Fatalf("after the cache time: %d queries, %s", source.count(), w.Body)
	}
}

func TestStatusHandlerSharesOneQuery(t *testing.T) {
	source := &fakeStatusSource{st: serverStatus{Map: "de_dust2"}, gate: make(chan struct{})}
	h, _ := newTestStatus(source)
	h.limiter = newRateLimiter(1000, 1000)
	var wg sync.WaitGroup
	codes := make(chan int, 50)
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- getStatus(h, "203.0.113.7:4000", nil).Code
		}()
	}
	// Let every request reach the handler, then answer.
	deadline := time.Now().Add(2 * time.Second)
	for source.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(source.gate)
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != http.StatusOK {
			t.Fatalf("status %d", code)
		}
	}
	if got := source.count(); got != 1 {
		t.Fatalf("%d queries for 50 requests", got)
	}
}

func TestStatusHandlerFailure(t *testing.T) {
	source := &fakeStatusSource{err: errConsoleTimeout}
	h, now := newTestStatus(source)
	for i := 0; i < 3; i++ {
		w := getStatus(h, "203.0.113.7:4000", nil)
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "didn't answer") {
			t.Fatalf("status %d: %s", w.Code, w.Body)
		}
	}
	if got := source.count(); got != 1 {
		t.Fatalf("failure not cached: %d queries", got)
	}
	*now = now.Add(statusCacheTTL)
	source.mu.Lock()
	source.err = nil
	source.mu.Unlock()
	if w := getStatus(h, "203.0.113.7:4000", nil); w.Code != http.StatusOK {
		t.Fatalf("after recovery: %d", w.Code)
	}
}

func TestStatusHandlerRateLimit(t *testing.T) {
	source := &fakeStatusSource{st: serverStatus{Map: "de_dust2"}}
	h, now := newTestStatus(source)
	for i := 0; i < statusBurst; i++ {
		if w := getStatus(h, "203.0.113.7:4000", nil); w.Code != http.StatusOK {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	w := getStatus(h, "203.0.113.7:4001", map[string]string{"X-Forwarded-For": "198.51.100.1"})
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("over the limit: %d, Retry-After %q", w.Code, w.Header().Get("Retry-After"))
	}
	// Other addresses aren't affected; an IPv6 /64 counts as one address.
	if w := getStatus(h, "198.51.100.1:4000", nil); w.Code != http.StatusOK {
		t.Fatalf("other address: %d", w.Code)
	}
	for i := 0; i < statusBurst; i++ {
		getStatus(h, "[2001:db8:1:2::1]:4000", nil)
	}
	if w := getStatus(h, "[2001:db8:1:2::ffff]:4000", nil); w.Code != http.StatusTooManyRequests {
		t.Fatalf("same /64: %d", w.Code)
	}
	// Tokens come back at statusRate per second.
	*now = now.Add(time.Second)
	for i := 0; i < statusRate; i++ {
		if w := getStatus(h, "203.0.113.7:4000", nil); w.Code != http.StatusOK {
			t.Fatalf("after a second, request %d: %d", i, w.Code)
		}
	}
	if w := getStatus(h, "203.0.113.7:4000", nil); w.Code != http.StatusTooManyRequests {
		t.Fatalf("refill too fast: %d", w.Code)
	}
}

func TestStatusHandlerMethods(t *testing.T) {
	h, _ := newTestStatus(&fakeStatusSource{st: serverStatus{Map: "de_dust2"}})
	r := httptest.NewRequest(http.MethodPost, "http://cs.example/status.json", strings.NewReader("{}"))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", w.Code)
	}
	r = httptest.NewRequest(http.MethodHead, "http://cs.example/status.json", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Body.Len() != 0 {
		t.Fatalf("HEAD: %d, %q", w.Code, w.Body)
	}
}

func TestServerRoutesStatus(t *testing.T) {
	h, _ := newTestStatus(&fakeStatusSource{st: serverStatus{Map: "de_dust2"}})
	s := &Server{status: h}
	if w := getStatus(s, "203.0.113.7:4000", nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "de_dust2") {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if w := getStatus(&Server{}, "203.0.113.7:4000", nil); w.Code != http.StatusNotFound {
		t.Fatalf("no status handler: %d", w.Code)
	}
}

func TestRateLimiterPrunes(t *testing.T) {
	l := newRateLimiter(1, 2)
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 1100; i++ {
		l.allow(string(rune('a'+i%26))+strings.Repeat("x", i/26), now)
	}
	now = now.Add(3 * time.Second)
	l.allow("new", now)
	if len(l.buckets) != 1 {
		t.Fatalf("%d buckets kept", len(l.buckets))
	}
}
