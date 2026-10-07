package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	_ "github.com/mattn/go-sqlite3" // database/sql driver "sqlite3" (cgo)
)

// statsDB keeps the leaderboard totals per player name in SQLite
// (DATA_DIR/leaderboard.db) together with how far each log file was read.
// It also keeps how many times each name killed each other name (duels, for
// GET /duel). Totals, duels and read offsets change in the same
// transaction, so a restart neither counts a line twice nor skips one.

const leaderboardFile = "leaderboard.db"

type statsDB struct {
	db *sql.DB
}

// playerTotals are one player's counters, or the change to add to them.
type playerTotals struct {
	Kills     int64
	Deaths    int64
	Headshots int64
	TeamKills int64
	Suicides  int64
	Rounds    int64
	// GunGameWins are Gun Game games won (wc_gg_win).
	GunGameWins int64
}

func (t playerTotals) zero() bool {
	return t == playerTotals{}
}

// logFileRecord is how far one log file was read. Fingerprint tells a file
// apart from a later one with the same name (names restart from L<date>000
// in a new container).
type logFileRecord struct {
	Fingerprint string
	Offset      int64
}

// duelPair is a killer and the enemy they killed, by name.
type duelPair struct {
	Killer string
	Victim string
}

type leaderboardRow struct {
	Name string
	playerTotals
	LastSeen time.Time
}

const statsSchema = `
CREATE TABLE IF NOT EXISTS players (
	name TEXT PRIMARY KEY,
	kills INTEGER NOT NULL DEFAULT 0,
	deaths INTEGER NOT NULL DEFAULT 0,
	headshots INTEGER NOT NULL DEFAULT 0,
	teamkills INTEGER NOT NULL DEFAULT 0,
	suicides INTEGER NOT NULL DEFAULT 0,
	rounds INTEGER NOT NULL DEFAULT 0,
	last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS players_by_kills ON players (kills DESC, deaths ASC, name ASC);
CREATE TABLE IF NOT EXISTS log_files (
	name TEXT PRIMARY KEY,
	fingerprint TEXT NOT NULL,
	read_offset INTEGER NOT NULL
);
`

// statsMigrations change the schema above, in order. The database's
// PRAGMA user_version is how many of them it has had (0: a database from
// before migrations, or a new one), so each runs once. Only add to the end.
var statsMigrations = []string{
	// 1: Gun Game wins (wc_gamemode.amxx's wc_gg_win line).
	`ALTER TABLE players ADD COLUMN gg_wins INTEGER NOT NULL DEFAULT 0`,
	// 2: head-to-head kills (GET /duel): how many times killer killed
	// victim (an enemy). Starts empty: older logs are gone.
	`CREATE TABLE duels (
	killer TEXT NOT NULL,
	victim TEXT NOT NULL,
	kills INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (killer, victim)
)`,
	// 3: claimed names (names.go). claims: one row per claimed name, keyed
	// by nameKey, with the spelling it was claimed as and the SHA-256 of
	// its recovery code. devices: the browsers signed in to a claim, by
	// the SHA-256 of their wc_player cookie.
	`CREATE TABLE claims (
	name_key TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	code_hash TEXT NOT NULL,
	created INTEGER NOT NULL
);
CREATE TABLE devices (
	token_hash TEXT PRIMARY KEY,
	name_key TEXT NOT NULL,
	created INTEGER NOT NULL,
	last_seen INTEGER NOT NULL
);
CREATE INDEX devices_by_name ON devices (name_key)`,
}

func openStatsDB(path string) (*statsDB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	// One connection: SQLite has a single writer anyway, and this keeps
	// _txlock / busy handling simple. WAL lets readers go on during a write.
	db, err := sql.Open("sqlite3", "file:"+path+"?_journal_mode=WAL&_busy_timeout=5000&_txlock=immediate")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(statsSchema); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateStatsDB(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrating %s: %w", path, err)
	}
	return &statsDB{db: db}, nil
}

// migrateStatsDB runs the migrations the database hasn't had, in one
// transaction with the new version. A database from a newer build (a higher
// version) is left as it is: its extra columns have defaults.
func migrateStatsDB(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	var version int
	if err := tx.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version >= len(statsMigrations) {
		return nil
	}
	for i := version; i < len(statsMigrations); i++ {
		if _, err := tx.Exec(statsMigrations[i]); err != nil {
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
	}
	// PRAGMA takes no bound parameters; the value is an int.
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, len(statsMigrations))); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *statsDB) Close() error {
	return s.db.Close()
}

