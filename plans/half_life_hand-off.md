# Half-Life hand-off

State of the "playable Half-Life" work as of 2026-10-12, when the orchestration was paused. The plan is `plans/playable-half-life.md`; read it first. This file says what is done, what is in the working tree, and what is left.

## Decisions already made (by the user)
- The browser engine is built from source in Docker (`apps/xash3d-fwgs`), with our patches in `apps/xash3d-fwgs/patches/`.
- Saves last for the session only (the engine's in-memory filesystem). No IndexedDB persistence.
- Verification uses a throwaway headless Playwright harness in the scratchpad. It is not committed.
- Commit each verified wave on `play-half-life-poc`. Never push: a push to `main` deploys.

## Done and committed
- **S1, wave 1** (`5ced195 Build the browser engine from source`):
  - Upstream pins: engine yohimik/xash3d-fwgs `4cbc288` (fetched through `FWGS/xash3d-fwgs`), emsdk 4.0.11, wrapper from webxash3d-fwgs `fedcda8`.
  - The vendored tgz is gone; `apps/client` depends on `file:../xash3d-fwgs`.
  - The wasm exports and imports are identical to the vendored build.
- **S2, wave 1** (harness, scratchpad only; see "Harness" below):
  - Baseline: all three scenarios FAIL with `Error: Invalid function pointer in entity!` from the first level change, on both the vendored and the rebuilt engine.
  - Baseline logs: `out/baseline-vendored/` and `out/baseline-s1engine/`.

## S3 (wave 2): fix written, not verified by the orchestrator, not committed
The S3 subagent was stopped at the user's request, just as it began a final harness run.

### Uncommitted working tree
- `apps/xash3d-fwgs/patches/0001-emscripten-name-for-function.patch` (new). It adds an `EM_JS` branch to `COM_NameForFunction` in `engine/platform/posix/lib_posix.c`:
  - A function pointer is an index into `wasmTable`.
  - `wasmTable.get(ptr)` is the same JS function object as the side module's export, so the patch maps it to an export name of the library in `LDSO.loadedLibsByHandle[hInstance]`. The Map is built once per library.
  - When Binaryen has merged identical functions, the patch prefers member-function names with the signatures `COM_ConvertToLocalPlatform` rebuilds.
  - `COM_FunctionFromName` is unchanged: `dlsym` returns the existing table index.
- `apps/xash3d-fwgs/patches/.gitkeep` is deleted (the folder now holds a real patch).
- `apps/xash3d-fwgs/AGENTS.md`: a new section, "Function names for save/restore", and the patches row is updated.
- `apps/hlsdk-portable/AGENTS.md`: "Known limitation" is replaced by a description of the fix, and the Verify step lists `_ZN11CBaseEntity10SUB_RemoveEv`.
- No change was needed in `apps/hlsdk-portable/patches/`: game functions are already `EXPORT`ed, and a side module exports them.

### Harness results the subagent got with the patch (in `out/s3/`; rerun before trusting them)
| Run | tram | changelevel | saveload |
|---|---|---|---|
| `run1` (`sys_timescale 2`) | FAIL: stalled after c0a0a, 0 errors | PASS: c1a0d loaded, 0 errors | PASS: save + load, frames advance |
| `run2-tram-speed1` (`--speed 1`) | PASS: reached c0a0e cleanly | not run | not run |

- The `run1` tram stall had no error lines. It is most likely the harness's double timescale rather than the engine. To confirm, run tram at speed 1 again and decide whether the harness default should be `--speed 1`.
- The Counter-Strike check is inconclusive. `out/s3/cs-new` and `out/s3/cs-old-wasm` both time out (exit 124), and the logs show `server 127.0.0.1:8080` with 404s. So that check ran against a locally served dist, not the image. Redo it against the image (`cs-check.mjs`).

### The container
- `cs16-web-server` (compose project in the repo root, image `6acb247fe329cadcaa7bcb99-cs16-web-server`) is running on http://127.0.0.1:27016.
- It may or may not include the final patch. Rebuild with `docker compose up -d --build` before verifying; plain `make run` does not rebuild.
- `.env` was created from `.env.example` and is git-ignored.

## Next steps
1. **Finish S3.**
   - Rebuild: `docker build --platform=linux/amd64 -f apps/server/Dockerfile --target xash3d-fwgs-dist --output apps/xash3d-fwgs/dist .` (slow, up to ~75 min on this host), then `docker compose up -d --build`.
   - Run the harness: `node run.mjs --scenario tram,changelevel,saveload --speed 1 --timeout-scale 2`. All three must PASS with zero `Invalid function pointer`.
   - Check that the hlsdk exports listed in `apps/hlsdk-portable/AGENTS.md` "Verify" are still present.
   - Check that Counter-Strike joins a map on the image.
   - Review the patch, mark S3 done in `plans/playable-half-life.md`, then commit, e.g. `Name game functions for save/restore in the browser engine`.
2. **S4 (wave 3).**
   - README line 17: Half-Life is playable through level changes; saves last the session.
   - `apps/client/AGENTS.md` Half-Life section: drop "Map changes that carry entities, and saves, are broken".
   - Fix any small page issue the harness surfaced.
   - Then `npx tsc -p tsconfig.json` and `npm run build` in `apps/client`.
3. **Final verification** from the plan.

## Not in scope, but found
- **The game-files cache never works in Chromium.** IndexedDB rejects the 407 MB zip as one value: `The serialized keys and/or value are too large (size=406846421, max=133169152)`. So every visit downloads it again, for Counter-Strike too (`apps/client/src/gamefiles.ts`). The fix would be storing it in chunks or using the Cache API. Ask the user before taking it on.
- The S1 build is about 32 bytes different from npm's, because the git commit and date are now embedded in `host_ver`. The build number is still 3773.

## Harness
- **Location:** `/tmp/claude-0/-srv-alfie-workspace-6acb247fe329cadcaa7bcb99/279c8b13-6a18-456c-9a5e-8fb7382fd358/scratchpad/hl-harness/` (scratchpad; it may not survive the session).
  - `run.mjs`: the main harness.
  - `cs-check.mjs`, `run-s3ab.mjs`: S3's helpers.
  - `cache/gamezip_8308.zip`: the game zip.
  - `out/`: logs and screenshots.
- **Command:** `node run.mjs [--url http://127.0.0.1:27016] [--scenario tram,changelevel,saveload] [--timeout-scale 2] [--speed N] [--fresh] [--failfast]`. It exits 1 if any scenario fails.
- **How it works:**
  - It rewrites the served `/assets/index-*.js` to add `-dev 2` and to expose `window.__xash`.
  - The game zip request is redirected (307) to a local CORS file server.
  - Scenarios: tram `map c0a0` through `c0a0e`; changelevel `map c1a0` then `changelevel2 c1a0d c1a0toc1a0d`; saveload `save s1` then `load s1`.
- **FAIL on:** `Invalid function pointer`, `Host_Error`, `Sys_Error`, `RuntimeError`, `null function`, `unreachable`, or a map that never loads.
- **Timing:** about 5–10 min to boot, about 7–20 min for the tram, about 3–5 min per other scenario. The host is often heavily loaded; use `--timeout-scale 2`.
- **If the scratchpad is gone,** rebuild the harness from this description; S2's brief is in the plan.
