# New Features (game modes, maps, announcer, killer card, names) — Plan

Date: 2026-10-06 · Branch: new branch off `main` after `chat-enhance` is
merged (suggested `new-features-1006`), because Parts C and D build on the
HUD and the `cs16-client` 0.0.9 bridge.

Make the server more fun to drop into with friends:

- **Part A — game modes:** Gun Game and Deathmatch, picked from the F4
  Match tab like the knife and pistols modes.
- **Part B — fun maps:** `fy_iceworld`, `aim_map`, `awp_india`,
  `fy_pool_day`, `cs_assault` in the image, the map cycle and the Map tab.
- **Part C — announcer sounds:** First Blood, Headshot, multi-kills, kill
  streaks and knife kills as audio on top of the existing toasts, with
  settings to turn them down or off.
- **Part D — "Killed by" card:** when you die, who killed you, with what,
  how much HP and armour they had left, the distance, and your record
  against them (this map and all time).
- **Part E — claimed names:** a player can claim a name for the
  leaderboard. Nobody else can play or score under it.

Each part can ship on its own. Suggested order: B (config only) → A → C → D
→ E. D's all-time record works better once E is done, but it doesn't need
E.

## How things work today

Check these again before starting a part.

- **Weapon modes.** `src/amxx/wc_weaponmode.sma` (`wc_weaponmode 0|1|2`)
  strips weapons on spawn, blocks buys (`RegisterBuyCommands`) and pickups
  (`Ham_Touch` on `weaponbox` / `armoury_entity` / `weapon_shield`), polls
  once a second, and sets YaPB's `yb_jasonmode` / `yb_restricted_weapons` so
  bots follow along. It goes back to 0 on every map change. The Match tab
  presets are in `src/client/src/admin/presets.ts`, and the cvars the admin
  API accepts are in `adminCvars` (`src/server/admin_actions.go`), mirrored
  in `src/client/src/admin/cvars.ts`.
- **Game DLL.** The image runs Valve's stock CS 1.6 game DLL from the HLDS
  build `8308` (Dockerfile `hlds` stage), loaded through Metamod-R. There is
  no ReGameDLL and no ReAPI, so cvars like `mp_forcerespawn` and
  `mp_round_infinite` don't exist yet.
- **Maps.** `configs/cstrike/mapcycle.txt` only has `de_dust2`. The stock
  maps come from the game zip (`GAMEFILES_URL` in
  `src/client/src/gamefiles.ts`). Maps the zip doesn't have are served by Go
  from `cstrike/maps` at `/maps/<name>.bsp` with `/maps/index.json` listing
  name, size and sha256 (`src/server/maps.go`). The client fetches them over
  HTTP before connecting and every 5 minutes after that
  (`src/client/src/maps.ts`), because the engine's own download crashes the
  server (`cl_allowdownload 0`). **Only `.bsp` files are served**: no
  `.wad`, models, sounds or sprites.
- **Bots.** YaPB 4.4.957. Without a graph (waypoint) file for a map, YaPB
  analyses the map itself on first load and saves the result in
  `addons/yapb/data` (that folder is writable for this reason).
- **Kill events on the page.** The bridge's `kill` event (`KillEvent` in
  `src/client/src/stats.ts`) has killer, victim, weapon, headshot, both
  teams and both userids. `createSessionStats().recordKill` counts it and
  reports the local player's streak and multi-kill (`MULTI_KILL_WINDOW_MS`
  = 4 s, "Double kill" ... "Rampage"). `hud.ts` shows that in
  `#hud-toast-text`. Round start and end come from `rounds.ts` (`round`,
  `intermission` events).
- **Settings.** `src/client/src/settings/schema.ts` (`SETTINGS`, groups
  `Mouse | Crosshair | Sound | HUD | Keys`). The F3 panel builds a control
  from each entry. Read values with `getSettings()` / `onSettingsChange()`.
- **Leaderboard.** `statsfollow.go` reads the game logs every 2 s and adds
  to per-name totals in `leaderboard.db` (`statsdb.go`). `statslog.go`
  parses kill, suicide, `wc_headshot`, team, name change, entered,
  disconnected and round lines. The "connected, address" line isn't parsed
  yet. Names aren't verified: anyone can play as anyone.
