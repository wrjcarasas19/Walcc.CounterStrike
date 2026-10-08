package main

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"
)

// The rules table: listener and speaker each alive, dead or spectating, on
// the same or the other team, with and without sv_alltalk and the
// intermission.
func TestCanHear(t *testing.T) {
	aliveT, deadT := rosterPlayer{1, teamT, true}, rosterPlayer{2, teamT, false}
	aliveCT, deadCT := rosterPlayer{3, teamCT, true}, rosterPlayer{4, teamCT, false}
	spec := rosterPlayer{5, teamSpec, false}
	players := map[string]rosterPlayer{"alive T": aliveT, "dead T": deadT, "alive CT": aliveCT, "dead CT": deadCT, "spec": spec}
	// Who each listener hears with sv_alltalk 0, outside the intermission.
	hears := map[string][]string{
		// The living hear living teammates only.
		"alive T":  {"alive T"},
		"alive CT": {"alive CT"},
		// The dead hear dead and living teammates.
		"dead T":  {"alive T", "dead T"},
		"dead CT": {"alive CT", "dead CT"},
		// Spectators hear spectators.
		"spec": {"spec"},
	}
	for ln, l := range players {
		for sn, s := range players {
			base := false
			for _, h := range hears[ln] {
				base = base || h == sn
			}
			for _, alltalk := range []bool{false, true} {
				for _, intermission := range []bool{false, true} {
					want := base || alltalk || intermission
					if got := canHear(l, s, alltalk, intermission); got != want {
						t.Errorf("%s hears %s (alltalk %v, intermission %v): %v, want %v", ln, sn, alltalk, intermission, got, want)
					}
				}
			}
		}
	}
}

func TestParseRoster(t *testing.T) {
	out := "alltalk 0 intermission 1 voiceenable 1\n" +
		"0.12.34.56:27005 7 T 1\n" +
		"3.1.2.3:27005 12 CT 0\n" +
		"5.9.9.9 3 SPEC 0\n" +
		"junk line\n" +
		"6.1.1.1:1 x T 1\n" +
		"7.1.1.1:1 4 TERRORIST 1\n" +
		"8.1.1.1:1 4 T 2\n" +
		"::1 4 T 1\n" +
		"loopback 1 CT 1\n"
	st, err := parseRoster(out)
	if err != nil {
		t.Fatal(err)
	}
	want := rosterState{alltalk: false, intermission: true, voiceEnable: true, players: []rosterLine{
		{[4]byte{0, 12, 34, 56}, rosterPlayer{7, teamT, true}},
		{[4]byte{3, 1, 2, 3}, rosterPlayer{12, teamCT, false}},
		{[4]byte{5, 9, 9, 9}, rosterPlayer{3, teamSpec, false}},
	}}
	if !reflect.DeepEqual(st, want) {
		t.Fatalf("got %+v\nwant %+v", st, want)
	}

	st, err = parseRoster("alltalk 1 intermission 0 voiceenable 0\n")
	if err != nil || !st.alltalk || st.intermission || st.voiceEnable || len(st.players) != 0 {
		t.Fatalf("empty roster: %+v, %v", st, err)
	}
	// Without voiceenable (an older plugin), voice stays on.
	if st, err = parseRoster("alltalk 0 intermission 0\n"); err != nil || !st.voiceEnable {
		t.Fatalf("no voiceenable: %+v, %v", st, err)
	}
	// Anything before the header is skipped (other prints).
	if st, err = parseRoster("L something\nalltalk 0 intermission 0 voiceenable 1\n1.2.3.4:5 9 CT 1"); err != nil || len(st.players) != 1 {
		t.Fatalf("text before the header: %+v, %v", st, err)
	}
	for _, bad := range []string{"", "Unknown command \"wc_roster\"\n", "1.2.3.4:5 9 CT 1\n"} {
		if _, err := parseRoster(bad); !errors.Is(err, errNoRoster) {
			t.Errorf("%q: err %v, want errNoRoster", bad, err)
		}
	}
}

// rosterPeers is a peerAt over a fixed set of addresses.
func rosterPeers(peers map[[4]byte]*voicePeer) func([4]byte) *voicePeer {
	return func(ip [4]byte) *voicePeer { return peers[ip] }
}

