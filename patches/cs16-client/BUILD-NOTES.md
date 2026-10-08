# cs16-client — local build notes (Walcc.CounterStrike)

How `Walcc.CounterStrike/vendor/cs16-client-0.0.10.tgz` was produced (0.0.9 is the same without
the `mode` / `killinfo` events, 0.0.8 also without the `hud_html` lock, 0.0.7 also without the `chat` event, 0.0.6 also without the `round` / `intermission` events and the kill userids, 0.0.5 also without `userid` /
`hud_html_scores`, 0.0.4 also without the menu event, 0.0.3 also without the scoreboard events).

## Source provenance

- `github.com/yohimik/webxash3d-fwgs` and `github.com/yohimik/cs16-client` now return 404.
  This checkout was cloned from the public mirror
  `https://github.com/daShao999/WebXash3D-Fwgs-yohimik` and detached at monorepo commit
  `9bde682` ("feat: cs update", 2025-07-20) — the commit that set this package to
  `0.0.2+commit.6a9023c`.
- At `9bde682` the `cs16-client` submodule points at `08a2f2df` ("feat: min", yohimik), whose
  parent is `6a9023cf` (the commit named in the version label; the label was not updated
  when the submodule moved). `08a2f2df` only adds `-Oz --closure 1 --minify-wasm-imports` to the
  client link flags and bumps mainui_cpp / ReGameDLL_CS.
- Both commits are still reachable through the GitHub fork network of `Velaron/cs16-client`,
  so the submodule is fetched from there by SHA.
- Rebuilding `08a2f2df` unchanged reproduced the 0.0.2 package: menu wasm byte-identical,
  client wasm same size (only the `__DATE__` string differs), server .so differs only in
  ReGameDLL version/build-date strings.

## Get the source

```sh
git clone https://github.com/daShao999/WebXash3D-Fwgs-yohimik.git webxash3d-fwgs
cd webxash3d-fwgs
git checkout 9bde682
cd packages/cs16-client
rm -rf cs16-client && git init cs16-client && cd cs16-client
git remote add origin https://github.com/Velaron/cs16-client.git
git fetch --depth 50 origin 08a2f2df22eb190d7d4017279ea519427e2abed7
git checkout FETCH_HEAD
git submodule update --init --recursive
cd ..
```

## Local changes in 0.0.3

- HTML HUD bridge (Phase 1 of `plans/html_hud.md`). All source changes are saved in
  `html-hud.patch` (paths relative to the `cs16-client/` repo; re-apply on a fresh checkout with
  `git -C cs16-client apply ../html-hud.patch`):
  - new `cl_dll/web_bridge.{h,cpp}` (picked up by the `*.cpp` glob in `cl_dll/CMakeLists.txt`):
    EM_JS functions that call `Module.hudEvent(type, payload)`; the event contract is documented
    at the top of `web_bridge.h`. No-ops on non-Emscripten builds.
  - cvar `hud_html` (default `0`, registered in `CHud::Init`); when nonzero the stock health,
    armor, money, ammo counters, round clock and death notices are not drawn.
  - calls into the bridge from the Health, Battery, ArmorType, Money, CurWeapon, AmmoX,
    WeaponList, RoundTime, BombDrop, DeathMsg, ResetHUD and InitHUD handlers and once per frame
    from `CHud::Redraw`.
  - The Phase 0.2 `EM_ASM` spike in `cdll_int.cpp` was removed.
- `package.json`: version `0.0.3` (the `exports` map is unchanged).

## Local changes in 0.0.4

- HTML scoreboard (Phase 4 of `plans/html_hud.md`), also in `html-hud.patch`:
  - `web_bridge.cpp`: events `scoreboard { visible }` (polled each frame, mirrors the stock
    `CHudScoreboard::Draw` conditions) and `scores` (a JSON snapshot built in C and passed to one
    `EM_JS` that `JSON.parse`s it; on open and every 0.5 s while visible). Contract in
    `web_bridge.h`.
  - `hud/scoreboard.cpp`: `Draw` returns early when `hud_html` is nonzero; `MsgFunc_TeamScore`
    hands the team score to the bridge.