- **Players and addresses.** The SFU gives each WebRTC player a made-up IPv4
  address: the slot index followed by 3 bytes unique to the connection
  (`peerSlot` in `src/server/sfu.go`). `peerSlot.key` is the player's real
  address (used for bans). `peerDirectory.keyOf(ip)` maps a fake address
  back to it.
- **Game client changes** need a new `cs16-client` tarball (see
  `BUILD-NOTES.md` in `../webxash3d-fwgs/packages/cs16-client`): update
  `html-hud.patch`, rebuild, bump the version, and update `package.json`,
  `package-lock.json` and the `Dockerfile` `COPY vendor/cs16-client-*.tgz`
  line.

## Definition of done for every step

On top of each step's own definition of done:

- `npm run build` succeeds with no TypeScript errors; Prettier formatting
  kept.
- Go changes: `go vet` and the Go tests pass (in the container,
  `plans/admin-player-features-tools/gotest.sh`), with new tests for new
  parsing or rules.
- `.sma` changes compile in the `amxx-plugins` Docker stage with no
  warnings. New plugins are added to the `plugins.ini` line in the `hlds`
  stage.
- Checked by hand in the Docker image (`make build-local-image`, then
  `make run`) with two browser clients plus bots, on desktop Chrome and on
  a phone.
- README updated (features, cvars, plugins table, environment variables).

---

## Part A — Game modes: Gun Game and Deathmatch

Both modes need players to come back right after they die and rounds that
don't end when one team is wiped out. The stock game DLL can't do either,
so the first step decides how we get them.

### A.0 Spike: ReGameDLL or AMXX only

**Goal:** pick the base for respawns and endless rounds.

- **Option 1 (recommended): ReGameDLL_CS.** A drop-in replacement for the
  CS game DLL (`cs.so`) that adds `mp_forcerespawn <seconds>`,
  `mp_respawn_immunitytime`, `mp_round_infinite`, `mp_buy_anywhere`,
  `mp_item_staytime` and `mp_refill_bpammo_weapons`. It is open source and
  pinned like the other addons (version and sha256 `ARG`s, Metamod's
  `gamedll_linux` stays the same, ReGameDLL replaces `dlls/cs.so`).
  Check: the server starts on Xash3D FWGS in the container, Metamod-R, AMX
  Mod X, YaPB, `wc_weaponmode` and `wc_statslog` still load, and a
  20-minute game with bots and two browser players runs with no crash and
  the same log lines (the leaderboard parser depends on them).
- **Option 2: AMXX only.** Respawn with `ExecuteHamB(Ham_CS_RoundRespawn)`
  0.5 s after death, remove the map's objectives (`func_bomb_target`,
  `info_bomb_target`, `hostage_entity`, `func_escapezone`,
  `func_vip_safetyzone`) on map start, and set `mp_roundtime 9`. Rounds
  still end when everyone on one team is dead at the same moment, and
  after 9 minutes. The game restarts the round 5 s later, which is
  acceptable but visible.

**Done when:** the choice is written in the Progress section below, with
what was checked. If ReGameDLL works, the rest of Part A uses its cvars;
otherwise the plugin does it as in option 2. **Every step below names both
paths.**

### A.1 Mode cvar and Match tab

- New cvar `wc_gamemode 0|1|2` (classic / gun game / deathmatch), owned by
  a new plugin `src/amxx/wc_gamemode.sma`. Like `wc_weaponmode`, it goes
  back to 0 on every map change, and the plugin polls it once a second and
  says the change in chat ("[Server] Game mode: Gun Game.").
- The modes don't mix: setting `wc_gamemode` to 1 or 2 sets
  `wc_weaponmode` to 0, and `wc_weaponmode` doing anything while
  `wc_gamemode` is not 0 is ignored (the weapon mode plugin checks
  `wc_gamemode`).
