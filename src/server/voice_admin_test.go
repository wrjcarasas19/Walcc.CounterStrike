package main

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

// rosterHub is a hub with the roster policy and n peers in voice; peer i
// is slot i with userid 21+i, all Ts and alive.
func rosterHub(t *testing.T, n int) (*voiceHub, *rosterPolicy, []*voicePeer) {
	t.Helper()
	pol := &rosterPolicy{}
	h := newVoiceHub(pol)
	p := testPeers(h, n)
	setRoster(pol, p)
	return h, pol, p
}

func setRoster(pol *rosterPolicy, p []*voicePeer) {
	var st rosterState
	peerOf := map[[4]byte]*voicePeer{}
	for i, q := range p {
		st.players = append(st.players, rosterLine{q.ip, rosterPlayer{21 + i, teamT, true}})
		peerOf[q.ip] = q
	}
	pol.set(buildVoiceRoster(st, rosterPeers(peerOf)))
}

// pendingMuted is the admin-muted list queued for p, if any.
func pendingMuted(p *voicePeer) ([]int, bool) { return p.takeMuted() }

func TestVoiceAdminMute(t *testing.T) {
	h, pol, p := rosterHub(t, 3)
	t0 := time.Unix(1000, 0)
	// p[0] talks: both others hear them.
	if out := h.route(p[0], 1, 1, t0, nil); len(out) != 2 {
		t.Fatalf("writes %+v, want 2", out)
	}
	for _, q := range p {
		drain(q)
	}

	list, changed, err := h.setAdminMute(pol, 21, true)
	if err != nil || !changed || !reflect.DeepEqual(list, []int{21}) {
		t.Fatalf("mute = %v, %v, %v", list, changed, err)
	}
	// Their lanes go at once, with quiet events, and nobody hears them.
	for _, q := range p[1:] {
		if e := drain(q); !eventsEqual(e, []voiceLaneEvent{{0, 0, false}}) {
			t.Fatalf("listener events %v, want lane 0 quiet", e)
		}
	}
	if out := h.route(p[0], 2, 961, t0.Add(20*time.Millisecond), nil); len(out) != 0 {
		t.Fatalf("muted player forwarded to %+v", out)
	}
	// Everyone in voice is sent the list, the muted player too.
	for i, q := range p {
		if got, ok := pendingMuted(q); !ok || !reflect.DeepEqual(got, []int{21}) {
			t.Fatalf("peer %d: muted list %v, %v", i, got, ok)
		}
	}
	// The others still hear each other.
	if out := h.route(p[1], 1, 1, t0, nil); len(out) != 2 {
		t.Fatalf("unmuted player's writes %+v, want 2", out)
	}

	// Muting again changes nothing and sends nothing.
	if list, changed, err := h.setAdminMute(pol, 21, true); err != nil || changed || !reflect.DeepEqual(list, []int{21}) {
		t.Fatalf("second mute = %v, %v, %v", list, changed, err)
	}
	if _, ok := pendingMuted(p[1]); ok {
		t.Fatal("list sent again without a change")
	}

	// A player who joins later is sent the list.
	late := &voicePeer{events: make(chan voiceLaneEvent, voiceEventQueue)}
	h.join(late, [4]byte{9, 1, 2, 3})
	if got, ok := pendingMuted(late); !ok || !reflect.DeepEqual(got, []int{21}) {
		t.Fatalf("late joiner: %v, %v", got, ok)
	}

	// Unmute: heard again, and the empty list is sent.
	list, changed, err = h.setAdminMute(pol, 21, false)
	if err != nil || !changed || len(list) != 0 {
		t.Fatalf("unmute = %v, %v, %v", list, changed, err)
	}
	if got, ok := pendingMuted(p[2]); !ok || got == nil || len(got) != 0 {
		t.Fatalf("after unmute: %v, %v; want an empty list", got, ok)
	}
	if out := h.route(p[0], 3, 1921, t0.Add(time.Second), nil); len(out) != 2 {
		t.Fatalf("unmuted player's writes %+v, want 2", out)
	}

	// Unknown userids, and players not in the hub, are refused.
	if _, _, err := h.setAdminMute(pol, 99, true); err == nil || !strings.Contains(err.Error(), "#99 isn't in voice chat") {
		t.Fatalf("unknown userid: %v", err)
	}
	h.leave(p[2])
	if _, _, err := h.setAdminMute(pol, 23, true); err == nil {
		t.Fatal("muted a player who left voice")
	}
}

