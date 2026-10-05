package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gorilla/websocket"
	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
	"github.com/yohimik/goxash3d-fwgs/pkg"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// peerSlot is a connected player as the engine's sendto sees it. The engine
// knows each player by a fake IPv4 address: the slot index followed by
// addr. A slot is reused after its player leaves, while the engine may still
// be sending to the old player until it times out; addr tells them apart.
type peerSlot struct {
	write io.Writer
	addr  [3]byte
}

// owns reports whether ip is the address of this slot's player.
func (p *peerSlot) owns(ip [4]byte) bool {
	return [3]byte(ip[1:]) == p.addr
}

var connections = NewFixedArray[*peerSlot](128)

var packets = make(chan *goxash3d_fwgs.Packet, 256)

var (
	addr     = ":27016"
	upgrader = websocket.Upgrader{
		CheckOrigin: checkOrigin,
	}

	api *webrtc.API

	log = logging.NewDefaultLoggerFactory().NewLogger("sfu-ws")
)

type websocketMessage struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

const (
	messageSize    = 64 * 1024
	maxMessageSize = 256 * 1024
)

func ReadLoop(d io.Reader, ip [4]byte) {
	buffer := make([]byte, messageSize)
	for {
		n, err := d.Read(buffer)
		if err != nil {
			if errors.Is(err, io.ErrShortBuffer) && len(buffer) < maxMessageSize {
				buffer = make([]byte, maxMessageSize)
				continue
			}
			fmt.Println("Datachannel closed; Exit the readloop:", err)
			return
		}
		if n <= 0 {
			continue
		}
		data := make([]byte, n)
		copy(data, buffer[:n])
		select {
		case packets <- &goxash3d_fwgs.Packet{IP: ip, Data: data}:
		default:
			// The engine is behind; drop rather than stall this client's
			// data channel (and the SCTP association behind it).
			countDroppedPacket()
		}
	}
}

const dropLogInterval = 5 * time.Second

var (
	droppedPacketsLock sync.Mutex
	droppedPackets     int
	lastDropLog        time.Time
)

// countDroppedPacket counts packets dropped because the engine queue is full
// and logs the total at most once per dropLogInterval.
func countDroppedPacket() {
	droppedPacketsLock.Lock()
	defer droppedPacketsLock.Unlock()
	droppedPackets++
	if now := time.Now(); now.Sub(lastDropLog) >= dropLogInterval {
		log.Errorf("Engine packet queue full: dropped %d incoming packets", droppedPackets)
		droppedPackets = 0
		lastDropLog = now
	}
}

const (
	// maxConnectionsPerIP caps concurrent signaling WebSockets from one remote IP.
	maxConnectionsPerIP = 4
	// connectTimeout is how long a client has to open the game data channel.
	connectTimeout = 30 * time.Second
	pingPeriod     = 20 * time.Second
	pongWait       = 45 * time.Second
	writeWait      = 10 * time.Second
)

var (
	ipConnectionsLock sync.Mutex
	ipConnections     = map[string]int{}

	// ALLOWED_ORIGINS is a comma-separated list of extra origins (e.g.
	// "http://localhost:5173") or "*" to accept any origin.
	allowedOrigins = parseAllowedOrigins(os.Getenv("ALLOWED_ORIGINS"))
)

func parseAllowedOrigins(value string) map[string]bool {
	origins := map[string]bool{}
	for _, origin := range strings.Split(value, ",") {
		origin = strings.TrimRight(strings.ToLower(strings.TrimSpace(origin)), "/")
		if origin != "" {
			origins[origin] = true
		}
	}
	return origins
}

