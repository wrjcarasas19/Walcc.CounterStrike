/*
web_bridge.cpp -- hands HUD state to the web page (HTML HUD)
See web_bridge.h for the JS contract.
*/

#include "hud.h"
#include "cl_util.h"
#include "parsemsg.h"
#include "web_bridge.h"
#include "r_studioint.h"
#include "com_model.h"
#include "vgui_parser.h"
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

// EM_JS bodies are stringified without macro expansion, so each one spells out
// the Module.hudEvent call. See web_bridge.h for the contract.
// Keep the parameter lists unpadded, "(int a, int b)": the side module loader
// takes the last space-separated word of each parameter as the JS argument name.
EM_JS( void, js_hud_health, (int hp), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "health", { hp: hp } ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_armor, (int ap, int helmet), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "armor", { ap: ap, helmet: !!helmet } ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_money, (int amount, int delta), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "money", { amount: amount, delta: delta } ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_weapon, (const char *name, int clip, int reserve), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "weapon", { name: UTF8ToString( name ), clip: clip, reserve: reserve } ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_timer, (int seconds, int bombPlanted), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "timer", { seconds: seconds, bombPlanted: !!bombPlanted } ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_kill, (const char *killer, const char *victim, const char *weapon, int headshot, const char *killerTeam, const char *victimTeam, int killerUserid, int victimUserid), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "kill", {
		killer: UTF8ToString( killer ), victim: UTF8ToString( victim ), weapon: UTF8ToString( weapon ),
		headshot: !!headshot, killerTeam: UTF8ToString( killerTeam ), victimTeam: UTF8ToString( victimTeam ),
		killerUserid: killerUserid, victimUserid: victimUserid
	} ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_alive, (int alive, int spectating), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "alive", { alive: !!alive, spectating: !!spectating } ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_reset, (void), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "reset", {} ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_scoreboard, (int visible), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "scoreboard", { visible: !!visible } ); } catch( e ) { console.error( "hudEvent", e ); }
} );
// ctScore / tScore < 0: no TeamScore known yet
EM_JS( void, js_hud_round, (const char *winner, const char *reason, const char *message, int ctScore, int tScore), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "round", {
		winner: UTF8ToString( winner ), reason: UTF8ToString( reason ), message: UTF8ToString( message ),
		ctScore: ctScore < 0 ? null : ctScore, tScore: tScore < 0 ? null : tScore
	} ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_intermission, (int active, const char *map), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "intermission", { active: !!active, map: UTF8ToString( map ) } ); } catch( e ) { console.error( "hudEvent", e ); }
} );
// json is built by WebBridge_Scores (valid UTF-8, strings escaped)
EM_JS( void, js_hud_scores, (const char *json), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "scores", JSON.parse( UTF8ToString( json ))); } catch( e ) { console.error( "hudEvent", e ); }
} );
// json is built by WebBridge_Chat (valid UTF-8, strings escaped)
EM_JS( void, js_hud_chat, (const char *json), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "chat", JSON.parse( UTF8ToString( json ))); } catch( e ) { console.error( "hudEvent", e ); }
} );
// json is built by WebBridge_MsgWcMode (valid UTF-8, strings escaped)
EM_JS( void, js_hud_mode, (const char *json), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "mode", JSON.parse( UTF8ToString( json ))); } catch( e ) { console.error( "hudEvent", e ); }
} );
// json is built by WebBridge_MsgWcKillInfo (valid UTF-8, strings escaped)
EM_JS( void, js_hud_killinfo, (const char *json), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "killinfo", JSON.parse( UTF8ToString( json ))); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_buymenu, (int open, const char *menu, const char *team, const char *map), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "buymenu", {
		open: !!open, menu: UTF8ToString( menu ), team: UTF8ToString( team ), map: UTF8ToString( map )
	} ); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_teammenu, (int open, const char *menu, int keys, const char *team), {
	var f = Module["hudEvent"];
	if( typeof f !== "function" ) return;
	try { f( "teammenu", {
		open: !!open, menu: UTF8ToString( menu ), keys: keys, team: UTF8ToString( team )
	} ); } catch( e ) { console.error( "hudEvent", e ); }
} );

#else

