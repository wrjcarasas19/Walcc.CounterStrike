# Voice Chat and Adaptive Bots — Plan

Date: 2026-10-06 · Branch: new branch off `main` (suggested
`new-features-1007`). Independent of `new-features-1006.md`, except where
noted.

- **Part A — voice chat:** push-to-talk team voice in the browser, carried
  over the WebRTC connection the game already uses, with the same
  who-hears-whom rules as CS 1.6, speaking indicators, mutes and admin
  controls.
- **Part B — adaptive bots:** the server raises or lowers YaPB's difficulty
  (and, if needed, balances bot numbers) from how the humans are doing
  against the bots, so one or two players still get a close game.

## How things work today

Check these again before starting a part.

- **WebRTC.** `src/server/sfu.go` (pion) opens one `PeerConnection` per
  player from the `/websocket` signaling socket. The **server makes the
  only offer**, with one unordered, no-retransmit data channel `game` for
  the engine's UDP. "The data channel is fixed up front, so there is never
  any renegotiation after the answer." Trickle ICE goes both ways over the
  WebSocket (`candidate`, `answer` events in `readSignaling`); the socket
  stays open with pings for the whole session. The client side is
  `Xash3DWebRTC` in `src/client/src/webrtc.ts`.
- **Players and slots.** Each player gets a made-up IPv4 address: slot
  index plus 3 bytes unique to the connection (`peerSlot`, `connections`,
  `owns(ip)`). `peerSlot.key` is the real address (bans).
- **Engine console.** `src/server/console.go` runs commands in the engine
  and captures their output; the admin API uses it
  (`admin_actions.go`). AMX Mod X server commands can print what Go needs
  (like `wc_weaponmode_status`).
- **Teams in Go.** Only the log follower (`statsfollow.go`, every 2 s)
  knows teams, from `joined team` lines, by userid.
- **Bots.** YaPB 4.4.957. `BOT_QUOTA` is written into `yapb.cfg` at startup
  (`src/server/bots.go`). The F4 Bots tab can add / kick bots, set
  `yb_difficulty` 0–4 (`bot_difficulty` action) and "fill to N".
  `yb_ignore_cvars_on_changelevel` keeps `yb_quota`, `yb_quota_mode`,
  `yb_difficulty` and `yb_autovacate` over map changes.
- **Kill lines.** `statslog.go` parses kills with both players' auth
  (`BOT` for bots) and teams; `statsTally` turns them into totals. Round
  start and end lines are parsed too.

## Definition of done for every step

On top of each step's own definition of done:

- `npm run build` succeeds with no TypeScript errors; Prettier formatting
  kept.
- `go vet` and the Go tests pass (`plans/admin-player-features-tools/gotest.sh`),
  with new tests for new rules.
- `.sma` changes compile in the `amxx-plugins` stage and are listed in
  `plugins.ini`.
- Checked by hand in the Docker image with at least two browser clients
  (desktop Chrome and a phone; Part A also Firefox and iOS Safari), plus
  bots.
- README updated.

---

## Part A — Voice chat

### A.0 Spike: engine voice or WebRTC audio

**Goal:** pick the transport.

- **Option 1 (recommended): WebRTC audio tracks** on the existing
  `PeerConnection`. The browser does echo cancellation, noise suppression,
  gain control and Opus; audio goes over the same ICE transport (bundled,
  same UDP port); the engine's netchan isn't touched (large netchan
  traffic has crashed this server before). The Go server decides who
  hears whom.
- **Option 2: the engine's own voice** (Xash3D FWGS supports Opus voice
  through `voice_enable` / `+voicerecord`). The game DLL would route by
  team by itself, and the scoreboard's speaking icons would work as they
  are. But the web build would need microphone capture through
  Emscripten's SDL audio, which may not be built in, and the audio would
  go through the netchan.

Check for option 2: does the web engine have voice compiled in
(`voice_enable 1`, `+voicerecord` in the console, any `Voice_` symbols)?
If it isn't there, option 1 without further work.

**Done when:** the choice and what was checked are in the Progress section.
The rest of Part A assumes option 1.

### A.1 Signaling: audio without renegotiation

Keep the "one offer, no renegotiation" design:

- In the initial offer the server adds:
  - one audio transceiver **recvonly** (from the server's view) for the
    player's microphone;
  - `voiceLanes` (= 4, **decision to review**) audio transceivers
    **sendonly**, each backed by a `TrackLocalStaticRTP` (Opus, 48 kHz,
    mono). A lane carries one speaker at a time, so a player hears at most
    4 people at once, and receives at most 4 × ~32 kbit/s.
- The client answers as usual. Its mic transceiver has no track until the
  player first pushes to talk; then it calls `sender.replaceTrack(mic)`,
  which needs no renegotiation. Releasing the key calls
  `replaceTrack(null)`, so nothing is sent while not talking.
- The server tells the client which player is on which lane over the
  signaling WebSocket: `{"event":"voice","data":{"lane":2,"userid":7}}`
  and `{"lane":2,"userid":0}` when the lane goes quiet. The page uses that
  for speaking indicators and per-player mutes.
- Sender limits on the client: `maxBitrate` 32 000 via
  `sender.setParameters`, mono, `echoCancellation`, `noiseSuppression`,
  `autoGainControl` on.
- `voice` events and the mic transceiver are only set up when voice is
  enabled on the server (A.6); old clients ignore the extra m-lines
  (check: a client from `main` still connects to a server with voice).

**Done when:** a client gets the offer with the audio lines, answers, and
the game works exactly as before with voice unused (same ping, no extra
packets while silent).

### A.2 Forwarding (Go)

New `src/server/voice.go`:

- `OnTrack` for the mic: read RTP packets. Drop the track if it isn't
  Opus or is a second mic track. Drop packets above 64 kbit/s averaged
  over 1 s (protects the server and listeners).
- For each packet from speaker S, for each listener L who **may hear S**
  (A.3) and hasn't been muted by the admin: if S already has a lane on L,
  write there; otherwise take a free lane (quiet for 300 ms or more); if
  none is free, drop the packet. A lane is free again after 500 ms with no
  packets from its speaker, and then the `voice` "lane quiet" event is
  sent.
- **RTP rewriting per lane:** when a lane switches speaker, keep its
  sequence numbers and timestamps continuous (offset from the new
  speaker's first packet), so the browser's jitter buffer doesn't stall.
  `TrackLocalStaticRTP` already rewrites SSRC and payload type.
- Ends with the session: lanes, the mic reader and all assignments are
  cleaned up in `gameSession.release`.
- Tests: lane assignment (free, busy, all busy, release after silence),
  sequence/timestamp rewriting across speaker switches and wraparound,
  rate limit.

**Done when:** two browsers hear each other with < 300 ms added delay on a
LAN, four people talking at once all get through, a fifth is dropped
cleanly, and server CPU stays reasonable with 16 players (measure with
fake microphones, `--use-fake-device-for-media-stream`).

### A.3 Who hears whom

Same rules as CS 1.6 with `sv_alltalk 0`:

- Alive players hear alive teammates.
- Dead players and spectators hear their dead teammates and alive
  teammates; spectators hear spectators.
- Alive players don't hear dead ones.
- `sv_alltalk 1`: everyone hears everyone. During intermission (map end):
  everyone.

Go needs each connection's team and alive state, live (the 2 s log
follower is too slow when someone dies mid-sentence):

- New AMXX plugin `src/amxx/wc_roster.sma` with a server command
  `wc_roster` that prints one line per connected human:
  `<ip:port> <userid> <team T|CT|SPEC> <alive 0|1>`, plus a first line
  `alltalk <0|1> intermission <0|1>`.
- Go runs it through the engine console every 250 ms while anyone is in
  voice (`console.go`), maps each fake `ip` to its `peerSlot` with
  `owns(ip)`, and keeps the result in a `voiceRoster` the forwarder reads.
  Players not in the roster yet (connecting) hear nobody and are heard by
  nobody.
- **Check** the console round trip is cheap enough at 4 per second; if
  not, the plugin pushes changes instead (writes a line only on team,
  alive or alltalk change, which Go reads from the AMXX log, or 1 s polling
  plus immediate updates on `DeathMsg` / spawn).
- Tests for the rules table (alive/dead/spec × same/other team ×
  alltalk × intermission).

**Done when:** in a 2 v 2 with four browsers, enemies never hear each
other, a teammate who dies stops being heard by the living within 0.5 s,
and `sv_alltalk 1` from the Match tab opens it up.

### A.4 Push to talk and settings (client)

- New `src/client/src/voice.ts`:
  - **Push to talk only** (no open mic; **decision to review**). Default
    key **K** (CS's `+voicerecord` key; check it isn't bound to anything
    the HUD uses). Holding the key starts sending, releasing stops after
    200 ms (so the last word isn't cut).
  - The key is taken from the game while held, the same way `chat.ts`
    takes keys (capture-phase listener before the engine's,
    `stopImmediatePropagation`), and not while the chat input or a menu is
    open (`modal.ts`).
  - Microphone permission is asked on the **first** press, never on page
    load. If refused: a toast "Microphone blocked" and the settings show
    how to allow it.
  - Incoming lanes play through an `<audio>` element each (or Web Audio
    `MediaStreamAudioSourceNode` → per-player gain), so per-player volume
    and mute work.
- Touch: a mic button next to the chat button (hold to talk).
- Settings, new group `Voice` in `SETTINGS`:
  - `voiceEnabled` toggle (default on; off means never ask for the mic and
    mute everyone).
  - `voiceKey` (Keys group, default K).
  - `voiceVolume` 0–100 % (default 80).
  - `voiceInput` choice of microphones (`enumerateDevices`, filled in after
    permission).
  - "Test microphone" level meter in the panel.

**Done when:** works on desktop Chrome, Firefox, Safari, Android Chrome and
iOS Safari; pressing K while chatting types "k"; no mic prompt until the
first press.

### A.5 Speaking indicators and mutes

- HUD: a "speaking" list on the left above the chat feed (name in team
  colour with a sound icon), from the `voice` lane events plus the local
  player while sending. The local player's own entry shows a mic icon.
- Scoreboard: speaker icon next to whoever is talking; a mute button per
  player (local, remembered by name in `localStorage`, wrapped in
  try/catch). Muted players' lanes play at 0.
- **Report/admin mute** (A.6) shows as a crossed-out mic for everyone.

**Done when:** indicators match who is talking within 100 ms; local mutes
survive a reload.

### A.6 Server and admin controls

- Env `VOICE=1|0` (default 1): 0 means no audio m-lines in the offer and
  no voice UI.
- `sv_voiceenable 0` from the Match tab turns voice off at runtime (the
  roster plugin reports it; the forwarder drops everything).
- F4 Players tab: **Mute voice** / Unmute per player (new admin actions
  `voice_mute {userid}` / `voice_unmute`, in `adminActions` and
  `actions.ts`); kept for the connection, cleared on reconnect
  (**decision to review**: keep by real address until map change?).
- Banned addresses never get this far (their WebSocket is refused).
- Voice is **not recorded or logged**. README says so, and that the
  server forwards audio without storing it.

**Done when:** each control works and the README describes voice, `VOICE`,
privacy and bandwidth (each player sends ≤ 32 kbit/s while talking and
receives ≤ 4 × 32 kbit/s).

---

## Part B — Adaptive bots

### B.0 Spike: what YaPB already does

- Read `addons/yapb/conf/yapb.cfg` in the image for difficulty cvars
  (`yb_difficulty`, any `yb_difficulty_auto`, `yb_difficulty_min/max`,
  per-bot difficulty on `yb add`). Write down what each does.
- Check whether changing `yb_difficulty` changes **existing** bots, or
  only bots added afterwards. If only new ones: applying a level means
  kicking and re-adding bots at round end (`yb kickall` + the quota
  refilling them), which is visible but fine between rounds.
- If YaPB has its own auto difficulty, check what it balances on (it may
  balance bots against each other, not against humans).

**Done when:** findings in the Progress section; the steps below are
adjusted to them. The plan assumes we run our own controller, because we
want it to follow the humans' results and show in the admin menu.

### B.1 Measuring how humans do against bots (Go)

- Hook into `statsTally` (`statsfollow.go`): for each counted kill,
  report human-vs-bot events to an observer: human killed bot, bot killed
  human. Human-vs-human and bot-vs-bot don't count. Events read again
  without counting after a restart (the catch-up read) are not reported.
- Also report round ends with the winning team and which team the humans
  were on (from the tally's `present` players).
- New `src/server/botskill.go` keeps a sliding window of the last
  **30 engagements** (human↔bot kills) and the last **6 rounds**.
- Needs the log follower: if the leaderboard database can't be opened,
  the follower must still run for adaptive bots (split "follow logs" from
  "save totals"), or adaptive bots are off with a warning. **Recommended:**
  split, so adaptive bots work without the database.

### B.2 The controller

- **Score:** humans' kill ratio against bots in the window,
  `r = humanKills / max(1, botKills)`, plus round results where humans and
  bots are on opposite teams.
- **Target:** `r` between 0.8 and 1.4 (**decision to review**; slightly in
  the humans' favour feels better).
- **Rules:**
  - At least 10 engagements since the last change before deciding.
  - `r > 1.4` and humans won 4 of the last 6 rounds → one level up.
  - `r < 0.8` and humans lost 4 of the last 6 rounds → one level down.
  - At most one change per 2 rounds (in Deathmatch / Gun Game without
    rounds: per 90 s).
  - Never outside `BOT_ADAPTIVE_MIN`–`BOT_ADAPTIVE_MAX` (default 0–4).
- **Finer steps** (if B.0 shows per-bot difficulty works): half levels by
  giving half the bots level n and half n+1 (e.g. 2.5), applied by
  re-adding bots at round end. Levels then go 0, 0.5, 1 … 4.
- **Applying:** at round start (never mid-round), through the console:
  `yb_difficulty <n>` (or the kick/re-add from B.0).
- **Telling players:** a chat line from the server "[Server] Bots are now
  Hard (humans won 5 of 6)" (setting `wc_bots_announce`, default on).
- Pure function `nextLevel(state, events) → (level, reason)` so it can be
  tested without the engine. Tests: steady state, streaks both ways,
  cooldown, min/max, too few engagements, a human joining mid-window
  (window resets when the number of humans changes by more than one).

**Done when:** in a solo game against 5 bots, playing well raises the level
within a few rounds and playing badly (standing still) lowers it, with the
chat line each time.

### B.3 Team balance

Difficulty alone isn't enough when, say, 3 humans are on CT against 5 bots
on T at the lowest level and still win every round, or 1 human is losing
every round with 4 bots on their side at level 0.

- When the level is at `BOT_ADAPTIVE_MAX` and humans still win 5 of the
  last 6 rounds: one more bot on the bots' team (up to `maxplayers`).
- When the level is at `BOT_ADAPTIVE_MIN` and humans still lose 5 of 6:
  one more bot on the humans' team (`yb add <difficulty> <team>`) or one
  fewer on the other team.
- Undo these extra bots first when things swing back, before changing the
  level.
- Works with `BOT_QUOTA` fill mode: the controller changes the quota and
  per-team placement through YaPB's commands, and the F4 Bots tab shows
  the result.

**Done when:** both edge cases above end up with close rounds within about
10 rounds, and bots are never added past `maxplayers`.

### B.4 Settings and admin

- Env: `BOT_ADAPTIVE=1|0` (default 0, **decision to review**),
  `BOT_ADAPTIVE_MIN`, `BOT_ADAPTIVE_MAX` (0–4, min ≤ max; invalid values
  log a warning and use the defaults, like `BOT_QUOTA`).
- F4 Bots tab: "Adaptive difficulty" toggle, min/max, and a status line:
  "Level 3 · humans 18 – 15 bots in the last 30 · last change 2 rounds ago
  (humans won 4/6)". New admin actions `bot_adaptive {on, min, max}`
  (in `adminActions` and `actions.ts`) and a `bot_adaptive_status` read.
- Setting the difficulty by hand in the Bots tab turns adaptive off (the
  status line says so).
- Kept over map changes until the server restarts (like the quota).
- `/status.json`: add the bot level ("Bots: Hard, adaptive") so the lobby
  can show it.
- README: what it measures, the env variables, and that it only looks at
  human-vs-bot kills.

**Done when:** each control works from the menu and env, and survives a map
change.

---

## Progress

Nothing started.

## Open questions

- A.0: WebRTC audio or engine voice (decided by the spike).
- A.1: 4 lanes (4 people heard at once) enough?
- A.4: push to talk only, or also an open-mic option with voice activity
  detection?
- A.6: admin voice mute per connection or per address until map change?
- B.2: target ratio, and adaptive bots on or off by default?
