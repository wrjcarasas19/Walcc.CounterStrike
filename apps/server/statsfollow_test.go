package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
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
	players, _ := tally.take()
	return players
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
		// A fall death.
		`"Bob<9><ID_3><TERRORIST>" committed suicide with "worldspawn" (world)`,
		// Killed by own grenade, written as a kill of oneself.
		`"Ann<8><ID_2><TERRORIST>" killed "Ann<8><ID_2><TERRORIST>" with "hegrenade"`,
		// Victim on no team (just switched): a death, no kill.
		`"Walter<7><ID_1><CT>" killed "Cy<10><ID_4><SPECTATOR>" with "awp"`,
	)
	want := map[string]playerTotals{
		"Walter": {Kills: 2, Deaths: 1, Headshots: 1},
		"Ann":    {Deaths: 2, TeamKills: 1, Suicides: 1},
		"Bob":    {Deaths: 4, Suicides: 3},
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

func TestStatsTallyGunGameWins(t *testing.T) {
	lines := []string{
		`"Walter<7><ID_1><CT>" triggered "wc_gg_win"`,
		`"Walter<7><ID_1><CT>" triggered "wc_gg_win"`,
		`"Gilroy<3><ID_BOT><TERRORIST>" triggered "wc_gg_win"`,
		`"Gilroy<3><BOT><TERRORIST>" killed "Walter<7><ID_1><CT>" with "knife"`,
		// No name: not counted, like any other total.
		`"<9><ID_3><CT>" triggered "wc_gg_win"`,
	}
	if got, want := tallyLines(t, false, lines...), map[string]playerTotals{
		"Walter": {Deaths: 1, GunGameWins: 2},
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("bots left out: got %+v, want %+v", got, want)
	}
	if got, want := tallyLines(t, true, lines...), map[string]playerTotals{
		"Walter": {Deaths: 1, GunGameWins: 2},
		"Gilroy": {Kills: 1, GunGameWins: 1},
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
	ft.f = newLogFollower(ft.dir, db, false, nil, nil)
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
		map[string]playerTotals{"Walter": {Kills: 1}}, map[duelPair]int64{{"Walter", "Ann"}: 1}, time.Now()); err != nil {
		t.Fatal(err)
	}
	// A canceled context fails the transaction: neither totals nor offset
	// change.
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := ft.db.commit(canceled, "L1006000.log", logFileRecord{Fingerprint: "a", Offset: 20},
		map[string]playerTotals{"Walter": {Kills: 1}}, map[duelPair]int64{{"Walter", "Ann"}: 1}, time.Now()); err == nil {
		t.Fatal("commit with a canceled context worked")
	}
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}})
	ft.expectDuels(map[duelPair]int64{{"Walter", "Ann"}: 1})
	recs, _ := ft.db.logFiles(ctx)
	if recs["L1006000.log"].Offset != 10 {
		t.Errorf("offset %d, want 10", recs["L1006000.log"].Offset)
	}
}

// The players table as it was before migrations (no gg_wins, user_version
// 0), with a row and a log file record in it.
const statsSchemaV0 = `
CREATE TABLE players (
	name TEXT PRIMARY KEY,
	kills INTEGER NOT NULL DEFAULT 0,
	deaths INTEGER NOT NULL DEFAULT 0,
	headshots INTEGER NOT NULL DEFAULT 0,
	teamkills INTEGER NOT NULL DEFAULT 0,
	suicides INTEGER NOT NULL DEFAULT 0,
	rounds INTEGER NOT NULL DEFAULT 0,
	last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX players_by_kills ON players (kills DESC, deaths ASC, name ASC);
CREATE TABLE log_files (
	name TEXT PRIMARY KEY,
	fingerprint TEXT NOT NULL,
	read_offset INTEGER NOT NULL
);
INSERT INTO players (name, kills, deaths, headshots, teamkills, suicides, rounds, last_seen)
VALUES ('Walter', 5, 2, 1, 0, 0, 3, 1791000000);
INSERT INTO log_files (name, fingerprint, read_offset) VALUES ('L1006000.log', 'abc', 42);
`

func statsUserVersion(t *testing.T, db *statsDB) int {
	t.Helper()
	var v int
	if err := db.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestStatsDBMigratesOldDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), leaderboardFile)
	old, err := sql.Open("sqlite3", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(statsSchemaV0); err != nil {
		t.Fatal(err)
	}
	old.Close()

	ft := &followerTest{t: t}
	ft.open(path)
	if v := statsUserVersion(t, ft.db); v != len(statsMigrations) {
		t.Errorf("user_version %d, want %d", v, len(statsMigrations))
	}
	// Old totals and offsets kept, gg_wins 0, and the new column counts.
	ft.expect(map[string]playerTotals{"Walter": {Kills: 5, Deaths: 2, Headshots: 1, Rounds: 3}})
	recs, err := ft.db.logFiles(context.Background())
	if err != nil || recs["L1006000.log"] != (logFileRecord{Fingerprint: "abc", Offset: 42}) {
		t.Errorf("log files %+v, %v", recs, err)
	}
	if err := ft.db.commit(context.Background(), "L1006000.log", logFileRecord{Fingerprint: "abc", Offset: 50},
		map[string]playerTotals{"Walter": {Kills: 1, GunGameWins: 1}}, nil, time.Now()); err != nil {
		t.Fatal(err)
	}
	ft.expect(map[string]playerTotals{"Walter": {Kills: 6, Deaths: 2, Headshots: 1, Rounds: 3, GunGameWins: 1}})

	// Opened again: the migration doesn't run twice (it would fail with a
	// duplicate column).
	ft.open(path)
	ft.expect(map[string]playerTotals{"Walter": {Kills: 6, Deaths: 2, Headshots: 1, Rounds: 3, GunGameWins: 1}})
}

func TestStatsDBNewDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "data", leaderboardFile)
	ft := &followerTest{t: t}
	ft.open(path)
	if v := statsUserVersion(t, ft.db); v != len(statsMigrations) {
		t.Errorf("user_version %d, want %d", v, len(statsMigrations))
	}
	if err := ft.db.commit(context.Background(), "L1006000.log", logFileRecord{Fingerprint: "a", Offset: 1},
		map[string]playerTotals{"Ann": {GunGameWins: 2}}, nil, time.Now()); err != nil {
		t.Fatal(err)
	}
	ft.open(path)
	ft.expect(map[string]playerTotals{"Ann": {GunGameWins: 2}})

	// A database from a newer build (a higher version) opens as it is.
	if _, err := ft.db.db.Exec(`PRAGMA user_version = 99`); err != nil {
		t.Fatal(err)
	}
	ft.open(path)
	if v := statsUserVersion(t, ft.db); v != 99 {
		t.Errorf("user_version %d, want 99", v)
	}
	ft.expect(map[string]playerTotals{"Ann": {GunGameWins: 2}})
}

func tallyDuels(t *testing.T, includeBots bool, bodies ...string) map[duelPair]int64 {
	t.Helper()
	tally := newStatsTally(includeBots)
	for _, body := range bodies {
		ev, ok := parseLogLine(strings.TrimSuffix(logLine(body), "\n"))
		if !ok {
			t.Fatalf("line not parsed: %q", body)
		}
		tally.apply(ev, true)
	}
	_, duels := tally.take()
	return duels
}

// duels reads the whole duels table.
func (ft *followerTest) duels() map[duelPair]int64 {
	ft.t.Helper()
	rows, err := ft.db.db.Query(`SELECT killer, victim, kills FROM duels`)
	if err != nil {
		ft.t.Fatal(err)
	}
	defer rows.Close()
	got := map[duelPair]int64{}
	for rows.Next() {
		var p duelPair
		var n int64
		if err := rows.Scan(&p.Killer, &p.Victim, &n); err != nil {
			ft.t.Fatal(err)
		}
		got[p] = n
	}
	if err := rows.Err(); err != nil {
		ft.t.Fatal(err)
	}
	return got
}

func (ft *followerTest) expectDuels(want map[duelPair]int64) {
	ft.t.Helper()
	if got := ft.duels(); !reflect.DeepEqual(got, want) {
		ft.t.Errorf("duels %+v\nwant %+v", got, want)
	}
}

func TestStatsTallyDuels(t *testing.T) {
	lines := []string{
		killWalterAnn,
		killWalterAnn,
		killAnnWalter,
		// Not enemy kills: no pair.
		`"Ann<8><ID_2><TERRORIST>" killed "Bob<9><ID_3><TERRORIST>" with "glock18"`,
		`"Ann<8><ID_2><TERRORIST>" killed "Ann<8><ID_2><TERRORIST>" with "hegrenade"`,
		`"Bob<9><ID_3><TERRORIST>" committed suicide with "worldspawn" (world)`,
		`"Walter<7><ID_1><CT>" killed "Cy<10><ID_4><SPECTATOR>" with "awp"`,
		// A headshot line isn't a second kill.
		`"Walter<7><ID_1><CT>" triggered "wc_headshot" against "Bob<9><ID_3><TERRORIST>" with "ak47"`,
		`"Walter<7><ID_1><CT>" killed "Bob<9><ID_3><TERRORIST>" with "ak47"`,
		// Bots: only with includeBots.
		`"Walter<7><ID_1><CT>" killed "Gilroy<3><BOT><TERRORIST>" with "ak47"`,
		`"Gilroy<3><ID_BOT><TERRORIST>" killed "Walter<7><ID_1><CT>" with "usp"`,
		// No name, or a name too long: no pair, like the totals.
		`"<11><ID_5><TERRORIST>" killed "Walter<7><ID_1><CT>" with "usp"`,
		`"` + strings.Repeat("x", statsNameMax+1) + `<12><ID_6><TERRORIST>" killed "Walter<7><ID_1><CT>" with "usp"`,
		`"Walter<7><ID_1><CT>" killed "` + strings.Repeat("y", statsNameMax) + `<13><ID_7><TERRORIST>" with "ak47"`,
		// Two players with the same name: not a pair with itself.
		`"Ann<8><ID_2><TERRORIST>" killed "Ann<14><ID_8><CT>" with "ak47"`,
	}
	long := strings.Repeat("y", statsNameMax)
	if got, want := tallyDuels(t, false, lines...), map[duelPair]int64{
		{"Walter", "Ann"}: 2,
		{"Ann", "Walter"}: 1,
		{"Walter", "Bob"}: 1,
		{"Walter", long}:  1,
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("bots left out: got %+v\nwant %+v", got, want)
	}
	if got, want := tallyDuels(t, true, lines...), map[duelPair]int64{
		{"Walter", "Ann"}:    2,
		{"Ann", "Walter"}:    1,
		{"Walter", "Bob"}:    1,
		{"Walter", long}:     1,
		{"Walter", "Gilroy"}: 1,
		{"Gilroy", "Walter"}: 1,
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("bots included: got %+v\nwant %+v", got, want)
	}
}

// A rename starts a new pair, like the totals start a new row.
func TestStatsTallyDuelsRename(t *testing.T) {
	got := tallyDuels(t, false,
		killWalterAnn,
		`"Ann<8><ID_2><TERRORIST>" changed name to "Anna"`,
		`"Walter<7><ID_1><CT>" killed "Anna<8><ID_2><TERRORIST>" with "ak47"`,
		`"Anna<8><ID_2><TERRORIST>" killed "Walter<7><ID_1><CT>" with "glock18"`,
		`"Walter<7><ID_1><CT>" changed name to "Walt"`,
		`"Anna<8><ID_2><TERRORIST>" killed "Walt<7><ID_1><CT>" with "glock18"`,
		// Kills after a shutdown line still count (the line has both teams).
		`Server shutdown`,
		`"Anna<8><ID_2><TERRORIST>" killed "Walt<7><ID_1><CT>" with "glock18"`,
	)
	want := map[duelPair]int64{
		{"Walter", "Ann"}:  1,
		{"Walter", "Anna"}: 1,
		{"Anna", "Walter"}: 1,
		{"Anna", "Walt"}:   2,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v\nwant %+v", got, want)
	}
}

