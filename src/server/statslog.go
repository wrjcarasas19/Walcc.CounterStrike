package main

import (
	"regexp"
	"strconv"
	"strings"
)

// Parsing of the game's log lines (Half-Life log format) for the leaderboard.
//
// The engine (FWGS sv_log.c) writes cstrike/logs/LMMDDNNN.log, a new file on
// every map load, one write() per line:
//
//	10/06/2026 - 15:33:31: "RAGE OF THE BOY<4><BOT><CT>" killed "Gilroy<3><BOT><TERRORIST>" with "usp"
//
// (GoldSrc puts "L " in front of the date; Xash3D doesn't. Both are read.)
// A player is "Name<userid><auth><team>": auth is "BOT" for bots in the
// game's lines ("ID_BOT" in the engine's), team is TERRORIST, CT, SPECTATOR
// or empty. Names are chosen by the player and may contain quotes, '<' and
// '>', so the player is read from the right: the name is everything before
// the last "<userid><auth><team>" that still lets the rest of the line
// match. A name that itself contains such a suffix followed by the rest of a
// line can be misread; nothing can tell those apart.
//
// Lines used (CS 1.6 mp.dll, plus wc_statslog.amxx for headshots):
//
//	"K<..>" killed "V<..>" with "weapon"
//	"V<..>" committed suicide with "weapon"
//	"K<..>" triggered "wc_headshot" against "V<..>" with "weapon"
//	"P<..>" joined team "CT"
//	"P<..>" changed name to "New name"
//	"P<..>" entered the game / disconnected
//	World triggered "Round_Start" / "Round_End"
//	Log file started / Server shutdown

type logEventKind int

const (
	logKill logEventKind = iota + 1
	logSuicide
	logHeadshot
	logJoinedTeam
	logChangedName
	logEntered
	logDisconnected
	logRoundStart
	logRoundEnd
	logShutdown
	logPlayerOther // any other line about one player (keeps their team current)
)

// logPlayer is one "Name<userid><auth><team>".
type logPlayer struct {
	Name   string
	UserID int
	Auth   string
	Team   string
}

func (p logPlayer) bot() bool {
	return p.Auth == "BOT" || p.Auth == "ID_BOT"
}

// playing is true on the terrorist or CT side.
func (p logPlayer) playing() bool {
	return p.Team == "TERRORIST" || p.Team == "CT"
}

type logEvent struct {
	Kind   logEventKind
	Player logPlayer // killer, or the player the line is about
	Victim logPlayer // logKill, logHeadshot
	Weapon string
	Value  string // new team (logJoinedTeam), new name (logChangedName)
}

const (
	logPlayerPattern = `"(.*)<(-?[0-9]{1,10})><([^<>"]*)><([^<>"]*)>"`
	// logStampPattern is the date in front of every line.
	logStampPattern = `^(?:L )?[0-9]{2}/[0-9]{2}/[0-9]{4} - [0-9]{2}:[0-9]{2}:[0-9]{2}: `
)

var (
	logStampRe      = regexp.MustCompile(logStampPattern)
	logKillRe       = regexp.MustCompile(`^` + logPlayerPattern + ` killed ` + logPlayerPattern + ` with "([^"]*)"$`)
	logHeadshotRe   = regexp.MustCompile(`^` + logPlayerPattern + ` triggered "wc_headshot" against ` + logPlayerPattern + ` with "([^"]*)"$`)
	logSuicideRe    = regexp.MustCompile(`^` + logPlayerPattern + ` committed suicide with "([^"]*)"$`)
	logTeamRe       = regexp.MustCompile(`^` + logPlayerPattern + ` joined team "([^"]*)"$`)
	logNameRe       = regexp.MustCompile(`^` + logPlayerPattern + ` changed name to "(.*)"$`)
	logEnteredRe    = regexp.MustCompile(`^` + logPlayerPattern + ` entered the game$`)
	logDisconnectRe = regexp.MustCompile(`^` + logPlayerPattern + ` disconnected`)
	// Other lines about one player (bomb events, chat). Not "connected":
	// the engine writes that one with the slot where the auth goes.
	logOtherRe = regexp.MustCompile(`^"(.*?)<(-?[0-9]{1,10})><([^<>"]*)><([^<>"]*)>" (?:triggered|say|say_team) `)
)

// parseLogLine reads one line (without the newline). ok is false for lines
// the leaderboard doesn't use.
func parseLogLine(line string) (logEvent, bool) {
	line = strings.TrimRight(line, "\r\n")
	stamp := logStampRe.FindString(line)
	if stamp == "" {
		return logEvent{}, false
	}
	body := line[len(stamp):]

	switch body {
	case `World triggered "Round_Start"`:
		return logEvent{Kind: logRoundStart}, true
	case `World triggered "Round_End"`:
		return logEvent{Kind: logRoundEnd}, true
	case "Server shutdown":
		return logEvent{Kind: logShutdown}, true
	}
	if !strings.HasPrefix(body, `"`) {
		return logEvent{}, false
	}

	if m := logKillRe.FindStringSubmatch(body); m != nil {
		return logEvent{Kind: logKill, Player: logPlayerFrom(m[1:5]), Victim: logPlayerFrom(m[5:9]), Weapon: m[9]}, true
	}
	if m := logHeadshotRe.FindStringSubmatch(body); m != nil {
		return logEvent{Kind: logHeadshot, Player: logPlayerFrom(m[1:5]), Victim: logPlayerFrom(m[5:9]), Weapon: m[9]}, true
	}
	if m := logSuicideRe.FindStringSubmatch(body); m != nil {
		return logEvent{Kind: logSuicide, Player: logPlayerFrom(m[1:5]), Weapon: m[5]}, true
	}
	if m := logTeamRe.FindStringSubmatch(body); m != nil {
		return logEvent{Kind: logJoinedTeam, Player: logPlayerFrom(m[1:5]), Value: m[5]}, true
	}
	if m := logNameRe.FindStringSubmatch(body); m != nil {
		return logEvent{Kind: logChangedName, Player: logPlayerFrom(m[1:5]), Value: m[5]}, true
	}
	if m := logEnteredRe.FindStringSubmatch(body); m != nil {
		return logEvent{Kind: logEntered, Player: logPlayerFrom(m[1:5])}, true
	}
	if m := logDisconnectRe.FindStringSubmatch(body); m != nil {
		return logEvent{Kind: logDisconnected, Player: logPlayerFrom(m[1:5])}, true
	}
	if m := logOtherRe.FindStringSubmatch(body); m != nil {
		return logEvent{Kind: logPlayerOther, Player: logPlayerFrom(m[1:5])}, true
	}
	return logEvent{}, false
}

func logPlayerFrom(m []string) logPlayer {
	id, _ := strconv.Atoi(m[1])
	return logPlayer{Name: m[0], UserID: id, Auth: m[2], Team: m[3]}
}
