# In-game Chat — Plan

Date: 2026-10-05 · Branch: new branch off `main` after `admin-player-features`
is merged (suggested `chat-enhance`), because this builds on `cs16-client`
0.0.6.

Move the in-game chat onto the HTML HUD (`src/client/src/hud.ts`) so it matches
the kill feed, scoreboard and the rest of the new HUD:

- **Part A — chat feed:** the game client hands every chat line to the page
  through the HUD bridge, and the page draws it.
- **Part B — chat input:** an HTML text field replaces the engine's
  `messagemode` prompt, so typing works the same on desktop and phones.

## How chat works today

Check these again before starting a phase.

- **Showing chat.** `CHudSayText` (`cl_dll/saytext.cpp` in the `cs16-client`
  checkout at `../webxash3d-fwgs/packages/cs16-client/cs16-client`) handles
  every chat line and draws the last 5 lines in the canvas with the console
  font. Three paths go through it:
  - `MsgFunc_SayText`: player chat. The first string is a format key
    (`#Cstrike_Chat_All`, `#Cstrike_Chat_CT`, `#Cstrike_Chat_T_Dead`,
    `#Cstrike_Chat_AllSpec`, `#Cstrike_Chat_CT_Loc`, `#Cstrike_Name_Change`,
    ...). From the key we can tell whether the line is team-only, whether the
    sender is dead or spectating, and whether there is a location. Lines from
    dead players are already dropped for living players there
    (`allowDead`).
  - `text_message.cpp`, `HUD_PRINTTALK`: server "talk" lines, with no sender.
  - `text_message.cpp`, `HUD_PRINTRADIO`: radio lines
    (`Name (RADIO): Fire in the hole!`), with the sender's slot.
  - All three call `SayTextPrint`, which also plays `misc/talk.wav` and writes
    the line to the console. The text has color codes `\x01` (normal), `\x02`
    (mark), `\x03` (team color) and `\x04` (green) mixed into it.
- **Typing.** Y and U are bound to the engine's `messagemode` /
  `messagemode2`. The engine (not the client dll) draws that prompt, so the
  client can't replace it. On phones, the touch layout opens it through a
  `messagemode` touch button.
- **Keys and pointer lock.** `src/client/src/admin/index.ts` already shows how
  to take keys from the game. It uses window `keydown`/`keypress` listeners in
  the capture phase, registered before the engine's listeners, with
  `stopImmediatePropagation`, then `exitPointerLock` on open and
  `requestPointerLock` on close during a key gesture. Escape and `` ` `` never
  reach the engine.
- **Text that can be sent.** `src/client/src/admin/message-text.ts`
  (`checkMessage`, `MESSAGE_MAX_LENGTH = 120`) already lists the characters
  that survive the engine's tokenizer and the server's `say`.
- **Changes to the game client need a new tarball.** See `BUILD-NOTES.md` in
  the `webxash3d-fwgs` checkout: update `html-hud.patch`, rebuild, bump to
  `0.0.7`, and update `package.json`, `package-lock.json` and the `Dockerfile`
  `COPY vendor/cs16-client-*.tgz` line.

## Definition of done for every step

On top of each step's own definition of done:

- `npm run build` succeeds with no TypeScript errors; Prettier formatting kept.
- Checked by hand in the Docker image (`make build-local-image`, then
  `make run`) with two clients (one on each team) on desktop Chrome, plus a
  phone check for any new UI.
- Text that comes from players (names, messages, locations) is only ever put
  into the page with `textContent`, never `innerHTML`.
- With `hud_html 0`, or with an older `cs16-client` that has no chat event,
  the stock chat and `messagemode` work exactly as before.
- New UI follows the HUD styling (`--hud-panel`, `--team-ct`, `--team-t`,
  `--divider`, the kill feed's look) and is hidden while the main menu is open.

---

## Part A — HTML chat feed

### A.1 Chat event in the HUD bridge (`cs16-client` 0.0.7)

**Change:**
- `web_bridge.{h,cpp}`: add `WebBridge_Chat(...)` and an EM_JS
  `js_hud_chat` that sends one event:

  ```ts
  { type: 'chat', payload: {
      kind: 'say' | 'name' | 'radio' | 'notice';
      slot: number;       // sender's slot (entity index), 0 if none
      name: string;       // sender's name; for 'name', the old name
      team: 'CT' | 'T' | 'SPEC' | '';
      dead: boolean;
      teamOnly: boolean;  // say_team
      location: string;   // '' unless a *_Loc key
      text: string;       // message; for 'name', the new name
  } }
  ```

  The payload is built in C as JSON and passed as one string, like
  `js_hud_scores` (strings escaped, valid UTF-8). Keep the EM_JS parameter
  lists unpadded.
- `saytext.cpp`, `MsgFunc_SayText`: after the `allowDead` check (so dead
  chat stays hidden from living players), call the bridge with fields taken
  from the format key and from `argv`, not from the formatted string. `team`
  comes from `g_PlayerExtraInfo[slot].teamnumber`, so `#Cstrike_Chat_All`
  lines get a team too. A SayText with no known key becomes
  `kind: 'notice'`.
