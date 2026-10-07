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

### Summary / remaining manual checks

Every step is implemented (A.4 and D.1 only on the server / page side, see
below); the wrap-up at the end of this section has the final regression
run. Left for the user:

- **cs16-client 0.0.10 (blocked here).** The bridge patches (0.0.3–0.0.9,
  `html-hud.patch`, BUILD-NOTES.md) are only in the user's local
  webxash3d-fwgs checkout, so the two new hooks couldn't be built: A.4's
  `WcMode` → `mode` (Gun Game / Deathmatch on the HTML HUD) and D.1's
  `WcKillInfo` → `killinfo` (killer HP / armour / distance, wall / blind
  tags on the "Killed by" card). Code for both, with the `web_bridge.h`
  doc and post-build checks:
  `plans/new-features-1006-tools/cs16-client-0.0.10-bridge-sketch.cpp`.
  Merge it, bump to 0.0.10, rebuild, then check A.4's and D.1's "done
  when" in a browser (the page turns both on from 0.0.10 by itself).
- **Map mirror (B.3).** The Dockerfile `maps` stage downloads the four fun
  maps from GameBanana; upload them to the user's blob storage and switch
  the four `*_url` build arguments (the `.bsp` sha256 stays the same).
- **Phone and real-browser checks, per part:** A (Gun Game / Deathmatch
  HUD, F4 Match tab, guns menu on a phone; the leaderboard GG column on a
  real phone), B (each fun map downloaded and played in a fresh browser,
  desktop and phone, watching the console for missing textures), C (the
  announcer on a phone and iOS, including the first-touch audio unlock;
  settings panel on a phone), D (the "Killed by" card on a phone with
  touch controls around it, and in portrait next to the chat; a fall, an
  own HE grenade, the bomb and a team kill, which the headless tool can't
  produce), E (the "Your name" section on a phone; two real browsers and a
  real HTTPS proxy for the `Secure` cookie).
- **Listen to the sounds (C.1):** the 16 announcer clips in
  `src/client/public/sounds` were made with Piper TTS and only checked by
  Whisper (the words) and loudness measurements (no audio out here);
  listen to them once and adjust the texts / chain in
  `plans/new-features-1006-tools/sounds/` if needed.
- Two small display bugs found earlier were fixed in the wrap-up rerun
  (see the Wrap-up entry): the F4 "Admin password" field staying visible
  after logging in, and the "Killed by" card under the engine's spectator
  label.
- Open questions at the end of the plan (map cycle, fun maps in the
  cycle, the knifed sound) are still the user's to decide.

### B.1 Pick and check the map files — done

Downloaded from GameBanana (the main CS 1.6 map archive; the archives'
MD5s match what GameBanana's API lists), unpacked in a container, and
checked by a small BSP/WAD parser (worldspawn `wad` and `skyname`, entity
file references, embedded vs external textures) against the game zip
(`gamezip_8308.zip`, sha256 `2cf2f9da…02bb0`) and the HLDS 8308 build the
server uses. Nothing from the downloads was run. Chosen files are kept
outside the repo for B.3 (see the step report for the path).

| Map           | Source                                                                                                                                      | `.bsp` size | `.bsp` sha256                                                                     | Author / license                                                                                                                                                             | Needs besides the `.bsp`                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fy_iceworld` | [gamebanana.com/mods/86290](https://gamebanana.com/mods/86290) "fy_iceworld without de_vegas.wad" (`fy_iceworld_2.7z`, dl 302949)           | 208,752     | `0fa8cc32a19c94b65a4f303fcd483ddff09a334d3e7275984ee4369957d8c769`                | Original by DARK DRAGONS CLAN (\|-DD-\| / "Fantasy"); this recompile by Anakin94 embeds the one texture that needed `de_vegas.wad` (`lv_marble`). Freeware, no license file. | Nothing. Other textures are in `cs_office.wad`, `cs_assault.wad`, `halflife.wad` (game zip). Sky `snow` in zip.                                                                                                                                                                                                                                                                                 |
| `aim_map`     | [gamebanana.com/mods/82314](https://gamebanana.com/mods/82314) (`aim_map_3.zip`, dl 320784)                                                 | 348,092     | `bf0a879d11c2b73a0b58b7832ea8f91d7979ba0b90071c14d40a712a2e1a5b3c`                | Filip "tntman" Orrby and Johan "w00d" Bjarnle (2002, aimmap.net). Freeware, no license file.                                                                                 | Nothing. All 18 textures external, all found in zip wads (`halflife`, `liquids`, `xeno`, `cstrike`, `cs_dust`, `de_aztec`). Sky `des` in zip (same as de_dust2).                                                                                                                                                                                                                                |
| `awp_india`   | [gamebanana.com/mods/87358](https://gamebanana.com/mods/87358) (`003_awp_india.rar` dl 320585 and `awp_india.7z` dl 1200010: identical bsp) | 1,204,068   | `c3d2311d633ab68aaf3708c49778e923f5a43e2dc2631abf5d602c56f2f2156f`                | Johan "Bobo" Fasting. Freeware, no license file.                                                                                                                             | Nothing. All 18 textures embedded (`india.wad`/`awp_india.wad` are listed but unused). Sky `trainyard` in zip (same as de_train).                                                                                                                                                                                                                                                               |
| `fy_pool_day` | [gamebanana.com/mods/86562](https://gamebanana.com/mods/86562) (`fy_pool_day_60bca.rar`, dl 616976)                                         | 853,064     | `fb22ba78a20d762a7114bdd56d62ec01794695ac48c6777f1bbd676ab769d208`                | Squall (steveas@goshen.edu). Freeware; the uploader's `.res` says it is "for redistribution".                                                                                | Textures all embedded, sky `desert` in zip (valve, same as de_nuke). **`sound/ambience/sprayer.wav`** (38,648 B, sha256 `fc623c75ae7436ce435c7c51b8b73f7f0fcd8a9c391c7d05bafbf41c29cb2d6f`, 8-bit mono 22 kHz PCM) for one `ambient_generic` (the "pee" button in the toilets). Not in the zip (the zip's `player/sprayer.wav` is a different file). Cosmetic: without it that sound is silent. |
| `cs_assault`  | Stock: in the game zip (`cstrike/maps/cs_assault.bsp`) and in the HLDS 8308 build                                                           | 1,041,700   | `2457e165671e3830ec91471dea6f471440747cbb4b1fa1b6a85cddc30adb3648` (same in both) | Valve (stock).                                                                                                                                                               | Nothing to add: `cs_assault.wad`, `halflife.wad`, `decals.wad`, sky `city1`, `models/hostage.mdl` all in zip. Nothing to do in B.3 except the map cycle.                                                                                                                                                                                                                                        |

Total to add to the image: 2,613,976 B of `.bsp` (about 2.5 MB), plus
38,648 B if `sprayer.wav` is shipped.

Notes and decisions:

- **fy_iceworld:** the original upload
  ([mods/86288](https://gamebanana.com/mods/86288), bsp 124,792 B, sha256
  `d36fe2c8…a69481`) needs `de_vegas.wad` (2,263,636 B, sha256
  `54eab282…cac676`) for one texture. Picked the `de_vegas`-free recompile
  instead (about as many downloads on GameBanana; same entities and leaf
  count; rebuilt from a .map source, not byte-identical), so no extra file
  is needed. Both the original and the wad are kept in the scratchpad
  (`alt/`) in case B.2 is done anyway and the original is preferred.
- **Missing wads are harmless:** Xash3D FWGS only adds a wad from the
  worldspawn list when `FS_FileExists` finds it (`engine/common/mod_bmodel.c`),
  so the `\sierra\...` paths and unused wads in these maps don't stop loading.
- **Sky names** are lower case in the bsps (`des`, `trainyard`) while the
  files are `Des*.tga` / `TrainYard*.tga`; stock de_dust2 and de_train do the
  same, so it already works.
- **B.2 is optional.** The only extra file is `fy_pool_day`'s
  `sprayer.wav`, which is cosmetic. Recommendation: skip B.2 and ship only
  the four `.bsp` files. If B.2 is done, serve `sound/ambience/sprayer.wav`
  for `fy_pool_day` (overview files in its `.res` aren't in the download and
  aren't needed).
- **For later steps:** `fy_pool_day` has a `func_bomb_target` (A.2 removes
  objectives; check YaPB doesn't try to plant there in classic mode with no
  C4 carrier). `awp_india` has `game_player_equip` + `player_weaponstrip`
  (gives everyone an AWP at spawn), which may fight with `wc_weaponmode` and
  Gun Game. `aim_map`, `fy_iceworld` and `fy_pool_day` have
  `armoury_entity` weapons on the ground (blocked by the pickup hooks in the
  knife/pistols modes, as intended). The `awp_india.7z` also had PODBot
  waypoints and the iceworld 7z a `.nav`: not used (YaPB makes its own
  graph).
- Not checked: a load on a real engine with `developer 2` (no local client
  here); B.3 should watch the server console on the first load of each map.

### B.2 Serve extra map files — skipped

B.1 found no required extra files: the only one is `sound/ambience/sprayer.wav`
(cosmetic, one button sound in fy_pool_day), which is just silent without it.
The plan makes B.2 conditional on required files, so `/maps/` stays bsp-only.

### B.3 Put the maps in the image — done

What was done:

- **Dockerfile `maps` stage** (new, runs on the build platform): downloads
  each map with a `<map>_url` / `<map>_sha256` build argument
  (`fy_iceworld`, `aim_map`, `awp_india`, `fy_pool_day`). A URL can be a
  bare `.bsp` (detected by the BSP v30 header) or an archive (zip, 7z, rar,
  extracted with `bsdtar`), and the stage takes exactly one `<map>.bsp` out
  of it; the **`.bsp`** sha256 is checked either way, so switching to a
  mirror needs no hash change. Defaults are the GameBanana files
  (`https://files.gamebanana.com/mods/<file>`, the same archives B.1
  checked). **Mirroring to the user's blob storage couldn't be done from
  here: upload the four `.bsp` files (or the archives) and pass/replace the
  `*_url` defaults.** The `hlds` stage copies them to `cstrike/maps`.
  Tested: bare `.bsp` via `file://`, wrong hash, archive without the map and
  a failed download all fail or pass as they should.
- **`configs/cstrike/mapcycle.txt`**: the cycle as written above (default
  from the brief):
  `de_dust2 fy_iceworld cs_assault aim_map de_inferno awp_india fy_pool_day de_nuke`.
- **`maps.ini`** (AMXX, used by the players' end-of-map vote and
  `amx_mapmenu`): the four maps are appended in the `hlds` stage. The Map
  tab needs nothing: it lists `/maps/index.json`, which now has them.
- **Per-map settings**: `configs/cstrike/addons/amxmodx/configs/maps/prefix_fy.cfg`,
  `prefix_aim.cfg`, `prefix_awp.cfg` (AMXX 1.10 runs `maps/prefix_<x>.cfg`
  and `maps/<map>.cfg`). Prefix files instead of per-map ones, so any
  `fy_`/`aim_`/`awp_` map dropped into a volume later gets them too. They
  set `mp_startmoney 16000`, `mp_freezetime 0`, `mp_roundtime 2`,
  `mp_buytime 0.25`, then `sv_restart 1`. Found while testing:
  - AMXX runs them **about 6 s after the map loads**, so players/bots who
    joined first got the old money: hence the `sv_restart 1`.
  - **`server.cfg` only runs at startup**, so these values leaked into the
    next classic map. Fix: the prefix configs also set the engine's
    `mapchangecfgfile leave_funmap.cfg` (Xash3D runs it at every map spawn,
    `sv_init.c`); `configs/cstrike/leave_funmap.cfg` puts back the stock
    values (800 / 6 / 5 / 1.5, checked on the base image) and clears
    `mapchangecfgfile`. Classic → classic map changes are unchanged (Match
    tab values kept); the map after a fun map gets the stock values.
- **Match tab note** (`src/client/src/admin/match.ts`, `presets.ts`,
  `map.ts`): always says "fy_, aim_ and awp_ maps set Start money $16000,
  Freeze time 0 s, Round time 2 min, Buy time 0.25 min when they load, over
  what is set here. The map after one goes back to …", prefixed with "The
  next map, X, has its own settings." when `amx_nextmap` (admin API only)
  is a fun map. The values/prefixes live in `presets.ts`
  (`FUN_MAP_PREFIXES`, `FUN_MAP_VALUES`, `AFTER_FUN_MAP_VALUES`, checked
  like the presets) and must stay in step with the cfg files. `map.ts`
  exports `getNextMap`, `onNextMapChange`, `refreshNextMap`; the Match
  tab's `show` re-reads the next map.
- **YaPB graphs**: the plan's "YaPB saves the analysis in
  `addons/yapb/data`" was wrong for graphs: `data/graph` wasn't writable
  ("Unable to open Graph file for writing"), so it re-analysed on every
  load, and YaPB also tries to download a graph from its database
  (`http://yapb.jeefo.net/graph/<map>.graph`) first, which failed for the
  same reason. Now the `graph` folder (not its files, to avoid copying 2 MB
  of stock graphs into another layer) is owned by `xashds`. Graphs shipped
  in `configs/cstrike/addons/yapb/data/graph/`: `aim_map`, `awp_india`,
  `fy_pool_day` from YaPB's database (sha256 `c326e954…`, `87e2f525…`,
  `a9764ca9…`); `fy_iceworld` from YaPB's own analysis (`fcee758a…`),
  because the database graph is for the original bsp and YaPB warned
  "Graph data is probably not for this map". Analysis takes 5–20 s per map
  here, so maps without a graph are cheap anyway.

Verified (image `local/cs16-web-server`, `--platform linux/386`):

- Full image builds; `npm run build` and `tsc --noEmit` pass; Prettier
  (es5 trailing commas like the rest of the repo) on the changed TS files.
- Every map loads from the console (`changelevel`), no engine errors; with
  `--network none` and `BOT_QUOTA=10`, 3 minutes per map: fy_iceworld 42
  kills / 7 rounds, aim_map 56 / 9, awp_india 28 / 5, fy_pool_day 40 / 7,
  **every round ended by elimination, none by time** (bots find each other;
  on fy_pool_day bots also planted and defused the bomb). cs_assault 13
  kills / 4 rounds (1 by time, normal for a hostage map).
- Settings: 16000 / 2 min on each fun map; `leave_funmap.cfg` ran on
  cs_assault after fy_pool_day and gave 800 / 5 min; de_dust2 after it kept
  800 / 5.
- `/maps/index.json` lists the four maps with the B.1 sizes and sha256s and
  `/maps/<map>.bsp` serves the same bytes.
- **Image size:** `/xashds` grew by 2,688,182 B (2,613,976 B of `.bsp`,
  66,863 B of graphs, configs): about +2.6 MB uncompressed, about +1 MB in
  compressed content size (513 → 514 MB as `docker images` rounds it).

Left / manual:

- A fresh browser downloading each map with progress and joining, and
  playing on them with real clients (desktop and phone): not done here (no
  browser). Watch the client console on first load of each map for missing
  textures/sky (B.1 found none).
- Switch the four `*_url` defaults to the user's mirror.
- awp_india's `game_player_equip` gives AWPs and `player_weaponstrip`
  strips; not tried with `wc_weaponmode` 1/2 (A.x steps).
- Map cycle choice is still an open question for the user.

### A.0 Spike: ReGameDLL or AMXX only — done: **ReGameDLL (option 1)**

**Decision: option 1, ReGameDLL_CS 5.30.0.814** (latest release,
2026-05-18). A.1–A.3 use its cvars (`mp_forcerespawn`,
`mp_respawn_immunitytime`, `mp_round_infinite`, `mp_item_staytime`,
`mp_buy_anywhere`, `mp_refill_bpammo_weapons`, …) and the plugin only does
what they don't (glow, ending protection on fire, random spawns, guns menu).

What was done:

- **Dockerfile `hlds` stage:** `ARG regamedll_version=5.30.0.814`,
  `ARG regamedll_sha256=457f5c96…bc6fd18` (of
  `regamedll-bin-5.30.0.814.zip` from github.com/rehlds/ReGameDLL_CS
  releases), downloaded and checked with the other addons; only
  `bin/linux32/cstrike/dlls/cs.so` is unzipped over `cstrike/dlls/cs.so`.
  `liblist.gam` / Metamod's `gamedll_linux` unchanged.
- **Not shipped from the zip:** `game.cfg` and `game_init.cfg` (ReGameDLL's
  cvar file: tested, ReGameDLL runs `exec game.cfg` **on every map change**,
  before AMXX's configs; the shipped one sets e.g. `mp_buytime 0.25`,
  `mp_timelimit 20`, so it would undo the Match tab on every map), and its
  `delta.lst` (wider origin/body/effects fields than HLDS's; HLDS 8308's is
  kept, so the wire format is unchanged for the browser client).
  **Note for A.1–A.3:** a `cstrike/game.cfg` of our own is a hook that runs
  at every map start (seen before `amxx.cfg`; order against
  `mapchangecfgfile` not checked), e.g. to put `mp_forcerespawn 0` /
  `mp_round_infinite 0` back when the mode resets; the plugin's own reset
  on map change works too.
