// Logs headshot kills for the web server's leaderboard (src/server/statslog.go).
//
// Stock CS 1.6 logs every kill as
//   "Killer<uid><auth><team>" killed "Victim<uid><auth><team>" with "weapon"
// without saying whether it was a headshot. For each headshot kill of one
// player by another, this plugin adds a line in the same format:
//   "Killer<uid><auth><team>" triggered "wc_headshot" against "Victim<uid><auth><team>" with "weapon"
// It comes right before the game's own "killed" line (the game sends the
// DeathMsg first). The Go side decides what counts (enemy kills only, bots
// or not), exactly as it does for the "killed" line.
//
// It also logs name changes, in the stock format the Go side reads:
//   "Old<uid><auth><team>" changed name to "New"
// The game itself writes none on this engine (Xash3D sets the new name
// before the game DLL hears of the change, so ReGameDLL finds nothing
// changed), for a player's own `name` command and amx_nick alike. AMX Mod
// X still knows the old name when the userinfo changes. The log follower
// needs these lines to rename whoever takes a claimed name (claimed names,
// src/server/statsfollow.go).
//
// Names go in as format arguments, never as the format, so a '%' in a name
// is harmless.

#include <amxmodx>

#define PLUGIN  "Web stats log"
#define VERSION "1.1"
#define AUTHOR  "Walcc"

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR)
	// DeathMsg: byte killer, byte victim, byte headshot, string weapon.
	// "3=1" = headshots only.
	register_event("DeathMsg", "on_headshot", "a", "3=1")
}

public on_headshot()
{
	new killer = read_data(1)
	new victim = read_data(2)
	if (killer < 1 || killer > MaxClients || victim < 1 || victim > MaxClients || killer == victim)
		return
	if (!is_user_connected(killer) || !is_user_connected(victim))
		return

	new weapon[32]
	read_data(4, weapon, charsmax(weapon))

	new killerName[64], killerAuth[64], killerTeam[32]
	new victimName[64], victimAuth[64], victimTeam[32]
	get_user_name(killer, killerName, charsmax(killerName))
	get_user_authid(killer, killerAuth, charsmax(killerAuth))
	get_user_team(killer, killerTeam, charsmax(killerTeam))
	get_user_name(victim, victimName, charsmax(victimName))
	get_user_authid(victim, victimAuth, charsmax(victimAuth))
	get_user_team(victim, victimTeam, charsmax(victimTeam))

	log_message("^"%s<%d><%s><%s>^" triggered ^"wc_headshot^" against ^"%s<%d><%s><%s>^" with ^"%s^"",
		killerName, get_user_userid(killer), killerAuth, killerTeam,
		victimName, get_user_userid(victim), victimAuth, victimTeam,
		weapon)
}

public client_infochanged(id)
{
	if (!is_user_connected(id))
		return

	new oldName[64], newName[64]
	get_user_name(id, oldName, charsmax(oldName))
	get_user_info(id, "name", newName, charsmax(newName))
	if (newName[0] == EOS || equal(oldName, newName))
		return

	// Like the game's lines: no team is "", not "UNASSIGNED".
	new auth[64], team[32]
	get_user_authid(id, auth, charsmax(auth))
	if (!get_user_team(id, team, charsmax(team)))
		team[0] = EOS
	log_message("^"%s<%d><%s><%s>^" changed name to ^"%s^"",
		oldName, get_user_userid(id), auth, team, newName)
}