// From the log file to the duels table, across a restart and a new file.
func TestLogFollowerDuels(t *testing.T) {
	ft := newFollowerTest(t)
	ft.write("L1006000.log", fileStart("L1006000.log")+logLine(killWalterAnn)+logLine(killAnnWalter)+logLine(killWalterAnn))
	ft.scan()
	ft.expectDuels(map[duelPair]int64{{"Walter", "Ann"}: 2, {"Ann", "Walter"}: 1})

	// Restart: the replayed part isn't counted again.
	ft.open(filepath.Join(filepath.Dir(ft.dir), "data", leaderboardFile))
	ft.write("L1006000.log", logLine(killAnnWalter))
	ft.scan()
	ft.write("L1006001.log", fileStart("L1006001.log")+logLine(killWalterAnn))
	ft.scan()
	ft.expectDuels(map[duelPair]int64{{"Walter", "Ann"}: 3, {"Ann", "Walter"}: 2})
	if a, b, err := ft.db.duel(context.Background(), "Ann", "Walter"); err != nil || a != 2 || b != 3 {
		t.Errorf("duel(Ann, Walter) = %d, %d, %v", a, b, err)
	}
	if a, b, err := ft.db.duel(context.Background(), "Walter", "Nobody"); err != nil || a != 0 || b != 0 {
		t.Errorf("duel(Walter, Nobody) = %d, %d, %v", a, b, err)
	}
}

// A database from after A.5 (gg_wins, user_version 1) and before the duels
// table gets the table; its totals and offsets are kept.
func TestStatsDBMigratesPreDuelDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), leaderboardFile)
	old, err := sql.Open("sqlite3", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(statsSchemaV0 + `
ALTER TABLE players ADD COLUMN gg_wins INTEGER NOT NULL DEFAULT 0;
UPDATE players SET gg_wins = 4 WHERE name = 'Walter';
PRAGMA user_version = 1;`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	ft := &followerTest{t: t}
	ft.open(path)
	if v := statsUserVersion(t, ft.db); v != len(statsMigrations) || v < 2 {
		t.Errorf("user_version %d, want %d", v, len(statsMigrations))
	}
	ft.expect(map[string]playerTotals{"Walter": {Kills: 5, Deaths: 2, Headshots: 1, Rounds: 3, GunGameWins: 4}})
	ft.expectDuels(map[duelPair]int64{})
	recs, err := ft.db.logFiles(context.Background())
	if err != nil || recs["L1006000.log"] != (logFileRecord{Fingerprint: "abc", Offset: 42}) {
		t.Errorf("log files %+v, %v", recs, err)
	}
	if err := ft.db.commit(context.Background(), "L1006000.log", logFileRecord{Fingerprint: "abc", Offset: 50},
		map[string]playerTotals{"Walter": {Kills: 1}, "Ann": {Deaths: 1}}, map[duelPair]int64{{"Walter", "Ann"}: 1}, time.Now()); err != nil {
		t.Fatal(err)
	}
	// Opened again: the CREATE TABLE doesn't run twice.
	ft.open(path)
	ft.expectDuels(map[duelPair]int64{{"Walter", "Ann"}: 1})
	ft.expect(map[string]playerTotals{"Walter": {Kills: 6, Deaths: 2, Headshots: 1, Rounds: 3, GunGameWins: 4}, "Ann": {Deaths: 1}})
}

// fakeDevices is the SFU's players for the tally: made-up address →
// device token hash ("" for a player without a cookie).
type fakeDevices map[[4]byte]string

func (f fakeDevices) deviceOf(ip [4]byte) (string, bool) {
	hash, ok := f[ip]
	return hash, ok
}

func applyLines(t *testing.T, tally *statsTally, count bool, bodies ...string) {
	t.Helper()
	for _, body := range bodies {
		ev, ok := parseLogLine(strings.TrimSuffix(logLine(body), "\n"))
		if !ok {
			t.Fatalf("line not parsed: %q", body)
		}
		tally.apply(ev, count)
	}
}

func expectDevices(t *testing.T, tally *statsTally, want map[int]string) {
	t.Helper()
	if !reflect.DeepEqual(tally.devices, want) {
		t.Errorf("devices %v\nwant %v", tally.devices, want)
	}
	for id, hash := range want {
		if got, ok := tally.device(id); !ok || got != hash {
			t.Errorf("device(%d) = %q, %v", id, got, ok)
		}
	}
}

// Real lines from the image (E.3 capture): two bots, a browser player who
// stays through a map change (new file, new userid, same address) and the
// same browser joining again (new address).
const (
	connectBot1     = `"blueguile<1><0><>" connected, address "local"`
	connectBot2     = `"Ender Wiggin<2><1><>" connected, address "local"`
	connectCapture  = `"Capture<3><2><>" connected, address "0.84.74.120:12345"`
	enterCapture    = `"Capture<3><ID_7dea362b3fac8e00956a4952a3d4f47><>" entered the game`
	connectCapture4 = `"Capture<4><2><>" connected, address "0.84.74.120:12345"`
	leaveCapture4   = `"Capture<4><ID_7dea362b3fac8e00956a4952a3d4f47><>" disconnected`
	connectCapture2 = `"Capture2<7><2><>" connected, address "0.53.54.164:12345"`
)

func TestStatsTallyDevices(t *testing.T) {
	peers := fakeDevices{
		{0, 84, 74, 120}: "hash-a",
		{0, 53, 54, 164}: "hash-b",
		{1, 9, 9, 9}:     "", // connected without a cookie
	}
	tally := newStatsTally(false)
	tally.peers = peers
	var logged []string
	tally.logf = func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }

	applyLines(t, tally, true, connectBot1, connectBot2, connectCapture, enterCapture,
		`"NoCookie<5><3><>" connected, address "1.9.9.9:12345"`,
		// Gone from the SFU before the line was read (same slot, another
		// player now): no device.
		`"Gone<6><4><>" connected, address "0.1.2.3:12345"`,
	)
	expectDevices(t, tally, map[int]string{3: "hash-a"})
	if want := []string{`#3 "Capture" connected with device hash-a`}; !reflect.DeepEqual(logged, want) {
		t.Errorf("logged %q", logged)
	}

	// A userid seen again (after a restart, which normally starts a new
	// file) takes the new connection's device, or none.
	applyLines(t, tally, true, `"Capture<3><2><>" connected, address "0.53.54.164:12345"`)
	expectDevices(t, tally, map[int]string{3: "hash-b"})
	applyLines(t, tally, true, `"Other<3><2><>" connected, address "local"`)
	expectDevices(t, tally, map[int]string{})

	applyLines(t, tally, true, connectCapture4, connectCapture2)
	expectDevices(t, tally, map[int]string{4: "hash-a", 7: "hash-b"})
	applyLines(t, tally, true, leaveCapture4)
	expectDevices(t, tally, map[int]string{7: "hash-b"})
	if _, ok := tally.device(4); ok {
		t.Error("device(4) after disconnect")
	}

	// Server shutdown: everyone is gone.
	applyLines(t, tally, true, "Server shutdown")
	expectDevices(t, tally, map[int]string{})

	// Replayed lines (count false) get the device back without logging.
	logged = nil
	applyLines(t, tally, false, connectCapture)
	expectDevices(t, tally, map[int]string{3: "hash-a"})
	if len(logged) != 0 {
		t.Errorf("logged while replaying: %q", logged)
	}

	// No SFU (tests, or a tally without peers): nobody has a device.
	plain := newStatsTally(false)
	applyLines(t, plain, true, connectCapture)
	expectDevices(t, plain, map[int]string{})
}

