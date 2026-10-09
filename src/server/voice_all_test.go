package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Talking to all players (new-features-1007 A.7).

// The rules table for a speaker talking to all players: listener and
// speaker each alive, dead or spectating, on the same or the other team,
// with wc_voice_all 1 and 0, through rosterPolicy.
func TestRosterPolicyTalkAll(t *testing.T) {
	names := []string{"alive T", "dead T", "alive CT", "dead CT", "spec"}
	players := map[string]rosterPlayer{
		"alive T": {1, teamT, true}, "dead T": {2, teamT, false},
		"alive CT": {3, teamCT, true}, "dead CT": {4, teamCT, false},
		"spec": {5, teamSpec, false},
	}
	// Who each listener hears when everyone talks to all players.
	hearsAll := map[string][]string{
		// The living hear the living, enemies too, never the dead.
		"alive T":  {"alive T", "alive CT"},
		"alive CT": {"alive T", "alive CT"},
		// The dead and spectators hear everyone.
		"dead T":  names,
		"dead CT": names,
		"spec":    names,
	}
	// Who each listener hears when everyone talks to their team (A.3).
	hearsTeam := map[string][]string{
		"alive T":  {"alive T"},
		"alive CT": {"alive CT"},
		"dead T":   {"alive T", "dead T"},
		"dead CT":  {"alive CT", "dead CT"},
		"spec":     {"spec"},
	}
	peers := map[string]*voicePeer{}
	ips := map[[4]byte]*voicePeer{}
	var st rosterState
	for i, n := range names {
		p := &voicePeer{}
		ip := [4]byte{byte(i), 1, 1, 1}
		peers[n], ips[ip] = p, p
		st.players = append(st.players, rosterLine{ip, players[n]})
	}
	contains := func(list []string, s string) bool {
		for _, x := range list {
			if x == s {
				return true
			}
		}
		return false
	}
	pol := &rosterPolicy{}
	for _, allOff := range []bool{false, true} {
		st.voiceAllOff = allOff
		pol.set(buildVoiceRoster(st, rosterPeers(ips)))
		for _, talkAll := range []bool{false, true} {
			for _, p := range peers {
				p.talkAll.Store(talkAll)
			}
			for _, ln := range names {
				for _, sn := range names {
					if ln == sn {
						continue
					}
					want := contains(hearsTeam[ln], sn)
					if talkAll && !allOff {
						want = contains(hearsAll[ln], sn)
					}
					if got := pol.mayHear(peers[ln], peers[sn]); got != want {
						t.Errorf("%s hears %s (talk all %v, wc_voice_all off %v): %v, want %v", ln, sn, talkAll, allOff, got, want)
					}
				}
				if got := pol.talksToAll(peers[ln]); got != (talkAll && !allOff) {
					t.Errorf("%s talksToAll (talk all %v, off %v) = %v", ln, talkAll, allOff, got)
				}
			}
		}
	}
	// sv_voiceenable 0 and the not-in-roster rule still apply.
	for _, p := range peers {
		p.talkAll.Store(true)
	}
	st.voiceAllOff, st.voiceOff = false, true
	pol.set(buildVoiceRoster(st, rosterPeers(ips)))
	if pol.mayHear(peers["alive CT"], peers["alive T"]) {
		t.Error("talk all heard with sv_voiceenable 0")
	}
	st.voiceOff = false
	pol.set(buildVoiceRoster(st, rosterPeers(ips)))
	outsider := &voicePeer{}
	outsider.talkAll.Store(true)
	if pol.mayHear(peers["alive T"], outsider) || pol.mayHear(outsider, peers["alive T"]) {
		t.Error("talk all: a player not in the roster is heard or hears")
	}
	pol.set(nil)
	if pol.talksToAll(peers["alive T"]) {
		t.Error("talksToAll without a roster")
	}
}