- README: features line and plugins table (ReGameDLL row).

Verified (image built with `docker build --platform linux/386`, tagged
`local/cs16-web-server:latest`; `--network none`, `BOT_QUOTA=10`):

- Starts on Xash3D FWGS: `ReGameDLL version: 5.30.0.814-dev`; YaPB says
  `Flags: BotVoice, ReGameDLL, Metamod`. `meta list`: AMX Mod X, YaPB,
  Ham Sandwich, CSX, CStrike, FakeMeta, Fun all RUN. `amxx plugins`: 22
  running incl. `wc_weaponmode` and `wc_statslog`; `amxx modules`: 5
  correct. Console warnings are the same as with the stock DLL (the AMXX
  gamedata "CRC mismatch"/"svs/sv not available" lines appear with both).
- Stock cvar defaults unchanged: 27 `mp_*`/`sv_alltalk` cvars read on both
  images, identical (only `mp_fraglimit` is new).
- **20-minute bot game, side by side with the stock image** (12 min
  de_dust2, `changelevel cs_assault`, 8 min): no crash on either. The lines
  `statslog.go` parses (checked with its regexes, ported to a script):
  ReGameDLL 114 kills / 54 `wc_headshot` / 1 suicide / 20 joined team / 20
  entered / 10 disconnected / 18 Round_End / 17 Round_Start; stock 99 / 44
  / 0 / 20 / 20 / 10 / 16 / 15. Every line shape (players and values
  masked) is the same in both, as are the `triggered` names
  (`Spawned_With_The_Bomb`, `Planted_The_Bomb`, `CTs_Win`,
  `Game_Commencing`, …) and weapon names. The only shape difference was
  chance: stock had one `committed suicide with "worldspawn" (world)`
  (fall damage), ReGameDLL one `committed suicide with "grenade"`.
  **Pre-existing, not ReGameDLL:** that `(world)` suffix doesn't match
  `logSuicideRe` (anchored with `$`), so fall-damage suicides aren't
  counted today (either DLL). Left as is (out of scope).
- `mp_round_infinite 1` + `mp_forcerespawn 1` + `mp_respawn_immunitytime 2` +
  `mp_item_staytime 5`, `sv_restart 1` on de_dust2: 7 minutes with no
  `Round_End` (also past the 5-min round time), 66 kills in the first 4
  min, the same bots dying again within 5–20 s (respawned). Kept on over
  `changelevel cs_assault` (hostage map): kills, no round end.
- `wc_weaponmode 1` with respawns on: 58 kills in 2.5 min, all `knife`, so
  AMXX's `Ham_Spawn` post hook fires on ReGameDLL's respawns.
- Full image: `/status.json` and `/` answer.

Left / not done:

- Two browser players (no browser here): someone should play a few rounds
  on the new image from desktop and phone (movement, weapons, hostages,
  bomb), since the client's prediction now talks to a different game DLL.
- The plan's per-mode details (bots and objectives with
  `mp_round_infinite`, spawn protection effects) are for A.2/A.3.
- Image size: `cs.so` is 2,985,944 B instead of 11,698,573 B (smaller).

### A.1 Mode cvar and Match tab — done

What was done:

- **`src/amxx/wc_gamemode.sma`** (new, in the `plugins.ini` line of the
  `hlds` stage, after `wc_weaponmode.amxx`): `wc_gamemode 0|1|2` (classic /
  Gun Game / Deathmatch), `FCVAR_SERVER`, set back to 0 in `plugin_init`
  (every map), polled once a second. On a change: sets the mode's game
  cvars (table `MODE_CVARS`), sets `wc_weaponmode 0` for modes 1/2,
  `log_amx` + chat "[Server] Game mode: Gun Game." and `sv_restart 1`.
  `wc_gamemode_status` (server command) prints the mode and its cvars.
  The modes themselves are skeletons: both currently set the same ReGameDLL
  cvars, `mp_round_infinite 1`, `mp_forcerespawn 1`,
  `mp_respawn_immunitytime 2`, `mp_item_staytime 5`; A.2/A.3 add their
  rules and can give each mode its own values in `MODE_CVARS` (one row per
  cvar: classic, Gun Game, Deathmatch value).