func TestRosterPolicy(t *testing.T) {
	pol := &rosterPolicy{}
	a, b, c, outsider := &voicePeer{}, &voicePeer{}, &voicePeer{}, &voicePeer{}
	if _, ok := pol.userID(a); ok || pol.mayHear(a, b) {
		t.Fatal("no roster yet, but someone is known")
	}
	st := rosterState{players: []rosterLine{
		{[4]byte{0, 1, 1, 1}, rosterPlayer{7, teamT, true}},
		{[4]byte{1, 1, 1, 1}, rosterPlayer{9, teamT, true}},
		{[4]byte{2, 1, 1, 1}, rosterPlayer{11, teamCT, true}},
		// A line for an address no player in voice has (a slot's old
		// player, a page without voice).
		{[4]byte{3, 1, 1, 1}, rosterPlayer{13, teamCT, true}},
	}}
	pol.set(buildVoiceRoster(st, rosterPeers(map[[4]byte]*voicePeer{{0, 1, 1, 1}: a, {1, 1, 1, 1}: b, {2, 1, 1, 1}: c})))
	if id, ok := pol.userID(a); !ok || id != 7 {
		t.Fatalf("userID(a) = %d, %v; want 7", id, ok)
	}
	if !pol.mayHear(a, b) || !pol.mayHear(b, a) {
		t.Fatal("teammates don't hear each other")
	}
	if pol.mayHear(a, c) || pol.mayHear(c, a) {
		t.Fatal("enemies hear each other")
	}
	if _, ok := pol.userID(outsider); ok || pol.mayHear(outsider, a) || pol.mayHear(a, outsider) {
		t.Fatal("a player not in the roster is heard or hears")
	}
	if pol.adminMuted(a) {
		t.Fatal("admin mute is A.6")
	}
	st.alltalk = true
	pol.set(buildVoiceRoster(st, rosterPeers(map[[4]byte]*voicePeer{{0, 1, 1, 1}: a, {2, 1, 1, 1}: c})))
	if !pol.mayHear(a, c) || !pol.mayHear(c, a) {
		t.Fatal("alltalk: enemies don't hear each other")
	}
	if pol.mayHear(a, b) {
		t.Fatal("alltalk: a player not in the roster hears")
	}
}

// gameVoicePeer only maps an address to the slot's current player.
func TestGameVoicePeer(t *testing.T) {
	v := &voicePeer{}
	slot := &peerSlot{addr: [3]byte{4, 5, 6}, voice: v}
	index, gen, err := connections.Add(slot)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = connections.Remove(index, gen) }()
	if got := gameVoicePeer([4]byte{index, 4, 5, 6}); got != v {
		t.Fatalf("own address: %p, want %p", got, v)
	}
	if got := gameVoicePeer([4]byte{index, 4, 5, 7}); got != nil {
		t.Fatal("another player's address in the same slot maps to this one")
	}
}

// rosterConsole answers wc_roster with whatever the test sets.
type rosterConsole struct {
	out   string
	err   error
	calls int
}

func (c *rosterConsole) Run(_ context.Context, command string) (string, error) {
	if command != rosterCommand {
		return "", fmt.Errorf("unexpected command %q", command)
	}
	c.calls++
	return c.out, c.err
}

func rosterOutput(alltalk int, lines ...string) string {
	out := fmt.Sprintf("alltalk %d intermission 0 voiceenable 1\n", alltalk)
	for _, l := range lines {
		out += l + "\n"
	}
	return out
}

