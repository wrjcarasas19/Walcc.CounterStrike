# Headless checks (new-features-1007)

Builds on `../new-features-1006-tools` (read its README first): same server
script (`run-server.sh`), same `lib.mjs`, same `node_modules` and `cache/`
with the game zip. Scripts here import `../new-features-1006-tools/lib.mjs`.

## Files

- `pw.sh <script.mjs> [args...]`: like the 1006 `pw.sh`, but mounts the
  whole `plans/` folder and runs a script from this folder with the working
  directory in `new-features-1006-tools` (so `cache/` and `node_modules`
  are found there). Same env (`OUT`, `BASE`, `ADMIN_PASSWORD`, `VERBOSE`,
  `ZIP_PORT`) plus `VOICE_ENABLE`, `START`, `DURATION`, `LABEL` and
  `NETWORK` (the docker network, default `host`), `DEATHS`, `CYCLES`,
  `STOP_AFTER`, `FPS`. Import Playwright as
  `../new-features-1006-tools/node_modules/playwright/index.mjs`.
- `check-engine-voice.mjs talker|listener [ct|t]`: the A.0 spike, the
  engine's own voice chat (`voice_enable`, `+voicerecord`) with Chromium's
  fake microphone (`--use-fake-device-for-media-stream`). `talker` counts
  `getUserMedia` calls and data-channel bytes sent idle / while holding
  `+voicerecord` / idle again, and prints the engine's console lines about
  voice (the engine prints to the page console: `VERBOSE=1` shows all).
  `VOICE_ENABLE=0` sets the client cvar to 0 before recording. `listener`
  prints bytes received per second for 180 s. Run both at once:
  `ZIP_PORT=27091 ./pw.sh check-engine-voice.mjs listener [t] &` then
  `./pw.sh check-engine-voice.mjs talker`. Results are in the plan's
  Progress section (A.0).

- `check-voice-signaling.mjs [talk]`: A.1, the voice audio in the single
  offer. Joins as "VoiceSig" with the fake mic and prints the audio m-lines
  of the offer and the answer (direction per mid), what the page found
  (`voiceAvailable`, mic mid, lane mids), RTP / transport / data-channel
  packets during 10 s of silence and the ICE round trip, and what
  `onVoiceLane` gets from `voice` events fed to the page's signal handler.
  `talk` also attaches the fake mic with `setMicTrack` (replaceTrack),
  checks RTP goes out with `maxBitrate` 32000, detaches it and checks it
  stops, and that no second offer came. Works with a page or server without
  voice (prints "old client" / "no voice"). Server variants:
  `VOICE=0 ../new-features-1006-tools/run-server.sh`, and an old client with
  `PUBLIC_DIR=<copy of /xashds/public from an older image>` (both env
  variables were added to the 1006 `run-server.sh`).

- `check-voice-pair.mjs`: A.2, two players in the game ("VoiceA",
  "VoiceB", one browser each: two SwiftShader engines in one browser share
  its GPU process and the second one times out) hear each other: A then B
  talk 5 s with the fake mic, the other's lane gets the RTP,
  `onVoiceTrack` fired for the 4 lanes and `onVoiceLane` shows who was on
  the lane and that it went quiet.
- `voice-light-client.js`: loaded into a page of the server's origin, a
  voice client without the engine (`window.voiceConnect(i)`: signaling,
  the single offer, mic answered sendonly, the `voice` data channel). The
  server gives it a slot and puts it in the voice hub, so many fit on one
  machine.
- `check-voice-delay.mjs [beeps]`: A.2, mouth-to-ear delay through the
  server between two light clients in one page (Web Audio beeps detected
  with an AnalyserNode on both ends), and over a direct connection in the
  page for comparison; the difference is what the server adds.
- `check-voice-crowd.mjs <clients> [talk windows]`: A.2, up to 4 light
  clients (the server allows 4 WebSockets per address) following a talk
  timeline (`from-to` seconds per client, `-` never) that starts at
  `START`; prints each client's lane events and, per second, lanes carrying
  audio and packets in / out.
- `voice-crowd.sh "<windows>" "<windows>" ...`: runs one
  `check-voice-crowd.mjs` container per argument on a docker network of
  its own (`cs16-voice`, 10.177.77.0/24; one address per container) against
  a fresh server container, on a shared timeline, and prints the server
  container's CPU about every second (from its cgroup). Removes the server
  and network afterwards (`KEEP=1` keeps them). E.g. 5 talkers and a
  listener: `./voice-crowd.sh "2-20 2-20 2-20 2-20" "6-26 -"`; 16 talkers:
  four arguments of `"5-25 5-25 5-25 5-25"`. Results in the plan (A.2).

