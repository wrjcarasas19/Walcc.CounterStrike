// Co-op vs bots (wc_coop) for wc_gamemode.sma, which includes this file
// after its globals; the behaviour is described at the top of that file.

#if defined _wc_gm_coop_included
	#endinput
#endif
#define _wc_gm_coop_included

// Game and YaPB cvars co-op holds while it runs (set again on each poll:
// yapb.cfg runs on every map change and sets yb_join_team back).
enum _:CoopCvar { COOP_NAME[24], COOP_VALUE[8] }
new const COOP_CVARS[][CoopCvar] = {
	// ReGameDLL: humans can only join the Counter-Terrorists.
	{ "humans_join_team", "CT" },
	// YaPB: bots join the Terrorists.
	{ "yb_join_team", "T" },
	// The teams are uneven on purpose.
	{ "mp_autoteambalance", "0" },
	{ "mp_limitteams", "0" },
	// yb_quota counts humans and bots (the plugin sets it, CoopQuota).
	{ "yb_quota_mode", "fill" }
}
// Cvars whose value from before co-op is put back when it ends: the ones
// above, the bot count (the Bots tab's or BOT_QUOTA's) and the difficulty
// (wc_coop_adapt, Survival). Each is saved in the cvar wc_saved_<name> as
// "=<value>" ("" when nothing is saved), so the value outlives the map
// change: co-op is kept over map changes and ends on a later map.
new const COOP_SAVED_EXTRA[][] = { "yb_quota", "yb_difficulty" }

// A moved player gets one of the new team's characters.
new const CsInternalModel:COOP_T_MODELS[] = { CS_T_TERROR, CS_T_LEET, CS_T_ARCTIC, CS_T_GUERILLA }
new const CsInternalModel:COOP_CT_MODELS[] = { CS_CT_URBAN, CS_CT_GSG9, CS_CT_SAS, CS_CT_GIGN }

#define COOP_DIFFICULTY_MIN 1
#define COOP_DIFFICULTY_MAX 4
// Rounds in a row won (or lost) by the humans before wc_coop_adapt moves
// the difficulty one step.
#define COOP_ADAPT_STREAK 2

new g_pCoop
new g_pCoopRatio
new g_pCoopMaxBots
new g_pCoopAdapt
new g_pYbQuota
new g_pYbDifficulty
// The co-op cvars are set (follows CoopWanted on each poll).
new bool:g_coopOn
// wc_coop_adapt: rounds in a row the humans won (> 0) or lost (< 0).
new g_coopStreak

CoopInit()
{
	// FCVAR_SERVER: the page (/status.json) greys out the Terrorists.
	g_pCoop = register_cvar("wc_coop", "0", FCVAR_SERVER)
	g_pCoopRatio = register_cvar("wc_coop_ratio", "3")
	g_pCoopMaxBots = register_cvar("wc_coop_max_bots", "10")
	g_pCoopAdapt = register_cvar("wc_coop_adapt", "0")
	for (new i = 0; i < sizeof COOP_CVARS; i++)
		RegisterSavedCvar(COOP_CVARS[i][COOP_NAME])
	for (new i = 0; i < sizeof COOP_SAVED_EXTRA; i++)
		RegisterSavedCvar(COOP_SAVED_EXTRA[i])
	g_pYbQuota = get_cvar_pointer("yb_quota")
	g_pYbDifficulty = get_cvar_pointer("yb_difficulty")
	// Team "CT" triggered "Bomb_Defused" (CT "1") (T "0"): every round win
	// (the team is argument 1); a draw is a World line.
	register_logevent("CoopOnTeamWin", 6, "0=Team", "2=triggered")
}

// plugin_cfg: co-op outlives the map; apply it again, or put the saved
// values back if it ended with the last map (a Zombies or Survival game
// with wc_coop 0). No restart: the map has just started.
CoopCfg()
{
	g_coopOn = CoopSavedValues()
	if (CoopWanted())
		CoopStart(false)
	else if (g_coopOn)
		CoopEnd(false)
}

bool:CoopWanted()
{
	return get_pcvar_num(g_pCoop) != 0
}

// Values from before co-op are saved (co-op ran on this map or the last).
bool:CoopSavedValues()
{
	new value[16]
	return SavedCvarValue(COOP_CVARS[0][COOP_NAME], value, charsmax(value))
}