// Devices across files, a follower restart in the middle of a file and the
// player leaving the SFU.
func TestLogFollowerDevices(t *testing.T) {
	ft := newFollowerTest(t)
	peers := fakeDevices{{0, 84, 74, 120}: "hash-a"}
	ft.f.tally.peers = peers
	ft.write("L1007001.log", fileStart("L1007001.log")+logLine(connectBot1)+logLine(connectBot2)+logLine(connectCapture)+logLine(enterCapture))
	ft.scan()
	expectDevices(t, ft.f.tally, map[int]string{3: "hash-a"})

	// Map change: a new file, where everyone connects again.
	ft.write("L1007001.log", logLine("Log file closed"))
	ft.write("L1007002.log", fileStart("L1007002.log"))
	ft.scan()
	expectDevices(t, ft.f.tally, map[int]string{})
	ft.write("L1007002.log", logLine(connectCapture4))
	ft.scan()
	expectDevices(t, ft.f.tally, map[int]string{4: "hash-a"})

	// The follower starts again (same SFU): the file is replayed up to the
	// stored offset and the device found again.
	ft.open(filepath.Join(filepath.Dir(ft.dir), "data", leaderboardFile))
	ft.f.tally.peers = peers
	ft.write("L1007002.log", logLine(`World triggered "Round_Start"`))
	ft.scan()
	expectDevices(t, ft.f.tally, map[int]string{4: "hash-a"})

	// The player leaves; a replay from scratch (another restart) no
	// longer finds their connection.
	ft.write("L1007002.log", logLine(leaveCapture4)+logLine(connectCapture4))
	delete(peers, [4]byte{0, 84, 74, 120})
	ft.open(filepath.Join(filepath.Dir(ft.dir), "data", leaderboardFile))
	ft.f.tally.peers = peers
	ft.write("L1007002.log", logLine(`World triggered "Round_End"`))
	ft.scan()
	expectDevices(t, ft.f.tally, map[int]string{})
}

// fakeOwners is statsDB.ownsClaim for the tally: "hash key" pairs that
// own, and how many times it was asked.
type fakeOwners struct {
	owns  map[[2]string]bool
	err   error
	calls int
}

func (f *fakeOwners) ownsClaim(_ context.Context, hash, key string) (bool, error) {
	f.calls++
	return f.owns[[2]string{hash, key}], f.err
}

// claimTally is a tally where "Walter" is claimed and owned by hash-a
// (address 0.1.1.1); 0.2.2.2 has another device, 0.3.3.3 none.
func claimTally(includeBots bool) (*statsTally, *fakeOwners) {
	tally := newStatsTally(includeBots)
	tally.peers = fakeDevices{{0, 1, 1, 1}: "hash-a", {0, 2, 2, 2}: "hash-b", {0, 3, 3, 3}: ""}
	owners := &fakeOwners{owns: map[[2]string]bool{{"hash-a", "walter"}: true}}
	tally.setClaims(context.Background(), map[string]string{"walter": "Walter"}, owners)
	tally.live = true
	return tally, owners
}

const (
	connectOwner    = `"walter<2><1><>" connected, address "0.1.1.1:12345"`
	connectGuest    = `"Walter<3><2><>" connected, address "0.2.2.2:12345"`
	connectNoCookie = `"Walter<4><3><>" connected, address "0.3.3.3:12345"`
	connectAnn      = `"Ann<5><4><>" connected, address "0.1.2.3:12345"`
	connectBotW     = `"Walter<6><5><>" connected, address "local"`
)

