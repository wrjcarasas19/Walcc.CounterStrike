package main

/*
#include <stdlib.h>

// Exported by libxash.a, which goxash3d-fwgs links.
void Cbuf_AddText(const char *text);
*/
import "C"

import (
	"fmt"
	"net"
	"unsafe"
)

// A player whose WebRTC session ends (tab closed, network gone) sends the
// engine nothing more, so without help the engine keeps them in the game
// until sv_timeout (65 s). When a session ends, the engine is told to drop
// the player's address right away.
//
// The engine has no kick-by-address command, but addip drops every client
// matching the address; removeip then deletes the filter again (expired
// filters are never freed). Fake addresses are random per session, so no
// other player matches.
var dropRequests = make(chan [4]byte, 128)

// requestDrop queues ip to be dropped on the engine thread. It may be called
// from any goroutine.
func requestDrop(ip [4]byte) {
	select {
	case dropRequests <- ip:
	default:
		log.Warnf("Drop queue full: %v stays until sv_timeout", net.IP(ip[:]))
	}
}

// runDrops hands the queued drops to the engine's command buffer, which runs
// them at the start of the next frame. Cbuf_AddText is not thread-safe, so
// this must be called on the engine thread (from the recvfrom callback).
func runDrops() {
	for {
		select {
		case ip := <-dropRequests:
			addCommand(dropCommand(ip))
		default:
			return
		}
	}
}

func dropCommand(ip [4]byte) string {
	addr := net.IP(ip[:]).String()
	return fmt.Sprintf("addip 0.1 %s; removeip %s\n", addr, addr)
}

func addCommand(text string) {
	cText := C.CString(text)
	defer C.free(unsafe.Pointer(cText))
	C.Cbuf_AddText(cText)
}
