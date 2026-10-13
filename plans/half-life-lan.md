# Half-Life LAN game

Goal: friends on the same network open a page and play Half-Life deathmatch together in their browsers (crossfire, stalkyard, …), the way they already play Counter-Strike. Today "Play Half-Life" is single player only: the engine runs the game's server inside one page, and browsers can't open UDP sockets or find LAN servers, so nothing else can join it. `plans/playable-half-life.md` (done) made the browser engine and the Half-Life client library work through level changes; this plan builds on that.

## Decisions (confirmed by the user: the recommended options)
1. **Where the game runs.** (a) A Half-Life dedicated server in a second container from the same image (`-game valve`), joined over the existing `/websocket` + WebRTC path. (b) One browser hosts and the others connect to it over WebRTC, with the Go server only signalling. Recommended: (a). It reuses the transport Counter-Strike already proves; (b) needs new engine networking in the wrapper and the game ends when the host closes the tab.
2. **Server game library.** (a) Build `hl.so` (Linux i386) from the same pinned `HLSDK_COMMIT` as the browser client (`apps/hlsdk-portable`). (b) Use Valve's `valve/dlls/hl.so` from the HLDS archive as is. Recommended: (a). The client's weapon prediction, user messages and HUD must match the server's code; Valve's later Steam builds can drift from the SDK the client is built from.
3. **Where it runs.** LAN only: a compose profile `hl` that `docker compose up -d` (and so the VPS deploy) never starts, and the deploy's `yq` drops the service. Putting it on the staging VPS too is a follow-up.
4. **Scope of the Half-Life server.** No leaderboard, claimed names, bots, community maps or F4 admin menu. Those are written for Counter-Strike (log lines, YaPB/AMXX in `cstrike/`, game-mode actions). Bans, `/status.json` and the lobby list still work.

The user chose 1(a), 2(a), LAN only, and the reduced scope; the rest of this plan follows them.

## Shape
- New compose service `hl-web-server`, profile `hl`, same image and build as `cs16-web-server`, `entrypoint: ["./xash", "+ip", "0.0.0.0", "-port", "27015", "-game", "valve"]`, `command: ["+map crossfire", "+maxplayers 16"]`. Ports: host 27026 → container 27016 (page, `/websocket`, HTTP); 27028 TCP+UDP for WebRTC (`PORT: 27028`, same number inside and outside because it is advertised). `IP: ${LAN_IP:-127.0.0.1}`: the address other machines reach this host at. Named volume `hl-data` on `/xashds/data` (bans only). The two services run independently; the engine's 27015/udp stays inside each container.
- Start: `docker compose --profile hl up -d`. Players open `http://<LAN_IP>:27026`.
- The page served on 27026 is the same build. It learns from `/status.json` which game the server runs and, for `valve`, joins as Half-Life.
- **Contract between `apps/server` and `apps/client`:** `/status.json` gains `"game": "cstrike" | "valve"`, the server's `-game` folder. It is always present.

Assumptions:
- Xash3D on both ends, so the protocol matches; only the game library pair (decision 2) must match.
- The game-files zip already holds `valve/` with the 12 deathmatch maps and their WADs, so no map downloads are needed (`cl_allowdownload 0` stays).
- The page needs no secure context: there are no pthreads, no COOP/COEP headers, and WebRTC data channels work over plain `http://` on a LAN IP. L5 checks this from a second machine.
- Counter-Strike behaviour, its compose service and the VPS deployment are unchanged.

## Wave 1 (3 agents in parallel: separate files; they share only the `game` field above)

### L1 — Image: Half-Life server library, configs, compose service — DONE
- Result:
  - Stage `hlsdk-portable-server` builds a 32-bit `hl.so` in about 20 s.
  - Xash runs `valve` as a dedicated server even though HLDS's `liblist.gam` says `singleplayer_only`.
  - The Counter-Strike server runs only `cstrike/server.cfg`, so the `valve/` configs are Half-Life's own. `default.cfg` no longer forces `maxplayers 12` or `log on`, and `config/server.cfg` holds the deathmatch settings.
  - The workflow's `yq` output, checked locally, has no `hl-web-server`.
