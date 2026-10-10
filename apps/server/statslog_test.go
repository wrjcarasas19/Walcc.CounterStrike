package main

import (
	"reflect"
	"testing"
)

func TestParseLogLine(t *testing.T) {
	bot := func(name string, id int, team string) logPlayer {
		return logPlayer{Name: name, UserID: id, Auth: "BOT", Team: team}
	}
	idBot := func(name string, id int, team string) logPlayer {
		return logPlayer{Name: name, UserID: id, Auth: "ID_BOT", Team: team}
	}
	human := func(name string, id int, team string) logPlayer {
		return logPlayer{Name: name, UserID: id, Auth: "ID_1a2b3c", Team: team}
	}
	for _, tc := range []struct {
		line string
		want logEvent
	}{
		// Real lines from the image (Xash3D writes no "L " in front).
		{`10/06/2026 - 15:33:31: "RAGE OF THE BOY<4><BOT><CT>" killed "Gilroy<3><BOT><TERRORIST>" with "usp"`,
			logEvent{Kind: logKill, Player: bot("RAGE OF THE BOY", 4, "CT"), Victim: bot("Gilroy", 3, "TERRORIST"), Weapon: "usp"}},
		{`10/06/2026 - 15:33:31: "Savage|420|<1><BOT><CT>" killed "Hextor<6><BOT><TERRORIST>" with "deagle"`,
			logEvent{Kind: logKill, Player: bot("Savage|420|", 1, "CT"), Victim: bot("Hextor", 6, "TERRORIST"), Weapon: "deagle"}},
		{`10/06/2026 - 15:40:10: "The<Boss> <3><22><BOT><TERRORIST>" killed "a<1><BOT><CT> b<24><BOT><CT>" with "glock18"`,
			logEvent{Kind: logKill, Player: bot("The<Boss> <3>", 22, "TERRORIST"), Victim: bot("a<1><BOT><CT> b", 24, "CT"), Weapon: "glock18"}},
		{`10/06/2026 - 15:40:10: "The<Boss> <3><22><ID_BOT><TERRORIST>" triggered "wc_headshot" against "a<1><BOT><CT> b<24><ID_BOT><CT>" with "glock18"`,
			logEvent{Kind: logHeadshot, Player: idBot("The<Boss> <3>", 22, "TERRORIST"), Victim: idBot("a<1><BOT><CT> b", 24, "CT"), Weapon: "glock18"}},
		{`10/06/2026 - 15:40:12: "funk<19><BOT><TERRORIST>" killed "shooterman<23><BOT><TERRORIST>" with "knife"`,
			logEvent{Kind: logKill, Player: bot("funk", 19, "TERRORIST"), Victim: bot("shooterman", 23, "TERRORIST"), Weapon: "knife"}},
		{`10/06/2026 - 15:39:04: "100% sure<21><BOT><CT>" committed suicide with "world"`,
			logEvent{Kind: logSuicide, Player: bot("100% sure", 21, "CT"), Weapon: "world"}},
		{`10/06/2026 - 15:33:02: "Savage|420|<1><BOT><>" joined team "CT"`,
			logEvent{Kind: logJoinedTeam, Player: bot("Savage|420|", 1, ""), Value: "CT"}},
		{`10/06/2026 - 15:33:02: "Savage|420|<1><BOT><>" entered the game`,
			logEvent{Kind: logEntered, Player: bot("Savage|420|", 1, "")}},
		{`10/06/2026 - 15:33:06: "phobos<2><BOT><TERRORIST>" triggered "Spawned_With_The_Bomb"`,
			logEvent{Kind: logPlayerOther, Player: bot("phobos", 2, "TERRORIST")}},
		{`10/06/2026 - 15:40:10: "a<1><BOT><CT> b<24><BOT><CT>" say "Will they stop camping now? Only 00:10 left!!" (dead)`,
			logEvent{Kind: logPlayerOther, Player: bot("a<1><BOT><CT> b", 24, "CT")}},
		{`10/06/2026 - 15:33:06: World triggered "Round_Start"`, logEvent{Kind: logRoundStart}},
		{`10/06/2026 - 15:34:02: World triggered "Round_End"` + "\r\n", logEvent{Kind: logRoundEnd}},
		// GoldSrc style, humans, and names with quotes (the engine here
		// refuses '"' in userinfo, but other servers' logs may have them).
		{`L 10/06/2026 - 12:34:56: "Mr "Q" <x><7><ID_1a2b3c><CT>" killed "x" killed "y<3><BOT><TERRORIST>" with "ak47"`,
			logEvent{Kind: logKill, Player: human(`Mr "Q" <x>`, 7, "CT"), Victim: bot(`x" killed "y`, 3, "TERRORIST"), Weapon: "ak47"}},
		{`10/06/2026 - 12:34:56: "Walter<7><ID_1a2b3c><CT>" changed name to "Walter "W" <2>"`,
			logEvent{Kind: logChangedName, Player: human("Walter", 7, "CT"), Value: `Walter "W" <2>`}},
		{`10/06/2026 - 12:34:56: "Walter<7><ID_1a2b3c><CT>" disconnected`,
			logEvent{Kind: logDisconnected, Player: human("Walter", 7, "CT")}},
		// A fall death (killed by the world), real line from the image.
		{`10/07/2026 - 00:44:51: "wind<18><BOT><CT>" committed suicide with "worldspawn" (world)`,
			logEvent{Kind: logSuicide, Player: bot("wind", 18, "CT"), Weapon: "worldspawn"}},
		{`10/07/2026 - 00:44:51: "a (world)<18><BOT><CT>" committed suicide with "x" (world)` + "\r\n",
			logEvent{Kind: logSuicide, Player: bot("a (world)", 18, "CT"), Weapon: "x"}},
		{`10/06/2026 - 12:34:56: "<7><ID_1a2b3c><SPECTATOR>" committed suicide with "worldspawn"`,
			logEvent{Kind: logSuicide, Player: human("", 7, "SPECTATOR"), Weapon: "worldspawn"}},
		// Gun Game win (wc_gamemode.amxx): AMXX writes ID_BOT for bots.
		{`10/07/2026 - 01:12:40: "Walter<7><ID_1a2b3c><CT>" triggered "wc_gg_win"`,
			logEvent{Kind: logGunGameWin, Player: human("Walter", 7, "CT")}},
		{`10/07/2026 - 01:12:40: "x" triggered "wc_gg_win<3><ID_BOT><TERRORIST>" triggered "wc_gg_win"` + "\r\n",
			logEvent{Kind: logGunGameWin, Player: idBot(`x" triggered "wc_gg_win`, 3, "TERRORIST")}},
		// Not a win: something else after it.
		{`10/07/2026 - 01:12:40: "Walter<7><ID_1a2b3c><CT>" triggered "wc_gg_win" (level "24")`,
			logEvent{Kind: logPlayerOther, Player: human("Walter", 7, "CT")}},
		{`10/07/2026 - 01:12:40: "Walter<7><ID_1a2b3c><CT>" triggered "wc_gg_winner"`,
			logEvent{Kind: logPlayerOther, Player: human("Walter", 7, "CT")}},
		{`10/06/2026 - 15:39:19: Server shutdown`, logEvent{Kind: logShutdown}},
		// Connections, real lines from the image (E.3): the engine writes
		// the slot index where the auth goes; a browser player has the
		// SFU's made-up address, a bot "local".
		{`10/07/2026 - 12:11:18: "Capture<3><2><>" connected, address "0.84.74.120:12345"`,
			logEvent{Kind: logConnected, Player: logPlayer{Name: "Capture", UserID: 3, Auth: "2"}, Value: "0.84.74.120:12345"}},
		{`10/07/2026 - 12:09:30: "Ender Wiggin<2><1><>" connected, address "local"`,
			logEvent{Kind: logConnected, Player: logPlayer{Name: "Ender Wiggin", UserID: 2, Auth: "1"}, Value: "local"}},
		{`10/07/2026 - 12:11:18: "a<1><2><> b<3><2><>" connected, address "0.84.74.120:12345"` + "\r\n",
			logEvent{Kind: logConnected, Player: logPlayer{Name: "a<1><2><> b", UserID: 3, Auth: "2"}, Value: "0.84.74.120:12345"}},
	} {
		got, ok := parseLogLine(tc.line)
		if !ok || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("parseLogLine(%q)\n got %+v, %v\nwant %+v", tc.line, got, ok, tc.want)
		}
	}
}

