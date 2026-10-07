// Game modes for the web server's admin menu: Gun Game and Deathmatch.
//
// cvar wc_gamemode: 0 = classic (normal game), 1 = Gun Game, 2 = Deathmatch.
//
// The cvar goes back to 0 on every map change (plugin_init runs once per
// map) and is kept over sv_restart. Like wc_weaponmode, the plugin polls it
// once a second (AMX Mod X on Xash3D can't hook cvars). When it changes:
//
// - the game's cvars for the mode are set (MODE_CVARS below: ReGameDLL's
//   respawn and endless round cvars, and the mode's equipment), or put back
//   to their classic values when going back to 0;
// - a game mode turns the weapon mode off (wc_weaponmode 0); the weapon mode
//   plugin also ignores wc_weaponmode while wc_gamemode isn't 0;
// - everyone is told in chat and the game restarts (sv_restart 1), unless
//   someone else restarts it (below).
//
// One restart, whoever asks for it: the Match tab presets set wc_gamemode
// and then send their own sv_restart 1. The game reads sv_restart only
// once a second and restarts a second after that, so two sv_restarts sent
// a moment apart can restart the round twice, a second apart. So:
//
// - The plugin hooks the game's "Restart_Round_" log line, written when a
//   restart is scheduled (from any source: Match tab, admin API, console).
//   A changed wc_gamemode is applied right there, before that restart.
// - It doesn't send its own sv_restart while a restart is scheduled (until
//   the new round, at most RESTART_PENDING_MAX seconds).
// - Otherwise it waits RESTART_GRACE seconds first, and sends nothing if a
//   restart was scheduled meanwhile (the preset's sv_restart, sent right
//   after wc_gamemode, is seen up to a second late).
//
// The mode cvars outlive the map like wc_gamemode itself, so on a map change
// that ends a mode (wc_gamemode was not 0 when the new map's plugin_init
// ran), they are put back to the classic values here too. A map that didn't
// run a mode leaves them alone, so values set in server.cfg are kept.
//
// Both modes (Gun Game and Deathmatch):
//
// - Respawn 1 s after death, rounds never end (ReGameDLL cvars).
// - Map objectives are off: no C4 (mp_give_player_c4 0), hostages hidden
//   the way the game hides a rescued one (a round restart, e.g. going back
//   to classic, brings them back), bots ignore objectives
//   (yb_ignore_objectives). Bomb sites stay but do nothing without a C4.
//   Hostages aren't removed: ReGameDLL's hostage manager keeps pointers to
//   them.
// - The map's "game_playerspawn" target (awp_india: strip and give an AWP
//   1 s after each spawn) is switched off, and back on in classic mode.
// - Random spawns: any info_player_start / info_player_deathmatch, chosen so
//   that no enemy is within 300 units or can see the spot, if possible.
// - Spawn protection (ReGameDLL mp_respawn_immunitytime, ended early by
//   shooting: mp_respawn_immunity_force_unset 2) shows as a glow in the
//   team's colour.
//
// Deathmatch only:
//
// - Guns menu on spawn: same as last time, same every time (until "say
//   guns"), or a new primary and pistol. Full armour, an HE and two
//   flashbangs come from ReGameDLL (mp_free_armor, mp_*_default_grenades).
//   Bots get a random primary and pistol. Buying is off (the buy commands
//   are refused; B opens the guns menu).
// - Dropped weapons disappear after 5 s (mp_item_staytime).
// - wc_dm_fraglimit (default 0 = off): the map ends when someone gets that
//   many frags (copied to ReGameDLL's mp_fraglimit while the mode runs).
//
// Gun Game only:
//
// - A ladder of weapons (wc_gg_ladder, a ";" list of weapon names; default
//   GG_DEFAULT_LADDER, 24 levels from the Glock to the knife). Everyone has
//   their level's weapon (full ammo, refilled on each reload by ReGameDLL's
//   mp_refill_bpammo_weapons 3) and the knife, plus kevlar and helmet.
// - A kill with the level's weapon counts towards the next level
//   (wc_gg_kills_per_level, default 1); on level up the old weapon is taken
//   away and the new one given. A knife kill steals a level: the killer goes
//   up one, the victim down one (not below 1). Kills with anything else (a
//   grenade from an earlier level) and team kills don't count. Suicides and
//   deaths by the world do nothing, or cost a level with
//   wc_gg_suicide_penalty 1.
// - On the HE grenade level a new grenade comes 1 s after the last one
//   explodes.
// - A kill on the last level (the knife on the default ladder) wins: chat
//   and centre message, a log line "Name<uid><auth><team>" triggered
//   "wc_gg_win" (for the leaderboard), everyone frozen and in god mode for
//   GG_WIN_DELAY seconds, then the next map (amx_nextmap: the map cycle or
//   the vote's pick). The new map starts in classic mode, like any map.
// - Players joining during the game start at the lowest level of the
//   players in a team (wc_gg_join_lowest 1, the default), or at level 1.
// - Buying, picking up and dropping weapons are off. Bots don't buy
//   (yb_botbuy 0) or look for weapons (yb_pickup_best 0), and every weapon
//   is in yb_restricted_weapons.
// - Each player sees "Level 7/24 | MP5 | leader: Walter (12)" at the top
//   of the screen (HUD message, refreshed every second), unless the web
//   page draws it (below).
// - wc_gg_status (server command) lists each player's level, used by the
//   smoke test; wc_gg_setlevel <userid> <level> sets one (tests).
//
// HTML HUD (the web page draws the mode instead of the HUD message):
//
// - A player whose client sends the userinfo key wc_html_hud 1 (the page
//   does "setinfo wc_html_hud 1" when its cs16-client has the "mode" bridge
//   event, 0.0.10+) gets the user message WcMode whenever their mode state
//   changes, instead of the HUD message and the level centre messages.
//   Everyone else (older clients, the stock HUD, bots) is unchanged, and
//   never gets WcMode, which their client doesn't hook.
// - WcMode (registered in plugin_precache, variable size), in this order:
//     byte   mode         0 classic, 1 Gun Game, 2 Deathmatch
//     byte   level        Gun Game: 1-based level; 0 otherwise
//     byte   levels       Gun Game: number of levels; 0 otherwise
//     byte   kills        Gun Game: counting kills on this level
//     byte   killsNeeded  Gun Game: wc_gg_kills_per_level (>= 1); 0 otherwise
//     byte   leaderLevel  Gun Game: the leader's 1-based level; 0 none
//     short  protection   spawn protection left in ms; 0 none
//     string weapon       Gun Game: this level's weapon ("MP5"); "" otherwise
//     string next         Gun Game: the next level's weapon; "" on the last
//     string leader       Gun Game: the leader's name; "" none
//     string winner       Gun Game: the winner's name once won; "" before
//   The client turns it into hudEvent("mode", {...}) with these field names
//   (web_bridge.h in cs16-client). Mode 0 is sent once when a mode ends.
//
// Messages to players are fixed text only: the web client uses TextMsg text
// as a printf format, so player-supplied text must never go into one.

#include <amxmodx>
#include <cstrike>
#include <fakemeta>
#include <fun>
#include <hamsandwich>
#include "wc_weapons.inc"

#define PLUGIN  "Web game mode"
#define VERSION "1.4"
#define AUTHOR  "Walcc"

#define MODE_CLASSIC    0
#define MODE_GUNGAME    1
#define MODE_DEATHMATCH 2

#define TASK_POLL     4300
#define TASK_EQUIP    4400
#define TASK_GLOW     4500
#define TASK_HE       4600
#define TASK_GG_WIN   4700
#define TASK_RESTART  4800

new const MODE_NAMES[][] = { "Classic", "Gun Game", "Deathmatch" }

enum _:ModeCvar { CVAR_NAME[32], CVAR_CLASSIC[24], CVAR_GUNGAME[192], CVAR_DEATHMATCH[24] }

