package main

import (
	"context"
	"errors"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Who hears whom (new-features-1007 A.3): the CS 1.6 rules with
// sv_alltalk 0, from a roster of the players' teams and alive state that
// the wc_roster AMXX plugin (src/amxx/wc_roster.sma) prints. While anyone
// is in voice, the roster is read through the engine console every
// rosterPollPeriod; the forwarder's policy reads the latest one, and lanes
// whose listener may no longer hear their speaker are released right after
// each read (so a player who dies goes quiet for the living within one
// poll).

const (
	// rosterPollPeriod is how often the roster is read while anyone is in
	// voice.
	rosterPollPeriod = 250 * time.Millisecond
	// rosterTimeout is how long one wc_roster command may take.
	rosterTimeout = time.Second
	// rosterStaleAfter: when the roster can't be read for this long (a map
	// change, the plugin missing), the last one is dropped and nobody hears
	// anybody until it can be read again.
	rosterStaleAfter = 2 * time.Second
	// rosterCommand is the plugin's server command.
	rosterCommand = "wc_roster"
)

// rosterTeam is a player's team as the roster reports it. Players who
// haven't picked a team are reported as spectators.
type rosterTeam uint8

const (
	teamSpec rosterTeam = iota
	teamT
	teamCT
)

// rosterPlayer is one human player in the roster.
type rosterPlayer struct {
	userid int
	team   rosterTeam
	alive  bool
}

// rosterLine is a roster line: the player and the address the engine knows
// them by (peerSlot).
type rosterLine struct {
	ip [4]byte
	rosterPlayer
}

// rosterState is one wc_roster output.
type rosterState struct {
	alltalk      bool
	intermission bool
	// voiceOff is sv_voiceenable 0: voice chat is off (nobody hears
	// anybody; rosterPolicy.mayHear).
	voiceOff bool
	// voiceAllOff is wc_voice_all 0: the talk-to-all key talks to the team
	// only (A.7).
	voiceAllOff bool
	players     []rosterLine
}

var errNoRoster = errors.New("no wc_roster header in the output (is wc_roster.amxx loaded?)")

// parseRoster reads the output of wc_roster: the header line
// "alltalk <0|1> intermission <0|1> voiceenable <0|1> wc_voice_all <0|1>",
// then
// "<ip:port> <userid> <T|CT|SPEC> <alive 0|1>" per player. Lines that don't
// parse are skipped; without the header it is an error.
func parseRoster(out string) (rosterState, error) {
	var st rosterState
	header := false
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if !header {
			if len(f) >= 4 && f[0] == "alltalk" && f[2] == "intermission" {
				header = true
				st.alltalk = f[1] != "0"
				st.intermission = f[3] != "0"
				// Settings older plugin output doesn't have keep their
				// defaults (voice on, talking to all on).
				for i := 4; i+1 < len(f); i += 2 {
					switch f[i] {
					case "voiceenable":
						st.voiceOff = f[i+1] == "0"
					case "wc_voice_all":
						st.voiceAllOff = f[i+1] == "0"
					}
				}
			}
			continue
		}
		if p, ok := parseRosterLine(f); ok {
			st.players = append(st.players, p)
		}
	}
	if !header {
		return rosterState{}, errNoRoster
	}
	return st, nil
}

// parseRosterLine reads the fields of one player line.
func parseRosterLine(f []string) (rosterLine, bool) {
	if len(f) != 4 {
		return rosterLine{}, false
	}
	var ip netip.Addr
	if ap, err := netip.ParseAddrPort(f[0]); err == nil {
		ip = ap.Addr()
	} else if ip, err = netip.ParseAddr(f[0]); err != nil {
		return rosterLine{}, false
	}
	if !ip.Is4() {
		return rosterLine{}, false
	}
	userid, err := strconv.Atoi(f[1])
	if err != nil || userid <= 0 {
		return rosterLine{}, false
	}
	var team rosterTeam
	switch f[2] {
	case "T":
		team = teamT
	case "CT":
		team = teamCT
	case "SPEC":
		team = teamSpec
	default:
		return rosterLine{}, false
	}
	if f[3] != "0" && f[3] != "1" {
		return rosterLine{}, false
	}
	return rosterLine{ip: ip.As4(), rosterPlayer: rosterPlayer{userid: userid, team: team, alive: f[3] == "1"}}, true
}

// canHear is the CS 1.6 rule: with sv_alltalk or during the intermission
// everyone hears everyone; otherwise only teammates (spectators are a team
// of their own), and the living don't hear the dead. Dead players hear
// their dead and living teammates.
func canHear(listener, speaker rosterPlayer, alltalk, intermission bool) bool {
	if alltalk || intermission {
		return true
	}
	if listener.team != speaker.team {
		return false
	}
	if listener.team == teamSpec {
		return true
	}
	return !listener.alive || speaker.alive
}

// canHearAll is the rule for a speaker talking to all players (A.7, the
// talk-to-all key): enemies hear them too, but the living still don't hear
// the dead (so the dead can't call out enemy positions). Spectators and the
// dead hear everyone.
func canHearAll(listener, speaker rosterPlayer) bool {
	return !listener.alive || speaker.alive
}

// voiceRoster is the roster the forwarder reads: the players in voice by
// their voicePeer, and the settings. It is never changed once published.
type voiceRoster struct {
	alltalk      bool
	intermission bool
	voiceOff     bool
	voiceAllOff  bool
	players      map[*voicePeer]rosterPlayer
}