func TestParseLogLineIgnored(t *testing.T) {
	for _, line := range []string{
		"",
		`10/06/2026 - 15:32:52: Log file started (file "logs/L1006000.log") (game "") (version "49/0.21/3772")`,
		`10/06/2026 - 15:33:02: Server cvar "mp_roundtime" = "1"`,
		`10/06/2026 - 15:33:03: World triggered "Game_Commencing" (CT "1") (T "0")`,
		`10/06/2026 - 15:39:19: Team "CT" scored "0" with "3" players`,
		`10/06/2026 - 15:39:19: World triggered "Restart_Round_(1_second)"`,
		`10/06/2026 - 15:39:20: Rcon: "rcon secret status" from "254.0.0.1:12345"`,
		// No date, broken date, cut-off line.
		`"a<1><BOT><CT>" killed "b<2><BOT><TERRORIST>" with "usp"`,
		`10/06/26 - 15:33:31: "a<1><BOT><CT>" killed "b<2><BOT><TERRORIST>" with "usp"`,
		`10/06/2026 - 15:33:31: "a<1><BOT><CT>" killed "b<2><BOT><TERR`,
		`10/06/2026 - 15:33:31: "a<x><BOT><CT>" killed "b<2><BOT><TERRORIST>" with "usp"`,
		`10/07/2026 - 00:44:51: "a<1><BOT><CT>" committed suicide with "worldspawn" (other)`,
	} {
		if ev, ok := parseLogLine(line); ok {
			t.Errorf("parseLogLine(%q) = %+v, want ignored", line, ev)
		}
	}
}

func TestLogAddressIP(t *testing.T) {
	for address, want := range map[string][4]byte{
		"0.84.74.120:12345": {0, 84, 74, 120},
		"3.1.2.3:27005":     {3, 1, 2, 3},
	} {
		if got, ok := logAddressIP(address); !ok || got != want {
			t.Errorf("logAddressIP(%q) = %v, %v; want %v", address, got, ok, want)
		}
	}
	for _, address := range []string{"local", "", "loopback", "0.84.74.120", "[::1]:27005", "1.2.3:4", "1.2.3.4:x", "1.2.3.4:5 "} {
		if got, ok := logAddressIP(address); ok {
			t.Errorf("logAddressIP(%q) = %v, want not ok", address, got)
		}
	}
}

func TestLogPlayerBot(t *testing.T) {
	for auth, want := range map[string]bool{"BOT": true, "ID_BOT": true, "ID_1a2b": false, "STEAM_0:1:2": false, "": false} {
		if got := (logPlayer{Auth: auth}).bot(); got != want {
			t.Errorf("bot() with auth %q = %v", auth, got)
		}
	}
}
