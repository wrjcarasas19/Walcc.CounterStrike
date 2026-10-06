package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"

	goxash3d_fwgs "github.com/yohimik/goxash3d-fwgs/pkg"
)

// The admin API runs engine commands and reads what they print by talking
// rcon to the engine from inside the process. Go owns the engine's sockets
// (the recvfrom/sendto callbacks in sfu.go), so it can hand the engine an
// rcon packet from an address no player has (consoleAddr) and catch the
// replies the engine sends back to it:
//
//   - SV_ConnectionlessPacket -> SV_RemoteCommand checks the password, then
//     runs the command between SV_BeginRedirect and SV_EndRedirect. While
//     the redirect is on, every console print is collected (Rcon_Print) and
//     sent back as an out-of-band "print\n<text>" packet: one per finished
//     line, and one more at SV_EndRedirect with whatever is left (an empty
//     text, or a line without its newline). So a reply whose text doesn't
//     end in a newline is the last one for that command.
//   - The command is run exactly as browser rcon runs it (SV_RemoteCommand
//     quotes every word), so the command strings and their quirks (see
//     message-text.ts) are the same for both paths.
//   - Only output printed while the command runs comes back. Effects that
//     happen later (a bot joining, a message an alias puts in the command
//     buffer) still need the HUD to confirm them.
//
// The engine prints "Rcon from <addr>: <packet>" (password included) to its
// console for every rcon packet, as it does for browser rcon.

// consoleAddr is the fake address the admin API's rcon packets come from.
// Player addresses start with their slot index (0-127, see peerSlot), so
// this one never matches a player.
var consoleAddr = [4]byte{254, 0, 0, 1}

var errConsoleTimeout = errors.New("the engine didn't answer")

const (
	oobHeader   = "\xff\xff\xff\xff"
	printPrefix = oobHeader + "print\n"
)

var colorCodePattern = regexp.MustCompile(`\^[0-9]`)

// engineConsole runs one command at a time through in-process rcon.
type engineConsole struct {
	mu       sync.Mutex
	password string
	// send queues a packet for the engine (as if it came from consoleAddr).
	send    func(ctx context.Context, data []byte) error
	replies chan string
	// resync is set when a command didn't finish, so late replies may still
	// be on their way; the next command waits them out first.
	resync bool
	marker int
}

func newEngineConsole(password string, send func(ctx context.Context, data []byte) error) *engineConsole {
	return &engineConsole{password: password, send: send, replies: make(chan string, 256)}
}

// queueEnginePacket hands data to the engine as a packet from consoleAddr,
// through the same queue as the players' packets.
func queueEnginePacket(ctx context.Context, data []byte) error {
	return queuePacketFrom(ctx, consoleAddr, data)
}

// queuePacketFrom hands data to the engine as a packet from the fake
// address from (consoleAddr, queryAddr).
func queuePacketFrom(ctx context.Context, from [4]byte, data []byte) error {
	select {
	case packets <- &goxash3d_fwgs.Packet{IP: from, Data: data}:
		return nil
	case <-ctx.Done():
		return errConsoleTimeout
	}
}

// rconPacket is the packet `rcon <password> <command>` sends. The password
// is quoted so characters the tokenizer splits on (like ,) stay in it; it
// can't contain a quote (rconPasswordPattern).
func rconPacket(password, command string) []byte {
	return []byte(oobHeader + `rcon "` + password + `" ` + command + "\n")
}

// deliver takes a packet the engine sent to consoleAddr. It is called on
// the engine thread; data is only valid during the call.
func (c *engineConsole) deliver(data []byte) {
	if !bytes.HasPrefix(data, []byte(printPrefix)) {
		return
	}
	text := string(bytes.TrimRight(data[len(printPrefix):], "\x00"))
	select {
	case c.replies <- text:
	default:
		// Nobody is reading (a command timed out); resync drops the rest.
	}
}

// Run executes command on the engine and returns what it printed, with
// colour codes removed. On a timeout it returns what arrived so far.
func (c *engineConsole) Run(ctx context.Context, command string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.resync {
		if err := c.sync(ctx); err != nil {
			return "", err
		}
		c.resync = false
	}
	out, err := c.exec(ctx, command)
	if err != nil {
		c.resync = true
	}
	return colorCodePattern.ReplaceAllString(out, ""), err
}

// exec sends one rcon packet and collects its replies up to the last one.
func (c *engineConsole) exec(ctx context.Context, command string) (string, error) {
	if err := c.send(ctx, rconPacket(c.password, command)); err != nil {
		return "", err
	}
	var out strings.Builder
	for {
		select {
		case text := <-c.replies:
			out.WriteString(text)
			if !strings.HasSuffix(text, "\n") {
				return out.String(), nil
			}
		case <-ctx.Done():
			return out.String(), errConsoleTimeout
		}
	}
}

// sync drops replies left over from a command that timed out: it echoes a
// new marker and throws everything away until the marker comes back.
func (c *engineConsole) sync(ctx context.Context) error {
	c.marker++
	marker := fmt.Sprintf("web_admin_sync_%d", c.marker)
	if err := c.send(ctx, rconPacket(c.password, "echo "+marker)); err != nil {
		return err
	}
	seen := false
	for {
		select {
		case text := <-c.replies:
			if strings.Contains(text, marker) {
				seen = true
			}
			if seen && !strings.HasSuffix(text, "\n") {
				return nil
			}
		case <-ctx.Done():
			return errConsoleTimeout
		}
	}
}

// isRconPacket reports whether a player's packet is an rcon request, the
// way SV_ConnectionlessPacket would read it: the -1 header, then the first
// word of the line (leading whitespace and a quote skipped). Case is
// ignored to stay on the safe side. The server never reassembles split
// packets (NET_GetLong is client side only), so a request can't be spread
// over several packets.
func isRconPacket(data []byte) bool {
	if !bytes.HasPrefix(data, []byte(oobHeader)) {
		return false
	}
	line := data[len(oobHeader):]
	if i := bytes.IndexAny(line, "\n\x00"); i >= 0 {
		line = line[:i]
	}
	for len(line) > 0 && line[0] <= ' ' {
		line = line[1:]
	}
	line = bytes.TrimPrefix(line, []byte(`"`))
	return len(line) >= 4 && strings.EqualFold(string(line[:4]), "rcon")
}
