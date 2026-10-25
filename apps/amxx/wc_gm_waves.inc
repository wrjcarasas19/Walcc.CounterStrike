// Survival waves (wc_gamemode 4) for wc_gamemode.sma, which includes this
// file after its globals; the behaviour is described at the top of that
// file.

#if defined _wc_gm_waves_included
	#endinput
#endif
#define _wc_gm_waves_included

#define TASK_WV_EQUIP 5200
#define TASK_WV_LOST  5300
#define TASK_WV_WIN   5400

// Wave states: waiting for the restart's new round, fighting, the break
// after a cleared wave, all humans dead (restarting), all waves cleared.
#define WAVE_STARTING 0
#define WAVE_FIGHT    1
#define WAVE_BREAK    2
#define WAVE_LOST     3
#define WAVE_WON      4

// Seconds a killed bot stays dead before it comes back (while the wave
// still has bots to send).
#define WAVE_RESPAWN_DELAY 2.0
// Seconds "Reached wave N" shows before the game restarts at wave 1.
#define WAVE_LOST_DELAY 5.0
// Seconds after a restart before wave 1 starts if no Round_Start line came.
#define WAVE_START_FALLBACK 3.0
// Boss health per human, and bot health per wave (x (1 + 0.15 N)).
#define WAVE_BOSS_HEALTH 3000
#define WAVE_HEALTH_STEP 0.15
// Money each human gets at a break: base + per wave number.
#define WAVE_MONEY_BASE 2000
#define WAVE_MONEY_PER_WAVE 500
#define WAVE_MONEY_MAX 16000

// Bot guns by wave: pistols (waves 1-2), SMGs and shotguns (3-4), rifles
// (5-7), rifles and the AWP (8 and up).
new const WAVE_PISTOLS[] = { CSW_GLOCK18, CSW_USP, CSW_P228, CSW_FIVESEVEN, CSW_DEAGLE, CSW_ELITE }
new const WAVE_SMGS[] = { CSW_MP5NAVY, CSW_TMP, CSW_MAC10, CSW_UMP45, CSW_P90, CSW_M3, CSW_XM1014 }
new const WAVE_RIFLES[] = { CSW_AK47, CSW_M4A1, CSW_GALIL, CSW_FAMAS, CSW_SG552, CSW_AUG }

new g_pWaveSize
new g_pWaveCount
new g_pWaveBossEvery
new g_pWaveBreak
new g_waveState = WAVE_STARTING
// The wave (1-based, 0 before the first), its size (bots to kill), bots
// killed and sent so far, and the boss (0: none alive or not this wave).
new g_wave
new g_waveSize
new g_waveKills
new g_waveSpawned
new g_waveBoss
new bool:g_waveBossDue
// When the break ends, and when the restart before wave 1 happened.
new Float:g_waveBreakEnd
new Float:g_waveStartAt
// Per bot: when it died (for the respawn delay).
new Float:g_waveDeadSince[MAX_PLAYERS + 1]

WvInit()
{
	g_pWaveSize = register_cvar("wc_wave_size", "6")
	g_pWaveCount = register_cvar("wc_wave_count", "10")
	g_pWaveBossEvery = register_cvar("wc_wave_boss_every", "5")
	g_pWaveBreak = register_cvar("wc_wave_break", "12")
	// mp_buytime is -1 (no limit) while the mode runs; buying is allowed
	// only in the breaks (OnBuy).
	RegisterSavedCvar("mp_buytime")

	RegisterHam(Ham_Killed, "player", "WvOnKilled", 1)
	register_logevent("WvOnRoundStart", 2, "1=Round_Start")
}

// plugin_cfg: each map starts in classic mode; put back the buy time if the
// last map ended during Survival.
WvCfg()
{
	RestoreCvar("mp_buytime")
}

WvStart()
{
	SaveCvar("mp_buytime")
	set_cvar_string("mp_buytime", "-1")
	WvReset()
}

