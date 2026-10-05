package main

import (
	"testing"
	"time"
)

func TestPacketReceiverWaitsWhenIdle(t *testing.T) {
	queue := make(chan *int, 4)
	recv := newPacketReceiver(queue, 20*time.Millisecond)

	start := time.Now()
	if got := recv(); got != nil {
		t.Fatalf("recv() = %v, want nil", got)
	}
	if elapsed := time.Since(start); elapsed < 20*time.Millisecond {
		t.Fatalf("idle read returned after %v, want at least the idle wait", elapsed)
	}
}

func TestPacketReceiverEndsDrainWithoutWaiting(t *testing.T) {
	queue := make(chan *int, 4)
	recv := newPacketReceiver(queue, time.Second)

	a, b := 1, 2
	queue <- &a
	queue <- &b
	if got := recv(); got != &a {
		t.Fatalf("first recv() = %v, want first packet", got)
	}
	if got := recv(); got != &b {
		t.Fatalf("second recv() = %v, want second packet", got)
	}
	start := time.Now()
	if got := recv(); got != nil {
		t.Fatalf("recv() after drain = %v, want nil", got)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("read ending a drain took %v, want an immediate return", elapsed)
	}
}

func TestPacketReceiverWaitsAgainAfterDrain(t *testing.T) {
	queue := make(chan *int, 4)
	recv := newPacketReceiver(queue, 20*time.Millisecond)

	a := 1
	queue <- &a
	recv() // packet
	recv() // ends the drain at once

	start := time.Now()
	if got := recv(); got != nil {
		t.Fatalf("recv() = %v, want nil", got)
	}
	if elapsed := time.Since(start); elapsed < 20*time.Millisecond {
		t.Fatalf("next frame's read returned after %v, want the idle wait", elapsed)
	}
}

func TestPacketReceiverReturnsPacketArrivingDuringWait(t *testing.T) {
	queue := make(chan *int, 4)
	recv := newPacketReceiver(queue, time.Second)

	a := 1
	go func() {
		time.Sleep(10 * time.Millisecond)
		queue <- &a
	}()
	start := time.Now()
	if got := recv(); got != &a {
		t.Fatalf("recv() = %v, want the packet sent during the wait", got)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("read took %v, want it to return when the packet arrived", elapsed)
	}
}
