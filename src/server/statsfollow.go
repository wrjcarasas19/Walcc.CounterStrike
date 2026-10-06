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
	"time"
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
// Bots (auth BOT) get no row unless includeBots is set, but a human's kill of
// a bot is still a kill and a death by a bot is still a death.
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
// logs every rcon command).

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
)

var logFileNameRe = regexp.MustCompile(`^L[0-9]{7}\.log$`)

// statsTally turns log events into changes to the totals.
type statsTally struct {
	includeBots bool
	present     map[int]logPlayer // by userid: players seen in this file, not gone
	inRound     bool
	deltas      map[string]playerTotals
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
	t.inRound = false
	t.deltas = map[string]playerTotals{}
}

// take returns the changes since the last take.
func (t *statsTally) take() map[string]playerTotals {
	d := t.deltas
	t.deltas = map[string]playerTotals{}
	return d
}

func (t *statsTally) counts(p logPlayer) bool {
	return p.Name != "" && len(p.Name) <= statsNameMax && (t.includeBots || !p.bot())
}

func (t *statsTally) add(p logPlayer, change func(*playerTotals)) {
	if !t.counts(p) {
		return
	}
	d := t.deltas[p.Name]
	change(&d)
	t.deltas[p.Name] = d
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
	case logSuicide, logEntered, logPlayerOther:
		t.seen(ev.Player)
	case logJoinedTeam:
		p := ev.Player
		p.Team = ev.Value
		t.seen(p)
	case logChangedName:
		p := ev.Player
		p.Name = ev.Value
		t.seen(p)
	case logDisconnected:
		delete(t.present, ev.Player.UserID)
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
		deltas := t.deltas
		t.reset()
		t.deltas = deltas
	}
	if !count {
		return
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

	// current is the file (name + fingerprint) whose state tally holds.
	current string
}

func newLogFollower(dir string, db *statsDB, includeBots bool) *logFollower {
	return &logFollower{
		dir:   dir,
		db:    db,
		tally: newStatsTally(includeBots),
		keep:  statsKeepLogFiles,
		now:   time.Now,
		logf: func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "leaderboard: "+format+"\n", args...)
		},
	}
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
	done := map[string]bool{}
	for i, file := range files {
		finished, err := f.follow(ctx, file, records, i == len(files)-1)
		if err != nil {
			return fmt.Errorf("%s: %w", file.name, err)
		}
		done[file.name] = finished
	}

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
		if err := f.db.commit(ctx, file.name, next, f.tally.take(), f.now()); err != nil {
			// The in-memory state already saw these lines: rebuild it from
			// the stored offset next time.
			f.current = ""
			return false, err
		}
		rec = next
		records[file.name] = rec
	}
	return true, nil
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
