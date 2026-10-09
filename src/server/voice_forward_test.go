package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// testPolicy lets tests decide who hears whom.
type testPolicy struct {
	deaf    map[[2]*voicePeer]bool // {listener, speaker}: may not hear
	unknown map[*voicePeer]bool    // no userid yet
	muted   map[*voicePeer]bool    // admin muted
}

func (p *testPolicy) userID(s *voicePeer) (int, bool) {
	if p.unknown[s] {
		return 0, false
	}
	return int(s.ip[0]) + 1, true
}
func (p *testPolicy) mayHear(l, s *voicePeer) bool { return !p.deaf[[2]*voicePeer{l, s}] }
func (p *testPolicy) adminMuted(s *voicePeer) bool { return p.muted[s] }
func (p *testPolicy) talksToAll(s *voicePeer) bool { return s.talkAll.Load() }

// openVoicePolicy: every player in voice hears every other one, with the
// slot index plus 1 as the userid.
type openVoicePolicy struct{}

func (openVoicePolicy) userID(p *voicePeer) (int, bool) { return int(p.ip[0]) + 1, true }
func (openVoicePolicy) mayHear(_, _ *voicePeer) bool    { return true }
func (openVoicePolicy) adminMuted(_ *voicePeer) bool    { return false }
func (openVoicePolicy) talksToAll(p *voicePeer) bool    { return p.talkAll.Load() }

func newTestPolicy() *testPolicy {
	return &testPolicy{deaf: map[[2]*voicePeer]bool{}, unknown: map[*voicePeer]bool{}, muted: map[*voicePeer]bool{}}
}

// testPeers joins n peers without connections; peer i has slot i (userid
// i+1 with testPolicy).
func testPeers(h *voiceHub, n int) []*voicePeer {
	peers := make([]*voicePeer, n)
	for i := range peers {
		peers[i] = &voicePeer{events: make(chan voiceLaneEvent, voiceEventQueue)}
		h.join(peers[i], [4]byte{byte(i), 1, 2, 3})
	}
	return peers
}

// drain returns the events queued for p so far.
func drain(p *voicePeer) []voiceLaneEvent {
	var got []voiceLaneEvent
	for {
		select {
		case e, ok := <-p.events:
			if !ok {
				return got
			}
			got = append(got, e)
		default:
			return got
		}
	}
}

func eventsEqual(a, b []voiceLaneEvent) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// writesTo returns the writes of out for listener.
func writesTo(out []laneWrite, listener *voicePeer) []laneWrite {
	var got []laneWrite
	for _, w := range out {
		if w.listener == listener {
			got = append(got, w)
		}
	}
	return got
}