func TestStatsTallyClaimedNames(t *testing.T) {
	tally, _ := claimTally(true)
	applyLines(t, tally, true, connectOwner, connectGuest, connectNoCookie, connectAnn, connectBotW,
		// The owner, as typed, with colour codes, a dup suffix, other case:
		// all to the claimed row.
		`"walter<2><ID_1><CT>" killed "Ann<5><ID_5><TERRORIST>" with "ak47"`,
		`"walter<2><ID_1><CT>" triggered "wc_headshot" against "Ann<5><ID_5><TERRORIST>" with "ak47"`,
		`"^1WALTER (1)<2><ID_1><CT>" killed "Ann<5><ID_5><TERRORIST>" with "ak47"`,
		`"Ann<5><ID_5><TERRORIST>" killed "walter<2><ID_1><CT>" with "glock18"`,
		`"walter<2><ID_1><CT>" committed suicide with "hegrenade"`,
		`"walter<2><ID_1><CT>" triggered "wc_gg_win"`,
		// Someone else's device, no cookie, a bot: dropped entirely; the
		// other side still counts.
		`"Walter<3><ID_2><CT>" killed "Ann<5><ID_5><TERRORIST>" with "m4a1"`,
		`"Walter<3><ID_2><CT>" triggered "wc_headshot" against "Ann<5><ID_5><TERRORIST>" with "m4a1"`,
		`"Ann<5><ID_5><TERRORIST>" killed "Walter (1)<4><ID_3><CT>" with "ak47"`,
		`"Walter<6><BOT><CT>" killed "Ann<5><ID_5><TERRORIST>" with "m4a1"`,
		`"Walter<3><ID_2><CT>" committed suicide with "worldspawn"`,
		`"Walter<4><ID_3><CT>" triggered "wc_gg_win"`,
		// The owner's device under an unclaimed name counts as that name.
		`"Bob<2><ID_1><CT>" killed "Ann<5><ID_5><TERRORIST>" with "ak47"`,
		// The guest's own rows of other spellings don't grow either.
		`"walter<3><ID_2><CT>" killed "Ann<5><ID_5><TERRORIST>" with "m4a1"`,
		`World triggered "Round_Start"`,
		`World triggered "Round_End"`,
	)
	players, duels := tally.take()
	// Rounds: Ann and the owner, last seen as "Bob" (that row).
	want := map[string]playerTotals{
		"Walter": {Kills: 2, Deaths: 2, Headshots: 1, Suicides: 1, GunGameWins: 1},
		"Ann":    {Kills: 2, Deaths: 6, Rounds: 1},
		"Bob":    {Kills: 1, Rounds: 1},
	}
	if !reflect.DeepEqual(players, want) {
		t.Errorf("totals %+v\nwant %+v", players, want)
	}
	wantDuels := map[duelPair]int64{
		{Killer: "Walter", Victim: "Ann"}: 2,
		{Killer: "Ann", Victim: "Walter"}: 1,
		{Killer: "Bob", Victim: "Ann"}:    1,
	}
	if !reflect.DeepEqual(duels, wantDuels) {
		t.Errorf("duels %+v\nwant %+v", duels, wantDuels)
	}
	if tally.err != nil {
		t.Error(tally.err)
	}
}

func TestStatsTallyClaimedRounds(t *testing.T) {
	tally, _ := claimTally(false)
	applyLines(t, tally, true, connectOwner, connectGuest,
		`"walter<2><ID_1><CT>" joined team "CT"`,
		`"Walter (1)<3><ID_2><TERRORIST>" joined team "TERRORIST"`,
		`World triggered "Round_Start"`,
		`World triggered "Round_End"`,
	)
	players, _ := tally.take()
	if want := map[string]playerTotals{"Walter": {Rounds: 1}}; !reflect.DeepEqual(players, want) {
		t.Errorf("totals %+v\nwant %+v", players, want)
	}
}

// Ownership is asked once per device and key per scan; an error is kept
// and the events dropped.
func TestStatsTallyClaimOwnersCache(t *testing.T) {
	tally, owners := claimTally(false)
	kill := `"walter<2><ID_1><CT>" killed "Ann<5><ID_5><TERRORIST>" with "ak47"`
	applyLines(t, tally, true, connectOwner, connectGuest, kill, kill, kill,
		`"Walter<3><ID_2><CT>" killed "Ann<5><ID_5><TERRORIST>" with "m4a1"`,
		`"Walter<3><ID_2><CT>" killed "Ann<5><ID_5><TERRORIST>" with "m4a1"`,
		// Unclaimed names and players without a device don't ask.
		`"Ann<5><ID_5><TERRORIST>" killed "Bob<9><ID_9><CT>" with "ak47"`,
		`"Walter<9><ID_9><CT>" killed "Ann<5><ID_5><TERRORIST>" with "ak47"`,
	)
	if owners.calls != 2 {
		t.Errorf("ownsClaim asked %d times, want 2", owners.calls)
	}
	// The next scan asks again (a claim can be released in between).
	tally.setClaims(context.Background(), map[string]string{"walter": "Walter"}, owners)
	applyLines(t, tally, true, kill)
	if owners.calls != 3 {
		t.Errorf("ownsClaim asked %d times after setClaims, want 3", owners.calls)
	}
	tally.take()

	owners.err = errors.New("database is locked")
	tally.setClaims(context.Background(), map[string]string{"walter": "Walter"}, owners)
	applyLines(t, tally, true, kill)
	if players, _ := tally.take(); tally.err == nil || !reflect.DeepEqual(players, map[string]playerTotals{"Ann": {Deaths: 1}}) {
		t.Errorf("after an error: err %v, totals %+v", tally.err, players)
	}
	if _, ok := tally.owned[[2]string{"hash-a", "walter"}]; ok {
		t.Error("a failed answer was cached")
	}

	// No claims at all: names count as before, nothing is asked.
	plain := newStatsTally(false)
	plain.peers = tally.peers
	applyLines(t, plain, true, connectGuest, `"Walter<3><ID_2><CT>" killed "Ann<5><ID_5><TERRORIST>" with "m4a1"`)
	if players, _ := plain.take(); players["Walter"] != (playerTotals{Kills: 1}) {
		t.Errorf("unclaimed: %+v", players)
	}
}

