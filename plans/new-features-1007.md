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

### A.0 done (2026-10-08): option 1, WebRTC audio tracks

**What was checked.** Engine files from `local/cs16-web-server:latest`
(`/xashds/public/assets`, the same `xash.wasm` as
`vendor/xash3d-fwgs-1.0.0.tgz`), the native server (`/xashds/xash`,
`cstrike/dlls/cs.so`), the game zip's configs, and a real headless client
with Chromium's fake microphone
(`plans/new-features-1007-tools/check-engine-voice.mjs`, see the README
there).

**Engine voice is compiled in, and it works.** Option 2 is not blocked:

- `xash.wasm` has `VoiceCapture_Init`, `Voice_GetOpusCompressedData`,
  `+voicerecord` / `-voicerecord`, the `voice_*` cvars and libopus; the
  Emscripten glue (`index-*.js`) has SDL2's audio capture through
  `getUserMedia({audio:true})` into a (deprecated) `ScriptProcessorNode`,
  and OpenAL capture. The server engine has `SV_ParseVoiceData`,
  `sv_voiceenable`, `sv_voicequality`; ReGameDLL `cs.so` has
  `CVoiceGameMgr` and `CCStrikeGameMgrHelper::CanPlayerHearPlayer`.
- In the client console: `voice_enable "1"`, `sv_voiceenable "1"`, 9
  `voice_*` cvars. The engine logs `VoiceCapture_Init: capture device
  creation success` right after "Setting up renderer", i.e. **at engine
  start, before connecting**, and `getUserMedia` has already been called
  once by the time the player is in the game.
- Holding `+voicerecord` with the fake mic: data-channel bytes sent go from
  ~150–390 B/s to **~4 000–4 950 B/s** (≈ 32–40 kbit/s), back to idle on
  `-voicerecord` (4 runs). A teammate (CT) running at the same time
  receives **~+4 000 B/s** for those 8 s (2 100–2 800 → 6 100–6 900 B/s);
  an enemy (T) receives nothing extra. So the netchan carries it, the server
  forwards it, and the game DLL routes by team. Playback wasn't checked
  (headless audio goes nowhere), and neither were Firefox, Safari or
  phones.
- `voice_enable 0` on the client (after joining) stops sending: 352 B/s
  while holding `+voicerecord`. `+sv_voiceenable 0` on the server's command
  line changed nothing seen from the client (it still sends at 4.9 KB/s;
  the server's real value wasn't read, since `cstrike/config.cfg` sets
  `sv_voiceenable "1"`).

**Engine voice is already on in production today.** The game zip's
`cstrike/config.cfg` and `kb_def.lst` bind **K to `+voicerecord`** and set
`voice_enable "1"`, `voice_forcemicrecord "1"`, `sv_voiceenable "1"`. So
today the engine asks for the microphone when the game starts (wherever
`navigator.mediaDevices` exists: https or localhost), and holding K sends
voice over the netchan to teammates.

**Decision: option 1 (WebRTC audio tracks), as the plan assumes.** Option 2
works, but:

- it puts ~4–5 KB/s per talker on the netchan and the data channel, and
  the server forwards that to every listener. That is the traffic the plan
  wanted to keep off (large netchan traffic has crashed this server
  before);
- the engine opens the mic at start, so the "no mic prompt until the first
  press" rule (A.4) can't be kept without patching the engine;
- there is no control from the page: SDL calls `getUserMedia({audio:true})`
  itself (no device choice, no bitrate cap, no per-player volume), on a
  deprecated `ScriptProcessorNode`;
- speaking indicators, mutes and admin mute would need cs16-client bridge
  work, which can only be built in the user's local webxash3d-fwgs
  checkout.

Its real advantage (team routing done by `CanPlayerHearPlayer`, the
scoreboard icons) is noted. **Decision to review** if the user prefers
"enable what's already there" over the plan's design.

**What later steps need to know:**