// Starts or ends co-op when wanted changes (each poll, and before a
// scheduled restart so that it moves the teams).
CoopFollow(bool:restart)
{
	new bool:wanted = CoopWanted()
	if (wanted && !g_coopOn)
		CoopStart(restart)
	else if (!wanted && g_coopOn)
		CoopEnd(restart)
}

CoopStart(bool:restart)
{
	g_coopOn = true
	g_coopStreak = 0
	for (new i = 0; i < sizeof COOP_CVARS; i++)
		SaveCvar(COOP_CVARS[i][COOP_NAME])
	for (new i = 0; i < sizeof COOP_SAVED_EXTRA; i++)
		SaveCvar(COOP_SAVED_EXTRA[i])
	CoopHoldCvars()
	CoopUpdateQuota()
	for (new id = 1; id <= MaxClients; id++)
		CoopMovePlayer(id, true)
	log_amx("Co-op: on (%d humans, yb_quota %d)", CoopHumans(), CoopQuota())
	client_print(0, print_chat, "[Server] Co-op vs bots: humans are the Counter-Terrorists, bots the Terrorists.")
	if (restart)
		ScheduleModeRestart()
}

CoopEnd(bool:restart)
{
	g_coopOn = false
	g_coopStreak = 0
	for (new i = 0; i < sizeof COOP_CVARS; i++)
		RestoreCvar(COOP_CVARS[i][COOP_NAME])
	for (new i = 0; i < sizeof COOP_SAVED_EXTRA; i++)
		RestoreCvar(COOP_SAVED_EXTRA[i])
	log_amx("Co-op: off")
	client_print(0, print_chat, "[Server] Co-op vs bots: off. Teams are open again.")
	if (restart)
		ScheduleModeRestart()
}

// Once a second.
CoopPoll()
{
	CoopFollow(true)
	if (!g_coopOn)
		return
	CoopHoldCvars()
	CoopUpdateQuota()
	for (new id = 1; id <= MaxClients; id++)
		CoopMovePlayer(id, false)
}

CoopHoldCvars()
{
	new value[16]
	for (new i = 0; i < sizeof COOP_CVARS; i++)
	{
		get_cvar_string(COOP_CVARS[i][COOP_NAME], value, charsmax(value))
		if (!equal(value, COOP_CVARS[i][COOP_VALUE]))
			set_cvar_string(COOP_CVARS[i][COOP_NAME], COOP_CVARS[i][COOP_VALUE])
	}
}

// Humans in the game: connected players who aren't bots or spectators.
CoopHumans()
{
	new count = 0
	for (new id = 1; id <= MaxClients; id++)
	{
		if (is_user_connected(id) && !is_user_bot(id) && !is_user_hltv(id) && get_user_team(id) != 3)
			count++
	}
	return count
}

// Bots for this many humans: wc_coop_ratio each, at most wc_coop_max_bots.
CoopBots(humans)
{
	return min(humans * max(get_pcvar_num(g_pCoopRatio), 1), max(get_pcvar_num(g_pCoopMaxBots), 1))
}

// yb_quota in fill mode counts humans and bots.
CoopQuota()
{
	new humans = CoopHumans()
	return humans + CoopBots(humans)
}

CoopUpdateQuota()
{
	if (!g_pYbQuota)
		return
	new quota = CoopQuota()
	if (get_pcvar_num(g_pYbQuota) != quota)
		set_pcvar_num(g_pYbQuota, quota)
}

// Bots to the Terrorists, humans to the Counter-Terrorists: everyone at the
// start (a restart follows), later only the dead (they wait for a spawn
// anyway). Spectators stay. Zombies' infected humans are alive on T.
CoopMovePlayer(id, bool:alive)
{
	if (!is_user_connected(id) || is_user_hltv(id) || (!alive && is_user_alive(id)))
		return
	new CsTeams:team = cs_get_user_team(id)
	if (is_user_bot(id) && team == CS_TEAM_CT)
		cs_set_user_team(id, CS_TEAM_T, COOP_T_MODELS[random(sizeof COOP_T_MODELS)])
	else if (!is_user_bot(id) && team == CS_TEAM_T)
		cs_set_user_team(id, CS_TEAM_CT, COOP_CT_MODELS[random(sizeof COOP_CT_MODELS)])
}