func expectRenames(t *testing.T, tally *statsTally, want ...guestRename) {
	t.Helper()
	got := tally.takeRenames()
	if len(got) == 0 && len(want) == 0 {
		return
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("renames %+v\nwant %+v", got, want)
	}
}

func TestStatsTallyEnforceClaims(t *testing.T) {
	tally, _ := claimTally(false)
	applyLines(t, tally, true, connectOwner, connectGuest, connectNoCookie, connectBotW,
		`"walter<2><ID_1><>" entered the game`,
		`"Walter<3><ID_2><>" entered the game`,
		`"Walter (1)<4><ID_3><>" entered the game`,
		`"Walter<6><BOT><>" entered the game`,
	)
	expectRenames(t, tally,
		guestRename{UserID: 3, Name: "Walter"},
		guestRename{UserID: 4, Name: "Walter (1)"},
		guestRename{UserID: 6, Name: "Walter"},
	)

	// The rename's own name change (if the engine logs one) and the
	// fallback are reserved names: nothing more.
	applyLines(t, tally, true,
		`"Walter<3><ID_2><CT>" changed name to "Walter (guest)"`,
		`"Walter (1)<4><ID_3><CT>" changed name to "Walter (guest) (1)"`,
		`"Walter<6><BOT><CT>" changed name to "Player 6"`,
	)
	expectRenames(t, tally)

	// Changing to a claimed name (any spelling) is renamed; changing away
	// isn't; the owner changing between spellings isn't.
	applyLines(t, tally, true,
		`"Ann<5><ID_5><CT>" changed name to "^1walter"`,
		`"walter<2><ID_1><CT>" changed name to "WALTER"`,
		`"Walter (guest)<3><ID_2><CT>" changed name to "Gus"`,
	)
	expectRenames(t, tally, guestRename{UserID: 5, Name: "^1walter"})

	// A client that keeps taking the name back: at most guestRenameMax
	// renames per userid, and one per userid at a time.
	renames := 0
	for i := 0; i < 5; i++ {
		applyLines(t, tally, true,
			`"Gus<3><ID_2><CT>" say "renamed"`,
			`"Gus<3><ID_2><CT>" changed name to "Walter"`,
			`"Walter<3><ID_2><CT>" changed name to "walter"`,
		)
		renames += len(tally.takeRenames())
	}
	if renames != guestRenameMax-1 {
		t.Errorf("%d renames for a client fighting back, want %d more", renames, guestRenameMax-1)
	}

	// No "changed name to" line (this engine writes none): any line that
	// shows a player under a claimed name, killer or victim, asks once
	// until a line shows them under a free name.
	applyLines(t, tally, true, connectAnn,
		`"Walter (1)<10><ID_10><CT>" killed "WALTER<11><ID_11><TERRORIST>" with "ak47"`,
		`"Walter (1)<10><ID_10><CT>" killed "WALTER<11><ID_11><TERRORIST>" with "ak47"`,
		`"Walter (1)<10><ID_10><CT>" triggered "wc_headshot" against "WALTER<11><ID_11><TERRORIST>" with "ak47"`,
		`"walter<12><ID_12><CT>" joined team "CT"`,
		`"walter<13><ID_13><CT>" committed suicide with "world"`,
		`"walter<14><ID_14><CT>" triggered "Planted_The_Bomb"`,
	)
	expectRenames(t, tally,
		guestRename{UserID: 10, Name: "Walter (1)"},
		guestRename{UserID: 11, Name: "WALTER"},
		guestRename{UserID: 12, Name: "walter"},
		guestRename{UserID: 13, Name: "walter"},
		guestRename{UserID: 14, Name: "walter"},
	)
	applyLines(t, tally, true, `"walter<12><ID_12><CT>" say "still"`)
	expectRenames(t, tally)
	applyLines(t, tally, true,
		`"Player 12<12><ID_12><CT>" say "renamed"`,
		`"walter<12><ID_12><CT>" say "back"`,
		// Leaving forgets the pending rename.
		`"walter<13><ID_13><CT>" disconnected`,
	)
	expectRenames(t, tally, guestRename{UserID: 12, Name: "walter"})
	if tally.pending[13] {
		t.Error("pending rename kept after a disconnect")
	}

	// Replayed lines and files of an engine that is gone: no renames.
	applyLines(t, tally, false, `"Walter<8><ID_8><>" entered the game`)
	tally.live = false
	applyLines(t, tally, true, `"Walter<9><ID_9><>" entered the game`)
	expectRenames(t, tally)

	// A new file starts the count again.
	tally.reset()
	tally.live = true
	applyLines(t, tally, true, `"Walter<3><ID_2><>" entered the game`)
	expectRenames(t, tally, guestRename{UserID: 3, Name: "Walter"})
}

