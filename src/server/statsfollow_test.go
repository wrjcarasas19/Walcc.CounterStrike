package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// logLine puts the engine's date in front of body.
func logLine(body string) string {
	return "10/06/2026 - 15:33:31: " + body + "\n"
}

func tallyLines(t *testing.T, includeBots bool, bodies ...string) map[string]playerTotals {
	t.Helper()
	tally := newStatsTally(includeBots)
	for _, body := range bodies {
		ev, ok := parseLogLine(strings.TrimSuffix(logLine(body), "\n"))
		if !ok {
			t.Fatalf("line not parsed: %q", body)
		}
		tally.apply(ev, true)
	}
	return tally.take()
}

func TestStatsTallyKills(t *testing.T) {
	got := tallyLines(t, false,
		`"Walter<7><ID_1><CT>" triggered "wc_headshot" against "Gilroy<3><BOT><TERRORIST>" with "ak47"`,
		`"Walter<7><ID_1><CT>" killed "Gilroy<3><BOT><TERRORIST>" with "ak47"`,
		`"Walter<7><ID_1><CT>" killed "Ann<8><ID_2><TERRORIST>" with "ak47"`,
		`"Hextor<6><BOT><TERRORIST>" killed "Walter<7><ID_1><CT>" with "usp"`,
		// Teamkill: a death for the victim, no kill, and a headshot
		// line for it doesn't count either.
		`"Ann<8><ID_2><TERRORIST>" triggered "wc_headshot" against "Bob<9><ID_3><TERRORIST>" with "glock18"`,
		`"Ann<8><ID_2><TERRORIST>" killed "Bob<9><ID_3><TERRORIST>" with "glock18"`,
		`"Bob<9><ID_3><TERRORIST>" committed suicide with "worldspawn"`,
		`"Bob<9><ID_3><TERRORIST>" committed suicide with "hegrenade"`,
		// Killed by own grenade, written as a kill of oneself.
		`"Ann<8><ID_2><TERRORIST>" killed "Ann<8><ID_2><TERRORIST>" with "hegrenade"`,
		// Victim on no team (just switched): a death, no kill.
		`"Walter<7><ID_1><CT>" killed "Cy<10><ID_4><SPECTATOR>" with "awp"`,
	)
	want := map[string]playerTotals{
		"Walter": {Kills: 2, Deaths: 1, Headshots: 1},
		"Ann":    {Deaths: 2, TeamKills: 1, Suicides: 1},
		"Bob":    {Deaths: 3, Suicides: 2},
		"Cy":     {Deaths: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

func TestStatsTallyBots(t *testing.T) {
	lines := []string{
		`"Walter<7><ID_1><CT>" killed "Gilroy<3><BOT><TERRORIST>" with "ak47"`,
		`"Gilroy<3><ID_BOT><TERRORIST>" triggered "wc_headshot" against "Walter<7><ID_1><CT>" with "usp"`,
		`"Gilroy<3><BOT><TERRORIST>" killed "Walter<7><ID_1><CT>" with "usp"`,
	}
	if got, want := tallyLines(t, false, lines...), map[string]playerTotals{
		"Walter": {Kills: 1, Deaths: 1},
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("bots left out: got %+v, want %+v", got, want)
	}
	if got, want := tallyLines(t, true, lines...), map[string]playerTotals{
		"Walter": {Kills: 1, Deaths: 1},
		"Gilroy": {Kills: 1, Deaths: 1, Headshots: 1},
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("bots included: got %+v, want %+v", got, want)
	}
}

func TestStatsTallyRounds(t *testing.T) {
	got := tallyLines(t, false,
		`"Walter<7><ID_1><>" entered the game`,
		`"Walter<7><ID_1><>" joined team "CT"`,
		`"Ann<8><ID_2><>" entered the game`,
		`"Ann<8><ID_2><>" joined team "TERRORIST"`,
		`"Cy<10><ID_4><>" entered the game`, // never picks a team
		`"Gilroy<3><BOT><>" joined team "TERRORIST"`,
		// Game commencing: a round end without a start doesn't count.
		`World triggered "Round_End"`,
		`World triggered "Round_Start"`,
		`World triggered "Round_End"`, // 1
		`World triggered "Round_Start"`,
		`"Ann<8><ID_2><TERRORIST>" changed name to "Anna"`,
		`"Walter<7><ID_1><CT>" disconnected`,
		`World triggered "Round_End"`, // 2 (Walter left)
		`World triggered "Round_Start"`,
		`"Anna<8><ID_2><TERRORIST>" joined team "SPECTATOR"`,
		`World triggered "Round_End"`, // 3 (Anna watching)
		`World triggered "Round_Start"`,
		`"Anna<8><ID_2><SPECTATOR>" joined team "CT"`,
		`Server shutdown`,
		`World triggered "Round_End"`, // after a shutdown nobody is known
	)
	want := map[string]playerTotals{
		"Walter": {Rounds: 1},
		"Ann":    {Rounds: 1},
		"Anna":   {Rounds: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

// followerTest is a log folder and a database in a temp dir.
type followerTest struct {
	t   *testing.T
	dir string
	db  *statsDB
	f   *logFollower
	mod time.Time
	// mtimes of the files written, kept after appends so files sort in
	// the order they were created.
	mtimes map[string]time.Time
}

func newFollowerTest(t *testing.T) *followerTest {
	t.Helper()
	root := t.TempDir()
	ft := &followerTest{t: t, dir: filepath.Join(root, "logs"), mod: time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC), mtimes: map[string]time.Time{}}
	ft.open(filepath.Join(root, "data", leaderboardFile))
	return ft
}

// open (re)opens the database and makes a new follower, like a restart.
func (ft *followerTest) open(path string) {
	ft.t.Helper()
	if ft.db != nil {
		ft.db.Close()
	}
	db, err := openStatsDB(path)
	if err != nil {
		ft.t.Fatal(err)
	}
	ft.t.Cleanup(func() { db.Close() })
	ft.db = db
	ft.f = newLogFollower(ft.dir, db, false)
	ft.f.logf = func(format string, args ...any) { ft.t.Logf(format, args...) }
}

// write appends text to a log file; each new file gets a later mtime.
func (ft *followerTest) write(name, text string) {
	ft.t.Helper()
	if err := os.MkdirAll(ft.dir, 0o755); err != nil {
		ft.t.Fatal(err)
	}
	path := filepath.Join(ft.dir, name)
	fh, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		ft.t.Fatal(err)
	}
	if _, err := fh.WriteString(text); err != nil {
		ft.t.Fatal(err)
	}
	fh.Close()
	mtime, ok := ft.mtimes[name]
	if !ok {
		ft.mod = ft.mod.Add(time.Minute)
		mtime = ft.mod
		ft.mtimes[name] = mtime
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		ft.t.Fatal(err)
	}
}

func (ft *followerTest) scan() {
	ft.t.Helper()
	if err := ft.f.scan(context.Background()); err != nil {
		ft.t.Fatal(err)
	}
}

func (ft *followerTest) totals() map[string]playerTotals {
	ft.t.Helper()
	rows, err := ft.db.top(context.Background(), 100)
	if err != nil {
		ft.t.Fatal(err)
	}
	got := map[string]playerTotals{}
	for _, r := range rows {
		got[r.Name] = r.playerTotals
	}
	return got
}

func (ft *followerTest) expect(want map[string]playerTotals) {
	ft.t.Helper()
	if got := ft.totals(); !reflect.DeepEqual(got, want) {
		ft.t.Errorf("totals %+v\nwant %+v", got, want)
	}
}

func fileStart(name string) string {
	return logLine(fmt.Sprintf(`Log file started (file "logs/%s") (game "") (version "49/0.21/3772")`, name))
}

const (
	killWalterAnn = `"Walter<7><ID_1><CT>" killed "Ann<8><ID_2><TERRORIST>" with "ak47"`
	killAnnWalter = `"Ann<8><ID_2><TERRORIST>" killed "Walter<7><ID_1><CT>" with "glock18"`
)

func TestLogFollowerPartialLinesAndRestart(t *testing.T) {
	ft := newFollowerTest(t)
	ft.scan() // no folder yet
	ft.expect(map[string]playerTotals{})

	ft.write("L1006000.log", fileStart("L1006000.log")+
		logLine(`"Walter<7><ID_1><>" joined team "CT"`)+
		logLine(`"Ann<8><ID_2><>" joined team "TERRORIST"`)+
		logLine(`World triggered "Round_Start"`)+
		logLine(killWalterAnn))
	// Half a line: not read until it is complete.
	half := logLine(killAnnWalter)
	ft.write("L1006000.log", half[:30])
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}, "Ann": {Deaths: 1}})
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}, "Ann": {Deaths: 1}})
	ft.write("L1006000.log", half[30:])
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1, Deaths: 1}, "Ann": {Kills: 1, Deaths: 1}})

	// Restart: nothing counted twice, and the round still counts both
	// players (who is playing comes back from the start of the file).
	ft.open(filepath.Join(filepath.Dir(ft.dir), "data", leaderboardFile))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1, Deaths: 1}, "Ann": {Kills: 1, Deaths: 1}})
	ft.write("L1006000.log", logLine(`World triggered "Round_End"`))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1, Deaths: 1, Rounds: 1}, "Ann": {Kills: 1, Deaths: 1, Rounds: 1}})

	// Next map: a new file; who is playing starts empty there.
	ft.write("L1006001.log", fileStart("L1006001.log")+
		logLine(`World triggered "Round_Start"`)+
		logLine(killWalterAnn)+
		logLine(`World triggered "Round_End"`))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 2, Deaths: 1, Rounds: 2}, "Ann": {Kills: 1, Deaths: 2, Rounds: 2}})
}