func TestVoiceLaneAssignment(t *testing.T) {
	h := newVoiceHub(newTestPolicy())
	p := testPeers(h, 6)
	listener := p[5]
	t0 := time.Unix(1000, 0)

	// Four speakers take the four lanes in order.
	for i := 0; i < 4; i++ {
		got := writesTo(h.route(p[i], 1, 1, t0, nil), listener)
		if len(got) != 1 || got[0].lane != i || !got[0].first {
			t.Fatalf("speaker %d: writes %+v, want lane %d first", i, got, i)
		}
	}
	if e := drain(listener); !eventsEqual(e, []voiceLaneEvent{{0, 1, false}, {1, 2, false}, {2, 3, false}, {3, 4, false}}) {
		t.Fatalf("events %v", e)
	}
	// A speaker keeps their lane.
	if got := writesTo(h.route(p[2], 2, 961, t0.Add(20*time.Millisecond), nil), listener); len(got) != 1 || got[0].lane != 2 || got[0].first {
		t.Fatalf("speaker 2 again: %+v", got)
	}
	// All busy: the fifth isn't heard by the listener, but by the others
	// (who have a lane free since they don't hear themselves).
	out := h.route(p[4], 1, 1, t0.Add(100*time.Millisecond), nil)
	if got := writesTo(out, listener); len(got) != 0 {
		t.Fatalf("fifth speaker got lanes %+v while all were busy", got)
	}
	if len(out) != 4 {
		t.Fatalf("fifth speaker reaches %d listeners, want 4", len(out))
	}
	if e := drain(listener); len(e) != 0 {
		t.Fatalf("events for a dropped packet: %v", e)
	}
	// Still busy at 299 ms of silence for speakers 0, 1, 3.
	if got := writesTo(h.route(p[4], 2, 961, t0.Add(299*time.Millisecond), nil), listener); len(got) != 0 {
		t.Fatalf("lane taken before %v: %+v", laneFreeAfter, got)
	}
	// At 300 ms the lane quiet longest is free: speaker 0's (lane 0;
	// speaker 2 spoke 20 ms later than the others).
	got := writesTo(h.route(p[4], 3, 1921, t0.Add(300*time.Millisecond), nil), listener)
	if len(got) != 1 || got[0].lane != 0 || !got[0].first {
		t.Fatalf("after %v: %+v, want lane 0", laneFreeAfter, got)
	}
	if e := drain(listener); !eventsEqual(e, []voiceLaneEvent{{0, 5, false}}) {
		t.Fatalf("takeover events %v", e)
	}
	// Speaker 0 comes back and gets another lane: 1 and 3 have been quiet
	// longest (since t0), and 1 comes first.
	got = writesTo(h.route(p[0], 2, 961, t0.Add(310*time.Millisecond), nil), listener)
	if len(got) != 1 || got[0].lane != 1 {
		t.Fatalf("speaker 0 back: %+v, want lane 1", got)
	}
	drain(listener)

	// Release after 500 ms of silence: lane 3 (speaker 3, last at t0) and
	// lane 2 (speaker 2, last at t0+20ms).
	h.sweep(t0.Add(499 * time.Millisecond))
	if e := drain(listener); len(e) != 0 {
		t.Fatalf("released before %v: %v", laneReleaseAfter, e)
	}
	h.sweep(t0.Add(520 * time.Millisecond))
	if e := drain(listener); !eventsEqual(e, []voiceLaneEvent{{2, 0, false}, {3, 0, false}}) {
		t.Fatalf("release events %v, want lanes 2 and 3 quiet", e)
	}
	if listener.out[2].speaker != nil || listener.out[3].speaker != nil {
		t.Fatal("released lanes still have a speaker")
	}
	// A released lane is taken at once by a new speaker.
	got = writesTo(h.route(p[3], 9, 9, t0.Add(530*time.Millisecond), nil), listener)
	if len(got) != 1 || got[0].lane != 2 {
		t.Fatalf("after release: %+v, want lane 2", got)
	}
}

func TestVoicePolicy(t *testing.T) {
	pol := newTestPolicy()
	h := newVoiceHub(pol)
	p := testPeers(h, 3)
	t0 := time.Unix(1000, 0)

	pol.deaf[[2]*voicePeer{p[1], p[0]}] = true
	out := h.route(p[0], 1, 1, t0, nil)
	if len(out) != 1 || out[0].listener != p[2] {
		t.Fatalf("writes %+v, want only to peer 2", out)
	}
	// The speaker never hears themselves.
	if got := writesTo(out, p[0]); len(got) != 0 {
		t.Fatal("speaker hears themselves")
	}
	pol.muted[p[0]] = true
	if out := h.route(p[0], 2, 961, t0, nil); len(out) != 0 {
		t.Fatalf("admin-muted speaker forwarded: %+v", out)
	}
	pol.unknown[p[1]] = true
	if out := h.route(p[1], 1, 1, t0, nil); len(out) != 0 {
		t.Fatalf("speaker without a userid forwarded: %+v", out)
	}
	// A peer not in the hub isn't forwarded.
	stranger := &voicePeer{events: make(chan voiceLaneEvent, 1)}
	if out := h.route(stranger, 1, 1, t0, nil); len(out) != 0 {
		t.Fatalf("peer outside the hub forwarded: %+v", out)
	}
}

