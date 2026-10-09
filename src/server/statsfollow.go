package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// The leaderboard follows the game's log files (statslog.go) and adds what
// happened to the totals in statsDB.
//
// What counts, per player name (the same rules as the page's session stats
// in src/client/src/stats.ts):
//   - kill: an enemy killed (both on T / CT, different teams). The victim
//     gets a death.
//   - teamkill: the victim gets a death, the killer a teamkill (not a kill).
//   - suicide (fall, own grenade, bomb, "kill" command): a death.
//   - headshot: a kill whose wc_statslog.amxx line says headshot.
//   - round: on T or CT when a round that had started ends.
//   - Gun Game win: wc_gamemode.amxx's wc_gg_win line. Kills in Gun Game
//     and Deathmatch count like any other (no separate per-mode totals);
//     those modes have no Round_End, so they add no rounds.
//   - duel: each kill also adds 1 to the (killer, victim) pair, when both
//     names count (head-to-head for GET /duel). Only enemy kills, like the
//     kills column. Pairs are by name: after a rename, a new pair starts.
// Bots (auth BOT) get no row unless includeBots is set, but a human's kill of
// a bot is still a kill and a death by a bot is still a death (with no duel
// pair: the bot's side would have no name to look up).
//
// Devices (claimed names, names.go): the "connected, address" line gives
// the SFU's made-up address of a player; while that player is still on the
// SFU (peerDevices, the address's random bytes tell a reused slot apart),
// the device token hash their WebSocket brought is kept by userid until
// they disconnect. Checked in the image: on a map change every player and
// bot connects again in the new file with a new userid, so this is kept
// per file like the teams. Lines replayed after a restart of the server
// are from players who are gone and get no device.
//
// Claimed names (E.4): the claims are read once per scan. A player whose
// name's key (nameKey) is claimed counts only if their device owns that
// claim (statsDB.ownsClaim, cached per scan); their kills, deaths, rounds,
// duels and Gun Game wins then go to the row named exactly as claimed
// (claims.name), whatever case, colour codes or "(1)" they play under.
// Anyone else under a claimed name (no cookie, another device, a bot, a
// player gone before the line was read) counts for nothing: not the
// claimed row, not a row of their own. Rows of other spellings of a
// claimed name ("walter" next to "Walter") are frozen.
//
// When a line shows such a player (entering the game, a kill, a team, a
// name change...), the follower renames them through the engine console
// (renameCommand) and tells them why in a chat line a little later
// (sendNotices); once per userid until a line shows them under a free name
// again, at most guestRenameMax times per file. Only for files this process is writing (modified since the
// follower started): the tail of an older file is from an engine that is
// gone, and its userids mean nobody now. Checked in the image: the game
// writes no "changed name to" line on this engine, for amx_nick or a
// player's own `name` command (Xash3D sets the new name before the game
// DLL sees the change, so ReGameDLL finds nothing changed: no log line,
// none of its name rules, no waiting for respawn); wc_statslog.amxx writes
// it instead. Without that plugin the next line about the player (a team,
// a kill...) still shows the claimed name and triggers the rename.
//
// Files: the engine writes cstrike/logs/LMMDDNNN.log, a new file on every
// map load, a whole line per write(). Each file is read up to its last
// complete line; the offset is stored with the totals in one transaction,
// keyed by the file name plus a hash of its first line ("Log file started"
// with the time), so a new container's L1006000.log isn't taken for the old
// one. Who is on which team is kept in memory per file; after a restart the
// current file is read again from the start up to the stored offset, without
// counting, to get it back. Only the newest keep files are kept; older ones
// are deleted once fully read (logs also hold the rcon password: the engine
// logs every rcon command, except the ones Go's own console sends).

