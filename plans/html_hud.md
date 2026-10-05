# HTML HUD — Plan

Date: 2026-10-05 · Branch: new branch off `main` (suggested `html-hud`)

## Status

Phases 0–3, the HTML scoreboard (Phase 4) and hiding the HUD in the menu
(Phase 5) are implemented; only the manual checks below are left.

- **Client build (Phase 0):** `yohimik/webxash3d-fwgs` and `yohimik/cs16-client`
  are gone (404). The local checkout `/Users/wcarasas/Repos/webxash3d-fwgs` was
  cloned from the mirror `daShao999/WebXash3D-Fwgs-yohimik` at `9bde682`, with
  the `cs16-client` submodule at `08a2f2df` fetched from the
  `Velaron/cs16-client` fork network. Not pushed to an owned GitHub account
  yet. Build steps, provenance and the npm-cache gotcha are in
  `packages/cs16-client/BUILD-NOTES.md`; the C++ changes are kept as
  `packages/cs16-client/html-hud.patch` (plus `html-hud-mainui.patch` for the
  menu library). Output: `vendor/cs16-client-0.0.5.tgz` (0.0.3 had the HUD
  bridge, 0.0.4 added the scoreboard; each version was bumped instead of
  overwritten because npm caches `file:` tarballs by integrity, see
  BUILD-NOTES).
- **Bridge (Phases 0.2 / 1):** `EM_JS` works in the client side module, so
  `cl_dll/web_bridge.{h,cpp}` calls `Module.hudEvent(type, payload)` directly.
  The event contract (when each event fires, resends) is documented in
  `web_bridge.h`. `hud_html` cvar as planned.