// logFiles returns every log file read so far.
func (s *statsDB) logFiles(ctx context.Context) (map[string]logFileRecord, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name, fingerprint, read_offset FROM log_files`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	files := map[string]logFileRecord{}
	for rows.Next() {
		var name string
		var r logFileRecord
		if err := rows.Scan(&name, &r.Fingerprint, &r.Offset); err != nil {
			return nil, err
		}
		files[name] = r
	}
	return files, rows.Err()
}

// commit adds deltas to the totals and duels (kills per pair) to the duels,
// and records the log file's new offset, all or nothing.
func (s *statsDB) commit(ctx context.Context, file string, rec logFileRecord, deltas map[string]playerTotals, duels map[duelPair]int64, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit

	names := make([]string, 0, len(deltas))
	for name, d := range deltas {
		if !d.zero() {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	if len(names) > 0 {
		stmt, err := tx.PrepareContext(ctx, `
INSERT INTO players (name, kills, deaths, headshots, teamkills, suicides, rounds, gg_wins, last_seen)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (name) DO UPDATE SET
	kills = kills + excluded.kills,
	deaths = deaths + excluded.deaths,
	headshots = headshots + excluded.headshots,
	teamkills = teamkills + excluded.teamkills,
	suicides = suicides + excluded.suicides,
	rounds = rounds + excluded.rounds,
	gg_wins = gg_wins + excluded.gg_wins,
	last_seen = MAX(last_seen, excluded.last_seen)`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, name := range names {
			d := deltas[name]
			if _, err := stmt.ExecContext(ctx, name, d.Kills, d.Deaths, d.Headshots, d.TeamKills, d.Suicides, d.Rounds, d.GunGameWins, at.Unix()); err != nil {
				return err
			}
		}
	}
	pairs := make([]duelPair, 0, len(duels))
	for p, n := range duels {
		if n != 0 {
			pairs = append(pairs, p)
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].Killer != pairs[j].Killer {
			return pairs[i].Killer < pairs[j].Killer
		}
		return pairs[i].Victim < pairs[j].Victim
	})
	if len(pairs) > 0 {
		stmt, err := tx.PrepareContext(ctx, `
INSERT INTO duels (killer, victim, kills) VALUES (?, ?, ?)
ON CONFLICT (killer, victim) DO UPDATE SET kills = kills + excluded.kills`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, p := range pairs {
			if _, err := stmt.ExecContext(ctx, p.Killer, p.Victim, duels[p]); err != nil {
				return err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO log_files (name, fingerprint, read_offset) VALUES (?, ?, ?)
ON CONFLICT (name) DO UPDATE SET fingerprint = excluded.fingerprint, read_offset = excluded.read_offset`,
		file, rec.Fingerprint, rec.Offset); err != nil {
		return err
	}
	return tx.Commit()
}

// forgetLogFile drops a file's record (the file is gone).
func (s *statsDB) forgetLogFile(ctx context.Context, file string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM log_files WHERE name = ?`, file)
	return err
}

// top returns up to limit players by kills (then fewer deaths, then name).
func (s *statsDB) top(ctx context.Context, limit int) ([]leaderboardRow, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT name, kills, deaths, headshots, teamkills, suicides, rounds, gg_wins, last_seen
FROM players ORDER BY kills DESC, deaths ASC, name ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []leaderboardRow{}
	for rows.Next() {
		var r leaderboardRow
		var seen int64
		if err := rows.Scan(&r.Name, &r.Kills, &r.Deaths, &r.Headshots, &r.TeamKills, &r.Suicides, &r.Rounds, &r.GunGameWins, &seen); err != nil {
			return nil, err
		}
		r.LastSeen = time.Unix(seen, 0).UTC()
		list = append(list, r)
	}
	return list, rows.Err()
}

// duel returns how many times a killed b and b killed a (enemy kills).
func (s *statsDB) duel(ctx context.Context, a, b string) (aKills, bKills int64, err error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT killer, kills FROM duels
WHERE (killer = ? AND victim = ?) OR (killer = ? AND victim = ?)`, a, b, b, a)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var killer string
		var kills int64
		if err := rows.Scan(&killer, &kills); err != nil {
			return 0, 0, err
		}
		if killer == a {
			aKills = kills
		} else {
			bKills = kills
		}
	}
	return aKills, bKills, rows.Err()
}
