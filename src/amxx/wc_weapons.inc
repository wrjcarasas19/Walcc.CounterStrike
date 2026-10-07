// Weapon helpers shared by the web server's plugins (wc_weaponmode.sma,
// wc_gamemode.sma): taking weapons away, giving them with full ammo, and the
// game's buy commands (for plugins that block buying).
//
// Everything here is a stock, so a plugin only gets what it uses.

#if defined _wc_weapons_included
	#endinput
#endif
#define _wc_weapons_included

#include <amxmodx>
#include <cstrike>
#include <fakemeta>
#include <fun>
#include <hamsandwich>

stock const WC_PISTOLS = (1 << CSW_P228) | (1 << CSW_ELITE) | (1 << CSW_FIVESEVEN) | (1 << CSW_USP) | (1 << CSW_GLOCK18) | (1 << CSW_DEAGLE)
stock const WC_GRENADES = (1 << CSW_HEGRENADE) | (1 << CSW_FLASHBANG) | (1 << CSW_SMOKEGRENADE)
stock const WC_PRIMARIES = (1 << CSW_SCOUT) | (1 << CSW_XM1014) | (1 << CSW_MAC10) | (1 << CSW_AUG) | (1 << CSW_UMP45) | (1 << CSW_SG550) | (1 << CSW_GALIL) | (1 << CSW_FAMAS) | (1 << CSW_AWP) | (1 << CSW_MP5NAVY) | (1 << CSW_M249) | (1 << CSW_M3) | (1 << CSW_M4A1) | (1 << CSW_TMP) | (1 << CSW_G3SG1) | (1 << CSW_SG552) | (1 << CSW_AK47) | (1 << CSW_P90)

// Most reserve ammo a player can carry for each weapon (CSW_ id), as the
// game's ammo types allow; 0 for the knife and C4.
stock const WC_MAX_BPAMMO[CSW_P90 + 1] = {
	0,   // none
	52,  // p228
	0,   // (shield)
	90,  // scout
	1,   // hegrenade
	32,  // xm1014
	0,   // c4
	100, // mac10
	90,  // aug
	1,   // smokegrenade
	120, // elite
	100, // fiveseven
	100, // ump45
	90,  // sg550
	90,  // galil
	90,  // famas
	100, // usp
	120, // glock18
	30,  // awp
	120, // mp5navy
	200, // m249
	32,  // m3
	90,  // m4a1
	120, // tmp
	90,  // g3sg1
	2,   // flashbang
	35,  // deagle
	90,  // sg552
	90,  // ak47
	0,   // knife
	100  // p90
}

// Takes weapon wid (CSW_ id) away from player id, if they have it.
stock WcStripWeapon(id, wid)
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

	if ((1 << wid) & WC_GRENADES)
		cs_set_user_bpammo(id, wid, 0)
	if (get_user_weapon(id) == wid)
		ExecuteHamB(Ham_Weapon_RetireWeapon, ent)
	if (!ExecuteHamB(Ham_RemovePlayerItem, id, ent))
		return
	ExecuteHamB(Ham_Item_Kill, ent)
	set_pev(id, pev_weapons, pev(id, pev_weapons) & ~(1 << wid))
}

// Takes away every weapon in the bit mask (1 << CSW_ id) that id has.
stock WcStripWeapons(id, mask)
{
	new owned = pev(id, pev_weapons) & mask & ~(1 << 31)
	if (!owned)
		return
	for (new wid = 1; wid <= CSW_P90; wid++)
	{
		if (owned & (1 << wid))
			WcStripWeapon(id, wid)
	}
}

// Gives weapon wid (CSW_ id) with a full magazine and full reserve ammo.
stock WcGiveWeapon(id, wid)
{
	new name[32]
	get_weaponname(wid, name, charsmax(name))
	if (!give_item(id, name))
		return 0
	if (WC_MAX_BPAMMO[wid] > 0 && !((1 << wid) & WC_GRENADES))
		cs_set_user_bpammo(id, wid, WC_MAX_BPAMMO[wid])
	return 1
}

// Buy items that aren't weapons (weapons use their CSW_ id).
#define WC_ITEM_PRIAMMO 33
#define WC_ITEM_SECAMMO 34
#define WC_ITEM_SHIELD  35

enum _:WcBuyAlias { WC_ALIAS_NAME[16], WC_ALIAS_ITEM }

// Every buy alias the game knows (CS 1.6 and its alternative names).
stock const WC_BUY_ALIASES[][WcBuyAlias] = {
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
	{ "shield", WC_ITEM_SHIELD },
	{ "primammo", WC_ITEM_PRIAMMO }, { "buyammo1", WC_ITEM_PRIAMMO },
	{ "secammo", WC_ITEM_SECAMMO }, { "buyammo2", WC_ITEM_SECAMMO }
}

// Commands that buy whatever the player's autobuy / rebuy list says.
stock const WC_AUTOBUY_COMMANDS[][] = { "cl_autobuy", "cl_setautobuy", "cl_rebuy", "cl_setrebuy" }