static void js_hud_health( int ) { }
static void js_hud_armor( int, int ) { }
static void js_hud_money( int, int ) { }
static void js_hud_weapon( const char *, int, int ) { }
static void js_hud_timer( int, int ) { }
static void js_hud_kill( const char *, const char *, const char *, int, const char *, const char *, int, int ) { }
static void js_hud_round( const char *, const char *, const char *, int, int ) { }
static void js_hud_intermission( int, const char * ) { }
static void js_hud_alive( int, int ) { }
static void js_hud_reset( void ) { }
static void js_hud_scoreboard( int ) { }
static void js_hud_scores( const char * ) { }
static void js_hud_chat( const char * ) { }
static void js_hud_mode( const char * ) { }
static void js_hud_killinfo( const char * ) { }
static void js_hud_buymenu( int, const char *, const char *, const char * ) { }
static void js_hud_teammenu( int, const char *, int, const char * ) { }

#endif

// last sent values; known == false until the server told us
static struct
{
	bool healthKnown;
	int hp;

	bool armorKnown;
	int ap;
	bool helmet;

	bool moneyKnown;
	int amount;

	bool weaponKnown;
	char weapon[MAX_WEAPON_NAME];
	int clip;
	int reserve;

	bool timerKnown;
	int seconds;
	bool bombPlanted;

	bool aliveKnown;
	bool alive;
	bool spectating;

	bool scoreboard;	// last sent "scoreboard" visible
	float scoresTime;	// gHUD.m_flTime of the last "scores"

	bool ctScoreKnown;
	int ctScore;
	bool tScoreKnown;
	int tScore;

	const struct round_end_s *roundEnd;	// round end seen, "round" goes out next frame
	bool intermission;	// last sent "intermission" active
	int pageMenu;		// WEB_MENU_*: the page draws the open text menu (last "buymenu" / "teammenu" open)
} s_web;

enum
{
	WEB_MENU_NONE = 0,
	WEB_MENU_BUY,
	WEB_MENU_TEAM,
};

// snapshot interval while the scoreboard is visible (or hud_html_scores is set)
#define SCORES_INTERVAL 0.5f

// set by HUD_GetStudioModelInterface; PlayerInfo gives the engine's
// player_info_t, the only place the client can read a player's userid
extern engine_studio_api_t IEngineStudio;

// Round end center messages (TextMsg HUD_PRINTCENTER) of the CS game dll and
// the winner / reason they stand for. Every round end sends exactly one of them
// (CHalfLifeMultiplay::EndRoundMessage; same strings in HLDS mp.dll and
// ReGameDLL_CS). "#Game_will_restart_in" (sv_restart) is not a round end.
static const struct round_end_s
{
	const char *message;
	const char *winner;	// "CT", "T" or "" (no winner)
	const char *reason;
} s_roundEnds[] =
{
	{ "#Terrorists_Win",                 "T",  "elimination" },
	{ "#CTs_Win",                        "CT", "elimination" },
	{ "#Target_Bombed",                  "T",  "bomb" },
	{ "#Bomb_Defused",                   "CT", "defuse" },
	{ "#Target_Saved",                   "CT", "time" },
	{ "#Hostages_Not_Rescued",           "T",  "time" },
	{ "#All_Hostages_Rescued",           "CT", "hostages" },
	{ "#VIP_Escaped",                    "CT", "vip_escaped" },
	{ "#VIP_Assassinated",               "T",  "vip_killed" },
	{ "#VIP_Not_Escaped",                "T",  "time" },
	{ "#Terrorists_Escaped",             "T",  "escaped" },
	{ "#CTs_PreventEscape",              "CT", "escape_prevented" },
	{ "#Escaping_Terrorists_Neutralized", "CT", "elimination" },
	{ "#Terrorists_Not_Escaped",         "CT", "time" },
	{ "#Round_Draw",                     "",   "draw" },
	{ "#Cstrike_Tutor_Round_Over",       "",   "draw" },
	{ "#Game_Commencing",                "",   "commencing" },
};

static const char *WebBridge_TeamName( int team )
{
	switch( team )
	{
	case TEAM_CT:        return "CT";
	case TEAM_TERRORIST: return "T";
	default:             return "";
	}
}

void WebBridge_Health( int hp )
{
	if( s_web.healthKnown && s_web.hp == hp )
		return;

	s_web.healthKnown = true;
	s_web.hp = hp;
	js_hud_health( hp );
}

void WebBridge_Armor( int ap, bool helmet )
{
	if( s_web.armorKnown && s_web.ap == ap && s_web.helmet == helmet )
		return;

	s_web.armorKnown = true;
	s_web.ap = ap;
	s_web.helmet = helmet;
	js_hud_armor( ap, helmet );
}

void WebBridge_Money( int amount, int delta )
{
	if( s_web.moneyKnown && s_web.amount == amount )
		return;

	s_web.moneyKnown = true;
	s_web.amount = amount;
	js_hud_money( amount, delta );
}