WvStop()
{
	remove_task(TASK_WV_LOST)
	remove_task(TASK_WV_WIN)
	for (new id = 1; id <= MaxClients; id++)
	{
		remove_task(TASK_WV_EQUIP + id)
		if (!is_user_connected(id))
			continue
		if (g_waveState == WAVE_WON && is_user_alive(id))
			Unfreeze(id)
		if (!is_user_bot(id) && !HtmlHud(id))
			ClearSyncHud(id, g_hudSync)
	}
	if (g_waveBoss && is_user_connected(g_waveBoss))
		set_user_rendering(g_waveBoss)
	g_waveBoss = 0
	g_waveState = WAVE_STARTING
	RestoreCvar("mp_buytime")
	// Co-op's difficulty from before (co-op may stay on with wc_coop 1).
	new difficulty[8]
	if (g_pYbDifficulty && SavedCvarValue("yb_difficulty", difficulty, charsmax(difficulty)))
		set_pcvar_string(g_pYbDifficulty, difficulty)
}

// A restart (the mode starting, a wipe, the admin): wave 1 starts with the
// new round.
WvReset()
{
	remove_task(TASK_WV_LOST)
	g_waveState = WAVE_STARTING
	g_wave = 0
	g_waveKills = 0
	g_waveSpawned = 0
	g_waveBoss = 0
	g_waveStartAt = get_gametime()
}

public WvOnRoundStart()
{
	if (g_mode == MODE_SURVIVAL && g_waveState == WAVE_STARTING)
		WvNextWave()
}

// Bots: wave N kills (wc_wave_size + 2 N) per human.
WvSizeOf(wave)
{
	return (max(get_pcvar_num(g_pWaveSize), 1) + 2 * wave) * max(CoopHumans(), 1)
}

WvCount()
{
	return max(get_pcvar_num(g_pWaveCount), 1)
}

// g_bot, not is_user_bot: a bot isn't one during its respawn (WvSpawn).
bool:WvIsBot(id)
{
	return is_user_connected(id) && g_bot[id] && cs_get_user_team(id) == CS_TEAM_T
}

WvNextWave()
{
	g_wave++
	g_waveState = WAVE_FIGHT
	g_waveSize = WvSizeOf(g_wave)
	g_waveKills = 0
	g_waveSpawned = 0
	g_waveBoss = 0
	new every = get_pcvar_num(g_pWaveBossEvery)
	g_waveBossDue = every > 0 && g_wave % every == 0
	if (g_pYbDifficulty)
		set_pcvar_num(g_pYbDifficulty, min(1 + g_wave / 2, 4))
	// Bots still alive (the restart's new round) fight in this wave.
	for (new id = 1; id <= MaxClients; id++)
	{
		if (WvIsBot(id) && is_user_alive(id))
			WvBotSpawned(id)
	}
	log_amx("Survival: wave %d/%d, %d bots, boss %d", g_wave, WvCount(), g_waveSize, g_waveBossDue)
	client_print(0, print_center, "Wave %d/%d: %d bots", g_wave, WvCount(), g_waveSize)
	client_print(0, print_chat, "[Server] Survival: wave %d of %d, %d bots to kill.", g_wave, WvCount(), g_waveSize)
	WvShowAll()
}

// A bot entered this wave (spawned or alive at its start): counted, and
// equipped a moment later; past the wave's size it is sent back.
WvBotSpawned(id)
{
	if (g_waveSpawned >= g_waveSize)
	{
		remove_task(TASK_WV_EQUIP + id)
		set_task(0.1, "WvSendBack", TASK_WV_EQUIP + id)
		return
	}
	g_waveSpawned++
	remove_task(TASK_WV_EQUIP + id)
	set_task(0.1, "WvEquip", TASK_WV_EQUIP + id)
}

public WvSendBack(taskid)
{
	new id = taskid - TASK_WV_EQUIP
	if (is_user_alive(id))
		user_silentkill(id, 1)
}

// OnPlayerSpawn in Survival.
WvSpawn(id)
{
	if (!WvIsBot(id))
		return
	switch (g_waveState)
	{
		// The restart's new round: WvNextWave counts the bots alive.
		case WAVE_STARTING: return
		case WAVE_FIGHT: WvBotSpawned(id)
		// No bots during the break (a bot joining then).
		case WAVE_BREAK:
		{
			remove_task(TASK_WV_EQUIP + id)
			set_task(0.1, "WvSendBack", TASK_WV_EQUIP + id)
		}
	}
}