- Add `wc_gamemode: {0, 2, 0}` to `adminCvars` and the same to `cvars.ts`.
  Add presets **Gun Game** and **Deathmatch** to `presets.ts` (with the
  money, freeze time and buy time each mode wants), and set `wc_gamemode: 0`
  in the existing presets so picking "Casual" leaves a gun game.
- Changing the mode runs `sv_restart 1` so everyone starts fresh.
- `wc_gamemode` is `FCVAR_SERVER`, so A2S_RULES shows it: add it to
  `/status.json` (`status.go`) and show "Gun Game" / "Deathmatch" on the
  login page lobby line ("de_dust2 · Gun Game · 5/16 players").

**Done when:** the mode can be switched from the Match tab and the lobby
shows it; switching to a weapon mode while a game mode is on does nothing
and the Match tab says why.

### A.2 Deathmatch

- **Respawn:** 1 s after death (ReGameDLL: `mp_forcerespawn 1`; otherwise
  the plugin). Free weapon choice on spawn.
- **Spawn protection:** 2 s of god mode with a team-coloured glow, ending
  early when the player fires (ReGameDLL: `mp_respawn_immunitytime 2`, plus
  the plugin for the glow and for ending it on fire).
- **Random spawns:** spawn at any `info_player_start` /
  `info_player_deathmatch` on the map, preferring points with no enemy in
  sight and none within 300 units, so people aren't spawn-killed.
- **Guns menu:** on spawn, a menu (AMXX `menu_create`) with "Same as last
  time", primary (rifles, SMGs, AWP, shotguns), secondary (pistols). Full
  armour and two flashbangs and an HE each spawn. The buy zone is off. Bots
  get a random primary.
- **Endless rounds:** objectives removed, no round end on elimination
  (ReGameDLL: `mp_round_infinite 1`). The map ends on `mp_timelimit` (or
  a frag limit, `wc_dm_fraglimit`, default 0 = off).
- **Dropped weapons** disappear after 5 s (`mp_item_staytime 5`, or the
  plugin removes `weaponbox` entities).
- **Bots:** they respawn too. Check YaPB doesn't get stuck trying to plant
  or rescue on maps whose objectives were removed. If it does, look in
  `yapb.cfg` for cvars that turn off objective play; write down what
  worked.

**Done when:** a 10-minute deathmatch on `de_dust2` and `cs_assault` with
bots and two browser players: respawns, protection, the guns menu (also on
a phone), no round ends, no stuck bots, no crash.

### A.3 Gun Game

Our own small plugin (in `wc_gamemode.sma`, sharing the weapon stripping
code with `wc_weaponmode.sma`, moved to an include `src/amxx/wc_weapons.inc`)
rather than the large community GunGame plugin, which uses features we
don't have and hasn't been tested on Xash3D.

- **Ladder** (cvar `wc_gg_ladder`, a `;` list of weapon names, default):
  glock18, usp, p228, deagle, fiveseven, elite, tmp, mac10, mp5navy,
  ump45, p90, m3, xm1014, galil, famas, ak47, m4a1, sg552, aug, scout,
  awp, m249, hegrenade, knife. 24 levels.
- **Rules:** one kill moves you up one level (`wc_gg_kills_per_level`,
  default 1). A knife kill steals a level from the victim (they go down one,
  not below 1). Team kills and suicides do nothing (suicide: down one,
  optional cvar `wc_gg_suicide_penalty`, default 0). On the HE grenade
  level, a new grenade comes 1 s after the last one explodes. On level up,
  the old weapon is taken away and the new one given with full ammo.
- **Respawn** as in Deathmatch (A.2), same spawn protection and random
  spawns. Buying and pickups are blocked like the knife mode does.
- **Win:** the first knife kill on the last level wins the map: centre
  message and chat "<name> won Gun Game!", a log line
  `"Name<..>" triggered "wc_gg_win"` (for the leaderboard, A.5), everyone
  frozen for 5 s (`set_user_maxspeed`, god mode), then the next map from
  the map cycle (or the vote, if one ran).
- **Late joiners** start at the lowest level among the players on the
  server (`wc_gg_join_lowest 1`), so they aren't hopeless.