const (
	statsScanInterval = 2 * time.Second
	// statsKeepLogFiles is how many log files (one per map, the newest
	// included) are kept; older ones are deleted once fully read.
	statsKeepLogFiles = 20
	// logReadChunk bytes are read and committed at a time.
	logReadChunk = 256 << 10
	// logFirstLineMax is how much of the first line is hashed; the engine's
	// "Log file started ..." line is about 100 bytes.
	logFirstLineMax = 1024
	// statsNameMax bytes: longer names (the engine allows 31) are ignored.
	statsNameMax = 64
	// guestRenameMax renames per userid and file: a client that keeps
	// setting the claimed name back isn't renamed forever (its stats are
	// still dropped).
	guestRenameMax = 3
	// guestRenameTimeout is how long one console command may take.
	guestRenameTimeout = 2 * time.Second
	// guestMessageDelay: the chat line follows the rename this much later
	// (on a later scan), or comes this long after the player joins a team
	// if they were renamed before. Checked in the image: the engine logs
	// "entered the game" while the page still shows the loading screen,
	// and the page clears its chat when the game shows (seen 23 s later
	// in headless Chromium), so a line sent then is never seen.
	guestMessageDelay = 3 * time.Second
	// guestSuffix is added to a claimed name for whoever isn't its owner.
	guestSuffix = " (guest)"
	// guestMessage is the chat line the renamed player gets (an admin
	// message: printable ASCII without " ; \ $ { } ' , ^ % or //).
	guestMessage = "That name is claimed. Sign in from Settings to use it."
)

var logFileNameRe = regexp.MustCompile(`^L[0-9]{7}\.log$`)

// peerDevices finds the device of a connected player (gamePeers in sfu.go).
type peerDevices interface {
	// deviceOf returns the device token hash ("" for none) of the player
	// the engine knows by ip; ok is false if ip isn't a connected player's.
	deviceOf(ip [4]byte) (hash string, ok bool)
}

// claimOwners says whether a device owns the claim on a key
// (statsDB.ownsClaim).
type claimOwners interface {
	ownsClaim(ctx context.Context, tokenHash, key string) (bool, error)
}

// guestRename is a player to rename away from a claimed name.
type guestRename struct {
	UserID int
	Name   string // the claimed name they used
}

// guestNotice is a chat line to send a renamed player.
type guestNotice struct {
	userid int
	file   string // logFollower.current when they were renamed
	due    time.Time
	// noTeam: renamed before joining a team, so most likely still on the
	// loading screen; the line waits for a team.
	noTeam bool
}

// statsTally turns log events into changes to the totals.
type statsTally struct {
	includeBots bool
	peers       peerDevices // nil: nobody has a device
	// logf, if set, notes the devices found (counted lines only).
	logf    func(format string, args ...any)
	present map[int]logPlayer // by userid: players seen in this file, not gone
	devices map[int]string    // by userid: device token hash, players with one
	inRound bool
	deltas  map[string]playerTotals
	duels   map[duelPair]int64

	// Claimed names, set for each scan by setClaims: claims maps a key to
	// the claimed spelling (nil: none), owners is asked once per device
	// and key and the answer kept in owned until the next setClaims. The
	// first error is kept in err; the caller must not commit after one.
	claims map[string]string
	owners claimOwners
	ctx    context.Context
	owned  map[[2]string]bool
	err    error
	// live: the file is being written by this engine, so its players can
	// be renamed. renames are the renames asked for since takeRenames;
	// renamed counts them per userid in this file; pending is set from a
	// rename until a line shows the player under a free name.
	live    bool
	renames []guestRename
	renamed map[int]int
	pending map[int]bool
}

func newStatsTally(includeBots bool) *statsTally {
	t := &statsTally{includeBots: includeBots}
	t.reset()
	return t
}

// reset forgets who is playing (new file, server shutdown) and any changes
// not taken yet.
func (t *statsTally) reset() {
	t.present = map[int]logPlayer{}
	t.devices = map[int]string{}
	t.renamed = map[int]int{}
	t.pending = map[int]bool{}
	t.renames = nil
	t.inRound = false
	t.deltas = map[string]playerTotals{}
	t.duels = map[duelPair]int64{}
}