- `text_message.cpp`: `HUD_PRINTTALK` sends `kind: 'notice'`, and
  `HUD_PRINTRADIO` sends `kind: 'radio'` with the sender's slot, name and
  team. The text has the `\x01`–`\x04` color codes stripped.
- `CHudSayText::Draw` returns early when `HUD_HTML_ACTIVE()`. `SayTextPrint`
  still runs, so the talk sound and the console log stay.
- Document the event at the top of `web_bridge.h`, regenerate
  `html-hud.patch`, add a "Local changes in 0.0.7" section to
  `BUILD-NOTES.md`, bump `package.json` to `0.0.7`, rebuild and pack into
  `vendor/`.
- In this repo: point `package.json` and the `Dockerfile` at 0.0.7 and run
  `npm install`.
- Done as 0.0.8 (0.0.7 was already taken). 0.0.9 then locks `hud_html` to 1 in
  the web build (default 1, `WebBridge_Frame` undoes any change), so the HTML
  HUD can't be turned off; the "`hud_html 0`" checks below now only apply to
  an older `cs16-client` with no bridge.

**Definition of done:**
- [ ] `strings dist/cl_dll/client_emscripten_wasm32.wasm | grep -c hudEvent`
      goes up by one from 0.0.6.
- [ ] With a temporary `console.log` in `onBridgeEvent`, each of these prints
      one `chat` event with the right fields: `say`, `say_team` (both teams),
      a dead player's `say` (seen only by dead players and spectators), a
      spectator's `say`, a name change, a radio command, and a `_Loc`
      message if a map sends locations.
- [ ] With `hud_html 1`, no stock chat lines are drawn in the canvas, but the
      talk sound still plays and the lines still show up in the console.
- [ ] With `hud_html 0`, the stock chat is drawn as before.
- [ ] `web_bridge.h`, `html-hud.patch` and `BUILD-NOTES.md` are updated in the
      `webxash3d-fwgs` checkout.

### A.2 Chat feed on the HUD

**Change:**
- `hud.ts`: add the `chat` case to `HudEvent` and to `handle()`, and a
  `#hud-chat` element in `index.html` inside `#hud`.
- Each line is built from parts, like `addKill`:
  - optional tags: `DEAD`, `SPEC`, `TEAM` (team-only), `RADIO`;
  - the name in the team color (`.ct` / `.t`, muted for spectators);
  - `@ location` in muted text, when set;
  - the message text in `--text`;
  - `name` lines read "‹old› is now ‹new›"; `notice` lines have no name and
    use the accent color.
- Placement: left side, above `.hud-vitals`, at most ~40% of the width; long
  messages wrap to at most 2 lines and are then cut off with an ellipsis.
