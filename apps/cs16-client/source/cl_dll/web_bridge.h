/*
web_bridge.h -- hands HUD state to the web page (HTML HUD)

All functions are no-ops when not built with Emscripten.

JS contract
-----------
Every event calls one function the page puts on the engine's Module object:

	Module.hudEvent( type, payload )

`type` is a string, `payload` a plain object. Nothing is called (and nothing
breaks) when Module.hudEvent is not a function. Exceptions thrown by the
handler are caught and logged with console.error.

	type       payload
	"health"   { hp: number }
	"armor"    { ap: number, helmet: boolean }
	"money"    { amount: number, delta: number }
	"weapon"   { name: string, clip: number, reserve: number }
	"timer"    { seconds: number, bombPlanted: boolean }
	"kill"     { killer: string, victim: string, weapon: string, headshot: boolean,
	             killerTeam: "CT" | "T" | "", victimTeam: "CT" | "T" | "",
	             killerUserid: number, victimUserid: number }
	"alive"    { alive: boolean, spectating: boolean }
	"reset"    {}
	"round"    { winner: "CT" | "T" | "", reason: Reason, message: string,
	             ctScore: number | null, tScore: number | null }
	           Reason = "elimination" | "bomb" | "defuse" | "time" | "hostages" |
	                    "vip_escaped" | "vip_killed" | "escaped" |
	                    "escape_prevented" | "draw" | "commencing"
	"intermission" { active: boolean, map: string }
	"scoreboard" { visible: boolean }
	"scores"   { map: string, server: string,
	             teams: { CT: Team, T: Team },
	             players: Player[] }
	           Team   = { score: number, players: number, avgPing: number }
	           Player = { id: number, userid: number, name: string,
	                      team: "CT" | "T" | "SPEC" | "",
	                      frags: number, deaths: number, ping: number, dead: boolean,
	                      bomb: boolean, vip: boolean, bot: boolean, local: boolean }
	"chat"     { kind: "say" | "name" | "radio" | "notice", slot: number,
	             name: string, team: "CT" | "T" | "SPEC" | "", dead: boolean,
	             teamOnly: boolean, location: string, text: string }

When each fires:
- health  - Health message, only when hp changed.
- armor   - Battery / ArmorType messages, only when ap or helmet changed.
- money   - Money message, only when amount changed. delta = new - previous
            amount as computed by the stock HUD (0 in a resend).
- weapon  - CurWeapon / AmmoX / WeaponList messages, only when name, clip or
            reserve changed. name is the short weapon name ("ak47", "knife",
            "hegrenade", ...; "weapon_" stripped), "" when there is no current
            weapon. clip is -1 for weapons without a magazine (knife, grenades,
            c4). reserve is -1 when the weapon uses no ammo (knife, "").
- timer   - every time the integer number of seconds left changes (polled
            each frame), on every RoundTime message (even if unchanged), and
            when the bomb is planted. seconds counts down the freeze time first,
            then the round time (whatever the last RoundTime said), clamped at 0.
            bombPlanted becomes true on BombDrop with the planted flag and false
            on the next RoundTime (new round) or reset. The stock HUD hides
            its clock while the bomb is planted; seconds keeps counting anyway.
- kill    - every DeathMsg (not deduplicated). weapon is the death-notice
            weapon name ("ak47", "grenade", "knife", "world", "teammate"...).
            killer is "" for suicide / world kills. For a non-player victim
            victim is the object name and victimTeam is "".
            killerUserid / victimUserid are the server userids (as in
            "scores") of the killer and victim slots, 0 when there is no
            player (suicide / world kill, non-player victim) or it can't be
            read.
- alive   - polled each frame, sent when either flag changes.
            spectating = observer mode (g_iUser1) or spectator-only client;
            alive = !spectating && local player not flagged dead (ScoreAttrib).
- reset   - InitHUD (connect / map change). Followed immediately by a resend
            of the last known value of every other event type, so the page can
            clear everything on "reset" and rebuild from what follows.
            Every ResetHUD (each spawn / new round) also resends all last known
            values (without a "reset" before them).
- round   - once per round end, the frame after the round end center message
            (TextMsg HUD_PRINTCENTER, see s_roundEnds in web_bridge.cpp), so
            the TeamScore messages sent with it are already counted.
            message is the raw title ("#CTs_Win", "#Target_Bombed"...).
            winner / reason:
              "#Terrorists_Win"                  T   elimination
              "#CTs_Win"                         CT  elimination
              "#Escaping_Terrorists_Neutralized" CT  elimination
              "#Target_Bombed"                   T   bomb
              "#Bomb_Defused"                    CT  defuse
              "#Target_Saved"                    CT  time
              "#Hostages_Not_Rescued"            T   time
              "#VIP_Not_Escaped"                 T   time
              "#Terrorists_Not_Escaped"          CT  time
              "#All_Hostages_Rescued"            CT  hostages
              "#VIP_Escaped"                     CT  vip_escaped
              "#VIP_Assassinated"                T   vip_killed
              "#Terrorists_Escaped"              T   escaped
              "#CTs_PreventEscape"               CT  escape_prevented
              "#Round_Draw"                      ""  draw
              "#Cstrike_Tutor_Round_Over"        ""  draw
              "#Game_Commencing"                 ""  commencing (first players
                                                     joined; not a real round)
            ctScore / tScore are the last TeamScore values (rounds won), null
            before one arrived on this map. There is no round start event:
            the next round starts with a RoundTime message, i.e. a "timer"
            event whose seconds jump up.
- intermission - polled each frame (the engine's intermission flag, set by
            svc_intermission when the map ends), sent when it changes. map is
            the current level name as in "scores". The scoreboard is forced
            visible during intermission, so "scores" follows. A map change
            ends it with "reset" (InitHUD), not with active false (that only
            comes if the engine clears the flag without a new map). The next
            map is a server cvar the client can't read, so it is not sent.

- scoreboard - polled each frame, sent when it changes. visible is what the
            stock scoreboard's Draw would decide: +showscores held,
            showscoreboard2, local health 0 (the death cam, until the server
            moves the player to observer mode) or intermission; and only once
            a ScoreInfo arrived and while the HUD is drawn at all (hud_draw,
            HIDEHUD_ALL). Not resent; after "reset" it is hidden.
- scores  - while the scoreboard is visible: right before scoreboard
            { visible: true }, then every 0.5 s; also every 0.5 s while the
            cvar hud_html_scores is nonzero, whether or not the scoreboard
            is visible. A full snapshot each time.
            map is the level name without "maps/" and ".bsp" ("" before one is
            loaded), server the ServerName message ("" if none). players lists
            every occupied slot in slot order (unsorted), names are refreshed
            through GetPlayerInfo like the stock scoreboard. team "SPEC" also
            covers unassigned players, "" means no TeamInfo yet. ping can be 0
            for everyone (Xash bug, see DrawPlayers in scoreboard.cpp); bot
            players have bot = true. id is the slot (entity index, 1-based);
            userid is the server's userid for "kick #<userid>" (unique per
            connection, from the engine's player_info_t through the studio
            API), 0 if unknown. teams[x].score is the last TeamScore
            (rounds won), or the team's summed frags until one arrives;
            players / avgPing count only that team's players.
- chat    - one event per chat line, from the same three places that feed
            the stock chat (CHudSayText::SayTextPrint), not deduplicated and
            never resent:
            * SayText message with a player chat format key, after the stock
              check that hides dead players' chat from living players (a
              living, non-spectating player never gets a *Dead / *Spec
              line). Fields come from the key and the message arguments,
              not from the formatted line:
                key                     kind  teamOnly dead  location
                #Cstrike_Chat_All       say   false    false ""
                #Cstrike_Chat_AllDead   say   false    true  ""
                #Cstrike_Chat_AllSpec   say   false    false ""   (team "SPEC" *)
                #Cstrike_Chat_CT / _T   say   true     false ""
                #Cstrike_Chat_CT_Dead / _T_Dead  say true true ""
                #Cstrike_Chat_Spec      say   true     false ""   (team "SPEC" *)
                #Cstrike_Chat_CT_Loc / _T_Loc    say true false place name
                #Cstrike_Name_Change    name  false    false ""
              (* when the slot has no TeamInfo yet; otherwise its team)
              slot is the sender's slot (entity index, 1-based), name its
              current name (GetPlayerInfo, as the stock chat prints it).
              For "name", name is the old name and text the new name, both
              as the server sent them (the slot's player info may already
              have the new name).
            * SayText with any other format (another key such as
              #Spec_PlayerItem, or a plain string from a plugin): "notice"
              with the formatted line as text.
            * TextMsg HUD_PRINTTALK: "notice", text is the formatted line.
            * TextMsg HUD_PRINTRADIO: "radio", slot / name are the sender
              (name as the server sent it), location the place name for
              #Game_radio_location ("" otherwise), text the radio message
              (title / localization key looked up, e.g. "Fire in the hole!").
              teamOnly is always true (radio only reaches teammates) and
              dead is the sender's scoreboard dead flag.
            "notice" lines have slot 0, name "", team "", dead and teamOnly
            false, location "". team is the sender slot's TeamInfo
            (g_PlayerExtraInfo[slot].teamnumber; "SPEC" covers unassigned,
            "" before TeamInfo), so #Cstrike_Chat_All lines have a team too.
            The color codes \x01-\x04 and trailing newlines are stripped
            from name, location and text; each is cut at 511 bytes. Strings
            are valid UTF-8 (bad bytes become '?'). Player text, so the page
            must insert it as text, never as HTML.

  "mode"     { mode, level, levels, kills, killsNeeded, leaderLevel,
               protection, weapon, next, leader, winner }   (0.0.10+)
            From the server's WcMode user message (cs16-web-server's
            wc_gamemode.sma), sent only to clients whose userinfo has
            wc_html_hud 1, whenever the player's Gun Game / Deathmatch state
            changes. mode 0 classic (the mode ended), 1 Gun Game,
            2 Deathmatch. level / levels / kills / killsNeeded / leaderLevel:
            Gun Game, 1-based, 0 otherwise. protection: spawn protection
            left in ms, 0 none. weapon / next: display names ("MP5"), next
            "" on the last level. leader / winner: player names ("" none /
            not won yet). Not resent by the client; the server resends on
            change.
  "killinfo" { killerUserid, health, armor, weapon, headshot, blind, wall,
               distance }   (0.0.10+)
            From the server's WcKillInfo user message (wc_killinfo.sma),
            sent only to the victim of a player kill (team kills included,
            not suicides / world), only if their userinfo has wc_html_hud 1.
            Arrives right after the "kill" event of that death.
            killerUserid: as kill's killerUserid. health / armor: the
            killer's at the kill (health 0: already dead). weapon: DeathMsg
            weapon name ("ak47", "grenade", "knife"). headshot / blind /
            wall: booleans; blind = killer fully flashed (gun kills only),
            wall = the bullet went through a wall. distance: metres, rounded.
  Both messages are registered by server plugins, so their ids are not
  fixed; WebBridge_Init hooks them by name.

  "buymenu"  { open: boolean, menu: string, team: "CT" | "T" | "",
               map: string }   (0.0.11+)
            Only while the cvar hud_html_buymenu is nonzero. open true: the
            server opened one of its buy menus as a text menu (ShowMenu; the
            page runs "_vgui_menus 0"), sent for every buy menu it opens,
            including a submenu replacing the main one. menu is the menu's
            title key without '#': "Buy" (main menu), "CT_BuyPistol",
            "T_BuyPistol", "BuyShotgun", "CT_BuySubMachineGun",
            "T_BuySubMachineGun", "CT_BuyRifle", "T_BuyRifle",
            "BuyMachineGun", "CT_BuyItem", "T_BuyItem", "DCT_BuyItem",
            "DT_BuyItem" or an assassination map's "AS_..." variant (see
            s_buyMenus in web_bridge.cpp). team is the local player's
            TeamInfo, map the level name as in "scores". The client keeps the
            menu open (number keys still go to it) but doesn't draw it.
            open false: that menu closed, for any reason: an item picked
            (slot keys), slot10 (the server sends it when the player leaves
            the buy zone or buy time ends), a menu with no valid keys,
            another text menu replacing it, or the cvar turned off; menu,
            team and map are "". The page closes the menu with "slot10",
            which also tells the server ("menuselect 10"). After "reset" it
            is closed and not resent.

Values not received from the server yet are not resent.

The menu library (3rdparty/mainui_cpp/BaseMenu.cpp) sends one more event the
same way: "menu" { visible: boolean }, checked every UI_UpdateMenu frame and on
UI_CloseMenu, sent when the main menu opens or closes.

cvar hud_html (default 0): nonzero skips drawing the stock HUD parts the
page replaces (including the whole scoreboard and the chat lines; the chat
still plays misc/talk.wav and goes to the console). Events are sent regardless of hud_html.
In the Emscripten build (0.0.9+) it defaults to 1 and is locked there:
WebBridge_Frame sets it back to 1 whenever something else changes it.

cvar hud_html_scores (default 0): nonzero also sends "scores" every 0.5 s
while the scoreboard is hidden (the page's admin player list).

cvar hud_html_buymenu (default 0): nonzero sends "buymenu" and skips drawing
the buy menus; the page sets it when it has its own buy menu, so a page
without one keeps the stock text menu.
*/

