package main

import (
	"errors"
	"fmt"

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
	return v.signal("voice", voiceLaneEvent{Lane: lane, UserID: userid})
}

// addVoiceTransceivers adds the mic and lane transceivers to a
// PeerConnection before its offer is made. The mic comes first, then the
// lanes in order.
func addVoiceTransceivers(pc *webrtc.PeerConnection, signal func(string, any) error) (*voicePeer, error) {
	mic, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	})
	if err != nil {
		return nil, err
	}
	v := &voicePeer{mic: mic, signal: signal}
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
	return v, nil
}

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
