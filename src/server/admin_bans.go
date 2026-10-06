package main

import (
	"context"
	"fmt"
	"math"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// The ban actions of the admin API (the ban list itself is in bans.go):
//
//	{"action":"bans"}                      -> {"output", "bans": [...]}
//	{"action":"ban","userid":U,"slot":S}   kicks the player and bans their address
//	{"action":"unban","address":"..."}     lifts a ban
//
// Banning needs the player's real address, which only Go knows (peerSlot.key),
// while the page only knows the player's slot and userid (the scores HUD
// event). The engine's `status` lists each client by slot with the fake
// address sfu.go gave it, so: run `status`, take the row of the slot, map
// its fake address to the peer and its real address, ban that, then
// `kick #<userid>`. The kick only works if that userid is still on the
// server, and a userid keeps its slot while connected, so the row was that
// player's; if the kick fails the ban is taken back. Finally every
// connection from the banned address is closed (other tabs, a second player
// behind the same address).

// peerDirectory maps the engine's fake player addresses to real ones
// (gamePeers in sfu.go).
type peerDirectory interface {
	// keyOf returns the addressKey of the player the engine knows by ip.
	keyOf(ip [4]byte) (string, bool)
	// closeFrom ends every connection from key and returns how many.
	closeFrom(key string) int
}

// actionRunner runs an action that needs more than fixed commands. client
// is the addressKey of the admin who sent it.
type actionRunner func(ctx context.Context, a *adminAPI, client string) (actionResult, error)

type actionResult struct {
	Output string     `json:"output"`
	Bans   []banEntry `json:"bans"`
	// NextMap is amx_nextmap, for the nextmap action (admin_maps.go).
	NextMap string `json:"nextMap,omitempty"`
}

// actionError is a refusal with its HTTP status. Any other error from a
// runner means the engine didn't answer (504).
type actionError struct {
	status  int
	message string
}

func (e *actionError) Error() string { return e.message }

func refuse(status int, format string, args ...any) error {
	return &actionError{status: status, message: fmt.Sprintf(format, args...)}
}

// maxSlot is the highest player slot (entity index) a ban accepts.
const maxSlot = 64

// clientNotOnServer is what kick prints when the userid isn't connected
// (FWGS SV_Kick_f).
const clientNotOnServer = "Client is not on the server"

var banActions = map[string]actionSpec{
	"bans": {prepare: func(actionFields, actionEnv) (actionRunner, error) {
		return func(_ context.Context, a *adminAPI, _ string) (actionResult, error) {
			return actionResult{Bans: a.env.bans.list()}, nil
		}, nil
	}},
	"ban": {fields: []string{"userid", "slot"}, prepare: func(f actionFields, _ actionEnv) (actionRunner, error) {
		userid, err := f.integer("userid", 1, math.MaxInt32)
		if err != nil {
			return nil, err
		}
		slot, err := f.integer("slot", 1, maxSlot)
		if err != nil {
			return nil, err
		}
		return func(ctx context.Context, a *adminAPI, client string) (actionResult, error) {
			return a.ban(ctx, client, userid, slot)
		}, nil
	}},
	"unban": {fields: []string{"address"}, prepare: func(f actionFields, _ actionEnv) (actionRunner, error) {
		raw, err := f.string("address")
		if err != nil {
			return nil, err
		}
		key, ok := normalizeBanAddress(raw)
		if !ok {
			return nil, fmt.Errorf("address: not an IPv4 address or IPv6 /64")
		}
		return func(_ context.Context, a *adminAPI, client string) (actionResult, error) {
			removed, err := a.env.bans.remove(key)
			if err != nil {
				a.logf("%s: unban %s: %v", client, key, err)
				return actionResult{}, refuse(http.StatusInternalServerError, "couldn't save the ban list: %v", err)
			}
			out := key + " wasn't banned\n"
			if removed {
				a.logf("%s: unbanned %s", client, key)
				out = "Unbanned " + key + "\n"
			}
			return actionResult{Output: out, Bans: a.env.bans.list()}, nil
		}, nil
	}},
}

func (a *adminAPI) ban(ctx context.Context, client string, userid, slot int) (actionResult, error) {
	if a.env.bans == nil || a.env.peers == nil {
		return actionResult{}, refuse(http.StatusServiceUnavailable, "bans aren't available")
	}
	status, err := a.console.Run(ctx, "status")
	if err != nil {
		return actionResult{}, err
	}
	row, ok := parseStatus(status)[slot-1]
	switch {
	case !ok:
		return actionResult{}, refuse(http.StatusConflict, "there's no player in that slot any more")
	case row.bot:
		return actionResult{}, refuse(http.StatusBadRequest, "bots can't be banned")
	}
	ip := net.ParseIP(row.address).To4()
	if ip == nil {
		return actionResult{}, refuse(http.StatusConflict, "%s isn't connected yet; try again", row.name)
	}
	key, ok := a.env.peers.keyOf([4]byte(ip))
	if !ok {
		return actionResult{}, refuse(http.StatusConflict, "%s has no connection on this server", row.name)
	}
	if key == client {
		return actionResult{}, refuse(http.StatusBadRequest,
			"%s has your own address (%s); banning it would ban you too", row.name, key)
	}

	// Ban first, so a reconnect between the kick and the ban can't get in.
	added, err := a.env.bans.add(banEntry{Address: key, Name: row.name, BannedAt: a.now().UTC()})
	if err != nil {
		a.logf("%s: ban %s: %v", client, key, err)
		return actionResult{}, refuse(http.StatusInternalServerError, "couldn't save the ban list: %v", err)
	}
	kick := "kick #" + strconv.Itoa(userid)
	if !safeCommandPattern.MatchString(kick) {
		return actionResult{}, refuse(http.StatusBadRequest, "refusing unsafe command %q", kick)
	}
	out, err := a.console.Run(ctx, kick)
	if err == nil && strings.Contains(out, clientNotOnServer) {
		err = refuse(http.StatusConflict, "%s left before the ban", row.name)
	}
	if err != nil {
		if added {
			if _, undo := a.env.bans.remove(key); undo != nil {
				a.logf("%s: taking back the ban on %s: %v", client, key, undo)
			}
		}
		return actionResult{Output: out}, err
	}
	closed := a.env.peers.closeFrom(key)
	a.logf("%s: banned %s (%s, userid %d); closed %d connection(s)", client, key, row.name, userid, closed)
	return actionResult{
		Output: out + fmt.Sprintf("Banned %s (%s)\n", key, row.name),
		Bans:   a.env.bans.list(),
	}, nil
}

// statusRow is one client in the output of the engine's `status`.
type statusRow struct {
	name    string
	address string
	bot     bool
}

// A client line of FWGS SV_Status_f:
//
//	"%2i %5i %4s %4s %.5f %5i %s (%s-%s %i)\t%8s\t%8s\n"
//
// slot index (0-based), frags, ping or state ("Bot", "Connect", ...), input
// devices, ..., then the name and the address after tabs. The name is
// padded to 8 characters on the left; the address is "a.b.c.d" (the fake
// address of a WebRTC player, 0.0.0.0 for a bot).
var statusRowPattern = regexp.MustCompile(`^ *([0-9]{1,3}) +-?[0-9]+ +(\S+) [^\t]*\t(.*)\t *(\S+) *$`)

// parseStatus returns the clients in status output by slot index.
func parseStatus(output string) map[int]statusRow {
	rows := map[int]statusRow{}
	for _, line := range strings.Split(output, "\n") {
		m := statusRowPattern.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m == nil {
			continue
		}
		index, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		rows[index] = statusRow{
			name:    strings.TrimLeft(m[3], " "),
			address: m[4],
			bot:     m[2] == "Bot",
		}
	}
	return rows
}