public WvEquip(taskid)
{
	new id = taskid - TASK_WV_EQUIP
	if (g_mode != MODE_SURVIVAL || !is_user_alive(id) || !WvIsBot(id))
		return
	WcStripWeapons(id, WC_PRIMARIES | WC_PISTOLS | WC_GRENADES | (1 << CSW_C4))
	new primary = 0, pistol = WAVE_PISTOLS[random(sizeof WAVE_PISTOLS)]
	if (g_wave >= 8)
		primary = random(4) == 0 ? CSW_AWP : WAVE_RIFLES[random(sizeof WAVE_RIFLES)]
	else if (g_wave >= 5)
		primary = WAVE_RIFLES[random(sizeof WAVE_RIFLES)]
	else if (g_wave >= 3)
		primary = WAVE_SMGS[random(sizeof WAVE_SMGS)]
	if (g_waveBossDue && !g_waveBoss)
	{
		// The first bot of a boss wave is the boss.
		g_waveBoss = id
		primary = CSW_M249
		set_user_health(id, WAVE_BOSS_HEALTH * max(CoopHumans(), 1))
		set_user_rendering(id, kRenderFxGlowShell, 255, 30, 30, kRenderNormal, 30)
		new name[32]
		SafeName(id, name, charsmax(name))
		log_amx("Survival: boss #%d on wave %d", get_user_userid(id), g_wave)
		client_print(0, print_center, "Boss incoming: %s!", name)
		client_print(0, print_chat, "[Server] Survival: boss incoming! %s has an M249 and %d HP.", name, get_user_health(id))
	}
	else
		set_user_health(id, floatround(100.0 * (1.0 + WAVE_HEALTH_STEP * float(g_wave))))
	WcGiveWeapon(id, pistol)
	if (primary)
		WcGiveWeapon(id, primary)
	new wname[32]
	get_weaponname(primary ? primary : pistol, wname, charsmax(wname))
	engclient_cmd(id, wname)
}

public WvOnKilled(victim, attacker)
{
	if (g_mode != MODE_SURVIVAL)
		return HAM_IGNORED
	remove_task(TASK_WV_EQUIP + victim)
	g_waveDeadSince[victim] = get_gametime()
	if (g_waveState != WAVE_FIGHT)
		return HAM_IGNORED
	if (WvIsBot(victim))
	{
		g_waveKills++
		if (victim == g_waveBoss)
		{
			g_waveBoss = 0
			client_print(0, print_chat, "[Server] Survival: the boss is down!")
		}
		if (g_waveKills >= g_waveSize)
			WvCleared()
		else
			WvShowAll()
	}
	else
		WvCheckWipe()
	return HAM_IGNORED
}

// Humans on CT but none of them alive: the wave is lost.
WvCheckWipe()
{
	if (g_waveState != WAVE_FIGHT)
		return
	new humans = 0
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id) || cs_get_user_team(id) != CS_TEAM_CT)
			continue
		if (is_user_alive(id))
			return
		humans++
	}
	if (!humans)
		return
	g_waveState = WAVE_LOST
	log_amx("Survival: lost on wave %d", g_wave)
	client_print(0, print_center, "Reached wave %d", g_wave)
	client_print(0, print_chat, "[Server] Survival: everyone is down. You reached wave %d. Starting again from wave 1.", g_wave)
	set_task(WAVE_LOST_DELAY, "WvRestart", TASK_WV_LOST)
	WvShowAll()
}

public WvRestart()
{
	if (g_mode != MODE_SURVIVAL || g_waveState != WAVE_LOST)
		return
	server_cmd("sv_restart 1")
}