- **How mode cvars get back to classic (decision):** the plugin does it, not
  a `cstrike/game.cfg`. Classic values are ReGameDLL's defaults (read on the
  image: 0 / 0 / 0 / 300). They are written (a) when the poll sees the mode
  go to 0 and (b) in `plugin_init` when `wc_gamemode` was still non-zero
  from the previous map (the cvar survives the map change, so that is "the
  last map ran a mode"). A map that didn't run a mode doesn't touch them,
  so values from `server.cfg` stay. Why not `game.cfg`: it would run on
  every map (also after classic maps) and the list of cvars would live in
  two places. Ordering vs `mapchangecfgfile` / `leave_funmap.cfg` doesn't
  matter: they set disjoint cvars (`leave_funmap.cfg` only touches money,
  freeze, round and buy time). `plugin_init` runs at ServerActivate, before
  the first frame of the map, so the new map never runs with the old
  mode's cvars. **A.2/A.3: put every game cvar a mode changes into
  `MODE_CVARS`** so it's reset the same way.
- **Mutual exclusion:** `wc_weaponmode.sma` reads `wc_gamemode` (pointer
  taken in `plugin_cfg`, so plugin order doesn't matter); while it isn't 0,
  a non-zero `wc_weaponmode` is set back to 0 with `log_amx` and chat
  "[Server] Knife only and pistols only are off during Gun Game and
  Deathmatch.", and the weapon mode stays off.
- **Admin API / client:** `wc_gamemode: {0, 2, 0}` in `adminCvars`
  (`admin_actions.go`) and `cvars.ts` (choice "classic / gun game /
  deathmatch", `mapReset: 0`). Match tab: new field "Game mode"; the preset
  group label is now "Presets" (it was "Game mode"); presets **Gun Game**
  (friendly fire off, $800, freeze 0, buy time 0.25, weapon mode off,
  `wc_gamemode 1`) and **Deathmatch** (same with $16000, `wc_gamemode 2`),
  and `wc_gamemode: 0` in Casual / Competitive / Warmup. Knife only /
  Pistols only don't set it (so they are refused during a mode, as the plan
  says). The tab knows the mode from what it sent, from `/status.json` when
  it's shown (ignored within 5 s of sending, the status may be older), and
  resets it to 0 on the `reset` event. While a mode is on, a note says
  "Gun Game is on. Knife only and pistols only don't work in it: pick
  Casual, Competitive or Warmup (or Game mode Classic) first.", and
  sending a weapon mode (preset or field) is refused in `sendCvars` with
  "Not sent: Knife only doesn't work during Gun Game. ..." in the status
  line. A preset's own `sv_restart 1` and the plugin's (up to 1 s later)
  often merge into one restart, but not always: sending `wc_gamemode N` and
  `sv_restart 1` together 3 times gave `Restart_Round_(1_second)` once,
  once and twice (a second apart). Harmless (the round just restarts
  again); the Match tab's restart check is satisfied by the first.
- **Lobby:** `status.go` reads `wc_gamemode` from A2S_RULES into
  `gameMode` (1 or 2; omitted for 0 / unknown / out of range);
  `lobby.ts` parses it (`GAME_MODE_NAMES`, `gameModeName`) and the summary
  reads "de_dust2 · Gun Game · 5/16 players".
- README: features line, `/status.json` paragraph, plugins table
  (`wc_gamemode.amxx` row, note on `wc_weaponmode.amxx`).

Files: `src/amxx/wc_gamemode.sma` (new), `src/amxx/wc_weaponmode.sma`,
`Dockerfile`, `src/server/status.go`, `status_test.go`,
`admin_actions.go`, `admin_actions_test.go`, `src/client/src/lobby.ts`,
`src/client/src/admin/cvars.ts`, `presets.ts`, `match.ts`, `README.md`.

Verified:

- `docker build --target amxx-plugins`: both plugins compile, no warnings.
- Go: `gofmt -l` empty, `go vet` and `go test ./src/server/...` pass, run in
  an image built from the Dockerfile's own `go` stage
  (`docker build --platform linux/386 --target go -t local/cs16-go-test .`,
  then the scratchpad `a1/gotest.sh`, which mounts `src/server`; the
  repo's `gotest.sh` has a macOS path). New tests: `TestApplyRulesGameMode`
  (0/1/2, out of range, fractions, text, missing), game mode in
  `TestEngineQueryStatus` and the `TestStatusHandler` JSON, `wc_gamemode`
  accepted 0–2 and refused 3 / -1 / 0.5 in the admin action tests.
- `npm run build`, `tsc --noEmit`, Prettier (repo style, es5 commas) pass. A
  `tsx` check of `parseLobbyStatus`/`summaryText` (modes 0–2, bad values)
  and of the cvar/presets (parse, range text, `actionCommands`,
  `checkPresets`, each preset's game/weapon mode).
- Full image (`--platform linux/386`, `local/cs16-web-server:latest`) with
  6 bots, `--network none`, console through a fifo (scratchpad
  `a1/modetest.sh`): plugin loads ("Web game mode ... running"); knife mode
  on, then `wc_gamemode 1` → weapon mode set to 0, mode cvars 1/1/2/5,
  `Restart_Round_(1_second)` in the game log, `/status.json` has
  `"gameMode":1`; `wc_weaponmode 2` during Gun Game → refused, back to 0;
  `wc_gamemode 2` → `"gameMode":2`, one restart; 60 s of it: bots died and
  respawned (same bots killed twice), no `Round_End`; `changelevel` →
  `wc_gamemode 0`, cvars back to 0/0/0/300, no `gameMode` in the status;
  `wc_gamemode 1` then `0` → classic values back, two restarts, and knife
  mode works again. The A2S_RULES reply isn't cut off with the new cvar.

Left / manual:

- In a browser (none here): the Match tab's Gun Game / Deathmatch buttons,
  the "not sent" message and note, the chat line, and the login page line,
  on desktop and phone.
- When the weapon mode plugin polls between the admin's `wc_gamemode 1`
  and the game mode plugin's poll, players see "Knife only and pistols only
  are off during ..." as well as "Game mode: Gun Game." (harmless).
- In Deathmatch until A.2, buying works only during the first 15 s after
  the restart (`mp_buytime 0.25`; ReGameDLL counts it from the round start,
  not per respawn), so respawned players have a pistol: A.2's guns menu
  fixes that. Bots and objectives under `mp_round_infinite` are A.2's.
- `cvars.ts`'s header comment still says the server runs the stock game
  DLL (from before A.0); its clamps weren't rechecked against ReGameDLL.

### A.2 Deathmatch — done (browser/phone checks left)

What was done:

- **`src/amxx/wc_weapons.inc`** (new, shared include for A.3): stocks
  `WcStripWeapon` / `WcStripWeapons` (moved from `wc_weaponmode.sma`),
  `WcGiveWeapon` (full magazine + `WC_MAX_BPAMMO`), bit masks
  `WC_PISTOLS` / `WC_PRIMARIES` / `WC_GRENADES`, the buy alias table
  `WC_BUY_ALIASES` (+ `WC_ITEM_*`) and `WC_AUTOBUY_COMMANDS`.
  `wc_weaponmode.sma` now uses it (same behaviour; knife and pistols modes
  re-checked with bots). Quoted `#include "wc_weapons.inc"` works in the
  `amxx-plugins` stage (it compiles `*.sma` only).
- **`wc_gamemode.sma` `MODE_CVARS`** (columns classic / Gun Game /
  Deathmatch; strings now up to 23 chars): `mp_round_infinite 0/1/1`,
  `mp_forcerespawn 0/1/1`, `mp_respawn_immunitytime 0/2/2`,
  `mp_respawn_immunity_force_unset 1/2/2` (2 = protection ends only on
  attack; ReGameDLL's default 1 also ends it on moving),
  `mp_item_staytime 300/5/5`, `mp_give_player_c4 1/0/0`,
  `mp_free_armor 0/0/2`, `mp_t_default_grenades` and
  `mp_ct_default_grenades ""/""/"hegrenade flash flash"` (gives 2
  flashbangs, checked), `mp_fraglimit 0/0/0`,
  `yb_ignore_objectives 0/1/1`, `yb_botbuy 1/1/0`. Gun Game got the shared rows (respawn,
  protection, no C4, bots ignore objectives); its equipment rows are
  classic values: **A.3 decides** them.
- **Both modes** (so A.3 gets them for free): random spawns (any
  `info_player_start` / `info_player_deathmatch`; first a spot with no
  enemy within 300 units and none with line of sight from its eyes, else
  one with no enemy within 300, else the free one farthest from enemies;
  never a spot someone stands on — hull trace; with no free spot the game's
  spot is kept), team-coloured glow (T red, CT blue) for the protection
  time, ended early on a new attack press (`FM_CmdStart`, the same test as
  ReGameDLL's `force_unset 2`), objectives off.
- **Objectives (decision):** nothing is removed. No C4
  (`mp_give_player_c4 0`), bots ignore objectives, bomb sites stay but do nothing.
  **Hostages are hidden, not removed:** ReGameDLL's `CHostageManager`
  keeps pointers to them (`RestartRound`, `OnEvent` on every shot), so
  removing one would be a use-after-free. The plugin puts them in the
  state the game uses for a rescued hostage (`EF_NODRAW`, not solid, no
  damage, `DEAD_DEAD`, size 0, no think), re-done each poll since a round
  restart brings them back (`CHostage::RePosition`); that is also how they
  come back when the mode goes to classic. No map reload needed.
- **awp_india (decision):** its `multi_manager` named `game_playerspawn`
  (fired by the game on every spawn) strips players and gives AWP + knife +
  armour 1 s later, which would undo the guns menu. In a mode the plugin
  renames it (targetname `wc_off_game_playerspawn`), and back in classic.
  So awp_india in Deathmatch is a normal guns-menu DM; classic is the AWP
  map as before (checked both).
- **Guns menu** (Deathmatch, humans): 0.1 s after each spawn, AMXX
  `menu_create` menus: "New weapons / Same as last time / Same every time
  (say guns to change)" (straight to the primary list if nothing was
  picked yet) → primary (16: AK-47, M4A1, AWP, FAMAS, Galil, AUG, SG 552,
  MP5, P90, UMP45, MAC-10, TMP, M3, XM1014, Scout, M249; 3 pages) →
  pistol (6). A pick is given right away only within 10 s of spawning,
  otherwise kept for the next spawn ("You get these weapons when you next
  spawn."), so the menu can't be used to refill ammo. Until a pick, the
  player has the team's default pistol, knife, armour and grenades.
  `guns` / `say guns` / `say /guns` (and `say_team`) open it and turn
  "same every time" off. Bots: random primary + pistol each spawn.
- **Buying off** in Deathmatch: all buy aliases, `vest`, `vesthelm`,
  `defuser`, `nvgs`, autobuy/rebuy are refused with a centre message;
  `buy` / `buyequip` (the B key) open the guns menu instead. Not done with
  `mp_buytime 0` (ReGameDLL: buying off) because `MODE_CVARS` would then
  overwrite the Match tab's buy time on the way back to classic. **YaPB
  bots' buy commands bypass AMXX's command hooks** (checked: with
  `yb_botbuy 1` in DM their money went down), hence `yb_botbuy 0`.
- **Frag limit:** `wc_dm_fraglimit` (default 0, not reset on map change)
  is copied to ReGameDLL's `mp_fraglimit` by the poll while in Deathmatch
  (`MODE_CVARS` puts 0 back). ReGameDLL then goes to intermission and the
  next map. Added to `adminCvars` (`{0, 500, 0}`, tests) and `cvars.ts`
  ("Deathmatch frag limit", 0–500 frags) and as a Match tab field.
- **Test commands:** `wc_dm_status` (each player: team, alive, hp,
  armour, glow, frags, flashbangs, money, position, weapons),
  `wc_dm_guns <userid> <primary 1-16> <pistol 1-6>` (the menu's pick code
  path), `wc_gamemode_status` also prints the frag limit, spawn point and
  spawn trigger counts and hostages (hidden).

Files: `src/amxx/wc_weapons.inc` (new), `src/amxx/wc_gamemode.sma`,
`src/amxx/wc_weaponmode.sma`, `src/server/admin_actions.go`,
`admin_actions_test.go`, `src/client/src/admin/cvars.ts`, `match.ts`,
`README.md`.

Verified (image `--platform linux/386`, `local/cs16-web-server:latest`,
`--network none`, 10 YaPB bots, console through a fifo; scripts in the
scratchpad `a2/`: `long.sh` + `c_long.txt`, `short.sh` + `c2.txt`,
`analyse.py`):

- `amxx-plugins` stage: 3 plugins compile, no warnings. Go: `gofmt`,
  `go vet`, tests pass (scratchpad `a1/gotest.sh`). `npm run build` and
  Prettier (es5 commas) pass.
- **10 min Deathmatch on de_dust2, then 10 min on cs_assault** (status
  every 30 s): no crash (container still running), no AMXX runtime errors.
  157 and 175 kills; top frags 25 / 29. **No `Round_End` while the mode
  ran** (the only ones: `Game_Commencing` at map start, and the round end
  right after switching back to classic, when the long-expired round time
  counts again). Every bot alive in a sample had a primary except ones
  sampled within 0.1 s of spawning (2 of 448). Armour 100 and 2
  flashbangs on spawn; glow on at spawn and off after 2 s. Random spawns:
  CTs spawned in the T base and vice versa (debug run: rank 3 spot found
  each time). cs_assault: 4 hostages hidden in DM, back (0 hidden) after
  `wc_gamemode 0`; no hostage events, no bomb plants. "Stuck" check (same
  spot ≥ 3 samples): two bots on cs_assault, both snipers (AWP / Scout)
  camping a roof (z 447–551) for 1.5–2.5 min, then moving on after dying:
  YaPB sniper camping, not stuck.
- awp_india: 1 spawn trigger found; in DM bots had random guns
  (48 kills, AWP 14 of them), back in classic they spawned with AWP +
  knife again.
- `wc_dm_guns` within 10 s of a spawn replaced the guns (AWP + Deagle),
  after 10 s kept them for the next spawn; bad index refused.
- `wc_dm_fraglimit 2` → map changed within a minute, `wc_gamemode` and the
  mode cvars back to classic on the new map.
- A.1's `modetest.sh` (mode switching, weapon mode refusal) passes.

Left / manual:

- **Browser and phone:** the guns menu itself (display, paging with 8/9,
  keys on a phone), B opening it, the refused-buy message, `say guns`,
  the glow as seen by others and ending when you shoot, two players
  spawning and not being spawn-killed. None of this could be driven here
  (no game client). The menu uses AMXX's standard `ShowMenu` like
  `amx_mapmenu`.
- **Spawn points:** de_dust2 and cs_assault only have spawn points in the
  two team bases, so "random" means either base. Spread-out DM spawns
  would need extra points (e.g. a CSDM-style spawn file): not done.
- The next map after a frag limit (or time limit) is AMXX's `amx_nextmap`;
  on a fresh server started with `+map de_dust2` it is `de_dust2` again
  (AMXX nextmap starts the cycle from its saved position), pre-existing.
- The Deathmatch preset still sets `mp_startmoney 16000` /
  `mp_buytime 0.25`; harmless (buying is off) and left as A.1 made it.
- No chat line when the frag limit is hit (ReGameDLL ends the map
  silently apart from the intermission).

### A.3 Gun Game — done (browser/phone checks left)

What was done (`src/amxx/wc_gamemode.sma`, version 1.2; uses
`wc_weapons.inc` for stripping and giving):

- **Ladder:** `wc_gg_ladder` (`;` list, names with or without `weapon_`;
  default the plan's 24 levels, max 32). Read when Gun Game starts and
  re-read by the poll when the cvar text changes (levels clamped to the new
  top, weapons re-given). Unknown names, `c4`, `flashbang`,
  `smokegrenade` are skipped with a `log_amx` line; nothing valid → the
  default ladder. The `wc_gg_*` cvars are kept over map changes (like
  `wc_dm_fraglimit`).
- **Rules** (DeathMsg event, `"knife"` / `"grenade"` / weapon name): a kill
  counts only with the killer's level weapon or the knife;
  `wc_gg_kills_per_level` (default 1) such kills → next level. **Knife
  kill (decision):** always a full level up for the killer (a steal, not
  one of the N kills) and victim down one (not below 1). Team kills: nothing.
  Suicide and deaths by the world (killer 0): nothing, or down one with
  `wc_gg_suicide_penalty 1`. A grenade thrown on the HE level that kills
  after the thrower moved on doesn't count. Level changes are logged
  (`log_amx "Gun Game: #uid up to level N (weapon)[, knife steal]"`) and
  shown to the player as a centre message.
- **Weapons:** 0.1 s after spawn and after each level change (not inside the
  kill: the killing weapon may still be in its attack), everything but the
  knife and the level weapon is stripped and the level weapon given with
  full ammo, then selected. **HE level:** `FM_SetModel` post on the thrown
  grenade (`classname grenade`, `w_hegrenade.mdl`; ReGameDLL sets owner and
  `dmgtime` before the model) → a new HE `dmgtime - now + 1 s` later.
- **`MODE_CVARS` Gun Game column (decisions):** `mp_free_armor 2` (kevlar +
  helmet), no default grenades, new rows
  `mp_t/ct_default_weapons_secondary ""` (classic/DM `glock18` / `usp`, so
  nobody gets a pistol to strip), `mp_refill_bpammo_weapons 3` (reserve
  refilled on reload, so a level never runs dry), `yb_botbuy 0`,
  `yb_pickup_best 0` (new row: YaPB 4.4's pickup logic ignores
  `yb_restricted_weapons`, checked in its source; this stops bots walking
  to weapons), `yb_restricted_weapons` = every YaPB alias (new row; the
  value column is now 192 chars). The restriction list is global, not per
  bot, so it is "everything" rather than "everything but my level"; YaPB
  only reads it for buying, so bots still use what the plugin gives (seen:
  kills with every ladder weapon). The poll re-applies it each second
  because `wc_weaponmode` clears it when it turns itself off.
- **Buying, pickups, drop off:** buy commands refused ("Gun Game: no
  buying."), `Ham_Touch` on `weaponbox` / `armoury_entity` /
  `weapon_shield` superseded, `drop` refused.
- **Win:** a counting kill on the last level (the knife kill on the default
  ladder; any ladder's last weapon or a knife kill otherwise). Chat
  "[Server] <name> won Gun Game! Next map: X." and centre "<name> won Gun
  Game!" (name with `%` removed and a leading `#` replaced: TextMsg is a
  printf format on the web client), game log
  `"Name<uid><auth><team>" triggered "wc_gg_win"` (real name, as a format
  argument; auth is `ID_BOT` for bots like `wc_headshot`, which
  `statslog.go` already accepts), everyone `FL_FROZEN` + god mode +
  `set_user_maxspeed 1` (also anyone respawning), no more level changes,
  then after 5 s `changelevel` to `amx_nextmap` (AMXX nextmap / the vote's
  pick; current map if invalid). The new map starts in classic (A.1's
  reset). An admin switching the mode during the 5 s cancels the change
  and unfreezes everyone (checked).
- **Late joiners:** `client_putinserver` during Gun Game → lowest level of
  the players in a team (`wc_gg_join_lowest`, default 1), else level 1.
- **HUD:** sync HUD message top centre, refreshed every second (hold 1.3 s),
  humans only: "Level 7/24 | MP5 | leader: Walter (12)" (with "(1/2
  kills)" after the weapon when `wc_gg_kills_per_level` > 1); "<name> won
  Gun Game!" after a win. `|` instead of the plan's `·`: the engine's HUD
  font is ASCII.
- **Test commands:** `wc_gg_status` (mode, levels, kills per level, winner;
  each player: team, alive, level n/N, weapon name, kills on the level,
  frozen, weapons) and `wc_gg_setlevel <userid> <level>`.
- **Admin API / Match tab:** `wc_gg_kills_per_level {1, 10, 0}`,
  `wc_gg_suicide_penalty {0, 1, 0}`, `wc_gg_join_lowest {0, 1, 0}` in
  `adminCvars` (tests: accepted and refused values, `wc_gg_ladder`
  refused) and `cvars.ts` / Match tab fields. `wc_gg_ladder` is a string,
  so it isn't in the admin API (rcon / `server.cfg` only).

Files: `src/amxx/wc_gamemode.sma`, `src/server/admin_actions.go`,
`admin_actions_test.go`, `src/client/src/admin/cvars.ts`, `match.ts`,
`README.md`.

Verified (image `--platform linux/386`, `local/cs16-web-server:latest`,
`--network none`, YaPB bots, console through a fifo; scripts in the
scratchpad `a3/`: `run.sh` + `c_*.txt`, `stoptest.sh`, `analyse.py`):

- `amxx-plugins` stage: 3 plugins compile, no warnings. Go: `gofmt`,
  `go vet`, tests pass (scratchpad `a1/gotest.sh`). `npm run build` and
  Prettier (es5 commas, single quotes) pass.
- **Full 24-level Gun Game, 10 bots, on de_dust2 (8 min 54 s) and
  fy_iceworld (4 min 49 s), run side by side:** a bot reached level 24 and
  won with the knife on both, `wc_gg_win` in the game log, everyone
  `frozen 1` in `wc_gg_status`, `Mapchange` 5 s later (to `de_dust2`, the
  AMXX nextmap; see A.2 on its cycle position), new map in classic with the
  classic cvars. 139 / 195 level ups, 2 / 1 knife steals (victim down one,
  killer up one). Kill weapons were exactly the ladder's (dust2: 10
  glock18, 10 usp, 10 p228, 10 deagle … 3 awp, 3 m249, 1 grenade, 3 knife;
  nothing off the ladder), i.e. bots used each level's weapon. No
  `Round_End` while the mode ran, no AMXX errors, no crash.
- Short ladder (`glock18;deagle;hegrenade;knife`): levels up, knife steals
  both ways, HE level: grenade gone after a throw and back 2–3 s later
  (sampled each second; 1.5 s fuse + 1 s), a grenade kill moved the bot up,
  win and map change.
- `wc_gg_kills_per_level 2`: kills counted 1/2 before the level up.
  `amx_slay` with `wc_gg_suicide_penalty 1` → down one; with 0 → no change.
  `yb_quota 12` while everyone was on 4 and one bot on 3 → the 2 new bots
  started on 3. Ladder changed mid-game to 2 weapons → everyone clamped to
  level 2 with the Deagle; garbage ladder → logged, default ladder.
  `wc_gamemode 0` during the win freeze → unfrozen, no map change; then
  Deathmatch still works (A.2's `wc_dm_status` shows guns, armour,
  flashbangs).

Left / manual:

- **Browser and phone:** the HUD line (position, that it doesn't flicker,
  readable on a phone), the centre messages, the refused buy / drop
  messages, the freeze as a player sees it, and two players playing a full
  Gun Game. Not possible here (no game client).
- Team kill path not exercised (friendly fire off in the Gun Game preset;
  the code just returns).
- `mp_timelimit` (30 in `server.cfg`) still ends the map; a Gun Game
  that hasn't been won by then ends without a winner. The Gun Game preset
  doesn't change it.
- YaPB bots rarely knife or throw HE, so a 24-level game mostly ends by
  guns; HE and knife levels pass within a minute anyway on both maps.

### A.4 Gun Game and Deathmatch on the HTML HUD — partial: **cs16-client 0.0.10 blocked**

**Blocked: the game client.** The bridge event can't be built here. The
0.0.3–0.0.9 bridge (`html-hud.patch`, `html-hud-mainui.patch`,
`BUILD-NOTES.md`) exists only in the local checkout
`/Users/wcarasas/Repos/webxash3d-fwgs` (plans/html_hud.md, admin-player-
features-notes.md); it is in no repo, no tarball (`vendor/cs16-client-0.0.9.tgz`
has only `package.json`, `README.md` and the three wasm files) and not on
this machine. The base sources are reachable (mirror
`github.com/daShao999/WebXash3D-Fwgs-yohimik`, `yohimik/webxash3d-fwgs` is
404), but building 0.0.10 from them without the patch would drop every
bridge event since 0.0.3 (HUD, scoreboard, chat, rounds, menu…), and
re-writing that patch from the wasm isn't realistic. **To unblock:** from
the Mac checkout, add the WcMode hook (sketch below) and D.1's
`WcKillInfo` to the same build, bump to 0.0.10, rebuild, `npm pack` into
`vendor/`, and update `package.json`, `package-lock.json` (`npm install`)
and the Dockerfile `COPY vendor/cs16-client-*.tgz` line. Better still,
commit `html-hud.patch`, `html-hud-mainui.patch` and `BUILD-NOTES.md`
into this repo (e.g. `patches/cs16-client/`) so the next agent can build.
Nothing else needs to change then: the page turns itself on from 0.0.10
(see "Version gate").

What was done (works with today's 0.0.9, which changes nothing for
players):

- **Plugin** (`wc_gamemode.sma` 1.3): `plugin_precache` registers
  `WcMode` (`engfunc(EngFunc_RegUserMsg, "WcMode", -1)`; id 60 on the
  image). Format (also at the top of the source): bytes `mode`, `level`,
  `levels`, `kills`, `killsNeeded`, `leaderLevel`, short `protection` (ms
  left, 0 none), strings `weapon`, `next`, `leader`, `winner` (display
  weapon names like "MP5"; real player names, since this isn't a TextMsg
  format). Sent reliably (`MSG_ONE`) only to players whose userinfo has
  `wc_html_hud 1` (`HtmlHud()`, never bots), and only when their state
  changed: the last state sent is kept per player (the protection as its
  end time, so a running protection isn't resent each second); checked
  each poll, and right away on level changes, kills on a level, the win,
  and protection start / end (`StartGlow` / `EndGlow`). When a mode ends,
  `mode 0` goes out once. Those players don't get the Gun Game HUD message
  or the level up/down centre messages (the page's toast replaces them);
  the win's centre message and chat line still go to everyone. Older
  clients never set the key, so they keep the HUD message and never
  receive `WcMode` (which they don't hook). Test command
  `wc_mode_test <userid> <0|1>` treats a player (bots too) as having
  `wc_html_hud 1`; `wc_gamemode_status` prints the message id and, per
  such player, the last state sent.
- **Page:** `src/client/src/gamemode.ts` (no DOM): `ModeState`,
  `parseModeState`, `gunGameStrip`, `levelToast`, `versionAtLeast`,
  `MODE_EVENT_CLIENT_VERSION = '0.0.10'`. `hud.ts`: `mode` in `HudEvent`;
  the Gun Game strip `#hud-gg` ("7 / 24 · MP5 → UMP45 next | Leader
  Walter (12)", "1/2 kills · …" when `wc_gg_kills_per_level` > 1, "last
  level", "Walter won Gun Game!" after a win); a level toast
  `#hud-level-toast-text` ("Level 8: UMP45", "Down to level 6: Desert
  Eagle"), its own element under the multi-kill toast so both can show;
  the spawn protection bar `#hud-protect` (both modes; the bar empties
  over the time left and hides on `protection 0`). All cleared on
  `reset`. CSS at the end of `style.css`.
- **Placement (decision):** the plan says "under the timer", but the
  timer is at the bottom centre, so the strip sits just above it
  (landscape `bottom: 4.4em`; portrait above the lifted clock, with the
  chat moved up by the strip's height via `#hud.gun-game`). The top centre
  would collide with the kill feed (up to 60% wide). The protection bar is
  under the crosshair (`top: 58%`).
- **Version gate:** `vite.config.ts` reads the installed
  `node_modules/cs16-client/package.json` version into
  `__CS16_CLIENT_VERSION__` (declared in `wasm.d.ts`); `setHudEnabled`
  runs `setinfo wc_html_hud 1` (0 when the HUD falls back to the stock one)
  only when it is ≥ 0.0.10. With 0.0.9 the built bundle has
  `versionAtLeast("0.0.9", …)` → false, so no setinfo: players see the
  plugin's HUD message as in A.3. **D.1 / whoever builds 0.0.10: the
  0.0.10 tarball must contain the WcMode hook**, or the page would turn
  the plugin's HUD message off with nothing to replace it (otherwise raise
  `MODE_EVENT_CLIENT_VERSION`).
- **Client sketch** for the C++ side (hook, JSON, EM_JS, `web_bridge.h`
  doc text, post-build checks): scratchpad `a4/wcmode-bridge-sketch.cpp`
  (copied here in short): `HOOK_MESSAGE(WcMode)` in `CHud::Init`;
  `MsgFunc_WcMode` reads the fields above in order (copy each
  `READ_STRING` before the next), builds
  `{"mode":..,"level":..,"levels":..,"kills":..,"killsNeeded":..,"leaderLevel":..,"protection":..,"weapon":"..","next":"..","leader":"..","winner":".."}`
  with the existing JSON escaping, and calls
  an EM_JS `js_hud_mode` → `Module.hudEvent("mode", JSON.parse(json))`
  like `js_hud_chat`. D.1's `WcKillInfo` follows the same pattern.

Files: `src/amxx/wc_gamemode.sma`, `src/client/src/gamemode.ts` (new),
`src/client/src/hud.ts`, `src/client/index.html`,
`src/client/src/style.css`, `src/client/src/wasm.d.ts`, `vite.config.ts`,
`README.md` (plugins table).

Verified:

- `amxx-plugins` stage: 3 plugins compile, no warnings. `npm run build`,
  `tsc --noEmit`, Prettier (new code; the existing html/css differences
  are pre-existing) pass. `tsx` check of `gamemode.ts` (scratchpad
  `a4/smoke-mode-a4.mts`: strip texts, toasts up/down/none, parsing of bad
  payloads, version compare incl. `0.0.2+commit…`).
- Image (`--platform linux/386`, `local/cs16-web-server:latest`, no
  network, bots; scratchpad `a4/run.sh` + `c_mode.txt`, `c_dm.txt`):
  `WcMode message id 60`; Gun Game with `wc_mode_test` on 3 bots: states
  sent and updated (leader changes, a level up "1 2 4 … Desert Eagle|HE
  grenade|…", protection end times), Deathmatch "2 0 0 0 0 0 …",
  protection end time sent at the restart spawn and cleared ~2 s later,
  `wc_gamemode 0` → mode 0 sent once, then nothing. No AMXX errors, no
  crash (sending `WcMode` to bots is harmless).

Left / blocked:

- The cs16-client 0.0.10 build (above), so the strip, toast and bar have
  never been seen in a browser; the A.4 "done when" (desktop and phone,
  and an older client still getting the HUD message with a new server)
  needs that build. The old-client half can be checked now: a browser on
  the current image still gets the "Level 7/24 | …" HUD message.
- After 0.0.10: check the strip's place on a phone in portrait and with
  touch controls, that the toast doesn't fight the multi-kill toast, and
  that `setinfo wc_html_hud 1` reaches the server
  (`wc_gamemode_status` shows `html_hud 1` for the browser player).

### Gap fixes after A.4 — done

Four fixes approved by the user, between A.4 and A.5.

1. **One round restart per mode change.** The game reads `sv_restart`
   once a second (ReGameDLL's periodic think) and restarts a second
   after that, so the plugin's own `sv_restart 1` and a preset's could
   land a second apart: reproduced in the image (`wc_gamemode` then
   `sv_restart 1` 0.4–1.7 s later → two `Restart_Round_` lines). The
   plugin's restart came first in most of them, so "skip if a restart just
   happened" alone wasn't enough; and skipping after a round that already
   started would leave everyone with the old mode's loadout until they
   died. `wc_gamemode.sma` (1.4) now hooks the game's
   `World triggered "Restart_Round_(…)"` log line (any source: Match tab,
   admin API, console): it applies a changed `wc_gamemode` right there,
   before that restart; while one is scheduled (until the new round,
   `HLTV` event, at most 2 s) it sends none; otherwise it sends its own
   `sv_restart 1` 2 s after the change (`RESTART_GRACE`), unless a restart
   was scheduled in the meantime. A change from the console alone now
   restarts 2–3 s later instead of 1–2 s.
2. **`cvars.ts` header and limits.** The header said stock game DLL; it
   now says ReGameDLL_CS 5.30.0.814 (REGAMEDLL_ADD + REGAMEDLL_FIXES).
   Checked every limit against its source (tag 5.30.0.814,
   `ReadMultiplayCvars`, `CheckStartMoney`, `CanPlayerBuy`, README):
   round time 0–500 min (0 = no limit), freeze time ≥ 0 (no upper
   clamp), start money 0–`mp_maxmoney` (16000), buy time no clamp (0 =
   buying off, -1 = no limit), max rounds and time limit only refuse
   negatives. All our ranges sit inside these, so none was wrong; only
   the comments changed (they said "the game clamps"). Go's `adminCvars`
   unchanged, so no test changes.
3. **Fall deaths on the leaderboard.** Deaths by the world are logged as
   `"wind<18><BOT><CT>" committed suicide with "worldspawn" (world)` (real
   line from an image log; same format in ReGameDLL's source).
   `logSuicideRe` now allows the ` (world)` suffix; they count as a death
   and a suicide like other suicides. Tests: the real line, a name
   containing "(world)", a CRLF ending, and a line with another suffix
   that stays ignored; the tally test has a fall death.
4. **Headless browser checks**: `plans/new-features-1006-tools/` (README
   there). Playwright 1.63 in Docker against the image. The game itself
   runs: full Chromium in new headless mode, WebGL 2 on SwiftShader,
   joins over WebRTC, ~25–30 fps (the headless shell stalls in signon).
   `engineCommand` runs console commands (team join etc.).

Files: `src/amxx/wc_gamemode.sma`, `src/client/src/admin/cvars.ts`,
`src/server/statslog.go`, `statslog_test.go`, `statsfollow_test.go`,
`README.md` (restart wording, world deaths), `plans/new-features-1006-tools/*`.

Verified:

- `amxx-plugins` stage compiles all three plugins, no warnings. Go
  gofmt / vet / tests pass (`local/cs16-go-test`, scratchpad
  `a1/gotest.sh`). `npm run build` passes. Image rebuilt.
- Restart test in the image (scratchpad `gapfix/restarttest.sh`, console
  through a fifo, 4 bots): `wc_gamemode` + `sv_restart 1` at gaps 0, 0.2,
  0.4, 0.6, 0.8, 1.0, 1.3, 1.7 s, and twice a change alone: 10 changes, 10
  `Restart_Round_` lines (before: 16), no AMXX errors.
- `check-gamemode.mjs` in headless Chromium against the image, all pass:
  lobby line "de_dust2 · Gun Game · 4/14 players"; F4 Match tab with the
  Game mode field, Gun Game and Deathmatch presets, the "Gun Game is on.
  Knife only and pistols only don't work" note, the fun map note ("The
  next map, fy_iceworld, has its own settings"); Knife only refused with
  "Not sent: Knife only doesn't work during Gun Game"; clicking the
  Deathmatch preset → "Deathmatch applied and the round restarted" and
  one `Restart_Round_` in the log (plugin: "restarted by someone else, not
  restarting again"); F3 settings render. **The 0.0.9 client gets the
  Gun Game HUD message**: "Level 1/24 | Glock | leader: bussemann (3)" at
  the top, Glock in hand (the old-client half of A.4's "done when").
  Screenshots in the scratchpad `gapfix/`.

Found, not fixed (out of scope): in the F4 menu the "Admin password"
field and Log in button stay visible after logging in, next to "Logged in
as admin" / Log out. `#admin-auth` has class `field` (`display: flex`),
which overrides its `hidden` attribute.

Left: phone checks; the HTML HUD half of A.4 still needs cs16-client
0.0.10.

### A.5 Leaderboard and stats in the new modes — done

Decision (the brief's default): **one shared leaderboard**; kills in Gun
Game and Deathmatch count like any other, plus a **Gun Game wins**
column. No `mode` column or filter. "Rounds" doesn't grow in those modes
(no `Round_End`), as the plan says.

What was done:

- `statslog.go`: new event `logGunGameWin` for
  `"Name<uid><auth><team>" triggered "wc_gg_win"` (exact line, checked
  before the generic `triggered` line, which would otherwise take it as
  `logPlayerOther`). Real line from the image:
  `"Zachalicious<4><ID_BOT><CT>" triggered "wc_gg_win"`.
- `statsfollow.go`: a win adds `GunGameWins` to the player with the same
  rules as the other totals (`counts`: named, ≤ 64 bytes, bots only with
  `LEADERBOARD_BOTS=1`; `BOT` and `ID_BOT` are both bots). The line also
  keeps the player's team current, like other player lines.
- `statsdb.go`: `playerTotals.GunGameWins`, column `gg_wins`.
  **Migrations:** `statsMigrations` (a list, append only);
  `PRAGMA user_version` is how many ran. `openStatsDB` creates the old schema if
  missing (unchanged `CREATE TABLE IF NOT EXISTS`), then runs the missing
  migrations and sets the version in one transaction. Migration 1:
  `ALTER TABLE players ADD COLUMN gg_wins INTEGER NOT NULL DEFAULT 0`. A
  new database goes through the same path. A database with a higher
  version (from a newer build) is left alone. Totals and read offsets of
  an old database are kept. Ordering stays by kills.
- `leaderboard.go`: `ggWins` in each `/leaderboard` entry.
- Login page: column **GG** (title "Gun Game wins") after HS
  (`index.html`, `leaderboard.ts`: `ggWins`, 0 when a server doesn't send
  it). `style.css`: with six number columns a 390 px phone left names
  ~40 px, so under 480 px wide the table uses 13 px text, 3 px cell
  padding and narrower number columns (names get ~86 px, about 11
  characters; before A.5 they had ~50 px).
- README: leaderboard paragraph (Gun Game wins, modes' kills, upgrade of
  an old `leaderboard.db`).
- `plans/new-features-1006-tools/check-leaderboard.mjs` (new): opens the
  login page at desktop and phone size, opens "Top players", checks the GG
  header and that each row's GG matches `/leaderboard`, and that the page
  doesn't scroll sideways.

Files: `src/server/statslog.go`, `statsfollow.go`, `statsdb.go`,
`leaderboard.go`, `statslog_test.go`, `statsfollow_test.go`,
`leaderboard_test.go`, `src/client/index.html`,
`src/client/src/leaderboard.ts`, `src/client/src/style.css`, `README.md`,
`plans/new-features-1006-tools/check-leaderboard.mjs`.

Verified:

- Go (scratchpad `a1/gotest.sh`, image `local/cs16-go-test` from the
  Dockerfile's `go` stage): `gofmt -l` empty, `go vet`, all tests pass.
  New: parse of the win line (human, `ID_BOT`, quotes/suffix in the name;
  `"wc_gg_win" (…)` and `"wc_gg_winner"` are not wins),
  `TestStatsTallyGunGameWins` (bots out / in, nameless player),
  `TestStatsDBMigratesOldDatabase` (a pre-A.5 database with a row and a
  log file record: kept, `gg_wins` 0, version 1, new wins add up, opened
  again without re-running the `ALTER`), `TestStatsDBNewDatabase` (new
  file at version 1; a version-99 database opens untouched), `ggWins` in
  `TestLeaderboardEntries` / `TestLeaderboardHandler` JSON and
  `TestLeaderboardFromLogs` (log file to JSON, bot win not listed).
- `npm run build`, `tsc --noEmit`, Prettier on `leaderboard.ts` (repo
  style); `index.html` / `style.css` only have Prettier differences that
  were there before.
- Real Gun Game win in the image (`--platform linux/386`, 6 bots,
  `LEADERBOARD_BOTS=1`, a map config `wc_gg_ladder "deagle;ak47"` mounted
  as `configs/maps/de_dust2.cfg`, `wc_gamemode 1` through the admin API):
  a bot won after ~40 s, the `wc_gg_win` line above was in the game log
  and `/leaderboard` had `"ggWins":1` for it, 0 for the others.
  `check-leaderboard.mjs` in headless Chromium: GG column and values right
  at 1280×800 and 390×844, no sideways scroll (screenshots in scratchpad
  `a5/`). Note for later checks: the Go server gzips the client files in
  memory at startup, so files copied into a running container are only
  served after a restart.

Left / manual: a Gun Game won by a browser player (same line with the
player's `ID_…` auth; covered by the parser/tally tests, not played: the
headless tool can't aim). Real phone look of the narrower table.

### C.1 Sounds — done

16 sounds in `src/client/public/sounds/`, each as `.webm` (Opus, 48 kHz
mono, 64 kb/s) and `.mp3` (44.1 kHz mono, 64 kb/s, no ID3): the 15 in the
plan plus **`knifed`** (the default for the C.2 question: being knifed
plays a shorter, different sound: 0.55 s synth "swipe" and falling tone, no
voice). 4.8–22.2 KB each, 390 KB in all.

- **Source:** Piper TTS (`piper-tts` 1.8.0) with the voice
  `en_US-john-medium` (piper-voices repo MIT; model card: public-domain
  LibriVox data, fine-tuned from `kristin`, also LibriVox, from scratch).
  Rejected: `norman` (PD, but Whisper heard "Rampage" as "R-V-N-P-H",
  "Winner" as "we're in there", "Godlike" as "I'd lie in"), `ljspeech`
  (female, also garbled some), `joe` / `alan` / `northern_english_male`
  (fine-tuned from `lessac`) and `ryan` / `hfc_male` (NC datasets). Jingles
  (level-up, final-level, winner) and `knifed` are SoX oscillators, no
  samples. ffmpeg announcer chain: pitch -10 %, EQ, 5:1 compressor, echo.
- **Loudness:** gain to -16 LUFS integrated, then `alimiter` at -2.5 dBFS
  at 4× sample rate (true-peak limiting), three passes, then encode. (Not
  `loudnorm`: on these short, peaky clips its "linear" mode fell back and
  left files at -32 LUFS. And libopus at ≤ 40 kb/s came out ~1.5 LU quieter
  than its input, hence 64 kb/s.)
- **Tools:** `plans/new-features-1006-tools/sounds/` (new): `Dockerfile`
  (image `local/cs16-sounds`: `python:3.12.11-slim-bookworm`, piper-tts
  1.8.0, onnxruntime 1.30.0, voice pinned to a repo commit + sha256,
  Debian ffmpeg 5.1.9 / sox 14.4.2), `make.sh` (all the commands),
  `generate.sh` (builds the image, runs `make.sh`, checks). Texts end in
  "!" except "First blood." (the "!" put a gap between the words);
  "Quad-kill!" and "God like!" are spelled that way because Whisper heard
  "quad to kill" / "god like it" otherwise.
- **Go:** `static.go` registers `.webm` → `audio/webm` and `.mp3` →
  `audio/mpeg` (Go's built-in table has neither and the image has no
  `/etc/mime.types`, so FileServer sniffed `video/webm` and, for an MP3
  without ID3, `application/octet-stream`). Not gzipped,
  `Cache-Control: no-cache` like other non-`/assets/` files. Test in
  `static_test.go`.

Files: `src/client/public/sounds/*.webm`, `*.mp3`, `README.md` (source,
licences, tool versions, every step and command, measurements),
`plans/new-features-1006-tools/sounds/{Dockerfile,make.sh,generate.sh}`,
`plans/new-features-1006-tools/README.md`, `src/server/static.go`,
`src/server/static_test.go`.

Verified:

- `generate.sh` decodes every output and measures it with ffmpeg
  `ebur128=peak=true`: all files -16.0 to -16.8 LUFS (webm -16.0…-16.4,
  mp3 -16.3…-16.8), true peak -1.4 dBTP or lower, all < 30 KB (table in
  the sounds README). Two runs give byte-identical files (md5).
- Every voice file transcribed by Whisper `base.en` (faster-whisper, run
  in a scratchpad install, since deleted) as its intended words, both
  `.webm` and `.mp3`.
- `npm run build`: `dist/sounds/` has all 32 files (plus README.md, served
  as a credits file). Go (scratchpad `a1/gotest.sh`): `gofmt -l` empty,
  `go vet`, all tests pass, including the new content-type checks.

Left / not done: nobody listened to them (no audio out here; only the
Whisper and loudness checks) — **listen once and adjust texts/chain in
`make.sh` if the voice or echo sounds off**. The real image wasn't rebuilt
to curl the types (covered by the handler test). Wiring is C.2. Note for
others: the host disk was full during this step (`/` at 100 %, other
projects' images and build cache); I removed only my own Whisper build
cache.

### C.2 Playing them — done (real-audio, phone and iOS checks left)

What was done:

- `src/client/src/announcer-rules.ts` (new, no DOM or audio, tested with
  node): `SOUND_NAMES`, `SOUND_PRIORITY`, `shouldReplace`, `pickSound`,
  `multiKillSound`, `streakSound`, `isLastMan`, `modeSound`,
  `AnnouncerOptions` / `DEFAULT_ANNOUNCER_OPTIONS`, and
  `createAnnouncerTriggers()` (per-round state: `kill`, `scores`,
  `roundStart`, `setGameMode`, `reset`).
- `src/client/src/announcer.ts` (new): `startAnnouncer()` (called in
  `main.ts` `start()`, after Connect, so nothing loads on the login page)
  creates the AudioContext and one GainNode, fetches the 16 files and
  decodes each once (`.webm` when
  `canPlayType('audio/webm; codecs="opus"')`, else `.mp3`; a `.webm` that fails to decode is retried
  as `.mp3`). The context is resumed on the first `keydown`, `pointerdown`,
  `touchend` or `mousedown` (capture listeners, removed once running).
  `announce(name)` drops the sound while the context isn't running, when
  not loaded, at volume 0, or when a higher-priority sound is playing;
  otherwise it stops the playing one and starts it. Every play / drop /
  load / audio state goes to `console.debug("announcer: …")` (the debug
  hook the headless check reads; hidden in a normal console).
- `hud.ts` triggers: kill events → `announcer.kill(…)` with
  `recordKill`'s result (first blood, headshot, multi-kill, streak,
  humiliation, knifed); first blood also shows the toast "<killer> drew
  first blood" (same `#hud-toast-text` as the multi-kill toasts, always
  shown); round starts (the timer's `createRoundStartDetector`) and `reset`
  start a new announcer round; `scores` → last man standing; `mode` →
  `modeSound` (level up / final level / winner) and `setGameMode`.
  `main.ts` turns live scores on (`setLiveScores('announcer', true)`):
  last man standing needs every player's alive state while the scoreboard
  is closed (2 Hz `scores`, as the admin tab already used).

Decisions:

- **Priorities** (higher wins): winner 6; godlike, unstoppable,
  final-level 5; multi-kills, killing-spree, dominating, last-man 4;
  first-blood 3; humiliation, knifed, level-up 2; headshot 1. A new sound
  with the **same or higher** priority stops the playing one (a triple
  kill replaces the double kill still playing), a lower one is dropped.
  One kill gives at most one sound: the highest of its candidates, so no
  headshot with a multi-kill (or with first blood / humiliation); a streak
  threshold that lands on a multi-kill loses to it (tie, multi listed
  first), so that streak sound is skipped.
- **Being knifed** plays `knifed` (the brief's default), only for an enemy
  knife kill of the local player.
- **First blood:** the first _enemy_ kill (not team kill, not suicide).
  After a reset (joining, map change) in a classic game it waits for the
  next round start, because the page can't know whether someone already
  drew it this round; in Gun Game / Deathmatch it's open at once (per map;
  round starts ignored; a mode change opens it again). Known limit: a player
  joining a Deathmatch mid-map hears the first kill they see as first
  blood. The game mode comes from the `mode` event with cs16-client
  0.0.10; with 0.0.9 from `/status.json` (`gameMode`), fetched at each
  reset and round start.
- **Last man standing:** you're alive on CT/T, you have at least one
  teammate and none is alive, at least one enemy is alive; once a round;
  armed only after a snapshot this round showed an alive teammate (so a
  stale snapshot from the last round can't fire it after a round start,
  and someone alone on a team never hears it). Off in Gun Game /
  Deathmatch.
- **Streaks:** exactly 5, 10, 15, 20 (once each, reset by death, as
  `recordKill`'s streak). **Multi-kills:** 2, 3, 4 → double/triple/quad,
  5 and more → rampage on each kill.
- **Part A:** `modeSound(prev, state)`: winner when `winner` becomes set
  (anyone's win), final-level when the local level goes up to the last,
  level-up on other increases; none on the first state, level downs or a
  ladder change. Wired but inactive until cs16-client 0.0.10.
- **Hook for C.3:** `setAnnouncerOptions({ volume, headshots, others })`
  (`announcer.ts`; volume 0–100, 0 = off and stops the playing sound;
  defaults 70 / on / on in `DEFAULT_ANNOUNCER_OPTIONS`). C.3 should add
  `announcerVolume`, `announcerHeadshots`, `announcerOthers` to
  `SETTINGS` and call `setAnnouncerOptions` with them at start and from
  `onSettingsChange` (e.g. in `settings/index.ts` or `main.ts`). `others`
  only mutes other players' first blood (the toast stays); your own first
  blood always plays. Gain is linear (volume / 100), like the `volume`
  cvar mapping. C.3 may also want to turn live scores off at volume 0.

Files: `src/client/src/announcer.ts`, `src/client/src/announcer-rules.ts`
(new), `src/client/src/hud.ts`, `src/client/src/main.ts`, `README.md`
(features), `plans/admin-player-features-tools/smoke-announcer-c2.mts`
(new, next to the stats smoke tests),
`plans/new-features-1006-tools/check-announcer.mjs` (new) and its README.

Verified:

- `npm run build` and `tsc --noEmit` pass; Prettier (with the repo's
  es5 trailing commas) clean on the new and touched TS files.
- `npx tsx plans/admin-player-features-tools/smoke-announcer-c2.mts`:
  every sound has both files; priority order and replace/drop; multi-kill
  and streak mapping; kill triggers through the real `createSessionStats`
  (mid-round join, team kill / suicide not first blood, others option,
  own first blood beats headshot, headshot option, no headshot in a
  multi-kill, streaks 5/10/15/20 and again after a death, humiliation,
  knifed, other players' knife kills and a teammate's knife silent);
  Deathmatch / Gun Game first blood per map and on mode change; last man
  standing (stale snapshot, once per round, re-armed after round start, off
  in Deathmatch, alone on a team, spectator); `modeSound` cases.
- Headless Chromium against the image (`local/cs16-web-server:latest` with
  the new `dist` copied into `/xashds/public` and a `docker restart`,
  de_dust2, 6 bots; `check-announcer.mjs`, all pass): 0 sound requests on
  the login page (5 s), "loaded 16/16 sounds (.webm)" and 16 `.webm`
  requests after joining; with an AudioContext forced to start suspended a
  level-up was "dropped (audio suspended)", then a Shift key → "audio
  running" → "play level-up"; after an admin round restart the bots' first
  kill gave "play first-blood" and the toast "Magnus drew first blood"
  (once in that round); 60–230 `scores` events while the scoreboard stayed
  closed; synthetic `hudEvent` kills / scores / mode: headshot, double kill
  with a headshot (no headshot sound), triple, quad, rampage, dominating,
  humiliation, "knifed dropped (double-kill playing)", knifed, last-man,
  level-up, final-level, winner. Chromium played them into its null audio
  sink (no output here). The served type was `video/webm` because that
  image predates C.1's `static.go` change (decoding doesn't care).
  Screenshots in scratchpad `c2/` (a full screenshot takes ~3.5 s under
  SwiftShader, longer than the 2 s toast, so it shows the toast already
  faded; its `show` class and text were checked instead).

Left / manual:

- Nobody heard it: real speakers on desktop Chrome, a phone, and
  **iOS Safari** (does `touchend` resume the context; does it take the
  `.webm` or fall back to `.mp3`). Headless Chromium never enforces the
  autoplay policy, so the gesture path was only tested with a forced
  suspended context.
- Local kills by the player in a real game (the headless player can't aim;
  covered by synthetic events through the real handler and the node test).
- Part A sounds need cs16-client 0.0.10 (blocked).
- C.3: settings (above). Done, see C.3.

### C.3 Settings — done (phone / iOS and real-audio checks left)

What was done:

- `settings/schema.ts`: `announcerVolume` (number 0–100 %, step 5,
  default 70, label "Announcer volume"), `announcerHeadshots` (toggle
  "Announce headshots", hint "Can be very frequent", default on),
  `announcerOthers` (toggle "Hear other players' first blood", default on),
  all in the Sound group after `volume`. No cvars (page-only).
- `main.ts`: `applyAnnouncerSettings(settings)` calls
  `setAnnouncerOptions({ volume, headshots, others })` and
  `setLiveScores('announcer', volume > 0)`; run once at module load (login
  page; `setLiveScores` only reaches the engine once the HUD is attached)
  and from `onSettingsChange` when an `announcer*` key changed. The
  unconditional `setLiveScores('announcer', true)` in `start()` is gone.
- `announcer.ts`: at volume 0 `startAnnouncer()` creates no AudioContext
  and fetches nothing (logs "off (volume 0), sounds not loaded"); turning
  the volume up after the game started (`setAnnouncerOptions`) creates the
  context and loads the sounds then.

Decisions: volume 0 also turns the announcer's live scores off (no 2 Hz
`scores` from it; the admin tabs still turn them on for themselves). Number
settings don't show hints in the panel, so 0 = off isn't spelled out under
the slider (the README says it); "0%" is shown.

Files: `src/client/src/settings/schema.ts`, `src/client/src/main.ts`,
`src/client/src/announcer.ts`, `README.md`,
`plans/new-features-1006-tools/check-settings-c3.mjs` (new) and its README.

Verified:

- `npm run build`, `tsc --noEmit`, Prettier (repo config) on the touched
  TS files.
- Smoke tests in `plans/admin-player-features-tools` (run through copies
  with the hard-coded `/Users/wcarasas/...` path replaced by this repo):
  all pass, including `smoke-set51` (settings) and `smoke-announcer-c2`,
  except `smoke-msg23.mts`, which fails before and after this step:
  it imports `src/client/src/admin/message-text.ts`, which no longer exists.
- Headless (`local/cs16-web-server:latest` with the new `dist` copied into
  `/xashds/public` and a `docker restart`, de_dust2, 4 bots; container
  removed afterwards): `check-settings-c3.mjs` all pass: the three
  controls in the Sound group (login page panel and F3 in game) with
  defaults 70 / on / on; volume 0 + both toggles off kept after a reload
  (controls and `localStorage`); joining at volume 0: "off (volume 0)",
  0 sound requests, 0 `scores` events in 5 s, a real bot first blood shows
  the toast and plays nothing; F3 → volume 60: "loaded 16/16 sounds
  (.webm)", 16 requests, `scores` resume; others off: real first blood
  toast without sound; others on: "play first-blood"; headshots off: a
  synthetic headshot kill logs nothing, on: "play headshot"; volume 0 in
  game: "headshot dropped (volume 0)", `scores` stop; values kept after a
  second reload. `check-announcer.mjs` (defaults) still all pass.
  Screenshot of the F3 panel in scratchpad `c3/`.

Left / manual: hearing it at different volumes on real speakers, a phone
and iOS Safari (the slider's look on a phone; creating the AudioContext
from the slider when the volume goes up from 0 in game should count as a
gesture, checked only in headless Chromium).

### D.1 Kill details from the server — partial: **cs16-client 0.0.10 blocked**

Same block as A.4: the bridge hook can't be built here (see A.4). The
plugin and the page side are done; nothing changes for players on 0.0.9.

What was done:

- **Plugin** `src/amxx/wc_killinfo.sma` (1.0, new; added to the
  `plugins.ini` line in the Dockerfile `hlds` stage and the README plugins
  table). `plugin_precache` registers `WcKillInfo`
  (`engfunc(EngFunc_RegUserMsg, "WcKillInfo", -1)`; id **61** on the image,
  after `WcMode` 60: it registers fine on Xash3D, so no `TextMsg`
  fallback). On every `DeathMsg` with a player killer and a different
  player victim (team kills included, for D.4's "Killed by teammate"),
  sends to the victim, reliably (`MSG_ONE`), right after the DeathMsg
  (AMXX runs `register_event` after the message, same reliable channel),
  in this order:

  | type   | field    | value                                                                                         |
  | ------ | -------- | --------------------------------------------------------------------------------------------- |
  | long   | killer   | killer's userid (= `kill`'s `killerUserid`)                                                   |
  | short  | health   | killer's health as their HUD shows it (0 if already dead, e.g. a grenade thrown before dying) |
  | short  | armor    | killer's armour                                                                               |
  | byte   | headshot | 1 headshot                                                                                    |
  | byte   | blind    | 1 killer fully flashed                                                                        |
  | byte   | wall     | 1 through a wall                                                                              |
  | short  | distance | killer to victim origin, metres (units / 39.37, rounded)                                      |
  | string | weapon   | DeathMsg weapon name (`ak47`, `grenade`, `knife`)                                             |

  The bridge turns it into `hudEvent("killinfo", {killerUserid, health,
armor, weapon, headshot, blind, wall, distance})` (booleans for the
  three flags). The `mode` event spec (A.4) is unchanged; both are in the
  sketch below.

- **Opt-in key (decision): the same `wc_html_hud 1`** as `WcMode`, not a
  new key: both hooks ship in the same client release (0.0.10), the page
  already sets it only from that version and only while the HTML HUD is
  on, and the card is part of the HTML HUD. Bots and older clients never
  get it.
- **Blind and through-wall (decision): kept, from the game itself.**
  ReGameDLL's DeathMsg carries kill-rarity flags after the weapon
  (`mp_deathmsg_flags`, default `abc`: a long of flags, the victim's
  position, the assister, then the rarity long); the plugin reads
  `KILLRARITY_KILLER_BLIND` (`IsFullyBlind`, gun kills only, never knife or
  grenade) and `KILLRARITY_PENETRATED`. `wall` = penetrated **and** a
  `trace_line` from the killer's eyes to the victim's eyes (ignoring
  players) hits the world. The trace alone was unreliable: in the tests
  6 kills had the eyes blocked without any penetration (4 gun kills, shot
  at the body past a corner, and 2 grenades), and one penetrated kill had clear eyes (through another
  player or a thin prop). Without ReGameDLL's flags both read 0.
- **Test commands:** `wc_killinfo_test <userid> <0|1>` (treat a player,
  bots too, as `wc_html_hud 1`; cleared when the player reconnects or the
  map changes); `wc_killinfo_status` prints the message id, kills seen and
  sent, who gets it, and the last 8 sends with, for checking, the killer's
  own HUD health / armour (their last `Health` / `Battery` messages, which
  the game sends to bots too), alive, the raw rarity flags, the eye trace
  and the distance in units.
- **Page:** `src/client/src/killinfo.ts` (new, no DOM):
  `KILLINFO_EVENT_CLIENT_VERSION = '0.0.10'`, `killInfoSupported(version)`
  (for D.4 to know whether to wait for details: pass
  `__CS16_CLIENT_VERSION__`), `KillInfo`, `parseKillInfo(payload)`
  (bad numbers → 0, flags as booleans or numbers, `undefined` without a
  killer userid), `killInfoMatches(kill, info)` (same killer userid and
  weapon; a `kill` without userids never matches). `hud.ts`: `killinfo`
  added to `HudEvent` (typed, not handled yet: D.4 listens via
  `onHudEvent`), and the `setinfo wc_html_hud` comment. The gate is the
  existing one: `setinfo wc_html_hud 1` only from 0.0.10, so on 0.0.9 the
  server never sends it.
- **Client sketch for 0.0.10** (both messages, hook + parser + EM_JS +
  `web_bridge.h` doc + post-build checks): scratchpad
  `d1/cs16-client-0.0.10-bridge-sketch.cpp` (supersedes
  `a4/wcmode-bridge-sketch.cpp`, which it includes). `MsgFunc_WcKillInfo`
  reads the table above in order and builds
  `{"killerUserid":..,"health":..,"armor":..,"weapon":"..","headshot":true,
"blind":false,"wall":false,"distance":..}` with the existing JSON
  escaping. **Whoever builds 0.0.10 must put both hooks in it.**

Files: `src/amxx/wc_killinfo.sma` (new), `src/client/src/killinfo.ts`
(new), `src/client/src/hud.ts`, `Dockerfile` (plugins.ini line),
`README.md` (plugins table; Prettier realigned that table),
`plans/admin-player-features-tools/smoke-killinfo-d1.mts` (new).

Verified:

- `amxx-plugins` stage (`docker build --target amxx-plugins -o
type=local`, no image): all 4 plugins compile, no warnings. `npm run
build`, `tsc --noEmit`, Prettier (es5 trailing commas) on the new / touched
  TS. `npx tsx plans/admin-player-features-tools/smoke-killinfo-d1.mts`
  passes (version gate, parsing, bad payloads, matching).
- Image (`local/cs16-web-server:latest`, `--platform linux/386`, no
  network, 10 bots; the new `.amxx` and `plugins.ini` copied in with
  `docker cp` before start, no rebuild; scratchpad `d1/run.sh` and
  `c_*.txt`, containers removed): `WcKillInfo message id 61`, plugin
  running, no new AMXX errors, no crash. 165 kills over three runs
  (classic, Deathmatch, a knife-only Gun Game); **kills seen = kills in the
  game log** (40 and 93 in the two runs that stayed on one map); with the test flag on bots 4–10 only, 65 of 93 sent and no
  send to bots 1–3 (the opt-in works). Of 98 sends captured, **health and
  armour equal the killer's own HUD values in all 98** (e.g. "hp 9 ap 91",
  "hp 1 ap 80", "hp 100 ap 100"); headshot = the DeathMsg's; distances
  plausible: knife 1–2 m, rifles 2–46 m, AWP 5–42 m, grenades 17–34 m,
  metres = units / 39.37 in every line; 6 through-wall kills (sg552, ak47,
  awp, deagle; bots shoot through walls with `yb_shoots_thru_walls 2`),
  1 blind kill (rarity 0x3 with a Deathmatch flashbang).

Left / blocked:

- cs16-client 0.0.10 with the `WcKillInfo` hook (and A.4's `WcMode`):
  then check D.1's "done when" in a browser: the `killinfo` event arrives
  for every player kill of the local player, and its HP / armour match the
  killer's HUD in a second browser (or `wc_killinfo_status`).
- Not seen in the tests: a team kill (no bot team kill happened with
  `mp_friendlyfire 1`) and a killer already dead (health 0); both follow
  the same code path.
- D.4 consumes `killinfo` (match it to the `kill` that came just before
  with `killInfoMatches`).

### D.2 Head-to-head this map — done

- `src/client/src/stats.ts`: `createSessionStats` keeps
  `duels: Map<killer, Map<victim, kills>>` and has `duel(a, b): Duel` (`{ aKills, bKills }`,
  new exported type; zeros for unknown names or `a === b`).
  `startRound` keeps them; `reset` (map change, reconnect) clears them.
  `rename` (from a scores snapshot's userid) moves both directions of every
  pair to the new name and merges into pairs the new name already has; a
  pair between the two merged names would be a player against themself and
  is dropped.
- **Decision: enemy kills only.** Team kills, suicides, world / fall kills
  and objects don't count, matching the kills column, the leaderboard and
  D.3's "count enemy kills". D.4 shows "Killed by teammate" without duel
  lines anyway.
- **Killer's streak for D.4:** already available, no new API:
  `stats.get(killer)?.streak` (enemy kills since their last death; a team
  kill doesn't change it, being killed resets it). Comment added on `get`.
  D.4 gets the instance from `getSessionStats()` (`hud.ts`) and reads
  `duel` / the streak in an `onHudEvent` listener for `kill`: listeners
  run after `hud.ts` has called `recordKill`, so both already include the
  kill that killed the local player.

Files: `src/client/src/stats.ts`,
`plans/admin-player-features-tools/smoke-stats61.mts` (duel section).

Verified: `npm run build`, `tsc --noEmit`, Prettier (es5 trailing commas)
on `stats.ts`. Smoke tests (copies with the `/Users/wcarasas/...` path
rewritten, scratchpad `d2/`; the relative-import ones in place): all pass,
including `smoke-stats61` with the new duel cases (counts both ways,
team kill / suicide / world / object / self ignored, kept over
`startRound`, the streak, rename of each side, rename onto a name with
pairs, merging two names that fought, cleared by `reset`), except
`smoke-msg23.mts`, which fails before and after (imports the removed
`admin/message-text.ts`). Nothing to check in the image: no UI yet (D.4).

Left: nothing for D.2; D.4 shows it.

### D.3 Head-to-head all time — done

- `statsfollow.go`: every enemy kill (same test as the kills column) also
  adds 1 to `duels[(killer, victim)]` when **both** names count (`counts`:
  named, ≤ `statsNameMax`, bots only with `includeBots`); so with bots
  left out a human's kill of a bot adds no pair. Two players with the same
  name make no pair. Pairs are by the names on the kill line, so a rename
  starts a new pair (nothing is moved, like the totals). `take()` now
  returns `(totals, duels)`; a `Server shutdown` line keeps untaken duels
  like it keeps totals.
- `statsdb.go`: migration 2 creates
  `duels (killer, victim, kills, PRIMARY KEY (killer, victim))`; `commit(ctx, file, rec, deltas, duels, at)`
  upserts pairs in the same transaction as the totals and offset;
  `duel(ctx, a, b)` returns both directions in one query.
- `duel.go` (new): `GET /duel?a=&b=` → `{"aKills":n,"bKills":m}`. GET/HEAD
  only, rate limited per address (`statusRate` / `statusBurst`, own
  limiter), cached 5 s per pair (one entry for both orders, swapped on the
  way out; at most 512 entries: expired dropped first, else cleared);
  failures cached and answered 503. `a` and `b` required, ≤ 64 bytes, else 400.
  Unknown names: 0 – 0. Routed in `sfu.go` (`Server.duel`, 404 when
  nil); `main.go` creates it with the leaderboard (both off together).
- README: "Head-to-head" paragraph after the leaderboard one.
- For D.4:
  `fetch('/duel?a=' + encodeURIComponent(me) + '&b=' + encodeURIComponent(killer))`; treat 404 / 503 / 429 as "no all-time
  line". Names are the exact in-game names.

Files: `src/server/statsfollow.go`, `statsdb.go`, `duel.go` (new),
`duel_test.go` (new), `statsfollow_test.go`, `sfu.go`, `main.go`,
`README.md`.

Verified (scratchpad `a1/gotest.sh`, image `local/cs16-go-test`): `gofmt
-l` empty, `go vet`, all tests pass. New: `TestStatsTallyDuels` (counts
both ways; team kill, suicide, self, world, spectator victim, headshot line,
nameless / too-long names, same-name players give no pair; bots only with
`includeBots`), `TestStatsTallyDuelsRename`, `TestLogFollowerDuels`
(restart doesn't recount, new file, `db.duel`),
`TestStatsDBMigratesPreDuelDatabase` (a version-1 database with `gg_wins`:
table added, totals / offsets kept, reopened without re-running),
`TestStatsDBCommitIsAtomic` now also checks duels roll back,
`TestDuelHandler` (JSON, headers, swap from one cache entry, TTL, cached
503, 400 for empty / 65-byte names, 64 ok, POST 405, HEAD),
`TestDuelCacheBounded`, `TestDuelRateLimit`, `TestServerRoutesDuel` (404
without database), `TestDuelFromLogs` (log file to JSON, with a rename).
Not run in the game image (disk nearly full; no image builds).

Left: nothing for D.3; D.4 calls it.

### D.4 The card — done (real-phone and 0.0.10 checks left)

What was done:

- `src/client/src/killcard-text.ts` (new, no DOM):
  `killCardFor(kill, localName)` picks the card for a `kill` event whose victim is the local
  player: **enemy** ("Killed by" + killer in team colour, weapon label and
  icon kind, headshot), **teammate** ("Killed by teammate <name>"), and
  short cards without killer or duel lines: `worldspawn` → "You fell to
  your death", `world` / no weapon → "You killed yourself" (`kill`),
  own `grenade` → "Killed by your own grenade", any other world entity
  (`trigger_hurt`...) → "Killed by the map". Texts: `detailsText` ("87 HP
  · 100 armour · 23 m", "Killer already dead · 23 m" at 0 health),
  `detailTags` ("Through a wall", "Killer was blind"), `mapLineText`,
  `allTimeLineText`, `streakText` (from `STREAK_MIN` = 3), `parseDuel`,
  `duelUrl`, `allTimeDuel`, and `createBombDeathDetector`.
- `src/client/src/killcard.ts` (new, DOM): `startKillCard()` (called in
  `main.ts` after `startAnnouncer()`) listens with `onHudEvent`. On a
  local death it shows `#hud-killcard` (new in `index.html`, inside `#hud`)
  for `KILL_CARD_MS` = 6 s, hidden earlier on respawn (`alive` with
  alive and not spectating, after being dead), a round start (its own
  `createRoundStartDetector` on `timer`), an active intermission, a
  `reset` or the setting turned off. Spectating after death keeps it (other
  players' kills are ignored). Map line from
  `getSessionStats().duel(me, killer)`, streak from `get(killer)?.streak`, both read when drawn (after
  hud.ts counted the kill).
- **`killinfo`:** with `killInfoSupported(__CS16_CLIENT_VERSION__)` and a
  player killer with a userid, the card waits up to `KILL_INFO_WAIT_MS` =
  250 ms for the matching `killinfo` (`killInfoMatches`), and fills it in
  if it comes later; on 0.0.9 it never waits and shows what `kill` has.
- **All time:** `GET /duel?a=<me>&b=<killer>` once per killer per map
  (cache cleared on `reset`; a failed request, 404 / 429 / 503 / bad JSON
  / 5 s timeout, gives no line and may be retried for that killer after
  60 s). **Decision:** the line shows server + this map's kills since the
  fetch (so it stays right for later deaths on the same map without a new
  request); the kill that brought up the card is taken as not yet in the
  server's numbers (the follower reads logs every 2 s), so a fetch that
  already includes it would count it twice (rare, off by one). **No line
  while the server has 0 – 0** for the pair: it would repeat "This map",
  and with `LEADERBOARD_BOTS` off bot pairs are always 0 – 0.
- **Bomb (decision):** the game sends no DeathMsg for bomb deaths
  (`CBasePlayer::Killed` skips `PlayerKilled` when `m_bKilledByBomb`,
  ReGameDLL source), so there's no `kill` event. The card shows "Killed by
  the bomb" when the local player goes from alive to dead without a kill
  event for them and a `round` event with reason `bomb` comes within
  1.5 s, either order.
- Setting `killerCard` (HUD group, "Killer card", hint "Who killed you and
  your record against them", default on), `settings/schema.ts`.
- `style.css`: lower centre, above the clock (`bottom` 4.6em; 7.4em above
  the Gun Game strip; portrait 10.6em / 13.4em, above the lifted clock),
  `max-height: calc(50% - bottom - 2em)` so it never reaches the crosshair
  (lines that don't fit are cut from the bottom), tighter under 480 px
  high; `pointer-events` none from `#hud`; dimmed with the scoreboard and
  hidden with the menu like the rest of the HUD.
- `hud.ts`: only the `killinfo` comment. README: feature line, and a note
  under Head-to-head.

Files: `src/client/src/killcard-text.ts` (new), `src/client/src/killcard.ts`
(new), `src/client/src/main.ts`, `src/client/src/settings/schema.ts`,
`src/client/index.html`, `src/client/src/style.css`, `src/client/src/hud.ts`
(comment), `README.md`,
`plans/admin-player-features-tools/smoke-killcard-d4.mts` (new),
`plans/new-features-1006-tools/check-killcard-layout-d4.mjs` (new) and its
README.

Verified:

- `npm run build`, `tsc --noEmit`, Prettier (es5 trailing commas) on the
  touched TS / CSS / HTML.
- `npx tsx plans/admin-player-features-tools/smoke-killcard-d4.mts`: card
  kinds (enemy, teammate, fall, self, own grenade, map, bomb, not mine,
  object victim), weapon labels / kinds, details and tags, duel / all-time
  / streak texts, `allTimeDuel`, `parseDuel`, `duelUrl` escaping, the bomb
  detector (both orders, kill event before / after, other reasons, window,
  reset). Other smoke tests (copies with the `/Users/wcarasas/...` path
  rewritten, scratchpad `d4/`): all pass except `smoke-msg23` (imports the
  removed `admin/message-text.ts`, as before) and `smoke-mode41`, which
  expects the presets before A.1 added Gun Game / Deathmatch (fails
  without this step's changes too; nothing here touches presets).
- Layout (headless Chromium, built page served statically, no game):
  `check-killcard-layout-d4.mjs` all ok at 1280×800, 1024×576, 844×390
  touch and 390×844 touch, with and without the Gun Game strip: card top
  below the crosshair, inside the viewport, clear of the clock and strip,
  all 6 lines shown, no sideways scroll, no pointer events. Screenshots in
  scratchpad `d4/`.
- **Not run in the game image:** the disk had under 400 MB free (the step
  required 1 GB), so no container was started.

Left / manual:

- In the game (image + headless tool, then two browsers and a phone): the
  card on a bot killing the local player (names, team colour, map line
  after several deaths, streak from 3, all-time line with
  `LEADERBOARD_BOTS=1`), `kill` in the console ("You killed yourself"), a
  fall, an own HE grenade, the bomb (check that the `alive` and `round`
  events come within 1.5 s), a team kill (`mp_friendlyfire 1`), staying
  up while spectating, hidden on respawn (Deathmatch) and at round start,
  the setting off / on, and on a real phone (touch controls around the
  card; in portrait the card can overlap the chat's right part while both
  show).
- cs16-client 0.0.10 (blocked, see A.4 / D.1): HP / armour / distance and
  the wall / blind tags on the card.

**In-game checks (done in the wrap-up, after E.5).** New headless check
`plans/new-features-1006-tools/check-killcard-d4.mjs` against the rebuilt
image, fresh server with `LEADERBOARD_BOTS=1` and 9 bots, desktop
(1280×800) and phone (`VIEWPORT=phone`, 844×390 touch):

- Deathmatch deaths to bots: "Killed by <bot>" with the bot's team class
  (`t`), the weapon, "This map: you 0 – n <bot>" counting up over the
  deaths (up to 0 – 3 against one bot), and "<bot> is on a n kill streak"
  exactly when the kill feed gives 3+ (seen 3, 4, 5 and 6), never below;
  the card 585–736 px in 800 (295–350 in 390), below the crosshair; hidden
  within a few ms of the respawn (~1 s after death in Deathmatch).
- `kill` → "You killed yourself", no duel lines. Killer card off in F3:
  no card on a death; on again: back.
- Classic rounds: the card stays up while dead / spectating (`alive`
  false, spectating true) and goes after 6 s; a round restart hides it
  (~1.5 s after the restart, well before the 6 s).
- **Bug found and fixed: the all-time line was often one too high.** The
  card asked `/duel` at the death and assumed the server didn't have that
  kill yet; in both of the first two test runs the log follower already had it
  (fresh server: first card "All time: 0 – 2" while "This map" said
  0 – 1, and every later card for that bot stayed one too high, server
  4 vs card 5). Fix (`killcard.ts`): `/duel` is asked once per killer per
  map **2.5 s after the death** (`FETCH_DELAY_MS`, past the follower's 2 s
  scan) and matched with the map's counts at that time, which include the
  kill. `allTimeDuel` (`killcard-text.ts`) now shows no line when the
  server has nothing from before this map (server − map counts at the
  fetch), since the server now includes this map's kills; new smoke case.
  Cost: when the card goes sooner than 2.5 s (Deathmatch / Gun Game
  respawn), the all-time line shows from the next death by that killer.
  README note updated. After the fix: no all-time line on a fresh server
  in any card; after a reconnect (`__engine.rejoin()`, which clears the
  cache like a new map without renaming the bots; a map change renames
  YaPB bots), the second death by an earlier killer showed "All time:
  0 – 4" with 2 deaths before and 2 after, then 0 – 5, equal to `/duel`.
- Not produced (the headless player can't move or aim): a fall, an own HE
  grenade, the bomb, a team kill; they stay manual (smoke-tested only).
- Seen here, fixed in the wrap-up rerun: in classic, while spectating,
  the engine's own "<name> (health)" spectator label is drawn in the same
  lower-centre spot and overlapped the card's title for its 6 s. On the phone size the
  engine's touch buttons (drawn as missing-texture squares in headless
  Chromium) sit under the card; it takes no input, so they still work
  (for the real-phone check).

### E.1 Design — done (design accepted as written, made concrete below)

Checked against Xash3D FWGS at the pinned `XASH3D_COMMIT` (`sv_client.c`
`SV_UserinfoChanged`, `infostring.c`), ReGameDLL `ClientUserInfoChanged` /
`SetClientUserInfoName`, AMXX `admincmd.sma` `cmdNick`, and this repo's
`admin.go`, `player.ts`, `statsdb.go`, `sfu.go`. Only the plan file changed.

**What the engine does to names** (the spec must match it):

- Userinfo values can't contain `\` or `"`, and a value with `..` is refused
  outright (the old name stays). Bytes ≤ 13 are dropped. `cl->name` is 32
  bytes, so names are cut at **31 bytes** (not characters; it can split a
  UTF-8 sequence). Leading/trailing ` \t\r\n` trimmed; empty or `console`
  → `unnamed`.
- A name already used by another spawned player (ASCII case-insensitive)
  becomes `"<name> (1)"`, `(2)`... So whoever joins second as "Walter" is
  "Walter (1)", **owner or not**.
- ReGameDLL, on a name change (not the first name): `%` and `&` → space,
  leading `#` → `*`; **while dead the change waits until respawn**
  ("#Name_change_at_respawn"), so E.4's rename of a dead impostor in the
  classic mode shows only next round (stats are dropped anyway).
- `^0`–`^9` are kept in the name (engine draws them as colours).
- Connect log line is
  `"Name<userid><slot><>" connected, address "A.B.C.D:port"` — the 3rd field is the **slot index, not the auth id**
  (E.3's regex), and the address is the netchan address (the SFU's
  made-up IP for players, `local` for bots). E.3 still checks it live.
- `amx_nick` = `set_user_info(player, "name", ...)` with
  `CMDTARGET_OBEY_IMMUNITY`; Xash's `pfnSetClientKeyValue` only marks the
  userinfo for resend. **E.4 must check in the image** that it really
  renames (look for the `changed name to` log line) before relying on it.

**Valid claim name** (`POST /names/claim`, 400 otherwise): valid UTF-8,
trimmed, 1–31 **bytes**; no `"` `\` `;`, no Cc control characters, no
`..`, no U+FFFD; key (below) not empty and not reserved: `console`,
`unnamed`, `player`, `player <digits>` (the page default / E.4 fallback),
anything ending ` (guest)`.

**`nameKey(name)`** (Go only, `names.go`; the page never normalises, it
asks `/names/status`), in this order: invalid UTF-8 → U+FFFD; remove
`^[0-9]` repeatedly until none is left; `%`, `&` and every
`unicode.IsSpace` rune (incl. NBSP) → space; drop Cf (zero-width space /
joiner, BOM, soft hyphen) and Cc runes; collapse spaces and trim;
`strings.ToLower` (Unicode simple lower); drop one trailing engine
duplicate suffix ` (<digits>)`; leading `#` → `*`. Checked in Go 1.22:

| name                                                                                                             | key                                           |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `Walter`, `" walter "` (spaces around), `WALTER`, `^1Wal^7ter`, `^^11Walter`, `Wal​ter`, `Walter `, `Walter (1)` | `walter`                                      |
| `Wal  ter`                                                                                                       | `wal ter`                                     |
| `Tom & Jerry`, `Tom   Jerry`                                                                                     | `tom jerry`                                   |
| `#Walter`, `*walter`                                                                                             | `*walter`                                     |
| `Ünal`, `ÜNAL`                                                                                                   | `ünal`                                        |
| `Walter (guest)`                                                                                                 | `walter (guest)` (reserved, can't be claimed) |
| `^1`                                                                                                             | empty (invalid)                               |

Not caught (accepted, say so in README): look-alikes from other scripts
(`Wаlter` with Cyrillic а), fullwidth `Ｗalter` (no NFKC: `x/text` isn't a
dependency and isn't worth adding).

**Secrets.** Device token: 32 bytes `crypto/rand`, cookie value base64url
without padding (43 chars; anything else is ignored without hashing).
Stored: hex SHA-256; looked up by hash (primary key), so no compare is
needed. Recovery code: 10 random bytes → 16 Crockford base32 chars
(`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, 32 symbols = 5 bits, 16 × 5 = **80
bits**), shown as `XXXX-XXXX-XXXX-XXXX`. Input: uppercase, drop `-` and
spaces, `O`→`0`, `I`/`L`→`1`; not 16 alphabet chars → 400 (not counted).
Stored: hex SHA-256 of the 16 canonical chars (no salt: 80 random bits);
compared with `subtle.ConstantTimeCompare` after loading the claim by key.

**Cookie** `wc_player`: `Path=/` (it must reach `/websocket` and
`/names/`), `HttpOnly`, `SameSite=Strict`, `Max-Age` 1 year, renewed by
`GET /names/me`; `Secure` with the admin rule (`r.TLS != nil ||
X-Forwarded-Proto: https`). The server only speaks plain HTTP (no TLS
config anywhere), so HTTPS means a reverse proxy. Strict cookies are kept
off the cross-site navigation of an invite link but sent on the page's own
fetches and WebSocket, so that's fine. A stale cookie (device row gone)
gets `{}` and an expired `Set-Cookie`.

**Requests.** POSTs: same as admin `checkPost` (POST, `sameOrigin`:
`Sec-Fetch-Site` same-origin/none, `Origin` host = `r.Host`; JSON
content type; 4 KiB body) — E.2 moves `checkPost` out of `adminAPI` into
a plain function both use. GETs: no origin check (like `/leaderboard`).
All `/names/` paths: `newRateLimiter(statusRate, statusBurst)` per
`clientKey`. Wrong codes (sign-in, release-all, unknown name counts too,
403 for both): a **separate** `newLoginLimiter(5, 5 min)`, 429 with
`Retry-After` when locked (same proxy caveat as admin). Claims: another
`loginLimiter(5, 1 h)` with `fail()` on each successful claim, so one
address can't hoard names. Database off → every `/names/` path 404.

**Device rules (decision).**

- `claim` on a device that already has a **different** name → 409
  `{error: "device_has_name", name}`; same for `signin`. Never switch
  silently: it could orphan a name whose code wasn't saved. The UI offers
  "Release this device" first. Sign-in to the name it already has → 200.
- `release {}` → deletes this device row, clears the cookie; the claim
  stays (code still works).
- `release {all: true, code, name?}` → `name` defaults to this device's;
  deletes the claim and all its devices (other browsers get `{}` next
  time). Usable without any device, with just the code.
- Claim race: `INSERT` claim + device in one transaction; the
  primary-key conflict → 409 `{error: "taken"}`.

**Leaderboard (decisions).**

- Rows stay keyed by exact name (`players.name`, binary). Stats of a
  connection that owns a claim go to the row named **`claims.name`** (the
  claimed spelling), whatever case/colour/dup-suffix variant they play
  under; same for `duels`, `gg_wins`, and `/duel` maps a claimed name's
  key to `claims.name`. Other variant rows ("walter" next to claimed
  "Walter") are frozen: nobody can add to them any more.
- `claimed: true` only on the row whose name equals a `claims.name`.
- **Release (admin, or with the code): the row is kept** as is, loses the
  ✓, and goes to whoever claims that name next (same "first claim wins"
  rule). No stats are deleted.
- Bots get no claim (address `local`): bots with a claimed name have their
  stats dropped and are renamed like players.

**Changes to the later steps.**

- E.3: store the device **token hash** on the session / `peerSlot`, not
  the `name_key`, and check "device row exists and points at this key" when
  tallying (cached per pass). Otherwise a released and re-claimed name
  would still count for the old claimant's open connection.
- E.4: the rename command is built by the follower:
  `amx_nick #<userid> "<name> (guest)"` cut to 31 bytes on a rune boundary; if that has `"`
  `\` `;` or Cc, or its key is claimed, `Player <userid>`. Don't send it
  through `safeCommandPattern` (ASCII only). The key's dup-suffix rule
  means the owner who joined second as "Walter (1)" still owns; E.4 may
  rename them back to the claimed name once it's free (optional).
- E.5: `release_claim` uses the existing `run` path of admin actions (like
  the bans), not a console command — no conflict.

**Genuine conflict with existing code:** `sanitizePlayerName`
(`player.ts`) cuts at 31 **code points**, the engine at 31 **bytes**; a
long non-ASCII name is cut mid-character in game, its key no longer
matches the claim and the owner's play isn't counted. E.5 (or E.2's page
part) changes it to cut at 31 UTF-8 bytes on a code-point boundary (it
should also drop `..`, which the engine refuses on a name change).

Verified: engine / ReGameDLL / AMXX source read (clones since deleted:
the disk is full, ~150 MB free); `nameKey` and the code generator run in
`golang:1.22-bookworm` (scratchpad `e1/main.go`), giving the table above
and codes like `23TX-0Y0E-B47N-X4S3`. Left: the live checks named above
(E.3 connect line, E.4 `amx_nick`).

### E.2 Storage and API — done

Implemented E.1's spec as written. Files: `src/server/names.go` (new),
`src/server/names_test.go` (new), `statsdb.go` (migration 3), `admin.go`
(`checkPost` is now a plain function; `httpsRequest(r)` holds the Secure
rule both cookies use), `sfu.go` (`Server.names`, `/names/` prefix → 404
when nil; `runSFU(..., leaderboard, duel, names)`), `main.go`
(`newNamesHandler(db)` next to the leaderboard), README (a "Claimed names"
paragraph under the leaderboard: endpoints, matching, cookie, limits, what
it doesn't protect; no new env vars, `DATA_DIR`'s volume keeps claims).

- **Schema** (migration 3, one statement list):
  `claims (name_key PK, name, code_hash, created)`,
  `devices (token_hash PK, name_key, created, last_seen)` + index `devices_by_name`. No foreign keys (SQLite doesn't
  enforce them by default); releases delete devices explicitly, and every
  device lookup joins `claims`, so a device row without a claim is ignored.
- **Endpoints** as in E.1. Responses: claim `{name, code}` (name = the
  trimmed spelling kept for display), signin `{name}`, release `{}` /
  `{released: name}`. Errors are `{error: <code>, message}`: 400
  `invalid_name` / `invalid_code` / `bad_request`, 403 `wrong_code`, 409
  `taken` / `device_has_name` (+ `name`) / `no_claim` (released between the
  code check and the write), 429 `rate_limited` / `locked_out` /
  `too_many_claims` with `Retry-After`, 413 for a body over 4 KiB.
  `checkPost`'s own refusals (405/403/415) keep the admin shape
  `{error: "<message>"}`.
- **Decisions beyond E.1:** claiming the name the device already has → 409
  `taken` (status says `mine`). Sign-in to the name the device already has
  → 200 without checking the code (keeps the cookie). Claim and sign-in
  always mint a new token (a stale cookie's row is replaced). A correct code
  does **not** reset the wrong-code counter (stricter than the admin
  login). Order in claim: name validity (400, not counted) → claim limiter
  → transaction; in sign-in: device check (409/200, not counted) → lockout
  → code format (400, not counted) → code (403, counted; unknown name
  counts too). Release `{}` without a cookie is 200 and sets no cookie;
  release-all clears the cookie only if this browser had that name.
  `/names/status` with no name or > 64 bytes → 400; a name whose key is
  empty → `{claimed: false, mine: false}`. `/names/me` updates `last_seen`
  and renews the cookie; a malformed or stale cookie gets `{}` and an
  expired cookie (`Max-Age=0`). Device token stored as hex SHA-256 of the
  32 raw bytes; code as hex SHA-256 of the 16 canonical characters.
- **Internal API for E.3–E.5** (all in `names.go`):
  - `deviceTokenHash(r *http.Request) (hash string, ok bool)` — the
    `wc_player` cookie's hash (E.3: call it in `websocketHandler`, store
    the hash on the session / `peerSlot`).
  - `(*statsDB).ownsClaim(ctx, tokenHash, key) (bool, error)` — device row
    exists, points at `key`, and the claim exists (E.3/E.4 tally check).
  - `(*statsDB).deviceClaim(ctx, tokenHash) (nameClaim, bool, error)` —
    the claim a device is signed in to.
  - `(*statsDB).claimByKey(ctx, key) (nameClaim, bool, error)` — isClaimed
    and the claimed spelling (`nameClaim{Key, Name, CodeHash, Created}`).
  - `(*statsDB).claimedNames(ctx) (map[key]name, error)` — for a per-pass
    cache in the follower and the leaderboard's ✓ (E.4/E.5).
  - `(*statsDB).releaseClaim(ctx, key) (name string, ok bool, error)` —
    deletes the claim and its devices, keeps stats (E.5 `release_claim`).
  - `nameKey(name)`, `claimNameProblem(name) string`,
    `reservedNameKey(key)`, `trimName(name)`, `nameMaxBytes` (31).
- **Verified:** `gofmt -l` clean, `go vet` and all Go tests pass
  (scratchpad `a1/gotest.sh`, image `local/cs16-go-test`; `-race` isn't
  available on linux/386). New tests: `nameKey` with E.1's table plus NBSP,
  soft hyphen, BOM, `%`, `(1) (2)`, invalid UTF-8 and the look-alikes that
  are _not_ caught; name validity incl. 31/32 bytes and multi-byte;
  Crockford encoding vectors, code round trip, sloppy input (case, spaces,
  O/I/L), hashing and `codeMatches`; token parsing; claim flow and stored
  hashes; cookie flags over plain HTTP, `r.TLS`, `X-Forwarded-Proto`
  (and renewal by `/names/me`); same-origin / content-type / method
  refusals; `device_has_name` for claim and sign-in; sign-in; wrong-code
  lockout (5th → 429, `Retry-After`, right code refused while locked,
  other address fine, IPv6 /64 shared, unlocked after 5 min); claim limit
  (5/hour, refused/invalid claims not counted); release variants (device,
  all with code, default name, from another browser, wrong code, stale
  cookies after release, re-claim by someone else); claim race (16 at once
  through the handler, and 16 through two separate connection pools on one
  file: exactly one wins); rate limit and 404 with the database off;
  internal API; migration from a version-2 database (totals and duels
  kept, reopening doesn't rerun). Live: built the server binary in
  `local/cs16-go-test`, ran it in `local/cs16-web-server:latest` with the
  binary mounted over `/xashds/xash`, and checked with curl: claim (cookie
  `Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`, `Secure` with
  `X-Forwarded-Proto: https`), me, status (owner / other), 409 `taken`, 403
  cross-origin, 409 `device_has_name`, wrong codes
  `403 403 403 403 429 429`, `/leaderboard` still 200, the claim survives a container restart,
  release device; audit lines `names: <addr>: claimed "..."` on stderr.
- **Left for later steps:** the page side (E.5, incl. `sanitizePlayerName`
  cutting at 31 bytes), E.3/E.4 enforcement. The image wasn't rebuilt (the
  binary was swapped in for the check).

### E.3 Knowing who is playing — done

Files: `src/server/sfu.go`, `statslog.go`, `statsfollow.go`, `main.go`
(follower gets `gamePeers{}`), tests in `sfu_test.go`, `statslog_test.go`,
`statsfollow_test.go`; tools: `plans/new-features-1006-tools/check-names-e3.mjs`
(new), `pw.sh` (passes `ZIP_PORT`), tools README. No README change (no new
feature, cvar or env var yet).

**Captured in the image first** (stock image + a browser player via the
headless tool, then a `changelevel`):

```
"blueguile<1><0><>" connected, address "local"
"Capture<3><2><>" connected, address "0.84.74.120:12345"
"Capture<3><ID_7dea362b3fac8e00956a4952a3d4f47><>" entered the game
-- changelevel: new file L1007002.log --
"Capture<4><2><>" connected, address "0.84.74.120:12345"
```

- The address **is** the SFU's made-up address; bots are `local`. Its
  first byte is the **SFU connection index** (`connections`), which is not
  the engine slot in the third field (`Walter<4><3><>` came from `1.51.81.184`).
  Lookup is by the address, never by the slot field.
- On a map change every player and bot connects again **in the new file
  with a new userid** (same address: the WebRTC connection stays). So
  userid → device kept per file works without carrying anything across
  files.
- Human auth ids are `ID_<hash>` and were the same for two different
  headless browsers: useless for identity (as expected).

**What was built.**

- `websocketHandler` calls `deviceTokenHash(r)` (E.2) and keeps the hash on
  `gameSession.device`, copied into `peerSlot.device` ("" without a valid
  cookie). Only the hash; which name it owns is looked up later (E.1).
  `gamePeers.deviceOf(ip) (hash, ok)`: ok only if `connections[ip[0]]`
  `.owns(ip)` (same connection, not a reused slot).
- `statslog.go`: `logConnected` from
  `"Name<userid><slot><>" connected, address "..."` (address in `Value`, slot in `Player.Auth`, unused);
  `logAddressIP` reads `A.B.C.D:port` (`local`, IPv6, junk → not ok).
- `statsTally`: `peers peerDevices` (interface with `deviceOf`; nil in
  tests = nobody has a device) and `devices map[userid]hash`. A connected
  line first forgets that userid's device, then sets it if the address is
  still a connected SFU player with a cookie; `disconnected` and `reset`
  (new file, `Server shutdown`) forget. Replayed lines (count false)
  resolve too, so a follower that re-reads a file (after a commit error)
  gets the devices back while those players are still connected.
  `t.device(userid) (hash, ok)` is the accessor for E.4.
- One stderr line per counted connect with a device:
  `leaderboard: #4 "Walter" connected with device c37431f4` (first 8 hex
  of the hash, for checking; never the token).
- Robustness: reconnect / userid reuse → the latest connected line wins;
  log rotation → per-file state; a player who left before the follower
  read the line (≤ 2 s) → no device (owns fails, so a reused slot never
  inherits someone's device). **Server restart mid-file:** the engine runs
  in the same process, so the tail of the old file is from players who are
  gone: no device for them (under E.4 their lines for a claimed name are
  dropped; unclaimed names count as today). Accepted.

**Not enforced** (E.4): nothing in the totals changes yet. E.4 needs, per
pass: `claimedNames` (key → name), and for a player under a claimed key,
`t.device(userid)` + `ownsClaim(hash, key)` (cached per pass).

**Verified.** `gofmt -l` clean, `go vet` and all Go tests pass (scratchpad
`a1/gotest.sh`, `local/cs16-go-test`). New tests: parsing the captured
lines (player, bot, a name containing `<1><2><>`), `logAddressIP`;
`gameSession` → `peerSlot.device` → `deviceOf` (with/without cookie, other
address in the same slot, after release); tally: device per userid, no
cookie, peer gone, userid reused, map-change reconnect, disconnect,
shutdown, replay without logging, no peers; follower across two files and
two follower restarts (device found again by replay while connected, not
after the player left). **Live:** built the binary in `local/cs16-go-test`,
mounted it over `/xashds/xash` in `local/cs16-web-server:latest` with 2 bots,
ran `check-names-e3.mjs` (owner claims "Walter" through
`POST /names/claim`, joins; a guest browser without cookie joins; then a
`changelevel`): token hash `c37431f4e881…`, server stderr
`leaderboard: #4 "Walter" connected with device c37431f4` and after the
map change `#5 "Walter" ... c37431f4`, nothing for Guest or the bots. So
the `SameSite=Strict` cookie does reach the game WebSocket. The image
wasn't rebuilt (binary mounted, as E.2 did).

### E.4 Enforcing the claim — done (phone and real-browser checks left)

Files: `src/server/statsfollow.go` (tally rules, renames, chat lines),
`main.go` (a console for the follower), `duel.go` (`/duel` mapping),
`sfu.go` (comment), tests in `statsfollow_test.go` and `duel_test.go`;
`src/amxx/wc_statslog.sma` (1.1: logs name changes); page:
`src/client/src/name-status.ts` (new), `index.html` (`#nickname-status`),
`style.css` (`.field-note`), `main.ts` (`startNameStatus()`); smoke test
`plans/admin-player-features-tools/smoke-names-e4.mts`; browser check
`plans/new-features-1006-tools/check-names-e4.mjs` (+ tools README); README
(claimed names: what is enforced, `/duel` mapping, `wc_statslog` row).

**Checked in the image first** (stdin console, then the real path):
`amx_nick #<userid> "<name>"` does rename on Xash3D, players and bots, in
team select, alive or dead. But **the game writes no `changed name to`
line on this engine**, neither for amx_nick nor for a player's own `name`
command: Xash's `SV_UserinfoChanged` points `netname` at `cl->name` and
updates it before calling the game DLL, so ReGameDLL sees no change (so
also none of E.1's ReGameDLL name rules apply, and no "change at respawn":
dead players are renamed at once). Hence `wc_statslog.amxx` now logs the
stock line from `client_infochanged` (AMXX still has the old name; team
"" when unassigned). Also seen: (a) Xash ignores a userinfo change that
comes too soon after the player's own (`sv_userinfo_penalty_*`) but keeps
the new value in the userinfo, so repeating the same amx_nick changes
nothing (it happened twice in ~6 runs: "WALTER (1)" stayed); (b) the
engine logs "entered the game" while the page still shows the loading
screen (23 s in headless Chromium) and the page's HUD `reset` clears the
chat feed when the game shows, so a chat line sent at join is never seen.

**Rules (as built).**

- Tally (`statsTally.rowName`): claims read once per scan
  (`claimedNames`), `ownsClaim(t.device(userid), key)` cached per scan per
  (device, key). Name's key claimed → counts only for the owning device and
  goes to `claims.name`; otherwise dropped entirely (bots never own). Used
  for kills, deaths, headshots, suicides, teamkills, rounds, Gun Game wins
  and duel pairs (both sides mapped). A DB error in `ownsClaim` aborts the
  scan before commit (re-read next time), never counts an impostor.
- `/duel`: each name whose key is claimed is looked up under
  `claims.name` (`claimedRowName`).
- Renames: any counted line showing a player under a claimed name they
  don't own (entered, kill/victim, headshot, suicide, team, say/triggered,
  Gun Game win, name change) asks for one rename; then nothing more for
  that userid until a line shows them under a free name (`pending`), at
  most 3 per userid per file. Only for **live** files (mtime ≥ follower
  start; the tail of a file from a previous engine is never acted on) and
  never on replayed lines. The follower runs
  `amx_nick #<userid> "<guestName>"` after the chunk's commit; `guestName` = name (invalid
  UTF-8 dropped, trimmed) cut to 23 bytes on a rune boundary + " (guest)",
  or `Player <userid>` if that has `" \ ; $ %`, `//`, `..`, Cc, U+FFFD or
  is claimed. Both are reserved keys, so the rename's own line can't loop.
- Chat line `amx_psay` (through the admin message alias) 3 s after the
  rename, on a later scan; if the player had no team when renamed, 3 s
  after their team appears. If the last line still shows the claimed name
  when it is due, the rename didn't take: retried as `Player <userid>`
  (a different value, see (a)) within the cap. Dropped if the player left
  or the file changed. It shows as "(Walter (guest)) My CS 1.6 Web
  Server : That name is claimed. Sign in from Settings to use it."; amx_nick
  also shows AMXX's "ADMIN ...: change nick of X to Y" to everyone.
- Console: the follower uses the admin API's in-process rcon console;
  with the admin API off, `main.go` now makes one anyway when the
  leaderboard DB opens (keeps `RCON_PASSWORD` if valid, else a random
  password and `blockPlayerRcon`). Errors are logged once.
- Page: `name-status.ts` asks `/names/status?name=` (sanitized name, ≤ 64
  bytes) 400 ms after typing stops and once at start for the saved name;
  shows "This name is claimed by someone else" (`--danger`) or "✓ yours"
  (`--gain`) under the field; nothing on unclaimed / 404 / errors; stale
  answers dropped.
- Not done (optional per E.1): renaming an owner who joined second as
  "Walter (1)" back to the claimed spelling (they own it and count anyway).

**Verified.** `gofmt -l` clean, `go vet` and all Go tests pass (scratchpad
`a1/gotest.sh`). New tests: tally with owner (all spellings), other
device, no cookie, bot, owner under an unclaimed name, unclaimed-only
tally; rounds; duels mapping; ownership cache and DB error; renames
(enter, reserved names don't loop, change to a claimed spelling, owner
not renamed, fight-back cap, any-line trigger once until free, disconnect,
replay and old files, new file); `guestName` table (cut, multi-byte,
broken UTF-8, unsafe → fallback, claimed guest name) and commands;
follower with a real DB: totals, duels, rename + delayed chat line, retry,
waiting for a team, release / re-claim by another device, console errors
logged once, map change drops pending lines, old file; `/duel` mapping
with a real DB. `npm run build` passes; `smoke-names-e4.mts` passes (npx
tsx). `.sma` compiles with no warnings. **Live**, image rebuilt
(`local/cs16-web-server:latest`), two headless browsers with
`check-names-e4.mjs` (Deathmatch, 2 bots): owner's page "✓ yours", guest's
"This name is claimed by someone else"; guest joined as Walter, renamed to
"Walter (guest)" 1–2 s after "entered the game" (status.json showed it
within ~100 ms of the HUD); chat line shown after joining a team; owner
joined as Walter, never renamed (`connected with device ...`); `name
WALTER` + `kill` by the guest → "WALTER (1)", renamed to "WALTER (1)
(guest)" 1 s later, chat line shown; leaderboard `Walter` 0/4 = exactly
the owner's 4 suicides, `Walter (guest)` 0/3, the guest's death as
"WALTER (1)" counted nowhere. Human kills couldn't be scripted (headless
players don't aim); kill counting goes through the same `rowName` (Go
tests). The retry (penalty case) is covered by tests only: it couldn't be
reproduced on purpose afterwards.

**Left:** phone and real desktop browser checks; E.5 (settings UI,
leaderboard ✓, admin release, `sanitizePlayerName` 31-byte cut). Note for
E.5: the page clears its chat on the HUD `reset`, so anything said to a
player at join must wait (as here, for a team).

### E.5 UI — done (phone and real two-browser checks left)

Files: page `src/client/src/names/api.ts` (new, no DOM: the `/names/` calls
and an error text for every E.2 code), `names/index.ts` (new: the F3
section), `settings/index.ts` (section under the invite link, refreshed on
open), `player.ts` (`sanitizePlayerName` cuts at 31 UTF-8 bytes,
`currentPlayerName`, `savePlayerName`, `setPlayerNameField`),
`name-status.ts` (`recheckNameStatus`), `invite/index.ts` (`copyLink`
exported), `leaderboard.ts` (✓, note), `admin/actions.ts`, `admin/core.ts`,
`admin/players.ts` (Claimed names list), `webrtc.ts` (`rejoin()`),
`main.ts` (rejoin handler), `style.css`; Go `leaderboard.go` (`claimed`),
`admin_names.go` + `admin_names_test.go` (new), `admin_actions.go`
(`actionEnv.claims`), `admin_bans.go` (`actionResult.Claims`), `main.go`
(the admin API gets the DB once it opens), `leaderboard_test.go`; README
(feature line, leaderboard `claimed`, the UI, admin release, what a claim
doesn't protect); smoke `plans/admin-player-features-tools/smoke-names-e5.mts`;
tools `check-names-e5.mjs`, `run-server.sh` (`DATA_VOLUME`), tools README.

- **F3 "Your name"** (hidden when `/names/me` is 404): no name → "Claim
  “<nickname>”" (disabled without a nickname), "Sign in with a recovery
  code" (name + code), "Release a name" (name + code). After a claim only
  the code shows (Copy code, "I saved it"; kept across closing the panel,
  lost on reload). With a name: "Release this device" (asks first) and
  "Release the name" (code; name defaults to this browser's). Every E.2
  code has its own message; `device_has_name` switches the panel to that
  name, so "Release this device" is offered; a malformed code is refused in
  the page (not sent, not counted). Sign-in on the login page also puts the
  claimed spelling in the nickname field; claim / sign-in / release ask
  `/names/status` again for the nickname note.
- **Decision: claiming in game.** The game connection's device is read when
  its WebSocket opens (E.3), so a claim made in game would get the player
  renamed as a guest. The panel says so and offers **"Rejoin now"**:
  `Xash3DWebRTC.rejoin()` drops the connection, the existing reconnect path
  opens a new WebSocket (with the cookie) and joins again under the claimed
  name (saved as the nickname). Checked live.
- **Leaderboard:** `claimed` per entry (exact `claims.name` match, so
  "walter" next to claimed "Walter" has none; a failed claims query just
  shows no marks); the page shows a green ✓ after the name (kept visible
  when the name is cut) and says "✓ marks a claimed name..." under the table
  when one is listed.
- **Admin:** `{"action":"claims"}` →
  `claims: [{name, created, devices, lastSeen}]`, `{"action":"release_claim","name"}` (any spelling, through
  `nameKey`; not claimed → 200 "wasn't claimed"; DB off → 503); both use the
  `run` path, no console command. F4 → Players → "Claimed names" with
  Release + confirm (API mode only, like the bans).
- **`sanitizePlayerName`** (E.1 conflict fixed): drops lone surrogates,
  turns `..`+ into `.`, cuts at 31 UTF-8 bytes on a code point boundary
  (`cutToBytes`), then trims; its output always passes `claimNameProblem`.

**Verified.** `gofmt -l` clean, `go vet` and all Go tests pass (scratchpad
`a1/gotest.sh`, `local/cs16-go-test`): new tests for the ✓ (exact spelling
only, claims query failing), `release_claim` / `claims` with a real DB
(device counts, last seen, release by another spelling, both browsers lose
it, row kept without ✓ and re-claimable, unclaimed name, bad fields, no
DB → 503, logged out → 401). `npm run build` and `tsc` pass; Prettier
(es5) clean on the touched files; `smoke-names-e5.mts` and
`smoke-names-e4.mts` pass (`npx tsx`). Live, image rebuilt, headless
`check-names-e5.mjs` all phases ok with a `DATA_DIR` volume: A claims
Walter in F3 (code, copy, "I saved it", ✓ yours), device_has_name and
wrong-code messages; B joins as Walter → "Walter (guest)", in-game claim
says taken; A plays as Walter, not renamed, leaderboard Walter 0/3
`claimed: true` (B's death went to "Walter (guest)"); a player claims
"Rex" in game, "Rejoin now" → back as Rex with `connected with device`,
not renamed; A's second browser signs in with "walter" + the code typed in
lowercase with spaces → nickname "Walter", ✓ yours, leaderboard ✓; new
container on the same volume → both still signed in, row and ✓ kept; A
releases this device; A2 plays as Walter; F4 lists Walter and Rex, Release
Walter → A2 loses it, leaderboard row kept with `claimed: false`; B
releases Rex with its code. `engine` phase: "Wal..ter " + 20 × é shows in
`status.json` as "Wal.ter " + 11 × é (30 bytes), exactly the page's cut.
Containers, the test volume and dangling images removed.

**Left:** phone layout of the section (only desktop width seen) and real
two-browser / real-proxy (HTTPS `Secure` cookie) checks by hand.

### Wrap-up — done

- **D.4 in-game checks** (deferred from D.4 for disk space): done with the
  new `check-killcard-d4.mjs`; one bug found and fixed (the all-time line
  one too high). Details at the end of D.4's entry.
- **Stale smoke tests.** `smoke-mode41.mts` now expects the seven presets
  of A.1 (`gungame` / `deathmatch` set `wc_weaponmode 0`) and checks their
  `wc_gamemode` (0 for Casual / Competitive / Warmup, 1 Gun Game, 2
  Deathmatch, unset for Knife / Pistols only). `smoke-msg23.mts`:
  `message-text.ts` moved from `src/client/src/admin/` to
  `src/client/src/` in commit 149b742 (HTML chat feed, which added the chat
  rules next to the admin ones); the test imports it from there and its
  output is unchanged (admin message checks, `amx_say` / `amx_csay` through
  the alias). It only prints, as before.
- **Paths.** Every smoke test now imports `../../src/...` (relative to the
  test file, so it works from any checkout, the Mac included) instead of
  `/Users/wcarasas/Repos/Walcc.CounterStrike/src/...`; `gotest.sh` does
  `cd "$(dirname "$0")/../.."` (ran it here from another folder: gofmt,
  vet and all tests pass). `console-run.sh` / `console-cmd.sh` (spike
  tools with a scratchpad path and an old image) left as they were.
- **Tools:** `run-server.sh` takes `LEADERBOARD_BOTS`; `pw.sh` passes
  `VIEWPORT` and `DEATHS`; `lib.mjs` `newPage` takes `touch` (isMobile +
  hasTouch); `check-names-e5.mjs` `engine` polls `status.json` for up to
  60 s instead of a fixed 4 s; the 0.0.10 bridge sketch copied into the
  tools folder; tools README updated (and made Prettier-clean).
- **Plan file** made Prettier-clean (repo `.prettierrc`, Prettier 3) with
  the meaning kept: three lines starting with `+ ` (which Prettier would
  turn into list items) and code spans broken across lines were rewrapped
  by hand first; the table of name keys writes `" walter "` with quotes
  (Prettier trims the spaces in `` ` walter ` ``).

Regression (image rebuilt with everything up to E.5 plus the D.4 fix):

| Check                                                                                   | Result                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16 smoke tests (`npx tsx plans/admin-player-features-tools/smoke-*.mts`)                | pass (all 16)                                                                                                                                                                                                                                                                                                             |
| `gofmt -l`, `go vet`, `go test ./src/server/...` (`gotest.sh`, `-count=1`)              | pass                                                                                                                                                                                                                                                                                                                      |
| `npm run build`, `tsc --noEmit`                                                         | pass                                                                                                                                                                                                                                                                                                                      |
| `docker build --target amxx-plugins` (no cache for the stage)                           | pass: 4 plugins, no warnings                                                                                                                                                                                                                                                                                              |
| `check-gamemode.mjs`                                                                    | pass                                                                                                                                                                                                                                                                                                                      |
| `check-leaderboard.mjs` (real Gun Game win, ladder `deagle;ak47`, `LEADERBOARD_BOTS=1`) | pass, desktop and phone                                                                                                                                                                                                                                                                                                   |
| `check-announcer.mjs`                                                                   | pass in the rerun, twice in a row (23 checks each); earlier the first of two runs failed one synthetic step (a round start after the bots were kicked reopened first blood, so the "headshot" kill played first blood: right by the rules, a timing flake of the check). It didn't recur, so the check is unchanged       |
| `check-settings-c3.mjs`                                                                 | pass                                                                                                                                                                                                                                                                                                                      |
| `check-killcard-layout-d4.mjs`                                                          | pass, all sizes, now also while spectating (rerun with the card fix)                                                                                                                                                                                                                                                      |
| `check-killcard-d4.mjs` phone (`VIEWPORT=phone`)                                        | pass (again in the rerun, with the spectating fix)                                                                                                                                                                                                                                                                        |
| `check-killcard-d4.mjs` desktop                                                         | pass: a clean run of the final script in the rerun, on the rebuilt image (`WAIT_SCALE=2`: the two runs before it got only 5 of the 6 deaths in the window, and then no repeat killer after the reconnect, on the slow host; every card check passed in those too). "All time: 0 – 5" after the reconnect equal to `/duel` |
| `check-names-e5.mjs` setup, guest + owner, rex, second                                  | pass (again in the rerun, on a fresh `cs16-e5` volume, guest and owner at the same time)                                                                                                                                                                                                                                  |
| `check-names-e5.mjs` after                                                              | pass in the rerun, all 17 checks, including F4 Claimed names → Release and B releasing Rex with its code                                                                                                                                                                                                                  |
| `check-names-e5.mjs` engine                                                             | pass in the rerun: `"Wal.ter ééééééééééé"` (30 bytes) in `status.json`, exactly the page's cut                                                                                                                                                                                                                            |

**Headless tool stopped working near the end.** From about 17:00 the
headless browser no longer got into the game: the game files took ~200 s
to load instead of ~30 s and the engine stayed on "Setting up
renderer..." (the host had a load of ~6 from outside this sandbox).

**Rerun (evening, same image, then rebuilt with the two fixes below).**
The host's load average was low but its CPU still contended: `vmstat`
showed 20–80 % steal while a check ran, a join took 3–4 minutes, and the
first few joins went to the main menu without entering the game (the
connection never got past signon). Two things made it work again:
waiting longer (`joinGame` now waits up to 8 minutes) and never leaving a
Playwright container running: a `pw.sh` killed by `timeout` leaves its
container (Chromium plus the engine) running, and it slowed every later
run. Both are in the tools README. Results (table above): `probe.mjs`
joins; `check-killcard-d4.mjs` desktop clean (with `WAIT_SCALE=2`, a new
option that doubles its waits for deaths) and phone; `check-names-e5.mjs`
all phases, `after` and `engine` included; `check-announcer.mjs` twice,
no flake; the smoke tests, `npm run build` and `tsc --noEmit` pass.

Fixed in the rerun:

- **F4 admin menu:** the "Admin password" field and Log in button stayed
  visible after logging in (`#admin-auth` has class `field`,
  `display: flex`, which beats its `hidden` attribute). `style.css`:
  `.field[hidden] { display: none }`. New headless check
  `check-admin-auth.mjs`: field and Log in shown when logged out, hidden
  after logging in ("Logged in as admin." and Log out instead), shown
  again after Log out: pass.
- **"Killed by" card under the engine's spectator label.** While
  spectating, cs16-client (`cl_dll/hud/spectator_gui.cpp`) darkens the top
  and bottom fifth of the screen (`INT_YPOS(2)` of a 10-unit box) and
  writes "<name> (health)" centred in the bottom bar (`INT_YPOS(9)`, 90 %
  of the height); the card (bottom 4.6em up) sat on it. `hud.ts` now sets
  `#hud` `data-spectating` from the `alive` event, and while it is
  `true` the card's bottom is `max(--kc-bottom, 20% + 0.5em)` (its
  max-height follows), so it sits just above the bar; otherwise
  unchanged. Checked: `check-killcard-layout-d4.mjs` with new spectating
  cases (card bottom 632 of 800, 455 of 576, above the bar at every size,
  all six lines shown) and in the game: the spectating screenshots show
  the card at about 600–620 px and the label at 717 px in 800 (desktop),
  about 298 and 349 px in 390 (phone), no overlap.

Containers and the test volumes removed after the runs (both times).

## Open questions

- A.0: decided: ReGameDLL (see Progress).
- A.5: decided: one shared leaderboard plus a Gun Game wins column (see
  Progress); a per-mode filter can still be added.
- B.3: final map cycle, and whether fun maps should be in the cycle at all
  or only in the Map tab / vote.
- C.2: should being knifed play a sound? C.2 took the default: yes, the
  shorter `knifed` (see Progress); easy to drop in `announcer-rules.ts`.
- E.1: took the default (design as written; see Progress): one name per
  device (a second claim / sign-in is refused until "Release this
  device"), first claim gets the existing row, release keeps the row.
