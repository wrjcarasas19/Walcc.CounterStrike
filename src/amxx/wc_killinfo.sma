// Kill details for the web page's "Killed by" card.
//
// The victim's game client knows who killed them and with what (DeathMsg),
// but not the killer's health, armour or distance. On every DeathMsg where
// a player killed another player (not themselves, not the world; team kills
// included), this plugin sends the victim the user message WcKillInfo with
// the killer's state at that moment.
//
// Sent only to players whose userinfo has wc_html_hud 1: the page sets it
// when its cs16-client forwards the HTML HUD's server messages (0.0.10+;
// the same key as WcMode in wc_gamemode.sma: both hooks ship in the same
// client release). Everyone else (older clients, the stock HUD, bots)
// never gets WcKillInfo, which their client doesn't hook.
//
// WcKillInfo (registered in plugin_precache, variable size), in this order:
//   long   killer    the killer's userid
//   short  health    the killer's health (0 if they were already dead, e.g.
//                    a grenade thrown before dying), as their HUD shows it
//   short  armor     the killer's armour
//   byte   headshot  1 if the kill was a headshot
//   byte   blind     1 if the killer was fully blinded by a flashbang
//                    (the game's own "killer blind" kill flag: gun kills
//                    only, never knife or grenade)
//   byte   wall      1 if the bullet went through a wall (the game's own
//                    "penetrated" kill flag, and the killer's eyes can't
//                    see the victim's: a bullet that only went through
//                    another player doesn't count)
//   short  distance  killer to victim in metres (units / 39.37, rounded)
//   string weapon    the DeathMsg weapon name ("ak47", "grenade", "knife")
// The client turns it into hudEvent("killinfo", {...}) with these field
// names, killer as killerUserid (web_bridge.h in cs16-client). It comes
// right after the DeathMsg it belongs to (same reliable channel).
//
// The blind and penetrated flags come from ReGameDLL's extended DeathMsg
// (mp_deathmsg_flags with "c", the default "abc"); without them both are 0.
//
// Tests: wc_killinfo_test <userid> <0|1> treats a player (bots too) as
// having wc_html_hud 1; wc_killinfo_status prints the message id and the
// last kills sent, with the killer's HUD health / armour (their last Health
// and Battery messages) next to the values sent, for checking.

#include <amxmodx>
#include <fakemeta>

#define PLUGIN  "Web kill info"
#define VERSION "1.0"
#define AUTHOR  "Walcc"

// ReGameDLL's DeathMsg extension (gamerules.h): after the weapon, a long of
// DeathMessageFlags, then the parts it lists.
#define PLAYERDEATH_POSITION   0x001
#define PLAYERDEATH_ASSISTANT  0x002
#define PLAYERDEATH_KILLRARITY 0x004
#define KILLRARITY_HEADSHOT     0x001
#define KILLRARITY_KILLER_BLIND 0x002
#define KILLRARITY_PENETRATED   0x008

#define UNITS_PER_METRE 39.37
#define HISTORY 8

new g_msgKillInfo
new bool:g_test[MAX_PLAYERS + 1]
// What each player's HUD shows (last Health / Battery message): only for
// wc_killinfo_status, to check the values sent.
new g_hudHealth[MAX_PLAYERS + 1]
new g_hudArmor[MAX_PLAYERS + 1]

// The last HISTORY kills sent (ring buffer), for wc_killinfo_status.
new g_history[HISTORY][192]
new g_historyNext
new g_seen
new g_sent

public plugin_precache()
{
	// Our own message, registered like the game's. Size -1: variable.
	g_msgKillInfo = engfunc(EngFunc_RegUserMsg, "WcKillInfo", -1)
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR)
	// DeathMsg: byte killer, byte victim, byte headshot, string weapon,
	// then ReGameDLL's extension (above).
	register_event("DeathMsg", "OnDeathMsg", "a")
	register_event("Health", "OnHealth", "b")
	register_event("Battery", "OnBattery", "b")
	register_srvcmd("wc_killinfo_status", "CmdStatus")
	register_srvcmd("wc_killinfo_test", "CmdTest")
}

public client_putinserver(id)
{
	g_test[id] = false
	g_hudHealth[id] = 0
	g_hudArmor[id] = 0
}

public OnHealth(id)
{
	g_hudHealth[id] = read_data(1)
}

public OnBattery(id)
{
	g_hudArmor[id] = read_data(1)
}