WvCleared()
{
	// Out of WAVE_FIGHT first, so the bots killed here don't count.
	g_waveState = WAVE_BREAK
	// Bots sent beyond the wave's size, if any.
	for (new id = 1; id <= MaxClients; id++)
	{
		if (WvIsBot(id) && is_user_alive(id))
			user_silentkill(id, 1)
	}
	// For the leaderboard (apps/server/statsfollow.go), in the game's
	// format, for every human on CT, dead or alive.
	WvLogHumans("^"%s<%d><%s><%s>^" triggered ^"wc_wave_clear^" (wave ^"%d^")", g_wave)
	if (g_wave >= WvCount())
	{
		WvWin()
		return
	}
	g_waveBreakEnd = get_gametime() + float(clamp(get_pcvar_num(g_pWaveBreak), 1, 300))
	new money = WAVE_MONEY_BASE + WAVE_MONEY_PER_WAVE * g_wave
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id) || cs_get_user_team(id) != CS_TEAM_CT)
			continue
		cs_set_user_money(id, min(cs_get_user_money(id) + money, WAVE_MONEY_MAX))
		if (!is_user_alive(id))
			ExecuteHamB(Ham_CS_RoundRespawn, id)
	}
	log_amx("Survival: wave %d cleared", g_wave)
	client_print(0, print_center, "Wave %d cleared! Buy anywhere for %d seconds.", g_wave, floatround(g_waveBreakEnd - get_gametime()))
	client_print(0, print_chat, "[Server] Survival: wave %d cleared. Everyone gets $%d; the dead are back. Buy anywhere until the next wave.", g_wave, money)
	WvShowAll()
}

WvWin()
{
	g_waveState = WAVE_WON
	WvLogHumans("^"%s<%d><%s><%s>^" triggered ^"wc_wave_win^"", 0)
	new nextMap[64]
	GgNextMapName(nextMap, charsmax(nextMap))
	log_amx("Survival: all %d waves cleared; next map %s", g_wave, nextMap)
	client_print(0, print_center, "Survived all %d waves!", g_wave)
	client_print(0, print_chat, "[Server] Survival: you survived all %d waves! Next map: %s.", g_wave, nextMap)
	for (new id = 1; id <= MaxClients; id++)
	{
		if (is_user_alive(id))
			Freeze(id)
	}
	set_task(GG_WIN_DELAY, "WvNextMap", TASK_WV_WIN)
	WvShowAll()
}

public WvNextMap()
{
	if (g_mode != MODE_SURVIVAL || g_waveState != WAVE_WON)
		return
	new map[64]
	GgNextMapName(map, charsmax(map))
	server_cmd("changelevel %s", map)
}

// One log line per human on CT; format takes name, userid, auth, team and,
// if it has one, the wave.
WvLogHumans(const format[], wave)
{
	new name[32], authid[64], team[32]
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id) || is_user_bot(id) || cs_get_user_team(id) != CS_TEAM_CT)
			continue
		// The real name, as a format argument.
		get_user_name(id, name, charsmax(name))
		get_user_authid(id, authid, charsmax(authid))
		get_user_team(id, team, charsmax(team))
		log_message(format, name, get_user_userid(id), authid, team, wave)
	}
}

// Once a second.
WvPoll()
{
	new Float:now = get_gametime()
	switch (g_waveState)
	{
		case WAVE_STARTING:
		{
			if (now - g_waveStartAt >= WAVE_START_FALLBACK)
				WvNextWave()
		}
		case WAVE_FIGHT:
		{
			WvRespawnBots(now)
			if (g_waveBoss && is_user_alive(g_waveBoss) && g_glowEnd[g_waveBoss] == 0.0)
				set_user_rendering(g_waveBoss, kRenderFxGlowShell, 255, 30, 30, kRenderNormal, 30)
			WvCheckWipe()
		}
		case WAVE_BREAK:
		{
			if (now >= g_waveBreakEnd)
				WvNextWave()
		}
	}
	WvShowAll()
}

// Sends dead bots back in while the wave has bots left to send.
WvRespawnBots(Float:now)
{
	for (new id = 1; id <= MaxClients && g_waveSpawned < g_waveSize; id++)
	{
		if (!WvIsBot(id) || is_user_alive(id) || now - g_waveDeadSince[id] < WAVE_RESPAWN_DELAY)
			continue
		// The spawn hook counts it (WvSpawn).
		ExecuteHamB(Ham_CS_RoundRespawn, id)
	}
}

// "Wave", "Boss" or "Break" (WcMode's weapon field).
WvPhase(text[], len)
{
	if (g_waveState == WAVE_BREAK)
		copy(text, len, "Break")
	else if (g_waveBoss)
		copy(text, len, "Boss")
	else
		copy(text, len, "Wave")
}