- **Turn the engine's voice off** whenever WebRTC voice is used (A.1/A.4),
  or there are two voice paths and K sends over the netchan too. That means
  client `voice_enable 0`, set **before the engine starts** if possible
  (e.g. in the engine's start arguments or an autoexec the page writes),
  so `VoiceCapture_Init` doesn't call `getUserMedia` at start. Setting it
  after joining stops sending (checked); whether setting it before start
  also stops the early `getUserMedia` call is **not checked**: A.4 must
  check it (count `getUserMedia` calls as `check-engine-voice.mjs` does).
  Unbinding K in the engine (`unbind k`), or A.4's capture-phase listener,
  keeps K for the page. On the server, `sv_voiceenable 0` belongs in the
  server config (check that `cstrike/config.cfg`'s `"1"` doesn't override
  it) so old clients can't use engine voice either.
- A.6 says `sv_voiceenable 0` from the Match tab turns voice off at
  runtime. That is the engine's own cvar, so with engine voice off as above
  it can double as the WebRTC switch, but the roster plugin has to report
  it.
- Fake mic in tests: Chromium `--use-fake-ui-for-media-stream
  --use-fake-device-for-media-stream` + `grantPermissions(['microphone'])`
  (the fake device is a beep). The engine's console output reaches the page
  console (`console.log` lines starting `[hh:mm:ss]`), so tests can read
  command output.
- The game zip isn't in the repo: copy or download
  `plans/new-features-1006-tools/cache/gamezip_8308.zip` (see that README;
  `cache/` is gitignored).

### A.1 done (2026-10-08): audio in the single offer

**What changed.**

- `src/server/voice.go` (new): `voiceLanes = 4`; `parseVoice` /
  `voiceEnabled` (the A.6 `VOICE` env gate, **stubbed now**: `""`/`1` on,
  `0` off, anything else warns and stays on; read in `main.go`);
  `newWebRTCAPI` (Opus 48000/2 PT 111 only, **empty interceptor registry**:
  before this pion registered its default codecs and interceptors
  (NACK, RTCP reports, TWCC) although only the data channel was used;
  now nothing is sent on an audio stream without voice);
  `addVoiceTransceivers(pc, signal)` adds, before the offer, one
  **recvonly** mic transceiver first, then 4 **sendonly** lanes, each a
  `TrackLocalStaticRTP` (id `lane0`..`lane3`, stream `voice`), and starts a
  goroutine per lane sender that reads and drops RTCP (ends with the
  PeerConnection). `voicePeer{mic, lanes, signal}` and
  `announceLane(lane, userid)` sends `{"event":"voice","data":{"lane":n,"userid":u}}`
  on the signaling WebSocket (`userid` 0 = quiet). **Lanes are numbered
  from 0** (0–3), in sendonly m-line order.
- `src/server/sfu.go`: `websocketHandler` calls `addVoiceTransceivers`
  after creating the data channel when `voiceEnabled`, keeps the result in
  `gameSession.voice`; `runSFU` uses `newWebRTCAPI`. Still one offer, no
  renegotiation. m-lines: mids 0 (mic), 1–4 (lanes), 5 (data), one BUNDLE.
- `src/client/src/webrtc.ts`: `voiceMids(sdp)` finds the mic (the audio
  m-line the server only receives on) and the lanes (sendonly, in order)
  from the offer, **before** `setRemoteDescription` (which fires
  `ontrack`). The mic transceiver is set to `sendonly` before the answer,
  with no track, so nothing is sent. New on `Xash3DWebRTC`:
  `voiceAvailable`, `setMicTrack(track | null)` (`replaceTrack`, then caps
  `maxBitrate` at `VOICE_MAX_BITRATE` = 32 000 when encodings exist; also
  tried right after the answer), `onVoiceLane(lane, userid)` (from `voice`
  events; non-integer data ignored), `onVoiceTrack(lane, track)` (from
  `ontrack`, matched by mid). `VOICE_MIC_CONSTRAINTS` (mono, echo
  cancellation, noise suppression, auto gain) is exported for A.4's
  `getUserMedia`. Teardown clears all of it.
- README: `VOICE` row in the env table. Tools:
  `plans/new-features-1007-tools/check-voice-signaling.mjs` (README
  there); the 1006 `run-server.sh` passes `VOICE` and can serve another
  client build with `PUBLIC_DIR`.
- **Engine voice not turned off yet.** A.1 adds no way to talk over
  WebRTC, so the engine's own voice (K = `+voicerecord`) is left as it
  was; turning it off belongs with A.4 (the step that makes WebRTC voice
  usable), see the A.0 notes.

**What was checked.**

- Go: `gotest.sh` (gofmt clean, vet, all tests). New `voice_test.go`:
  `parseVoice`; the offer has 1 recvonly + 4 sendonly Opus audio m-lines,
  mic first, plus the data channel, all in one BUNDLE; with voice off it is
  data only; a pion client that adds nothing (like an old page) answers and
  the server accepts the answer; `announceLane` events and lane bounds.
- `npm run build`, `tsc --noEmit`; Prettier: my additions are clean
  (`webrtc.ts` and `README.md` already failed `--check` at HEAD on lines I
  didn't touch; the diff Prettier wants is the same size before and after).
- Image rebuilt (`local/cs16-web-server:latest`; the previous image is
  tagged `local/cs16-web-server:pre-a1`). Headless Chromium with the fake
  mic, `check-voice-signaling.mjs`, de_dust2 with 2 bots:
  - voice on, new page: 1 offer; offer mids 0 recvonly, 1–4 sendonly
    (Opus), 5 application; answer 0 sendonly, 1–4 recvonly; page found mic
    0 and lanes 1–4. **10 s silent: 0 RTP packets either way**; transport
    31 pkt/s up / 51 down, ICE RTT ~1 ms.
  - `VOICE=0`: offer and answer data only; silent 31 / 50 pkt/s, same RTT.
    So voice unused costs nothing measurable.
  - `talk`: `setMicTrack(fake mic)` → `maxBitrate` [32000], ~50 RTP pkt/s
    out (+~3.5 KB/s on the transport, ≈ 28 kbit/s); `setMicTrack(null)` →
    0 RTP, back to 31 pkt/s; still 1 offer in total (no renegotiation).
    The server has no `OnTrack` yet, so pion drops that audio quietly (no
    log lines).
  - Fed `voice` events → `onVoiceLane` got `{2,7}`, `{2,0}`; bad data
    ignored.
  - **Old client** (page copied from the pre-A.1 image; `webrtc.ts` was
    the same as `origin/main`'s) against the voice server: joins and plays;
    it answers mic `inactive`, lanes `recvonly`; 0 RTP while silent; `voice`
    events ignored.
- **Not checked:** Firefox, Safari, phones (no browsers for them here);
  in particular whether Firefox/Safari have sender encodings before a
  track is attached (if not, `setMicTrack` applies the cap then). No
  incoming lane audio yet (A.2), so `onVoiceTrack` firing was only seen
  indirectly (the lanes' transceivers exist; not logged).

**What A.2 needs to know.**

- `gameSession.voice` (`*voicePeer`) holds `mic` (the
  `RTPTransceiver`; set `peerConnection.OnTrack` in `websocketHandler`
  or in `addVoiceTransceivers`, and check the track's
  `RTPTransceiver`/mid is the mic's) and `lanes[i]` (write with
  `WriteRTP`; it rewrites SSRC/PT, A.2 does seq/timestamp). Nothing ties
  `voicePeer` to `peerSlot` yet: the slot is made in
  `gameSession.channelOpened`; A.2 can copy `session.voice` into the
  `peerSlot` there and clean up in `release`.
- **Old clients answer the lanes `recvonly`** too, so the server could
  send them audio they never play. Forward only to players whose answer
  has the mic m-line (mid of `voice.mic.Mid()`) as `sendonly`/`sendrecv`
  (read `pc.RemoteDescription()` after the answer), i.e. pages with voice
  code.
- `signal` is the signaling socket's `WriteJSON`. **The socket can close
  after the game is connected** (the session goes on: "losing the
  signaling socket no longer ends the game", and the page sets `this.ws =
  undefined`), so `voice` events can stop reaching a player mid-game.
  Writes then just fail. A.2/A.5 should decide whether that's acceptable
  or move the events to the data channel / a second data channel (that
  would mean renegotiation unless created up front).
- No interceptors: no RTCP sender reports or NACK. If A.2 wants sender
  reports (A/V sync isn't needed) it has to add them to `newWebRTCAPI`;
  measure the silent packet rate again if so.
- The client's mic is `sendonly` from the answer on and A.4 only needs
  `getUserMedia({audio: VOICE_MIC_CONSTRAINTS})` +
  `engine.setMicTrack(track)` / `setMicTrack(null)`.

### A.2 done (2026-10-08): forwarding

**What changed.**

- `src/server/voice_forward.go` (new): the forwarder.
  - `voiceHub` (`voices`, one per server; `run` sweeps every 100 ms,
    started in `runSFU` when voice is on) holds the players in voice.
    `route(speaker, seq, ts, now)` decides, under the hub's mutex, which
    listener lanes a packet goes to and with which numbers; the mic reader
    then writes them outside the lock. `sweep` releases lanes.
  - **Lanes:** a speaker who has a lane on a listener keeps it; otherwise
    the first free lane, else the lane whose speaker has been quiet longest
    if that is **≥ 300 ms** (taken over: the page gets the new userid on
    that lane, no "quiet" in between); else the packet isn't sent to that
    listener. A lane with no packet for **500 ms** is released and the
    "quiet" event (userid 0) is sent.
  - **RTP rewriting per lane:** `seqDelta` / `tsDelta` set when a speaker
    takes the lane so their first packet gets the lane's next sequence
    number and a timestamp moved on by the wall-clock gap since the lane's
    last packet (at least one 20 ms frame); uint16/uint32 arithmetic, so
    wraparound (the speaker's or the lane's) needs nothing special; late
    packets don't move the lane's numbers back. The marker bit is set on a
    speaker's first packet on a lane. Header extensions and padding are
    stripped (the lanes negotiate none). SSRC / PT: `TrackLocalStaticRTP`.
  - **Mic:** `pc.OnTrack` (set in `addVoiceTransceivers`) reads only the
    first Opus track whose receiver is the mic transceiver's; any other
    track is read and dropped (logged). Its RTCP (sender reports) is
    drained. One goroutine per mic, reusing one buffer and one
    `rtp.Packet`.
  - **Rate limit:** `byteRate`, a token bucket of 8 000 B/s (64 kbit/s)
    holding at most 1 s, counting whole RTP packets; packets over it are
    dropped (the browser sends ~4.6 KB/s at the 32 kbit/s cap).
  - **Who hears whom is behind `voicePolicy`** (`userID`, `mayHear`,
    `adminMuted`). **Stand-in until A.3: `openVoicePolicy`**: every other
    player in voice hears every speaker; `adminMuted` is a **stub** (always
    false, A.6); and **the announced `userid` is a placeholder, the slot
    index plus 1, not the engine's userid** (Go doesn't know userids
    before the A.3 roster).
  - Lane events go through a queue per listener (64; dropped with a
    warning if full) and a goroutine per player (`sendEvents`), so a slow
    socket never holds up audio.
  - `voiceAnswered(remoteDescription, micMid)`: only players whose answer
    has the mic m-line `sendonly`/`sendrecv` join the hub (as speaker and
    listener). Old pages (mic `inactive`) are never sent audio.
- `voice.go`: `voicePeer` gains the hub state (`ip`, `joined`/`left`,
  per-lane `out`, `events`) and the **`voice` data channel** (below);
  `addVoiceTransceivers(pc, signal, hub)` also creates that channel and
  sets `OnTrack`. `announceLane` → `sendVoiceEvent`.
- `sfu.go`: `peerSlot.voice` is set from `gameSession.voice` in
  `channelOpened`, which also joins the hub (with the slot's address) when
  `gameSession.voiceCapable` (computed in the game channel's `OnOpen`, the
  answer being set by then). `release` calls `voices.leave`: the player's
  lanes on others are released with "quiet" events, their own lane state
  and event goroutine end; the mic reader and lane RTCP readers end with
  the PeerConnection.
- **The signaling WebSocket, checked in `sfu.go`:** both A.1 and the plan
  are right. The server keeps it open for the whole session (pings every
  20 s, 45 s pong deadline, and it is only closed when reading fails), and
  the page keeps it too; but if it drops (a proxy, a network change, a
  missed pong window) neither side reopens it and the game goes on
  ("losing the signaling socket no longer ends the game"), so lane events
  sent on it would be lost from then on. **Decision: a reliable, ordered
  `voice` data channel**, created by the server up front next to `game`
  (same SCTP association, so the offer's SDP is unchanged and there is no
  renegotiation), carries the events once open: the same JSON
  (`{"event":"voice","data":{...}}`, as text). Before it opens (or if a
  write fails) they go on the WebSocket as in A.1. `webrtc.ts` handles
  `voice` messages from both (`voiceLane`). Pages without voice code ignore
  the channel (they only take `game`). In the Chromium runs below every
  lane event came over the data channel.
- **No interceptors added** (no RTCP reports / NACK). Silent rates
  re-measured with `check-voice-signaling.mjs`: unchanged (below).
- Tools (`plans/new-features-1007-tools`, README there):
  `check-voice-pair.mjs`, `voice-light-client.js` (a voice client without
  the engine), `check-voice-delay.mjs`, `check-voice-crowd.mjs`,
  `voice-crowd.sh`; `pw.sh` passes `START`, `DURATION`, `LABEL`,
  `NETWORK`. README: the `VOICE` row says the server forwards voice.

**What was checked.**

- Go (`gotest.sh`: gofmt, vet, all tests). New `voice_forward_test.go`:
  lane assignment (four speakers take lanes 0–3, a speaker keeps theirs, a
  fifth is dropped for the full listener but reaches the others, not taken
  at 299 ms, taken at 300 ms from the speaker quiet longest, release at
  500 ms not 499, a released lane taken at once); policy (`mayHear`,
  admin mute, unknown userid, a peer outside the hub, no self-hearing);
  leave (quiet events, queue closed, twice is fine, leave-before-join);
  seq/timestamp rewriting across speaker switches (1 s gap → +48 000,
  minimum one frame, late packets) and wraparound (the lane's and the
  speaker's, seq and ts); the rate limit (32 kbit/s always passes; 160
  kbit/s for 10 s passes 1 s of burst + 64 kbit/s; refills to 1 s);
  `voiceAnswered`; and **end to end through pion** (three loopback pion
  clients: a talker's RTP arrives on the listener's `lane0`, continuous
  across the talker's seq/ts wrap, the lane event comes over the `voice`
  data channel as text, the quiet event after the sweep; nothing reaches a
  client that answered the mic `inactive`, nor the talker). No `-race`
  (the test image is linux/386).
- `npm run build`, `tsc --noEmit`; Prettier: my lines clean (the files I
  touched already differ from Prettier at HEAD by the same amount).
- Image rebuilt (`local/cs16-web-server:latest`; the A.1 image is tagged
  `local/cs16-web-server:pre-a2`). Headless Chromium, fake microphone:
  - **Two players in the game** (`check-voice-pair.mjs`, real page and
    engine): `onVoiceTrack` fired for lanes 0–3 on both; A talks 5 s: A
    sent 274 RTP packets, B got 274 on lane 0, `onVoiceLane` {0, A},
    then {0, 0}; B talks: 267 sent, 267 on A's lane 0, same events.
  - **Delay** (`check-voice-delay.mjs`, two light clients in one page, 10
    beeps): mouth to ear **61 ms median** through the server (60–73),
    direct connection in the page 68 ms (60–80): the server adds nothing
    measurable (< the ±10 ms of the method). Lane jitter buffer 29 ms,
    0 lost. All on one machine (ICE RTT 1 ms), not a real LAN. (Measuring
    with two game engines running gave 225–840 ms and missed beeps: the
    SwiftShader engines starve the browsers' audio, so the engine-less
    clients were used.)
  - **Five talkers and a listener**
    (`voice-crowd.sh "2-20 2-20 2-20 2-20" "6-26 -"`): the listener had 4 lanes at 50 pkt/s each from 2 s;
    the fifth talker (from 6 s) wasn't heard by it while the four talked
    (no event, no packets: dropped cleanly) and took a lane at **20.32 s**
    (300 ms after the four stopped); the four's lanes went quiet at
    20.57 s, the fifth's at 26.57 s. The fifth talker and each of the four
    heard 4 lanes. No errors in the server log.
  - **16 talkers** (four containers of 4 light clients, all talking
    5–25 s): every client had 4 lanes × ~50 pkt/s for the 20 s (800 pkt/s
    in, 3 200 out at the server). **Server container CPU: 29–37 % of one
    core while all 16 talk**, 5–7 % connected and silent (11–15 % in the
    first seconds after connecting). The clients ran on the same 4-core
    machine (shared, some steal time); the image is 32-bit (linux/386), so
    SRTP's AES has no assembly. The engine wasn't involved (light clients
    take an SFU slot but never join the game).
  - A.1's `check-voice-signaling.mjs talk` again: offer/answer as before;
    **silent 0 RTP, 31 pkt/s up / 51 down** (unchanged); talking alone, 0
    RTP in (nobody else, no self-echo). Old client (pre-A.1 page): mic
    answered `inactive`, joins and plays, 0 RTP.
- **Not checked:** Firefox, Safari, phones; a real LAN between machines;
  16 real game clients (light clients instead; two real ones above);
  audible playback (headless; decoded audio was seen by the analyser);
  the WebSocket actually dropping mid-game (the data channel path is what
  carried every event, so it no longer matters).
- Engine voice (K = `+voicerecord`) is still on, as in A.1: A.4 turns it
  off.

**What A.3 needs to know.**

- Replace `voices = newVoiceHub(openVoicePolicy{})` with a policy fed by
  the roster. Its methods run under the hub's mutex for every packet ×
  listener (~3 200/s with 16 talkers), so they must only read a snapshot
  (e.g. an atomic pointer to a map from the engine address `ip [4]byte`, or
  from `*voicePeer`, to {userid, team, alive}) and never block or call the
  console.
- `voicePeer.ip` is the engine's address for the player (`peerSlot`
  `owns(ip)`); `peerSlot.voice` links a roster line's address to the
  `voicePeer`. Players not in the roster: `userID` ok=false (not heard)
  and `mayHear` false (hear nobody).
- `userID` must return the real engine userid: **until then the events'
  userid is the slot index plus 1**, so A.5 can't use it before A.3.
- When `mayHear` turns false mid-sentence the audio stops at once, but
  the lane is only announced quiet 500 ms after its last packet. With a
  250 ms roster poll that's up to ~0.75 s for the indicator; if A.3/A.5
  want it faster, add a hub method that releases (and announces) lanes
  whose listener may no longer hear the speaker when the roster changes.
- `adminMuted` is the A.6 hook (speaker heard by nobody).

### A.3 done (2026-10-08): who hears whom

**What changed.**

- `src/amxx/wc_roster.sma` (new, in `plugins.ini` after `wc_killinfo`,
  compiled in the `amxx-plugins` stage): server command `wc_roster` prints
  `alltalk <0|1> intermission <0|1> voiceenable <0|1>`, then
  `<ip:port> <userid> <T|CT|SPEC> <alive 0|1>` per human in the game
  (`get_players "ch"`: no bots, no HLTV, no one still connecting; no team
  yet = `SPEC`). `alltalk` is `sv_alltalk != 0`; `intermission` is set by
  the `SVC_INTERMISSION` message (`register_event("30")`) and cleared by
  the next map's `plugin_init`. **`sv_voiceenable` is in the first line
  already (cheap), parsed into `voiceRoster.voiceEnable`, not used yet**
  (A.6). Names are never printed.
- `src/server/voice_roster.go` (new): `parseRoster` (lines that don't
  parse are skipped; no header = error, e.g. the plugin missing);
  `canHear` (the rules: alltalk or intermission → everyone; otherwise
  same team only, spectators being their own team; the living hear only
  the living, the dead hear dead and living teammates); `voiceRoster`
  (immutable snapshot: settings + `map[*voicePeer]rosterPlayer`),
  built by `buildVoiceRoster` with `gameVoicePeer` (`connections.Get(ip[0])`
  and `peerSlot.owns(ip)` → `peerSlot.voice`, so a line for a slot's previous
  player maps to nobody); `rosterPolicy` (the `voicePolicy`: an
  `atomic.Pointer[voiceRoster]`, nothing else, so it's safe under the hub
  lock; `userID` returns the **engine's userid**, ok=false and
  `mayHear` false for anyone not in the roster; `adminMuted` still a stub
  for A.6); `rosterPoller`: every 250 ms, **only while the hub has anyone
  in it** (`voiceHub.active`), runs `wc_roster` through the console (1 s
  timeout), publishes the snapshot and calls `voiceHub.recheck`. With
  nobody in voice the snapshot is dropped and the console isn't touched.
  If reading fails the last roster is kept for 2 s (a map change), then
  dropped (nobody hears anybody), logged once if it lasts 2 s.
- `voice_forward.go`: `voices = newVoiceHub(voicePolicyNow)` (the roster
  policy); `openVoicePolicy` moved to the tests. New `recheck`: releases,
  with their "quiet" events, the lanes whose speaker is no longer known,
  admin-muted or allowed for that listener. So **a death goes quiet at the
  next roster read, not 500 ms after the last packet**: audio stops and
  the page is told in the same step.
- `main.go`: `ensureConsole` (the existing "no admin API" fallback,
  factored out) is also called when voice is on, so the roster works
  without `ADMIN_PASSWORD` and without the leaderboard database; starts the
  poller.
- **`sv_alltalk 0` in `configs/cstrike/server.cfg`.** Xash3D registers
  `sv_alltalk` itself with the default **`1`** ("legacy, unused",
  `sv_main.c`), so without this everyone heard everyone (the first roster
  reads said `alltalk 1`). This also makes the engine's own voice (still on
  until A.4) team-only via ReGameDLL.
- **Match tab:** new field "All talk (voice)" (`sv_alltalk`, on/off,
  applies now, kept over map changes): `cvars.ts`, `match.ts` `FIELDS`,
  and `adminCvars` in `admin_actions.go` (test cases for 1 and the refused
  2). The plan's "`sv_alltalk 1` from the Match tab" had no field before.
- **Engine patch `patches/engine/rcon-quiet-console.patch`** (see the cost
  check below for why). Dockerfile comment updated; `console.go` and
  `statsfollow.go` comments too.
- README: `wc_roster.amxx` row in the plugins table, the `VOICE` row says
  who hears whom. Tools: `check-voice-teams.mjs`,
  `check-voice-roster-cost.mjs`, `voice-roster-cost.sh` (README there);
  `pw.sh` passes `DEATHS`.

**The plan's check: console round trip at 4/s. Decision: keep the 250 ms
poll (not the push fallback), plus an engine patch for the logs.**

- Time per `wc_roster` call (temporary instrumented build, 40-call
  windows over ~8 min, 1–4 players): **mean 0.7–2.4 ms, max 14 ms**. That
  includes waiting for the engine frame to pick the packet up, so the
  engine's own work is less.
- Effect on the server (`voice-roster-cost.sh 60`: 1 real player + 4 bots,
  60 s, voice on = poll running vs `VOICE=0`): server CPU **12.4 % vs
  11.8 %** and, on the final image, **12.8 % vs 12.0 %** of one core; game
  packets the player received **49.6 vs 49.1** and **49.3 vs 49.4 /s**
  (the server frame isn't slowed); ICE RTT 1.0–1.8 ms either way. So the
  poll costs well under 1 % of a core and nothing visible in tick or ping.
- **But it flooded the logs.** For every rcon packet the engine prints
  `Rcon from 254.0.0.1:12345:` + the packet **with the rcon password** to
  stdout (Docker logs), writes `Rcon: "<packet>" from ...` (password again)
  to the game log when logging is on, and everything the command prints
  during the redirect also goes to stdout (`Sys_Print` →
  `Sys_PrintLog`, then `Rcon_Print`): with the plugin that's the header and
  one line per player. At 4/s that is ~4 + N lines a second (≈ 56/s, ~5
  million a day, with 10 players) whenever anyone is in voice: Docker logs
  become unreadable and fill the disk, and the password is repeated in
  them. Seen in the first runs.
- Options weighed: (a) the plan's push fallback (the plugin writes changes
  to a file / the AMXX log, Go tails it) avoids rcon entirely but is a new
  mechanism with its own latency and partial-write problems, to solve a
  problem that isn't the cost the fallback was meant for; (b) polling only
  while someone is talking still floods while they talk and leaves the
  roster stale at the start of each sentence; (c) a small engine patch
  that keeps the in-process console quiet. **Chose (c).**
- **What the patch changes** (3 files, ~20 lines, applied with the
  existing `git apply /patches/engine/*.patch`): `host_redirect_t` gets a
  `quiet` flag (`common.h`); `SV_RemoteCommand` (`sv_client.c`) treats a
  packet whose address string starts with `254.0.0.1:` (Go's
  `consoleAddr`, which no player can have: player addresses start with
  their slot 0–127) as quiet: no `Rcon from` print, no `Rcon:` log line,
  and `host.rd.quiet` is set while the command runs under the redirect;
  `Sys_Print` (`system.c`) skips `Sys_PrintLog` (stdout and the engine's
  log file) while `host.rd.quiet` is set, but still calls `Rcon_Print`, so
  **Go still gets the full output**. Nothing changes for any other address:
  browser rcon (the `RCON_PASSWORD` path) is printed and logged as before,
  and `Bad rcon_password.` is still printed.
- **Side effect:** the admin API's and the log follower's console commands
  (and their output, e.g. `status` for a ban) no longer appear on the
  server console either. Both already log what they run in Go
  (`admin: <ip>: <action>: <command>`, the rename lines), so nothing is
  lost but duplicate noise and the password. The address string in the
  patch must match `consoleAddr` (comment added at both ends).
- After the patch, a full 2 v 2 run left **0** `Rcon` lines and no
  roster output in `docker logs`.

**What was checked.**

- Go (`gotest.sh`: gofmt, vet, all tests). New `voice_roster_test.go`:
  the **rules table** (alive T / dead T / alive CT / dead CT / spectator as
  listener × the same as speaker, i.e. same / other team, × alltalk ×
  intermission, 100 cases against an explicit "who hears whom" list);
  `parseRoster` (header with and without `voiceenable`, ip with/without
  port, bad lines skipped, text before the header, no header = error);
  `rosterPolicy` (no roster = nobody; teammates/enemies; a player not in
  the roster neither hears nor is heard; a line for an address with no
  voice peer; alltalk); `gameVoicePeer` (only the slot's current player);
  the **poller** with a fake console (no console call with nobody in voice;
  real userid in the lane event; a death releases the lane at the next read
  with its quiet event and stops the audio; the dead hear the living;
  alltalk; failures keep the roster 2 s then drop it and release lanes;
  output without the header counts as a failure; everyone leaving drops
  the roster); `recheck` (only the disallowed lanes go: not heard any
  more, admin-muted, left the roster). Admin action tests for `sv_alltalk`.
- `npm run build`, `tsc --noEmit`; Prettier: my lines clean (`match.ts`
  and `README.md` already differed at HEAD; README tables re-run through
  Prettier).
- `.sma` compiles in the image build (amxxpc, no warnings) and is in the
  image's `plugins.ini`.
- Image rebuilt (`local/cs16-web-server:latest`; the A.2 image is tagged
  `local/cs16-web-server:pre-a3`). **2 v 2 with four real game clients**
  (`check-voice-teams.mjs`, one Chromium + SwiftShader engine each, fake
  mic; no bots). Five runs in all: two on an instrumented build (roster
  changes and call times logged), one on the image with a first version of
  the patch (it still echoed the command output), and three on the final
  image. Rules, alltalk and the dead-hear-living checks passed in every
  run; the only failures were an early "last packet sampled < 500 ms"
  check that the starved pages can't measure (replaced by "no packets
  from 1 s on" + the quiet event time) and a first intermission check
  that talked too early (rewritten); the last final-image run passed
  everything:
  - with the server's default `sv_alltalk` (0 now): T1 talks → T2 got
    179–211 packets / 4 s, C1 and C2 **0 packets and no lane events**; C1
    talks → C2 only, the Ts 0. Enemies never heard each other in any run.
  - **Death:** T1 runs `kill` while talking: T2's lane quiet event came
    **107–460 ms** after the kill (9 trials: 156, 208, 422, 292, 143,
    460, 107, 360, 248), no packets from T1 after it; the CTs got nothing. The
    server saw the death **42 ms** after the page's `kill` (instrumented
    build), so most of that is the poll (≤ 250 ms) and the starved pages
    (four SwiftShader engines on 4 shared cores: the pages' timers and
    getStats samples come in 100–500 ms bursts, so these are upper bounds).
  - The dead T1 hears T2 (129–158 packets / 3 s) and is heard by nobody
    (0 everywhere).
  - **`sv_alltalk 1` through the admin API's `cvar` action** (what the
    Match tab sends): dead T1 heard by T2, C1, C2 (~140–160 each / 3 s), C1
    by everyone; `sv_alltalk 0` closes it again (C1 → C2 only).
  - Lane events carry the **engine userid** (T1 = 1 for T2 and for C1;
    with no bots, userids 1–4 happen to equal slot+1, so this run can't
    tell them apart; the unit test with userids 21–23 does).
  - **Intermission:** `mp_timelimit 1` (the map had run > 1 min) at
    15:30:32.9; the Ts started hearing C1 (enemy, alltalk 0) **1.8 s**
    later; the map changed at 15:30:44.7 (AMXX `nextmap` waits
    `mp_chattime`). After the map change all four are unassigned (CS makes
    everyone pick a team again), reported as `SPEC`, so they hear each
    other until they join teams, as in CS (unassigned players share team
    0 there).
- **Not checked:** Firefox, Safari, phones; a real LAN; more than 4 real
  players in the roster (the output is one short line per player and the
  redirect flushes per line, so the 2 KB buffer isn't a limit); the
  roster failing for > 2 s in real use (only in tests); a map change while
  someone talks (seen only as above); the death timing on a machine where
  the clients aren't starved.

**What A.4 needs to know.**

- `voice` lane events now carry the **engine userid** (`#userid`, the one
  in `status`, kill lines and the scoreboard), so A.5 can map lanes to
  players.
- A player hears nobody and is heard by nobody until they are in the game
  (the roster lists them, ≤ 250 ms after joining the hub, and only once
  `putinserver` happened); before picking a team they are "spectators"
  (hear and are heard by other spectators / unassigned players).
- The engine's own voice is still on (K = `+voicerecord`); with
  `sv_alltalk 0` it is now team-only too. A.4 turns it off as the A.0
  notes say. If A.4 uses `sv_voiceenable 0` on the server for that, note
  the roster already reports it and A.6 means to use it as the WebRTC
  switch: pick one meaning (A.6: `voiceRoster.voiceEnable` is parsed but
  unused; `rosterPolicy.adminMuted` is still the stub).
- Any new Go console command now runs quietly (no console/log echo):
  log what matters in Go.

### A.4 done (2026-10-08): push to talk and settings (client)

**What changed.**

- **Engine voice off, checked.** `engine.ts` starts the engine with
  `+voice_enable 0` (start arguments; they run after the game's
  `config.cfg`, which sets it to 1). Counting `getUserMedia` calls in the
  page: the A.3 image's page calls it **once** during engine start
  (`VoiceCapture_Init: capture device creation success`); with the argument
  **0 calls** through engine start, joining and playing, `voice_enable` reads
  `"0"`, and no `VoiceCapture` line. `attachVoice` also runs `unbind k`
  (K was `+voicerecord`; nothing else in the game's binds or the page used
  K; J, L, P are unbound in stock CS too). `sv_voiceenable` untouched (A.6).
- `src/client/src/voice.ts` (new):
  - **Push to talk** with the `voiceKey` setting (matched on
    `KeyboardEvent.code`, so keyup matches keydown whatever Shift does).
    Capture listeners (keydown, keypress, keyup) registered after
    `modal.ts`'s and `chat.ts`'s (main.ts imports `./voice` right after
    `./chat`) and before the engine's: an open menu or the chat input keeps
    the key (K types "k"), otherwise `preventDefault` +
    `stopImmediatePropagation` keep keydown, repeats and keyup from the
    engine. Ctrl/Alt/Meta + key are left alone. Blur releases.
  - Press: `getUserMedia({audio: VOICE_MIC_CONSTRAINTS})` (with
    `deviceId: {exact}` when a microphone is picked, falling back to the
    default if it is gone) on the **first** press only, then
    `setMicTrack(track)`. Release: `setMicTrack(null)` **200 ms** after the
    last holder (key or touch) lets go; pressing again within it keeps
    sending. **Decision to review:** the capture stays open 30 s
    (`MIC_IDLE_MS`) after the last use so the next press starts at once,
    then its tracks are stopped (the browser's recording indicator goes off;
    on iOS an open capture also changes the audio session). Nothing is sent
    while not talking either way (no track on the sender).
  - Refused: notice "Microphone blocked" in the HUD (`#hud-voice-notice`,
    6 s, with how to allow it) and the same help in the settings' Voice
    group; also "No microphone" (NotFoundError), "Microphone unavailable"
    (insecure page / in use).
  - **Playback:** per lane `MediaStreamAudioSourceNode` → per-lane
    `GainNode` (per player, `setPlayerGain`, for A.5) → master `GainNode`
    (`voiceVolume`) → speakers, plus a muted `<audio>` element per lane
    (Chrome only feeds remote WebRTC audio to Web Audio while a media
    element plays it; without it the graph would be silent). Element
    `volume` was avoided because iOS ignores it. The `AudioContext` is
    resumed on the first key or tap in game, suspended when voice is off or
    the game is left. A lane whose speaker isn't known yet plays at gain 1
    (its event can arrive just after the first packets).
  - `initVoice(engine)` right after `createEngine()` (the lanes' tracks come
    with the offer, before `start()`), `attachVoice(touch)` in `start()`,
    `detachVoice()` when the connection is lost for good (stops talking,
    closes the mic, drops lanes). A new connection's tracks replace the old
    lanes (announced quiet).
  - **Touch:** `#voice-button` (hold to talk, `aria-pressed` while
    sending), top row left of the settings button, above the chat button;
    shown with touch controls while in game, voice on, the server offering
    voice and no game menu open. Pointer capture, `touch-action: none`, no
    context menu.
  - **Hooks for A.5, not built:** `onVoiceEvent(listener)` (`lane` events
    with the engine userid, `talking` for the local player),
    `setPlayerGain((userid) => gain)`, `isTalking()`.
- Settings (`settings/schema.ts`, `settings/index.ts`): new group `Voice`
  with `voiceEnabled` (default on; off stops talking, closes the mic, master
  gain 0, context suspended; K then goes to the engine, where it is
  unbound), `voiceVolume` (0–100 %, default 80), `voiceInput` (new setting
  kind **`device`**: a device id string, `''` = default, checked against
  printable ASCII ≤ 256 chars; the panel's select gets its options from
  `setDeviceOptions`, which voice.ts fills from `enumerateDevices` once the
  names are visible, i.e. after permission; a saved device not present is
  kept as "Saved device (not found)"), and `voiceKey` in Keys (K, J, L, P,
  off). The panel also has "Test microphone" with a level meter (Web Audio
  analyser on the same capture, never played back, stops after 20 s or when
  the panel closes) and a status/help line. New panel exports:
  `setDeviceOptions`, `settingsGroupFields`, `onSettingsPanel`.
- README: Features bullet (voice controls and settings), `VOICE` row no
  longer says "no voice UI yet". Tools: `check-voice-ptt.mjs` (README there).

**What was checked** (`npm run build`, `tsc --noEmit`; Prettier with the
repo's style — `--trailing-comma es5`, which leaves HEAD's files clean except
`webrtc.ts` and README's YAML block — clean on every file touched; no Go
touched). Image rebuilt (`local/cs16-web-server:latest`; the A.3 image is
tagged `local/cs16-web-server:pre-a4`), `check-voice-ptt.mjs` against it,
headless Chromium, fake microphone, de_dust2 without bots, all OK in the
last two runs on the image and the last `PUBLIC_DIR` run before (numbers from
the final run):

- No `getUserMedia` on A or B before the first press (0 / 0); A: once on the
  first K.
- Holding K 4 s: A sent 169 RTP packets, B got 182 on lane 0 (lane event
  `[0, 1]`, A's engine userid) and **played it**: peak RMS 0.24 after B's
  master gain; at voice volume 0 it is 0.00000.
- **Game data channel while holding K: 210 B/s vs 200 B/s idle** (other
  runs 201 vs 224, 182 vs 202; A.0's engine voice added ~4 000 B/s): the
  engine no longer sends voice.
- Release: `setMicTrack(null)` was called 608 ms after the keyup, exactly
  when a plain 200 ms `setTimeout` started at the same keyup fired (608 ms:
  the SwiftShader engine starves the page's timers); 454 ms = 454 ms in the
  run before, and 285 / 441 ms in the first runs (before the timer
  comparison was added). So the code waits the
  200 ms tail; how late timers run depends on the machine. No RTP after.
- Y then K: the chat field got "k", 0 RTP.
- B with the permission denied (CDP): "Microphone blocked" notice shown
  (screenshot), one `getUserMedia` call, the settings' help says how to
  allow it.
- Voice off: K asks for nothing, sends nothing, master gain 0.
- Login page, browser without the fake UI: only "Default microphone"
  before the permission; after it the two fake microphones are listed and
  the test meter peaks at 84–100 %; volume 55, key J and a picked
  microphone survive a reload.
- Phone viewport (844×390, `isMobile`, `hasTouch`): the mic button shows
  next to the chat button, not over cs16-client's touch buttons
  (screenshot); no `getUserMedia` before it is held; held with CDP touch
  events: `aria-pressed` true, 223 RTP packets sent, B got 228; nothing
  after letting go. (Without the try/catch around `setPointerCapture` the
  CDP touch pointer threw `InvalidStateError`; touch pointers are captured
  implicitly anyway.)
- `VOICE=0` server: `voiceAvailable` false, holding K calls no
  `getUserMedia`.

**Not checked:** Firefox, Safari, Android Chrome, iOS Safari and real phones
(none here): in particular the muted-element + Web Audio playback on iOS,
whether iOS lets the `AudioContext` resume from the key/tap listener, the
"blocked" help text against each browser's real UI, and device names in
Firefox (it may list them only while capturing). Audible output (headless:
levels measured in the graph instead). A real microphone and the browser's
permission prompt (the fake UI accepts it). Talking through a reconnect (a
held key is not re-attached to the new connection until the next press).
An older cs16-client without the HTML HUD (the engine's chat line would not
keep K from voice; 0.0.10 is what's shipped).

**What A.5 needs to know.**

- `onVoiceEvent` gives `{type:'lane', lane, userid}` (engine userid, 0 =
  quiet; a new connection's lanes are announced quiet) and
  `{type:'talking', talking}` for the local player (true on press, false
  after the 200 ms tail or when voice is turned off). The speaking list
  can be built from these alone.
- Mutes: call `setPlayerGain((userid) => muted ? 0 : 1)` again whenever the
  mute list changes; it is applied to every lane at once and on each lane
  event. Userids come from the scoreboard / killinfo (same `#userid`).
- `isTalking()` for the local "mic" entry. The HUD notice element
  (`#hud-voice-notice`) sits at 32 % from the top, centred.
- With voice off the page still receives lane events (the server keeps
  forwarding; A.6 may want the page to tell the server, to save the
  bandwidth).

## Open questions

- A.0: decided, WebRTC audio (see Progress). Engine voice works too and is
  already on (K = `+voicerecord`); revisit only if the user prefers it.
- A.1: 4 lanes (4 people heard at once) enough?
- A.4: push to talk only, or also an open-mic option with voice activity
  detection? Keep the microphone open 30 s after talking (instant next
  press) or close it at once (no recording indicator, ~0.1–0.3 s to reopen)?
- A.6: admin voice mute per connection or per address until map change?
- B.2: target ratio, and adaptive bots on or off by default?
