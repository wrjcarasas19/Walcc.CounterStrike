# Headless checks (new-features-1007)

Builds on `../new-features-1006-tools` (read its README first): same server
script (`run-server.sh`), same `lib.mjs`, same `node_modules` and `cache/`
with the game zip. Scripts here import `../new-features-1006-tools/lib.mjs`.

## Files

- `pw.sh <script.mjs> [args...]`: like the 1006 `pw.sh`, but mounts the
  whole `plans/` folder and runs a script from this folder with the working
  directory in `new-features-1006-tools` (so `cache/` and `node_modules`
  are found there). Same env (`OUT`, `BASE`, `ADMIN_PASSWORD`, `VERBOSE`,
  `ZIP_PORT`) plus `VOICE_ENABLE`. Import Playwright as
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

## Notes

- Chromium flags for a fake microphone: `--use-fake-ui-for-media-stream
  --use-fake-device-for-media-stream`, plus
  `context.grantPermissions(['microphone'])`. The fake device is a beep.
- The engine's console output reaches the page console (`console.log`,
  lines start with `[hh:mm:ss]`), so `page.on('console')` can read the
  output of commands run with `engineCommand`. `condump` doesn't exist in
  this engine.
