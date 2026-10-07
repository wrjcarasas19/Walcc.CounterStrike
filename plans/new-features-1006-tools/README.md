# Headless browser checks (new-features-1006)

Drives the real web page in headless Chromium (Playwright in Docker)
against the image, including the game itself: the engine renders through
WebGL on SwiftShader, connects over WebRTC and joins the server. Made
during the gap fixes after A.4; use it for any step that changes the page
or what a player sees.

## Files

- `run-server.sh [map] [bots]`: starts `local/cs16-web-server:latest`
  (`--platform linux/386`) as container `cs16-headless` with the page's
  ports on the host (27016 HTTP, 27018 WebRTC) and waits for
  `/status.json`. Env: `NAME`, `IMAGE`, `ADMIN_PASSWORD` (default
  `headless-admin`), `DATA_VOLUME`, `LEADERBOARD_BOTS`.
- `pw.sh <script.mjs>`: runs a script in `mcr.microsoft.com/playwright:v1.63.0-noble`
  with `--network host` (so `127.0.0.1:27016` and the WebRTC port are the
  server's). Installs `node_modules` here on first use. Screenshots go to
  `$OUT` (default `./out`). Env passed in: `BASE`, `ADMIN_PASSWORD`,
  `VERBOSE=1` (log every page console line, not just errors), `ZIP_PORT`
  (the local game-zip server, default 27090: give a second `pw.sh` running
  at the same time another one).
- `admin.sh '<json action>'`: one admin API action from the shell (logs in
  with `ADMIN_PASSWORD`), e.g. `./admin.sh '{"action":"restart"}'`.
- `lib.mjs`: helpers. `launch()`, `newPage(browser, {width, height, touch})`,
  `shot(page, name)`,
  `joinGame(page, {name})` (types the nickname, Download, Connect, waits for
  the HUD), `waitForPlayer(name)` (polls `/status.json`),
  `engineCommand(page, 'jointeam 2')` (console command in the game),
  `openAdmin(page)` (F4 and log in), `pressKey(page, 'F3')`,
  `adminAction({...})`, `webglInfo(page)`.
- `probe.mjs`: smoke test of the tool (WebGL renderer, login page, join).
- `check-gamemode.mjs`: game modes on the page (lobby line, F4 Match tab
  notes and presets, Knife only refused in Gun Game, a preset's single
  restart, F3 settings, the Gun Game HUD line of the 0.0.9 client). Leaves
  the server in Deathmatch.
- `check-leaderboard.mjs`: the login page's "Top players" table (A.5) at
  desktop and phone size: the GG (Gun Game wins) column matches
  `/leaderboard`, no sideways scroll. Needs a server whose leaderboard
  has rows (e.g. a short-ladder Gun Game with `LEADERBOARD_BOTS=1`).
- `check-announcer.mjs`: the announcer (C.2): no sound file fetched on the
  login page, all 16 `.webm` after joining; a sound is dropped while the
  AudioContext is suspended and plays after a key (headless Chromium never
  enforces the autoplay policy, so the test page's AudioContext is made to
  start suspended); a real first blood by bots after a round restart (sound +
  toast, once); live `scores` without the scoreboard; then, with the bots
  kicked, synthetic bridge events through the page's own `hudEvent`:
  headshot, multi-kills (no headshot sound with them), streaks, humiliation,
  knifed, a lower priority sound dropped, last man standing, and the Gun
  Game `mode` sounds. Reads the page's `console.debug("announcer: ...")`
  lines. Leaves the server without bots.
- `check-settings-c3.mjs`: the announcer settings (C.3): the three
  controls in the Sound group (login page and F3 in game) and their
  defaults; values kept across reloads; at volume 0 no sound file fetched
  after joining, no live `scores`, a real first blood only toasts; volume
  up in game loads the 16 sounds and starts live scores; "Hear other
  players' first blood" off / on with the bots' real first blood;
  "Announce headshots" off / on and volume 0 in game with synthetic kills.
- `check-killcard-layout-d4.mjs`: layout only, no game or server (D.4):
  serve the built page (`python3 -m http.server 27099 -d src/client/dist`,
  then `BASE=http://127.0.0.1:27099 ./pw.sh check-killcard-layout-d4.mjs`);
  fills the "Killed by" card with every line plus the clock, Gun Game strip
  and money, at desktop, phone landscape (touch) and portrait sizes, with
  and without Gun Game, and while spectating (`#hud` `data-spectating`):
  the card stays below the crosshair, inside the viewport, clear of the
  clock and strip (and above the engine's bottom spectator bar when
  spectating), all lines shown, no input.
  Leaves the server without bots.
- `check-killcard-d4.mjs`: the "Killed by" card in the game (D.4), on a
  fresh server started with `LEADERBOARD_BOTS=1 ./run-server.sh de_dust2 9`:
  Deathmatch deaths to bots (killer name and team colour, weapon, "This
  map" counting up, the streak line from 3, all checked against the kill
  feed; the card below the crosshair; hidden on respawn), `kill` in the
  console ("You killed yourself"), the Killer card setting off / on in F3,
  no all-time line on a fresh server, then a reconnect
  (`__engine.rejoin()`, which clears the cache like a new map without
  renaming the bots) and "All time: 0 – n" equal to `/duel`, and in classic
  rounds the card staying up while spectating until 6 s and going at a
  round restart. `VIEWPORT=phone` runs it at 844×390 touch (fewer deaths,
  no reconnect). `WAIT_SCALE=2` doubles the waits for deaths on a slow
  host. Leaves the server in classic mode with bots.
- `check-names-e3.mjs owner|guest`: claimed names, knowing who is playing
  (E.3). Two games in one headless browser stall in signon, so it runs as
  two processes at once: `ZIP_PORT=27091 ./pw.sh check-names-e3.mjs guest &`
  then `./pw.sh check-names-e3.mjs owner`. The owner claims "Walter"
  (cookie), joins, waits for the guest, changes the map; it prints its
  device token hash. Check the server's stderr (`docker logs`) for
  `leaderboard: #<userid> "Walter" connected with device <8 hex>` after the
  join and again after the map change, and none for Guest.
- `check-names-e4.mjs owner|guest`: claimed names, enforcing the claim
  (E.4), on a fresh server (empty claims) with bots. Run like E.3's:
  `ZIP_PORT=27091 ./pw.sh check-names-e4.mjs guest &` then
  `./pw.sh check-names-e4.mjs owner`. The owner claims "Walter", switches to
  Deathmatch and sees "✓ yours" under the nickname; the guest sees "This
  name is claimed by someone else", joins as Walter anyway and is renamed
  to "Walter (guest)" (prints how long after the HUD showed) and gets the
  chat line; the owner joins as Walter and stays Walter; both `kill`
  themselves; then the guest runs `name WALTER`, dies at once and is
  renamed again ("WALTER (1) (guest)") with another chat line. Compare the
  server's log with the leaderboard the owner prints: "Walter" has exactly
  the owner's deaths, the guest's deaths under a claimed name count
  nowhere.
- `check-names-e5.mjs <phase>`: claimed names UI (E.5), in phases that
  share codes and cookies through `$OUT`, on a server started with
  `DATA_VOLUME=cs16-e5 ./run-server.sh de_dust2 2` (fresh volume):
  `setup` (F3 claim, code once, Copy code, "I saved it", device_has_name,
  bad/wrong code; switches to Deathmatch), then `ZIP_PORT=27091 ./pw.sh
check-names-e5.mjs guest &` with `owner` (B renamed, "taken" in game;
  A plays as Walter, leaderboard deaths and `claimed`), `rex` (claims in
  game, "Rejoin now"), `second` (another browser signs in with the code;
  leaderboard ✓), then a new container on the same volume and `after`
  (still claimed, release this device, F4 Claimed names → Release, release
  with the code). `engine`: a name with `..` and 2-byte letters arrives in
  `status.json` exactly as the page cut it (31 bytes). `run-server.sh`
  takes `DATA_VOLUME` for this.
- `check-admin-auth.mjs`: the F4 admin menu's password field and Log in
  button: shown when logged out, hidden after logging in, shown again
  after Log out. Any server.
- `cs16-client-0.0.10-bridge-sketch.cpp`: not a check: the cs16-client
  0.0.10 bridge code (A.4 `WcMode` → `mode`, D.1 `WcKillInfo` →
  `killinfo`), not built here (the bridge patches are only in the user's
  local webxash3d-fwgs checkout); merge it there to make 0.0.10.
- `sounds/`: not a browser check: `generate.sh` (re)makes the announcer
  sounds in `src/client/public/sounds` (C.1) with Piper TTS, ffmpeg and
  SoX in a pinned image (`Dockerfile`, `make.sh`); see the README there.

## Setup (once)

```sh
cd plans/new-features-1006-tools
docker pull mcr.microsoft.com/playwright:v1.63.0-noble
# The game files zip (400 MB). Its blob store only allows CORS from the
# real site, so lib.mjs redirects the page's download to a small local
# server that sends this copy.
mkdir -p cache && curl -fo cache/gamezip_8308.zip \
  https://sgwalcc.blob.core.windows.net/public/gamezip_8308.zip
```

If `src/client/src/gamefiles.ts` moves to a new zip URL, download that file
name into `cache/` instead.

## Use

```sh
docker build --platform=linux/386 -t local/cs16-web-server:latest .   # repo root
cd plans/new-features-1006-tools
./run-server.sh de_dust2 4
OUT=/some/folder ./pw.sh check-gamemode.mjs
docker rm -f cs16-headless
```

A join takes about 30 s (download from the local copy, loading, connect)
on an idle host, and up to about 4 minutes when the VM's CPU is contended
(`vmstat` shows a high `st`): `joinGame` waits up to 8 minutes. Stop a
`pw.sh` run with `docker rm -f` on its container: killing the `docker run`
client (e.g. `timeout`) leaves Chromium running and slows the next run.
The page can't keep the zip in IndexedDB (too large for a headless
profile), so every new page downloads it again from the local server.

## What works and what doesn't

- **The game runs.** `chromium.launch({ channel: 'chromium' })` (the full
  Chromium in its new headless mode) with `--use-angle=swiftshader
--enable-unsafe-swiftshader`: WebGL 2 is "ANGLE (Google, Vulkan 1.3.0
  (SwiftShader Device (Subzero)))", the engine draws the map, HUD and
  menus, about 25-30 frames a second. The old headless shell (Playwright's
  default, `CHANNEL=chromium-headless-shell`) loads the engine and opens the
  WebRTC channel, but the client stops in the middle of signon (connected,
  never "entered the game"), with this and older images alike.
- **Console commands**: the engine object isn't global; `lib.mjs` catches it
  when its constructor runs (an `Object.prototype` setter, test pages only)
  as `window.__engine`, so `engineCommand` can join a team, buy, `kill`,
  etc. The engine console itself doesn't open (no `-console`), and its
  output doesn't reach the page console.
- **Keys**: F3 / F4 / Escape go through `page.keyboard`. Mouse look and
  shooting weren't tried.
- **Audio** goes nowhere (no device); WebRTC voice capture says it works.
- Only what one player sees. Two players: run two pages (`newPage` twice,
  different names).
