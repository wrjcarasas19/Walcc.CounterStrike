package main

import (
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestParseVoice(t *testing.T) {
	for _, tc := range []struct {
		raw    string
		on, ok bool
	}{
		{"", true, true},
		{"1", true, true},
		{"0", false, true},
		{"yes", true, false},
		{" 0", true, false},
	} {
		if on, ok := parseVoice(tc.raw); on != tc.on || ok != tc.ok {
			t.Errorf("parseVoice(%q) = %v, %v; want %v, %v", tc.raw, on, ok, tc.on, tc.ok)
		}
	}
}

// sdpSection is one m-line of an SDP and its attributes.
type sdpSection struct {
	media string // "audio", "application"
	lines []string
}

func (s sdpSection) has(line string) bool {
	for _, l := range s.lines {
		if l == line {
			return true
		}
	}
	return false
}

func sdpSections(sdp string) []sdpSection {
	var sections []sdpSection
	for _, line := range strings.Split(sdp, "\r\n") {
		if strings.HasPrefix(line, "m=") {
			media, _, _ := strings.Cut(line[2:], " ")
			sections = append(sections, sdpSection{media: media})
		} else if len(sections) > 0 {
			sections[len(sections)-1].lines = append(sections[len(sections)-1].lines, line)
		}
	}
	return sections
}

// newGamePeer makes a PeerConnection like websocketHandler's: the game data
// channel, plus voice when withVoice. It returns the offer.
func newGamePeer(t *testing.T, api *webrtc.API, withVoice bool, signal func(string, any) error) (*webrtc.PeerConnection, *voicePeer, webrtc.SessionDescription) {
	t.Helper()
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	f := false
	var z uint16
	if _, err := pc.CreateDataChannel("game", &webrtc.DataChannelInit{Ordered: &f, MaxRetransmits: &z}); err != nil {
		t.Fatal(err)
	}
	var voice *voicePeer
	if withVoice {
		if voice, err = addVoiceTransceivers(pc, signal); err != nil {
			t.Fatal(err)
		}
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	return pc, voice, offer
}

func testAPI(t *testing.T) *webrtc.API {
	t.Helper()
	api, err := newWebRTCAPI(webrtc.SettingEngine{})
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func TestVoiceOfferHasMicAndLanes(t *testing.T) {
	_, _, offer := newGamePeer(t, testAPI(t), true, nil)

	var mic, lanes, data int
	for _, s := range sdpSections(offer.SDP) {
		switch s.media {
		case "application":
			data++
		case "audio":
			if !s.has("a=rtpmap:111 opus/48000/2") {
				t.Errorf("audio m-line without Opus: %q", s.lines)
			}
			switch {
			case s.has("a=recvonly"):
				if lanes > 0 {
					t.Error("the mic m-line comes after a lane")
				}
				mic++
			case s.has("a=sendonly"):
				lanes++
			default:
				t.Errorf("audio m-line is neither recvonly nor sendonly: %q", s.lines)
			}
		default:
			t.Errorf("unexpected m-line %q", s.media)
		}
	}
	if mic != 1 || lanes != voiceLanes || data != 1 {
		t.Fatalf("offer has %d mic, %d lane, %d data m-lines; want 1, %d, 1:\n%s", mic, lanes, data, voiceLanes, offer.SDP)
	}
	// Everything shares one transport.
	group := ""
	for _, line := range strings.Split(offer.SDP, "\r\n") {
		if strings.HasPrefix(line, "a=group:BUNDLE ") {
			group = line
		}
	}
	if got := len(strings.Fields(group)) - 1; got != 1+voiceLanes+1 {
		t.Fatalf("BUNDLE group %q has %d mids, want %d", group, got, 1+voiceLanes+1)
	}
}

func TestNoVoiceOfferIsDataOnly(t *testing.T) {
	_, _, offer := newGamePeer(t, testAPI(t), false, nil)
	sections := sdpSections(offer.SDP)
	if len(sections) != 1 || sections[0].media != "application" {
		t.Fatalf("offer without voice has m-lines %v, want only application", sections)
	}
}

// A client that knows nothing about voice (the page before voice chat, or
// one that adds no tracks) answers the offer as is.
func TestVoiceOfferAnsweredByClientWithoutVoice(t *testing.T) {
	api := testAPI(t)
	server, _, offer := newGamePeer(t, api, true, nil)

	client, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.SetRemoteDescription(offer); err != nil {
		t.Fatal(err)
	}
	answer, err := client.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	if err := server.SetRemoteDescription(answer); err != nil {
		t.Fatalf("server rejects the answer: %v", err)
	}
	if n := len(sdpSections(answer.SDP)); n != 1+voiceLanes+1 {
		t.Fatalf("answer has %d m-lines, want %d", n, 1+voiceLanes+1)
	}
}

func TestAnnounceLane(t *testing.T) {
	var events []voiceLaneEvent
	v := &voicePeer{signal: func(event string, data any) error {
		if event != "voice" {
			t.Errorf("event %q, want voice", event)
		}
		events = append(events, data.(voiceLaneEvent))
		return nil
	}}
	if err := v.announceLane(2, 7); err != nil {
		t.Fatal(err)
	}
	if err := v.announceLane(2, 0); err != nil {
		t.Fatal(err)
	}
	if err := v.announceLane(voiceLanes, 7); err != errNoSuchLane {
		t.Fatalf("lane %d: err = %v, want errNoSuchLane", voiceLanes, err)
	}
	if err := v.announceLane(-1, 7); err != errNoSuchLane {
		t.Fatalf("lane -1: err = %v, want errNoSuchLane", err)
	}
	want := []voiceLaneEvent{{2, 7}, {2, 0}}
	if len(events) != len(want) || events[0] != want[0] || events[1] != want[1] {
		t.Fatalf("events = %v, want %v", events, want)
	}
}