- `package.json`: version `0.0.4`. Bumped rather than overwriting 0.0.3 to avoid the npm
  integrity-cache problem below.

## Local changes in 0.0.5

- Menu visibility event, so the page hides its HTML HUD while the main menu is open (the menu is
  drawn inside the canvas, under the overlay). `3rdparty/mainui_cpp` is its own nested git repo,
  so this change is saved separately in `html-hud-mainui.patch` (paths relative to
  `cs16-client/3rdparty/mainui_cpp`; apply with
  `git -C cs16-client/3rdparty/mainui_cpp apply ../../../html-hud-mainui.patch`):
  - `BaseMenu.cpp`: `EM_JS js_menu_visible` sends `menu { visible }` through `Module.hudEvent`
    when `uiStatic.menu.IsActive()` changes; checked every `UI_UpdateMenu` frame and on
    `UI_CloseMenu`.
- `web_bridge.h` documents the event (in `html-hud.patch`).
- `package.json`: version `0.0.5`.

## Local changes in 0.0.6

- Admin Players tab (step 2.1 of `plans/admin-player-features.md`), in `html-hud.patch`:
  - `web_bridge.cpp`: each `scores` player gets `userid`, the server's userid for
    `kick #<userid>` (the engine's `kick` takes only `#<userid>` or an exact name; `id` is the
    slot). The client API has no userid getter, so it is read from the engine's `player_info_t`
    through `IEngineStudio.PlayerInfo( slot - 1 )` (0 if unavailable).
  - cvar `hud_html_scores` (default `0`, registered next to `hud_html`): when nonzero, `scores`
    is also sent every 0.5 s while the scoreboard is hidden (the page turns it on while the admin
    Players tab is open).
  - `web_bridge.h` documents both.
- `package.json`: version `0.0.6`. Rebuilt on 2026-10-05 with the cached `cs-builder` image
  (`strings ... | grep -c hudEvent` is still 10).
- `html-hud.patch` is regenerated with
  `git -C cs16-client diff -- . ':!3rdparty/mainui_cpp' > html-hud.patch` (`web_bridge.{h,cpp}`
  are intent-to-add, so they show up in `git diff`).

## Local changes in 0.0.7

- Round and map summary (step 6.2 of `plans/admin-player-features.md`), in `html-hud.patch`:
  - `text_message.cpp`: `MsgFunc_TextMsg` hands the raw title to `WebBridge_TextMsg` before
    localising it. `web_bridge.cpp` matches HUD_PRINTCENTER titles against `s_roundEnds`
    (`#CTs_Win`, `#Terrorists_Win`, `#Target_Bombed`, `#Bomb_Defused`, `#Target_Saved`,
    `#Round_Draw`, hostage / VIP / escape endings, `#Game_Commencing`) and sends
    `round { winner, reason, message, ctScore, tScore }` from the next `WebBridge_Frame`, so the
    TeamScore messages of the same packet are counted.
  - `web_bridge.cpp`: `intermission { active, map }` when `gHUD.m_iIntermission` changes
    (svc_intermission at map end); cleared without an event on InitHUD (`reset`).
  - `death.cpp` passes the killer / victim slots; `kill` gets `killerUserid` / `victimUserid`
    (same `IEngineStudio.PlayerInfo` lookup as `scores`, 0 for none).
  - `web_bridge.h` documents all of it (reason table included).
- `package.json`: version `0.0.7`. Rebuilt on 2026-10-05 with the cached `cs-builder` image
  (`strings ... | grep -c hudEvent` is now 12).

## Local changes in 0.0.8

- Chat event (step A.1 of `plans/chat-enhance.md`), in `html-hud.patch`:
  - `web_bridge.cpp`: `chat { kind, slot, name, team, dead, teamOnly, location, text }`, built in
    C as JSON (same writer and escaping as `scores`) and passed to one `EM_JS js_hud_chat`.
    `s_chatKeys` maps the SayText format keys (`#Cstrike_Chat_*`, `#Cstrike_Name_Change`) to
    kind / teamOnly / dead / spectator and the argv indexes of text and location; `team` comes
    from `g_PlayerExtraInfo[slot].teamnumber`. Color codes `\x01`-`\x04` are stripped.
  - `saytext.cpp`: `MsgFunc_SayText` calls `WebBridge_SayText` after the `allowDead` check (other
    formats become `notice`); `CHudSayText::Draw` keeps scrolling but draws nothing when
    `hud_html` is nonzero (`SayTextPrint` still plays `misc/talk.wav` and prints to the console).
  - `text_message.cpp`: HUD_PRINTTALK sends `notice`, HUD_PRINTRADIO sends `radio` with the
    sender's slot, name, place (for `#Game_radio_location`) and the looked-up radio message.
  - `web_bridge.h` documents the event.