// YaPB's names for every weapon and item (Gun Game: bots buy and pick up
// nothing; the plugin gives them their level's weapon).
#define YAPB_ALL_WEAPONS "usp;glock;deagle;p228;elite;fn57;m3;xm1014;mp5;tmp;p90;mac10;ump45;ak47;galil;famas;sg552;m4a1;aug;scout;awp;g3sg1;sg550;m249;shield;flash;hegren;sgren;vest;vesthelm;defuser"

// Game cvars each mode sets. The classic values are ReGameDLL's and YaPB's
// defaults (ReGameDLL's game.cfg isn't shipped, see the Dockerfile; yapb.cfg
// sets YaPB's again on every map change).
new const MODE_CVARS[][ModeCvar] = {
	// Rounds don't end on elimination or on the round timer.
	{ "mp_round_infinite", "0", "1", "1" },
	// Respawn this many seconds after death.
	{ "mp_forcerespawn", "0", "1", "1" },
	// God mode after a respawn, in seconds...
	{ "mp_respawn_immunitytime", "0", "2", "2" },
	// ...ended early by shooting (1: also by moving).
	{ "mp_respawn_immunity_force_unset", "1", "2", "2" },
	// Seconds before dropped weapons disappear.
	{ "mp_item_staytime", "300", "5", "5" },
	// No bomb for the Terrorists.
	{ "mp_give_player_c4", "1", "0", "0" },
	// Armour (2: kevlar and helmet) and grenades on every spawn.
	{ "mp_free_armor", "0", "2", "2" },
	{ "mp_t_default_grenades", "", "", "hegrenade flash flash" },
	{ "mp_ct_default_grenades", "", "", "hegrenade flash flash" },
	// The pistol everyone spawns with (Gun Game: the level's weapon instead).
	{ "mp_t_default_weapons_secondary", "glock18", "", "glock18" },
	{ "mp_ct_default_weapons_secondary", "usp", "", "usp" },
	// 3: reserve ammo refilled on each reload.
	{ "mp_refill_bpammo_weapons", "0", "3", "0" },
	// The map ends at this many frags (Deathmatch: from wc_dm_fraglimit).
	{ "mp_fraglimit", "0", "0", "0" },
	// YaPB: no planting, defusing or rescuing; no buying; no going after
	// weapons on the ground; weapons it may not buy or pick up.
	{ "yb_ignore_objectives", "0", "1", "1" },
	{ "yb_botbuy", "1", "0", "0" },
	{ "yb_pickup_best", "1", "0", "1" },
	{ "yb_restricted_weapons", "", YAPB_ALL_WEAPONS, "" }
}

// Deathmatch guns menu: primary weapons, then pistols (CSW_ id and name).
enum _:Gun { GUN_ID, GUN_NAME[20] }
new const PRIMARY_GUNS[][Gun] = {
	{ CSW_AK47, "AK-47" }, { CSW_M4A1, "M4A1" }, { CSW_AWP, "AWP" },
	{ CSW_FAMAS, "FAMAS" }, { CSW_GALIL, "Galil" }, { CSW_AUG, "AUG" },
	{ CSW_SG552, "SG 552" }, { CSW_MP5NAVY, "MP5" }, { CSW_P90, "P90" },
	{ CSW_UMP45, "UMP45" }, { CSW_MAC10, "MAC-10" }, { CSW_TMP, "TMP" },
	{ CSW_M3, "M3 shotgun" }, { CSW_XM1014, "XM1014 shotgun" },
	{ CSW_SCOUT, "Scout" }, { CSW_M249, "M249" }
}
new const SECONDARY_GUNS[][Gun] = {
	{ CSW_DEAGLE, "Desert Eagle" }, { CSW_USP, "USP" }, { CSW_GLOCK18, "Glock" },
	{ CSW_P228, "P228" }, { CSW_FIVESEVEN, "Five-SeveN" }, { CSW_ELITE, "Dual Elites" }
}

// Equipment buy aliases (weapons are in wc_weapons.inc) and the commands
// that open the buy menus.
new const DM_BUY_COMMANDS[][] = { "vest", "vesthelm", "defuser", "nvgs", "buy", "buyequip" }

// A menu pick gives the weapons right away only this soon after spawning;
// later it is kept for the next spawn (no free ammo refills).
#define PICK_WINDOW 10.0
// Random spawns: no enemy this close (units).
#define SPAWN_ENEMY_DISTANCE 300.0
#define MAX_SPAWNS 128
#define MAX_SPAWN_TRIGGERS 16

// Gun Game: the ladder when wc_gg_ladder is empty or has no valid weapon.
#define GG_DEFAULT_LADDER "glock18;usp;p228;deagle;fiveseven;elite;tmp;mac10;mp5navy;ump45;p90;m3;xm1014;galil;famas;ak47;m4a1;sg552;aug;scout;awp;m249;hegrenade;knife"
#define GG_MAX_LEVELS 32
// Seconds everyone stays frozen after a win, before the map changes.
#define GG_WIN_DELAY 5.0
// Seconds after an HE grenade explodes before the next one is given.
#define GG_HE_DELAY 1.0
// A scheduled restart (sv_restart 1: one second) counts as on its way for
// this long at most, in case its new round is missed.
#define RESTART_PENDING_MAX 2.0
// Seconds the plugin waits for someone else's restart after a mode change
// before restarting the round itself.
#define RESTART_GRACE 2.0

// Weapon names for players (CSW_ id); "" for what can't be on the ladder.
new const GG_WEAPON_TITLES[CSW_P90 + 1][] = {
	"", "P228", "", "Scout", "HE grenade", "XM1014", "", "MAC-10", "AUG", "",
	"Dual Elites", "Five-SeveN", "UMP45", "SG 550", "Galil", "FAMAS", "USP",
	"Glock", "AWP", "MP5", "M249", "M3", "M4A1", "TMP", "G3SG1", "",
	"Desert Eagle", "SG 552", "AK-47", "Knife", "P90"
}

new g_pMode
new g_pWeaponMode
new g_pFragLimit
new g_pGameFragLimit
new g_pImmunityTime
new g_pGgLadder
new g_pGgKillsPerLevel
new g_pGgSuicidePenalty
new g_pGgJoinLowest
new g_pYbRestricted
new g_pNextMap
// The mode the plugin runs; follows the cvar on each poll.
new g_mode = MODE_CLASSIC
// When the game last scheduled a round restart (Restart_Round_ log line),
// whether that restart hasn't happened yet, and when the mode last changed.
new Float:g_restartScheduledAt = -1.0
new bool:g_restartPending
new Float:g_modeChangedAt

new Float:g_spawnOrigin[MAX_SPAWNS][3]
new Float:g_spawnAngles[MAX_SPAWNS][3]
new g_spawnCount

// Entities named game_playerspawn, switched off during a mode.
new g_spawnTriggers[MAX_SPAWN_TRIGGERS]
new g_spawnTriggerCount

new g_menuMain
new g_menuPrimary
new g_menuSecondary

// Per player: last guns picked (index into PRIMARY_GUNS / SECONDARY_GUNS,
// -1 none), "same every time", the primary picked while the pistol menu is
// open, when they last spawned, and when their protection glow ends (0 off).
new g_lastPrimary[MAX_PLAYERS + 1] = { -1, ... }
new g_lastSecondary[MAX_PLAYERS + 1] = { -1, ... }
new bool:g_autoSame[MAX_PLAYERS + 1]
new g_pendingPrimary[MAX_PLAYERS + 1]
new Float:g_spawnTime[MAX_PLAYERS + 1]
new Float:g_glowEnd[MAX_PLAYERS + 1]

// Gun Game: the ladder (CSW_ ids) and the wc_gg_ladder text it was read
// from; per player the level (0 = first) and kills on it; the winner (0
// while the game runs) and the HUD message channel.
new g_ladder[GG_MAX_LEVELS]
new g_ladderCount
new g_ladderText[512]
new g_level[MAX_PLAYERS + 1]
new g_levelKills[MAX_PLAYERS + 1]
new g_ggWinner
new g_hudSync