void WebBridge_Weapon( const char *name, int clip, int reserve )
{
	if( !name )
		name = "";

	if( !strncmp( name, "weapon_", 7 ))
		name += 7;

	if( s_web.weaponKnown && s_web.clip == clip && s_web.reserve == reserve && !strcmp( s_web.weapon, name ))
		return;

	s_web.weaponKnown = true;
	strncpy( s_web.weapon, name, sizeof( s_web.weapon ));
	s_web.weapon[sizeof( s_web.weapon ) - 1] = 0;
	s_web.clip = clip;
	s_web.reserve = reserve;
	js_hud_weapon( s_web.weapon, clip, reserve );
}

void WebBridge_RoundTime( void )
{
	s_web.timerKnown = true;
	s_web.bombPlanted = false;
	s_web.seconds = gHUD.m_Timer.SecondsLeft();
	js_hud_timer( s_web.seconds, false );
}

void WebBridge_BombPlanted( void )
{
	if( s_web.bombPlanted )
		return;

	s_web.timerKnown = true;
	s_web.bombPlanted = true;
	s_web.seconds = gHUD.m_Timer.SecondsLeft();
	js_hud_timer( s_web.seconds, true );
}

void WebBridge_TeamScore( const char *team, int score )
{
	if( !team )
		return;

	if( !strcmp( team, "CT" ))
	{
		s_web.ctScoreKnown = true;
		s_web.ctScore = score;
	}
	else if( !strcmp( team, "TERRORIST" ))
	{
		s_web.tScoreKnown = true;
		s_web.tScore = score;
	}
}

// Bounded JSON writer for the "scores" payload. On overflow nothing is sent.
static struct
{
	char data[16384];
	size_t len;
	bool overflow;
} s_json;

static void Json_Printf( const char *fmt, ... )
{
	if( s_json.overflow )
		return;

	size_t room = sizeof( s_json.data ) - s_json.len;
	va_list args;
	va_start( args, fmt );
	int n = vsnprintf( s_json.data + s_json.len, room, fmt, args );
	va_end( args );

	if( n < 0 || (size_t)n >= room )
		s_json.overflow = true;
	else
		s_json.len += n;
}

// Length of the valid UTF-8 sequence at s, 0 if it is not valid
static int Json_Utf8Length( const unsigned char *s )
{
	unsigned char c = s[0];
	int len;
	unsigned char lo = 0x80, hi = 0xBF;	// allowed range of the second byte

	if( c >= 0xC2 && c <= 0xDF ) len = 2;
	else if( c >= 0xE0 && c <= 0xEF ) len = 3;
	else if( c >= 0xF0 && c <= 0xF4 ) len = 4;
	else return 0;

	if( c == 0xE0 ) lo = 0xA0;		// overlong
	else if( c == 0xED ) hi = 0x9F;	// surrogates
	else if( c == 0xF0 ) lo = 0x90;	// overlong
	else if( c == 0xF4 ) hi = 0x8F;	// > U+10FFFF

	if( s[1] < lo || s[1] > hi )
		return 0;

	for( int i = 2; i < len; i++ )
	{
		if( s[i] < 0x80 || s[i] > 0xBF )
			return 0;
	}

	return len;
}

// Quoted JSON string. Player names are UTF-8 from the server and may be cut
// mid-character or invalid: bad bytes become '?' so the JSON always parses
// (UTF8ToString's fallback decoder would swallow the closing quote).
static void Json_String( const char *str )
{
	const unsigned char *s = (const unsigned char *)( str ? str : "" );

	Json_Printf( "\"" );

	while( *s && !s_json.overflow )
	{
		unsigned char c = *s;

		if( c == '"' || c == '\\' )
		{
			Json_Printf( "\\%c", c );
			s++;
		}
		else if( c < 0x20 )
		{
			Json_Printf( "\\u%04x", c );
			s++;
		}
		else if( c < 0x80 )
		{
			Json_Printf( "%c", c );
			s++;
		}
		else
		{
			int len = Json_Utf8Length( s );

			if( len )
			{
				Json_Printf( "%.*s", len, (const char *)s );
				s += len;
			}
			else
			{
				Json_Printf( "?" );
				s++;
			}
		}
	}

	Json_Printf( "\"" );
}

static const char *WebBridge_ScoreTeamName( int team )
{
	switch( team )
	{
	case TEAM_CT:        return "CT";
	case TEAM_TERRORIST: return "T";
	case TEAM_SPECTATOR: return "SPEC";
	default:             return "";
	}
}

