package main

import "time"

// recvIdleWait is how long a read waits for a packet when the engine starts
// reading and nothing is queued. goxash3d-fwgs notes that "i386 requires
// 10ms timeout": the wait is what paces the engine's loop while it is idle.
const recvIdleWait = 10 * time.Millisecond

// newPacketReceiver returns the engine's recvfrom callback. The engine keeps
// calling recvfrom until it gets no packet, so a timed wait on every empty
// read would add recvIdleWait to the end of every drain, and steady traffic
// could keep the drain from ending at all. Instead, the read that ends a
// drain (one right after a packet) returns at once, and only a read that
// starts with an empty queue waits. Callbacks run on the engine thread, one
// at a time.
func newPacketReceiver[T any](queue <-chan *T, idleWait time.Duration) func() *T {
	timer := time.NewTimer(idleWait)
	timer.Stop()
	draining := false

	return func() *T {
		select {
		case packet := <-queue:
			draining = true
			return packet
		default:
		}
		if draining {
			draining = false
			return nil
		}

		timer.Reset(idleWait)
		defer timer.Stop()
		select {
		case packet := <-queue:
			draining = true
			return packet
		case <-timer.C:
			return nil
		}
	}
}
