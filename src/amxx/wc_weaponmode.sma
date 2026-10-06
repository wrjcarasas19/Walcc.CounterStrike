// Knife-only and pistols-only modes for the web server's admin menu.
//
// cvar wc_weaponmode: 0 = off (normal game), 1 = knife only, 2 = pistols only.
//
// - Knife only: knife, C4 (so the bomb objective still works) and equipment
//   (armour, defuse kit, night vision). No guns, no grenades.
// - Pistols only: the same plus pistols and pistol ammo. No primary weapons,
//   no shield, no grenades.
//
// The value is kept over sv_restart and set back to 0 on every map change
// (plugin_init runs once per map).
//
// AMX Mod X on Xash3D can't hook or bind cvars (its gamedata doesn't match
// the engine), so the plugin polls the cvar once a second. Weapons are kept
// out three ways: buy commands are refused, weapons on the ground
// can't be picked up (Ham_Touch), and once a second (and right after each
// spawn) any weapon the mode doesn't allow is taken away, which also covers
// weapons given by other means. YaPB bots obey the same rules; the plugin
// also sets yb_jasonmode / yb_restricted_weapons so they don't waste money
// trying to buy what the plugin refuses.
//
// Messages to players are fixed text only: the web client uses TextMsg text
// as a printf format, so player-supplied text must never go into one.

#include <amxmodx>
#include <cstrike>
#include <fakemeta>
#include <fun>
#include <hamsandwich>

#define PLUGIN  "Web weapon mode"
#define VERSION "1.0"
#define AUTHOR  "Walcc"

#define MODE_OFF     0
#define MODE_KNIFE   1
#define MODE_PISTOLS 2

#define TASK_POLL  4100
#define TASK_SPAWN 4200

const ALWAYS_ALLOWED = (1 << CSW_KNIFE) | (1 << CSW_C4)
const PISTOLS = (1 << CSW_P228) | (1 << CSW_ELITE) | (1 << CSW_FIVESEVEN) | (1 << CSW_USP) | (1 << CSW_GLOCK18) | (1 << CSW_DEAGLE)
const GRENADES = (1 << CSW_HEGRENADE) | (1 << CSW_FLASHBANG) | (1 << CSW_SMOKEGRENADE)

// Weapons YaPB bots may not buy or pick up in pistols mode (its buy aliases).
new const YAPB_NOT_PISTOLS[] = "m3;xm1014;mp5;tmp;p90;mac10;ump45;ak47;sg552;m4a1;galil;famas;aug;scout;awp;g3sg1;sg550;m249;shield;hegren;flash;sgren"

// World models of items that may be picked up in each mode (weaponbox and
// armoury_entity use the item's world model).
new const KNIFE_MODELS[][] = {
	"models/w_backpack.mdl",
	"models/w_kevlar.mdl",
	"models/w_assault.mdl",
	"models/w_thighpack.mdl"
}
new const PISTOL_MODELS[][] = {
	"models/w_p228.mdl",
	"models/w_elite.mdl",
	"models/w_fiveseven.mdl",
	"models/w_usp.mdl",
	"models/w_glock18.mdl",
	"models/w_deagle.mdl"
}

// Buy items that aren't weapons (weapons use their CSW_ id).
#define ITEM_PRIAMMO 33
#define ITEM_SECAMMO 34
#define ITEM_SHIELD  35

enum _:BuyAlias { ALIAS_NAME[16], ALIAS_ITEM }