// The list follows the players: a muted player who leaves drops out of it
// at the next roster read.
func TestVoiceAdminMuteLeaves(t *testing.T) {
	h, pol, p := rosterHub(t, 3)
	if _, _, err := h.setAdminMute(pol, 22, true); err != nil {
		t.Fatal(err)
	}
	for _, q := range p {
		pendingMuted(q)
	}
	console := &rosterConsole{out: rosterOutput(0, "0.1.2.3:27005 21 T 1", "2.1.2.3:27005 23 T 1")}
	h.leave(p[1])
	peerOf := map[[4]byte]*voicePeer{p[0].ip: p[0], p[2].ip: p[2]}
	newRosterPoller(console, h, pol, rosterPeers(peerOf)).poll(context.Background(), time.Unix(1000, 0))
	if got, ok := pendingMuted(p[0]); !ok || len(got) != 0 {
		t.Fatalf("after the muted player left: %v, %v", got, ok)
	}
}

// The list goes out as a "voice" event (on the WebSocket here: no data
// channel), coalesced to the latest.
func TestVoiceMutedEvent(t *testing.T) {
	sent := make(chan string, 4)
	p := &voicePeer{
		events:      make(chan voiceLaneEvent, voiceEventQueue),
		mutedNotify: make(chan struct{}, 1),
		signal: func(event string, v any) error {
			b, _ := json.Marshal(map[string]any{"event": event, "data": v})
			sent <- string(b)
			return nil
		},
	}
	p.offerMuted([]int{3})
	p.offerMuted([]int{3, 7})
	done := make(chan struct{})
	go func() {
		p.sendEvents()
		close(done)
	}()
	select {
	case got := <-sent:
		if got != `{"data":{"muted":[3,7]},"event":"voice"}` {
			t.Fatalf("event %s", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no event")
	}
	p.offerMuted(nil)
	if got := <-sent; got != `{"data":{"muted":[]},"event":"voice"}` {
		t.Fatalf("empty list event %s", got)
	}
	close(p.events)
	<-done
	if len(sent) != 0 {
		t.Fatalf("extra events: %d", len(sent))
	}
}

// {"listen":false} from the page: its lanes go and it is sent no audio
// until {"listen":true}.
func TestVoiceListenRequest(t *testing.T) {
	h := newVoiceHub(newTestPolicy())
	p := testPeers(h, 3)
	t0 := time.Unix(1000, 0)
	h.route(p[0], 1, 1, t0, nil)
	drain(p[1])
	drain(p[2])

	p[1].request(h, []byte(`{"listen":false}`))
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 0, false}}) {
		t.Fatalf("events %v, want lane 0 quiet", e)
	}
	if e := drain(p[2]); len(e) != 0 {
		t.Fatalf("another listener's events %v", e)
	}
	out := h.route(p[0], 2, 961, t0.Add(20*time.Millisecond), nil)
	if len(out) != 1 || out[0].listener != p[2] {
		t.Fatalf("writes %+v, want only to the listening player", out)
	}
	// Not listening doesn't stop them talking.
	if out := h.route(p[1], 1, 1, t0, nil); len(writesTo(out, p[2])) != 1 {
		t.Fatalf("non-listener's writes %+v", out)
	}
	// Garbage and unknown fields change nothing.
	for _, msg := range []string{`not json`, `{"other":1}`, `{"listen":"no"}`, `[]`} {
		p[1].request(h, []byte(msg))
	}
	if !p[1].deaf.Load() {
		t.Fatal("a bad message turned listening back on")
	}
	p[1].request(h, []byte(`{"listen":true}`))
	if out := h.route(p[0], 3, 1921, t0.Add(40*time.Millisecond), nil); len(writesTo(out, p[1])) != 1 {
		t.Fatalf("listening again: writes %+v", out)
	}
}

