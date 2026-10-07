package main

import "testing"

func TestPeerSlotOwnsOnlyItsAddress(t *testing.T) {
	peer := &peerSlot{addr: [3]byte{10, 20, 30}}

	if !peer.owns([4]byte{5, 10, 20, 30}) {
		t.Fatal("owns() = false for the slot's own address")
	}
	// A player who left the same slot: same index, different address.
	if peer.owns([4]byte{5, 10, 20, 31}) {
		t.Fatal("owns() = true for a previous player's address")
	}
}

func TestGamePeers(t *testing.T) {
	closed := make(chan string, 4)
	add := func(key string, addr [3]byte) [4]byte {
		peer := &peerSlot{addr: addr, key: key, close: func() { closed <- key }}
		index, gen, err := connections.Add(peer)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = connections.Remove(index, gen) })
		return [4]byte{index, addr[0], addr[1], addr[2]}
	}
	a := add("198.51.100.9", [3]byte{1, 2, 3})
	add("198.51.100.9", [3]byte{4, 5, 6})
	other := add("203.0.113.8", [3]byte{7, 8, 9})

	var peers gamePeers
	if key, ok := peers.keyOf(a); !ok || key != "198.51.100.9" {
		t.Fatalf("keyOf = %q, %v", key, ok)
	}
	if _, ok := peers.keyOf([4]byte{a[0], 9, 9, 9}); ok {
		t.Fatal("keyOf matched a previous player's address")
	}
	if n := peers.closeFrom("198.51.100.9"); n != 2 {
		t.Fatalf("closeFrom = %d, want 2", n)
	}
	for i := 0; i < 2; i++ {
		if key := <-closed; key != "198.51.100.9" {
			t.Fatalf("closed %q", key)
		}
	}
	if key, ok := peers.keyOf(other); !ok || key != "203.0.113.8" {
		t.Fatalf("other keyOf = %q, %v", key, ok)
	}
	select {
	case key := <-closed:
		t.Fatalf("also closed %q", key)
	default:
	}
}

type nopChannel struct{}

func (nopChannel) Read([]byte) (int, error)    { return 0, nil }
func (nopChannel) Write(b []byte) (int, error) { return len(b), nil }
func (nopChannel) Close() error                { return nil }

// The device token hash a session was opened with goes into its slot, for
// as long as the slot is this player's.
func TestGameSessionDevice(t *testing.T) {
	var peers gamePeers
	withDevice := &gameSession{connected: make(chan struct{}), key: "198.51.100.9", device: "ab12"}
	ip, err := withDevice.channelOpened(nopChannel{})
	if err != nil {
		t.Fatal(err)
	}
	without := &gameSession{connected: make(chan struct{}), key: "198.51.100.10"}
	ip2, err := without.channelOpened(nopChannel{})
	if err != nil {
		t.Fatal(err)
	}
	// release queues an engine drop of the address: take it back out so
	// TestRequestDropQueuesUntilRun only sees its own.
	t.Cleanup(func() {
		without.release()
		for i := 0; i < 2; i++ {
			<-dropRequests
		}
	})

	if hash, ok := peers.deviceOf(ip); !ok || hash != "ab12" {
		t.Fatalf("deviceOf = %q, %v", hash, ok)
	}
	if hash, ok := peers.deviceOf(ip2); !ok || hash != "" {
		t.Fatalf("deviceOf without a cookie = %q, %v", hash, ok)
	}
	if _, ok := peers.deviceOf([4]byte{ip[0], ip[1] + 1, ip[2], ip[3]}); ok {
		t.Fatal("deviceOf matched another address in the same slot")
	}
	withDevice.release()
	if hash, ok := peers.deviceOf(ip); ok {
		t.Fatalf("deviceOf after release = %q", hash)
	}
}