// Seconds left in the break, 0 otherwise.
WvBreakLeft()
{
	if (g_waveState != WAVE_BREAK)
		return 0
	return max(floatround(g_waveBreakEnd - get_gametime(), floatround_ceil), 0)
}

WvShowAll()
{
	for (new id = 1; id <= MaxClients; id++)
		ShowWvHud(id)
}

// Top centre: "Wave 4/10 | 12/20 killed", "Wave 5/10 | Boss | 3/22 killed",
// "Wave 4/10 cleared | next in 8 s"; players with the HTML HUD get WcMode
// instead.
ShowWvHud(id)
{
	if (g_mode != MODE_SURVIVAL || !is_user_connected(id) || is_user_bot(id))
		return
	if (HtmlHud(id))
	{
		SendMode(id)
		return
	}
	set_hudmessage(255, 160, 60, -1.0, 0.02, 0, 0.0, 1.3, 0.0, 0.0, -1)
	switch (g_waveState)
	{
		case WAVE_BREAK: ShowSyncHudMsg(id, g_hudSync, "Wave %d/%d cleared | next in %d s", g_wave, WvCount(), WvBreakLeft())
		case WAVE_WON: ShowSyncHudMsg(id, g_hudSync, "Survived all %d waves!", g_wave)
		case WAVE_LOST: ShowSyncHudMsg(id, g_hudSync, "Reached wave %d", g_wave)
		default:
		{
			if (g_waveBoss)
				ShowSyncHudMsg(id, g_hudSync, "Wave %d/%d | Boss | %d/%d killed", max(g_wave, 1), WvCount(), g_waveKills, g_waveSize)
			else
				ShowSyncHudMsg(id, g_hudSync, "Wave %d/%d | %d/%d killed", max(g_wave, 1), WvCount(), g_waveKills, g_waveSize)
		}
	}
}

// Server console: the wave, kills, bots alive and the boss.
public CmdWaveStatus()
{
	new alive = 0, bots = 0
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!WvIsBot(id))
			continue
		bots++
		if (is_user_alive(id))
			alive++
	}
	server_print("wc_wave_status mode %d state %d wave %d/%d killed %d/%d sent %d bots %d alive %d boss #%d (due %d) break %d s difficulty %d",
		g_mode, g_waveState, g_wave, WvCount(), g_waveKills, g_waveSize, g_waveSpawned, bots, alive,
		g_waveBoss ? get_user_userid(g_waveBoss) : 0, g_waveBossDue, WvBreakLeft(),
		g_pYbDifficulty ? get_pcvar_num(g_pYbDifficulty) : -1)
	new name[32], weapons[32], num, wname[32], line[128]
	for (new id = 1; id <= MaxClients; id++)
	{
		if (!is_user_connected(id))
			continue
		get_user_name(id, name, charsmax(name))
		num = 0
		line[0] = EOS
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
		server_print("  #%d %s team %d alive %d hp %d money %d:%s", get_user_userid(id), name,
			get_user_team(id), is_user_alive(id), get_user_health(id), cs_get_user_money(id), line)
	}
	return PLUGIN_HANDLED
}

// Server console: wc_wave_set <n> starts wave n now (tests).
public CmdWaveSet()
{
	new wave = read_argc() >= 2 ? read_argv_int(1) : 0
	if (g_mode != MODE_SURVIVAL || wave < 1 || wave > WvCount())
	{
		server_print("Usage: wc_wave_set <wave 1-%d> (in Survival)", WvCount())
		return PLUGIN_HANDLED
	}
	remove_task(TASK_WV_LOST)
	// Not counted: the state isn't WAVE_FIGHT while they die.
	g_waveState = WAVE_STARTING
	for (new id = 1; id <= MaxClients; id++)
	{
		if (WvIsBot(id) && is_user_alive(id))
			user_silentkill(id, 1)
	}
	g_wave = wave - 1
	WvNextWave()
	server_print("wc_wave_set: wave %d, %d bots, boss %d", g_wave, g_waveSize, g_waveBossDue)
	return PLUGIN_HANDLED
}