// What CHudScoreboard::Draw would decide (it skips drawing when hud_html is set)
// level name without "maps/" and ".bsp", "" before one is loaded
static void WebBridge_MapName( char *map, size_t size )
{
	map[0] = 0;

	const char *level = gEngfuncs.pfnGetLevelName();
	if( !level || !level[0] )
		return;

	const char *base = strrchr( level, '/' );
	base = base ? base + 1 : level;
	strncpy( map, base, size - 1 );
	map[size - 1] = 0;
	char *ext = strrchr( map, '.' );
	if( ext )
		*ext = 0;
}

static bool WebBridge_ScoreboardVisible( void )
{
	if( !( gHUD.m_Scoreboard.m_iFlags & HUD_DRAW ) || !gHUD.m_pCvarDraw->value )
		return false;

	// CHud::Redraw draws nothing under HIDEHUD_ALL, except at intermission
	if( !gHUD.m_iIntermission && ( gHUD.m_iHideHUDDisplay & HIDEHUD_ALL ))
		return false;

	return gHUD.m_Scoreboard.m_bForceDraw || gHUD.m_Scoreboard.m_bShowscoresHeld ||
		gHUD.m_Health.m_iHealth <= 0 || gHUD.m_iIntermission;
}

static void WebBridge_Scores( void )
{
	struct
	{
		int players;
		int sumping;
		int frags;
	} teams[2] = { };	// CT, T

	s_json.len = 0;
	s_json.overflow = false;

	// refresh names and pings like the stock scoreboard does each draw;
	// GetAllPlayersInfo stops one slot short, so fetch the last one too
	gHUD.m_Scoreboard.GetAllPlayersInfo();
	GetPlayerInfo( MAX_PLAYERS, &g_PlayerInfoList[MAX_PLAYERS] );

	char map[64];
	WebBridge_MapName( map, sizeof( map ));

	Json_Printf( "{\"map\":" );
	Json_String( map );
	Json_Printf( ",\"server\":" );
	Json_String( gHUD.m_szServerName );
	Json_Printf( ",\"players\":[" );

	bool first = true;
	for( int i = 1; i <= MAX_PLAYERS; i++ )
	{
		hud_player_info_t *info = &g_PlayerInfoList[i];
		extra_player_info_t *extra = &g_PlayerExtraInfo[i];

		if( !info->name || !info->name[0] )
			continue; // empty slot

		int team = extra->teamnumber;
		if( team == TEAM_CT || team == TEAM_TERRORIST )
		{
			int t = team == TEAM_CT ? 0 : 1;
			teams[t].players++;
			teams[t].sumping += info->ping;
			teams[t].frags += extra->frags;
		}

		const char *bot = gEngfuncs.PlayerInfo_ValueForKey( i, "*bot" );

		// server userid ("kick #<userid>"), 0 if unknown; PlayerInfo is 0-based
		player_info_s *engineInfo = IEngineStudio.PlayerInfo ? IEngineStudio.PlayerInfo( i - 1 ) : NULL;
		int userid = engineInfo ? engineInfo->userid : 0;

		Json_Printf( "%s{\"id\":%d,\"userid\":%d,\"name\":", first ? "" : ",", i, userid );
		Json_String( info->name );
		Json_Printf( ",\"team\":\"%s\",\"frags\":%d,\"deaths\":%d,\"ping\":%d,"
			"\"dead\":%s,\"bomb\":%s,\"vip\":%s,\"bot\":%s,\"local\":%s}",
			WebBridge_ScoreTeamName( team ), extra->frags, extra->deaths, info->ping,
			extra->dead ? "true" : "false", extra->has_c4 ? "true" : "false",
			extra->vip ? "true" : "false", bot && atoi( bot ) > 0 ? "true" : "false",
			info->thisplayer ? "true" : "false" );
		first = false;
	}

	// like the stock scoreboard, fall back to summed frags without TeamScore
	int ctScore = s_web.ctScoreKnown ? s_web.ctScore : teams[0].frags;
	int tScore = s_web.tScoreKnown ? s_web.tScore : teams[1].frags;

	Json_Printf( "],\"teams\":{"
		"\"CT\":{\"score\":%d,\"players\":%d,\"avgPing\":%d},"
		"\"T\":{\"score\":%d,\"players\":%d,\"avgPing\":%d}}}",
		ctScore, teams[0].players, teams[0].players ? teams[0].sumping / teams[0].players : 0,
		tScore, teams[1].players, teams[1].players ? teams[1].sumping / teams[1].players : 0 );

	s_web.scoresTime = gHUD.m_flTime;

	if( !s_json.overflow )
		js_hud_scores( s_json.data );
}