func TestParseRosterVoiceAll(t *testing.T) {
	st, err := parseRoster("alltalk 0 intermission 0 voiceenable 1 wc_voice_all 0\n1.2.3.4:5 9 CT 1\n")
	if err != nil || !st.voiceAllOff || st.voiceOff || len(st.players) != 1 {
		t.Fatalf("wc_voice_all 0: %+v, %v", st, err)
	}
	if st, err = parseRoster("alltalk 0 intermission 0 voiceenable 0 wc_voice_all 1\n"); err != nil || st.voiceAllOff || !st.voiceOff {
		t.Fatalf("wc_voice_all 1: %+v, %v", st, err)
	}
	// An older plugin without it: talking to all is on.
	if st, err = parseRoster("alltalk 0 intermission 0 voiceenable 1\n"); err != nil || st.voiceAllOff {
		t.Fatalf("no wc_voice_all: %+v, %v", st, err)
	}
}

// allHub is a 2 v 2 in voice with the roster policy: T1 (userid 21), T2
// (22), C1 (23) alive, C2 (24) dead.
func allHub(t *testing.T, allOff bool) (*voiceHub, *rosterPolicy, []*voicePeer) {
	t.Helper()
	pol := &rosterPolicy{}
	h := newVoiceHub(pol)
	p := testPeers(h, 4)
	st := rosterState{voiceAllOff: allOff, players: []rosterLine{
		{p[0].ip, rosterPlayer{21, teamT, true}},
		{p[1].ip, rosterPlayer{22, teamT, true}},
		{p[2].ip, rosterPlayer{23, teamCT, true}},
		{p[3].ip, rosterPlayer{24, teamCT, false}},
	}}
	pol.set(buildVoiceRoster(st, rosterPeers(map[[4]byte]*voicePeer{p[0].ip: p[0], p[1].ip: p[1], p[2].ip: p[2], p[3].ip: p[3]})))
	return h, pol, p
}

func listeners(out []laneWrite) map[*voicePeer]bool {
	got := map[*voicePeer]bool{}
	for _, w := range out {
		got[w.listener] = true
	}
	return got
}

func TestVoiceTalkAll(t *testing.T) {
	h, _, p := allHub(t, false)
	t0 := time.Unix(1000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	// An old page never says: team only.
	if got := listeners(h.route(p[0], 1, 1, at(0), nil)); len(got) != 1 || !got[p[1]] {
		t.Fatalf("no talk message: heard by %v, want T2 only", got)
	}
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 21, false}}) {
		t.Fatalf("T2 events %v", e)
	}

	// "all" mid-sentence: the enemies hear too (the dead C2 as well), and
	// T2's lane is announced again as all.
	p[0].request(h, []byte(`{"talk":"all"}`))
	if !p[0].talkAll.Load() {
		t.Fatal(`{"talk":"all"} didn't set the mode`)
	}
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 21, true}}) {
		t.Fatalf("T2 events after switching to all %v", e)
	}
	if got := listeners(h.route(p[0], 2, 961, at(20), nil)); len(got) != 3 {
		t.Fatalf("talk all: heard by %d players, want 3", len(got))
	}
	for _, q := range p[2:] {
		if e := drain(q); !eventsEqual(e, []voiceLaneEvent{{0, 21, true}}) {
			t.Fatalf("enemy events %v", e)
		}
	}
	if e := drain(p[1]); len(e) != 0 {
		t.Fatalf("T2 announced twice: %v", e)
	}

	// Back to the team mid-sentence: the enemies' lanes go at once, T2's is
	// announced again as team.
	p[0].request(h, []byte(`{"talk":"team"}`))
	for _, q := range p[2:] {
		if e := drain(q); !eventsEqual(e, []voiceLaneEvent{{0, 0, false}}) {
			t.Fatalf("enemy events after switching to team %v", e)
		}
	}
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 21, false}}) {
		t.Fatalf("T2 events after switching to team %v", e)
	}
	if got := listeners(h.route(p[0], 3, 1921, at(40), nil)); len(got) != 1 || !got[p[1]] {
		t.Fatalf("back to team: heard by %v", got)
	}
	// Anything but "all" is the team; a bad message changes nothing.
	p[0].request(h, []byte(`{"talk":"all"}`))
	p[0].request(h, []byte(`{"talk":5}`))
	if !p[0].talkAll.Load() {
		t.Fatal("a bad message changed the mode")
	}
	p[0].request(h, []byte(`{"talk":"everyone"}`))
	if p[0].talkAll.Load() {
		t.Fatal(`"everyone" is not "all"`)
	}

	// The dead talking to all: the living don't hear them.
	p[3].request(h, []byte(`{"talk":"all"}`))
	if out := h.route(p[3], 1, 1, at(60), nil); len(out) != 0 {
		t.Fatalf("dead C2 talking to all heard by %v", listeners(out))
	}
	// Admin mute still applies.
	p[2].request(h, []byte(`{"talk":"all"}`))
	p[2].adminMuted.Store(true)
	if out := h.route(p[2], 1, 1, at(60), nil); len(out) != 0 {
		t.Fatal("admin-muted player talking to all is heard")
	}
	p[2].adminMuted.Store(false)
	// A listener who asked for no audio still gets none.
	p[1].deaf.Store(true)
	if got := listeners(h.route(p[2], 2, 961, at(80), nil)); got[p[1]] || len(got) != 2 {
		t.Fatalf("talk all with a deaf listener: heard by %v", got)
	}
}

