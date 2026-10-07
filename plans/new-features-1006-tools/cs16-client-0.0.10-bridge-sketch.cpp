// cs16-client 0.0.10: the two new bridge events, in one place.
//   A.4  WcMode     -> hudEvent("mode", {...})      (src/amxx/wc_gamemode.sma)
//   D.1  WcKillInfo -> hudEvent("killinfo", {...})  (src/amxx/wc_killinfo.sma)
// NOT built: the 0.0.3-0.0.9 bridge (html-hud.patch, BUILD-NOTES.md) lives only
// in the user's local checkout (/Users/wcarasas/Repos/webxash3d-fwgs). Merge
// this into that checkout's cl_dll (web_bridge.{h,cpp} + hooks in hud.cpp),
// bump to 0.0.10, rebuild, npm pack. BOTH hooks must be in 0.0.10: the page
// sets `setinfo wc_html_hud 1` from that version, which turns off the server's
// Gun Game HUD message (replaced by `mode`) and turns on WcKillInfo. A client
// without the WcKillInfo hook would only log "UserMsg: No pfn" (Xash3D skips
// unhooked user messages), but the card would get no details.
//
// Both messages are registered by the plugins in plugin_precache
// (engfunc(EngFunc_RegUserMsg, name, -1)), so the client learns them from
// svc_usermessage like the game's own; ids on the image today: WcMode 60,
// WcKillInfo 61 (don't hard-code them).
//
// ---- web_bridge.h (doc block, next to the other events) -------------------
//
//   mode   { mode, level, levels, kills, killsNeeded, leaderLevel, protection,
//            weapon, next, leader, winner }
//          From the server's WcMode user message (src/amxx/wc_gamemode.sma in
//          cs16-web-server), sent only to clients whose userinfo has
//          wc_html_hud 1, whenever the player's Gun Game / Deathmatch state
//          changes. mode 0 classic (the mode ended), 1 Gun Game, 2 Deathmatch.
//          level/levels/kills/killsNeeded/leaderLevel: Gun Game, 1-based, 0
//          otherwise. protection: spawn protection left in ms, 0 none.
//          weapon/next: display names ("MP5"); next "" on the last level.
//          leader/winner: player names ("" none / not won yet).
//          Not resent by the client; the server resends on change.
//
//   killinfo { killerUserid, health, armor, weapon, headshot, blind, wall,
//              distance }
//          From the server's WcKillInfo user message (src/amxx/wc_killinfo.sma),
//          sent only to the victim of a player kill (not suicide / world;
//          team kills included), only if their userinfo has wc_html_hud 1.
//          Arrives right after the `kill` event of that death.
//          killerUserid: the killer's userid (as `kill`'s killerUserid).
//          health/armor: the killer's, at the kill (health 0: already dead).
//          weapon: DeathMsg weapon name ("ak47", "grenade", "knife").
//          headshot/blind/wall: booleans; blind = killer fully flashed (gun
//          kills only), wall = bullet went through a wall.
//          distance: killer to victim in metres, rounded.
//
//   void WebBridge_Mode( const char *json );
//   void WebBridge_KillInfo( const char *json );
//
// ---- web_bridge.cpp --------------------------------------------------------

#ifdef __EMSCRIPTEN__
EM_JS( void, js_hud_mode, ( const char *json ), {
	var f = Module["hudEvent"]; if( typeof f !== "function" ) return;
	try { f( "mode", JSON.parse( UTF8ToString( json ))); } catch( e ) { console.error( "hudEvent", e ); }
} );
EM_JS( void, js_hud_killinfo, ( const char *json ), {
	var f = Module["hudEvent"]; if( typeof f !== "function" ) return;
	try { f( "killinfo", JSON.parse( UTF8ToString( json ))); } catch( e ) { console.error( "hudEvent", e ); }
} );
#endif

void WebBridge_Mode( const char *json )
{
#ifdef __EMSCRIPTEN__
	js_hud_mode( json );
#endif
}

void WebBridge_KillInfo( const char *json )
{
#ifdef __EMSCRIPTEN__
	js_hud_killinfo( json );
#endif
}

// ---- hud.cpp (or wherever the bridge hooks live): hooks + parsers ----------
// Register in CHud::Init with the other HOOK_MESSAGEs:
//   HOOK_MESSAGE( WcMode );
//   HOOK_MESSAGE( WcKillInfo );
// (each needs `int __MsgFunc_<Name>( const char *pszName, int iSize, void *pbuf )`
// declared like the others, forwarding to gHUD.MsgFunc_<Name>, and the
// member declared in CHud).