func TestVoiceLeave(t *testing.T) {
	h := newVoiceHub(newTestPolicy())
	p := testPeers(h, 3)
	t0 := time.Unix(1000, 0)
	h.route(p[0], 1, 1, t0, nil)
	drain(p[1])
	drain(p[2])

	h.leave(p[0])
	if e := drain(p[1]); !eventsEqual(e, []voiceLaneEvent{{0, 0, false}}) {
		t.Fatalf("listener events after the speaker left: %v", e)
	}
	if _, ok := <-p[0].events; ok {
		t.Fatal("leaver's event queue still open")
	}
	h.leave(p[0]) // twice is fine
	if out := h.route(p[0], 2, 961, t0, nil); len(out) != 0 {
		t.Fatal("a player who left is still forwarded")
	}
	if out := h.route(p[1], 1, 1, t0, nil); len(out) != 1 || out[0].listener != p[2] {
		t.Fatalf("after leave, writes %+v, want only peer 2", out)
	}
	// Leaving before joining keeps the player out for good.
	late := &voicePeer{events: make(chan voiceLaneEvent, 1)}
	h.leave(late)
	h.join(late, [4]byte{9, 1, 2, 3})
	if late.joined {
		t.Fatal("joined after leave")
	}
}

func TestVoiceRewriteAcrossSpeakers(t *testing.T) {
	h := newVoiceHub(newTestPolicy())
	p := testPeers(h, 3)
	listener := p[2]
	t0 := time.Unix(1000, 0)
	one := func(speaker *voicePeer, seq uint16, ts uint32, at time.Time) laneWrite {
		t.Helper()
		got := writesTo(h.route(speaker, seq, ts, at, nil), listener)
		if len(got) != 1 {
			t.Fatalf("writes %+v, want one", got)
		}
		return got[0]
	}

	// A lane's first speaker keeps their numbers.
	w := one(p[0], 40000, 1000, t0)
	if w.seq != 40000 || w.ts != 1000 {
		t.Fatalf("first packet %d/%d, want 40000/1000", w.seq, w.ts)
	}
	w = one(p[0], 40001, 1960, t0.Add(20*time.Millisecond))
	if w.seq != 40001 || w.ts != 1960 {
		t.Fatalf("second packet %d/%d", w.seq, w.ts)
	}
	// Speaker 0 is released; speaker 1 takes the lane 1 s after its last
	// packet: the next sequence number, timestamp moved on by 1 s.
	h.sweep(t0.Add(600 * time.Millisecond))
	at := t0.Add(1020 * time.Millisecond)
	w = one(p[1], 7, 123456789, at)
	if w.lane != 0 || w.seq != 40002 || w.ts != 1960+opusClockRate || !w.first {
		t.Fatalf("switch: lane %d %d/%d first %v, want lane 0 40002/%d first", w.lane, w.seq, w.ts, w.first, 1960+opusClockRate)
	}
	w = one(p[1], 8, 123456789+960, at.Add(20*time.Millisecond))
	if w.seq != 40003 || w.ts != 1960+opusClockRate+960 || w.first {
		t.Fatalf("after switch %d/%d", w.seq, w.ts)
	}
	// A late packet from before maps back but doesn't move the lane back.
	w = one(p[1], 6, 123456789-960, at.Add(25*time.Millisecond))
	if w.seq != 40001 || listener.out[0].seq != 40003 {
		t.Fatalf("late packet %d, lane at %d", w.seq, listener.out[0].seq)
	}
	// The speaker leaves; the next one, 1 ms after the lane's last packet,
	// still starts one frame later.
	h.leave(p[1])
	w = one(p[0], 100, 5, at.Add(26*time.Millisecond))
	if w.seq != 40004 || w.ts != 1960+opusClockRate+960+opusFrame {
		t.Fatalf("after leave %d/%d, want 40004/%d", w.seq, w.ts, 1960+opusClockRate+960+opusFrame)
	}
}