// HTML HUD: the WcMode message id, and per player the last state sent
// ("" = none, so the next send always goes out).
new g_msgMode
new g_modeSent[MAX_PLAYERS + 1][160]
// Tests (wc_mode_test): treat this player as having the HTML HUD, bots too.
new bool:g_modeTest[MAX_PLAYERS + 1]

public plugin_precache()
{
	// Registered here, not with register_message: it is our own message.
	// Size -1: variable.
	g_msgMode = engfunc(EngFunc_RegUserMsg, "WcMode", -1)
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR)

	// FCVAR_SERVER: the lobby (/status.json) reads it from A2S_RULES.
	// Not FCVAR_SPONLY: Xash3D refuses console/rcon changes to those.
	g_pMode = register_cvar("wc_gamemode", "0", FCVAR_SERVER)
	// Kept over map changes, like mp_fraglimit.
	g_pFragLimit = register_cvar("wc_dm_fraglimit", "0")
	// Gun Game settings, also kept over map changes.
	g_pGgLadder = register_cvar("wc_gg_ladder", GG_DEFAULT_LADDER)
	g_pGgKillsPerLevel = register_cvar("wc_gg_kills_per_level", "1")
	g_pGgSuicidePenalty = register_cvar("wc_gg_suicide_penalty", "0")
	g_pGgJoinLowest = register_cvar("wc_gg_join_lowest", "1")
	// The cvar outlives the plugin across a map change; start each map in
	// classic mode, and undo the last map's mode cvars if it ran a mode.
	if (get_pcvar_num(g_pMode) != MODE_CLASSIC)
	{
		set_pcvar_num(g_pMode, MODE_CLASSIC)
		SetModeCvars(MODE_CLASSIC)
	}
	g_pGameFragLimit = get_cvar_pointer("mp_fraglimit")
	g_pImmunityTime = get_cvar_pointer("mp_respawn_immunitytime")
	g_pYbRestricted = get_cvar_pointer("yb_restricted_weapons")
	g_hudSync = CreateHudSyncObj()

	FindSpawns()
	FindSpawnTriggers()
	CreateMenus()

	RegisterHam(Ham_Spawn, "player", "OnPlayerSpawn", 1)
	RegisterHam(Ham_Killed, "player", "OnPlayerKilled", 1)
	register_forward(FM_CmdStart, "OnCmdStart")
	register_forward(FM_SetModel, "OnSetModel", 1)
	RegisterHam(Ham_Touch, "weaponbox", "OnTouchItem")
	RegisterHam(Ham_Touch, "armoury_entity", "OnTouchItem")
	RegisterHam(Ham_Touch, "weapon_shield", "OnTouchItem")
	// DeathMsg: byte killer, byte victim, byte headshot, string weapon.
	register_event("DeathMsg", "OnDeathMsg", "a")
	// World triggered "Restart_Round_(1_second)": a restart is scheduled.
	register_logevent("OnRestartScheduled", 2, "1&Restart_Round_")
	// A new round (any: also the end of a scheduled restart).
	register_event("HLTV", "OnNewRound", "a", "1=0", "2=0")

	for (new i = 0; i < sizeof WC_BUY_ALIASES; i++)
		register_clcmd(WC_BUY_ALIASES[i][WC_ALIAS_NAME], "OnBuy")
	for (new i = 0; i < sizeof WC_AUTOBUY_COMMANDS; i++)
		register_clcmd(WC_AUTOBUY_COMMANDS[i], "OnBuy")
	for (new i = 0; i < sizeof DM_BUY_COMMANDS; i++)
		register_clcmd(DM_BUY_COMMANDS[i], "OnBuy")
	register_clcmd("guns", "CmdGuns")
	register_clcmd("say guns", "CmdGuns")
	register_clcmd("say /guns", "CmdGuns")
	register_clcmd("say_team guns", "CmdGuns")
	register_clcmd("say_team /guns", "CmdGuns")
	register_clcmd("drop", "OnDrop")

	register_srvcmd("wc_gamemode_status", "CmdStatus")
	register_srvcmd("wc_dm_status", "CmdDmStatus")
	register_srvcmd("wc_dm_guns", "CmdDmGuns")
	register_srvcmd("wc_gg_status", "CmdGgStatus")
	register_srvcmd("wc_gg_setlevel", "CmdGgSetLevel")
	register_srvcmd("wc_mode_test", "CmdModeTest")

	set_task(1.0, "Poll", TASK_POLL, _, _, "b")
}

public plugin_cfg()
{
	// Registered by wc_weaponmode.amxx (any plugin order).
	g_pWeaponMode = get_cvar_pointer("wc_weaponmode")
	// AMXX's nextmap plugin: the next map in the cycle, or the vote's pick.
	g_pNextMap = get_cvar_pointer("amx_nextmap")
}

public client_putinserver(id)
{
	g_lastPrimary[id] = -1
	g_lastSecondary[id] = -1
	g_autoSame[id] = false
	g_pendingPrimary[id] = -1
	g_glowEnd[id] = 0.0
	g_level[id] = g_mode == MODE_GUNGAME ? GgJoinLevel(id) : 0
	g_levelKills[id] = 0
	g_modeSent[id][0] = EOS
	g_modeTest[id] = false
}

public client_disconnected(id)
{
	remove_task(TASK_EQUIP + id)
	remove_task(TASK_GLOW + id)
	remove_task(TASK_HE + id)
	g_glowEnd[id] = 0.0
	g_level[id] = 0
	g_levelKills[id] = 0
	g_modeSent[id][0] = EOS
	g_modeTest[id] = false
}

ReadMode()
{
	new mode = get_pcvar_num(g_pMode)
	if (mode < MODE_CLASSIC || mode > MODE_DEATHMATCH)
		return MODE_CLASSIC
	return mode
}

public Poll()
{
	new mode = ReadMode()
	if (mode != g_mode)
		ChangeMode(mode)
	// HTML HUD: a changed state (also a wc_html_hud just set), or the mode
	// ending (mode 0 once).
	for (new id = 1; id <= MaxClients; id++)
		SendMode(id)

	if (g_mode == MODE_CLASSIC)
		return
	// A round restart brings the hostages back.
	HideHostages()
	if (g_mode == MODE_DEATHMATCH && g_pGameFragLimit)
	{
		new limit = max(get_pcvar_num(g_pFragLimit), 0)
		if (get_pcvar_num(g_pGameFragLimit) != limit)
			set_pcvar_num(g_pGameFragLimit, limit)
	}
	if (g_mode == MODE_GUNGAME)
		GgPoll()
}

public OnRestartScheduled()
{
	g_restartScheduledAt = get_gametime()
	g_restartPending = true
	// Apply a changed mode now, so the scheduled restart starts it.
	new mode = ReadMode()
	if (mode != g_mode)
		ChangeMode(mode)
}

public OnNewRound()
{
	g_restartPending = false
}

bool:RestartPending()
{
	return g_restartPending
		&& get_gametime() - g_restartScheduledAt < RESTART_PENDING_MAX
}

public ModeRestart()
{
	if (g_restartScheduledAt >= g_modeChangedAt)
		log_amx("Game mode: the round was restarted by someone else, not restarting again")
	else
		server_cmd("sv_restart 1")
}

ChangeMode(mode)
{
	new old = g_mode
	g_mode = mode

	// The modes don't mix with knife only / pistols only.
	if (mode != MODE_CLASSIC && g_pWeaponMode && get_pcvar_num(g_pWeaponMode) != 0)
		set_pcvar_num(g_pWeaponMode, 0)
	SetModeCvars(mode)
	if (old == MODE_CLASSIC)
		SetSpawnTriggers(false)
	else if (mode == MODE_CLASSIC)
		SetSpawnTriggers(true)
	if (mode != MODE_DEATHMATCH)
		CloseGunMenus()
	if (old == MODE_GUNGAME)
		GgStop()
	if (mode == MODE_GUNGAME)
		GgStart()
	if (mode == MODE_CLASSIC)
	{
		for (new id = 1; id <= MaxClients; id++)
			EndGlow(id)
	}

	log_amx("Game mode: %s", MODE_NAMES[mode])
	client_print(0, print_chat, "[Server] Game mode: %s.", MODE_NAMES[mode])
	if (mode == MODE_DEATHMATCH)
		client_print(0, print_chat, "[Server] Deathmatch: pick your weapons from the menu. Press B or say guns to open it again.")
	else if (mode == MODE_GUNGAME)
		client_print(0, print_chat, "[Server] Gun Game: %d levels. Each kill gives you the next weapon; a knife kill steals a level.", g_ladderCount)
	// Everyone starts fresh under the new rules: one restart (see the top).
	remove_task(TASK_RESTART)
	g_modeChangedAt = get_gametime()
	if (RestartPending())
		log_amx("Game mode: a round restart is scheduled already, not restarting again")
	else
		set_task(RESTART_GRACE, "ModeRestart", TASK_RESTART)
}