// wc_coop_adapt 1: harder after the humans win COOP_ADAPT_STREAK rounds in
// a row, easier after they lose as many.
public CoopOnTeamWin()
{
	if (!g_coopOn || !get_pcvar_num(g_pCoopAdapt) || !g_pYbDifficulty)
		return
	new team[16]
	read_logargv(1, team, charsmax(team))
	new bool:humansWon = bool:equal(team, "CT")
	if (!humansWon && !equal(team, "TERRORIST"))
		return
	if (humansWon)
		g_coopStreak = g_coopStreak > 0 ? g_coopStreak + 1 : 1
	else
		g_coopStreak = g_coopStreak < 0 ? g_coopStreak - 1 : -1
	if (abs(g_coopStreak) < COOP_ADAPT_STREAK)
		return
	new old = get_pcvar_num(g_pYbDifficulty)
	new difficulty = clamp(old + (humansWon ? 1 : -1), COOP_DIFFICULTY_MIN, COOP_DIFFICULTY_MAX)
	g_coopStreak = 0
	if (difficulty == old)
		return
	set_pcvar_num(g_pYbDifficulty, difficulty)
	log_amx("Co-op: bot difficulty %d (humans %s %d rounds in a row)", difficulty, humansWon ? "won" : "lost", COOP_ADAPT_STREAK)
	client_print(0, print_chat, "[Server] Co-op: the bots got %s (difficulty %d).", humansWon ? "harder" : "easier", difficulty)
}

// Server console: what co-op set and why.
public CmdCoopStatus()
{
	server_print("wc_coop %d (on %d), ratio %d, max bots %d, adapt %d, streak %d",
		get_pcvar_num(g_pCoop), g_coopOn, get_pcvar_num(g_pCoopRatio),
		get_pcvar_num(g_pCoopMaxBots), get_pcvar_num(g_pCoopAdapt), g_coopStreak)
	new value[32], saved[32]
	for (new i = 0; i < sizeof COOP_CVARS; i++)
	{
		get_cvar_string(COOP_CVARS[i][COOP_NAME], value, charsmax(value))
		SavedCvarValue(COOP_CVARS[i][COOP_NAME], saved, charsmax(saved))
		server_print("  %s ^"%s^" (before co-op ^"%s^")", COOP_CVARS[i][COOP_NAME], value, saved)
	}
	for (new i = 0; i < sizeof COOP_SAVED_EXTRA; i++)
	{
		get_cvar_string(COOP_SAVED_EXTRA[i], value, charsmax(value))
		SavedCvarValue(COOP_SAVED_EXTRA[i], saved, charsmax(saved))
		server_print("  %s ^"%s^" (before co-op ^"%s^")", COOP_SAVED_EXTRA[i], value, saved)
	}
	new humans = CoopHumans()
	new bots = 0, ct = 0, t = 0
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id))
			continue
		if (is_user_bot(id))
			bots++
		switch (cs_get_user_team(id))
		{
			case CS_TEAM_CT: ct++
			case CS_TEAM_T: t++
		}
	}
	server_print("  humans %d, bots %d (wanted %d), CT %d, T %d, quota %d", humans, bots, CoopBots(humans), ct, t, CoopQuota())
	return PLUGIN_HANDLED
}

// --- Saved cvars (wc_saved_<name>) ---------------------------------------

RegisterSavedCvar(const name[])
{
	new saved[40]
	formatex(saved, charsmax(saved), "wc_saved_%s", name)
	register_cvar(saved, "")
}

// Keeps name's value unless one is saved already (from the last map).
SaveCvar(const name[])
{
	new saved[40], value[64]
	formatex(saved, charsmax(saved), "wc_saved_%s", name)
	get_cvar_string(saved, value, charsmax(value))
	if (value[0])
		return
	value[0] = '='
	get_cvar_string(name, value[1], charsmax(value) - 1)
	set_cvar_string(saved, value)
}

// Puts the saved value back and forgets it.
RestoreCvar(const name[])
{
	new value[64]
	if (!SavedCvarValue(name, value, charsmax(value)))
		return
	set_cvar_string(name, value)
	new saved[40]
	formatex(saved, charsmax(saved), "wc_saved_%s", name)
	set_cvar_string(saved, "")
}

// The saved value of name in value; false (and "") if none.
bool:SavedCvarValue(const name[], value[], len)
{
	new saved[40], text[64]
	formatex(saved, charsmax(saved), "wc_saved_%s", name)
	get_cvar_string(saved, text, charsmax(text))
	value[0] = EOS
	if (text[0] != '=')
		return false
	copy(value, len, text[1])
	return true
}