func TestVoiceRewriteWraparound(t *testing.T) {
	h := newVoiceHub(newTestPolicy())
	p := testPeers(h, 3)
	listener := p[2]
	t0 := time.Unix(1000, 0)
	route := func(speaker *voicePeer, seq uint16, ts uint32, at time.Time) laneWrite {
		t.Helper()
		got := writesTo(h.route(speaker, seq, ts, at, nil), listener)
		if len(got) != 1 {
			t.Fatalf("writes %+v", got)
		}
		return got[0]
	}
	// The lane ends at 65535 / 2^32-480.
	route(p[0], 65535, 0xFFFFFFFF-479, t0)
	h.sweep(t0.Add(time.Second))
	// The next speaker continues across the wrap: seq 0, ts wrapped.
	at := t0.Add(laneReleaseAfter + 10*time.Millisecond)
	w := route(p[1], 30000, 50, at)
	gap := uint32(at.Sub(t0).Nanoseconds() * opusClockRate / int64(time.Second))
	if w.seq != 0 || w.ts != 0xFFFFFFFF-479+gap {
		t.Fatalf("across wrap %d/%d, want 0/%d", w.seq, w.ts, uint32(0xFFFFFFFF-479+gap))
	}
	// The speaker's own wrap keeps the lane continuous.
	h.leave(p[1])
	p1 := &voicePeer{events: make(chan voiceLaneEvent, voiceEventQueue)}
	h.join(p1, [4]byte{1, 9, 9, 9})
	at = at.Add(time.Second)
	w = route(p1, 65534, 0xFFFFFFFF-959, at)
	base := w.seq
	baseTS := w.ts
	w = route(p1, 65535, 0, at.Add(20*time.Millisecond)) // the speaker's ts wrapped
	if w.seq != base+1 || w.ts != baseTS+960 {
		t.Fatalf("speaker wrap step %d/%d, want %d/%d", w.seq, w.ts, base+1, baseTS+960)
	}
	w = route(p1, 0, 960, at.Add(40*time.Millisecond))
	if w.seq != base+2 || w.ts != baseTS+1920 {
		t.Fatalf("speaker seq wrap %d/%d, want %d/%d", w.seq, w.ts, base+2, baseTS+1920)
	}
	if listener.out[0].seq != base+2 {
		t.Fatalf("lane seq %d, want %d", listener.out[0].seq, base+2)
	}
}

func TestVoiceMicRateLimit(t *testing.T) {
	t0 := time.Unix(1000, 0)
	// A browser at 32 kbit/s (~100 B every 20 ms) always passes.
	r := byteRate{rate: micRateLimit}
	for i := 0; i < 500; i++ {
		if !r.allow(100, t0.Add(time.Duration(i)*20*time.Millisecond)) {
			t.Fatalf("32 kbit/s packet %d dropped", i)
		}
	}
	// 160 kbit/s (200 B every 10 ms) for 10 s: 1 s of burst plus 64 kbit/s.
	r = byteRate{rate: micRateLimit}
	passed := 0
	for i := 0; i < 1000; i++ {
		if r.allow(200, t0.Add(time.Duration(i)*10*time.Millisecond)) {
			passed += 200
		}
	}
	want := micRateLimit + 10*micRateLimit
	if passed < want-400 || passed > want+400 {
		t.Fatalf("160 kbit/s for 10 s passed %d B, want about %d", passed, want)
	}
	// After a quiet second the bucket is full again, and no fuller.
	r.allow(0, t0.Add(20*time.Second))
	if r.tokens != micRateLimit {
		t.Fatalf("tokens after a pause %v, want %d", r.tokens, micRateLimit)
	}
}