func TestLogFollowerFirstLineNotWrittenYet(t *testing.T) {
	ft := newFollowerTest(t)
	ft.write("L1006000.log", "10/06/2026 - 15:3")
	ft.scan()
	recs, _ := ft.db.logFiles(context.Background())
	if len(recs) != 0 {
		t.Errorf("records %+v for a file without a first line", recs)
	}
	ft.write("L1006000.log", "3:31: Log file started\n"+logLine(killWalterAnn))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}, "Ann": {Deaths: 1}})
}

func TestLogFollowerEmptyOldFilePruned(t *testing.T) {
	ft := newFollowerTest(t)
	ft.f.keep = 1
	// "log on" before the first map opens a file nothing is written to.
	ft.write("L1006000.log", "")
	ft.write("L1006001.log", fileStart("L1006001.log")+logLine(killWalterAnn))
	ft.scan()
	if _, err := os.Stat(filepath.Join(ft.dir, "L1006000.log")); !os.IsNotExist(err) {
		t.Errorf("empty old file kept: %v", err)
	}
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}, "Ann": {Deaths: 1}})
}

func TestLogFollowerSameNameNewFile(t *testing.T) {
	ft := newFollowerTest(t)
	ft.write("L1006000.log", fileStart("L1006000.log")+logLine(killWalterAnn)+logLine(killWalterAnn))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 2}, "Ann": {Deaths: 2}})

	// A new container starts again at L1006000.log with another first line
	// (other time): it is read from the start, though it is shorter.
	path := filepath.Join(ft.dir, "L1006000.log")
	text := "10/06/2026 - 18:00:00: Log file started\n" + logLine(killAnnWalter)
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 2, Deaths: 1}, "Ann": {Kills: 1, Deaths: 2}})

	// Same first line but cut shorter (rewritten): read again from the start.
	if err := os.WriteFile(path, []byte("10/06/2026 - 18:00:00: Log file started\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ft.scan()
	ft.write("L1006000.log", logLine(killAnnWalter))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 2, Deaths: 2}, "Ann": {Kills: 2, Deaths: 2}})
}

