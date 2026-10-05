package main

import "testing"

func TestDropCommand(t *testing.T) {
	got := dropCommand([4]byte{3, 200, 17, 9})
	want := "addip 0.1 3.200.17.9; removeip 3.200.17.9\n"
	if got != want {
		t.Fatalf("dropCommand() = %q, want %q", got, want)
	}
}

func TestRequestDropQueuesUntilRun(t *testing.T) {
	ip := [4]byte{1, 2, 3, 4}
	requestDrop(ip)
	select {
	case got := <-dropRequests:
		if got != ip {
			t.Fatalf("queued %v, want %v", got, ip)
		}
	default:
		t.Fatal("requestDrop did not queue the address")
	}
}
