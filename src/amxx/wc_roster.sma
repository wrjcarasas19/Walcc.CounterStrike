// Who is on which team and alive, for the web server's voice chat
// (src/server/voice_roster.go). Go runs the server command `wc_roster`
// through its in-process rcon (console.go) while anyone is in voice, and
// decides from it who hears whom (the CS 1.6 rules).
//
// Output, first a line with the server's settings, then one line per
// connected human (bots and players still connecting are left out):
//   alltalk <0|1> intermission <0|1> voiceenable <0|1> wc_voice_all <0|1>
//   <ip:port> <userid> <T|CT|SPEC> <alive 0|1>
//
// - ip is the address the engine knows the player by: on this server the
//   fake address the Go side gave the player's connection.
// - A player who hasn't picked a team yet is reported as SPEC.
// - alltalk is sv_alltalk (any non-zero value is 1), voiceenable is
//   sv_voiceenable. intermission is 1 from the game's intermission (the
//   scoreboard at the end of a map) until the next map loads the plugin
//   again.
// - wc_voice_all is this plugin's cvar (default 1): 0 makes the page's
//   talk-to-all key talk to the team only (the server treats "all" as
//   "team"). Plugin cvars keep their value over map changes.
//
// Nothing here comes from player-supplied text except through %d / %s
// arguments, so a name can't break a line (names aren't printed at all).

#include <amxmodx>
#include <cstrike>

#define PLUGIN  "Web voice roster"
#define VERSION "1.1"
#define AUTHOR  "Walcc"

new g_pAlltalk
new g_pVoiceEnable
new g_pVoiceAll
// Set by the intermission message; plugin_init runs again on the next map.
new bool:g_intermission

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR)
	g_pAlltalk = get_cvar_pointer("sv_alltalk")
	g_pVoiceEnable = get_cvar_pointer("sv_voiceenable")
	g_pVoiceAll = register_cvar("wc_voice_all", "1")
	// SVC_INTERMISSION (30), sent to everyone when the map ends.
	register_event("30", "OnIntermission", "a")
	register_srvcmd("wc_roster", "CmdRoster")
}

public OnIntermission()
{
	g_intermission = true
}

public CmdRoster()
{
	new alltalk = g_pAlltalk ? get_pcvar_num(g_pAlltalk) : 0
	new voiceEnable = g_pVoiceEnable ? get_pcvar_num(g_pVoiceEnable) : 1
	new voiceAll = get_pcvar_num(g_pVoiceAll)
	server_print("alltalk %d intermission %d voiceenable %d wc_voice_all %d", alltalk != 0, g_intermission, voiceEnable != 0, voiceAll != 0)

	new players[32], count, ip[32]
	// c: no bots, h: no HLTV. Connecting players aren't listed without i.
	get_players(players, count, "ch")
	for (new i = 0; i < count; i++)
	{
		new id = players[i]
		get_user_ip(id, ip, charsmax(ip))
		new team[5]
		switch (cs_get_user_team(id))
		{
			case CS_TEAM_T: copy(team, charsmax(team), "T")
			case CS_TEAM_CT: copy(team, charsmax(team), "CT")
			default: copy(team, charsmax(team), "SPEC")
		}
		server_print("%s %d %s %d", ip, get_user_userid(id), team, is_user_alive(id) ? 1 : 0)
	}
	return PLUGIN_HANDLED
}