// buildVoiceRoster maps the roster lines to the players' voicePeers;
// peerAt returns the voicePeer of the player the engine knows by ip, or nil
// (no such player, not this slot's current player, or no voice).
func buildVoiceRoster(st rosterState, peerAt func(ip [4]byte) *voicePeer) *voiceRoster {
	r := &voiceRoster{alltalk: st.alltalk, intermission: st.intermission, voiceOff: st.voiceOff, voiceAllOff: st.voiceAllOff, players: make(map[*voicePeer]rosterPlayer, len(st.players))}
	for _, line := range st.players {
		if p := peerAt(line.ip); p != nil {
			r.players[p] = line.rosterPlayer
		}
	}
	return r
}

// gameVoicePeer is peerAt for the players connected through runSFU: the
// slot's player if ip is theirs (peerSlot.owns).
func gameVoicePeer(ip [4]byte) *voicePeer {
	peer, err := connections.Get(ip[0])
	if err != nil || peer == nil || !peer.owns(ip) {
		return nil
	}
	return peer.voice
}

// rosterPolicy is the voicePolicy fed by the roster. Its methods run under
// the hub's lock for every packet and listener, so they only read the
// published roster.
type rosterPolicy struct {
	roster atomic.Pointer[voiceRoster]
}

// set publishes a new roster (nil: nobody is known).
func (p *rosterPolicy) set(r *voiceRoster) { p.roster.Store(r) }

func (p *rosterPolicy) userID(speaker *voicePeer) (int, bool) {
	r := p.roster.Load()
	if r == nil {
		return 0, false
	}
	s, ok := r.players[speaker]
	return s.userid, ok
}

func (p *rosterPolicy) mayHear(listener, speaker *voicePeer) bool {
	r := p.roster.Load()
	if r == nil || r.voiceOff {
		return false
	}
	l, ok := r.players[listener]
	if !ok {
		return false
	}
	s, ok := r.players[speaker]
	if !ok {
		return false
	}
	return canHear(l, s, r.alltalk, r.intermission) ||
		(!r.voiceAllOff && speaker.talkAll.Load() && canHearAll(l, s))
}

// talksToAll reports whether speaker is talking to all players now: they
// asked for it ({"talk":"all"}) and wc_voice_all allows it.
func (p *rosterPolicy) talksToAll(speaker *voicePeer) bool {
	r := p.roster.Load()
	return r != nil && !r.voiceAllOff && speaker.talkAll.Load()
}

// adminMuted is the admin's mute of this connection (voice_admin.go).
func (p *rosterPolicy) adminMuted(speaker *voicePeer) bool { return speaker.adminMuted.Load() }

// peerOf returns the voicePeer of the player with this engine userid in the
// roster, or nil.
func (p *rosterPolicy) peerOf(userid int) *voicePeer {
	r := p.roster.Load()
	if r == nil {
		return nil
	}
	for peer, player := range r.players {
		if player.userid == userid {
			return peer
		}
	}
	return nil
}

// voicePolicyNow is the server's voice policy (the hub in voices uses it).
var voicePolicyNow = &rosterPolicy{}

// rosterPoller reads the roster while anyone is in voice.
type rosterPoller struct {
	console consoleRunner
	hub     *voiceHub
	policy  *rosterPolicy
	peerAt  func(ip [4]byte) *voicePeer
	// lastGood is when the roster was last read, failedSince when reading
	// it started failing; failing is set once that lasted rosterStaleAfter
	// (so it is logged once).
	lastGood    time.Time
	failedSince time.Time
	failing     bool
	// voiceOff is the last sv_voiceenable 0 seen, to log changes.
	voiceOff bool
}

func newRosterPoller(console consoleRunner, hub *voiceHub, policy *rosterPolicy, peerAt func([4]byte) *voicePeer) *rosterPoller {
	return &rosterPoller{console: console, hub: hub, policy: policy, peerAt: peerAt}
}

// run polls until ctx ends.
func (r *rosterPoller) run(ctx context.Context) {
	ticker := time.NewTicker(rosterPollPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.poll(ctx, time.Now())
		}
	}
}

// poll reads the roster once if anyone is in voice, publishes it and
// releases the lanes it no longer allows.
func (r *rosterPoller) poll(ctx context.Context, now time.Time) {
	if !r.hub.active() {
		// Nobody to route; the next player in voice waits for a fresh read.
		if r.policy.roster.Load() != nil {
			r.policy.set(nil)
		}
		r.lastGood = time.Time{}
		return
	}
	cctx, cancel := context.WithTimeout(ctx, rosterTimeout)
	out, err := r.console.Run(cctx, rosterCommand)
	cancel()
	var st rosterState
	if err == nil {
		st, err = parseRoster(out)
	}
	if err != nil {
		if r.failedSince.IsZero() {
			r.failedSince = now
		}
		if !r.failing && now.Sub(r.failedSince) >= rosterStaleAfter {
			// Logged once, and only when it lasts (a map change is
			// usually shorter).
			log.Errorf("Voice: can't read the roster (%v): nobody hears anybody until it can", err)
			r.failing = true
		}
		if r.lastGood.IsZero() || now.Sub(r.lastGood) >= rosterStaleAfter {
			r.policy.set(nil)
			r.hub.recheck()
		}
		return
	}
	if r.failing {
		log.Errorf("Voice: the roster can be read again")
		r.failing = false
	}
	r.failedSince = time.Time{}
	r.lastGood = now
	if r.voiceOff != st.voiceOff {
		r.voiceOff = st.voiceOff
		if r.voiceOff {
			log.Errorf("Voice: sv_voiceenable is 0: voice chat is off")
		} else {
			log.Errorf("Voice: sv_voiceenable is 1: voice chat is on")
		}
	}
	r.policy.set(buildVoiceRoster(st, r.peerAt))
	r.hub.setAllOff(st.voiceAllOff)
	r.hub.recheck()
	// A muted player who left, or whose userid only now became known.
	r.hub.refreshMuted()
}