- `check-voice-teams.mjs`: A.3, who hears whom in a 2 v 2 of real game
  clients (T1, T2 Terrorists, C1, C2 CTs; one browser each, 640×400).
  Start the server without bots (`run-server.sh de_dust2 0`). Leaves
  `sv_alltalk` at the server's default (must be 0), restarts the round,
  then: each team's talker is heard by their teammate only; T1 runs `kill`
  while talking (`DEATHS` times, default 3, round restart in between): no
  more of T1's packets reach T2 and the lane's quiet event time after the
  kill is printed (when T2's page handled it: four SwiftShader engines
  starve the pages, so this is an upper bound, and getStats samples come
  in bursts); the dead T1 hears T2 and isn't heard; `sv_alltalk 1` through
  the admin API (the Match tab's action) opens everything, `0` closes it;
  finally `mp_timelimit 1` ends the map and C1 talks until after the map
  change: the Ts' first lane event time shows when the intermission opened
  it (the map change itself isn't detected; after it everyone is
  unassigned, which counts as spectator, so they hear each other as in
  CS). Prints OK / FAIL per check.
- `check-voice-roster-cost.mjs [seconds]` and `voice-roster-cost.sh`
  (same argument): A.3, the cost of the 250 ms roster poll. The script joins one
  player and records, per second, game packets received and the ICE round
  trip; the shell script runs it against a fresh server with voice on (the
  poll runs) and with `VOICE=0` (no poll) and adds the server container's
  mean CPU. `BOTS` (default 4).

- `check-voice-ptt.mjs [novoice]`: A.4, push to talk and the voice
  settings through the real page (voice.ts), not `setMicTrack` by hand.
  Start the server without bots (`run-server.sh de_dust2 0`). PttA (fake
  mic allowed) and PttB (microphone denied with CDP
  `Browser.setPermission`, browser without the fake UI) join as CTs; then:
  no `getUserMedia` before the first press (and `voice_enable` 0, K
  unbound); holding K sends RTP, B gets it and plays it (level after the
  page's master gain, found by wrapping `AudioNode.connect`) while the game
  data channel stays at its idle rate; the release tail (when
  `setMicTrack(null)` is called after the keyup, next to a plain 200 ms
  timer started at the keyup, since the starved page's timers run late); K
  in the chat input types "k"; B's voice volume 0 silences A; B pressing K
  shows "Microphone blocked" and the settings' help; voice off asks for
  nothing and sends nothing; on the login page (no fake UI, permission then
  granted) the microphone list fills in after the permission, the test
  meter moves, and changed settings survive a reload; PttC on a touch phone
  viewport (844x390) holds the microphone button with CDP touch events and
  B hears it. Screenshots `a4-*.png` in `out/`. `novoice`, against
  `VOICE=0 run-server.sh de_dust2 0`: K asks for nothing. Prints OK / FAIL.

- `check-voice-hud.mjs`: A.5, the speaking list and the mutes through the
  real page (voice-hud.ts). Start the server without bots (`run-server.sh
  de_dust2 0`); after a client rebuild, start it again: the server keeps
  the page's files gzipped in memory from its start (`static.go`), so
  `PUBLIC_DIR` changes aren't served to browsers until then. HudA and
  HudB (desktop, fake mic) join as CTs: `CYCLES` (default 5) presses of
  K, timing B's list entry against B's lane event (DOM mutation and the
  next frame), and its removal against the last
  packet B played (`getSynchronizationSources`, as the page polls it), A's
  `setMicTrack(null)` and the server's quiet event; A's own entry against
  the key. Then B's scoreboard (Tab): speaking icon, the hidden mute buttons
  while the pointer is locked, a right click frees it, clicking mutes
  (`voice-mutes` in localStorage), a click on the game locks again; muted:
  level 0 after the master gain and the lane's gain 0, not listed; B loads
  the page again and rejoins: still muted, then unmuted by a click and heard;
  a `{"muted":[userid]}` voice event fed to both pages shows the crossed-out
  microphone (A.6's display hook); HudC on a touch phone viewport: the list
  above the chat, the scoreboard (`+showscores`) mute button tapped with CDP
  touch events. `STOP_AFTER=1` stops after the timing; `FPS` sets the
  engines' `fps_max` (it didn't make the pages' timers less late here).
  Screenshots `a5-*.png`. Prints OK / FAIL.

- `check-voice-admin.mjs [novoice]`: A.6, the server and admin controls.
  Start the server without bots (`run-server.sh de_dust2 0`). AdmA
  (talker) and AdmB (listener, admin) join as CTs: baseline (B gets A's
  RTP); B clicks Mute on AdmA's row in F4 → Players: B gets no packets and
  no lane event while A holds K, both pages get `{"muted":[userid]}`, both
  scoreboards show the crossed-out microphone and A's own speaking entry is
  crossed out; Unmute: heard again; `sv_voiceenable 0` / `1` through the
  admin API (the Match tab's `cvar` action): nobody heard / heard again;
  B turns Voice chat off in F3: the page sends `{"listen":false}` and the
  server sends B nothing, on again: heard. Also: the login page shows the
  Voice settings. `novoice`, against `VOICE=0 run-server.sh de_dust2 0`:
  status.json `voiceOff`, no Voice settings on the login page or in game,
  no mic button, speaking list, scoreboard voice cells or hint, no
  `getUserMedia` on K, no Mute button in the Players tab. Screenshots
  `a6-*.png`. Prints OK / FAIL.

## Notes

- Chromium flags for a fake microphone: `--use-fake-ui-for-media-stream
  --use-fake-device-for-media-stream`, plus
  `context.grantPermissions(['microphone'])`. The fake device is a beep.
  On an address other than localhost the page isn't a secure origin and
  has no `getUserMedia`: add
  `--unsafely-treat-insecure-origin-as-secure=<origin>`.
- The engine's console output reaches the page console (`console.log`,
  lines start with `[hh:mm:ss]`), so `page.on('console')` can read the
  output of commands run with `engineCommand`. `condump` doesn't exist in
  this engine.
