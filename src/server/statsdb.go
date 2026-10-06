package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"sort"
	"time"

	_ "github.com/mattn/go-sqlite3" // database/sql driver "sqlite3" (cgo)
)

// statsDB keeps the leaderboard totals per player name in SQLite
// (DATA_DIR/leaderboard.db) together with how far each log file was read.
// Totals and read offsets change in the same transaction, so a restart
// neither counts a line twice nor skips one.

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
	return &statsDB{db: db}, nil
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

// commit adds deltas to the totals and records the log file's new offset,
// all or nothing.
func (s *statsDB) commit(ctx context.Context, file string, rec logFileRecord, deltas map[string]playerTotals, at time.Time) error {
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
INSERT INTO players (name, kills, deaths, headshots, teamkills, suicides, rounds, last_seen)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (name) DO UPDATE SET
	kills = kills + excluded.kills,
	deaths = deaths + excluded.deaths,
	headshots = headshots + excluded.headshots,
	teamkills = teamkills + excluded.teamkills,
	suicides = suicides + excluded.suicides,
	rounds = rounds + excluded.rounds,
	last_seen = MAX(last_seen, excluded.last_seen)`)
		if err != nil {
			return err
		}
		defer stmt.Close()
		for _, name := range names {
			d := deltas[name]
			if _, err := stmt.ExecContext(ctx, name, d.Kills, d.Deaths, d.Headshots, d.TeamKills, d.Suicides, d.Rounds, at.Unix()); err != nil {
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
SELECT name, kills, deaths, headshots, teamkills, suicides, rounds, last_seen
FROM players ORDER BY kills DESC, deaths ASC, name ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []leaderboardRow{}
	for rows.Next() {
		var r leaderboardRow
		var seen int64
		if err := rows.Scan(&r.Name, &r.Kills, &r.Deaths, &r.Headshots, &r.TeamKills, &r.Suicides, &r.Rounds, &seen); err != nil {
			return nil, err
		}
		r.LastSeen = time.Unix(seen, 0).UTC()
		list = append(list, r)
	}
	return list, rows.Err()
}