func TestVoiceAnswered(t *testing.T) {
	sdp := func(dir string) *webrtc.SessionDescription {
		return &webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n" +
			"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=" + dir + "\r\n" +
			"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\na=recvonly\r\n"}
	}
	for dir, want := range map[string]bool{"sendonly": true, "sendrecv": true, "recvonly": false, "inactive": false} {
		if got := voiceAnswered(sdp(dir), "0"); got != want {
			t.Errorf("mic %s: %v, want %v", dir, got, want)
		}
	}
	if voiceAnswered(sdp("sendonly"), "7") || voiceAnswered(nil, "0") || voiceAnswered(sdp("sendonly"), "") {
		t.Error("answered without the mic m-line")
	}
}

// voiceTestClient is a pion client with a microphone track, connected to a
// server PeerConnection made like websocketHandler's.
type voiceTestClient struct {
	server *webrtc.PeerConnection
	voice  *voicePeer
	client *webrtc.PeerConnection
	mic    *webrtc.TrackLocalStaticRTP
	events chan string
	lanes  chan *webrtc.TrackRemote
}

func loopbackAPI(t *testing.T, detach bool) *webrtc.API {
	t.Helper()
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	se.SetInterfaceFilter(func(name string) bool { return name == "lo" })
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	if detach {
		se.DetachDataChannels()
	}
	api, err := newWebRTCAPI(se)
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func connectVoiceClient(t *testing.T, serverAPI, clientAPI *webrtc.API, hub *voiceHub, withMic bool) *voiceTestClient {
	t.Helper()
	c := &voiceTestClient{events: make(chan string, 16), lanes: make(chan *webrtc.TrackRemote, voiceLanes)}
	var err error
	if c.server, err = serverAPI.NewPeerConnection(webrtc.Configuration{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.server.Close() })
	f := false
	var z uint16
	if _, err := c.server.CreateDataChannel("game", &webrtc.DataChannelInit{Ordered: &f, MaxRetransmits: &z}); err != nil {
		t.Fatal(err)
	}
	if c.voice, err = addVoiceTransceivers(c.server, func(string, any) error { return nil }, hub); err != nil {
		t.Fatal(err)
	}
	offer, err := c.server.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(c.server)
	if err := c.server.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered

	if c.client, err = clientAPI.NewPeerConnection(webrtc.Configuration{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.client.Close() })
	c.client.OnDataChannel(func(d *webrtc.DataChannel) {
		if d.Label() == "voice" {
			d.OnMessage(func(m webrtc.DataChannelMessage) {
				if m.IsString {
					c.events <- string(m.Data)
				}
			})
		}
	})
	c.client.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) { c.lanes <- track })
	if err := c.client.SetRemoteDescription(*c.server.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	if withMic {
		// Like the page: the first audio transceiver (the mic) sends.
		if c.mic, err = webrtc.NewTrackLocalStaticRTP(voiceCodec.RTPCodecCapability, "mic", "mic"); err != nil {
			t.Fatal(err)
		}
		if _, err := c.client.AddTrack(c.mic); err != nil {
			t.Fatal(err)
		}
	}
	answer, err := c.client.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered = webrtc.GatheringCompletePromise(c.client)
	if err := c.client.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	answer = *c.client.LocalDescription()
	if !withMic {
		// pion answers the mic sendonly even without a track; Chrome (and
		// the page before voice chat) answers it inactive.
		answer.SDP = strings.Replace(answer.SDP, "a=sendonly", "a=inactive", 1)
	}
	if err := c.server.SetRemoteDescription(answer); err != nil {
		t.Fatal(err)
	}
	return c
}

