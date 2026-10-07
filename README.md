# Counter-Strike 1.6 Web Server <img alt="Counter-Strike 1.6 icon" align="right" width="128" height="128" src="./src/client/public/apple-touch-icon.png" />

This repository provides a **plug-and-play Docker image** for running a fully functional **Counter-Strike 1.6** client and dedicated server via the web. Powered by **Xash3D FWGS**, **WebRTC**, and modern web tooling, this setup allows for in-browser gameplay and remote multiplayer support.

## 🏆 Features

- ✅ Web-based CS 1.6 client (HTML + TypeScript + Vite)
- ✅ Dedicated CS 1.6 server (Go + CGO + Xash3D FWGS)
- ✅ WebRTC support for browser-to-server networking
- ✅ ReGameDLL_CS, Metamod-R, AMX Mod X and YaPB bots included
- ✅ Game modes from the F4 Match tab: Gun Game and Deathmatch (respawns, endless rounds, spawn protection; Gun Game has a 24-weapon ladder with knife steals and a winner that ends the map; Deathmatch has a guns menu), plus knife only and pistols only
- ✅ Fun maps on top of the stock ones: `fy_iceworld`, `aim_map`, `awp_india`, `fy_pool_day` (browsers download them from the server before joining)
- ✅ Announcer sounds on top of the HUD's toasts: First Blood (everyone hears it, with a "<name> drew first blood" toast; once a round, once a map in Gun Game and Deathmatch), Headshot, Double / Triple / Quad kill and Rampage, streaks of 5 / 10 / 15 / 20 (Killing spree, Dominating, Unstoppable, Godlike), Humiliation for a knife kill and a short sound when you are knifed, Last man standing; Gun Game level up, last level and winner once the game client sends the `mode` event (cs16-client 0.0.10). Our own sounds (`src/client/public/sounds`, credits in its README), loaded only after joining; one at a time, by priority. Settings (F3, Sound): Announcer volume (0 turns it off, and then the sounds aren't even downloaded), Announce headshots, Hear other players' first blood
- ✅ "Killed by" card when you die (lower centre, 6 s or until you respawn / the round starts): the killer in team colour, weapon, headshot, this map's record against them ("This map: you 2 – 5 Walter"), the all-time record from `/duel` once the pair has history, and their streak from 3 kills; short cards for falls, the bomb, your own grenade or `kill`, and "Killed by teammate". The killer's HP, armour and distance need cs16-client 0.0.10 (`killinfo` event). Setting (F3, HUD): Killer card
- ✅ Invite links: Settings (F3, or the Settings button on the login page) → "Copy invite link"; opening `/?join=1` loads the game and joins with the saved nickname (or asks for one first)
- ✅ Claimed names: Settings (F3) → "Your name" claims your nickname on this server, with a recovery code to sign in other browsers; nobody else can play or score under it, the leaderboard marks it with ✓, and the admin can release it (F4 → Players)
- ✅ Dockerized & easy to deploy
- ✅ i386 (32-bit) architecture support

## 🙏 Acknowledgements