- **Overlay (Phase 2):** `src/client/src/hud.ts`, `#hud` inside `#game`;
  `engine.ts` redirects the canvas' `requestFullscreen` to `#game`.
  Deviation: the stock-HUD fallback fires 10 s after `attachHud` (not "a few
  seconds after connecting"), and a late bridge event turns the HTML HUD back
  on.
- **States (Phase 3):** see the decisions under Phase 3.
- **Scoreboard (Phase 4):** `scoreboard` / `scores` events, the stock
  scoreboard is skipped with `hud_html 1`; see Phase 4.
- **Menu (Phase 5):** `menu` event from the menu library hides the HTML HUD
  while the main menu is open; see Phase 5.
- **Fixed after the first deploy:** `engine.em` is a wrapper
  (`{ Module, FS, HEAPU8, ... }`), so `hudEvent` must be set on
  `engine.em.Module` (`bridgeModule` in `hud.ts`). Setting it on `engine.em`
  meant no event ever arrived and the page fell back to the stock HUD.

**Remaining manual verification:**
- [ ] A real match round: buy, take damage, reload, die, respawn; values match
      `hud_html 0`.
- [ ] `hud_html 0` / `hud_html 1` toggle in the console.
- [ ] Fullscreen toggle: HUD and the connection-lost overlay stay visible.
- [ ] Mobile with touch controls (`touch_enable 1`): no overlap with buttons.
- [ ] Map change (`changelevel`): kill feed cleared, no money flash, timer
      back on the next round time.
- [ ] Join mid-round: no health/armor/ammo while dead or spectating.
- [ ] Die and spectate: health/armor/ammo hidden; timer, money and kill feed
      stay.
- [ ] Kill the server mid-game: overlay shows and the HUD is gone.
- [ ] Hold Tab: HTML scoreboard opens at once, the rest of the HUD fades,
      no stock scoreboard behind it; K/D update while held; release closes
      it. Players, teams, scores and dead/bomb/VIP markers match
      `hud_html 0`.
- [ ] Die: the scoreboard shows during the death cam and closes when
      spectating starts (stock behaviour). Round end / map end
      intermission shows it.
- [ ] `changelevel` while holding Tab: scoreboard closes on the reset.
- [ ] Bots show `BOT` as ping; a player with a quoted / non-ASCII name
      renders correctly. Ping may read 0 for real players (see Phase 4).
- [ ] Phone (portrait): CT above T, fits the screen.
- [ ] Esc opens the main menu: the HTML HUD (and scoreboard) disappear;
      Resume game brings them back. Same for the connection-progress dialog.

Replace part of the in-game CS 1.6 HUD with an HTML/CSS overlay styled to match
the new login page, while the engine keeps drawing everything tied to the 3D
world or the camera.

## Scope

**Moves to HTML:** health, armor (with helmet), money (with +/- change flash),
current weapon + clip/reserve ammo, round timer (and bomb-planted state),
kill feed; the scoreboard since Phase 4.

**Stays native (drawn by the game):** crosshair, damage-direction arcs, radar,
names / spectator labels / voice icons over players, scope and flashbang
effects, chat, text menus (buy / team select — `_vgui_menus 0` is
already set in `main.ts`).

Not in the original plan: HTML scoreboard (added as Phase 4), HTML buy
menu, HTML radar. They can follow
once the bridge exists.

## How it fits together

```
cs16-client (C++ → client_emscripten_wasm32.wasm)
  HUD message handlers (Health, Battery, Money, CurWeapon, AmmoX, RoundTime,
  DeathMsg, ...) ──► web bridge ──► JS callback on the page
  each replaced element's Draw() ──► skipped when cvar hud_html = 1

page (src/client)
  hud.ts: state store + DOM updates ──► #hud overlay above #canvas
```

Today `cs16-client` comes from `vendor/cs16-client-0.0.2.tgz`, a prebuilt
package (`0.0.2+commit.6a9023c`, built from `yohimik/webxash3d-fwgs` with its
Docker builder). This plan replaces it with our own build of a fork.

## Phase 0 — Own the client build

### 0.1 Fork and rebuild unchanged
**Change:**
- Fork `yohimik/webxash3d-fwgs` (or just its `cs16-client` package) into an
  owned GitHub account, pinned at commit `6a9023c`.
- Run its `build:wasm` Docker build; package `dist/` as
  `vendor/cs16-client-0.0.3.tgz` (same `exports` map).
- Point `package.json` and the two `COPY vendor/...` lines in `Dockerfile`
  (`Dockerfile:103`) at the new tgz.
- Write down the exact build command in the fork's README so the tgz can be
  regenerated.

**Verify:** `npm ci && npm run build`; a local match on de_dust2 behaves exactly
as before (same HUD, menus, connect flow).

### 0.2 Spike: can the client library call JS?
`client_emscripten_wasm32.wasm` is loaded as an Emscripten side module, and
`EM_ASM`/`EM_JS` support in side modules depends on the Emscripten version the
builder uses.

**Change:** in `HUD_Init`, add one `EM_ASM({ console.log('hud bridge ok'); });`
and rebuild.

**Verify:** the message appears in the browser console after the engine starts.

**If it doesn't work**, use one of these instead, in order:
1. Call a JS function the page puts on `Module` (e.g. `Module.hudEvent`) through
   an import the main module already exposes.
2. Write HUD state into a fixed struct in the client library, export a getter
   that returns its address, and have JS read it from `engine.em.HEAPU8` once
   per animation frame (only touching the DOM when values change).

Pick the mechanism here; the rest of the plan only depends on "C++ can hand a
small event to JS".

## Phase 1 — Bridge in cs16-client (C++)

### 1.1 `hud_html` cvar
**Change:** register `hud_html` (default `0`) in the HUD init code. `0` = stock
HUD, `1` = skip drawing the replaced elements. Being a cvar means the stock HUD
is always one console command away while developing.

### 1.2 Send events to JS
**Change:** add `cl_dll/web_bridge.{h,cpp}` with one small function per event,
all no-ops outside Emscripten builds. Call them from the existing HUD message
handlers, sending only when a value changes:

| Event | Source (HUD class / user message) | Payload |
|---|---|---|
| `health` | `CHudHealth` / `Health` | `hp` |
| `armor` | `CHudBattery` / `Battery`, `ArmorType` | `ap`, `helmet` |
| `money` | `CHudMoney` / `Money` | `amount`, `delta` |
| `weapon` | `CHudAmmo` / `CurWeapon`, `WeaponList`, `AmmoX` | `name`, `clip`, `reserve` (‑1 = no ammo, e.g. knife) |
| `timer` | `CHudTimer` / `RoundTime`, bomb messages | `seconds`, `bombPlanted` |
| `kill` | `CHudDeathNotice` / `DeathMsg` | `killer`, `victim`, `weapon`, `headshot`, team of each |
| `alive` | `ResetHUD`, death / spectator state | `alive`, `spectating` |
| `reset` | `InitHUD` (map change / reconnect) | — |

Class and message names are from the HL/CS SDK layout; check them against the
fork at `6a9023c` before writing code.

### 1.3 Skip drawing only what HTML replaces
**Change:** when `hud_html` is `1`, return early from the draw code of the
replaced elements.

**Watch out:** several classes draw more than one thing.
- `CHudHealth` also draws the **damage-direction arcs** and pain/status icons —
  skip only the health number + cross icon.
- `CHudAmmo` also handles the **crosshair** and weapon selection list — skip
  only the ammo counters.
- `CHudTimer` may share drawing with the bomb/round status — skip only the
  clock.

**Verify (Phase 1):** with `hud_html 1` the six elements disappear and
everything in "Stays native" is still drawn; `hud_html 0` restores the stock
HUD; the browser console (temporary logging in the JS callback) shows events
when taking damage, buying, shooting, reloading and killing.

## Phase 2 — Overlay on the page

### 2.1 Markup and layering
**Change:**
- `src/client/index.html`: wrap `#canvas` in `<div id="game">` and add
  `<div id="hud" hidden>` inside it, after the canvas.
- `style.css`: `#game` is `position: fixed; inset: 0` (as implemented); `#hud` is `position: absolute;
  inset: 0; pointer-events: none` so mouse capture and touch controls still
  reach the canvas.
- Fullscreen: make sure fullscreen applies to `#game`, not the canvas, or the
  overlay disappears. Check whether the engine calls `requestFullscreen` on the
  canvas itself (SDL fullscreen / F-key toggle) and redirect it if needed.

### 2.2 `hud.ts`
**Change:** new `src/client/src/hud.ts`:
- Typed event union matching the table in 1.2.
- A small state store; DOM nodes are updated only when their value changes
  (no work per animation frame).
- `attachHud(engine)` registers the bridge callback, shows `#hud`, and runs
  `engine.Cmd_ExecuteString('hud_html 1')`. Call it from `start()` in
  `main.ts` right after `engine.main()`.
- If no bridge event arrives within a few seconds of connecting (e.g. an old
  client build), hide `#hud` and set `hud_html 0` so the player keeps the stock
  HUD.

### 2.3 Elements and style
**Change:** build the six elements using the login page's colors and fonts
(`style.css` tokens), sized relative to the viewport so they scale with
resolution.
- Bottom-left: health + armor (helmet icon); low-health state under 25 hp.
- Bottom-center: round timer; switches to a bomb indicator when planted.
- Bottom-right: weapon name, clip / reserve; low-ammo state.
- Right side, above ammo: money with a short green `+$` / red `-$` flash.
- Top-right: kill feed, max ~5 rows, each fading out after ~6 s, headshot
  icon, team colors.
- Keep the top-left clear for the native radar, and check touch-control
  positions when `touch_enable 1` (mobile).

**Verify (Phase 2):** a full round in a local match — buy, take damage, reload,
die, respawn — every HTML value matches what `hud_html 0` shows; overlay
visible in fullscreen; the mouse is still captured; no layout break at
1280×720, 1920×1080 and phone width.

## Phase 3 — States and edge cases

**Change / check:**
- Dead or spectating: hide health/armor/ammo, keep timer and kill feed.
- Map change and reconnect: `reset` clears the kill feed and state.
- Scoreboard (Tab) or chat open: decide whether to dim the HTML HUD so it
  doesn't overlap the native scoreboard (superseded by Phase 4).
- Connection lost overlay (`#connection-lost`) sits above `#hud`.
- Values arrive before the first `alive` event (joining mid-round).

**As implemented (page only, no C++ changes):**
- `#hud[data-alive]` is `unknown` at load and after every `reset`, `false`
  when dead or spectating, `true` when alive; health/armor/ammo show only
  for `true`. `alive` is polled every frame from connect and is resent right
  after a reset's resend, so the wait is at most a frame, and a spectator
  joining mid-round never sees vitals flash (resent or default values would
  otherwise show). Money stays visible when dead, like timer and kill feed.
- `reset` hides every element, clears the kill feed and its timers, keeps
  the timer hidden until the next `timer` event (not resent), and marks money as unsynced: the
  first money change after a reset is the server syncing the balance (+$800
  on connect, start money on a new map — the stock HUD flashes it as a delta),
  so it updates the value without the +/- flash. Resends carry `delta 0` and
  never flash. Other resent values from the previous map can be stale for a
  moment until the server sends fresh ones after spawn; acceptable.
  Edge: if the new map's money equals the old value the bridge sends nothing,
  so the first real purchase after it won't flash.
- (Replaced in Phase 4.) A Tab key listener used to dim the HUD while the
  native scoreboard was drawn; it is gone, the `scoreboard` event drives
  the HTML scoreboard and the dimming now. Chat is left alone: it is drawn
  bottom/left-center, the kill feed is top-right.
- `#connection-lost` moved inside `#game`, so it is part of the fullscreen
  element and stacks above `#hud` (z 3 vs 2 inside `#game`). No fullscreen
  exit needed. On disconnect `main.ts` calls `detachHud()`: removes
  `Module.hudEvent`, clears the fallback and kill-feed timers, hides the
  scoreboard and `#hud`.
- `attachHud` detaches first, so calling it twice only resets the HUD.

**Verify:** join mid-round, die and spectate, change map with `changelevel`,
kill the server mid-game — no stale or overlapping HUD in any case.

## Phase 4 — HTML scoreboard (as implemented)

**C++ (`web_bridge.cpp`, `hud/scoreboard.cpp`):**
- `scoreboard { visible }` is polled each frame in `WebBridge_Frame` and sent
  on change. `visible` mirrors what `CHudScoreboard::Draw` decides:
  `+showscores` held, `showscoreboard2`, local health 0, or intermission;
  only once a `ScoreInfo` set the element's `HUD_DRAW` flag and while the HUD
  is drawn at all (`hud_draw`, `HIDEHUD_ALL` outside intermission). So it
  opens the frame after `+showscores`, during the death cam (health 0 until
  the server moves the player to observer mode, which sets health 1, as in
  the stock HUD) and at round-end / map-end intermission. Polling instead of
  hooking the commands covers every one of those with one code path.
- `scores` is a full snapshot: right before `scoreboard { visible: true }`
  (so the page never shows the previous one), then every 0.5 s while
  visible. Players are refreshed with `GetPlayerInfo` like the stock
  scoreboard (`GetAllPlayersInfo`, plus slot 32, which it skips). Payload:
  `{ map, server, teams: { CT, T: { score, players, avgPing } }, players:
  [{ id, name, team ("CT" / "T" / "SPEC" / ""), frags, deaths, ping, dead,
  bomb, vip, bot, local }] }`, players in slot order. Team score is the last
  `TeamScore` (rounds won) captured by the bridge — the stock handler's
  team lookup is off by one, so the bridge keys on the team name instead —
  or the summed frags until one arrives, like the stock scoreboard.
- The snapshot is built as JSON in C and handed to one `EM_JS` that runs
  `JSON.parse`: one JS call per snapshot, the nested payload arrives
  complete, and no per-player JS staging state. Strings are escaped (`"`,
  `\`, control characters) and invalid / cut UTF-8 bytes become `?` (the
  engine truncates names at 32 bytes, possibly mid-character). The buffer
  is 16 KB, well above 32 players with fully escaped names; on overflow
  nothing is sent.
- With `hud_html` nonzero `CHudScoreboard::Draw` returns at once, so the
  whole stock scoreboard (including `showscoreboard2`) is skipped. With 0 it
  is unchanged. Events are sent either way.
- `reset` (InitHUD) clears the bridge's scoreboard state and team scores; the
  server resends `TeamScore` after InitHUD.
- **Ping may read 0** for real players: a known Xash bug noted in
  `CHudScoreboard::DrawPlayers` ("must be 0, until Xash's bug not fixed").
  Bots report `bot: true` and show `BOT`, like the stock scoreboard.

**Page (`hud.ts`, `index.html`, `style.css`):**
- `#hud-scoreboard` inside `#hud`, centred, in the launcher panel style. CT
  and T side by side (stacked on portrait screens), each with name, score,
  player count and average ping; rows sorted by frags desc, deaths asc;
  columns name / K / D / ping. Dead rows greyed with a skull, bomb and VIP
  icons (inline SVG), local row highlighted in the accent colour,
  spectators (`SPEC` and `""`) listed below. Names are set with
  `textContent` only.
- A snapshot identical to the last one is skipped; otherwise each team's
  rows are built in a fragment and swapped in with one `replaceChildren`.
- While open, the other HUD elements fade to 25 % (`#hud.scores-open`).
- `reset` and `detachHud` hide it. With 32 players on a phone in portrait
  the last rows are clipped.

## Phase 5 — Hide the HUD while the menu is open (as implemented)

**Problem:** the main menu (Esc) is drawn by the menu library inside the
canvas, so the HTML overlay stayed on top of it.

**Change:**
- The engine exposes no "menu open" state to the page or the game client, but
  the menu library (`menu_emscripten_wasm32.wasm`, built from
  `3rdparty/mainui_cpp` in the same package) knows. `BaseMenu.cpp` gets an
  `EM_JS` that sends `menu { visible }` through `Module.hudEvent` whenever
  `uiStatic.menu.IsActive()` changes, checked each `UI_UpdateMenu` frame and in
  `UI_CloseMenu`. Saved as `html-hud-mainui.patch`; client version 0.0.5.
- `hud.ts` toggles `#hud.menu-open` (`visibility: hidden` in `style.css`); it is
  not cleared by `reset` (the menu is independent of map changes), only on
  `detachHud`.
- The engine console (`~`) is not part of the menu, so the HUD stays visible
  there.

## Release checklist
- Fork tagged, tgz build command documented, `vendor/cs16-client-0.0.5.tgz`
  committed.
- `npx tsc --noEmit -p .` and `npm run build` pass.
- `docker compose up --build`; two browser tabs play a round together and both
  show correct HTML HUDs; `hud_html 0` in the console restores the stock HUD.
- Check one mobile browser with touch controls.

## Later
- HTML buy menu: render from the `ShowMenu` text and send choices back with
  `engine.Cmd_ExecuteString('menuselect N')`.
- HTML radar and damage arcs: need player position and yaw from the bridge.
