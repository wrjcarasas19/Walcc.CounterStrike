package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"

	goxash3d_fwgs "github.com/yohimik/goxash3d-fwgs/pkg"
)

func main() {
	goxash3d_fwgs.DefaultXash3D.RegisterNetCallbacks()

	// The pion logger in sfu.go only prints errors, so this goes to stderr.
	adminPassword := os.Getenv("ADMIN_PASSWORD")
	adminOn := adminPassword != ""
	if problem := adminPasswordProblem(adminPassword); adminOn && problem != "" {
		fmt.Fprintf(os.Stderr, "WARNING: ADMIN_PASSWORD is %s: the admin API is disabled\n", problem)
		adminOn = false
	}

	// Anything but Counter-Strike (the Half-Life LAN server) runs without
	// the parts written for it: admin API, leaderboard, bots (game.go).
	game := gameDir(os.Args)
	cs := game == counterStrike
	if adminOn && !cs {
		fmt.Fprintf(os.Stderr, "The admin API is off: it is written for Counter-Strike and this server runs %s\n", game)
		adminOn = false
	}

	rconPassword := os.Getenv("RCON_PASSWORD")
	args, rcon := engineArgs(os.Args, rconPassword)
	switch {
	case rcon == rconInvalid:
		fmt.Fprintln(os.Stderr, "WARNING: RCON_PASSWORD is not a plain token (letters, digits and _.~!@#%^*=+,:?-, up to 64, starting with a letter or digit): rcon is disabled")
	case rcon == rconUnset && !adminOn && cs:
		fmt.Fprintln(os.Stderr, "WARNING: neither ADMIN_PASSWORD nor RCON_PASSWORD is set: the admin menu is disabled")
	}
	if adminOn && rcon != rconEnabled {
		// The admin API talks rcon to the engine (console.go); without a
		// password of our own, use a random one nobody else knows.
		rconPassword = randomToken()
		args, _ = engineArgs(os.Args, rconPassword)
	}
	// Bans are checked even with the admin API off (they can't be changed
	// then, but a list kept in the data volume still applies).
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	var err error
	if bans, err = loadBanList(filepath.Join(dataDir, bansFile)); err != nil {
		fmt.Fprintf(os.Stderr, "WARNING: can't read the ban list: %v; nobody is banned and bans can't be changed until it is fixed\n", err)
	}

	var admin http.Handler
	var adminCommands *adminAPI
	var console *engineConsole
	if adminOn {
		console = newEngineConsole(rconPassword, queueEnginePacket)
		adminCommands = newAdminAPI(adminPassword, console, actionEnv{
			mapsDir: filepath.Join("cstrike", "maps"),
			bans:    bans,
			peers:   gamePeers{},
		})
		admin = adminCommands
		blockPlayerRcon = true
	} else if rcon == rconEnabled && cs {
		fmt.Fprintln(os.Stderr, "The admin API is off (no valid ADMIN_PASSWORD): the F4 menu uses rcon")
	}

	// YaPB is installed for Counter-Strike only.
	if cs {
		applyBotQuota()
	}

	// The leaderboard reads the game's log files into DATA_DIR (statsdb.go).
	// Logging is only turned on when the database opens.
	includeBots, ok := parseLeaderboardBots(os.Getenv("LEADERBOARD_BOTS"))
	if !ok {
		fmt.Fprintln(os.Stderr, "WARNING: LEADERBOARD_BOTS must be 0 or 1: bots are left out of the leaderboard")
	}
	var leaderboard, duel, names http.Handler
	if !cs {
		// The leaderboard reads Counter-Strike's log lines; /leaderboard,
		// /duel and /names/ are off as when the database can't be opened.
	} else if db, err := openStatsDB(filepath.Join(dataDir, leaderboardFile)); err != nil {
		fmt.Fprintf(os.Stderr, "WARNING: can't open the leaderboard database: %v; /leaderboard, /duel and /names/ are off\n", err)
	} else {
		if console == nil {
			// The log follower renames players under a claimed name they
			// don't own through the console (statsfollow.go). Without the
			// admin API, keep RCON_PASSWORD if there is one; otherwise use
			// a password nobody knows and keep players off rcon.
			if rcon != rconEnabled {
				rconPassword = randomToken()
				args, _ = engineArgs(os.Args, rconPassword)
				blockPlayerRcon = true
			}
			console = newEngineConsole(rconPassword, queueEnginePacket)
		}
		args = withGameLogging(args)
		go newLogFollower(filepath.Join("cstrike", "logs"), db, includeBots, gamePeers{}, console).run(context.Background(), statsScanInterval)
		leaderboard = newLeaderboardHandler(db, includeBots)
		duel = newDuelHandler(db)
		names = newNamesHandler(db)
		if adminCommands != nil {
			// Set before runSFU serves the admin API.
			adminCommands.env.claims = db
		}
	}

	// Server queries for /status.json work without the admin API: they
	// don't use rcon (status.go).
	go runSFU(game, admin, console, newEngineQuery(queueQueryPacket), leaderboard, duel, names)

	// SysStart, but with our arguments instead of os.Args.
	goxash3d_fwgs.DefaultXash3D.HostMain(args, goxash3d_fwgs.GameDir, 0)
}

// applyBotQuota writes BOT_QUOTA into YaPB's config (bots.go).
func applyBotQuota() {
	quota, ok := parseBotQuota(os.Getenv("BOT_QUOTA"))
	if !ok {
		fmt.Fprintf(os.Stderr, "WARNING: BOT_QUOTA must be a whole number from 0 to %d: using 0 (no bots)\n", botQuotaMax)
	}
	baseDir := os.Getenv("XASH3D_BASEDIR")
	if baseDir == "" {
		baseDir = "."
	}
	// No yapb.cfg (a build without YaPB) only matters when bots were asked for.
	if err := writeBotQuota(baseDir, quota); err != nil && (quota > 0 || !errors.Is(err, fs.ErrNotExist)) {
		fmt.Fprintf(os.Stderr, "WARNING: can't set BOT_QUOTA in %s: %v\n", yapbConfPath, err)
	}
}

// randomToken is a random rcon password (hex, so it passes
// rconPasswordPattern).
func randomToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