#pragma once
#ifndef WEB_BRIDGE_H
#define WEB_BRIDGE_H

#define HUD_HTML_ACTIVE() ( gHUD.hud_html && gHUD.hud_html->value != 0.0f )

void WebBridge_Health( int hp );
void WebBridge_Armor( int ap, bool helmet );
void WebBridge_Money( int amount, int delta );
void WebBridge_Weapon( const char *name, int clip, int reserve );
void WebBridge_RoundTime( void );	// RoundTime message: force a timer event
void WebBridge_BombPlanted( void );
void WebBridge_TeamScore( const char *team, int score );	// TeamScore message ("CT" / "TERRORIST")
void WebBridge_Kill( const char *killer, const char *victim, const char *weapon, bool headshot, int killerTeam, int victimTeam, int killerSlot, int victimSlot );
void WebBridge_TextMsg( int dest, const char *message );	// TextMsg: round end center messages
void WebBridge_SayText( const char *fmt, int slot, char *const argv[3], const char *formatted );	// SayText: argv[0] is the sender's name
void WebBridge_Notice( const char *text );	// TextMsg HUD_PRINTTALK
void WebBridge_Radio( int slot, const char *name, const char *location, const char *text );	// TextMsg HUD_PRINTRADIO
void WebBridge_Menu( const char *menu );	// ShowMenu: a whole text menu arrived (title key before localization)
void WebBridge_MenuClosed( void );	// CHudMenu closed its text menu
bool WebBridge_BuyMenuShown( void );	// the page draws the open text menu: CHudMenu::Draw skips it
void WebBridge_Init( void );		// CHud::Init: hooks the server plugins' WcMode / WcKillInfo
void WebBridge_Frame( void );		// once per frame: timer seconds, alive state, scoreboard
void WebBridge_InitHUD( void );		// sends "reset" + resend
void WebBridge_ResetHUD( void );	// resend

#endif // WEB_BRIDGE_H