static int WebBridge_UserId( int slot )
{
	if( slot < 1 || slot > MAX_PLAYERS || !IEngineStudio.PlayerInfo )
		return 0;

	player_info_s *info = IEngineStudio.PlayerInfo( slot - 1 );
	return info ? info->userid : 0;
}

void WebBridge_Kill( const char *killer, const char *victim, const char *weapon, bool headshot, int killerTeam, int victimTeam, int killerSlot, int victimSlot )
{
	js_hud_kill( killer ? killer : "", victim ? victim : "", weapon ? weapon : "", headshot,
		WebBridge_TeamName( killerTeam ), WebBridge_TeamName( victimTeam ),
		WebBridge_UserId( killerSlot ), WebBridge_UserId( victimSlot ));
}

// SayText format keys that are player chat. Every key sends its sender's
// name as argv[0] (MsgFunc_SayText replaces it with the slot's name for the
// chat keys); textArg / locArg are the argv indexes of the message and the
// location (-1: none). Other keys become "notice" lines.
static const struct chat_key_s
{
	const char *key;
	const char *kind;	// "say" or "name"
	bool teamOnly;
	bool dead;
	bool spec;		// sender is a spectator
	int textArg;
	int locArg;
} s_chatKeys[] =
{
	{ "#Cstrike_Chat_CT",      "say",  true,  false, false, 1, -1 },
	{ "#Cstrike_Chat_T",       "say",  true,  false, false, 1, -1 },
	{ "#Cstrike_Chat_CT_Dead", "say",  true,  true,  false, 1, -1 },
	{ "#Cstrike_Chat_T_Dead",  "say",  true,  true,  false, 1, -1 },
	{ "#Cstrike_Chat_Spec",    "say",  true,  false, true,  1, -1 },
	{ "#Cstrike_Chat_All",     "say",  false, false, false, 1, -1 },
	{ "#Cstrike_Chat_AllDead", "say",  false, true,  false, 1, -1 },
	{ "#Cstrike_Chat_AllSpec", "say",  false, false, true,  1, -1 },
	{ "#Cstrike_Name_Change",  "name", false, false, false, 1, -1 },	// argv[0] old name, argv[1] new name
	{ "#Cstrike_Chat_T_Loc",   "say",  true,  false, false, 1, 2 },
	{ "#Cstrike_Chat_CT_Loc",  "say",  true,  false, false, 1, 2 },
};

// Copy of str without the SayText color codes \x01-\x04 and without
// trailing newlines
static void WebBridge_ChatClean( const char *str, char *out, size_t size )
{
	size_t len = 0;

	for( const char *s = str ? str : ""; *s && len < size - 1; s++ )
	{
		if( *s >= 1 && *s <= 4 )
			continue;
		out[len++] = *s;
	}

	while( len > 0 && ( out[len - 1] == '\n' || out[len - 1] == '\r' ))
		len--;

	out[len] = 0;
}

static void WebBridge_Chat( const char *kind, int slot, const char *name, bool dead, bool teamOnly, bool spec, const char *location, const char *text )
{
	char buf[512];
	const char *team = "";

	if( slot >= 1 && slot <= MAX_PLAYERS )
		team = WebBridge_ScoreTeamName( g_PlayerExtraInfo[slot].teamnumber );
	else
		slot = 0;

	// a spectator chat key without TeamInfo (unassigned) still means SPEC
	if( spec && !team[0] )
		team = "SPEC";

	s_json.len = 0;
	s_json.overflow = false;

	Json_Printf( "{\"kind\":\"%s\",\"slot\":%d,\"name\":", kind, slot );
	WebBridge_ChatClean( name, buf, sizeof( buf ));
	Json_String( buf );
	Json_Printf( ",\"team\":\"%s\",\"dead\":%s,\"teamOnly\":%s,\"location\":",
		team, dead ? "true" : "false", teamOnly ? "true" : "false" );
	WebBridge_ChatClean( location, buf, sizeof( buf ));
	Json_String( buf );
	Json_Printf( ",\"text\":" );
	WebBridge_ChatClean( text, buf, sizeof( buf ));
	Json_String( buf );
	Json_Printf( "}" );

	if( !s_json.overflow )
		js_hud_chat( s_json.data );
}