// checkOrigin accepts same-host pages, origins listed in ALLOWED_ORIGINS and
// non-browser clients that send no Origin header.
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	normalized := strings.TrimRight(strings.ToLower(origin), "/")
	if allowedOrigins["*"] || allowedOrigins[normalized] {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

func remoteHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func acquireIP(host string) bool {
	ipConnectionsLock.Lock()
	defer ipConnectionsLock.Unlock()
	if ipConnections[host] >= maxConnectionsPerIP {
		return false
	}
	ipConnections[host]++
	return true
}

func releaseIP(host string) {
	ipConnectionsLock.Lock()
	defer ipConnectionsLock.Unlock()
	if ipConnections[host] <= 1 {
		delete(ipConnections, host)
		return
	}
	ipConnections[host]--
}

var errSessionClosed = errors.New("session closed")

// gameSession owns the server slot of one player. The slot is allocated only
// once the game data channel is open and is released exactly once.
type gameSession struct {
	lock      sync.Mutex
	closed    bool
	slot      byte
	slotGen   uint32
	ip        [4]byte
	hasSlot   bool
	connected chan struct{}
}

// channelOpened takes a slot for the open game channel and returns the
// address the engine knows this player by.
func (s *gameSession) channelOpened(d io.ReadWriteCloser) (ip [4]byte, err error) {
	s.lock.Lock()
	defer s.lock.Unlock()

	if s.closed || s.hasSlot {
		_ = d.Close()
		return ip, errSessionClosed
	}

	peer := &peerSlot{write: d}
	for i := range peer.addr {
		peer.addr[i] = byte(rand.Intn(256))
	}
	index, gen, err := connections.Add(peer)
	if err != nil {
		s.closed = true
		return ip, err
	}
	s.slot, s.slotGen, s.hasSlot = index, gen, true

	ip = [4]byte{index, peer.addr[0], peer.addr[1], peer.addr[2]}
	s.ip = ip
	close(s.connected)
	return ip, nil
}

// abandon closes a session that never finished connecting. It returns false
// (and changes nothing) if the game channel is already open.
func (s *gameSession) abandon() bool {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.hasSlot {
		return false
	}
	s.closed = true
	return true
}

// release frees the slot (if any), has the engine drop the player, and stops
// later channel opens from taking a slot.
func (s *gameSession) release() {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.closed = true
	if s.hasSlot {
		s.hasSlot = false
		if err := connections.Remove(s.slot, s.slotGen); err != nil {
			log.Errorf("Failed to remove connection: %v", err)
		}
		requestDrop(s.ip)
	}
}

// Handle incoming websockets.
func websocketHandler(w http.ResponseWriter, r *http.Request) { // nolint
	host := remoteHost(r)
	if !acquireIP(host) {
		log.Errorf("Refusing websocket from %s: more than %d connections", host, maxConnectionsPerIP)
		http.Error(w, "Too many connections", http.StatusTooManyRequests)

		return
	}
	defer releaseIP(host)

	// Upgrade HTTP request to Websocket
	unsafeConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Errorf("Failed to upgrade HTTP to Websocket: %v", err)

		return
	}

	c := &threadSafeWriter{unsafeConn, sync.Mutex{}} // nolint

	// When this frame returns close the Websocket
	defer c.Close() //nolint

	// Create new PeerConnection
	peerConnection, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		log.Errorf("Failed to creates a PeerConnection: %v", err)

		return
	}

	// When this frame returns close the PeerConnection
	defer peerConnection.Close() //nolint

	// Runs before the PeerConnection closes; frees the slot exactly once.
	session := &gameSession{connected: make(chan struct{})}
	defer session.release()

	closePeer := func() {
		if err := peerConnection.Close(); err != nil {
			log.Errorf("Failed to close PeerConnection: %v", err)
		}
	}

	// One unordered channel without retransmits carries the game's UDP
	// traffic both ways.
	f := false
	var z uint16 = 0
	gameChannel, err := peerConnection.CreateDataChannel("game", &webrtc.DataChannelInit{
		Ordered:        &f,
		MaxRetransmits: &z,
	})
	if err != nil {
		log.Errorf("Failed to creates a data channel: %v", err)

		return
	}
	gameChannel.OnOpen(func() {
		d, err := gameChannel.Detach()
		if err != nil {
			log.Errorf("Failed to detach data channel: %v", err)
			go closePeer()

			return
		}
		ip, err := session.channelOpened(d)
		if err != nil {
			if !errors.Is(err, errSessionClosed) {
				log.Errorf("Failed to add connection: %v", err)
				go closePeer()
			}

			return
		}
		go func() {
			ReadLoop(d, ip)
			// The client's game channel is gone; end the session.
			closePeer()
		}()
	})
	defer gameChannel.Close()

	// Trickle ICE. Emit server candidate to client
	peerConnection.OnICECandidate(func(i *webrtc.ICECandidate) {
		if i == nil {
			return
		}
		// If you are serializing a candidate make sure to use ToJSON
		// Using Marshal will result in errors around `sdpMid`

		if writeErr := c.WriteJSON("candidate", i.ToJSON()); writeErr != nil {
			log.Errorf("Failed to write JSON: %v", writeErr)
		}
	})

	// The session lives as long as the PeerConnection: failed/closed ends it.
	peerDone := make(chan struct{})
	var peerDoneOnce sync.Once
	peerConnection.OnConnectionStateChange(func(p webrtc.PeerConnectionState) {
		switch p {
		case webrtc.PeerConnectionStateFailed:
			closePeer()
		case webrtc.PeerConnectionStateClosed:
			peerDoneOnce.Do(func() { close(peerDone) })
		default:
		}
	})

	// Keep the signaling socket alive through idle proxies/NATs.
	if err := c.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		log.Errorf("Failed to set read deadline: %v", err)

		return
	}
	c.SetPongHandler(func(string) error {
		return c.SetReadDeadline(time.Now().Add(pongWait))
	})

	// Send the single offer for this connection. The data channel is fixed
	// up front, so there is never any renegotiation after the answer.
	offer, err := peerConnection.CreateOffer(nil)
	if err != nil {
		log.Errorf("Failed to create offer: %v", err)

		return
	}
	if err := peerConnection.SetLocalDescription(offer); err != nil {
		log.Errorf("Failed to set local description: %v", err)

		return
	}
	if err := c.WriteJSON("offer", offer); err != nil {
		log.Errorf("Failed to send offer: %v", err)

		return
	}

	wsDone := make(chan struct{})
	go func() {
		defer close(wsDone)
		readSignaling(c, peerConnection)
		// Finish the close now rather than when the PeerConnection ends.
		_ = c.Close()
	}()

	stopPing := make(chan struct{})
	defer close(stopPing)
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-stopPing:
				return
			case <-wsDone:
				return
			case <-ticker.C:
				if err := c.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
					return
				}
			}
		}
	}()

	timer := time.NewTimer(connectTimeout)
	defer timer.Stop()
	timedOut := false
	select {
	case <-session.connected:
	case <-wsDone:
	case <-peerDone:
	case <-timer.C:
		timedOut = true
	}
	if session.abandon() {
		if timedOut {
			log.Errorf("Closing websocket from %s: WebRTC not connected within %v", host, connectTimeout)
		}

		return
	}

	// The game data channel is open. Losing the signaling socket no longer ends
	// the game; wait for the PeerConnection to fail or close.
	<-peerDone
}