// sv_voiceenable 0 in the roster: nobody hears anybody and lanes go at
// the read; 1 opens it again.
func TestVoiceEnableOff(t *testing.T) {
	pol := &rosterPolicy{}
	h := newVoiceHub(pol)
	p := testPeers(h, 2)
	peerOf := map[[4]byte]*voicePeer{p[0].ip: p[0], p[1].ip: p[1]}
	console := &rosterConsole{out: rosterOutput(0, "0.1.2.3:27005 21 T 1", "1.1.2.3:27005 22 T 1")}
	r := newRosterPoller(console, h, pol, rosterPeers(peerOf))
	t0 := time.Unix(1000, 0)
	r.poll(context.Background(), t0)
	if out := h.route(p[0], 1, 1, t0, nil); len(out) != 1 {
		t.Fatalf("writes %+v, want 1", out)
	}
	drain(p[1])

	console.out = strings.Replace(console.out, "voiceenable 1", "voiceenable 0", 1)
	r.poll(context.Background(), t0.Add(250*time.Millisecond))
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 0, false}}) {
		t.Fatalf("events %v, want lane 0 quiet", e)
	}
	for _, s := range p {
		if out := h.route(s, 2, 961, t0.Add(260*time.Millisecond), nil); len(out) != 0 {
			t.Fatalf("forwarded with voice off: %+v", out)
		}
	}
	// Userids stay known (the admin-muted list doesn't change).
	if id, ok := pol.userID(p[0]); !ok || id != 21 {
		t.Fatalf("userID with voice off = %d, %v", id, ok)
	}

	console.out = strings.Replace(console.out, "voiceenable 0", "voiceenable 1", 1)
	r.poll(context.Background(), t0.Add(500*time.Millisecond))
	if out := h.route(p[0], 3, 1921, t0.Add(510*time.Millisecond), nil); len(out) != 1 {
		t.Fatalf("voice on again: writes %+v, want 1", out)
	}
}

type voiceMuteResponse struct {
	Output     string `json:"output"`
	Error      string `json:"error"`
	VoiceMuted []int  `json:"voiceMuted"`
}

func voiceCommand(t *testing.T, a *adminAPI, c *http.Cookie, body string) (int, voiceMuteResponse) {
	t.Helper()
	rec := a.do(adminRequest{path: "/admin/command", body: body, cookie: c, remote: testAdminAddress})
	var resp voiceMuteResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("%s: %v (%s)", body, err, rec.Body)
	}
	return rec.Code, resp
}

func TestAdminVoiceMute(t *testing.T) {
	h, pol, p := rosterHub(t, 2)
	console := &scriptConsole{outputs: map[string]string{}, errs: map[string]error{}}
	a := newAdminAPI(testAdminPassword, console, actionEnv{mapsDir: t.TempDir(), voice: &voiceControl{hub: h, policy: pol}})
	var logged []string
	a.logf = func(format string, args ...any) { logged = append(logged, format) }
	c := sessionCookie(t, login(t, a, testAdminPassword, testAdminAddress))

	code, resp := voiceCommand(t, a, c, `{"action":"voice_mute","userid":22}`)
	if code != http.StatusOK || !reflect.DeepEqual(resp.VoiceMuted, []int{22}) || !strings.Contains(resp.Output, "Muted player #22") {
		t.Fatalf("voice_mute = %d %+v", code, resp)
	}
	if !p[1].adminMuted.Load() || p[0].adminMuted.Load() {
		t.Fatal("wrong player muted")
	}
	code, resp = voiceCommand(t, a, c, `{"action":"voice_unmute","userid":22}`)
	if code != http.StatusOK || len(resp.VoiceMuted) != 0 || !strings.Contains(resp.Output, "Unmuted") {
		t.Fatalf("voice_unmute = %d %+v", code, resp)
	}
	code, resp = voiceCommand(t, a, c, `{"action":"voice_unmute","userid":22}`)
	if code != http.StatusOK || !strings.Contains(resp.Output, "wasn't muted") {
		t.Fatalf("second voice_unmute = %d %+v", code, resp)
	}
	code, resp = voiceCommand(t, a, c, `{"action":"voice_mute","userid":40}`)
	if code != http.StatusConflict || !strings.Contains(resp.Error, "isn't in voice chat") {
		t.Fatalf("not in voice = %d %+v", code, resp)
	}
	if len(console.commands) != 0 {
		t.Fatalf("engine commands %q", console.commands)
	}
	if len(logged) != 3 { // the login, the mute and the unmute
		t.Fatalf("logged %q, want the mute and the unmute", logged)
	}
	// Without a session: refused.
	rec := a.do(adminRequest{path: "/admin/command", body: `{"action":"voice_mute","userid":22}`, remote: testAdminAddress})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("without session = %d", rec.Code)
	}

	// VOICE=0: no voice in the env.
	a.env.voice = nil
	code, resp = voiceCommand(t, a, c, `{"action":"voice_mute","userid":22}`)
	if code != http.StatusConflict || !strings.Contains(resp.Error, "VOICE=0") {
		t.Fatalf("VOICE=0 = %d %+v", code, resp)
	}
}
