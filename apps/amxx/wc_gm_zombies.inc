// Zombies (wc_gamemode 3) for wc_gamemode.sma, which includes this file
// after its globals; the behaviour is described at the top of that file.

#if defined _wc_gm_zombies_included
	#endinput
#endif
#define _wc_gm_zombies_included

#define TASK_ZM_EQUIP  5000
#define TASK_ZM_INFECT 5100

// Seconds before the round timer runs out when the remaining zombies die.
#define ZM_TIMEOUT_EARLY 1.0
// Knockback: push speed (units/s) per point of damage at wc_zm_knockback 1,
// and the most one hit adds.
#define ZM_KNOCKBACK_SCALE 6.0
#define ZM_KNOCKBACK_MAX 600.0
// Seconds after death before an infected human comes back as a zombie.
#define ZM_INFECT_DELAY 1.0

new g_pZmHealth
new g_pZmHealthPerHuman
new g_pZmSpeed
new g_pZmGravity
new g_pZmDamage
new g_pZmKnockback
new g_pZmInfect
new g_pRoundTime
// Round number since the mode started (Round_Start lines), the zombies at
// its start, and when its timer runs out (0: not running).
new g_zmRound
new g_zmStartCount
new Float:g_zmRoundEnd
// Humans turned into zombies this round (wc_zm_infect 1).
new bool:g_zmInfected[MAX_PLAYERS + 1]

ZmInit()
{
	g_pZmHealth = register_cvar("wc_zm_health", "1000")
	g_pZmHealthPerHuman = register_cvar("wc_zm_health_per_human", "250")
	g_pZmSpeed = register_cvar("wc_zm_speed", "300")
	g_pZmGravity = register_cvar("wc_zm_gravity", "0.7")
	g_pZmDamage = register_cvar("wc_zm_damage", "2.0")
	g_pZmKnockback = register_cvar("wc_zm_knockback", "1.0")
	g_pZmInfect = register_cvar("wc_zm_infect", "0")
	g_pRoundTime = get_cvar_pointer("mp_roundtime")

	RegisterHam(Ham_TakeDamage, "player", "ZmOnTakeDamage")
	RegisterHam(Ham_TakeDamage, "player", "ZmOnTakeDamagePost", 1)
	RegisterHam(Ham_Killed, "player", "ZmOnKilled", 1)
	// The game sets the speed again on every weapon switch (and more).
	RegisterHam(Ham_CS_Player_ResetMaxSpeed, "player", "ZmOnResetMaxSpeed", 1)
	// World triggered "Round_Start" (after the freeze time) / "Round_End".
	register_logevent("ZmOnRoundStart", 2, "1=Round_Start")
	register_logevent("ZmOnRoundEnd", 2, "1=Round_End")
}

ZmStart()
{
	g_zmRound = 0
	g_zmStartCount = 0
	g_zmRoundEnd = 0.0
	arrayset(g_zmInfected, false, sizeof g_zmInfected)
}

// The mode ends: everyone back to normal (the restart that follows
// respawns them as usual).
ZmStop()
{
	g_zmRoundEnd = 0.0
	for (new id = 1; id <= MaxClients; id++)
	{
		remove_task(TASK_ZM_EQUIP + id)
		remove_task(TASK_ZM_INFECT + id)
		ZmCure(id)
		if (!is_user_connected(id))
			continue
		set_user_gravity(id, 1.0)
		set_user_rendering(id)
		if (is_user_alive(id))
			ExecuteHamB(Ham_CS_Player_ResetMaxSpeed, id)
		if (!is_user_bot(id) && !HtmlHud(id))
			ClearSyncHud(id, g_hudSync)
	}
}

// A zombie: anyone on the Terrorists in this mode (bots, and humans
// infected this round).
bool:IsZombie(id)
{
	return g_mode == MODE_ZOMBIES && id >= 1 && id <= MaxClients && is_user_connected(id)
		&& cs_get_user_team(id) == CS_TEAM_T
}

// Zombies left: alive Terrorists.
ZmAlive()
{
	new count = 0
	for (new id = 1; id <= MaxClients; id++)
	{
		if (is_user_alive(id) && cs_get_user_team(id) == CS_TEAM_T)
			count++
	}
	return count
}

ZmHealth()
{
	return max(get_pcvar_num(g_pZmHealth), 1) + max(get_pcvar_num(g_pZmHealthPerHuman), 0) * CoopHumans()
}

