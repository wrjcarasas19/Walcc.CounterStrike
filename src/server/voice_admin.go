package main

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"slices"
)

// Admin voice mute (new-features-1007 A.6). The F4 Players tab mutes a
// player's voice with {"action":"voice_mute","userid":7} and lifts it with
// "voice_unmute". The mute is kept on the player's connection (voicePeer),
// so it lasts through map changes and ends when they leave: a reconnect is
// a new connection (and a new engine userid). It runs in Go, so it needs
// the admin API (rcon can't reach it), and only a player in voice chat can
// be muted (the roster must know their userid).
//
// A muted player's packets go to nobody (voicePolicy.adminMuted) and every
// player in voice is sent the whole list of muted userids
// ({"event":"voice","data":{"muted":[7]}}) whenever it changes and when
// they join, so their pages show a crossed-out microphone.

// voiceControl is what the voice admin actions use; nil in actionEnv when
// VOICE=0.
type voiceControl struct {
	hub    *voiceHub
	policy *rosterPolicy
}

var voiceActions = map[string]actionSpec{
	"voice_mute":   voiceMuteAction(true),
	"voice_unmute": voiceMuteAction(false),
}

func voiceMuteAction(muted bool) actionSpec {
	name := "voice_unmute"
	if muted {
		name = "voice_mute"
	}
	return actionSpec{fields: []string{"userid"}, prepare: func(f actionFields, _ actionEnv) (actionRunner, error) {
		userid, err := f.integer("userid", 1, math.MaxInt32)
		if err != nil {
			return nil, err
		}
		return func(_ context.Context, a *adminAPI, client string) (actionResult, error) {
			v := a.env.voice
			if v == nil {
				return actionResult{}, refuse(http.StatusConflict, "voice chat is off on this server (VOICE=0)")
			}
			list, changed, err := v.hub.setAdminMute(v.policy, userid, muted)
			if err != nil {
				return actionResult{}, refuse(http.StatusConflict, "%v", err)
			}
			out := fmt.Sprintf("Player #%d was already muted\n", userid)
			if !muted {
				out = fmt.Sprintf("Player #%d wasn't muted\n", userid)
			}
			if changed {
				a.logf("%s: %s #%d", client, name, userid)
				out = fmt.Sprintf("Muted player #%d\n", userid)
				if !muted {
					out = fmt.Sprintf("Unmuted player #%d\n", userid)
				}
			}
			return actionResult{Output: out, VoiceMuted: list}, nil
		}, nil
	}}
}

// mutedOrEmpty keeps an empty list as [] in JSON.
func mutedOrEmpty(list []int) []int {
	if list == nil {
		return []int{}
	}
	return list
}

// setAdminMute mutes (or unmutes) the player in voice with this engine
// userid, releases their lanes at once and sends everyone the new list.
// It returns the list and whether the mute changed.
func (h *voiceHub) setAdminMute(policy *rosterPolicy, userid int, muted bool) ([]int, bool, error) {
	p := policy.peerOf(userid)
	h.mu.Lock()
	if p == nil || !p.joined {
		h.mu.Unlock()
		return nil, false, fmt.Errorf("player #%d isn't in voice chat", userid)
	}
	changed := p.adminMuted.Swap(muted) != muted
	h.mu.Unlock()
	if changed {
		h.recheck()
	}
	h.refreshMuted()
	return h.mutedUserids(), changed, nil
}

// refreshMuted works out the admin-muted userids of the players in voice
// and, if the list changed, queues it for every one of them.
func (h *voiceHub) refreshMuted() {
	h.mu.Lock()
	defer h.mu.Unlock()
	var list []int
	for p := range h.peers {
		if !h.policy.adminMuted(p) {
			continue
		}
		if userid, ok := h.policy.userID(p); ok {
			list = append(list, userid)
		}
	}
	slices.Sort(list)
	if slices.Equal(list, h.muted) {
		return
	}
	h.muted = list
	for p := range h.peers {
		p.offerMuted(list)
	}
}

// mutedUserids is the list last sent (a copy).
func (h *voiceHub) mutedUserids() []int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.muted)
}

// offerMuted queues list (the whole admin-muted list) for sendEvents;
// only the latest list is sent if several come before it runs.
func (p *voicePeer) offerMuted(list []int) {
	p.mutedLock.Lock()
	p.mutedList = mutedOrEmpty(slices.Clone(list))
	p.mutedPending = true
	p.mutedLock.Unlock()
	if p.mutedNotify != nil {
		select {
		case p.mutedNotify <- struct{}{}:
		default:
		}
	}
}

// takeMuted returns the list waiting to be sent, if any.
func (p *voicePeer) takeMuted() ([]int, bool) {
	p.mutedLock.Lock()
	defer p.mutedLock.Unlock()
	if !p.mutedPending {
		return nil, false
	}
	p.mutedPending = false
	return p.mutedList, true
}
