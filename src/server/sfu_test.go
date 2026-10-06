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