// maxPendingCandidates caps the ICE candidates kept while waiting for the
// answer; a browser sends a handful.
const maxPendingCandidates = 64

// readSignaling handles answer/candidate messages until the socket fails.
func readSignaling(c *threadSafeWriter, peerConnection *webrtc.PeerConnection) {
	// Candidates that arrive before the answer can't be added yet (pion
	// rejects them without a remote description), so they wait for it.
	var pending []webrtc.ICECandidateInit
	answered := false
	addCandidate := func(candidate webrtc.ICECandidateInit) {
		// A candidate the peer can't use only loses that path; ICE goes on
		// with the others.
		if err := peerConnection.AddICECandidate(candidate); err != nil {
			log.Warnf("Failed to add ICE candidate: %v", err)
		}
	}

	for {
		_, raw, err := c.ReadMessage()
		if err != nil {
			log.Errorf("Failed to read message: %v", err)

			return
		}

		message := websocketMessage{}
		if err := json.Unmarshal(raw, &message); err != nil {
			log.Errorf("Failed to unmarshal json to message: %v", err)

			return
		}

		switch message.Event {
		case "candidate":
			candidate := webrtc.ICECandidateInit{}
			if err := json.Unmarshal(message.Data, &candidate); err != nil {
				log.Errorf("Failed to unmarshal json to candidate: %v", err)

				return
			}

			if answered {
				addCandidate(candidate)
			} else if len(pending) < maxPendingCandidates {
				pending = append(pending, candidate)
			}
		case "answer":
			answer := webrtc.SessionDescription{}
			if err := json.Unmarshal(message.Data, &answer); err != nil {
				log.Errorf("Failed to unmarshal json to answer: %v", err)

				return
			}

			if err := peerConnection.SetRemoteDescription(answer); err != nil {
				log.Errorf("Failed to set remote description: %v", err)

				return
			}
			answered = true
			for _, candidate := range pending {
				addCandidate(candidate)
			}
			pending = nil
		default:
			log.Errorf("unknown message: %+v", message)
		}
	}
}