// Every buy alias the game knows (CS 1.6 and its alternative names).
new const BUY_ALIASES[][BuyAlias] = {
	{ "p228", CSW_P228 }, { "228compact", CSW_P228 },
	{ "glock", CSW_GLOCK18 }, { "9x19mm", CSW_GLOCK18 },
	{ "usp", CSW_USP }, { "km45", CSW_USP },
	{ "deagle", CSW_DEAGLE }, { "nighthawk", CSW_DEAGLE },
	{ "elites", CSW_ELITE }, { "fiveseven", CSW_FIVESEVEN }, { "fn57", CSW_FIVESEVEN },
	{ "m3", CSW_M3 }, { "12gauge", CSW_M3 },
	{ "xm1014", CSW_XM1014 }, { "autoshotgun", CSW_XM1014 },
	{ "mac10", CSW_MAC10 }, { "tmp", CSW_TMP }, { "mp", CSW_TMP },
	{ "mp5", CSW_MP5NAVY }, { "smg", CSW_MP5NAVY },
	{ "ump45", CSW_UMP45 }, { "p90", CSW_P90 }, { "c90", CSW_P90 },
	{ "galil", CSW_GALIL }, { "defender", CSW_GALIL },
	{ "famas", CSW_FAMAS }, { "clarion", CSW_FAMAS },
	{ "ak47", CSW_AK47 }, { "cv47", CSW_AK47 },
	{ "m4a1", CSW_M4A1 }, { "sg552", CSW_SG552 }, { "krieg552", CSW_SG552 },
	{ "aug", CSW_AUG }, { "bullpup", CSW_AUG },
	{ "scout", CSW_SCOUT }, { "awp", CSW_AWP }, { "magnum", CSW_AWP },
	{ "g3sg1", CSW_G3SG1 }, { "d3au1", CSW_G3SG1 },
	{ "sg550", CSW_SG550 }, { "krieg550", CSW_SG550 },
	{ "m249", CSW_M249 },
	{ "hegren", CSW_HEGRENADE }, { "flash", CSW_FLASHBANG }, { "sgren", CSW_SMOKEGRENADE },
	{ "shield", ITEM_SHIELD },
	{ "primammo", ITEM_PRIAMMO }, { "buyammo1", ITEM_PRIAMMO },
	{ "secammo", ITEM_SECAMMO }, { "buyammo2", ITEM_SECAMMO }
}

new const MODE_NAMES[][] = { "off", "knife only", "pistols only" }

new g_pMode
new g_pYbJason
new g_pYbRestricted
// The mode the plugin enforces; follows the cvar on each poll.
new g_mode = MODE_OFF

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR)

	// Not FCVAR_SPONLY: Xash3D refuses console/rcon changes to those.
	g_pMode = register_cvar("wc_weaponmode", "0", FCVAR_SERVER)
	// The cvar outlives the plugin across a map change; start each map off.
	set_pcvar_num(g_pMode, MODE_OFF)

	g_pYbJason = get_cvar_pointer("yb_jasonmode")
	g_pYbRestricted = get_cvar_pointer("yb_restricted_weapons")

	RegisterHam(Ham_Spawn, "player", "OnPlayerSpawn", 1)
	RegisterHam(Ham_Touch, "weaponbox", "OnTouchItem")
	RegisterHam(Ham_Touch, "armoury_entity", "OnTouchItem")
	RegisterHam(Ham_Touch, "weapon_shield", "OnTouchItem")

	RegisterBuyCommands()
	register_srvcmd("wc_weaponmode_status", "CmdStatus")

	set_task(1.0, "Poll", TASK_POLL, _, _, "b")
}

// Weapon bits the mode lets a player keep.
AllowedWeapons(mode)
{
	switch (mode)
	{
		case MODE_KNIFE: return ALWAYS_ALLOWED
		case MODE_PISTOLS: return ALWAYS_ALLOWED | PISTOLS
	}
	return -1
}

ReadMode()
{
	new mode = get_pcvar_num(g_pMode)
	if (mode < MODE_OFF || mode > MODE_PISTOLS)
		return MODE_OFF
	return mode
}

public Poll()
{
	new mode = ReadMode()
	if (mode != g_mode)
	{
		g_mode = mode
		ApplyBotSettings()
		log_amx("Weapon mode: %s", MODE_NAMES[mode])
		client_print(0, print_chat, "[Server] Weapon mode: %s.", MODE_NAMES[mode])
	}
	if (g_mode == MODE_OFF)
		return

	new players[32], count
	get_players(players, count, "a")
	for (new i = 0; i < count; i++)
		Enforce(players[i], false)
}