SetModeCvars(mode)
{
	for (new i = 0; i < sizeof MODE_CVARS; i++)
	{
		switch (mode)
		{
			case MODE_GUNGAME: set_cvar_string(MODE_CVARS[i][CVAR_NAME], MODE_CVARS[i][CVAR_GUNGAME])
			case MODE_DEATHMATCH: set_cvar_string(MODE_CVARS[i][CVAR_NAME], MODE_CVARS[i][CVAR_DEATHMATCH])
			default: set_cvar_string(MODE_CVARS[i][CVAR_NAME], MODE_CVARS[i][CVAR_CLASSIC])
		}
	}
}

// --- Map setup ---------------------------------------------------------

FindSpawns()
{
	new const classes[][] = { "info_player_start", "info_player_deathmatch" }
	for (new c = 0; c < sizeof classes; c++)
	{
		new ent = -1
		while ((ent = engfunc(EngFunc_FindEntityByString, ent, "classname", classes[c])) > 0 && g_spawnCount < MAX_SPAWNS)
		{
			pev(ent, pev_origin, g_spawnOrigin[g_spawnCount])
			pev(ent, pev_angles, g_spawnAngles[g_spawnCount])
			// Where the game puts a player on this spot.
			g_spawnOrigin[g_spawnCount][2] += 1.0
			g_spawnCount++
		}
	}
}

FindSpawnTriggers()
{
	new ent = -1
	while ((ent = engfunc(EngFunc_FindEntityByString, ent, "targetname", "game_playerspawn")) > 0 && g_spawnTriggerCount < MAX_SPAWN_TRIGGERS)
		g_spawnTriggers[g_spawnTriggerCount++] = ent
}

// The game fires "game_playerspawn" on every spawn; maps use it to strip
// and equip players (awp_india), which would fight the mode's weapons.
SetSpawnTriggers(bool:on)
{
	for (new i = 0; i < g_spawnTriggerCount; i++)
	{
		if (pev_valid(g_spawnTriggers[i]))
			set_pev(g_spawnTriggers[i], pev_targetname, on ? "game_playerspawn" : "wc_off_game_playerspawn")
	}
}

// Hides the hostages the way the game hides a rescued one (CHostage::Remove);
// the next round restart puts them back (CHostage::RePosition).
HideHostages()
{
	new ent = -1
	while ((ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "hostage_entity")) > 0)
	{
		if (pev(ent, pev_effects) & EF_NODRAW)
			continue
		set_pev(ent, pev_effects, pev(ent, pev_effects) | EF_NODRAW)
		set_pev(ent, pev_movetype, MOVETYPE_NONE)
		set_pev(ent, pev_solid, SOLID_NOT)
		set_pev(ent, pev_takedamage, DAMAGE_NO)
		set_pev(ent, pev_deadflag, DEAD_DEAD)
		engfunc(EngFunc_SetSize, ent, Float:{ 0.0, 0.0, 0.0 }, Float:{ 0.0, 0.0, 0.0 })
		set_pev(ent, pev_nextthink, -1.0)
	}
}

// --- Spawns ------------------------------------------------------------

public OnPlayerSpawn(id)
{
	if (g_mode == MODE_CLASSIC || !is_user_alive(id))
		return HAM_IGNORED

	g_spawnTime[id] = get_gametime()
	RandomSpawn(id)
	StartGlow(id)
	// After anything the map or the game hands out on spawn.
	remove_task(TASK_EQUIP + id)
	if (g_mode == MODE_DEATHMATCH)
		set_task(0.1, "DmEquip", TASK_EQUIP + id)
	else if (g_mode == MODE_GUNGAME)
	{
		set_task(0.1, "GgEquip", TASK_EQUIP + id)
		if (g_ggWinner)
			Freeze(id)
	}
	return HAM_IGNORED
}

public OnPlayerKilled(victim)
{
	remove_task(TASK_EQUIP + victim)
	remove_task(TASK_HE + victim)
	EndGlow(victim)
	return HAM_IGNORED
}

// Moves the player to a random spawn point: one with no enemy within
// SPAWN_ENEMY_DISTANCE and none that can see it if there is one, else one
// with no enemy that close, else the free one farthest from enemies. A spot
// someone already stands on is never used; with no free spot the player
// stays where the game put them.
RandomSpawn(id)
{
	if (g_spawnCount == 0)
		return

	new enemies[MAX_PLAYERS], enemyCount
	new Float:enemyEyes[MAX_PLAYERS][3]
	new team = get_user_team(id)
	for (new other = 1; other <= MaxClients; other++)
	{
		if (other == id || !is_user_alive(other) || get_user_team(other) == team)
			continue
		new Float:ofs[3]
		pev(other, pev_origin, enemyEyes[enemyCount])
		pev(other, pev_view_ofs, ofs)
		enemyEyes[enemyCount][0] += ofs[0]
		enemyEyes[enemyCount][1] += ofs[1]
		enemyEyes[enemyCount][2] += ofs[2]
		enemies[enemyCount++] = other
	}

	new best = -1, bestRank = 0
	new Float:bestDistance = -1.0
	new start = random(g_spawnCount)
	for (new n = 0; n < g_spawnCount; n++)
	{
		new s = (start + n) % g_spawnCount
		if (!SpotFree(id, g_spawnOrigin[s]))
			continue

		new Float:eye[3]
		eye[0] = g_spawnOrigin[s][0]
		eye[1] = g_spawnOrigin[s][1]
		eye[2] = g_spawnOrigin[s][2] + 17.0
		new Float:nearest = 999999.0
		new bool:seen = false
		for (new e = 0; e < enemyCount; e++)
		{
			new Float:distance = get_distance_f(g_spawnOrigin[s], enemyEyes[e])
			if (distance < nearest)
				nearest = distance
			if (!seen)
			{
				new Float:fraction
				engfunc(EngFunc_TraceLine, enemyEyes[e], eye, IGNORE_MONSTERS, enemies[e], 0)
				get_tr2(0, TR_flFraction, fraction)
				seen = fraction >= 1.0
			}
		}

		new rank = 1
		if (nearest >= SPAWN_ENEMY_DISTANCE)
			rank = seen ? 2 : 3
		if (rank > bestRank || (rank == bestRank && rank == 1 && nearest > bestDistance))
		{
			best = s
			bestRank = rank
			bestDistance = nearest
			if (rank == 3)
				break
		}
	}
	if (best < 0)
		return

	engfunc(EngFunc_SetOrigin, id, g_spawnOrigin[best])
	set_pev(id, pev_velocity, Float:{ 0.0, 0.0, 0.0 })
	set_pev(id, pev_angles, g_spawnAngles[best])
	set_pev(id, pev_v_angle, g_spawnAngles[best])
	set_pev(id, pev_fixangle, 1)
}

// No player or wall where a standing player would be at origin.
bool:SpotFree(id, const Float:origin[3])
{
	engfunc(EngFunc_TraceHull, origin, origin, DONT_IGNORE_MONSTERS, HULL_HUMAN, id, 0)
	return !get_tr2(0, TR_StartSolid) && !get_tr2(0, TR_AllSolid)
}

// --- Spawn protection glow ---------------------------------------------