// Helper to make Gorilla Websockets threadsafe.
type threadSafeWriter struct {
	*websocket.Conn
	sync.Mutex
}

func (t *threadSafeWriter) WriteJSON(event string, v interface{}) error {
	t.Lock()
	defer t.Unlock()

	return t.Conn.WriteJSON(struct {
		Event string `json:"event"`
		Data  any    `json:"data"`
	}{event, v})
}

const html = ""

func indexHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, html)
}

type Server struct {
	static http.Handler
	maps   http.Handler
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/websocket":
		websocketHandler(w, r)
	default:
		if strings.HasPrefix(r.URL.Path, mapsPrefix) {
			s.maps.ServeHTTP(w, r)
			return
		}
		s.static.ServeHTTP(w, r)
	}
}

func runSFU() {
	settingEngine := webrtc.SettingEngine{}
	settingEngine.DetachDataChannels()

	// Browsers hide their local addresses behind mDNS .local names, which
	// the container can't resolve; the peer-reflexive candidate learned from
	// the browser's own checks is what connects.
	settingEngine.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)

	// IPv4 only: the NAT 1:1 IP below is an IPv4 address.
	settingEngine.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})

	port, ok := os.LookupEnv("PORT")
	if ok {
		p, err := strconv.Atoi(port)
		if err == nil {
			udpMux, err := ice.NewMultiUDPMuxFromPort(p)
			if err != nil {
				panic(err)
			}
			settingEngine.SetICEUDPMux(udpMux)

			// ICE-TCP on the same port, for networks that block UDP.
			tcpListener, err := net.ListenTCP("tcp", &net.TCPAddr{Port: p})
			if err != nil {
				panic(err)
			}
			settingEngine.SetICETCPMux(webrtc.NewICETCPMux(nil, tcpListener, 8))
		}
	}

	ip, ok := os.LookupEnv("IP")
	if ok {
		// Applies to all host candidates, UDP and TCP.
		settingEngine.SetNAT1To1IPs([]string{ip}, webrtc.ICECandidateTypeHost)
	}

	// Data channels only: no media codecs or RTP interceptors needed.
	api = webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine))

	receive := newPacketReceiver(packets, recvIdleWait)
	goxash3d_fwgs.DefaultXash3D.RegisterRecvfromCallback(func() *goxash3d_fwgs.Packet {
		// recvfrom runs on the engine thread, the only place commands can
		// be queued safely.
		runDrops()
		return receive()
	})
	goxash3d_fwgs.DefaultXash3D.RegisterSendtoCallback(func(p goxash3d_fwgs.Packet) {
		peer, err := connections.Get(p.IP[0])
		if err != nil || peer == nil || !peer.owns(p.IP) {
			return
		}
		if len(p.Data) == 0 || len(p.Data) > maxMessageSize {
			return
		}
		// p.Data aliases C stack memory from Netchan_TransmitBits; copy before Write.
		payload := append([]byte(nil), p.Data...)
		_, _ = peer.write.Write(payload)
	})

	// start HTTP server
	if err := http.ListenAndServe(addr, &Server{
		static: newStaticHandler("public"),
		maps:   newMapsHandler(filepath.Join("cstrike", "maps")),
	}); err != nil { //nolint: gosec
		log.Errorf("Failed to start http server: %v", err)
	}
}