// take returns the changes to the totals and to the duels since the last
// take.
func (t *statsTally) take() (map[string]playerTotals, map[duelPair]int64) {
	d, duels := t.deltas, t.duels
	t.deltas = map[string]playerTotals{}
	t.duels = map[duelPair]int64{}
	return d, duels
}

// setClaims gives the tally this scan's claims (key → claimed name) and
// forgets which devices owned what.
func (t *statsTally) setClaims(ctx context.Context, claims map[string]string, owners claimOwners) {
	t.ctx, t.claims, t.owners = ctx, claims, owners
	t.owned = map[[2]string]bool{}
	t.err = nil
}

// takeRenames returns the renames asked for since the last take.
func (t *statsTally) takeRenames() []guestRename {
	r := t.renames
	t.renames = nil
	return r
}

// owns says whether p is playing from a device that owns the claim on key.
// Bots never do.
func (t *statsTally) owns(p logPlayer, key string) bool {
	if p.bot() || t.owners == nil {
		return false
	}
	hash, ok := t.device(p.UserID)
	if !ok {
		return false
	}
	k := [2]string{hash, key}
	if owns, ok := t.owned[k]; ok {
		return owns
	}
	owns, err := t.owners.ownsClaim(t.ctx, hash, key)
	if err != nil {
		if t.err == nil {
			t.err = err
		}
		return false // not cached: the scan is given up anyway
	}
	t.owned[k] = owns
	return owns
}

// rowName is the leaderboard row p's events go to; ok is false if they
// don't count at all.
func (t *statsTally) rowName(p logPlayer) (string, bool) {
	if p.Name == "" || len(p.Name) > statsNameMax || (!t.includeBots && p.bot()) {
		return "", false
	}
	key := nameKey(p.Name)
	claimed, ok := t.claims[key]
	if !ok {
		return p.Name, true
	}
	if !t.owns(p, key) {
		return "", false
	}
	return claimed, true
}

// enforce asks for p (as a line just showed them) to be renamed if p.Name
// is claimed and p doesn't own it, unless a rename is pending already.
func (t *statsTally) enforce(p logPlayer) {
	if !t.live || p.UserID <= 0 || p.Name == "" {
		return
	}
	key := nameKey(p.Name)
	if _, ok := t.claims[key]; !ok {
		delete(t.pending, p.UserID) // renamed, or a free name of their own
		return
	}
	if t.pending[p.UserID] || t.renamed[p.UserID] >= guestRenameMax || t.owns(p, key) {
		return
	}
	t.pending[p.UserID] = true
	t.renamed[p.UserID]++
	t.renames = append(t.renames, guestRename{UserID: p.UserID, Name: p.Name})
}

// retryRename says whether p, last seen under p.Name, should be renamed
// again: the name is still claimed (and not p's) and the renames left
// allow it. It counts the rename.
func (t *statsTally) retryRename(p logPlayer) bool {
	key := nameKey(p.Name)
	if _, ok := t.claims[key]; !ok || t.renamed[p.UserID] >= guestRenameMax || t.owns(p, key) {
		return false
	}
	t.renamed[p.UserID]++
	return true
}

// device returns the device token hash the player with userid connected
// with in this file, if any. It says nothing about which name, if any, the
// device owns (statsDB.ownsClaim).
func (t *statsTally) device(userid int) (string, bool) {
	hash, ok := t.devices[userid]
	return hash, ok
}

// connected notes the device of a player's connection.
func (t *statsTally) connected(p logPlayer, address string, count bool) {
	delete(t.devices, p.UserID)
	ip, ok := logAddressIP(address)
	if !ok || t.peers == nil || p.UserID <= 0 {
		return
	}
	hash, ok := t.peers.deviceOf(ip)
	if !ok || hash == "" {
		return
	}
	t.devices[p.UserID] = hash
	if count && t.logf != nil {
		t.logf("#%d %q connected with device %.8s", p.UserID, p.Name, hash)
	}
}