void WebBridge_SayText( const char *fmt, int slot, char *const argv[3], const char *formatted )
{
	if( fmt && fmt[0] == '#' )
	{
		for( size_t i = 0; i < sizeof( s_chatKeys ) / sizeof( s_chatKeys[0] ); i++ )
		{
			const chat_key_s *k = &s_chatKeys[i];

			if( strcmp( fmt, k->key ))
				continue;

			WebBridge_Chat( k->kind, slot, argv[0], k->dead, k->teamOnly, k->spec,
				k->locArg >= 0 ? argv[k->locArg] : "", argv[k->textArg] );
			return;
		}
	}

	WebBridge_Chat( "notice", 0, "", false, false, false, "", formatted );
}

void WebBridge_Notice( const char *text )
{
	WebBridge_Chat( "notice", 0, "", false, false, false, "", text );
}

void WebBridge_Radio( int slot, const char *name, const char *location, const char *text )
{
	// radio messages are title / localization keys ("#Fire_in_the_hole");
	// TextMsg already looked them up in titles.txt, try the dictionary too
	if( text && text[0] == '#' )
		text = Localize( text );

	bool dead = slot >= 1 && slot <= MAX_PLAYERS && g_PlayerExtraInfo[slot].dead;
	WebBridge_Chat( "radio", slot, name, dead, true, false, location, text );
}

void WebBridge_TextMsg( int dest, const char *message )
{
	if( dest != HUD_PRINTCENTER || !message || message[0] != '#' )
		return;

	for( size_t i = 0; i < sizeof( s_roundEnds ) / sizeof( s_roundEnds[0] ); i++ )
	{
		if( !strcmp( message, s_roundEnds[i].message ))
		{
			// sent from WebBridge_Frame, after the TeamScore messages of the
			// same packet
			s_web.roundEnd = &s_roundEnds[i];
			return;
		}
	}
}

// WcMode (cs16-web-server's wc_gamemode.sma), in this order: byte mode,
// byte level, byte levels, byte kills, byte killsNeeded, byte leaderLevel,
// short protection (ms), string weapon, string next, string leader,
// string winner
static int WebBridge_MsgWcMode( const char *pszName, int iSize, void *pbuf )
{
	BufferReader reader( pszName, pbuf, iSize );
	int mode = reader.ReadByte();
	int level = reader.ReadByte();
	int levels = reader.ReadByte();
	int kills = reader.ReadByte();
	int killsNeeded = reader.ReadByte();
	int leaderLevel = reader.ReadByte();
	int protection = reader.ReadShort();
	// ReadString returns one static buffer: copy each string before the next
	char weapon[64], next[64], leader[64], winner[64];
	strncpy( weapon, reader.ReadString(), sizeof( weapon ) - 1 ); weapon[sizeof( weapon ) - 1] = 0;
	strncpy( next, reader.ReadString(), sizeof( next ) - 1 ); next[sizeof( next ) - 1] = 0;
	strncpy( leader, reader.ReadString(), sizeof( leader ) - 1 ); leader[sizeof( leader ) - 1] = 0;
	strncpy( winner, reader.ReadString(), sizeof( winner ) - 1 ); winner[sizeof( winner ) - 1] = 0;

	s_json.len = 0;
	s_json.overflow = false;

	Json_Printf( "{\"mode\":%d,\"level\":%d,\"levels\":%d,\"kills\":%d,\"killsNeeded\":%d,"
		"\"leaderLevel\":%d,\"protection\":%d,\"weapon\":",
		mode, level, levels, kills, killsNeeded, leaderLevel, protection < 0 ? 0 : protection );
	Json_String( weapon );
	Json_Printf( ",\"next\":" );
	Json_String( next );
	Json_Printf( ",\"leader\":" );
	Json_String( leader );
	Json_Printf( ",\"winner\":" );
	Json_String( winner );
	Json_Printf( "}" );

	if( !s_json.overflow )
		js_hud_mode( s_json.data );
	return 1;
}