// WcMode, in this order:
//   byte mode, byte level, byte levels, byte kills, byte killsNeeded,
//   byte leaderLevel, short protection (ms), string weapon, string next,
//   string leader, string winner
int CHud::MsgFunc_WcMode( const char *pszName, int iSize, void *pbuf )
{
	BEGIN_READ( pbuf, iSize );
	int mode = READ_BYTE();
	int level = READ_BYTE();
	int levels = READ_BYTE();
	int kills = READ_BYTE();
	int killsNeeded = READ_BYTE();
	int leaderLevel = READ_BYTE();
	int protection = READ_SHORT();
	// READ_STRING returns one static buffer: copy each string before the next.
	char weapon[32], next[32], leader[64], winner[64];
	strncpy( weapon, READ_STRING(), sizeof( weapon ) - 1 ); weapon[sizeof( weapon ) - 1] = 0;
	strncpy( next, READ_STRING(), sizeof( next ) - 1 ); next[sizeof( next ) - 1] = 0;
	strncpy( leader, READ_STRING(), sizeof( leader ) - 1 ); leader[sizeof( leader ) - 1] = 0;
	strncpy( winner, READ_STRING(), sizeof( winner ) - 1 ); winner[sizeof( winner ) - 1] = 0;

	// Same JSON string escaping as the scores / chat events (reuse the
	// existing helper in web_bridge.cpp, e.g. its JSON string appender).
	char json[512];
	char eWeapon[80], eNext[80], eLeader[160], eWinner[160];
	WebBridge_JsonEscape( weapon, eWeapon, sizeof( eWeapon ));
	WebBridge_JsonEscape( next, eNext, sizeof( eNext ));
	WebBridge_JsonEscape( leader, eLeader, sizeof( eLeader ));
	WebBridge_JsonEscape( winner, eWinner, sizeof( eWinner ));
	snprintf( json, sizeof( json ),
		"{\"mode\":%d,\"level\":%d,\"levels\":%d,\"kills\":%d,\"killsNeeded\":%d,"
		"\"leaderLevel\":%d,\"protection\":%d,\"weapon\":%s,\"next\":%s,"
		"\"leader\":%s,\"winner\":%s}",
		mode, level, levels, kills, killsNeeded, leaderLevel, protection,
		eWeapon, eNext, eLeader, eWinner );
	WebBridge_Mode( json );
	return 1;
}

// WcKillInfo, in this order:
//   long killer (userid), short health, short armor, byte headshot,
//   byte blind, byte wall, short distance (m), string weapon
int CHud::MsgFunc_WcKillInfo( const char *pszName, int iSize, void *pbuf )
{
	BEGIN_READ( pbuf, iSize );
	int killer = READ_LONG();
	int health = READ_SHORT();
	int armor = READ_SHORT();
	int headshot = READ_BYTE();
	int blind = READ_BYTE();
	int wall = READ_BYTE();
	int distance = READ_SHORT();
	char weapon[32];
	strncpy( weapon, READ_STRING(), sizeof( weapon ) - 1 ); weapon[sizeof( weapon ) - 1] = 0;

	char json[256];
	char eWeapon[80];
	WebBridge_JsonEscape( weapon, eWeapon, sizeof( eWeapon ));
	snprintf( json, sizeof( json ),
		"{\"killerUserid\":%d,\"health\":%d,\"armor\":%d,\"weapon\":%s,"
		"\"headshot\":%s,\"blind\":%s,\"wall\":%s,\"distance\":%d}",
		killer, health, armor, eWeapon,
		headshot ? "true" : "false", blind ? "true" : "false", wall ? "true" : "false",
		distance );
	WebBridge_KillInfo( json );
	return 1;
}

// Check after the build:
//   strings dist/cl_dll/client_emscripten_wasm32.wasm | grep -c hudEvent   (two more than 0.0.9's 13)
//   strings ... | grep -e '"mode"' -e '"killinfo"' -e WcKillInfo -e WcMode
// Then in cs16-web-server: package.json "cs16-client": "file:vendor/cs16-client-0.0.10.tgz",
// npm install (package-lock), Dockerfile COPY line. The page turns on
// `setinfo wc_html_hud 1` by itself from that version (gamemode.ts
// MODE_EVENT_CLIENT_VERSION via vite.config.ts __CS16_CLIENT_VERSION__;
// killinfo.ts KILLINFO_EVENT_CLIENT_VERSION is the same release).
// In a browser on the image: wc_killinfo_status (server console) lists the
// browser player under "gets WcKillInfo", and after dying to a bot the page
// gets a `killinfo` event whose health/armor match that bot's line in
// wc_killinfo_status (hud hp/ap = what the killer's own HUD showed).