ApplyBotSettings()
{
	if (g_pYbJason)
		set_pcvar_num(g_pYbJason, g_mode == MODE_KNIFE ? 1 : 0)
	if (g_pYbRestricted)
		set_pcvar_string(g_pYbRestricted, g_mode == MODE_PISTOLS ? YAPB_NOT_PISTOLS : "")
}

public OnPlayerSpawn(id)
{
	if (g_mode == MODE_OFF || !is_user_alive(id))
		return HAM_IGNORED
	// The game hands out the default pistol after the spawn itself.
	remove_task(TASK_SPAWN + id)
	set_task(0.1, "SpawnCheck", TASK_SPAWN + id)
	return HAM_IGNORED
}

public SpawnCheck(taskid)
{
	new id = taskid - TASK_SPAWN
	if (g_mode != MODE_OFF && is_user_alive(id))
		Enforce(id, true)
}

// Takes away every weapon the mode doesn't allow. On spawn in pistols mode a
// player left without a pistol gets their team's default one.
Enforce(id, bool:spawned)
{
	new allowed = AllowedWeapons(g_mode)
	new owned = pev(id, pev_weapons)
	new removed = owned & ~allowed & ~(1 << 31)
	if (removed)
	{
		for (new wid = 1; wid <= CSW_P90; wid++)
		{
			if (removed & (1 << wid))
				StripWeapon(id, wid)
		}
	}

	if (g_mode == MODE_PISTOLS && spawned && !(pev(id, pev_weapons) & PISTOLS))
	{
		if (cs_get_user_team(id) == CS_TEAM_CT)
		{
			give_item(id, "weapon_usp")
			cs_set_user_bpammo(id, CSW_USP, 24)
		}
		else
		{
			give_item(id, "weapon_glock18")
			cs_set_user_bpammo(id, CSW_GLOCK18, 40)
		}
	}

	if (removed && !(allowed & (1 << get_user_weapon(id))))
		engclient_cmd(id, "weapon_knife")
}

StripWeapon(id, wid)
{
	new name[32]
	get_weaponname(wid, name, charsmax(name))
	new ent = -1
	while ((ent = engfunc(EngFunc_FindEntityByString, ent, "classname", name)) > 0)
	{
		if (pev(ent, pev_owner) == id)
			break
	}
	if (ent <= 0)
		return

	if ((1 << wid) & GRENADES)
		cs_set_user_bpammo(id, wid, 0)
	if (get_user_weapon(id) == wid)
		ExecuteHamB(Ham_Weapon_RetireWeapon, ent)
	if (!ExecuteHamB(Ham_RemovePlayerItem, id, ent))
		return
	ExecuteHamB(Ham_Item_Kill, ent)
	set_pev(id, pev_weapons, pev(id, pev_weapons) & ~(1 << wid))
}

// Buy commands: the VGUI buy menu and console aliases send the item's
// alias; the old-style menus send menuselect. (The cstrike module's
// CS_OnBuyAttempt forward never fires on Xash3D, so the plugin hooks the
// commands itself.)
RegisterBuyCommands()
{
	for (new i = 0; i < sizeof BUY_ALIASES; i++)
		register_clcmd(BUY_ALIASES[i][ALIAS_NAME], "OnBuyAlias")
	register_clcmd("cl_autobuy", "OnAutoBuy")
	register_clcmd("cl_setautobuy", "OnAutoBuy")
	register_clcmd("cl_rebuy", "OnAutoBuy")
	register_clcmd("cl_setrebuy", "OnAutoBuy")
	register_clcmd("menuselect", "OnMenuSelect")
}

bool:BuyAllowed(item)
{
	switch (item)
	{
		case ITEM_PRIAMMO, ITEM_SHIELD, CSW_HEGRENADE, CSW_FLASHBANG, CSW_SMOKEGRENADE:
			return false
		case ITEM_SECAMMO:
			return g_mode == MODE_PISTOLS
	}
	return (AllowedWeapons(g_mode) & (1 << item)) != 0
}