// ReGameDLL makes a protected player see-through; a glow in the team's
// colour is easier to see. It ends with the protection: after
// mp_respawn_immunitytime, or when the player shoots (OnCmdStart, the same
// test as ReGameDLL's mp_respawn_immunity_force_unset 2).
StartGlow(id)
{
	new Float:time = g_pImmunityTime ? get_pcvar_float(g_pImmunityTime) : 0.0
	if (time <= 0.0)
		return
	if (get_user_team(id) == 1)
		set_user_rendering(id, kRenderFxGlowShell, 255, 40, 40, kRenderNormal, 20)
	else
		set_user_rendering(id, kRenderFxGlowShell, 40, 100, 255, kRenderNormal, 20)
	g_glowEnd[id] = get_gametime() + time
	remove_task(TASK_GLOW + id)
	set_task(time, "GlowTimeout", TASK_GLOW + id)
	SendMode(id)
}

public GlowTimeout(taskid)
{
	EndGlow(taskid - TASK_GLOW)
}

EndGlow(id)
{
	if (g_glowEnd[id] == 0.0)
		return
	g_glowEnd[id] = 0.0
	remove_task(TASK_GLOW + id)
	if (is_user_connected(id))
	{
		set_user_rendering(id)
		SendMode(id)
	}
}

public OnCmdStart(id, uc)
{
	if (id < 1 || id > MaxClients || g_glowEnd[id] == 0.0)
		return FMRES_IGNORED
	// Pressed this frame (pev_button still has the last command's buttons).
	new pressed = get_uc(uc, UC_Buttons) & ~pev(id, pev_button)
	if (pressed & (IN_ATTACK | IN_ATTACK2))
		EndGlow(id)
	return FMRES_IGNORED
}

// --- Deathmatch guns ---------------------------------------------------

CreateMenus()
{
	g_menuMain = menu_create("Deathmatch weapons", "OnMainMenu")
	menu_additem(g_menuMain, "New weapons")
	menu_additem(g_menuMain, "Same as last time")
	menu_additem(g_menuMain, "Same every time (say guns to change)")

	g_menuPrimary = menu_create("Primary weapon", "OnPrimaryMenu")
	for (new i = 0; i < sizeof PRIMARY_GUNS; i++)
		menu_additem(g_menuPrimary, PRIMARY_GUNS[i][GUN_NAME])

	g_menuSecondary = menu_create("Pistol", "OnSecondaryMenu")
	for (new i = 0; i < sizeof SECONDARY_GUNS; i++)
		menu_additem(g_menuSecondary, SECONDARY_GUNS[i][GUN_NAME])
}

public DmEquip(taskid)
{
	new id = taskid - TASK_EQUIP
	if (g_mode != MODE_DEATHMATCH || !is_user_alive(id))
		return
	// Nothing to plant (mp_give_player_c4 0 covers new rounds only).
	WcStripWeapons(id, 1 << CSW_C4)

	if (is_user_bot(id))
	{
		GiveGuns(id, random(sizeof PRIMARY_GUNS), random(sizeof SECONDARY_GUNS))
		return
	}
	if (g_autoSame[id] && g_lastPrimary[id] >= 0)
	{
		GiveGuns(id, g_lastPrimary[id], g_lastSecondary[id])
		return
	}
	ShowGunMenu(id)
}

ShowGunMenu(id)
{
	g_pendingPrimary[id] = -1
	if (g_lastPrimary[id] >= 0)
		menu_display(id, g_menuMain)
	else
		menu_display(id, g_menuPrimary)
}

CloseGunMenus()
{
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id))
			continue
		new menu, newmenu
		player_menu_info(id, menu, newmenu)
		if (newmenu == g_menuMain || newmenu == g_menuPrimary || newmenu == g_menuSecondary)
			menu_cancel(id)
	}
}

public OnMainMenu(id, menu, item)
{
	if (g_mode != MODE_DEATHMATCH || item < 0)
		return PLUGIN_HANDLED
	switch (item)
	{
		case 0: menu_display(id, g_menuPrimary)
		case 1: PickGuns(id, g_lastPrimary[id], g_lastSecondary[id])
		case 2:
		{
			g_autoSame[id] = true
			PickGuns(id, g_lastPrimary[id], g_lastSecondary[id])
		}
	}
	return PLUGIN_HANDLED
}

public OnPrimaryMenu(id, menu, item)
{
	if (g_mode != MODE_DEATHMATCH || item < 0 || item >= sizeof PRIMARY_GUNS)
		return PLUGIN_HANDLED
	g_pendingPrimary[id] = item
	menu_display(id, g_menuSecondary)
	return PLUGIN_HANDLED
}

public OnSecondaryMenu(id, menu, item)
{
	if (g_mode != MODE_DEATHMATCH || item < 0 || item >= sizeof SECONDARY_GUNS || g_pendingPrimary[id] < 0)
		return PLUGIN_HANDLED
	PickGuns(id, g_pendingPrimary[id], item)
	g_pendingPrimary[id] = -1
	return PLUGIN_HANDLED
}

// A player's pick (menu or wc_dm_guns): remembered, and given now if they
// spawned within PICK_WINDOW seconds.
PickGuns(id, primary, secondary)
{
	if (primary < 0 || secondary < 0)
		return
	g_lastPrimary[id] = primary
	g_lastSecondary[id] = secondary
	if (!is_user_alive(id))
		return
	if (get_gametime() - g_spawnTime[id] > PICK_WINDOW)
	{
		client_print(id, print_center, "You get these weapons when you next spawn.")
		return
	}
	GiveGuns(id, primary, secondary)
}

GiveGuns(id, primary, secondary)
{
	WcStripWeapons(id, WC_PRIMARIES | WC_PISTOLS)
	WcGiveWeapon(id, SECONDARY_GUNS[secondary][GUN_ID])
	WcGiveWeapon(id, PRIMARY_GUNS[primary][GUN_ID])
	new name[32]
	get_weaponname(PRIMARY_GUNS[primary][GUN_ID], name, charsmax(name))
	engclient_cmd(id, name)
}

// "guns" / "say guns": the guns menu, and "same every time" off.
public CmdGuns(id)
{
	if (g_mode != MODE_DEATHMATCH)
		return PLUGIN_CONTINUE
	g_autoSame[id] = false
	ShowGunMenu(id)
	return PLUGIN_HANDLED
}

// Buy commands in Deathmatch: refused; the buy menu key opens the guns
// menu instead. (The cstrike module's CS_OnBuyAttempt forward never fires
// on Xash3D, so the plugin hooks the commands, like wc_weaponmode.)
public OnBuy(id)
{
	if (g_mode == MODE_GUNGAME)
	{
		client_print(id, print_center, "Gun Game: no buying. Kills give you the next weapon.")
		return PLUGIN_HANDLED
	}
	if (g_mode != MODE_DEATHMATCH)
		return PLUGIN_CONTINUE
	new command[16]
	read_argv(0, command, charsmax(command))
	if (equali(command, "buy") || equali(command, "buyequip"))
	{
		if (!is_user_bot(id))
			ShowGunMenu(id)
	}
	else
		client_print(id, print_center, "Deathmatch: no buying. Press B or say guns for the guns menu.")
	return PLUGIN_HANDLED
}

// --- Gun Game ----------------------------------------------------------

GgStart()
{
	GgReadLadder()
	for (new id = 1; id <= MaxClients; id++)
	{
		g_level[id] = 0
		g_levelKills[id] = 0
	}
	g_ggWinner = 0
	remove_task(TASK_GG_WIN)
}

GgStop()
{
	remove_task(TASK_GG_WIN)
	for (new id = 1; id <= MaxClients; id++)
	{
		remove_task(TASK_HE + id)
		if (!is_user_connected(id))
			continue
		if (g_ggWinner && is_user_alive(id))
			Unfreeze(id)
		if (!is_user_bot(id) && !HtmlHud(id))
			ClearSyncHud(id, g_hudSync)
	}
	g_ggWinner = 0
}