func TestGuestName(t *testing.T) {
	claims := map[string]string{"walter": "Walter", "bob (guest)": "Bob (guest)"}
	long := strings.Repeat("a", 31)
	for _, c := range []struct{ name, want string }{
		{"Walter", "Walter (guest)"},
		{"^1Walter (1)", "^1Walter (1) (guest)"},
		{long, strings.Repeat("a", 23) + " (guest)"},
		// Cut on a character boundary (Ü is 2 bytes): 11 Ü = 22 bytes.
		{strings.Repeat("Ü", 15), strings.Repeat("Ü", 11) + " (guest)"},
		// A name the engine cut in the middle of a character.
		{"Walter\xc3", "Walter (guest)"},
		// Spaces before the cut don't double up.
		{strings.Repeat("a", 22) + "  bcd", strings.Repeat("a", 22) + " (guest)"},
		{"Tom & Jerry", "Tom & Jerry (guest)"},
		{"Wal,ter {x}", "Wal,ter {x} (guest)"},
		// Unsafe in the command, or refused by the engine: the fallback.
		{"$rcon_password", "Player 7"},
		{"100%", "Player 7"},
		{"a;quit", "Player 7"},
		{"a//b", "Player 7"},
		{"a..b", "Player 7"},
		{"a\x01b", "Player 7"},
		// The guest name is claimed itself (can't happen through the API).
		{"Bob", "Player 7"},
	} {
		got := guestName(c.name, 7, claims)
		if got != c.want {
			t.Errorf("guestName(%q) = %q, want %q", c.name, got, c.want)
		}
		if len(got) > nameMaxBytes || !utf8.ValidString(got) {
			t.Errorf("guestName(%q) = %q: %d bytes", c.name, got, len(got))
		}
		if !reservedNameKey(nameKey(got)) {
			t.Errorf("guestName(%q) = %q can be claimed", c.name, got)
		}
	}
}

func TestGuestCommands(t *testing.T) {
	if got, want := renameCommand(12, "Ünal (guest)"), `amx_nick #12 "Ünal (guest)"`; got != want {
		t.Errorf("rename %q, want %q", got, want)
	}
	got := messageCommands(12)
	want := []string{
		"alias web_msg amx_psay #12 " + guestMessage,
		"web_msg",
		"alias web_msg",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("commands %q\nwant %q", got, want)
	}
	for _, command := range got {
		if !safeCommandPattern.MatchString(command) {
			t.Errorf("message command %q isn't safe", command)
		}
	}
	if !messagePattern.MatchString(guestMessage) || strings.Contains(guestMessage, "//") || len(guestMessage) > messageMaxLength {
		t.Errorf("guestMessage %q isn't a valid admin message", guestMessage)
	}
}

