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
// A speaker talks to their team, or to all players while the page says so
// (A.7: {"talk":"all"}, the talk-to-all key; voicePolicy decides who hears
// that). The lane events say which (all), and are sent again when it
// changes while the speaker keeps a lane. Switching back to the team
// releases the lanes of listeners who may no longer hear (recheck), and a
// speaker who stops talking for laneReleaseAfter goes back to the team.
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

// voicePolicy decides who hears whom: rosterPolicy (voice_roster.go), fed
// by the roster plugin (teams, alive, sv_alltalk, sv_voiceenable), plus the
// admin mute (voice_admin.go).
// Its methods are called under the hub's lock for every packet and
// listener, so they must not block.
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
	// talksToAll reports whether speaker is talking to all players now
	// (asked for, and allowed by the server), for the lane events.
	talksToAll(speaker *voicePeer) bool
}

// voiceLane is the forwarding state of one lane of a listener.
type voiceLane struct {
	// speaker is on the lane; nil when it is free (released and announced
	// quiet, or never used).
	speaker *voicePeer
	// all is what the page was last told: speaker talks to all players.
	all bool
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
	// mu guards peers, muted and, in each peer, joined, out and events.
	mu    sync.Mutex
	peers map[*voicePeer]struct{}
	// muted is the admin-muted userids last sent to the players, sorted
	// (voice_admin.go).
	muted []int
	// allOff is wc_voice_all 0 as last sent to the players (A.7).
	allOff bool
}

// voices is the server's voice hub (sfu.go joins players to it).
var voices = newVoiceHub(voicePolicyNow)

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
	// The page starts each connection with nobody muted.
	if len(h.muted) > 0 {
		p.offerMuted(h.muted)
	}
	// It also assumes talking to all players is on.
	if h.allOff {
		p.offerAllOff(true)
	}
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
				l.queue(i, 0, false)
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
	if !speaker.joined {
		return out
	}
	speaker.spoke = now
	if h.policy.adminMuted(speaker) {
		return out
	}
	userid, ok := h.policy.userID(speaker)
	if !ok {
		return out
	}
	all := h.policy.talksToAll(speaker)
	for l := range h.peers {
		if l == speaker || l.deaf.Load() || !h.policy.mayHear(l, speaker) {
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
			l.out[i].all = all
			l.queue(i, userid, all)
			first = true
		}
		lane := &l.out[i]
		if lane.all != all {
			// Switched between team and all while keeping the lane.
			lane.all = all
			l.queue(i, userid, all)
		}
		w := laneWrite{listener: l, lane: i, seq: seq + lane.seqDelta, ts: ts + lane.tsDelta, first: first}
		lane.sent(w.seq, w.ts, now)
		out = append(out, w)
	}
	return out
}

// sweep releases the lanes quiet for laneReleaseAfter and queues their
// "quiet" events, and puts the speakers quiet that long (who haven't just
// chosen who they talk to either) back to talking to their team.
func (h *voiceHub) sweep(now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for l := range h.peers {
		for i := range l.out {
			lane := &l.out[i]
			if lane.speaker != nil && now.Sub(lane.last) >= laneReleaseAfter {
				lane.speaker = nil
				l.queue(i, 0, false)
			}
		}
		// Their lanes went above: each lane's last packet is one of theirs.
		if l.talkAll.Load() && now.Sub(l.spoke) >= laneReleaseAfter && now.Sub(l.talkAt) >= laneReleaseAfter {
			l.talkAll.Store(false)
		}
	}
}

// setTalk sets who speaker talks to: all players or their team (A.7,
// {"talk":...} from the page) at now. Going back to the team releases the
// lanes of the listeners who may no longer hear them; the lanes they keep
// are announced again with the new mode.
func (h *voiceHub) setTalk(speaker *voicePeer, all bool, now time.Time) {
	h.mu.Lock()
	if !speaker.joined {
		h.mu.Unlock()
		return
	}
	speaker.talkAt = now
	changed := speaker.talkAll.Swap(all) != all
	h.mu.Unlock()
	if changed {
		h.recheck()
	}
}

// recheck releases (and announces quiet) the lanes whose listener may no
// longer hear their speaker, after the policy changed (a new roster, an
// admin mute, sv_voiceenable 0, a speaker back to talking to their team)
// or the listener asked for no audio: the speaker's audio already stops at
// the next packet, this tells the page at once instead of laneReleaseAfter
// later. Lanes kept whose talk-to-all mode changed are announced again.
func (h *voiceHub) recheck() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for l := range h.peers {
		deaf := l.deaf.Load()
		for i := range l.out {
			s := l.out[i].speaker
			if s == nil {
				continue
			}
			if userid, known := h.policy.userID(s); known && !deaf && !h.policy.adminMuted(s) && h.policy.mayHear(l, s) {
				if all := h.policy.talksToAll(s); all != l.out[i].all {
					l.out[i].all = all
					l.queue(i, userid, all)
				}
				continue
			}
			l.out[i].speaker = nil
			l.queue(i, 0, false)
		}
	}
}

// active reports whether anyone is in voice.
func (h *voiceHub) active() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.peers) > 0
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
func (p *voicePeer) queue(lane, userid int, all bool) {
	select {
	case p.events <- voiceLaneEvent{Lane: lane, UserID: userid, All: all}:
	default:
		log.Warnf("Voice: event queue full, dropped lane %d event", lane)
	}
}

// sendEvents writes the queued lane events, and the admin-muted list and
// wc_voice_all when they change, until leave closes the queue.
func (p *voicePeer) sendEvents() {
	for {
		select {
		case e, ok := <-p.events:
			if !ok {
				return
			}
			_ = p.announceLane(e)
		case <-p.mutedNotify:
			if list, ok := p.takeMuted(); ok {
				_ = p.sendVoiceEvent(voiceMutedEvent{Muted: list})
			}
			if off, ok := p.takeAllOff(); ok {
				_ = p.sendVoiceEvent(voiceAllEvent{AllOff: off})
			}
		}
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