RefuseBuy(id)
{
	client_print(id, print_center, "Weapon mode: %s. You can't buy that.", MODE_NAMES[g_mode])
	return PLUGIN_HANDLED
}

public OnBuyAlias(id)
{
	if (g_mode == MODE_OFF)
		return PLUGIN_CONTINUE
	new command[16]
	read_argv(0, command, charsmax(command))
	for (new i = 0; i < sizeof BUY_ALIASES; i++)
	{
		if (equali(command, BUY_ALIASES[i][ALIAS_NAME]))
			return BuyAllowed(BUY_ALIASES[i][ALIAS_ITEM]) ? PLUGIN_CONTINUE : RefuseBuy(id)
	}
	return PLUGIN_CONTINUE
}

// Autobuy and rebuy would buy whatever the player's list says.
public OnAutoBuy(id)
{
	if (g_mode == MODE_OFF)
		return PLUGIN_CONTINUE
	return RefuseBuy(id)
}

public OnMenuSelect(id)
{
	if (g_mode == MODE_OFF || !is_user_connected(id))
		return PLUGIN_CONTINUE
	new slot = read_argv_int(1)
	switch (get_ent_data(id, "CBasePlayer", "m_iMenu"))
	{
		// 1 pistols, 2 shotguns, 3 SMGs, 4 rifles, 5 machine guns,
		// 6 primary ammo, 7 secondary ammo, 8 equipment.
		case CS_Menu_Buy:
		{
			if ((slot >= 2 && slot <= 6) || ((slot == 1 || slot == 7) && g_mode != MODE_PISTOLS))
				return RefuseBuy(id)
		}
		case CS_Menu_BuyPistol:
		{
			if (slot >= 1 && slot <= 9 && g_mode != MODE_PISTOLS)
				return RefuseBuy(id)
		}
		case CS_Menu_BuyRifle, CS_Menu_BuyMachineGun, CS_Menu_BuyShotgun, CS_Menu_BuySubMachineGun:
		{
			if (slot >= 1 && slot <= 9)
				return RefuseBuy(id)
		}
		// 1 vest, 2 vest and helmet, 3 flashbang, 4 HE, 5 smoke,
		// 6 night vision, 7 defuse kit, 8 shield.
		case CS_Menu_BuyItem:
		{
			if ((slot >= 3 && slot <= 5) || slot == 8)
				return RefuseBuy(id)
		}
	}
	return PLUGIN_CONTINUE
}

public OnTouchItem(ent, id)
{
	if (g_mode == MODE_OFF || id < 1 || id > MaxClients)
		return HAM_IGNORED

	new classname[32]
	pev(ent, pev_classname, classname, charsmax(classname))
	if (equal(classname, "weapon_shield"))
		return HAM_SUPERCEDE

	new model[64]
	pev(ent, pev_model, model, charsmax(model))
	for (new i = 0; i < sizeof KNIFE_MODELS; i++)
	{
		if (equal(model, KNIFE_MODELS[i]))
			return HAM_IGNORED
	}
	if (g_mode == MODE_PISTOLS)
	{
		for (new i = 0; i < sizeof PISTOL_MODELS; i++)
		{
			if (equal(model, PISTOL_MODELS[i]))
				return HAM_IGNORED
		}
	}
	return HAM_SUPERCEDE
}

// Server console: lists each live player's weapons (for checking the mode).
public CmdStatus()
{
	server_print("wc_weaponmode %d (%s)", g_mode, MODE_NAMES[g_mode])
	new players[32], count, weapons[32], num, wname[32], line[256], name[32]
	get_players(players, count, "a")
	for (new i = 0; i < count; i++)
	{
		new id = players[i]
		get_user_name(id, name, charsmax(name))
		num = 0
		get_user_weapons(id, weapons, num)
		line[0] = 0
		for (new w = 0; w < num; w++)
		{
			get_weaponname(weapons[w], wname, charsmax(wname))
			add(line, charsmax(line), " ")
			add(line, charsmax(line), wname[7])
		}
		server_print("  #%d %s:%s", get_user_userid(id), name, line)
	}
	return PLUGIN_HANDLED
}