Special thanks to **[yohimik](https://github.com/yohimik)** for his outstanding work on the [Xash3D-FWGS Emscripten Web Port](https://github.com/yohimik/webxash3d-fwgs) and the [Xash3D-FWGS CGO Wrapper](https://github.com/yohimik/goxash3d-fwgs), which made this possible!

## 🚀 Getting Started

### docker compose (recommended)

```yaml
---
services:
  cs16-web-server:
    image: ghcr.io/balintsoos/cs16-web-server:latest
    container_name: cs16-web-server
    command: ["+map de_dust2", "+maxplayers 14"]
    restart: always
    platform: linux/386
    environment:
      IP: 127.0.0.1
      PORT: 27018
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:-}
      RCON_PASSWORD: ${RCON_PASSWORD:-}
      BOT_QUOTA: ${BOT_QUOTA:-0}
      LEADERBOARD_BOTS: ${LEADERBOARD_BOTS:-0}
    volumes:
      - cs16-data:/xashds/data
    ports:
      - "27016:27016"
      - "27018:27018/tcp"
      - "27018:27018/udp"

volumes:
  cs16-data:
```

### docker cli

```shell
docker run -d \
  -name=cs16-web-server \
  -e IP=127.0.0.1 \
  -e PORT=27018 \
  -e ADMIN_PASSWORD \
  -e BOT_QUOTA=6 \
  -v cs16-data:/xashds/data \
  -p 27016:27016 \
  -p 27018:27018/tcp \
  -p 27018:27018/udp \
  --platform linux/386 \
  --restart always \
  ghcr.io/balintsoos/cs16-web-server:latest \
  +map de_dust2 +maxplayers 14
```

Then open http://127.0.0.1:27016 in your browser!

## 🌍 Environment Variables

| Variable           | Description                                                                                                                                    | Example            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `IP`               | Server IP address for WebRTC connection                                                                                                        | `123.45.67.89`     |
| `PORT`             | UDP port for CS server (must be open)                                                                                                          | `27018`            |
| `ADMIN_PASSWORD`   | Login for the F4 admin menu (admin API), at least 8 characters; unset: the menu uses `RCON_PASSWORD`                                           | `long-pass-phrase` |
| `RCON_PASSWORD`    | rcon password, only needed without `ADMIN_PASSWORD`; unset disables rcon. Letters, digits and `_.~!@#%^*=+,:?-`, ≤ 64                          | `Xk9_m2.Lq7`       |
| `BOT_QUOTA`        | Players (humans + YaPB bots) to keep in the game, 0–32; bots leave as humans join. Default `0` (no bots)                                       | `6`                |
| `DATA_DIR`         | Directory of the ban list (`bans.json`) and the leaderboard (`leaderboard.db`); default `data` in the working dir, `/xashds/data` in the image | `/xashds/data`     |
| `LEADERBOARD_BOTS` | `1` lists YaPB bots on the leaderboard too; default `0` (bots get no row, but kills on them and deaths by them count)                          | `1`                |

With docker compose, put the passwords in a `.env` file next to
`docker-compose.yml` (ignored by git; see `.env.example`). Never set them in
`server.cfg`, which is part of the image.

With `ADMIN_PASSWORD` set, the F4 menu logs in to the server's admin API
(`/admin/*`) and the server runs the commands itself; the browser never
sees the rcon password, and rcon requests from players are dropped. If
`RCON_PASSWORD` isn't set too, the server makes up a random one for its own
use. The login is a session cookie that lasts 8 hours or until the server
restarts. Five wrong passwords from one address lock that address out of
the login for 5 minutes. The server counts the address the connection
comes from and doesn't trust `X-Forwarded-For`, so behind a reverse proxy
everybody shares the proxy's address (and its lockout). The server itself
only speaks plain HTTP: put it behind HTTPS if the password must not cross
the network in the clear (rcon from the game is encrypted by WebRTC).

`BOT_QUOTA` fills the server with bots (YaPB `yb_quota_mode fill`): with
`BOT_QUOTA=6`, an empty server has 6 bots and a single player joining
finds 5. Spectators don't count. An invalid value logs a warning and
means 0. It is only the starting value: the Bots tab of the F4 menu ("Fill
to N", add/kick) changes it at runtime, and that change is kept over map
changes until the server restarts.

Bans: with `ADMIN_PASSWORD` set, the Players tab of the F4 menu has a Ban
button next to Kick. It kicks the player and bans the address their
connection came from (IPv4: that address; IPv6: its whole /64), and lists
the banned addresses with an Unban button. A banned address can't connect
(the game's WebSocket gets 403), and every connection from it is closed
when the ban is made. Like the login lockout, the address is the one the
connection comes from, not `X-Forwarded-For`: behind a reverse proxy every
player has the proxy's address, so the server refuses to ban an address
that is the admin's own. Bans are saved in `bans.json` in `DATA_DIR`; mount
a volume there (the compose file above does) to keep them across
restarts. Without `ADMIN_PASSWORD` (rcon only) there is no Ban button, but
a saved ban list still applies. The engine's own `banid` / `addip` don't
work here: the engine only sees made-up addresses for WebRTC players.

Lobby status: `GET /status.json` returns the current map, the player count
and max players, each player's name and score (bots marked), the time left
and the next map (the last two need AMX Mod X), and `gameMode` (1 Gun Game,
2 Deathmatch, left out for a classic game). The login page shows it as
"de_dust2 · 5/16 players" (or "de_dust2 · Gun Game · 5/16 players") with
the names, refreshed every 5 seconds.
**Player names are public:** anyone who opens the page (or the endpoint)
sees who is playing, as in any server browser. The server reads it with
the engine's own server queries (A2S_INFO / PLAYER / RULES, no rcon), so it
works with or without `ADMIN_PASSWORD`; answers are cached for 2 seconds
and each address may ask 5 times a second (bursts of 20; behind a reverse
proxy everyone shares the proxy's address). Setting `sv_password` or
`sv_expose_player_list 0` hides the names but not the count.

Leaderboard: `GET /leaderboard` returns the top 20 players by kills since
the leaderboard was started, with deaths, K/D, headshot %, rounds
played, Gun Game wins (`ggWins`) and `claimed` (true on the row of a
claimed name, exactly as it was claimed); the login page shows it as a
"Top players" section, with a ✓ after claimed names. **Other names aren't
verified:** totals are kept per player name, and anyone can join under an
unclaimed name and add to (or spoil) its totals; a rename starts a new
row. The
server turns on the game's logging (`log on`, one `cstrike/logs/L*.log` per
map, inside the container) and reads the kill, team and round lines as
they are written; the totals, and how far each log file was read, are
saved in `leaderboard.db` (SQLite) in `DATA_DIR`, so mount a volume there
(the compose file does) to keep them. A restart neither counts a line
twice nor skips one. Kills count like the scoreboard's session stats:
enemy kills only; teamkills and suicides (also falls and other deaths by
the world) count as deaths. Kills in Gun Game and Deathmatch count like
any other (one shared leaderboard); those modes have no round ends, so
they add no rounds. Headshots come
from our `wc_statslog.amxx` plugin (stock CS 1.6 doesn't log them), Gun
Game wins from `wc_gamemode.amxx`'s `triggered "wc_gg_win"` line. Bots
get no row unless `LEADERBOARD_BOTS=1`. Only the 20 newest log files are
kept (older ones are deleted once read); the logs also contain every rcon
command, including the rcon password, so don't publish them. Answers are
cached for 5 seconds and rate limited like `/status.json`. If the database
can't be opened, the server logs a warning, doesn't turn logging on and
`/leaderboard` answers 404. To start over, stop the server and delete
`leaderboard.db`. An older `leaderboard.db` is upgraded in place when the
server starts (new columns and tables added, totals kept; `PRAGMA
user_version` says which upgrades it has had).

Head-to-head: `GET /duel?a=<name>&b=<name>` returns `{"aKills": n,
"bKills": m}`, how many times `a` killed `b` and `b` killed `a` since this
was added (no history from before). It comes from the same log lines and
rules as the leaderboard: enemy kills only, bots only with
`LEADERBOARD_BOTS=1`, names exact (case included), up to 64 bytes each
(400 otherwise), unknown names are 0 – 0, and a rename starts a new pair.
A claimed name (below) in any spelling ("walter", "Walter (1)") is looked
up under its claimed spelling, where its owner's kills go.
Cached for 5 seconds per pair and rate limited like `/leaderboard`; 404
when the leaderboard database is off. The "Killed by" card asks it once per
killer per map, 2.5 s after the death (when the server has read that kill
from the log), so the all-time line shows from the next death by that
killer when the card is gone sooner (respawn).

Claimed names: a player can claim a name, which ties it to the browser
with a cookie and a recovery code. In the page: Settings (F3, or the
Settings button on the login page) → **Your name** claims the current
nickname and shows the recovery code **once** (Copy code, then "I saved
it"); "Sign in with a recovery code" signs in another browser (or this one
after clearing its cookies); "Release this device" signs this browser out
(the claim and its code stay); "Release the name" (with the code) frees the
name for anyone. Claiming or signing in during a game counts from the next
join, so the panel offers "Rejoin now" (it reconnects, under the claimed
name); until then the server treats the connection as a guest. The admin
can release any claim in the F4 menu (Players tab, "Claimed names", needs
`ADMIN_PASSWORD`; admin action `{"action":"release_claim","name":"..."}`,
`{"action":"claims"}` lists them). A release keeps the leaderboard row; it
loses its ✓ and goes to whoever claims the name next.

What a claim protects, on this server only:

- **The leaderboard row.** Kills, deaths, rounds, head-to-head and Gun
  Game wins of a player under a claimed name (in any spelling that matches,
  see below) count only if their browser has the claim, and then go to the
  row named exactly as claimed. Anyone else's (no cookie, another browser,
  a bot) count nowhere: not for the claimed row, not for a row of their
  own. Rows of other spellings ("walter" next to "Walter") stop growing.
- **The name in game.** Whoever enters, changes to or plays under a
  claimed name without the claim is renamed by the server within about 2
  seconds (the log is read every 2 s) to `<name> (guest)` (cut to 31
  bytes), or `Player <userid>` if that can't be used, and a few seconds
  later (after joining a team, if renamed while still loading) gets the
  chat line "That name is claimed. Sign in from Settings to use it."
  Everyone sees AMX Mod X's "change nick" notice. A client that
  keeps taking the name back is renamed at most 3 times per map (its stats
  are dropped anyway). The rename runs `amx_nick` through the same
  in-process console as the admin API; with the admin API off the server
  sets an rcon password nobody knows for it (or uses `RCON_PASSWORD`).
- **The login page** says "This name is claimed by someone else" (or
  "✓ yours") under the nickname as it is typed.

What it doesn't:

- **It's not an account.** No password or email; nothing about the player
  is stored. It covers this server's leaderboard and in-game name only.
- **The recovery code is the name.** Anyone who has it can sign in, play
  under the name, or release it; nobody (not even the admin) can show it
  again or tell who claimed what. Lose it and clear your cookies and the
  name is gone until the admin releases it.
- **Behind a reverse proxy without HTTPS** the cookie crosses the network
  in the clear on every request: anyone on the path can copy it and play
  as you. Serve the page over HTTPS for claims to mean much.
- **Look-alike names aren't caught**: "Wаlter" with a Cyrillic а or a
  fullwidth "Ｗalter" is a different name from "Walter".
- First claim wins: claiming an existing leaderboard row gives it to
  whoever claims it first; there's no proof of who played it.

- `GET /names/me` → `{"name": "..."}` for this browser's claim, or `{}`.
- `GET /names/status?name=<name>` → `{"claimed": bool, "mine": bool}`.
- `POST /names/claim {"name"}` → `{"name", "code": "XXXX-XXXX-XXXX-XXXX"}`
  and sets the cookie. The code is shown only this once. 409 `taken` if
  someone has the name, 400 `invalid_name` for a name the game wouldn't
  keep or a reserved one (`Player`, `Player <n>`, `unnamed`, `console`,
  `... (guest)`): 1–31 bytes of UTF-8, no `"` `\` `;`, `..` or control
  characters.
- `POST /names/signin {"name", "code"}` signs this browser in (sets the
  cookie); the code may be typed in any case, with or without dashes.
- `POST /names/release {}` forgets this browser (the claim stays);
  `{"all": true, "code", "name"}` releases the claim itself and signs out
  all its browsers (`name` defaults to this browser's). The leaderboard row
  is kept.

Names match ignoring case, spaces, colour codes (`^1`), `%`/`&`, invisible
characters and the game's ` (1)` suffix, so "walter" and "^1Walter " are
the same name as "Walter"; look-alike letters from other scripts
("Wаlter" with a Cyrillic а) and fullwidth letters are not caught. One
name per browser: claiming or signing in to another one answers 409
`device_has_name` until this browser is released. Errors are
`{"error": "<code>", "message": "..."}`. The cookie (`wc_player`) is
HttpOnly, SameSite=Strict, lasts a year (renewed by `/names/me`) and is
`Secure` when the page came over HTTPS (`X-Forwarded-Proto: https` from a
proxy counts); behind a proxy **without** HTTPS it crosses the network in
the clear. Only SHA-256 hashes of the cookie and the code are stored, in
`leaderboard.db`, so the volume on `DATA_DIR` keeps claims too. POSTs must
be same-origin JSON like the admin API; every `/names/` path is rate
limited like `/leaderboard`; 5 wrong codes from one address lock it out of
sign-in and release for 5 minutes (separately from the admin login), and
one address can claim 5 names an hour (both 429 with `Retry-After`; the
proxy caveat of the admin login applies). With the leaderboard database
off every `/names/` path is 404.

## ⚙️ Customization

Client UI/UX:

- Modify files in src/client

Plugins included in the image (pinned versions with checksums in the
`Dockerfile`):

| Plugin    | Version        | Notes                                                                                                                                                                                                                                                                            |
| --------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metamod-R | 1.3.0.149      | Loaded through `liblist.gam`; plugin list in `configs/cstrike/addons/metamod/plugins.ini`                                                                                                                                                                                        |
| AMX Mod X | 1.10.0-git5486 | Base + cstrike packages; `adminslots.amxx` is off (it errors on Xash3D)                                                                                                                                                                                                          |
| YaPB      | 4.4.957        | Bots; `yb_quota` defaults to 0, so add them with `yb add` / `yb_quota <n>`                                                                                                                                                                                                       |
| ReGameDLL | 5.30.0.814     | Replaces the stock game DLL (`cstrike/dlls/cs.so`); adds cvars such as `mp_forcerespawn`, `mp_round_infinite`, `mp_respawn_immunitytime`, `mp_item_staytime`, `mp_buy_anywhere`. Only `cs.so` is used: no `game.cfg` (it would run on every map change), HLDS's `delta.lst` kept |

The server console and rcon run `amx_*`, `meta` and `yb` commands. On
Xash3D, cvars that AMX Mod X marks as single-player-only (like
`amx_nextmap`) can't be set from the console; use
`amx_cvar amx_nextmap <map>`.

Our own AMX Mod X plugins are in `src/amxx/`. The Docker build compiles
every `.sma` there with the AMX Mod X compiler (`amxx-plugins` stage); add
each new one to the `plugins.ini` line in the `hlds` stage. Weapon code they
share (stripping, giving with full ammo, the buy commands) is in
`src/amxx/wc_weapons.inc`:

| Plugin               | Cvar                                                                                                                                                                                                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wc_weaponmode.amxx` | `wc_weaponmode 0\|1\|2` (off / knife / pistols)                                                                                                                                                                                                                                                       | Knife only or pistols only; C4, armour, defuse kit and night vision stay allowed, grenades and the shield don't. Blocks buys and pickups and strips other weapons. Kept over `sv_restart`, set back to 0 on every map change. Ignored (set back to 0) while `wc_gamemode` isn't 0. Match tab presets. `wc_weaponmode_status` lists each player's weapons.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `wc_gamemode.amxx`   | `wc_gamemode 0\|1\|2` (classic / Gun Game / Deathmatch), `wc_dm_fraglimit` (default 0 = off), `wc_gg_ladder` (`;` list of weapon names, default glock18 … m249;hegrenade;knife, 24 levels), `wc_gg_kills_per_level` (default 1), `wc_gg_suicide_penalty` (default 0), `wc_gg_join_lowest` (default 1) | Sets the mode's ReGameDLL and YaPB cvars (respawn after 1 s, endless rounds, 2 s spawn protection ended by shooting, dropped weapons gone after 5 s, no C4, bots ignore objectives; see `MODE_CVARS` in the source) and puts back the classic values when the mode ends or on the next map; turns `wc_weaponmode` off; says the mode in chat and restarts the game (`sv_restart 1`, 2 s later, and only if nothing else restarted it meanwhile: a Match tab preset's own restart is the only one). Both modes: hostages hidden, the map's `game_playerspawn` equipment (awp_india) off, random spawns away from enemies, protected players glow in their team colour. Deathmatch: guns menu on spawn (new / same as last time / same every time; B or `say guns` opens it), full armour, HE and two flashbangs, buying off, bots get random guns, the map ends at `wc_dm_fraglimit` frags. Gun Game: everyone has their level's weapon (full ammo, refilled on reload) and the knife, kevlar and helmet; `wc_gg_kills_per_level` kills with it give the next weapon, a knife kill steals a level (victim down one), team kills don't count, suicides cost a level only with `wc_gg_suicide_penalty 1`; on the HE level a new grenade comes 1 s after the last one explodes; a kill on the last level (the knife) wins: chat and centre message, a `"Name<uid><auth><team>" triggered "wc_gg_win"` log line, everyone frozen for 5 s, then the next map (`amx_nextmap`); late joiners start at the lowest level (`wc_gg_join_lowest`); buying, pickups and dropping are off; bots get their level's weapon and don't buy or look for weapons; a HUD line at the top shows "Level 7/24 \| MP5 \| leader: Walter (12)". Players whose userinfo has `wc_html_hud 1` (set by the page once its cs16-client forwards the `mode` bridge event, 0.0.10+; not yet the vendored 0.0.9) get the `WcMode` user message instead (format at the top of the source) and the HTML HUD draws a Gun Game strip above the clock, a level toast and a spawn protection bar. The `wc_gg_*` cvars are kept over map changes. Set back to 0 on every map change. `FCVAR_SERVER`, so `/status.json` shows it. Match tab presets and fields. `wc_gamemode_status` prints the mode and its cvars, `wc_dm_status` each player's state, `wc_dm_guns <userid> <primary> <pistol>` picks guns as the menu does, `wc_gg_status` lists each player's Gun Game level, `wc_gg_setlevel <userid> <level>` sets one (tests); `wc_mode_test <userid> <0\|1>` sends `WcMode` to a player (bots too) as if they had `wc_html_hud 1`. |
| `wc_statslog.amxx`   | none                                                                                                                                                                                                                                                                                                  | Logs `"Killer<..>" triggered "wc_headshot" against "Victim<..>" with "weapon"` for every headshot kill, for the leaderboard (stock CS 1.6 logs kills without saying headshot), and the stock `"Old<..>" changed name to "New"` line, which the game doesn't write on this engine (claimed names need it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `wc_killinfo.amxx`   | none                                                                                                                                                                                                                                                                                                  | Kill details for the "Killed by" card: when a player kills another (team kills too, not suicides or the world), sends the victim the `WcKillInfo` user message with the killer's userid, health and armour at that moment, the weapon, headshot, whether the killer was fully flashed and whether the bullet went through a wall (ReGameDLL's kill flags, plus a check that the killer couldn't see the victim), and the distance in metres (format at the top of the source). Only to players whose userinfo has `wc_html_hud 1` (the page sets it once its cs16-client forwards the `killinfo` bridge event, 0.0.10+; not yet the vendored 0.0.9), never to bots. `wc_killinfo_status` prints the message id and the last kills sent (with the killer's own HUD health / armour for checking); `wc_killinfo_test <userid> <0\|1>` sends it to a player (bots too) as if they had `wc_html_hud 1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

AMX Mod X logs (`log_amx`) are in `cstrike/addons/amxmodx/logs`; the
game's own logs (read by the leaderboard) are in `cstrike/logs`.

Custom plugins:

- Mount a volume to /xashds inside the container
- Or copy plugin files into the Docker build context

Maps:

- The map cycle (`configs/cstrike/mapcycle.txt`) is `de_dust2`,
  `fy_iceworld`, `cs_assault`, `aim_map`, `de_inferno`, `awp_india`,
  `fy_pool_day`, `de_nuke`. The players' end-of-map vote and `amx_mapmenu`
  offer the stock maps plus the four community maps (`maps.ini`).
- The community maps are downloaded in the Dockerfile `maps` stage and
  checked against a pinned sha256 of the `.bsp`. Each one has a
  `<map>_url` / `<map>_sha256` build argument (for example
  `--build-arg fy_iceworld_url=https://example.com/maps/fy_iceworld.bsp`).
  The defaults are the GameBanana archives; **point the URLs at your own
  mirror** (a bare `.bsp` or an archive with it inside both work) so the
  build doesn't depend on GameBanana. Sources, authors and sizes are in
  `plans/new-features-1006.md` (Progress, B.1).
- `fy_`, `aim_` and `awp_` maps load their own settings when they start
  (`configs/cstrike/addons/amxmodx/configs/maps/prefix_*.cfg`, run by AMX
  Mod X a few seconds in): `mp_startmoney 16000`, `mp_freezetime 0`,
  `mp_roundtime 2`, `mp_buytime 0.25`, then a round restart. They override
  what the F4 Match tab set. The map after one of them gets the stock values
  back (`configs/cstrike/leave_funmap.cfg`, run through the engine's
  `mapchangecfgfile`), so a classic map doesn't keep $16000 and 2-minute
  rounds.
- YaPB graphs (bot waypoints) for the community maps are in
  `configs/cstrike/addons/yapb/data/graph` (from YaPB's graph database,
  except `fy_iceworld`'s, made by YaPB's own analysis because the database
  has the graph for the original version of that map).
  For any other map YaPB downloads one from that database, or analyses the
  map itself (a few seconds to a minute), and saves it in
  `cstrike/addons/yapb/data/graph`.

## 🛠️ Development

### Build Docker image:

```shell
docker build --platform=linux/386 -t cs16-web-server .
```

### Install client dependencies, build and serve client:

```shell
nvm install
npm install
npm run build
npm run serve
```

### Install server dependencies:

```shell
goenv install
go mod download
```

## 📜 License

This project is licensed under the MIT License.
See the [LICENSE](./LICENSE) file for more information.

Counter-Strike and all related trademarks, logos, and intellectual property are the property of Valve Corporation. This project is not affiliated with or endorsed by Valve Corporation.
