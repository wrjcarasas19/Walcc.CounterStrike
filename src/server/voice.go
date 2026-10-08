package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

// Voice chat goes over WebRTC audio on each player's PeerConnection,
// negotiated in the server's single offer (no renegotiation): one recvonly
// transceiver for the player's microphone and voiceLanes sendonly ones,
// each a lane that carries one speaker at a time to this player.

// voiceLanes is how many people a player can hear at once.
const voiceLanes = 4

// voiceEnabled is VOICE (main.go): false leaves the audio out of the offer.
var voiceEnabled = true

// parseVoice reads VOICE: "", "1" turn voice on, "0" off. ok is false for
// anything else (voice stays on).
func parseVoice(raw string) (on, ok bool) {
	switch raw {
	case "", "1":
		return true, true
	case "0":
		return false, true
	}
	return true, false
}

// voiceCodec is the only codec the server negotiates. RFC 7587 always
// writes Opus as 48000/2 in SDP; the browser sends mono (its getUserMedia
// asks for one channel).
var voiceCodec = webrtc.RTPCodecParameters{
	RTPCodecCapability: webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeOpus,
		ClockRate:   48000,
		Channels:    2,
		SDPFmtpLine: "minptime=10;useinbandfec=1",
	},
	PayloadType: 111,
}

// newWebRTCAPI builds the API for the game's PeerConnections: Opus only and
// no interceptors, so nothing (no RTCP reports, no NACKs) is sent on an
// audio stream that carries no voice.
func newWebRTCAPI(settingEngine webrtc.SettingEngine) (*webrtc.API, error) {
	media := &webrtc.MediaEngine{}
	if err := media.RegisterCodec(voiceCodec, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	return webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(media),
		webrtc.WithInterceptorRegistry(&interceptor.Registry{}),
	), nil
}

// voicePeer is one player's side of voice chat.
type voicePeer struct {
	// mic receives the player's microphone. The page attaches a track only
	// while the player talks (replaceTrack), so it is silent otherwise.
	mic *webrtc.RTPTransceiver
	// lanes are the tracks this player hears; the page knows them by the
	// order of their sendonly m-lines (lane 0 first).
	lanes [voiceLanes]*webrtc.TrackLocalStaticRTP
	// signal writes an event to the player's signaling WebSocket. It fails
	// once the socket is gone (the game goes on without it).
	signal func(event string, v any) error
	// channel is the open "voice" data channel (nil before), which carries
	// the lane events once open; see sendVoiceEvent.
	channelLock sync.Mutex
	channel     io.Writer
	// micTaken is set once a track is read as the microphone.
	micTaken atomic.Bool

	// Hub state (voice_forward.go), guarded by the hub's mu: ip is the
	// address the engine knows the player by (peerSlot); joined while in
	// the hub, left once leave ran; out is the forwarding state of each
	// lane; events queues lane events for sendEvents.
	ip     [4]byte
	joined bool
	left   bool
	out    [voiceLanes]voiceLane
	events chan voiceLaneEvent
}

// voiceLaneEvent tells the page who is on a lane: UserID 0 when it goes
// quiet.
type voiceLaneEvent struct {
	Lane   int `json:"lane"`
	UserID int `json:"userid"`
}

var errNoSuchLane = errors.New("no such voice lane")

// announceLane sends the "voice" event for lane.
func (v *voicePeer) announceLane(lane, userid int) error {
	if lane < 0 || lane >= voiceLanes {
		return errNoSuchLane
	}
	return v.sendVoiceEvent(voiceLaneEvent{Lane: lane, UserID: userid})
}

// sendVoiceEvent sends a "voice" event on the voice data channel, or on
// the signaling WebSocket before the channel is open (or if writing to it
// fails). The data channel lasts as long as the game's connection, while
// the WebSocket may be lost mid-game (sfu.go goes on without it).
func (v *voicePeer) sendVoiceEvent(e voiceLaneEvent) error {
	v.channelLock.Lock()
	channel := v.channel
	v.channelLock.Unlock()
	if channel != nil {
		msg, err := json.Marshal(struct {
			Event string         `json:"event"`
			Data  voiceLaneEvent `json:"data"`
		}{"voice", e})
		if err != nil {
			return err
		}
		if w, ok := channel.(interface {
			WriteDataChannel([]byte, bool) (int, error)
		}); ok {
			// A text message, so the page gets a string.
			_, err = w.WriteDataChannel(msg, true)
		} else {
			_, err = channel.Write(msg)
		}
		if err == nil {
			return nil
		}
	}
	return v.signal("voice", e)
}

// addVoiceTransceivers adds the mic and lane transceivers to a
// PeerConnection before its offer is made, the mic first, then the lanes in
// order, and the reliable "voice" data channel for lane events (in the same
// SCTP association as the game channel, so the offer doesn't change). The
// microphone is forwarded through hub once the player joins it.
func addVoiceTransceivers(pc *webrtc.PeerConnection, signal func(string, any) error, hub *voiceHub) (*voicePeer, error) {
	mic, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	})
	if err != nil {
		return nil, err
	}
	v := &voicePeer{mic: mic, signal: signal, events: make(chan voiceLaneEvent, voiceEventQueue)}
	for i := range v.lanes {
		track, err := webrtc.NewTrackLocalStaticRTP(voiceCodec.RTPCodecCapability, fmt.Sprintf("lane%d", i), "voice")
		if err != nil {
			return nil, err
		}
		t, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		})
		if err != nil {
			return nil, err
		}
		v.lanes[i] = track
		go drainRTCP(t.Sender())
	}
	channel, err := pc.CreateDataChannel("voice", nil)
	if err != nil {
		return nil, err
	}
	channel.OnOpen(func() {
		d, err := channel.Detach()
		if err != nil {
			log.Errorf("Failed to detach voice data channel: %v", err)
			return
		}
		v.channelLock.Lock()
		v.channel = d
		v.channelLock.Unlock()
		// The page sends nothing on it; read until it closes.
		go func() {
			buf := make([]byte, 1500)
			for {
				if _, err := d.Read(buf); err != nil {
					v.channelLock.Lock()
					v.channel = nil
					v.channelLock.Unlock()
					return
				}
			}
		}()
	})
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		v.onTrack(hub, track, receiver)
	})
	return v, nil
}

// voiceEventQueue is how many lane events can wait for a slow page.
const voiceEventQueue = 64

// drainRTCP reads (and drops) the RTCP the player sends about a lane, so
// its buffer never fills; it ends when the PeerConnection closes.
func drainRTCP(sender *webrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := sender.Read(buf); err != nil {
			return
		}
	}
}
