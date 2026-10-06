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
// Names go in as format arguments, never as the format, so a '%' in a name
// is harmless.

#include <amxmodx>

#define PLUGIN  "Web stats log"
#define VERSION "1.0"
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