public OnDeathMsg()
{
	new killer = read_data(1)
	new victim = read_data(2)
	if (killer < 1 || killer > MaxClients || victim < 1 || victim > MaxClients || killer == victim)
		return
	if (!is_user_connected(killer) || !is_user_connected(victim))
		return
	g_seen++
	if (!HtmlHud(victim))
		return

	new weapon[32]
	read_data(4, weapon, charsmax(weapon))
	new headshot = read_data(3) ? 1 : 0
	new rarity = ReadRarity()
	new blind = rarity & KILLRARITY_KILLER_BLIND ? 1 : 0
	new penetrated = rarity & KILLRARITY_PENETRATED ? 1 : 0
	new bool:seen = EyesSee(killer, victim)
	new wall = penetrated && !seen ? 1 : 0

	// As the killer's HUD shows it (the game's Health message: a health
	// between 0 and 1 shows as 1).
	new Float:fHealth
	pev(killer, pev_health, fHealth)
	new health = fHealth > 0.0 && fHealth < 1.0 ? 1 : clamp(floatround(fHealth, floatround_tozero), 0, 32767)
	new Float:fArmor
	pev(killer, pev_armorvalue, fArmor)
	new armor = clamp(floatround(fArmor, floatround_tozero), 0, 32767)

	new Float:from[3], Float:to[3]
	pev(killer, pev_origin, from)
	pev(victim, pev_origin, to)
	new Float:units = get_distance_f(from, to)
	new distance = clamp(floatround(units / UNITS_PER_METRE), 0, 32767)

	message_begin(MSG_ONE, g_msgKillInfo, _, victim)
	write_long(get_user_userid(killer))
	write_short(health)
	write_short(armor)
	write_byte(headshot)
	write_byte(blind)
	write_byte(wall)
	write_short(distance)
	write_string(weapon)
	message_end()
	g_sent++

	new killerName[32], victimName[32]
	get_user_name(killer, killerName, charsmax(killerName))
	get_user_name(victim, victimName, charsmax(victimName))
	formatex(g_history[g_historyNext], charsmax(g_history[]),
		"t=%.1f %s #%d -> %s #%d: hp %d ap %d hs %d blind %d wall %d %dm %s | hud hp %d ap %d, alive %d, rarity 0x%x, eyes see %d, %.0f units",
		get_gametime(), killerName, get_user_userid(killer), victimName, get_user_userid(victim),
		health, armor, headshot, blind, wall, distance, weapon,
		g_hudHealth[killer], g_hudArmor[killer], is_user_alive(killer), rarity, seen, units)
	g_historyNext = (g_historyNext + 1) % HISTORY
}

// The kill rarity bits from ReGameDLL's extended DeathMsg, 0 without them.
ReadRarity()
{
	new count = read_datanum()
	if (count < 5)
		return 0
	new flags = read_data(5)
	if (!(flags & PLAYERDEATH_KILLRARITY))
		return 0
	new arg = 6
	if (flags & PLAYERDEATH_POSITION)
		arg += 3
	if (flags & PLAYERDEATH_ASSISTANT)
		arg++
	return arg <= count ? read_data(arg) : 0
}

// A line from the killer's eyes to the victim's eyes, through players,
// doesn't hit the world (walls, boxes, doors).
bool:EyesSee(killer, victim)
{
	new Float:from[3], Float:to[3], Float:offset[3]
	pev(killer, pev_origin, from)
	pev(killer, pev_view_ofs, offset)
	from[0] += offset[0]
	from[1] += offset[1]
	from[2] += offset[2]
	pev(victim, pev_origin, to)
	pev(victim, pev_view_ofs, offset)
	to[0] += offset[0]
	to[1] += offset[1]
	to[2] += offset[2]
	engfunc(EngFunc_TraceLine, from, to, IGNORE_MONSTERS, killer, 0)
	new Float:fraction
	get_tr2(0, TR_flFraction, fraction)
	return fraction >= 1.0
}

// The player's page draws the HTML HUD with the server's messages
// (userinfo wc_html_hud 1, as in wc_gamemode.sma).
bool:HtmlHud(id)
{
	if (!g_msgKillInfo || !is_user_connected(id))
		return false
	if (g_test[id])
		return true
	if (is_user_bot(id))
		return false
	new value[4]
	get_user_info(id, "wc_html_hud", value, charsmax(value))
	return value[0] == '1' && value[1] == EOS
}

// Server console: the message id, counts, players getting WcKillInfo, and
// the last kills sent (oldest first).
public CmdStatus()
{
	server_print("wc_killinfo: WcKillInfo message id %d, %d player kills seen, %d sent", g_msgKillInfo, g_seen, g_sent)
	new name[32]
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || !HtmlHud(id))
			continue
		get_user_name(id, name, charsmax(name))
		server_print("  gets WcKillInfo: #%d %s%s", get_user_userid(id), name, g_test[id] ? " (test)" : "")
	}
	for (new i = 0; i < HISTORY; i++)
	{
		new slot = (g_historyNext + i) % HISTORY
		if (g_history[slot][0])
			server_print("  %s", g_history[slot])
	}
	return PLUGIN_HANDLED
}

// Server console: wc_killinfo_test <userid> <0|1> (tests: send WcKillInfo
// to that player, a bot too, as if their page had set wc_html_hud 1).
public CmdTest()
{
	new id = read_argc() >= 3 ? find_player("k", read_argv_int(1)) : 0
	if (!id)
	{
		server_print("Usage: wc_killinfo_test <userid> <0|1>")
		return PLUGIN_HANDLED
	}
	g_test[id] = read_argv_int(2) != 0
	server_print("wc_killinfo_test: #%d %d", read_argv_int(1), g_test[id])
	return PLUGIN_HANDLED
}
