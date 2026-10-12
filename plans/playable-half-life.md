# Playable Half-Life in the browser

Goal: "Play Half-Life" on the login page runs the campaign through level changes and in-session save/load, not only the first maps. Today the prebuilt browser engine (`apps/client/vendor/xash3d-fwgs-1.0.0.tgz`) can't name the game library's functions (`COM_NameForFunction` relies on `dladdr`, which names nothing in Emscripten), so entities that cross a level change stop working (`Error: Invalid function pointer in entity!`, tram stalls after `c0a0b → c0a0c`) and saves break. See `apps/hlsdk-portable/AGENTS.md`, "Known limitation".

Decisions (from the user):
- Build the browser engine from source in a Dockerfile stage, with a patch that gives Emscripten builds a real function name lookup. New folder `apps/xash3d-fwgs` with its own guide replaces the vendored tgz.
- Saves stay session only (in-memory filesystem); they must work within a session.
- Verify with a throwaway headless Playwright script in the scratchpad, using the Chromium in `~/.cache/ms-playwright`; nothing committed for it.
- Commit each verified wave on `play-half-life-poc`; never push (a push to `main` deploys).

Assumptions:
- Pin the engine to the same sources the vendored package came from: `yohimik/webxash3d-fwgs` (wrapper, `packages/xash3d-fwgs`) and engine commit `eeca965` of the FWGS fork it uses. If those can't be resolved exactly, pick the closest commit and record the reason in the Dockerfile comment.
- Counter-Strike must keep working on the rebuilt engine (same package API, same file names).
- Touch controls and the generic main menu stay as they are.

## Wave 1 (2 agents in parallel: independent, no shared files)

### S1 — Build the browser engine from source (no behaviour change) — DONE
- Result: engine pinned to yohimik/xash3d-fwgs `4cbc288` (served via FWGS/xash3d-fwgs), emsdk 4.0.11; wasm exports/imports identical to the vendored build; harness shows the same Half-Life behaviour as the vendored engine.
- Goal: replace the vendored tgz with an engine package built by a Dockerfile stage, so later steps can patch the engine. Why: the fix lives in engine C code.
- Read first: `AGENTS.md`, `apps/client/AGENTS.md`, `apps/hlsdk-portable/AGENTS.md`, `apps/server/Dockerfile` (stages `cs16-client`, `hlsdk-portable`, the client build stage), `apps/client/package.json`, the tgz contents (`package/package.json`, `dist/generated/xash.js`), upstream `yohimik/webxash3d-fwgs` (its Dockerfile, `scripts/patch-emscripten-js.mts`, build flags).
- Owned files: new `apps/xash3d-fwgs/` (`AGENTS.md`, `package.json`, `patches/` if needed, `.gitignore` for `dist/`), `apps/server/Dockerfile` (new stages `xash3d-fwgs`, `xash3d-fwgs-dist`, client stage wiring), `apps/client/package.json`, `apps/client/package-lock.json`, removal of `apps/client/vendor/xash3d-fwgs-1.0.0.tgz`, `.dockerignore`, root `AGENTS.md` app table, `apps/client/AGENTS.md` references to the vendor tgz, `apps/client` npm script `build:xash3d-fwgs`.
- Depends on: none.
- Done when: `docker build --platform=linux/amd64 -f apps/server/Dockerfile --target xash3d-fwgs-dist --output apps/xash3d-fwgs/dist .` produces a package with the same export paths and file names as the tgz; `npx tsc -p tsconfig.json` and `npm run build` pass in `apps/client`; the full image builds; every upstream is a pinned `ARG` with a comment.
- Verify: commands above, `make build-local-image`, and S2's harness reaching an in-game map on the rebuilt engine for both `valve` and `cstrike` (orchestrator runs it).