// Once a second: the round timer (blocked by mp_round_infinite a), the
// zombie count, the HUD.
ZmPoll()
{
	if (g_zmRoundEnd > 0.0 && get_gametime() >= g_zmRoundEnd - ZM_TIMEOUT_EARLY)
	{
		g_zmRoundEnd = 0.0
		new killed = 0
		for (new id = 1; id <= MaxClients; id++)
		{
			if (is_user_alive(id) && cs_get_user_team(id) == CS_TEAM_T)
			{
				// Flag 1: the score stays as it was. The game ends the round
				// on the last one: a CT win by elimination on any map.
				user_silentkill(id, 1)
				killed++
			}
		}
		log_amx("Zombies: time is up, %d zombies left (killed)", killed)
		if (killed)
			client_print(0, print_chat, "[Server] Zombies: time is up. The humans survived!")
	}
	g_zmStartCount = max(g_zmStartCount, ZmAlive())
	for (new id = 1; id <= MaxClients; id++)
		ShowZmHud(id)
}

public ZmOnRoundStart()
{
	if (g_mode != MODE_ZOMBIES)
		return
	g_zmRound++
	g_zmStartCount = ZmAlive()
	new Float:minutes = g_pRoundTime ? get_pcvar_float(g_pRoundTime) : 0.0
	g_zmRoundEnd = minutes > 0.0 ? get_gametime() + minutes * 60.0 : 0.0
	for (new id = 1; id <= MaxClients; id++)
		ShowZmHud(id)
}

// Infected humans go back to the Counter-Terrorists for the next round.
public ZmOnRoundEnd()
{
	g_zmRoundEnd = 0.0
	if (g_mode != MODE_ZOMBIES)
		return
	for (new id = 1; id <= MaxClients; id++)
		ZmCure(id)
}

// Back on the Counter-Terrorists; until the next round respawns them (5 s
// after the round end), alive without the zombie's powers.
ZmCure(id)
{
	if (!g_zmInfected[id])
		return
	g_zmInfected[id] = false
	if (!is_user_connected(id) || cs_get_user_team(id) != CS_TEAM_T)
		return
	cs_set_user_team(id, CS_TEAM_CT, COOP_CT_MODELS[random(sizeof COOP_CT_MODELS)])
	if (!is_user_alive(id))
		return
	set_user_gravity(id, 1.0)
	set_user_rendering(id)
	set_user_health(id, min(get_user_health(id), 100))
	// Players alive at the round end keep what they carry into the next
	// round: a zombie's knife only. Give the Counter-Terrorists' pistol.
	if (!(pev(id, pev_weapons) & (WC_PISTOLS | WC_PRIMARIES)))
		WcGiveWeapon(id, CSW_USP)
	ExecuteHamB(Ham_CS_Player_ResetMaxSpeed, id)
}

// Spawned (OnPlayerSpawn): zombies get their knife, health and powers a
// moment later, after what the game hands out on spawn.
ZmSpawn(id)
{
	remove_task(TASK_ZM_EQUIP + id)
	set_task(0.1, "ZmEquip", TASK_ZM_EQUIP + id)
}

public ZmEquip(taskid)
{
	new id = taskid - TASK_ZM_EQUIP
	if (g_mode != MODE_ZOMBIES || !is_user_alive(id))
		return
	if (!IsZombie(id))
	{
		// A human (also one cured since the last round).
		set_user_gravity(id, 1.0)
		set_user_rendering(id)
		return
	}
	// yb_jasonmode keeps bots from buying, but not from spawning with a
	// pistol (checked in the image).
	WcStripWeapons(id, WC_PRIMARIES | WC_PISTOLS | WC_GRENADES | (1 << CSW_C4))
	if (!(pev(id, pev_weapons) & (1 << CSW_KNIFE)))
		give_item(id, "weapon_knife")
	engclient_cmd(id, "weapon_knife")
	set_user_armor(id, 0)
	set_user_health(id, ZmHealth())
	set_user_gravity(id, floatclamp(get_pcvar_float(g_pZmGravity), 0.1, 2.0))
	set_user_rendering(id, kRenderFxGlowShell, 40, 255, 40, kRenderNormal, 20)
	ExecuteHamB(Ham_CS_Player_ResetMaxSpeed, id)
}

public ZmOnResetMaxSpeed(id)
{
	if (!IsZombie(id) || !is_user_alive(id) || (pev(id, pev_flags) & FL_FROZEN))
		return HAM_IGNORED
	set_user_maxspeed(id, float(clamp(get_pcvar_num(g_pZmSpeed), 100, 2000)))
	return HAM_IGNORED
}