// WcKillInfo (cs16-web-server's wc_killinfo.sma), in this order: long killer
// (userid), short health, short armor, byte headshot, byte blind, byte wall,
// short distance (m), string weapon
static int WebBridge_MsgWcKillInfo( const char *pszName, int iSize, void *pbuf )
{
	BufferReader reader( pszName, pbuf, iSize );
	int killer = reader.ReadLong();
	int health = reader.ReadShort();
	int armor = reader.ReadShort();
	int headshot = reader.ReadByte();
	int blind = reader.ReadByte();
	int wall = reader.ReadByte();
	int distance = reader.ReadShort();
	char weapon[64];
	strncpy( weapon, reader.ReadString(), sizeof( weapon ) - 1 ); weapon[sizeof( weapon ) - 1] = 0;

	s_json.len = 0;
	s_json.overflow = false;

	Json_Printf( "{\"killerUserid\":%d,\"health\":%d,\"armor\":%d,\"weapon\":",
		killer, health, armor );
	Json_String( weapon );
	Json_Printf( ",\"headshot\":%s,\"blind\":%s,\"wall\":%s,\"distance\":%d}",
		headshot ? "true" : "false", blind ? "true" : "false", wall ? "true" : "false", distance );

	if( !s_json.overflow )
		js_hud_killinfo( s_json.data );
	return 1;
}

// Title keys of the CS game dll's buy menus as ShowVGUIMenu sends them in a
// text menu (ReGameDLL_CS client.cpp; same keys in HLDS mp.dll).
static const char *const s_buyMenus[] =
{
	"#Buy",
	"#CT_BuyPistol", "#T_BuyPistol",
	"#BuyShotgun", "#AS_BuyShotgun",
	"#CT_BuySubMachineGun", "#T_BuySubMachineGun", "#AS_CT_BuySubMachineGun", "#AS_T_BuySubMachineGun",
	"#CT_BuyRifle", "#T_BuyRifle", "#AS_CT_BuyRifle", "#AS_T_BuyRifle",
	"#BuyMachineGun", "#AS_T_BuyMachineGun",
	"#CT_BuyItem", "#T_BuyItem", "#DCT_BuyItem", "#DT_BuyItem",
};

// Title keys of the team and character (class) menus, same source. Which
// options each one offers is in its valid keys, sent along.
static const char *const s_teamMenus[] =
{
	"#Team_Select", "#Team_Select_Spect",
	"#IG_Team_Select", "#IG_Team_Select_Spect",
	"#IG_VIP_Team_Select", "#IG_VIP_Team_Select_Spect",
	"#Terrorist_Select", "#CT_Select",
};

static bool WebBridge_BuyMenusOn( void )
{
	return HUD_HTML_ACTIVE() && gHUD.hud_html_buymenu && gHUD.hud_html_buymenu->value != 0.0f;
}

static bool WebBridge_TeamMenusOn( void )
{
	return HUD_HTML_ACTIVE() && gHUD.hud_html_teammenu && gHUD.hud_html_teammenu->value != 0.0f;
}

static const char *WebBridge_FindMenu( const char *menu, const char *const *keys, size_t count )
{
	for( size_t i = 0; menu && i < count; i++ )
	{
		if( !strcmp( menu, keys[i] ))
			return keys[i];
	}
	return NULL;
}

void WebBridge_Menu( const char *menu, int keys )
{
	const char *buyKey = WebBridge_FindMenu( menu, s_buyMenus, sizeof( s_buyMenus ) / sizeof( s_buyMenus[0] ));
	const char *teamKey = WebBridge_FindMenu( menu, s_teamMenus, sizeof( s_teamMenus ) / sizeof( s_teamMenus[0] ));
	int kind = buyKey && WebBridge_BuyMenusOn() ? WEB_MENU_BUY
		: teamKey && WebBridge_TeamMenusOn() ? WEB_MENU_TEAM
		: WEB_MENU_NONE;

	// another menu replaced the open one: close it on the page first
	if( s_web.pageMenu != kind )
		WebBridge_MenuClosed();

	if( kind == WEB_MENU_NONE )
		return;

	int local = gHUD.m_Scoreboard.m_iPlayerNum;
	int team = local > 0 && local <= MAX_PLAYERS ? g_PlayerExtraInfo[local].teamnumber : 0;

	s_web.pageMenu = kind;
	if( kind == WEB_MENU_BUY )
	{
		char map[64];
		WebBridge_MapName( map, sizeof( map ));
		js_hud_buymenu( true, buyKey + 1, WebBridge_TeamName( team ), map );
	}
	else
	{
		js_hud_teammenu( true, teamKey + 1, keys, WebBridge_TeamName( team ));
	}
}

void WebBridge_MenuClosed( void )
{
	int kind = s_web.pageMenu;

	s_web.pageMenu = WEB_MENU_NONE;
	if( kind == WEB_MENU_BUY )
		js_hud_buymenu( false, "", "", "" );
	else if( kind == WEB_MENU_TEAM )
		js_hud_teammenu( false, "", 0, "" );
}

bool WebBridge_PageMenuShown( void )
{
	return s_web.pageMenu != WEB_MENU_NONE;
}