func TestLogFollowerDeletedAndPruned(t *testing.T) {
	ft := newFollowerTest(t)
	ft.f.keep = 2
	for i := 0; i < 4; i++ {
		name := fmt.Sprintf("L1006%03d.log", i)
		ft.write(name, fileStart(name)+logLine(killWalterAnn))
	}
	ft.write("notes.txt", "not a log\n")
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 4}, "Ann": {Deaths: 4}})

	names := func() []string {
		entries, err := os.ReadDir(ft.dir)
		if err != nil {
			t.Fatal(err)
		}
		var list []string
		for _, e := range entries {
			list = append(list, e.Name())
		}
		return list
	}
	if got, want := names(), []string{"L1006002.log", "L1006003.log", "notes.txt"}; !reflect.DeepEqual(got, want) {
		t.Errorf("files after prune %v, want %v", got, want)
	}
	recs, err := ft.db.logFiles(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 || recs["L1006002.log"].Offset == 0 || recs["L1006003.log"].Offset == 0 {
		t.Errorf("records %+v", recs)
	}

	// A file deleted by someone else: its record goes too.
	if err := os.Remove(filepath.Join(ft.dir, "L1006002.log")); err != nil {
		t.Fatal(err)
	}
	ft.scan()
	recs, _ = ft.db.logFiles(context.Background())
	if _, ok := recs["L1006002.log"]; ok || len(recs) != 1 {
		t.Errorf("records after delete %+v", recs)
	}
	ft.expect(map[string]playerTotals{"Walter": {Kills: 4}, "Ann": {Deaths: 4}})
}

func TestLogFollowerUnreadFileNotPruned(t *testing.T) {
	ft := newFollowerTest(t)
	ft.f.keep = 1
	// Old file whose last line isn't complete: never fully read, kept.
	ft.write("L1006000.log", fileStart("L1006000.log")+logLine(killWalterAnn)+`10/06/2026 - 15:33:31: "Walter<7>`)
	ft.write("L1006001.log", fileStart("L1006001.log"))
	ft.scan()
	if _, err := os.Stat(filepath.Join(ft.dir, "L1006000.log")); err != nil {
		t.Errorf("unfinished file was deleted: %v", err)
	}
}

func TestStatsDBCommitIsAtomic(t *testing.T) {
	ft := newFollowerTest(t)
	ctx := context.Background()
	if err := ft.db.commit(ctx, "L1006000.log", logFileRecord{Fingerprint: "a", Offset: 10},
		map[string]playerTotals{"Walter": {Kills: 1}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	// A canceled context fails the transaction: neither totals nor offset
	// change.
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := ft.db.commit(canceled, "L1006000.log", logFileRecord{Fingerprint: "a", Offset: 20},
		map[string]playerTotals{"Walter": {Kills: 1}}, time.Now()); err == nil {
		t.Fatal("commit with a canceled context worked")
	}
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}})
	recs, _ := ft.db.logFiles(ctx)
	if recs["L1006000.log"].Offset != 10 {
		t.Errorf("offset %d, want 10", recs["L1006000.log"].Offset)
	}
}
