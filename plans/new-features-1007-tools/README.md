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
  `NETWORK` (the docker network, default `host`). Import Playwright as
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