// The mode goes back to the team once the speaker has been quiet for
// laneReleaseAfter (their lanes go then too), not before, and not right
// after they asked for all (the page sends it before its first packet).
func TestVoiceTalkAllReset(t *testing.T) {
	h, _, p := allHub(t, false)
	t0 := time.Unix(1000, 0)
	h.setTalk(p[0], true, t0)
	h.sweep(t0.Add(laneReleaseAfter - time.Millisecond))
	if !p[0].talkAll.Load() {
		t.Fatal("reset before the first packet")
	}
	h.route(p[0], 1, 1, t0.Add(400*time.Millisecond), nil)
	for _, q := range p[1:] {
		drain(q)
	}
	h.sweep(t0.Add(800 * time.Millisecond))
	if !p[0].talkAll.Load() {
		t.Fatal("reset 400 ms after the last packet")
	}
	h.sweep(t0.Add(900 * time.Millisecond))
	if p[0].talkAll.Load() {
		t.Fatal("not reset 500 ms after the last packet")
	}
	for _, q := range p[1:] {
		if e := drain(q); !eventsEqual(e, []voiceLaneEvent{{0, 0, false}}) {
			t.Fatalf("events at the reset %v, want lane 0 quiet", e)
		}
	}
	// Talking again without a talk message: the team.
	if got := listeners(h.route(p[0], 2, 961, t0.Add(time.Second), nil)); len(got) != 1 || !got[p[1]] {
		t.Fatalf("after the reset: heard by %v", got)
	}
	// A player not in the hub (left, or not joined yet) can't set it.
	h.leave(p[0])
	h.setTalk(p[0], true, t0)
	if p[0].talkAll.Load() {
		t.Fatal("mode set after leaving")
	}
	// A reconnect is a new peer, talking to the team.
	if q := (&voicePeer{}); q.talkAll.Load() {
		t.Fatal("a new connection talks to all")
	}
}