func (t *statsTally) add(p logPlayer, change func(*playerTotals)) {
	name, ok := t.rowName(p)
	if !ok {
		return
	}
	d := t.deltas[name]
	change(&d)
	t.deltas[name] = d
}

func (t *statsTally) seen(p logPlayer) {
	if p.UserID > 0 {
		t.present[p.UserID] = p
	}
}

// apply updates who is playing; with count it also adds to the totals.
func (t *statsTally) apply(ev logEvent, count bool) {
	switch ev.Kind {
	case logKill, logHeadshot:
		t.seen(ev.Player)
		t.seen(ev.Victim)
	case logSuicide, logEntered, logPlayerOther, logGunGameWin:
		t.seen(ev.Player)
	case logJoinedTeam:
		p := ev.Player
		p.Team = ev.Value
		t.seen(p)
	case logChangedName:
		p := ev.Player
		p.Name = ev.Value
		t.seen(p)
	case logConnected:
		t.connected(ev.Player, ev.Value, count)
	case logDisconnected:
		delete(t.present, ev.Player.UserID)
		delete(t.devices, ev.Player.UserID)
		delete(t.pending, ev.Player.UserID)
	case logRoundStart:
		t.inRound = true
	case logRoundEnd:
		if t.inRound && count {
			for _, p := range t.present {
				if p.playing() {
					t.add(p, func(d *playerTotals) { d.Rounds++ })
				}
			}
		}
		t.inRound = false
	case logShutdown:
		deltas, duels := t.deltas, t.duels
		t.reset()
		t.deltas, t.duels = deltas, duels
	}
	if !count {
		return
	}
	switch ev.Kind {
	case logKill, logHeadshot:
		t.enforce(ev.Player)
		t.enforce(ev.Victim)
	case logSuicide, logEntered, logPlayerOther, logGunGameWin, logJoinedTeam:
		t.enforce(ev.Player)
	case logChangedName:
		p := ev.Player
		p.Name = ev.Value
		t.enforce(p)
	}

	killer, victim := ev.Player, ev.Victim
	enemies := killer.playing() && victim.playing() && killer.Team != victim.Team
	switch ev.Kind {
	case logKill:
		switch {
		case killer.UserID == victim.UserID:
			t.add(victim, func(d *playerTotals) { d.Deaths++; d.Suicides++ })
		case enemies:
			t.add(killer, func(d *playerTotals) { d.Kills++ })
			t.add(victim, func(d *playerTotals) { d.Deaths++ })
			k, kok := t.rowName(killer)
			v, vok := t.rowName(victim)
			if kok && vok && k != v {
				t.duels[duelPair{Killer: k, Victim: v}]++
			}
		default:
			if killer.playing() && killer.Team == victim.Team {
				t.add(killer, func(d *playerTotals) { d.TeamKills++ })
			}
			t.add(victim, func(d *playerTotals) { d.Deaths++ })
		}
	case logHeadshot:
		if enemies && killer.UserID != victim.UserID {
			t.add(killer, func(d *playerTotals) { d.Headshots++ })
		}
	case logSuicide:
		t.add(killer, func(d *playerTotals) { d.Deaths++; d.Suicides++ })
	case logGunGameWin:
		t.add(ev.Player, func(d *playerTotals) { d.GunGameWins++ })
	}
}

// logFollower reads new log lines into the database.
type logFollower struct {
	dir   string
	db    *statsDB
	tally *statsTally
	keep  int
	now   func() time.Time
	logf  func(format string, args ...any)
	// console renames players under a claimed name they don't own (nil:
	// they aren't renamed, their stats are still dropped).
	console consoleRunner
	// started: files modified before this are from an engine that is gone.
	started time.Time

	// current is the file (name + fingerprint) whose state tally holds.
	current string
	// consoleErr is the last rename error logged (logged once until one
	// works again).
	consoleErr string
	// notices are the chat lines to send renamed players.
	notices []guestNotice
}