- Lifetime: keep the newest 6 lines; each fades out after 8 s, using the same
  timer and `fading` class pattern as the kill feed (its own timer set,
  cleared in `reset()`).
- `reset()` (map change or reconnect) clears the feed, like the kill feed.
- `style.css`: `.hud-chat`, `.hud-chat-line`, `.hud-chat-tag`, in the kill
  feed's style (panel background, 1px divider border).

**Definition of done:**
- [ ] Every kind from A.1 renders with the right tags and team color.
- [ ] A message containing `<b>hi</b>` or `<img src=x onerror=alert(1)>`
      shows up as plain text.
- [ ] A 100-character message wraps and never covers the health or armor
      panels at 1280×720, 1920×1080, or a phone in landscape.
- [ ] Lines fade after 8 s; a 7th line pushes out the oldest one.
- [ ] The feed is empty after a map change, and is hidden while the main menu
      or the scoreboard is open (current `#hud` rules).
- [ ] The feed doesn't overlap the kill feed (top right) or the touch buttons
      on a phone.

### A.3 Chat history while the scoreboard is open

**Change:**
- Keep the last 50 lines in memory (also cleared on `reset()`).
- While the scoreboard is open, show the full history in a scrollable panel
  under the scoreboard instead of hiding the chat
  (`#hud.scores-open > :not(.hud-scoreboard)` then needs an exception).

**Definition of done:**
- [ ] Holding Tab shows lines that have already faded from the feed, newest
      at the bottom.
- [ ] The history panel fits under the scoreboard at 1280×720 without
      covering the team tables.
- [ ] Releasing Tab returns to the normal feed with no lines lost or doubled.

---

## Part B — HTML chat input

Part B needs no change to the game client: the page catches Y and U itself,
the same way the admin menu catches F4. It depends on A.2 for showing the
sent message.

### B.1 Open and close the chat input

**Change:**
- New module `src/client/src/chat.ts` with `attachChat(engine)` /
  `detachChat()`, called next to `attachHud` / `detachHud` in `main.ts`.
- A `<form id="hud-chat-input">` under the chat feed: a "Say" / "Say (team)"
  label, a text field and a character counter. It can be clicked, unlike the
  rest of `#hud` (`pointer-events: auto` on the form only).
