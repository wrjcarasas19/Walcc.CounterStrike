package main

import (
	"strings"
	"sync"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Forwarding (new-features-1007 A.2). Each player's microphone is read by
// one goroutine; every packet goes to each other player who may hear the
// speaker (voicePolicy), on a lane of theirs:
//
//   - if the speaker already has a lane on that listener, there;
//   - otherwise on a free lane: one that was released, or whose speaker has
//     been quiet for laneFreeAfter (300 ms) or more; the page is told who is
//     on it now ("voice" event);
//   - if every lane is busy, the packet isn't sent to that listener.
//
// A lane whose speaker sends nothing for laneReleaseAfter (500 ms) is
// released and the page is told it went quiet (userid 0).
//
// Each lane rewrites sequence numbers and timestamps so they stay
// continuous for the listener's jitter buffer when a lane changes speaker:
// the new speaker's numbers get an offset that makes their first packet
// follow the lane's last one (timestamps advance by the wall-clock gap).
// TrackLocalStaticRTP rewrites SSRC and payload type itself.

const (
	// laneFreeAfter: a lane whose speaker has been quiet this long can be
	// taken by another speaker.
	laneFreeAfter = 300 * time.Millisecond
	// laneReleaseAfter: a lane whose speaker has been quiet this long is
	// released and announced quiet.
	laneReleaseAfter = 500 * time.Millisecond
	// voiceSweepPeriod is how often lanes are checked for release.
	voiceSweepPeriod = 100 * time.Millisecond
	// micRateLimit is the most a microphone may send, in bytes per second
	// of RTP (64 kbit/s, twice what the page asks the browser for), with
	// up to 1 s of it in a burst. Packets above it are dropped.
	micRateLimit = 64000 / 8
	// opusClockRate is the RTP clock of Opus (RFC 7587).
	opusClockRate = 48000
	// opusFrame is the shortest timestamp step put between two speakers on
	// a lane (20 ms, the browser's frame).
	opusFrame = opusClockRate / 50
)

// voicePolicy decides who hears whom. openVoicePolicy is the stand-in
// until A.3 replaces it with one fed by the roster plugin (teams, alive,
// sv_alltalk) and A.6 adds the admin mute.
type voicePolicy interface {
	// userID is the engine userid announced to listeners for speaker; ok
	// is false while it isn't known (the speaker isn't forwarded then).
	userID(speaker *voicePeer) (userid int, ok bool)
	// mayHear reports whether listener may hear speaker (never called with
	// listener == speaker).
	mayHear(listener, speaker *voicePeer) bool
	// adminMuted reports whether speaker was muted by the admin (heard by
	// nobody).
	adminMuted(speaker *voicePeer) bool
}

// openVoicePolicy: every voice-capable player hears every other one. The
// announced "userid" is a placeholder (slot index + 1), not the engine's
// userid: A.3 gets the real one from the roster.
type openVoicePolicy struct{}

func (openVoicePolicy) userID(p *voicePeer) (int, bool) { return int(p.ip[0]) + 1, true }
func (openVoicePolicy) mayHear(_, _ *voicePeer) bool    { return true }
func (openVoicePolicy) adminMuted(_ *voicePeer) bool    { return false }

// voiceLane is the forwarding state of one lane of a listener.
type voiceLane struct {
	// speaker is on the lane; nil when it is free (released and announced
	// quiet, or never used).
	speaker *voicePeer
	// last is when the lane last carried a packet.
	last time.Time
	// used: the lane has carried a packet, so seq and ts are its last
	// numbers.
	used bool
	// seqDelta and tsDelta turn the speaker's numbers into the lane's.
	seqDelta uint16
	tsDelta  uint32
	// seq and ts are the newest numbers the lane has sent.
	seq uint16
	ts  uint32
}

// laneWrite is one packet to send on a lane, with the lane's numbers.
type laneWrite struct {
	listener *voicePeer
	lane     int
	seq      uint16
	ts       uint32
	// first: the first packet of this speaker on the lane (RTP marker).
	first bool
}

// voiceHub routes voice between the players in it.
type voiceHub struct {
	policy voicePolicy
	// mu guards peers and, in each peer, joined, out and events.
	mu    sync.Mutex
	peers map[*voicePeer]struct{}
}

// voices is the server's voice hub (sfu.go joins players to it).
var voices = newVoiceHub(openVoicePolicy{})

func newVoiceHub(policy voicePolicy) *voiceHub {
	return &voiceHub{policy: policy, peers: map[*voicePeer]struct{}{}}
}

// join adds a player whose answer can send voice (voicePeer.answered) as
// both speaker and listener, known to the engine by ip. Lane events are
// queued on p.events from then on until leave.
func (h *voiceHub) join(p *voicePeer, ip [4]byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.joined || p.left {
		return
	}
	p.ip = ip
	p.joined = true
	h.peers[p] = struct{}{}
}

// leave removes a player: lanes they had on others are released (and
// announced quiet), their own lane state goes and their event queue is
// closed. Safe to call more than once, or for a player who never joined.
func (h *voiceHub) leave(p *voicePeer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.left {
		return
	}
	p.left = true
	if !p.joined {
		return
	}
	p.joined = false
	delete(h.peers, p)
	for l := range h.peers {
		for i := range l.out {
			if l.out[i].speaker == p {
				l.out[i].speaker = nil
				l.queue(i, 0)
			}
		}
	}
	p.out = [voiceLanes]voiceLane{}
	close(p.events)
}

// route decides where one packet from speaker goes (seq and ts are the
// speaker's numbers, now when it arrived) and appends those writes to out.
func (h *voiceHub) route(speaker *voicePeer, seq uint16, ts uint32, now time.Time, out []laneWrite) []laneWrite {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !speaker.joined || h.policy.adminMuted(speaker) {
		return out
	}
	userid, ok := h.policy.userID(speaker)
	if !ok {
		return out
	}
	for l := range h.peers {
		if l == speaker || !h.policy.mayHear(l, speaker) {
			continue
		}
		i := l.laneOf(speaker)
		first := false
		if i < 0 {
			if i = l.freeLane(now); i < 0 {
				// All lanes busy: this listener doesn't hear speaker now.
				continue
			}
			l.out[i].assign(speaker, seq, ts, now)
			l.queue(i, userid)
			first = true
		}
		lane := &l.out[i]
		w := laneWrite{listener: l, lane: i, seq: seq + lane.seqDelta, ts: ts + lane.tsDelta, first: first}
		lane.sent(w.seq, w.ts, now)
		out = append(out, w)
	}
	return out
}

// sweep releases the lanes quiet for laneReleaseAfter and queues their
// "quiet" events.
func (h *voiceHub) sweep(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for l := range h.peers {
		for i := range l.out {
			lane := &l.out[i]
			if lane.speaker != nil && now.Sub(lane.last) >= laneReleaseAfter {
				lane.speaker = nil
				l.queue(i, 0)
			}
		}
	}
}

// run sweeps the lanes for the life of the server.
func (h *voiceHub) run() {
	ticker := time.NewTicker(voiceSweepPeriod)
	defer ticker.Stop()
	for now := range ticker.C {
		h.sweep(now)
	}
}

// laneOf returns the lane speaker is on, or -1. Called with the hub locked.
func (p *voicePeer) laneOf(speaker *voicePeer) int {
	for i := range p.out {
		if p.out[i].speaker == speaker {
			return i
		}
	}
	return -1
}

// freeLane returns a lane a new speaker can take: a free one first, else
// the one quiet longest if that is laneFreeAfter or more; -1 if none.
// Called with the hub locked.
func (p *voicePeer) freeLane(now time.Time) int {
	best := -1
	for i := range p.out {
		lane := &p.out[i]
		if lane.speaker == nil {
			return i
		}
		if now.Sub(lane.last) >= laneFreeAfter && (best < 0 || lane.last.Before(p.out[best].last)) {
			best = i
		}
	}
	return best
}

// queue sends a lane event to the page without blocking the forwarding;
// it is dropped if the page has fallen that far behind. Called with the
// hub locked, while p is joined.
func (p *voicePeer) queue(lane, userid int) {
	select {
	case p.events <- voiceLaneEvent{Lane: lane, UserID: userid}:
	default:
		log.Warnf("Voice: event queue full, dropped lane %d event", lane)
	}
}

// sendEvents writes the queued lane events until leave closes the queue.
func (p *voicePeer) sendEvents() {
	for e := range p.events {
		_ = p.announceLane(e.Lane, e.UserID)
	}
}

// assign puts speaker on the lane. The offsets make the speaker's packet
// (seq, ts) follow the lane's last one: the next sequence number, and a
// timestamp moved on by the time since then (at least one frame).
func (lane *voiceLane) assign(speaker *voicePeer, seq uint16, ts uint32, now time.Time) {
	outSeq, outTS := seq, ts
	if lane.used {
		gap := uint32(opusFrame)
		if d := now.Sub(lane.last); d > 0 {
			// Wraps after 24 h of silence, like the RTP clock itself.
			if samples := uint32(d.Nanoseconds() * opusClockRate / int64(time.Second)); samples > gap {
				gap = samples
			}
		}
		outSeq, outTS = lane.seq+1, lane.ts+gap
	}
	lane.speaker = speaker
	lane.seqDelta = outSeq - seq
	lane.tsDelta = outTS - ts
}

// sent records a packet written on the lane with the lane's numbers.
// Sequence numbers and timestamps wrap; a late (reordered) packet doesn't
// move them back.
func (lane *voiceLane) sent(seq uint16, ts uint32, now time.Time) {
	if !lane.used || int16(seq-lane.seq) > 0 {
		lane.seq = seq
	}
	if !lane.used || int32(ts-lane.ts) > 0 {
		lane.ts = ts
	}
	lane.used = true
	lane.last = now
}

// byteRate is a token bucket of bytes: rate per second, holding at most
// one second's worth.
type byteRate struct {
	rate   float64
	tokens float64
	last   time.Time
}

// allow reports whether n more bytes may pass at now, and takes them if so.
func (r *byteRate) allow(n int, now time.Time) bool {
	if r.last.IsZero() {
		r.tokens = r.rate
	} else if d := now.Sub(r.last).Seconds(); d > 0 {
		r.tokens = min(r.rate, r.tokens+d*r.rate)
	}
	r.last = now
	if r.tokens < float64(n) {
		return false
	}
	r.tokens -= float64(n)
	return true
}

// onTrack handles a track the player sends. Only the first Opus track on
// the mic transceiver is read as the microphone; any other is drained and
// dropped.
func (p *voicePeer) onTrack(h *voiceHub, track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	if receiver != p.mic.Receiver() || !strings.EqualFold(track.Codec().MimeType, webrtc.MimeTypeOpus) || !p.micTaken.CompareAndSwap(false, true) {
		log.Warnf("Voice: dropping track %s (%s): not the microphone", track.ID(), track.Codec().MimeType)
		go discardTrack(track)
		return
	}
	go drainReceiverRTCP(receiver)
	go p.readMic(h, track)
}

// readMic forwards the microphone's packets until the track ends (the
// PeerConnection closes).
func (p *voicePeer) readMic(h *voiceHub, track *webrtc.TrackRemote) {
	buf := make([]byte, 1500)
	var pkt rtp.Packet
	limit := byteRate{rate: micRateLimit}
	var writes []laneWrite
	for {
		n, _, err := track.Read(buf)
		if err != nil {
			return
		}
		now := time.Now()
		if !limit.allow(n, now) {
			continue
		}
		if err := pkt.Unmarshal(buf[:n]); err != nil {
			continue
		}
		writes = h.route(p, pkt.SequenceNumber, pkt.Timestamp, now, writes[:0])
		if len(writes) == 0 {
			continue
		}
		// The lanes negotiate no header extensions, and padding isn't
		// worth carrying.
		pkt.Extension, pkt.ExtensionProfile, pkt.Extensions = false, 0, nil
		pkt.Padding, pkt.Header.PaddingSize, pkt.PaddingSize = false, 0, 0
		marker := pkt.Marker
		for _, w := range writes {
			pkt.SequenceNumber, pkt.Timestamp, pkt.Marker = w.seq, w.ts, marker || w.first
			// Fails only when the listener's connection is closing.
			_ = w.listener.lanes[w.lane].WriteRTP(&pkt)
		}
	}
}

// discardTrack reads a dropped track until it ends, so its buffer never
// fills.
func discardTrack(track *webrtc.TrackRemote) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := track.Read(buf); err != nil {
			return
		}
	}
}

// drainReceiverRTCP reads (and drops) the RTCP the player sends about their
// microphone (sender reports).
func drainReceiverRTCP(receiver *webrtc.RTPReceiver) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := receiver.Read(buf); err != nil {
			return
		}
	}
}

// voiceAnswered reports whether the answer in desc has the m-line mid as
// sendonly or sendrecv: a page with voice code (A.1). Old pages answer it
// inactive and get no voice at all.
func voiceAnswered(desc *webrtc.SessionDescription, mid string) bool {
	if desc == nil || mid == "" {
		return false
	}
	parsed, err := desc.Unmarshal()
	if err != nil {
		return false
	}
	for _, m := range parsed.MediaDescriptions {
		if got, _ := m.Attribute("mid"); got != mid {
			continue
		}
		_, sendonly := m.Attribute(webrtc.RTPTransceiverDirectionSendonly.String())
		_, sendrecv := m.Attribute(webrtc.RTPTransceiverDirectionSendrecv.String())
		return sendonly || sendrecv
	}
	return false
}