void WebBridge_Init( void )
{
	gEngfuncs.pfnHookUserMsg( "WcMode", WebBridge_MsgWcMode );
	gEngfuncs.pfnHookUserMsg( "WcKillInfo", WebBridge_MsgWcKillInfo );
}

void WebBridge_Frame( void )
{
#ifdef __EMSCRIPTEN__
	// The web build always uses the page's HUD: undo any change to hud_html
	// (console, config, server stuffcmd) on the next frame.
	if( gHUD.hud_html && gHUD.hud_html->value != 1.0f )
		gEngfuncs.Cvar_SetValue( "hud_html", 1.0f );
#endif

	// the page gave up its menu: CHudMenu draws the open one again
	if(( s_web.pageMenu == WEB_MENU_BUY && !WebBridge_BuyMenusOn( ))
		|| ( s_web.pageMenu == WEB_MENU_TEAM && !WebBridge_TeamMenusOn( )))
		WebBridge_MenuClosed();

	if( s_web.timerKnown )
	{
		int seconds = gHUD.m_Timer.SecondsLeft();

		if( seconds != s_web.seconds )
		{
			s_web.seconds = seconds;
			js_hud_timer( seconds, s_web.bombPlanted );
		}
	}

	int local = gHUD.m_Scoreboard.m_iPlayerNum;
	bool spectating = g_iUser1 || gEngfuncs.IsSpectateOnly();
	bool dead = local > 0 && local <= MAX_PLAYERS && g_PlayerExtraInfo[local].dead;
	bool alive = !spectating && !dead;

	if( !s_web.aliveKnown || s_web.alive != alive || s_web.spectating != spectating )
	{
		s_web.aliveKnown = true;
		s_web.alive = alive;
		s_web.spectating = spectating;
		js_hud_alive( alive, spectating );
	}

	if( s_web.roundEnd )
	{
		const round_end_s *end = s_web.roundEnd;
		s_web.roundEnd = NULL;
		js_hud_round( end->winner, end->reason, end->message,
			s_web.ctScoreKnown ? s_web.ctScore : -1, s_web.tScoreKnown ? s_web.tScore : -1 );
	}

	// engine intermission flag (svc_intermission at map end), before the
	// scoreboard it forces open
	bool intermission = gHUD.m_iIntermission != 0;
	if( intermission != s_web.intermission )
	{
		char map[64];
		WebBridge_MapName( map, sizeof( map ));
		s_web.intermission = intermission;
		js_hud_intermission( intermission, map );
	}

	bool scoreboard = WebBridge_ScoreboardVisible();
	// the page asks for scores while the scoreboard is hidden (admin menu)
	bool live = gHUD.hud_html_scores && gHUD.hud_html_scores->value != 0.0f;

	if( scoreboard != s_web.scoreboard )
	{
		s_web.scoreboard = scoreboard;
		// fresh scores first, so the page never shows the previous snapshot
		if( scoreboard )
			WebBridge_Scores();
		js_hud_scoreboard( scoreboard );
	}
	else if(( scoreboard || live ) && ( gHUD.m_flTime - s_web.scoresTime >= SCORES_INTERVAL || gHUD.m_flTime < s_web.scoresTime ))
	{
		WebBridge_Scores();
	}
}

void WebBridge_ResetHUD( void )
{
	if( s_web.healthKnown )
		js_hud_health( s_web.hp );
	if( s_web.armorKnown )
		js_hud_armor( s_web.ap, s_web.helmet );
	if( s_web.moneyKnown )
		js_hud_money( s_web.amount, 0 );
	if( s_web.weaponKnown )
		js_hud_weapon( s_web.weapon, s_web.clip, s_web.reserve );
	if( s_web.timerKnown )
		js_hud_timer( s_web.seconds, s_web.bombPlanted );
	if( s_web.aliveKnown )
		js_hud_alive( s_web.alive, s_web.spectating );
}

void WebBridge_InitHUD( void )
{
	// the old round clock means nothing on a new map, wait for RoundTime
	s_web.timerKnown = false;
	s_web.bombPlanted = false;
	// the page hides its scoreboard on "reset"; the server resends TeamScore
	s_web.scoreboard = false;
	s_web.ctScoreKnown = false;
	s_web.tScoreKnown = false;
	s_web.roundEnd = NULL;
	s_web.intermission = false;
	// CHudMenu::InitHUDData drops the open menu; the page closes its own on "reset"
	s_web.pageMenu = WEB_MENU_NONE;

	js_hud_reset();
	WebBridge_ResetHUD();
}