- **Level display:** HUD message (AMXX `set_hudmessage`, top centre) with
  "Level 7/24 · MP5 · leader: Walter (12)". Step A.4 replaces it with the
  HTML HUD.
- **Bots:** give them their level's weapon on spawn and after each level
  up, and set `yb_restricted_weapons` to everything else so they don't buy
  or pick up other weapons (same trick as the pistols mode).

**Done when:** a full Gun Game on `de_dust2` and `fy_iceworld` with bots and
two browser players: levels go up and down correctly (also the knife steal
and grenade refill), bots use their level's weapon, the winner is
announced and the map changes. Plugin unit-like check: `wc_gg_status`
server command lists each player's level, used by the smoke test.

### A.4 Gun Game and Deathmatch on the HTML HUD

- The page only hears from the server through the game, and the bridge
  doesn't forward console lines, so this needs a client change.
  **Decision:** add a bridge event `mode` in cs16-client 0.0.10 (same
  release as Part D's `killinfo`, see D.1): the plugin registers a user
  message `WcMode` (`engfunc(EngFunc_RegUserMsg, "WcMode", -1)` in
  `plugin_precache`) and sends `{mode, level, levels, weapon, leader,
leaderLevel}` to each player when it changes. The client hooks
  `WcMode` and calls `hudEvent("mode", ...)`.
- HUD: a Gun Game strip under the timer ("7 / 24 · MP5 → UMP45 next",
  leader name and level) and a short level-up toast ("Level 8: UMP45").
  Deathmatch: spawn protection bar while immune.
- When the bridge event arrives, the plugin's HUD message is not drawn for
  that player (the plugin skips players whose client sent `wc_html_hud 1`
  as a userinfo key; set it from the page with `setinfo wc_html_hud 1` at
  connect).

**Done when:** the strip and toasts update on desktop and phone, and a
client without the new bridge (older tarball) still gets the plugin's HUD
message.

### A.5 Leaderboard and stats in the new modes

- Kills in Gun Game and Deathmatch count on the leaderboard like any other
  kills (**decision to review**; the alternative is a `mode` column and a
  mode filter on `/leaderboard`).
- "Rounds played" doesn't grow in these modes (no `Round_End` lines);
  that's fine.
- New leaderboard column "Gun Game wins" from the `wc_gg_win` line
  (`statslog.go` new event `logGunGameWin`, new `gg_wins` column, schema
  migration with `ALTER TABLE ... ADD COLUMN` guarded by a version check,
  test for both an old and a new database).

**Done when:** Go tests cover the new line and the migration; the login page
shows the column.

---

## Part B — Fun maps

### B.1 Pick and check the map files

For each of `fy_iceworld`, `aim_map`, `awp_india`, `fy_pool_day`
(`cs_assault` is a stock map and should already be in the game zip; check):

- Find a widely mirrored copy, write down where it came from, its size
  and sha256, and check it may be redistributed (community maps are
  usually shared freely; note the author).
- **List what it needs besides the `.bsp`:** textures in external `.wad`
  files, custom models, sounds, sprites, sky textures (`resgen` or
  `strings` on the bsp, or load it on a local engine with `developer 2`
  and watch for missing files). Prefer versions with textures embedded in
  the bsp.
- Anything a map needs that the game zip doesn't have: either extend
  `/maps/` to serve those files too (B.2), or skip the map.

**Done when:** a table in this file (Progress section) with each map's
source, size, sha256, license note and extra files.

### B.2 Serve extra map files (only if B.1 found any)

- Extend `src/server/maps.go` to serve the files listed in a map's
  `<map>.res` (or our own list) from `cstrike/` at `/maps/res/<path>`, with
  the same name checks (relative path, allowed extensions `.wad .mdl .spr
.wav .tga .bmp`, no `..`) and include them in `index.json` under the map
  (`"resources": [{path, size, sha256}]`).
- `src/client/src/maps.ts` writes them into `/rodir/cstrike/<path>` like
  the bsp and caches them the same way.

**Done when:** Go tests for the path checks and index; a map with a custom
wad loads in a fresh browser profile.

### B.3 Put the maps in the image

- Don't commit the binaries. Mirror them to the same blob storage as the
  game zip and download them in the Dockerfile `hlds` stage with pinned
  sha256 `ARG`s (like Metamod / AMXX / YaPB), into `cstrike/maps`.
- `mapcycle.txt`: `de_dust2`, `fy_iceworld`, `cs_assault`, `aim_map`,
  `de_inferno`, `awp_india`, `fy_pool_day`, `de_nuke` (mix of fun and
  classic; **decision to review**).
- Per-map settings in `addons/amxmodx/configs/maps/<map>.cfg` (AMXX runs
  it on map load): for `fy_`, `aim_` and `awp_` maps `mp_startmoney 16000`,
  `mp_freezetime 0`, `mp_roundtime 2`, `mp_buytime 0.25`. Note: these run
  after `server.cfg` and override what the Match tab set for the previous
  map; the Match tab should say so when a fun map is next.
- YaPB: load each map once in the container so YaPB analyses it, check bots
  move around sensibly (no bots standing still for a whole round), and
  copy the generated graph files into the image (`addons/yapb/data/graph`)
  so a fresh container doesn't spend minutes analysing on first load. If a
  map's graph is bad, look for a published graph for it.

**Done when:** every map loads from the Map tab and from the cycle, a fresh
browser downloads it with progress and joins, bots play on it, and the
image size grew by what the table says.

---

## Part C — Announcer sounds

### C.1 Sounds

- **Don't use the Unreal Tournament / "Quake sounds" files**: they are
  copyrighted. Record our own or use CC0 sounds, or generate them with a
  TTS voice whose license allows it. Write down the source of each file in
  `src/client/public/sounds/README.md`.
- Files (Opus in `.webm` plus `.mp3` fallback for Safari, each under
  30 KB, loudness matched, -1 dBTP peak): `first-blood`, `headshot`,
  `double-kill`, `triple-kill`, `quad-kill`, `rampage` (5+), `killing-spree`
  (5 streak), `dominating` (10), `unstoppable` (15), `godlike` (20+),
  `humiliation` (knife kill), `last-man` (you're the last one alive on your
  team), and for Part A `level-up`, `final-level`, `winner`.

### C.2 Playing them

- New `src/client/src/announcer.ts`: loads the files with `fetch` after
  the game starts (not on the login page), decodes them once into Web Audio
  buffers, plays through one `GainNode`. The `AudioContext` is resumed on
  the first key or tap (the engine's audio already needs a gesture).
- One sound at a time: a new one with a higher priority stops the current
  one (priority: winner > godlike/unstoppable > multi-kills > first blood >
  humiliation > headshot), a lower one is dropped. No headshot sound when a
  multi-kill sound plays for the same kill.
- Triggers (from `recordKill` results and round events in `hud.ts`):
  - **First blood:** the first enemy kill of a round, by anyone. Everyone
    hears it, with a toast "<killer> drew first blood". In Deathmatch and
    Gun Game: the first kill of the map.
  - **Headshot:** your enemy kill was a headshot.
  - **Multi-kills:** the existing `multiKill.count` (2, 3, 4, 5+).
  - **Streaks:** your streak reaching 5, 10, 15, 20 (one sound per
    threshold, reset on death).
  - **Humiliation:** your kill with the knife, and also when you are knifed
    (a different, shorter sound) — **decision to review**.
  - **Last man standing:** from the `scores` event: you're alive and no
    teammate is, with at least one enemy alive. Once per round.
  - Part A: level up, final level, someone won.
- The toast text stays as it is; the sound is extra.

### C.3 Settings

In the `Sound` group of `SETTINGS`:

- `announcerVolume` (number, 0–100 %, default 70; 0 turns it off).
- `announcerHeadshots` (toggle, default on; headshots can be very
  frequent).
- `announcerOthers` (toggle "Hear other players' first blood", default
  on).

**Done when:** each trigger plays once at the right moment on desktop and
phone (iOS Safari too), volume 0 is silent, sounds don't stack, and nothing
is downloaded before the game starts.

---

## Part D — "Killed by" card

### D.1 Kill details from the server (cs16-client 0.0.10)

The victim's client doesn't know the killer's health, armour or distance.
New plugin `src/amxx/wc_killinfo.sma`:

- Registers a user message `WcKillInfo` (`engfunc(EngFunc_RegUserMsg,
"WcKillInfo", -1)` in `plugin_precache`; check it registers on Xash3D,
  otherwise use `register_message`-free fallback: a `TextMsg` with
  `HUD_PRINTCONSOLE` and a `#WcKillInfo` key that the bridge picks out).
- On `DeathMsg` with a player killer and victim (not self), sends to the
  victim: killer userid, killer health, killer armour, weapon, headshot,
  distance in metres (units / 39.37, rounded), and whether the killer was
  blind or the kill went through a wall (`trace_line` from the killer's
  eyes to the victim's eyes hits world) — **"through wall" is optional;
  drop it if the trace is unreliable**.
- In `cs16-client` (`html-hud.patch`): hook `WcKillInfo` and call
  `hudEvent("killinfo", {...})`, documented in `web_bridge.h`. Same release
  as A.4's `WcMode`. Bump to 0.0.10.

**Done when:** the event arrives in the page for every player kill, with
right values (check HP against the killer's HUD in a second browser).

### D.2 Head-to-head this map

- `stats.ts`: keep per-pair counts (`duels: Map<string, Map<string,
number>>` of kills of A on B), renamed with the rest on `rename`, cleared
  on `reset`. Add `duel(a, b): { aKills, bKills }` and tests in the
  existing stats tests.

### D.3 Head-to-head all time

- `statsfollow.go`: count enemy kills per (killer, victim) name pair, with
  the same rules as the totals (bots only if `includeBots`), in a new
  `duels (killer TEXT, victim TEXT, kills INTEGER, PRIMARY KEY (killer,
victim))` table, in the same transaction as the totals.
- `GET /duel?a=<name>&b=<name>` returns `{aKills, bKills}`; cached and rate
  limited like `/leaderboard`; names up to `statsNameMax`.
- Only from when this ships: old logs were deleted, so there's no history.

**Done when:** Go tests for the pair counting, renames (a rename starts a
new pair, like the totals) and the endpoint.

### D.4 The card

- When the local player dies to another player: a card at the lower centre
  (above the money, out of the way of the kill feed), for 6 s or until
  respawn / round start, whichever first. It doesn't block input.
- Contents: killer's name in team colour, weapon icon and name,
  "HEADSHOT" tag, "87 HP · 100 armour" (from D.1), distance, "This map:
  you 2 – 5 Walter", "All time: 14 – 22" (from D.3, fetched once per
  killer per map and cached), and the killer's current streak if 3+
  ("Walter is on a 6 kill streak").
- Killed by world, fall, bomb or yourself: a short card ("You fell to your
  death", "Killed by the bomb") without the duel lines. Team kill: "Killed
  by teammate <name>".
- Setting `HUD` group: `killerCard` toggle, default on.
- Without the 0.0.10 bridge, the card shows what the `kill` event has
  (no HP / distance).

**Done when:** checked on desktop and phone with each kind of death; the card
never covers the crosshair; works while spectating after death.

---

## Part E — Claimed names

Today anyone can join as "Walter" and add to or spoil Walter's leaderboard
row. A claim ties a name to a secret that only the claimant's browsers
have.

### E.1 Design (decisions to review)

- **No accounts, no email.** Claiming a name gives the browser a device
  token (in an `HttpOnly`, `SameSite=Strict`, 1-year cookie `wc_player`;
  `Secure` when served over HTTPS) and shows a **recovery code** once
  (e.g. `KJ7Q-M2XP-9WRT-4HCD`, 80 bits), which signs in other browsers or a
  cleared one. Only SHA-256 hashes of the token and the code are stored.
- One name per device. A name can have several devices.
- **Name matching is case- and space-insensitive** (lowercase, trim,
  collapse spaces, strip the engine's colour codes `^0`–`^9`), so "walter"
  and "Walter " can't impersonate "Walter". The claim keeps the original
  spelling for display.
- **Claiming an existing leaderboard row** is allowed for whoever claims
  first (there's no way to prove who played it). The admin can release a
  claim (E.5).
- Unclaimed names work exactly as today.

### E.2 Storage and API (Go)

- New tables in `leaderboard.db` (`statsdb.go`): `claims (name_key TEXT
PRIMARY KEY, name TEXT, code_hash TEXT, created INTEGER)` and `devices
(token_hash TEXT PRIMARY KEY, name_key TEXT, created INTEGER, last_seen
INTEGER)`. If the database can't be opened, claims are off and the
  endpoints answer 404 (like `/leaderboard`).
- Endpoints (JSON, same-origin only, rate limited per address like the
  admin login; 5 wrong codes per address lock it out for 5 minutes):
  - `GET /names/me` → `{name}` or `{}` for this cookie.
  - `GET /names/status?name=` → `{claimed: bool, mine: bool}`.
  - `POST /names/claim {name}` → sets the cookie, returns `{code}`; 409 if
    taken, 400 for an invalid name (same characters as the engine allows,
    1–31 bytes).
  - `POST /names/signin {name, code}` → sets the cookie.
  - `POST /names/release` → forgets this device; with `{all: true}` and
    the code, releases the claim.
- New file `src/server/names.go` with tests: normalising, hashing, claim
  races (two claims at once: one wins), lockout, cookie flags.

### E.3 Knowing who is playing

- `websocketHandler` (`sfu.go`) reads the `wc_player` cookie on the game
  WebSocket (sent automatically, same origin) and stores the claimed
  `name_key` (or none) on the session, copied into `peerSlot.claim`.
- `statslog.go`: parse `"Name<uid><auth><>" connected, address
"A.B.C.D:port"`. **Check first** that Xash3D logs the SFU's made-up
  address there. The first byte is the slot; `peerSlot.owns(ip)` confirms
  it's the same connection. Keep `userid → claim` per log file in the
  tally.

### E.4 Enforcing the claim

- **Leaderboard:** a kill, death or round of a player using a claimed name
  counts only if that player's connection has the claim. Otherwise it's
  dropped (not added to the claimed row, not given its own row).
- **In game:** when the log follower sees a player enter or change name to
  a claimed name they don't own, it renames them through the console:
  `amx_nick #<userid> "<name> (guest)"` (cut to 31 bytes; if that's also
  claimed, `Player <userid>`), and sends them a chat line from the server
  ("That name is claimed. Sign in from Settings to use it."). The log
  follower runs every 2 s, so for up to 2 s the wrong name is visible;
  that's acceptable (the leaderboard already doesn't count it).
- **Before joining:** the login page checks `/names/status` when the name
  field changes and warns "This name is claimed by someone else" (or shows
  "✓ yours"), so most people never hit the rename.

### E.5 UI

- **F3 Settings → "Your name"** section (next to the invite link): claim
  the current name, show the recovery code once with a copy button and a
  "I saved it" confirmation, sign in with name + code, release this device,
  release the name.
- **Leaderboard:** a small ✓ next to claimed names (`/leaderboard` gets a
  `claimed` field).
- **F4 admin → Players:** a "Claimed names" list with Release, through a new
  admin action `release_claim {name}` (in `adminActions` and
  `actions.ts`).
- README: what a claim protects (the leaderboard row and the in-game name
  on this server) and what it doesn't (it's not an account; anyone with
  the recovery code can use the name; behind a reverse proxy without HTTPS
  the cookie crosses the network in the clear).

**Done when:** in two browsers: B can't score as A's claimed name and gets
renamed, A's other browser signs in with the code, the admin can release,
the leaderboard marks claimed names, and all of it survives a server
restart (volume on `DATA_DIR`).

---

## Progress

Nothing started.

## Open questions

- A.0: ReGameDLL or AMXX only (decided by the spike).
- A.5: separate leaderboards per mode, or one?
- B.3: final map cycle, and whether fun maps should be in the cycle at all
  or only in the Map tab / vote.
- C.2: should being knifed play a sound?
- E.1: one name per device OK? Is "first to claim gets the existing row"
  OK, or should claiming an existing row with kills need the admin?