### S2 — Headless playthrough harness (scratchpad, not committed) — DONE
- Result: `node <scratchpad>/hl-harness/run.mjs [--scenario tram,changelevel,saveload] [--timeout-scale 2]`. Baseline: all three FAIL with `Invalid function pointer in entity!` from the first level change (c0a0→c0a0a), on both the vendored and the rebuilt engine.
- Goal: a repeatable browser check of Half-Life playability, so the fix can be proven. Run it against the current image to reproduce the bug as a baseline.
- Read first: `apps/client/src/main.ts` (`playHalfLife`), `apps/client/src/engine.ts`, `apps/client/src/gamefiles.ts` (zip URL, CORS note), `apps/hlsdk-portable/AGENTS.md` "Verify".
- Owned files: `<scratchpad>/hl-harness/` only. It may run `make build-local-image` / `make run` but must not edit the repo. (The `-dev 2` flag is injected at runtime through the page, e.g. by routing/patching the served JS, not by editing `engine.ts`.)
- Depends on: none.
- Done when: `node hl-harness/run.mjs [--url http://127.0.0.1:27016]` uses Playwright + cached Chromium, serves the game zip with CORS through a route (cache the zip on disk once), presses "Play Half-Life", then via `Cmd_ExecuteString` runs scenarios: (a) `map c0a0` and let the tram cross to `c0a0e`, (b) `map c1a0` → `changelevel c1a0d`/trigger walk, (c) `save s1` then `load s1`; it collects the engine console and reports PASS/FAIL per scenario (FAIL on `Invalid function pointer`, `null function`, wasm traps, or the map not advancing), with screenshots. Baseline run shows the known failure.
- Verify: run it against the current image; report output.

## Wave 2 (1 agent: one shared contract between engine and game library)

### S3 — Function name lookup for Emscripten builds — DONE
- Result: `apps/xash3d-fwgs/patches/0001-emscripten-name-for-function.patch` names a function table entry by the side module's export of the same function. On the rebuilt amd64 image, at `sys_timescale` 1: tram c0a0 → c0a0e, `changelevel2 c1a0d c1a0toc1a0d`, and `save s1`/`load s1` all PASS with no `Invalid function pointer`; the hlsdk exports in its guide are present; Counter-Strike joins de_dust2.
- Goal: make `COM_NameForFunction` / `COM_FunctionFromName` work in the browser so save/restore and level transitions keep entity think/touch/use functions.
- Read first: S1's `apps/xash3d-fwgs/AGENTS.md`, engine `platform/posix/lib_posix.c`, `engine/common/lib_common.c`, how Emscripten `dlopen` side modules expose exports and table indices, `apps/hlsdk-portable/patches/emscripten-side-modules.patch`.
- Owned files: `apps/xash3d-fwgs/patches/*`, `apps/hlsdk-portable/patches/*` (e.g. exporting all game functions), the two apps' `AGENTS.md`, `apps/hlsdk-portable/package.json` version if bumped, Dockerfile lines for those two stages.
- Depends on: S1, S2.
- Done when: the harness passes all scenarios on the rebuilt image; Counter-Strike still loads a map; the client exports listed in `apps/hlsdk-portable/AGENTS.md` "Verify" are still present.
- Verify: `make build-local-image`, `make run`, `node hl-harness/run.mjs`.

## Wave 3 (1 agent: docs, small)

### S4 — Docs and leftover playability fixes — DONE
- Result: README, `apps/client/AGENTS.md` and the `playHalfLife` comment describe level changes and session saves as working. The harness surfaced no page-side issue.
- Goal: README and guides describe Half-Life as playable (session-only saves), remove the "Known limitation" text, and fix any small page-side issue the harness surfaced (e.g. touch, pointer lock).
- Owned files: `README.md`, `apps/client/AGENTS.md` (Half-Life section), `apps/hlsdk-portable/AGENTS.md`, `apps/client/src/main.ts` / `engine.ts` only for harness-found issues.
- Depends on: S3.
- Done when: docs match behaviour; `npx tsc` and `npm run build` pass.

## Final verification
- `cd apps/client && npx tsc -p tsconfig.json && npm run build`
- `make build-local-image && make run`, then `node <scratchpad>/hl-harness/run.mjs` (all PASS) and a Counter-Strike join to a map (no regression); read `docker compose logs cs16-web-server`.
- The Go test from the root guide is unaffected (no Go change); run it only if S1 touched the Go stage.

## Summary
- Wave 1: 2 agents (engine build from source; test harness). Wave 2: 1 agent (the fix). Wave 3: 1 agent (docs and small fixes).
- Risks: reproducing the exact webxash3d-fwgs build (flags, JS patch script) may take iteration; Emscripten may not expose side-module function names without exporting every function from `hl`, which grows the wasm; other browser-only issues may appear once the tram passes (they'd be fixed in S3/S4 or reported).

## Found, not in scope
- The game-files cache never works in Chromium: IndexedDB rejects the 407 MB zip as one value (`The serialized keys and/or value are too large (size=406846421, max=133169152)`), so every visit downloads it again, for Counter-Strike too (`apps/client/src/gamefiles.ts`). Storing it in chunks or in the Cache API would fix it; ask the user first.
- The source-built engine differs from npm's by about 32 bytes, because the git commit and date are embedded in `host_ver`. The build number is still 3773.