// Once a second: a changed ladder, YaPB's weapon list (the weapon mode
// plugin clears it when it turns itself off), the HUD.
GgPoll()
{
	new text[sizeof g_ladderText]
	get_pcvar_string(g_pGgLadder, text, charsmax(text))
	if (!equal(text, g_ladderText))
	{
		GgReadLadder()
		for (new id = 1; id <= MaxClients; id++)
		{
			if (g_level[id] >= g_ladderCount)
				g_level[id] = g_ladderCount - 1
			if (is_user_alive(id) && !g_ggWinner)
				GgScheduleEquip(id)
		}
		client_print(0, print_chat, "[Server] Gun Game: the ladder changed (%d levels).", g_ladderCount)
	}
	if (g_pYbRestricted)
	{
		new restricted[192]
		get_pcvar_string(g_pYbRestricted, restricted, charsmax(restricted))
		if (!equal(restricted, YAPB_ALL_WEAPONS))
			set_pcvar_string(g_pYbRestricted, YAPB_ALL_WEAPONS)
	}
	for (new id = 1; id <= MaxClients; id++)
		ShowGgHud(id)
}

// Reads wc_gg_ladder: weapon names (with or without "weapon_") separated by
// ";". Unknown names, the C4, flashbangs and smoke grenades are skipped.
GgReadLadder()
{
	get_pcvar_string(g_pGgLadder, g_ladderText, charsmax(g_ladderText))
	ParseLadder(g_ladderText)
	if (g_ladderCount == 0)
	{
		log_amx("wc_gg_ladder has no weapon this plugin knows; using the default ladder")
		ParseLadder(GG_DEFAULT_LADDER)
	}
}

ParseLadder(const text[])
{
	g_ladderCount = 0
	new item[32], name[40]
	new len = strlen(text), start = 0
	for (new i = 0; i <= len && g_ladderCount < GG_MAX_LEVELS; i++)
	{
		if (text[i] != ';' && text[i] != EOS)
			continue
		copy(item, min(i - start, charsmax(item)), text[start])
		start = i + 1
		trim(item)
		strtolower(item)
		if (!item[0])
			continue
		if (equal(item, "weapon_", 7))
			copy(name, charsmax(name), item)
		else
			formatex(name, charsmax(name), "weapon_%s", item)
		new wid = get_weaponid(name)
		if (wid <= 0 || wid > CSW_P90 || !GG_WEAPON_TITLES[wid][0])
		{
			log_amx("wc_gg_ladder: ^"%s^" isn't a weapon the ladder can have; skipped", item)
			continue
		}
		g_ladder[g_ladderCount++] = wid
	}
}

// Level for a player joining during the game: the lowest of the players in
// a team (wc_gg_join_lowest 1), else the first.
GgJoinLevel(id)
{
	if (get_pcvar_num(g_pGgJoinLowest) == 0)
		return 0
	new lowest = -1
	for (new other = 1; other <= MaxClients; other++)
	{
		if (other == id || !is_user_connected(other))
			continue
		new team = get_user_team(other)
		if (team != 1 && team != 2)
			continue
		if (lowest < 0 || g_level[other] < lowest)
			lowest = g_level[other]
	}
	return lowest < 0 ? 0 : lowest
}

GgScheduleEquip(id)
{
	remove_task(TASK_EQUIP + id)
	set_task(0.1, "GgEquip", TASK_EQUIP + id)
}

// The level's weapon with full ammo and the knife; everything else taken
// away. (Not done inside the kill itself: the weapon that made the kill
// may still be running its attack.)
public GgEquip(taskid)
{
	new id = taskid - TASK_EQUIP
	if (g_mode != MODE_GUNGAME || !is_user_alive(id) || !g_ladderCount)
		return
	new wid = g_ladder[g_level[id]]
	WcStripWeapons(id, (WC_PRIMARIES | WC_PISTOLS | WC_GRENADES | (1 << CSW_C4)) & ~(1 << wid))
	if (!(pev(id, pev_weapons) & (1 << CSW_KNIFE)))
		give_item(id, "weapon_knife")
	if (wid != CSW_KNIFE)
	{
		if (!(pev(id, pev_weapons) & (1 << wid)))
			WcGiveWeapon(id, wid)
		else if (WC_MAX_BPAMMO[wid] > 0 && !((1 << wid) & WC_GRENADES))
			cs_set_user_bpammo(id, wid, WC_MAX_BPAMMO[wid])
	}
	new name[32]
	get_weaponname(wid, name, charsmax(name))
	engclient_cmd(id, name)
	ShowGgHud(id)
}

public OnDeathMsg()
{
	if (g_mode != MODE_GUNGAME || g_ggWinner || !g_ladderCount)
		return
	new killer = read_data(1)
	new victim = read_data(2)
	if (victim < 1 || victim > MaxClients || !is_user_connected(victim))
		return

	// Suicide, or killed by the world (falling, map hazards).
	if (killer == victim || killer < 1 || killer > MaxClients || !is_user_connected(killer))
	{
		if (get_pcvar_num(g_pGgSuicidePenalty) != 0)
			GgLevelDown(victim, "Suicide")
		return
	}
	if (get_user_team(killer) == get_user_team(victim))
		return

	new weapon[32]
	read_data(4, weapon, charsmax(weapon))
	new bool:knife = bool:equal(weapon, "knife")
	if (!knife && !GgIsLevelWeapon(g_ladder[g_level[killer]], weapon))
		return

	if (knife)
		GgLevelDown(victim, "Knifed")
	if (g_level[killer] >= g_ladderCount - 1)
	{
		GgWin(killer)
		return
	}
	if (!knife && ++g_levelKills[killer] < max(get_pcvar_num(g_pGgKillsPerLevel), 1))
	{
		ShowGgHud(killer)
		return
	}
	GgLevelUp(killer, knife)
}

// weapon: the DeathMsg weapon name ("grenade" for an HE grenade).
bool:GgIsLevelWeapon(wid, const weapon[])
{
	if (wid == CSW_HEGRENADE)
		return bool:equal(weapon, "grenade")
	new name[32]
	get_weaponname(wid, name, charsmax(name))
	return bool:equal(weapon, name[7])
}

GgLevelUp(id, bool:knife)
{
	g_level[id]++
	g_levelKills[id] = 0
	remove_task(TASK_HE + id)
	new wid = g_ladder[g_level[id]]
	log_amx("Gun Game: #%d up to level %d (%s)%s", get_user_userid(id), g_level[id] + 1, GG_WEAPON_TITLES[wid], knife ? ", knife steal" : "")
	// The HTML HUD shows its own toast.
	if (!HtmlHud(id))
		client_print(id, print_center, "Level %d/%d: %s%s", g_level[id] + 1, g_ladderCount, GG_WEAPON_TITLES[wid], knife ? " (knife steal)" : "")
	if (is_user_alive(id))
		GgScheduleEquip(id)
	ShowGgHud(id)
}

GgLevelDown(id, const why[])
{
	if (g_level[id] <= 0)
		return
	g_level[id]--
	g_levelKills[id] = 0
	remove_task(TASK_HE + id)
	log_amx("Gun Game: #%d down to level %d (%s)", get_user_userid(id), g_level[id] + 1, why)
	if (!HtmlHud(id))
		client_print(id, print_center, "%s: you lost a level. Level %d/%d: %s", why, g_level[id] + 1, g_ladderCount, GG_WEAPON_TITLES[g_ladder[g_level[id]]])
	if (is_user_alive(id))
		GgScheduleEquip(id)
	ShowGgHud(id)
}