- Window `keydown`/`keypress` listeners in the capture phase, registered at
  module load (before the engine's), as in `admin/index.ts`:
  - **Y** opens "Say", **U** opens "Say (team)", but only when: the HTML HUD
    is active (bridge seen), the main menu is closed, the admin menu is
    closed, and the key isn't a repeat. Otherwise the key goes to the game,
    so the engine's `messagemode` still works when the HTML HUD is off.
  - While open: every key is stopped from reaching the game (no
    `preventDefault`, so typing works); **Esc** closes without sending;
    **Enter** sends (B.2).
  - `keyup` is left alone so keys held while opening (W, mouse buttons) are
    released in the game.
- On open: `document.exitPointerLock()`, focus the field. On close: blur, and
  call `canvas.requestPointerLock()` only when closing from a key gesture
  (Enter or Esc).
- Close the input on `menu` (visible), `reset`, `detachChat`, and when the
  admin menu opens. Export an `isOpen()` from the admin menu (or add a small
  shared "an overlay is open" flag) so the two never open at the same time.

**Definition of done:**
- [ ] Y and U open the input with the right label; the player stops turning
      with the mouse and doesn't walk while typing W/A/S/D.
- [ ] Esc closes it, nothing is sent, the main menu does not open, and the
      pointer is locked again without a click.
- [ ] With the admin menu open (F4), Y types into the admin form and the chat
      input doesn't open.
- [ ] With the main menu open, or with `hud_html 0`, Y/U do what they did
      before.
- [ ] A map change or disconnect while typing closes the input with no
      errors in the console.

### B.2 Sending, checking and history

**Change:**
- On Enter: check the text with `checkMessage` (`admin/message-text.ts`;
  move it to a shared module such as `src/client/src/message-text.ts` if
  importing it from `admin/` reads oddly), then run `say <text>` or
  `say_team <text>` with `Cmd_ExecuteString`. Empty text just closes the
  input.
- Check while typing: the counter shows `n/100` and turns `--danger` at the
  limit (`maxlength` on the field); characters that can't be sent are named
  under the field with `checkMessage`'s error and Enter does nothing until
  they are removed.
- Check how the engine forwards a client `say` to the server (quoted or not)
  and write down which form keeps the text unchanged, including `?`, `:` and
  several spaces in a row.
- Chat limit is 100 characters (`CHAT_MAX_LENGTH`), not 120: Host_Say cuts
  the text at 125 bytes minus its format name (as few as 104 when dead).
  At most one message per second, since Host_Say silently drops messages
  sent less than 0.66 s apart.
- History: up to 20 sent messages for this session (in memory only); ↑/↓ in
  the field moves through them.

**Definition of done:**
- [ ] `say` reaches every player; `say_team` reaches only teammates; both show
      up in the A.2 feed with the right tags.
- [ ] Text with every allowed punctuation character arrives unchanged.
- [ ] `é`, `"`, `;` and `//` are reported before sending and are never sent.
- [ ] A 101st character can't be typed; pasting a longer text is cut to 100.
- [ ] A second message within 1 s of the last one isn't sent; the input says
      "One message per second" and Enter works again after that.
- [ ] ↑ brings back the last message, ↓ goes forward, and history survives a
      map change.
- [ ] A dead player's message is seen only by dead players and spectators,
      as with the stock chat.

### B.3 Phones and touch

**Change:**
- On touch devices (where `main.ts` turns on `touch_enable 1`), show a small
  chat button in the HUD that opens the input (with a Say / Team toggle in
  the form, since there's no U key).
- Hide the engine's own touch chat button if it can be removed with a
  `touch_*` command; otherwise write down that both buttons exist.
- Keep the field visible above the on-screen keyboard (use
  `visualViewport` to move the form up while it's open).
- No pointer lock on close for touch.

**Note — the engine's touch chat button:** there is none to hide in the
layout players get. The game zip (`gamezip_8308.zip`) has no `touch.cfg`
or `touch/` files, so the engine falls back to the default buttons, and
`cs16-client` replaces the engine's list (which has a `messagemode`
button) with its own (`cl_dll/cdll_int.cpp`, `pfnTouchResetDefaultButtons`
then `TOUCH_ADDDEFAULT`), which has no chat button. The `chat` / `say` /
`say2` buttons are only in `cs16client-extras/touch.cfg`, which isn't
shipped. If a layout with one is ever shipped, `touch_hide <name>` /
`touch_show <name>` would work (`in_touch.c`, `Touch_HideButtons`: only
sets the hide flag, wildcards allowed), but run it on each `reset` event,
because the touch config is only loaded on the first in-game frame. Nothing
would stick for `hud_html 0`: `touch.cfg` is only rewritten when the touch
editor is used, or on engine shutdown after a change, and the page's
filesystem is in memory (no IDBFS), so nothing is kept after a reload.

**Definition of done:**
- [ ] On a phone (Android Chrome and iOS Safari), the button opens the
      input, the keyboard opens, and the field stays visible above it.
- [ ] Sending or closing hides the keyboard and gives touch control back to
      the game.
- [ ] The button and the feed are both usable with one thumb in landscape
      and don't cover the fire or jump buttons.

---

## Out of scope (possible follow-ups)

- Muting a player's chat on the client (by `userid`, from the scoreboard).
- Admin messages shown as announcements in the feed: `rcon say` prints to
  the console notify area, not as a `SayText`, so this needs AMXX
  (`amx_chat` / `amx_say`) or a server-side change.
- Quick chat and radio wheel (Phase 7 of `admin-player-features.md`). It
  should reuse B.2's send path.