- Goal: the image can run a Half-Life deathmatch server, and compose can start one next to Counter-Strike.
- Read first: `AGENTS.md`, `apps/server/AGENTS.md`, `apps/hlsdk-portable/AGENTS.md`, `apps/server/Dockerfile` (stages `engine`, `hlsdk-portable`, `hlds`, `final`), `apps/server/configs/valve/*`, `valve/liblist.gam` in the image, `docker-compose.yml`, `.env.example`, `.github/workflows/deploy.yml` ("Write compose files").
- Owned files: `apps/server/Dockerfile` (new stage `hlsdk-portable-server`: the pinned `HLSDK_COMMIT`, a 32-bit gcc build like the `engine` stage, target `server` only; `final` copies it over `valve/dlls/hl.so`), `apps/server/configs/valve/` (deathmatch `server.cfg` settings such as `mp_timelimit`, `mp_fraglimit` and `hostname`; `mapcycle.txt` with the 12 stock DM maps), `docker-compose.yml` (service `hl-web-server` as in "Shape"), `.env.example` (`LAN_IP`), `.github/workflows/deploy.yml` (`yq`: `del(.services."hl-web-server")`), `apps/hlsdk-portable/AGENTS.md` (the server library is now built twice: wasm for the page, i386 for the image).
- Depends on: none.
- Watch: `valve/` is also the Counter-Strike server's base folder. Check that nothing under `cstrike/` execs `valve/server.cfg`, `valve/config/server.cfg` or `valve/default.cfg`, or reads `valve/mapcycle.txt`, before changing them. If anything does, give Half-Life its own config names and exec them from the compose `command`. Don't set `sv_lan 1`: the SFU hands the engine stand-in addresses (`fsa.go`).
- Done when:
  - The full image builds, and `file valve/dlls/hl.so` in it is a 32-bit ELF built from `HLSDK_COMMIT`.
  - `docker compose --profile hl up -d` starts both containers, and the HL container's log shows `crossfire` loading with no `WARNING:` lines other than expected ones.
  - Plain `docker compose up -d` starts only Counter-Strike.
  - `docker compose config` and the workflow YAML validate, and the workflow's `yq` output contains no `hl-web-server`.
- Verify: `make build-local-image`, the compose commands above, `docker compose logs hl-web-server`, and run the workflow's `yq` expression locally on `docker-compose.yml`.

### L2 — Go server: run for whichever game folder it was started with — DONE
- Result:
  - `game.go` (`gameDir`) and the gating are in `main.go`; `/status.json` has `game`.
  - The Go tests pass, 14 runs in a row.
  - One deviation: `/maps/index.json` on the Half-Life server lists the stock `valve` maps' `.res` files instead of being empty. It is harmless, because the page skips map sync for `valve`.
- Goal: with `-game valve`, the server serves the page, `/websocket`, bans and `/status.json`, and turns off what only fits Counter-Strike. Under `-game cstrike` nothing changes.
- Read first: `apps/server/AGENTS.md`, `main.go`, `rcon.go` (`engineArgs`), `sfu.go` (`runSFU`, `Server`), `status.go`, `maps.go`, `bots.go`, `statsfollow.go` (its `cstrike/logs` path), `admin_actions.go` (`mapsDir`).
- Owned files: `apps/server/*.go` and their tests, `apps/server/AGENTS.md`.
- Depends on: none.
- Work:
  - Read the game folder from the engine arguments (`-game`, default `cstrike`) and use it where `"cstrike"` is hard-coded.
  - For anything but `cstrike`:
    - Leave off the leaderboard follower and `/leaderboard`, `/duel` and `/names/*` (404, as when the database fails to open), and don't add `withGameLogging`.
    - Don't write `BOT_QUOTA`.
    - Serve an empty `/maps/index.json`.
    - Keep the admin API off, with one `WARNING:`-free line saying why.
  - Add `game` to `/status.json`.
- Done when: the Go tests pass, with new tests for the argument parsing, the `game` field, and the routes that are off under `valve`. A `cstrike` run behaves as before.
- Verify: the Go test command from the root guide; then, on L1's image, `curl :27026/status.json` shows `"game":"valve"` and `curl :27016/status.json` shows `"game":"cstrike"`.