func waitConnected(t *testing.T, pc *webrtc.PeerConnection) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
		if time.Now().After(deadline) {
			t.Fatalf("not connected: %v", pc.ConnectionState())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// End to end through pion: a client's microphone packets arrive on another
// client's lane with the lane's numbers, and the lane events come over the
// voice data channel.
func TestVoiceForwardsBetweenClients(t *testing.T) {
	serverAPI, clientAPI := loopbackAPI(t, true), loopbackAPI(t, false)
	hub := newVoiceHub(openVoicePolicy{})
	talker := connectVoiceClient(t, serverAPI, clientAPI, hub, true)
	listener := connectVoiceClient(t, serverAPI, clientAPI, hub, true)
	old := connectVoiceClient(t, serverAPI, clientAPI, hub, false)
	for i, c := range []*voiceTestClient{talker, listener, old} {
		waitConnected(t, c.server)
		capable := voiceAnswered(c.server.RemoteDescription(), c.voice.mic.Mid())
		if capable != (c != old) {
			t.Fatalf("client %d: voiceAnswered %v", i, capable)
		}
		if capable {
			hub.join(c.voice, [4]byte{byte(i), 1, 2, 3})
			go c.voice.sendEvents()
		}
	}
	// The voice data channel opens shortly after connecting.
	deadline := time.Now().Add(5 * time.Second)
	for {
		listener.voice.channelLock.Lock()
		open := listener.voice.channel != nil
		listener.voice.channelLock.Unlock()
		if open {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("voice data channel never opened")
		}
		time.Sleep(10 * time.Millisecond)
	}

	stop := make(chan struct{})
	defer close(stop)
	go func() {
		seq, ts := uint16(65530), uint32(0xFFFFFFFF-2000)
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = talker.mic.WriteRTP(&rtp.Packet{
					Header:  rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: ts},
					Payload: []byte{0xfc, byte(seq), byte(seq >> 8)},
				})
				seq++
				ts += 960
			}
		}
	}()

	var lane *webrtc.TrackRemote
	select {
	case lane = <-listener.lanes:
	case <-time.After(10 * time.Second):
		t.Fatal("no audio on the listener's lanes")
	}
	if lane.ID() != "lane0" {
		t.Fatalf("audio on %s, want lane0", lane.ID())
	}
	var prev *rtp.Packet
	for i := 0; i < 10; i++ {
		_ = lane.SetReadDeadline(time.Now().Add(2 * time.Second))
		pkt, _, err := lane.ReadRTP()
		if err != nil {
			t.Fatal(err)
		}
		if len(pkt.Payload) != 3 || pkt.Payload[0] != 0xfc {
			t.Fatalf("payload %x", pkt.Payload)
		}
		if prev != nil && (pkt.SequenceNumber != prev.SequenceNumber+1 || pkt.Timestamp != prev.Timestamp+960) {
			t.Fatalf("packet %d/%d after %d/%d", pkt.SequenceNumber, pkt.Timestamp, prev.SequenceNumber, prev.Timestamp)
		}
		prev = pkt
	}
	select {
	case e := <-listener.events:
		var got struct {
			Event string         `json:"event"`
			Data  voiceLaneEvent `json:"data"`
		}
		if err := json.Unmarshal([]byte(e), &got); err != nil || got.Event != "voice" || got.Data != (voiceLaneEvent{0, 1, false}) {
			t.Fatalf("lane event %q", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no lane event on the voice data channel")
	}
	// Nothing reaches the old client, and the talker doesn't hear themself.
	select {
	case tr := <-old.lanes:
		t.Fatalf("old client got audio on %s", tr.ID())
	case tr := <-talker.lanes:
		t.Fatalf("talker got audio on %s", tr.ID())
	case <-time.After(200 * time.Millisecond):
	}
	// The talker stops: the lane is announced quiet.
	stop <- struct{}{}
	hub.sweep(time.Now().Add(laneReleaseAfter))
	select {
	case e := <-listener.events:
		if !strings.Contains(e, `"userid":0`) {
			t.Fatalf("quiet event %q", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no quiet event")
	}
	hub.leave(talker.voice)
	hub.leave(listener.voice)
}