// A zombie's knife hits harder (inflictor == attacker: not a grenade).
public ZmOnTakeDamage(victim, inflictor, attacker, Float:damage, bits)
{
	if (g_mode != MODE_ZOMBIES || inflictor != attacker || !IsZombie(attacker) || IsZombie(victim))
		return HAM_IGNORED
	SetHamParamFloat(4, damage * floatclamp(get_pcvar_float(g_pZmDamage), 0.0, 100.0))
	return HAM_HANDLED
}

// A shot zombie is pushed along the shooter's aim (after the game's own
// slow-down on being hit).
public ZmOnTakeDamagePost(victim, inflictor, attacker, Float:damage, bits)
{
	if (g_mode != MODE_ZOMBIES || inflictor != attacker || !IsZombie(victim) || !is_user_alive(victim)
		|| attacker < 1 || attacker > MaxClients || IsZombie(attacker) || !is_user_alive(attacker))
		return HAM_IGNORED
	new Float:speed = floatmin(damage * floatmax(get_pcvar_float(g_pZmKnockback), 0.0) * ZM_KNOCKBACK_SCALE, ZM_KNOCKBACK_MAX)
	if (speed < 1.0)
		return HAM_IGNORED
	new Float:push[3], Float:velocity[3]
	velocity_by_aim(attacker, floatround(speed), push)
	pev(victim, pev_velocity, velocity)
	velocity[0] += push[0]
	velocity[1] += push[1]
	set_pev(victim, pev_velocity, velocity)
	return HAM_IGNORED
}

// wc_zm_infect 1: a human killed by a zombie comes back as one.
public ZmOnKilled(victim, attacker)
{
	remove_task(TASK_ZM_EQUIP + victim)
	if (g_mode != MODE_ZOMBIES || !get_pcvar_num(g_pZmInfect) || is_user_bot(victim)
		|| cs_get_user_team(victim) != CS_TEAM_CT || !IsZombie(attacker))
		return HAM_IGNORED
	remove_task(TASK_ZM_INFECT + victim)
	set_task(ZM_INFECT_DELAY, "ZmInfect", TASK_ZM_INFECT + victim)
	return HAM_IGNORED
}

public ZmInfect(taskid)
{
	new id = taskid - TASK_ZM_INFECT
	// Not if the round ended meanwhile (the last human died).
	if (g_mode != MODE_ZOMBIES || !is_user_connected(id) || is_user_alive(id) || g_zmRoundEnd == 0.0)
		return
	g_zmInfected[id] = true
	cs_set_user_team(id, CS_TEAM_T, COOP_T_MODELS[random(sizeof COOP_T_MODELS)])
	ExecuteHamB(Ham_CS_RoundRespawn, id)
	new name[32]
	SafeName(id, name, charsmax(name))
	client_print(0, print_chat, "[Server] Zombies: %s was infected.", name)
	log_amx("Zombies: #%d infected", get_user_userid(id))
}

// Top centre: "Round 3 | Zombies 5/9 left"; players with the HTML HUD get
// WcMode instead.
ShowZmHud(id)
{
	if (g_mode != MODE_ZOMBIES || !is_user_connected(id) || is_user_bot(id))
		return
	if (HtmlHud(id))
	{
		SendMode(id)
		return
	}
	set_hudmessage(120, 255, 120, -1.0, 0.02, 0, 0.0, 1.3, 0.0, 0.0, -1)
	ShowSyncHudMsg(id, g_hudSync, "Round %d | Zombies %d/%d left", max(g_zmRound, 1), ZmAlive(), g_zmStartCount)
}

// Server console: each zombie's health, speed, gravity and team.
public CmdZmStatus()
{
	server_print("wc_zm_status mode %d round %d zombies %d/%d health %d infect %d time left %.0f",
		g_mode, g_zmRound, ZmAlive(), g_zmStartCount, ZmHealth(), get_pcvar_num(g_pZmInfect),
		g_zmRoundEnd > 0.0 ? g_zmRoundEnd - get_gametime() : -1.0)
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
		server_print("  #%d %s team %d zombie %d infected %d alive %d hp %d ap %d speed %.0f gravity %.2f:%s",
			get_user_userid(id), name, get_user_team(id), IsZombie(id), g_zmInfected[id],
			is_user_alive(id), get_user_health(id), get_user_armor(id), get_user_maxspeed(id),
			get_user_gravity(id), line)
	}
	return PLUGIN_HANDLED
}