### L3 — Page: join a Half-Life server — DONE
- Result: `servergame.ts`, `showHalfLifeServer` in `desktop.ts`, and `startDeathmatch`/`joinServer` in `main.ts`. `tsc` and `npm run build` pass.
- Goal: on a page served by a `valve` server, the Connect flow joins Half-Life deathmatch with the player's nickname. On a `cstrike` server the page is unchanged, and "Play Half-Life" (single player) still works on both.
- Read first: `apps/client/AGENTS.md`, `src/main.ts` (`prepare`, `start`, `connect`, `reconnect`, `playHalfLife`), `src/engine.ts`, `src/lobby.ts` (where `/status.json` is read), `src/leaderboard.ts`, `src/maps.ts`, `src/desktop.ts`, `index.html`.
- Owned files: `apps/client/src/*` (expected: `main.ts`, `lobby.ts` or a small `servergame.ts`, `desktop.ts`), `apps/client/index.html` and `style.css` only for labels, `apps/client/AGENTS.md`.
- Depends on: none (codes against the `game` contract).
- Work:
  - Read `game` from `/status.json` before the first download, treating it as `cstrike` if it is missing.
  - For `valve`:
    - Label the login page as Half-Life Deathmatch.
    - Use `createEngine('valve')` and `loadGameFiles(…, 'valve/')`.
    - Start with a lean `start`: `engine.main()`, `name`, the same rate and `cl_dlmax`/download settings, `connect`, `onDisconnect` → `reconnect`, `touch_enable` on touch, and `beforeunload`.
    - Skip the Counter-Strike-only parts: `attachHud`, announcer, kill card, HTML chat, wheel, F3/F4 hooks, map resync and `_vgui_menus`. The engine's own HUD, chat (`messagemode`) and scoreboard serve.
    - Hide the leaderboard when its route is off.
  - The lobby's player list works as is.
- Done when: `npx tsc -p tsconfig.json` and `npm run build` pass. On `npm run dev` with no server behind it, the page still behaves as on a `cstrike` server.

## Wave 2 (1 agent: needs all of wave 1)

### L4 — Two-browser check, docs — DONE
- Result: `hl-harness/dm-check.mjs` passes in under 2 minutes. Labels, both players joined, frames for 60 s, `kill` counted, `rcon changelevel stalkyard` moved both, and no engine errors. Counter-Strike still joins de_dust2 (`cs-check.mjs`). Two earlier runs stalled for about 15 minutes, because the Mac went into idle sleep on battery (`pmset -g log`); run long checks under `caffeinate -i`.
- Goal: prove two browsers play together on the Half-Life server, Counter-Strike still works, and the docs say how to run it.
- Read first: everything wave 1 changed; the scratchpad harness from `plans/playable-half-life.md` (`hl-harness/run.mjs`, `cs-check.mjs`), or rebuild it from that plan's S2 brief.
- Owned files: `<scratchpad>/hl-harness/` (not committed), `README.md` (feature line, how to start the `hl` profile and what to open, `LAN_IP` in the environment table, ports 27026/27028), root `AGENTS.md` (ports and the second service under "Build and run"; the deploy note that the `yq` step drops it), `plans/half-life-lan.md` (mark steps done).
- Depends on: L1, L2, L3.
- Done when, on `docker compose --profile hl up -d --build`:
  - A harness with two browser contexts opens `http://127.0.0.1:27026`, sets two names, and both join `crossfire`.
  - `/status.json` lists both players.
  - The HL container's log shows both `entered the game`.
  - Frames advance in both pages for 60 s.
  - One player's `kill` shows on the other's scoreboard, or the log shows the frag change.
  - No `Invalid function pointer`, `Host_Error`, `Sys_Error` or wasm trap appears.
  - A `changelevel stalkyard` (rcon or server console) moves both players to the new map.
  - Counter-Strike on 27016 still joins de_dust2 (`cs-check.mjs`).
  - "Play Half-Life" single player still loads `c0a0`.
- Verify: commands above; `docker compose logs hl-web-server`.

## Final verification
- `cd apps/client && npx tsc -p tsconfig.json && npm run build`.
- The Go tests from the root guide.
- `make build-local-image` (linux/386, what the image runs as) still builds.
- L4's checks.
- **By the user, on a real LAN:** set `LAN_IP` to this machine's address, run `docker compose --profile hl up -d --build`, open `http://<LAN_IP>:27026` from a second computer, and play a round together. This is the only check of a non-localhost address, of plain-`http` pages on another machine, and of the WebRTC port through Docker's port mapping.
- Nothing is pushed: a push to `main` deploys.

## Summary
- Wave 1: 3 agents (image and compose; Go server; page). Wave 2: 1 agent (two-browser check and docs).
- Risks:
  - Valve's `valve/` configs may be shared with the Counter-Strike server (L1 checks this first).
  - The hlsdk-portable i386 server may need build flags the `engine` stage already solved (reuse them).
  - Docker Desktop's UDP forwarding on macOS, or a firewall, may block the WebRTC port from other machines. The final LAN check catches this, and the fix is outside the repository.
  - Bots for deathmatch would need Metamod and YaPB under `valve/`; that is left out on purpose.