GgWin(id)
{
	g_ggWinner = id
	new name[32], authid[64], team[32], nextMap[64]
	SafeName(id, name, charsmax(name))
	GgNextMapName(nextMap, charsmax(nextMap))

	client_print(0, print_center, "%s won Gun Game!", name)
	client_print(0, print_chat, "[Server] %s won Gun Game! Next map: %s.", name, nextMap)
	// For the leaderboard (src/server/statslog.go), in the game's format.
	// The real name, as a format argument.
	get_user_name(id, name, charsmax(name))
	get_user_authid(id, authid, charsmax(authid))
	get_user_team(id, team, charsmax(team))
	log_message("^"%s<%d><%s><%s>^" triggered ^"wc_gg_win^"", name, get_user_userid(id), authid, team)
	log_amx("Gun Game won by #%d; next map %s", get_user_userid(id), nextMap)

	for (new other = 1; other <= MaxClients; other++)
	{
		remove_task(TASK_HE + other)
		if (is_user_alive(other))
			Freeze(other)
		ShowGgHud(other)
	}
	set_task(GG_WIN_DELAY, "GgNextMap", TASK_GG_WIN)
}

GgNextMapName(map[], len)
{
	if (g_pNextMap)
		get_pcvar_string(g_pNextMap, map, len)
	if (!map[0] || !is_map_valid(map))
		get_mapname(map, len)
}

public GgNextMap()
{
	if (g_mode != MODE_GUNGAME || !g_ggWinner)
		return
	new map[64]
	GgNextMapName(map, charsmax(map))
	server_cmd("changelevel %s", map)
}

// The winner's pause: no moving, no damage.
Freeze(id)
{
	set_pev(id, pev_flags, pev(id, pev_flags) | FL_FROZEN)
	set_pev(id, pev_velocity, Float:{ 0.0, 0.0, 0.0 })
	set_user_maxspeed(id, 1.0)
	set_user_godmode(id, 1)
}

Unfreeze(id)
{
	set_pev(id, pev_flags, pev(id, pev_flags) & ~FL_FROZEN)
	set_user_godmode(id, 0)
	ExecuteHamB(Ham_CS_Player_ResetMaxSpeed, id)
}

// The thrown HE grenade gets its model once its fuse is set: give the next
// one GG_HE_DELAY seconds after it explodes.
public OnSetModel(ent, const model[])
{
	if (g_mode != MODE_GUNGAME || g_ggWinner || !equal(model, "models/w_hegrenade.mdl"))
		return FMRES_IGNORED
	new classname[16]
	pev(ent, pev_classname, classname, charsmax(classname))
	if (!equal(classname, "grenade"))
		return FMRES_IGNORED
	new owner = pev(ent, pev_owner)
	if (owner < 1 || owner > MaxClients || g_ladder[g_level[owner]] != CSW_HEGRENADE)
		return FMRES_IGNORED
	new Float:fuse
	pev(ent, pev_dmgtime, fuse)
	fuse = floatmax(fuse - get_gametime(), 0.0)
	remove_task(TASK_HE + owner)
	set_task(fuse + GG_HE_DELAY, "GgHeRefill", TASK_HE + owner)
	return FMRES_IGNORED
}

public GgHeRefill(taskid)
{
	new id = taskid - TASK_HE
	if (g_mode != MODE_GUNGAME || g_ggWinner || !is_user_alive(id) || g_ladder[g_level[id]] != CSW_HEGRENADE)
		return
	if (pev(id, pev_weapons) & (1 << CSW_HEGRENADE))
		return
	WcGiveWeapon(id, CSW_HEGRENADE)
	engclient_cmd(id, "weapon_hegrenade")
}

// Gun Game: no picking up weapons or armour.
public OnTouchItem(ent, id)
{
	if (g_mode != MODE_GUNGAME || id < 1 || id > MaxClients)
		return HAM_IGNORED
	return HAM_SUPERCEDE
}

// Gun Game: dropping the level's weapon would leave only the knife.
public OnDrop(id)
{
	if (g_mode != MODE_GUNGAME)
		return PLUGIN_CONTINUE
	client_print(id, print_center, "Gun Game: you can't drop your weapon.")
	return PLUGIN_HANDLED
}

// The leader: the highest level of the players in a team (0: none).
GgLeader()
{
	new leader = 0
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id))
			continue
		new team = get_user_team(id)
		if ((team == 1 || team == 2) && (!leader || g_level[id] > g_level[leader]))
			leader = id
	}
	return leader
}

// Top centre: "Level 7/24 | MP5 | leader: Walter (12)"; players with the
// HTML HUD get WcMode instead.
ShowGgHud(id)
{
	if (g_mode != MODE_GUNGAME || !g_ladderCount || !is_user_connected(id) || is_user_bot(id))
		return
	if (HtmlHud(id))
	{
		SendMode(id)
		return
	}
	new name[32]
	set_hudmessage(255, 210, 60, -1.0, 0.02, 0, 0.0, 1.3, 0.0, 0.0, -1)
	if (g_ggWinner)
	{
		SafeName(g_ggWinner, name, charsmax(name))
		ShowSyncHudMsg(id, g_hudSync, "%s won Gun Game!", name)
		return
	}
	new leader = GgLeader()
	if (leader)
		SafeName(leader, name, charsmax(name))
	else
		copy(name, charsmax(name), "-")
	new level = g_level[id]
	new kills = max(get_pcvar_num(g_pGgKillsPerLevel), 1)
	if (kills > 1 && level < g_ladderCount - 1)
		ShowSyncHudMsg(id, g_hudSync, "Level %d/%d | %s (%d/%d kills) | leader: %s (%d)",
			level + 1, g_ladderCount, GG_WEAPON_TITLES[g_ladder[level]], g_levelKills[id], kills,
			name, leader ? g_level[leader] + 1 : 0)
	else
		ShowSyncHudMsg(id, g_hudSync, "Level %d/%d | %s | leader: %s (%d)",
			level + 1, g_ladderCount, GG_WEAPON_TITLES[g_ladder[level]], name, leader ? g_level[leader] + 1 : 0)
}

// The player's page draws the mode itself (userinfo wc_html_hud 1, set by
// the page when its game client forwards WcMode).
bool:HtmlHud(id)
{
	if (!g_msgMode || !is_user_connected(id))
		return false
	if (g_modeTest[id])
		return true
	if (is_user_bot(id))
		return false
	new value[4]
	get_user_info(id, "wc_html_hud", value, charsmax(value))
	return value[0] == '1' && value[1] == EOS
}

// Sends WcMode (format at the top of the file) to a player with the HTML
// HUD when their state changed since the last send. In classic mode only
// once, after a mode ran (mode 0 hides the page's mode display).
SendMode(id)
{
	if (!HtmlHud(id))
	{
		// Sent again in full if the page turns the HTML HUD back on.
		g_modeSent[id][0] = EOS
		return
	}
	if (g_mode == MODE_CLASSIC && !g_modeSent[id][0])
		return

	new level, levels, kills, killsNeeded, leaderLevel
	new weapon[16], next[16], leader[32], winner[32]
	if (g_mode == MODE_GUNGAME && g_ladderCount)
	{
		level = g_level[id] + 1
		levels = g_ladderCount
		kills = g_levelKills[id]
		killsNeeded = max(get_pcvar_num(g_pGgKillsPerLevel), 1)
		copy(weapon, charsmax(weapon), GG_WEAPON_TITLES[g_ladder[g_level[id]]])
		if (level < levels)
			copy(next, charsmax(next), GG_WEAPON_TITLES[g_ladder[g_level[id] + 1]])
		new top = GgLeader()
		if (top)
		{
			leaderLevel = g_level[top] + 1
			get_user_name(top, leader, charsmax(leader))
		}
		if (g_ggWinner)
			get_user_name(g_ggWinner, winner, charsmax(winner))
	}
	// The end time, not the time left, so a running protection isn't
	// "changed" every poll.
	new Float:glowEnd = g_glowEnd[id]
	new protection = 0
	if (glowEnd > 0.0)
		protection = clamp(floatround((glowEnd - get_gametime()) * 1000.0), 1, 32767)

	new key[sizeof g_modeSent[]]
	formatex(key, charsmax(key), "%d %d %d %d %d %d %.2f %s|%s|%s|%s", g_mode, level, levels,
		kills, killsNeeded, leaderLevel, glowEnd, weapon, next, leader, winner)
	if (equal(key, g_modeSent[id]))
		return
	// After a mode ended, mode 0 goes out once and then nothing.
	if (g_mode == MODE_CLASSIC)
		g_modeSent[id][0] = EOS
	else
		copy(g_modeSent[id], charsmax(g_modeSent[]), key)

	message_begin(MSG_ONE, g_msgMode, _, id)
	write_byte(g_mode)
	write_byte(level)
	write_byte(levels)
	write_byte(min(kills, 255))
	write_byte(min(killsNeeded, 255))
	write_byte(leaderLevel)
	write_short(protection)
	write_string(weapon)
	write_string(next)
	write_string(leader)
	write_string(winner)
	message_end()
}

