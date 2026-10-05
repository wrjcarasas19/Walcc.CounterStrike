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