// wc_voice_all from the roster: 0 makes talking to all talk to the team
// (lanes go at the read, kept ones are announced as team), and is sent to
// the pages; 1 opens it again.
func TestVoiceAllOffPoller(t *testing.T) {
	pol := &rosterPolicy{}
	h := newVoiceHub(pol)
	p := testPeers(h, 3)
	for _, q := range p {
		q.mutedNotify = make(chan struct{}, 1)
	}
	peerOf := map[[4]byte]*voicePeer{p[0].ip: p[0], p[1].ip: p[1], p[2].ip: p[2]}
	console := &rosterConsole{out: "alltalk 0 intermission 0 voiceenable 1 wc_voice_all 1\n" +
		"0.1.2.3:27005 21 T 1\n1.1.2.3:27005 22 T 1\n2.1.2.3:27005 23 CT 1\n"}
	r := newRosterPoller(console, h, pol, rosterPeers(peerOf))
	t0 := time.Unix(1000, 0)
	r.poll(context.Background(), t0)
	if _, ok := p[0].takeAllOff(); ok {
		t.Fatal("wc_voice_all 1 sent without a change")
	}
	h.setTalk(p[0], true, t0)
	if got := listeners(h.route(p[0], 1, 1, t0, nil)); len(got) != 2 {
		t.Fatalf("talk all: heard by %v", got)
	}
	drain(p[1])
	drain(p[2])

	console.out = strings.Replace(console.out, "wc_voice_all 1", "wc_voice_all 0", 1)
	r.poll(context.Background(), t0.Add(250*time.Millisecond))
	if e := drain(p[2]); !eventsEqual(e, []voiceLaneEvent{{0, 0, false}}) {
		t.Fatalf("enemy events at wc_voice_all 0: %v", e)
	}
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 21, false}}) {
		t.Fatalf("teammate events at wc_voice_all 0: %v", e)
	}
	if got := listeners(h.route(p[0], 2, 961, t0.Add(260*time.Millisecond), nil)); len(got) != 1 || !got[p[1]] {
		t.Fatalf("wc_voice_all 0: heard by %v", got)
	}
	for _, q := range p {
		if off, ok := q.takeAllOff(); !ok || !off {
			t.Fatalf("wc_voice_all 0 not queued: %v, %v", off, ok)
		}
	}
	// A player joining now is told at once.
	late := &voicePeer{events: make(chan voiceLaneEvent, voiceEventQueue), mutedNotify: make(chan struct{}, 1)}
	h.join(late, [4]byte{9, 1, 2, 3})
	if off, ok := late.takeAllOff(); !ok || !off {
		t.Fatalf("late joiner: %v, %v", off, ok)
	}

	console.out = strings.Replace(console.out, "wc_voice_all 0", "wc_voice_all 1", 1)
	r.poll(context.Background(), t0.Add(500*time.Millisecond))
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 21, true}}) {
		t.Fatalf("teammate events at wc_voice_all 1: %v", e)
	}
	if got := listeners(h.route(p[0], 3, 1921, t0.Add(510*time.Millisecond), nil)); len(got) != 2 {
		t.Fatalf("wc_voice_all 1 again: heard by %v", got)
	}
	if off, ok := p[2].takeAllOff(); !ok || off {
		t.Fatalf("wc_voice_all 1 not queued: %v, %v", off, ok)
	}
}

// On the wire: the lane event's all, and the allOff event.
func TestVoiceAllEvents(t *testing.T) {
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
	done := make(chan struct{})
	go func() {
		p.sendEvents()
		close(done)
	}()
	next := func() string {
		select {
		case got := <-sent:
			return got
		case <-time.After(5 * time.Second):
			t.Fatal("no event")
			return ""
		}
	}
	p.events <- voiceLaneEvent{Lane: 2, UserID: 7, All: true}
	if got := next(); got != `{"data":{"lane":2,"userid":7,"all":true},"event":"voice"}` {
		t.Fatalf("all lane event %s", got)
	}
	// Team: no all field, as before A.7.
	p.events <- voiceLaneEvent{Lane: 2, UserID: 7}
	if got := next(); got != `{"data":{"lane":2,"userid":7},"event":"voice"}` {
		t.Fatalf("team lane event %s", got)
	}
	p.offerAllOff(true)
	if got := next(); got != `{"data":{"allOff":true},"event":"voice"}` {
		t.Fatalf("allOff event %s", got)
	}
	p.offerAllOff(false)
	if got := next(); got != `{"data":{"allOff":false},"event":"voice"}` {
		t.Fatalf("allOff false event %s", got)
	}
	close(p.events)
	<-done
}