func TestRosterPoller(t *testing.T) {
	pol := &rosterPolicy{}
	h := newVoiceHub(pol)
	console := &rosterConsole{}
	peerOf := map[[4]byte]*voicePeer{}
	r := newRosterPoller(console, h, pol, rosterPeers(peerOf))
	t0 := time.Unix(1000, 0)

	// Nobody in voice: the console isn't used.
	r.poll(context.Background(), t0)
	if console.calls != 0 {
		t.Fatal("roster read with nobody in voice")
	}

	// Two Ts and a CT; peer i is slot i (testPeers).
	p := testPeers(h, 3)
	for _, q := range p {
		peerOf[q.ip] = q
	}
	console.out = rosterOutput(0, "0.1.2.3:27005 21 T 1", "1.1.2.3:27005 22 T 1", "2.1.2.3:27005 23 CT 1")
	r.poll(context.Background(), t0)
	if console.calls != 1 {
		t.Fatalf("%d console calls, want 1", console.calls)
	}
	// T 0 talks: T 1 hears them with the real userid, the CT doesn't.
	out := h.route(p[0], 1, 1, t0, nil)
	if len(out) != 1 || out[0].listener != p[1] {
		t.Fatalf("writes %+v, want only to the teammate", out)
	}
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 21}}) {
		t.Fatalf("teammate's events %v, want lane 0 userid 21", e)
	}
	if e := drain(p[2]); len(e) != 0 {
		t.Fatalf("enemy got events %v", e)
	}

	// T 0 dies mid-sentence: the next read releases the lane at once, with
	// its quiet event, and their audio doesn't reach the living teammate.
	console.out = rosterOutput(0, "0.1.2.3:27005 21 T 0", "1.1.2.3:27005 22 T 1", "2.1.2.3:27005 23 CT 1")
	r.poll(context.Background(), t0.Add(250*time.Millisecond))
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 0}}) {
		t.Fatalf("after the death: events %v, want lane 0 quiet", e)
	}
	if out := h.route(p[0], 2, 961, t0.Add(260*time.Millisecond), nil); len(out) != 0 {
		t.Fatalf("dead player forwarded to %+v", out)
	}
	// The dead player still hears their living teammate.
	if out := h.route(p[1], 1, 1, t0.Add(270*time.Millisecond), nil); len(out) != 1 || out[0].listener != p[0] {
		t.Fatalf("living teammate's writes %+v, want only to the dead teammate", out)
	}
	drain(p[0])

	// sv_alltalk 1: everyone hears everyone.
	console.out = rosterOutput(1, "0.1.2.3:27005 21 T 0", "1.1.2.3:27005 22 T 1", "2.1.2.3:27005 23 CT 1")
	r.poll(context.Background(), t0.Add(500*time.Millisecond))
	if out := h.route(p[0], 3, 1921, t0.Add(510*time.Millisecond), nil); len(out) != 2 {
		t.Fatalf("alltalk: writes %+v, want both others", out)
	}
	drain(p[1])
	drain(p[2])

	// The console fails: the last roster is kept for rosterStaleAfter,
	// then dropped (nobody heard; lanes released).
	console.err = errors.New("timeout")
	r.poll(context.Background(), t0.Add(750*time.Millisecond))
	if _, ok := pol.userID(p[0]); !ok {
		t.Fatal("roster dropped at the first failure")
	}
	r.poll(context.Background(), t0.Add(500*time.Millisecond+rosterStaleAfter))
	if _, ok := pol.userID(p[0]); ok {
		t.Fatal("stale roster kept")
	}
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 0}}) {
		t.Fatalf("stale roster: events %v, want lane 0 quiet", e)
	}
	if out := h.route(p[0], 4, 2881, t0.Add(3*time.Second), nil); len(out) != 0 {
		t.Fatalf("forwarded without a roster: %+v", out)
	}
	// Output without the plugin's header counts as a failure too.
	console.err = nil
	console.out = "Unknown command: wc_roster\n"
	r.poll(context.Background(), t0.Add(4*time.Second))
	if _, ok := pol.userID(p[0]); ok {
		t.Fatal("roster from output without a header")
	}

	// Everyone leaves voice: the roster is dropped without reading.
	for _, q := range p {
		h.leave(q)
	}
	calls := console.calls
	r.poll(context.Background(), t0.Add(5*time.Second))
	if console.calls != calls || pol.roster.Load() != nil {
		t.Fatal("roster read or kept with nobody in voice")
	}
}

// recheck releases only the lanes the policy no longer allows.
func TestVoiceRecheck(t *testing.T) {
	pol := newTestPolicy()
	h := newVoiceHub(pol)
	p := testPeers(h, 4)
	t0 := time.Unix(1000, 0)
	h.route(p[0], 1, 1, t0, nil)
	h.route(p[1], 1, 1, t0, nil)
	h.route(p[2], 1, 1, t0, nil)
	for _, q := range p {
		drain(q)
	}
	h.recheck()
	if e := drain(p[3]); len(e) != 0 {
		t.Fatalf("nothing changed, events %v", e)
	}
	pol.deaf[[2]*voicePeer{p[3], p[0]}] = true // p[3] no longer hears p[0]
	pol.muted[p[1]] = true                     // p[1] muted for everyone
	pol.unknown[p[2]] = true                   // p[2] left the roster
	h.recheck()
	if e := drain(p[3]); !eventsEqual(e, []voiceLaneEvent{{0, 0}, {1, 0}, {2, 0}}) {
		t.Fatalf("p[3] events %v", e)
	}
	// p[1] still hears p[0] (lane 0); p[2]'s lane 1 goes.
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{1, 0}}) {
		t.Fatalf("p[1] events %v", e)
	}
	if !h.active() {
		t.Fatal("hub not active with players")
	}
}