// A player's name for messages whose text the web client uses as a printf
// format (TextMsg): no '%', and no leading '#' (a translation key).
SafeName(id, name[], len)
{
	get_user_name(id, name, len)
	replace_string(name, len, "%", "")
	if (name[0] == '#')
		name[0] = '*'
}

// --- Server commands ---------------------------------------------------

// Server console: the mode and its cvars (for checking the mode).
public CmdStatus()
{
	server_print("wc_gamemode %d (%s)", g_mode, MODE_NAMES[g_mode])
	new value[192]
	for (new i = 0; i < sizeof MODE_CVARS; i++)
	{
		get_cvar_string(MODE_CVARS[i][CVAR_NAME], value, charsmax(value))
		server_print("  %s ^"%s^"", MODE_CVARS[i][CVAR_NAME], value)
	}
	new hostages, hidden, ent = -1
	while ((ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "hostage_entity")) > 0)
	{
		hostages++
		if (pev(ent, pev_effects) & EF_NODRAW)
			hidden++
	}
	server_print("  wc_dm_fraglimit %d, %d spawn points, %d spawn triggers, %d hostages (%d hidden)",
		get_pcvar_num(g_pFragLimit), g_spawnCount, g_spawnTriggerCount, hostages, hidden)
	server_print("  WcMode message id %d", g_msgMode)
	new name[32]
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || (is_user_bot(id) && !g_modeTest[id]))
			continue
		get_user_name(id, name, charsmax(name))
		server_print("  #%d %s html_hud %d sent ^"%s^"", get_user_userid(id), name, HtmlHud(id), g_modeSent[id])
	}
	return PLUGIN_HANDLED
}

// Server console: each player's state (for the Deathmatch smoke test):
// team, alive, health/armour, glowing (protected), frags, flashbangs,
// money, position, weapons.
public CmdDmStatus()
{
	server_print("wc_dm_status mode %d time %.1f", g_mode, get_gametime())
	new weapons[32], num, wname[32], line[192], name[32]
	new Float:origin[3]
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id))
			continue
		get_user_name(id, name, charsmax(name))
		num = 0
		line[0] = 0
		if (is_user_alive(id))
		{
			get_user_weapons(id, weapons, num)
			for (new w = 0; w < num; w++)
			{
				get_weaponname(weapons[w], wname, charsmax(wname))
				add(line, charsmax(line), " ")
				add(line, charsmax(line), wname[7])
			}
		}
		pev(id, pev_origin, origin)
		server_print("  #%d %s team %d alive %d hp %d ap %d glow %d frags %d flash %d money %d pos %.0f %.0f %.0f:%s",
			get_user_userid(id), name, get_user_team(id), is_user_alive(id), get_user_health(id),
			get_user_armor(id), g_glowEnd[id] != 0.0, get_user_frags(id),
			is_user_alive(id) ? cs_get_user_bpammo(id, CSW_FLASHBANG) : 0, cs_get_user_money(id),
			origin[0], origin[1], origin[2], line)
	}
	return PLUGIN_HANDLED
}

// Server console: wc_dm_guns <userid> <primary 1-16> <pistol 1-6> picks
// guns for a player as the menu does (to test the menu's code path).
public CmdDmGuns()
{
	if (read_argc() < 4)
	{
		server_print("Usage: wc_dm_guns <userid> <primary 1-%d> <pistol 1-%d>", sizeof PRIMARY_GUNS, sizeof SECONDARY_GUNS)
		return PLUGIN_HANDLED
	}
	new id = find_player("k", read_argv_int(1))
	new primary = read_argv_int(2) - 1
	new secondary = read_argv_int(3) - 1
	if (!id || primary < 0 || primary >= sizeof PRIMARY_GUNS || secondary < 0 || secondary >= sizeof SECONDARY_GUNS)
	{
		server_print("wc_dm_guns: no such player or weapon")
		return PLUGIN_HANDLED
	}
	if (g_mode != MODE_DEATHMATCH)
	{
		server_print("wc_dm_guns: not in Deathmatch")
		return PLUGIN_HANDLED
	}
	PickGuns(id, primary, secondary)
	server_print("wc_dm_guns: #%d %s + %s", read_argv_int(1), PRIMARY_GUNS[primary][GUN_NAME], SECONDARY_GUNS[secondary][GUN_NAME])
	return PLUGIN_HANDLED
}

// Server console: Gun Game state (for the smoke test): the ladder, the
// winner, and each player's team, alive, level, kills on it and weapons.
public CmdGgStatus()
{
	server_print("wc_gg_status mode %d levels %d kills_per_level %d winner #%d time %.1f",
		g_mode, g_ladderCount, max(get_pcvar_num(g_pGgKillsPerLevel), 1),
		g_ggWinner ? get_user_userid(g_ggWinner) : 0, get_gametime())
	new weapons[32], num, wname[32], line[192], name[32]
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id))
			continue
		get_user_name(id, name, charsmax(name))
		num = 0
		line[0] = 0
		if (is_user_alive(id))
		{
			get_user_weapons(id, weapons, num)
			for (new w = 0; w < num; w++)
			{
				get_weaponname(weapons[w], wname, charsmax(wname))
				add(line, charsmax(line), " ")
				add(line, charsmax(line), wname[7])
			}
		}
		server_print("  #%d %s team %d alive %d level %d/%d %s kills %d frozen %d:%s",
			get_user_userid(id), name, get_user_team(id), is_user_alive(id), g_level[id] + 1,
			g_ladderCount, g_ladderCount ? GG_WEAPON_TITLES[g_ladder[g_level[id]]] : "-",
			g_levelKills[id], (pev(id, pev_flags) & FL_FROZEN) != 0, line)
	}
	return PLUGIN_HANDLED
}

// Server console: wc_gg_setlevel <userid> <level> (tests: e.g. put a bot on
// the last level).
public CmdGgSetLevel()
{
	if (read_argc() < 3)
	{
		server_print("Usage: wc_gg_setlevel <userid> <level 1-%d>", g_ladderCount)
		return PLUGIN_HANDLED
	}
	new id = find_player("k", read_argv_int(1))
	new level = read_argv_int(2) - 1
	if (g_mode != MODE_GUNGAME || !id || level < 0 || level >= g_ladderCount)
	{
		server_print("wc_gg_setlevel: not in Gun Game, or no such player or level")
		return PLUGIN_HANDLED
	}
	g_level[id] = level
	g_levelKills[id] = 0
	remove_task(TASK_HE + id)
	if (is_user_alive(id))
		GgScheduleEquip(id)
	server_print("wc_gg_setlevel: #%d level %d (%s)", read_argv_int(1), level + 1, GG_WEAPON_TITLES[g_ladder[level]])
	return PLUGIN_HANDLED
}

// Server console: wc_mode_test <userid> <0|1> (tests: send WcMode to that
// player, a bot too, as if their page had set wc_html_hud 1; the state sent
// shows in wc_gamemode_status).
public CmdModeTest()
{
	new id = read_argc() >= 3 ? find_player("k", read_argv_int(1)) : 0
	if (!id)
	{
		server_print("Usage: wc_mode_test <userid> <0|1>")
		return PLUGIN_HANDLED
	}
	g_modeTest[id] = read_argv_int(2) != 0
	g_modeSent[id][0] = EOS
	SendMode(id)
	server_print("wc_mode_test: #%d %d sent ^"%s^"", read_argv_int(1), g_modeTest[id], g_modeSent[id])
	return PLUGIN_HANDLED
}