// The follower with a real database: an owner and a guest under the
// claimed name, renames through the console, and an old file.
func TestLogFollowerClaimedNames(t *testing.T) {
	ft := newFollowerTest(t)
	ctx := context.Background()
	now := time.Unix(1791000000, 0)
	if err := ft.db.createClaim(ctx, nameClaim{Key: "walter", Name: "Walter", CodeHash: "x"}, "", "hash-a", now); err != nil {
		t.Fatal(err)
	}
	console := &fakeConsole{}
	clock := now
	ft.f.tally.peers = fakeDevices{{0, 1, 1, 1}: "hash-a", {0, 2, 2, 2}: "hash-b"}
	ft.f.console = console
	ft.f.started = time.Time{} // every file is this engine's
	ft.f.now = func() time.Time { return clock }
	ft.write("L1007001.log", fileStart("L1007001.log")+
		logLine(connectOwner)+logLine(connectGuest)+logLine(connectAnn)+
		logLine(`"walter<2><ID_1><>" entered the game`)+
		logLine(`"Walter<3><ID_2><>" entered the game`)+
		logLine(`"walter<2><ID_1><CT>" killed "Ann<5><ID_5><TERRORIST>" with "ak47"`)+
		logLine(`"Walter<3><ID_2><CT>" killed "Ann<5><ID_5><TERRORIST>" with "m4a1"`))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}, "Ann": {Deaths: 2}})
	ft.expectDuels(map[duelPair]int64{{Killer: "Walter", Victim: "Ann"}: 1})
	if want := []string{renameCommand(3, "Walter (guest)")}; !reflect.DeepEqual(console.commands, want) {
		t.Errorf("commands %q\nwant %q", console.commands, want)
	}
	// The chat line follows guestMessageDelay later, on a later scan.
	// wc_statslog.amxx logs the rename.
	ft.write("L1007001.log", logLine(`"Walter<3><ID_2><>" changed name to "Walter (guest)"`))
	console.commands = nil
	clock = clock.Add(guestMessageDelay - time.Second)
	ft.scan()
	if len(console.commands) != 0 {
		t.Errorf("chat line too early: %q", console.commands)
	}
	clock = clock.Add(time.Second)
	ft.scan()
	if want := messageCommands(3); !reflect.DeepEqual(console.commands, want) {
		t.Errorf("chat line %q\nwant %q", console.commands, want)
	}
	ft.scan()
	if want := messageCommands(3); !reflect.DeepEqual(console.commands, want) {
		t.Errorf("chat line sent again: %q", console.commands)
	}

	// A rename that didn't take (the last line still has the claimed
	// name when the chat line is due) is sent again first, within
	// guestRenameMax; one that worked (wc_statslog's line) isn't.
	console.commands = nil
	ft.write("L1007001.log", logLine(`"Walter<30><ID_30><>" entered the game`)+
		logLine(`"Walter<30><ID_30><>" joined team "CT"`)+
		logLine(`"Walter<31><ID_31><>" entered the game`)+
		logLine(`"Walter<31><ID_31><>" joined team "TERRORIST"`))
	ft.scan()
	ft.write("L1007001.log", logLine(`"Walter<31><ID_31><>" changed name to "Walter (guest)"`))
	clock = clock.Add(guestMessageDelay)
	ft.scan()
	want := append([]string{renameCommand(30, "Walter (guest)"), renameCommand(31, "Walter (guest)"),
		renameCommand(30, "Player 30")}, messageCommands(30)...)
	want = append(want, messageCommands(31)...)
	if !reflect.DeepEqual(console.commands, want) {
		t.Errorf("retry: %q\nwant %q", console.commands, want)
	}
	if got := ft.f.tally.renamed[30]; got != 2 {
		t.Errorf("renames of #30: %d, want 2", got)
	}
	ft.f.tally.renamed[30] = guestRenameMax
	ft.write("L1007001.log", logLine(`"Walter<30><ID_30><CT>" say "x"`)+logLine(`"Walter<30><ID_30><>" disconnected`))
	ft.scan()

	// Renamed before joining a team (still on the loading screen): the
	// chat line comes guestMessageDelay after they join one.
	console.commands = nil
	ft.write("L1007001.log", logLine(`"Walter<40><ID_40><>" entered the game`))
	ft.scan()
	ft.write("L1007001.log", logLine(`"Walter<40><ID_40><>" changed name to "Walter (guest)"`))
	clock = clock.Add(time.Minute)
	ft.scan()
	if want := []string{renameCommand(40, "Walter (guest)")}; !reflect.DeepEqual(console.commands, want) {
		t.Errorf("before a team: %q\nwant %q", console.commands, want)
	}
	ft.write("L1007001.log", logLine(`"Walter (guest)<40><ID_40><>" joined team "SPECTATOR"`))
	ft.scan()
	clock = clock.Add(guestMessageDelay - time.Second)
	ft.scan()
	if len(console.commands) != 1 {
		t.Errorf("chat line right after joining a team: %q", console.commands)
	}
	clock = clock.Add(time.Second)
	ft.scan()
	if want := append([]string{renameCommand(40, "Walter (guest)")}, messageCommands(40)...); !reflect.DeepEqual(console.commands, want) {
		t.Errorf("after joining a team: %q\nwant %q", console.commands, want)
	}

	// The rename shows in later lines; nothing more is sent.
	console.commands = nil
	ft.write("L1007001.log", logLine(`"Walter (guest)<3><ID_2><CT>" killed "Ann<5><ID_5><TERRORIST>" with "m4a1"`))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}, "Ann": {Deaths: 3}, "Walter (guest)": {Kills: 1}})
	if len(console.commands) != 0 {
		t.Errorf("commands after the rename: %q", console.commands)
	}

	// Released: the row stays, the old owner's device no longer counts
	// for it, and the name is free (no renames).
	if _, ok, err := ft.db.releaseClaim(ctx, "walter"); err != nil || !ok {
		t.Fatal(ok, err)
	}
	ft.write("L1007001.log", logLine(`"walter<2><ID_1><CT>" killed "Ann<5><ID_5><TERRORIST>" with "ak47"`)+
		logLine(`"Ann<5><ID_5><TERRORIST>" changed name to "Walter"`))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}, "walter": {Kills: 1}, "Ann": {Deaths: 4}, "Walter (guest)": {Kills: 1}})
	if len(console.commands) != 0 {
		t.Errorf("commands after the release: %q", console.commands)
	}

	// Claimed again by hash-b: the guest's device now owns it.
	if err := ft.db.createClaim(ctx, nameClaim{Key: "walter", Name: "WALTER", CodeHash: "y"}, "", "hash-b", now); err != nil {
		t.Fatal(err)
	}
	ft.write("L1007001.log", logLine(`"Walter (guest)<3><ID_2><CT>" changed name to "walter"`)+
		logLine(`"walter<3><ID_2><CT>" killed "Ann<5><ID_5><TERRORIST>" with "m4a1"`)+
		logLine(`"walter<2><ID_1><CT>" killed "Ann<5><ID_5><TERRORIST>" with "ak47"`))
	ft.scan()
	ft.expect(map[string]playerTotals{"Walter": {Kills: 1}, "walter": {Kills: 1}, "WALTER": {Kills: 1}, "Ann": {Deaths: 6}, "Walter (guest)": {Kills: 1}})
	// Now #2 is the one under someone else's name.
	if want := []string{renameCommand(2, "walter (guest)")}; !reflect.DeepEqual(console.commands, want) {
		t.Errorf("commands after the new owner took the name: %q\nwant %q", console.commands, want)
	}
	// #2 leaves before the chat line is due: it isn't sent.
	ft.write("L1007001.log", logLine(`"walter (guest)<2><ID_1><CT>" disconnected`))
	clock = clock.Add(guestMessageDelay)
	console.commands = nil
	ft.scan()
	if len(console.commands) != 0 || len(ft.f.notices) != 0 {
		t.Errorf("chat line to a player who left: %q, %d left", console.commands, len(ft.f.notices))
	}

	// A console error is logged once and doesn't stop the counting.
	var logged []string
	ft.f.logf = func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) }
	console.commands, console.err = nil, errConsoleTimeout
	ft.write("L1007001.log", logLine(`"Bob<7><ID_7><>" entered the game`)+
		logLine(`"Bob<7><ID_7><CT>" changed name to "Walter"`)+
		logLine(`"Cy<8><ID_8><CT>" changed name to "Walter"`))
	ft.scan()
	if len(console.commands) != 2 || len(ft.f.notices) != 0 {
		t.Errorf("commands with a failing console: %q (and %d chat lines)", console.commands, len(ft.f.notices))
	}
	failures := 0
	for _, line := range logged {
		if strings.Contains(line, errConsoleTimeout.Error()) {
			failures++
		}
	}
	if failures != 1 {
		t.Errorf("console errors logged %d times: %q", failures, logged)
	}
	console.err = nil

	// A chat line due in a file that has ended (map change: new userids)
	// is dropped.
	console.commands = nil
	ft.write("L1007001.log", logLine(`"Walter<20><ID_20><>" entered the game`))
	ft.scan()
	ft.write("L1007002.log", fileStart("L1007002.log"))
	clock = clock.Add(guestMessageDelay)
	ft.scan()
	if want := []string{renameCommand(20, "Walter (guest)")}; !reflect.DeepEqual(console.commands, want) || len(ft.f.notices) != 0 {
		t.Errorf("after a map change: %q, %d chat lines left", console.commands, len(ft.f.notices))
	}

	// A file from before the follower started (an engine that is gone):
	// counted by the rules, nobody renamed.
	ft.f.started = time.Now()
	console.commands = nil
	ft.write("L1007002.log", logLine(`"Walter<9><ID_9><>" entered the game`))
	ft.scan()
	if len(console.commands) != 0 {
		t.Errorf("renamed from an old file: %q", console.commands)
	}
}