func newLogFollower(dir string, db *statsDB, includeBots bool, peers peerDevices, console consoleRunner) *logFollower {
	f := &logFollower{
		dir:     dir,
		db:      db,
		tally:   newStatsTally(includeBots),
		keep:    statsKeepLogFiles,
		now:     time.Now,
		console: console,
		started: time.Now(),
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "leaderboard: "+format+"\n", args...)
		},
	}
	f.tally.peers = peers
	f.tally.logf = func(format string, args ...any) { f.logf(format, args...) }
	return f
}

// run scans every interval until ctx ends. Errors are logged once until
// a scan works again.
func (f *logFollower) run(ctx context.Context, interval time.Duration) {
	var lastErr string
	for {
		err := f.scan(ctx)
		switch {
		case err != nil && err.Error() != lastErr:
			f.logf("%v", err)
			lastErr = err.Error()
		case err == nil:
			lastErr = ""
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

type logFileInfo struct {
	name string
	size int64
	mod  time.Time
}

// scan reads whatever was added to the log files since the last scan.
func (f *logFollower) scan(ctx context.Context) error {
	entries, err := os.ReadDir(f.dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil // nothing logged yet
	}
	if err != nil {
		return err
	}
	var files []logFileInfo
	for _, e := range entries {
		if !logFileNameRe.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		files = append(files, logFileInfo{name: e.Name(), size: info.Size(), mod: info.ModTime()})
	}
	// Oldest first. Names alone don't sort across a new year or a new
	// container.
	sort.Slice(files, func(i, j int) bool {
		if !files[i].mod.Equal(files[j].mod) {
			return files[i].mod.Before(files[j].mod)
		}
		return files[i].name < files[j].name
	})

	records, err := f.db.logFiles(ctx)
	if err != nil {
		return err
	}
	claims, err := f.db.claimedNames(ctx)
	if err != nil {
		return err
	}
	f.tally.setClaims(ctx, claims, f.db)
	done := map[string]bool{}
	for i, file := range files {
		finished, err := f.follow(ctx, file, records, i == len(files)-1)
		if err != nil {
			return fmt.Errorf("%s: %w", file.name, err)
		}
		done[file.name] = finished
	}
	f.sendNotices(ctx)

	// Forget files that are gone; delete old ones that were fully read.
	inDir := map[string]bool{}
	for _, file := range files {
		inDir[file.name] = true
	}
	for name := range records {
		if !inDir[name] {
			if err := f.db.forgetLogFile(ctx, name); err != nil {
				return err
			}
		}
	}
	for i := 0; i < len(files)-f.keep; i++ {
		name := files[i].name
		if !done[name] {
			continue
		}
		if err := os.Remove(filepath.Join(f.dir, name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := f.db.forgetLogFile(ctx, name); err != nil {
			return err
		}
	}
	return nil
}

// follow reads one file from its stored offset. finished is true when it
// was read to the end (possibly to be continued if the engine writes more).
//
// The engine only writes to the newest file, so an older one without a
// complete first line (the file "log on" opens before the first map, when
// nothing is logged yet, stays empty) is finished as it is.
func (f *logFollower) follow(ctx context.Context, file logFileInfo, records map[string]logFileRecord, newest bool) (finished bool, err error) {
	fh, err := os.Open(filepath.Join(f.dir, file.name))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer fh.Close()
	info, err := fh.Stat()
	if err != nil {
		return false, err
	}
	size := info.Size()

	head := make([]byte, logFirstLineMax)
	n, err := fh.ReadAt(head, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	end := bytes.IndexByte(head[:n], '\n')
	if end < 0 {
		if n < logFirstLineMax {
			return !newest, nil // first line not written yet
		}
		end = n
	}
	sum := sha256.Sum256(head[:end])
	fingerprint := hex.EncodeToString(sum[:])

	rec, ok := records[file.name]
	if !ok || rec.Fingerprint != fingerprint {
		rec = logFileRecord{Fingerprint: fingerprint}
	}
	if size < rec.Offset {
		// Same first line but shorter: rewritten. Start over.
		f.logf("%s got shorter (%d < %d bytes read); reading it again", file.name, size, rec.Offset)
		rec.Offset = 0
	}
	if size == rec.Offset {
		return true, nil
	}

	key := file.name + "\x00" + fingerprint
	if f.current != key {
		f.tally.reset()
		f.current = ""
		if err := f.replay(fh, rec.Offset); err != nil {
			return false, err
		}
		f.current = key
	}
	f.tally.live = !file.mod.Before(f.started)

	buf := make([]byte, logReadChunk)
	for rec.Offset < size {
		n, err := fh.ReadAt(buf, rec.Offset)
		if err != nil && !errors.Is(err, io.EOF) {
			return false, err
		}
		chunk := buf[:n]
		cut := bytes.LastIndexByte(chunk, '\n') + 1
		if cut == 0 {
			if n < logReadChunk {
				return false, nil // the rest of the line isn't written yet
			}
			cut = n // no line is this long; skip it
		}
		for _, line := range bytes.Split(chunk[:cut], []byte{'\n'}) {
			if ev, ok := parseLogLine(string(line)); ok {
				f.tally.apply(ev, true)
			}
		}
		next := logFileRecord{Fingerprint: fingerprint, Offset: rec.Offset + int64(cut)}
		deltas, duels := f.tally.take()
		renames := f.tally.takeRenames()
		err = f.tally.err
		if err == nil {
			err = f.db.commit(ctx, file.name, next, deltas, duels, f.now())
		}
		if err != nil {
			// The in-memory state already saw these lines: rebuild it from
			// the stored offset next time.
			f.current = ""
			return false, err
		}
		rec = next
		records[file.name] = rec
		f.rename(ctx, renames)
	}
	return true, nil
}

// rename renames each player under a claimed name they don't own; the
// chat line telling them why follows guestMessageDelay later (sendNotices).
func (f *logFollower) rename(ctx context.Context, renames []guestRename) {
	if f.console == nil {
		return
	}
	for _, r := range renames {
		name := guestName(r.Name, r.UserID, f.tally.claims)
		f.logf("#%d %q is a claimed name: renaming to %q", r.UserID, r.Name, name)
		if f.runCommands(ctx, r.UserID, []string{renameCommand(r.UserID, name)}) {
			f.notices = append(f.notices, guestNotice{
				userid: r.UserID,
				file:   f.current,
				due:    f.now().Add(guestMessageDelay),
				noTeam: f.tally.present[r.UserID].Team == "",
			})
		}
	}
}

// sendNotices sends the chat lines that are due, to players still in the
// file they were renamed in (a player renamed before joining a team gets
// it guestMessageDelay after joining one). If the last line about the
// player still has the claimed name, the rename didn't take and is sent
// again first, within guestRenameMax (wc_statslog.amxx logs a rename that
// worked). Seen in the image: Xash3D ignores a userinfo change that comes
// too soon after the player's own (sv_userinfo_penalty_*), but keeps the
// new name in the userinfo, so the same amx_nick again would change
// nothing; the retry uses "Player <userid>".
func (f *logFollower) sendNotices(ctx context.Context) {
	now := f.now()
	kept := f.notices[:0]
	for _, n := range f.notices {
		p, present := f.tally.present[n.userid]
		switch {
		case n.file != f.current || !present:
			// Gone, or the map changed (new userids): dropped.
		case n.noTeam && p.Team != "":
			// Joined a team: in the game now.
			n.noTeam = false
			n.due = now.Add(guestMessageDelay)
			kept = append(kept, n)
		case n.noTeam || now.Before(n.due):
			kept = append(kept, n)
		default:
			if f.tally.retryRename(p) {
				name := fallbackName(p.UserID)
				f.logf("#%d is still %q: renaming to %q again", p.UserID, p.Name, name)
				f.runCommands(ctx, p.UserID, []string{renameCommand(p.UserID, name)})
			}
			f.runCommands(ctx, n.userid, messageCommands(n.userid))
		}
	}
	f.notices = kept
}

// runCommands runs commands for userid on the console until one fails;
// errors are logged once until a command works again.
func (f *logFollower) runCommands(ctx context.Context, userid int, commands []string) bool {
	for _, command := range commands {
		cctx, cancel := context.WithTimeout(ctx, guestRenameTimeout)
		_, err := f.console.Run(cctx, command)
		cancel()
		if err != nil {
			if err.Error() != f.consoleErr {
				f.logf("renaming #%d: %v", userid, err)
				f.consoleErr = err.Error()
			}
			return false
		}
		f.consoleErr = ""
	}
	return true
}

// guestName is what a player under someone else's claimed name is renamed
// to: "<name> (guest)" in at most nameMaxBytes bytes (the name is cut on a
// character boundary), or "Player <userid>" if that can't be sent safely
// or is claimed itself. Neither can be claimed (reservedNameKey), so the
// rename can't trigger another one.
func guestName(name string, userid int, claims map[string]string) string {
	base := strings.ToValidUTF8(trimName(name), "")
	for len(base) > nameMaxBytes-len(guestSuffix) {
		_, size := utf8.DecodeLastRuneInString(base)
		base = base[:len(base)-size]
	}
	guest := strings.TrimRight(base, " \t\r\n") + guestSuffix
	if guestNameProblem(guest) {
		return fallbackName(userid)
	}
	if _, claimed := claims[nameKey(guest)]; claimed {
		return fallbackName(userid)
	}
	return guest
}

func fallbackName(userid int) string {
	return "Player " + strconv.Itoa(userid)
}

// guestNameProblem says whether name can't go into the rename command: the
// command is `amx_nick #<userid> "<name>"`, sent through rcon, so no " \ ;
// (end the word or the command), $ (cvar expansion), // (a comment), % (a
// format string in the chat lines naming the player), .. (the engine
// refuses the change) or control characters.
func guestNameProblem(name string) bool {
	return strings.ContainsAny(name, "\"\\;$%") ||
		strings.Contains(name, "//") || strings.Contains(name, "..") ||
		strings.ContainsRune(name, utf8.RuneError) ||
		strings.IndexFunc(name, func(r rune) bool { return unicode.Is(unicode.Cc, r) }) >= 0
}

// renameCommand renames userid to name with AMX Mod X's amx_nick. It is
// built here and not checked by safeCommandPattern (names can be any
// UTF-8): guestName keeps out what would break it.
func renameCommand(userid int, name string) string {
	return "amx_nick #" + strconv.Itoa(userid) + ` "` + name + `"`
}

// messageCommands send userid guestMessage with amx_psay, through the admin
// message alias (aliasCommands) so it shows without quotes.
func messageCommands(userid int) []string {
	return aliasCommands("amx_psay #" + strconv.Itoa(userid) + " " + guestMessage)
}

// replay reads [0, offset) of a file to rebuild who is playing, without
// counting anything.
func (f *logFollower) replay(fh *os.File, offset int64) error {
	if offset == 0 {
		return nil
	}
	data := make([]byte, offset)
	if _, err := fh.ReadAt(data, 0); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if ev, ok := parseLogLine(string(line)); ok {
			f.tally.apply(ev, false)
		}
	}
	f.tally.take()
	return nil
}