- `package.json`: version `0.0.8`. Rebuilt on 2026-10-06 with the cached `cs-builder` image
  (`strings ... | grep -c hudEvent` is now 13).

## Local changes in 0.0.9

- `hud_html` locked on in the Emscripten build (`html-hud.patch`): `hud.cpp` registers it with
  default `1`, and `WebBridge_Frame` sets it back to `1` whenever it is changed (console, config,
  server `stuffcmd`). Non-Emscripten builds keep default `0` and no lock. `web_bridge.h` says so.
- `package.json`: version `0.0.9`. Rebuilt on 2026-10-06 with the cached `cs-builder` image
  (`strings ... | grep -c hudEvent` is still 13).

## Local changes in 0.0.10

- Server plugin events (steps A.4 and D.1 of `plans/new-features-1006.md`), in `html-hud.patch`:
  - `web_bridge.cpp`: `WebBridge_Init` (called from `CHud::Init`) hooks the user messages
    `WcMode` (`src/amxx/wc_gamemode.sma`) and `WcKillInfo` (`src/amxx/wc_killinfo.sma`) by name
    (the plugins register them, so their ids aren't fixed). Each handler reads the message, builds
    JSON with the `scores` writer and passes it to one EM_JS: `js_hud_mode` -> `mode`,
    `js_hud_killinfo` -> `killinfo`.
  - `web_bridge.h` documents both events and the message formats.
- `package.json`: version `0.0.10`. Rebuilt on 2026-10-07 with the cached `cs-builder` image
  (`strings ... | grep -c hudEvent` is now 15).

## Build and pack

Requires Docker. The `emscripten/emsdk:4.0.11` image is amd64-only, so on Apple Silicon it runs
under emulation (a clean build takes about 5 minutes).

```sh
cd packages/cs16-client
rm -rf dist
docker build --progress=plain -t cs-builder . && docker run --rm -v "$(pwd)/dist:/out" cs-builder
# (this is the same as `npm run build:wasm`)
npm pack --pack-destination /path/to/Walcc.CounterStrike/vendor   # -> cs16-client-<version>.tgz
```

Then in Walcc.CounterStrike: `npm install` (this refreshes the integrity hash in package-lock.json
when the version changes; for a same-version rebuild see the lock file note below),
`npm run build`, then `npx tsc --noEmit -p .`. If you bump the version, also update the
`cs16-client` dependency in `package.json` and the `COPY vendor/cs16-client-*.tgz` line in the
`Dockerfile`.

## Checking that the bridge made it into the client wasm

Each EM_JS function shows up as an import `env.js_hud_<event>` plus an exported global
`__em_js__js_hud_<event>` that points at the JS body in the data segment (the main module's
loader evals it at load time and binds the import). `--minify-wasm-imports` does not rename them.

```sh
strings dist/cl_dll/client_emscripten_wasm32.wasm | grep -c hudEvent   # 15 (13 in 0.0.8-0.0.9, 12 in 0.0.7, 10 before)
```

Note on EM_JS in this setup: keep EM_JS parameter lists unpadded (`(int a, int b)`, not
`( int a, int b )`). The side-module loader takes the last space-separated word of each
parameter as the JS argument name, so a trailing space yields an empty name.

Note on the lock file: npm caches `file:` tarballs by integrity, so overwriting the tgz without
changing the version makes `npm install` keep the old integrity and install the old (cached)
package. Update the `integrity` of `node_modules/cs16-client` in `package-lock.json` to
`sha512-$(openssl dgst -sha512 -binary vendor/cs16-client-<version>.tgz | base64)` (or delete it
and run `npm install`), remove `node_modules/cs16-client`, then `npm ci`.
