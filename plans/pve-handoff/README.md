# PvE modes: hand-off

State on 2026-10-26, for continuing [../pve-modes.md](../pve-modes.md).

## Where things are

- Branch `pickle-rick-gsg9`, not pushed anywhere. All three phases of the plan are implemented and committed:
  - `89082fe` Add co-op against bots (`wc_coop`, `apps/amxx/wc_gm_coop.inc`)
  - `b74b418` Add a Zombies mode against knife-only bots (`wc_gamemode 3`, `apps/amxx/wc_gm_zombies.inc`)
  - `03d4d79` Add Survival waves against bots with leaderboard credit (`wc_gamemode 4`, `apps/amxx/wc_gm_waves.inc`, migration 4 in `apps/server/statsdb.go`)
- The Go tests pass, `npx tsc` and `npm run build` pass, and gofmt is clean. The checks that were open on 2026-10-25 are done (below).
- Untracked and not part of this work: `pickle_rick_multiversus.zip` and `src/` in the repository root.
- **Pushing or merging to `main` deploys to the staging VPS.** The freeze below is fixed on this branch; deploying is the owner's call. Pushing the branch itself is safe, because the workflow only runs on `main`.

## The freeze: cause found and fixed

**Symptom:** the server stops for good. `docker logs` shows `Engine packet queue full`, the game log stops, one core stays at 100%, and `status` on the console prints nothing. A frozen container left alone stayed that way for 30 minutes.

**Cause:** YaPB (4.4.957) rebuilding its visibility table. The first time a map loads in a container, YaPB computes `addons/yapb/data/train/<map>.vis` (and `<map>.pmx`) and logs `Rebuilding vistable... N% done.` about once a second; under qemu this takes about 2 minutes for de_dust2. The rebuild runs in YaPB's `pfnStartFrame` on the engine thread. While it runs, a frame sometimes takes several seconds and sometimes never ends: backtraces taken during the stall show YaPB calling `pfnTraceLine` → `SV_Move` → `PM_RecursiveHullCheck` over and over from one function. The table isn't in the image or the data volume, so every new container rebuilds it for every map, which means after every deploy.

`Engine packet queue full` is a consequence, not the cause: `countDroppedPacket` in `apps/server/sfu.go` counts packets the browser sent that were dropped because the engine thread stopped reading them.

**Evidence** (2026-10-26, Apple Silicon, linux/386 images under qemu, one headless player, 4 bots):

| What | Result |
|---|---|
| 33 runs of `freeze-check.sh` on the baseline (`0bd64e5`), the head, the head with the Phase 1 client files, and the head with the trace patch | All 9 freezes happened while the vistable rebuild was still running (39–83%). None of the 24 clean runs froze after the rebuild reached 99%. Two clean runs stalled for several seconds during the rebuild and recovered |
| Head with a prebuilt `de_dust2.vis` and `.pmx` copied into the image, 25 restarts 6 s apart, 3 runs | 75 restarts, no rebuild, no freeze. The same check without the files: 2 of 3 runs froze (or stalled) during the rebuild |
| Backtraces of the engine thread during a stall (`freeze-trace.patch`) | Every sample past the first is in YaPB's `pfnStartFrame` (`GetEntityAPI::$_9` in `yapb.so`) inside `pfnTraceLine` |

**What it is not:**

- Not the PvE modes. The image from before them (`0bd64e5`) froze in 2 of 4 runs.
- Not the rebuilt cs16-client. An image with byte-identical Phase 1 client files (same hash, same hashed name) froze too. Yesterday's bisect was luck: restarts start when the rebuild is about half done, and with so few runs per image the clean ones looked like a pattern.
- Not tied to the restart itself. Freezes hit about 1 s after `sv_restart` (the round restart), at the end of freeze time, and 7 s into a live round.
- Not the data channel `Write` blocking (the old suspect in `pve-modes.md`). The engine thread is busy in YaPB, not waiting in Go.

**The fix:** every map in the image now ships with its table, in `apps/server/configs/cstrike/addons/yapb/data/train/<map>.vis` (31 maps, 1.3 MB). `cs_mansion` and `ttt_mario_b1` also got committed graphs; before, YaPB analysed them after every deploy, and a different graph would invalidate the table. `apps/server/yapb-tables.sh` regenerates all of it by running each map in the image with no bots. Run it after changing `yapb_version`, adding a map or changing a graph.

- YaPB accepts a `.vis` file when its node count and format version match the graph; there's no map checksum (`src/storage.cpp` at the pinned tag). A stale table fails that check, and YaPB rebuilds it, which brings the risk back. That's why the script exists.
- `.pmx` (the path matrix, megabytes per map) isn't shipped. YaPB computes it synchronously once at a map's first load (Floyd–Warshall), on x86 probably within a few seconds. That's a pause at load, not the in-game hazard.
- Persisting `train/` in the data volume isn't needed: no map can be added at runtime, so the image covers every map.
- Verified on the built image: loading all 31 maps one after another logged 32 `Loaded Bots Vistable` lines and no `Rebuilding vistable` at all.
- Upstream: `yapb-issue.md` in this folder is a draft report for YaPB, not posted. No matching issue exists; the nearest is #443, a crash when the graph is deleted during the rebuild.

**Still not known:** how often the freeze hit production. The staging VPS logs haven't been searched for `Engine packet queue full` next to `Rebuilding vistable`.

## Next session: what's left

State at hand-off: the fix (`0cbf7a3`) and this write-up (`8e4cedf`) are committed on `pickle-rick-gsg9`, not pushed. Steps 1–4 run on an Apple Silicon Mac with Docker Desktop; step 5 needs the VPS. When done, write the results into this file and `plans/pve-modes.md`. Commit on the branch, and don't push to `main` unless the owner says so.

1. **The documented run path, which is also the amd64 build.** `docker-compose.yml` builds with `platform: linux/amd64`, the platform the deploy workflow builds. So `make run` covers both the Verify step in `AGENTS.md` and the image the VPS runs; the 2026-10-26 checks used `linux/386` images through `docker run`. One-time setup on a Mac:
   - Run `docker network create proxy`.
   - Run `cp .env.example .env`, set `ADMIN_PASSWORD` (8+ characters) and `BOT_QUOTA=4`.
   - Run `sudo mkdir -p /var/data/cs`; Docker Desktop shares `/private`, which holds `/var`.

   Then run `make run` (the first build takes a while). Open http://127.0.0.1:27016 or use `players.mjs`, and read `docker compose logs cs16-web-server`. Expect:
   - one `Loaded Bots Vistable` line per map, and no `Rebuilding vistable`;
   - `leaderboard.db` and `bans.json` appearing in `/var/data/cs`;
   - `/leaderboard` answering, and `bestWave`/`survivalWins` showing up after a Survival win (migration 4 on a fresh database).

   The helpers expect a container named `cs-p0`; use `CONTAINER=cs16-web-server ./c.sh ...`. Stop it with `docker compose down` before running `freeze-check.sh`, which needs the same ports.
2. **Mode features not repeated on 2026-10-26.** Two headless players (`players.mjs Alice Bob`; if the second times out, `close 1` then `open Bob`):
   - Zombies: `wc_zm_infect 1` (a human killed by a zombie comes back on T, and is cured at the next round); one round on an `fy_` map (`changelevel fy_iceworld`, then `wc_gamemode 3` and `sv_restart 1`, because the level change re-runs the config); each round ending (humans win, zombies win, timer).
   - Survival: `wc_wave_set 4`, then clear wave 4 (`yb kill` repeatedly) to get the wave 5 boss; a wipe, where every human dies (`./c.sh "amx_slay Alice" "amx_slay Bob"` from the server console), should show "Reached wave N" and restart at wave 1.
   - `wc_mode_test <userid> 0`: the plain HUD line instead of the HTML strip.
   - Screenshots with `shot <i> <file.png>` to check the strips.
3. **Go tests.** The fix didn't touch Go, but rerun them once on the final tree: `docker build --platform=linux/amd64 -f apps/server/Dockerfile --target go -t local/cs16-go-test . && docker run --rm local/cs16-go-test go test ./`.
4. **The `.pmx` pause at first map load.** Optional: with the step 1 container, `changelevel` to a big map (de_nuke, cs_office) and time from `Spawn Server` to the first `Loaded Bots` line. The number is emulated; on x86 it should be much shorter.
5. **On the VPS (needs SSH access; ask the owner for the host).**
   - Before deploying, search the current logs for the old freeze: `docker logs cs16-web-server 2>&1 | grep -E "Engine packet queue full|Rebuilding vistable"` in `/opt/apps/cs`.
   - After the owner deploys, check that a map change logs `Loaded Bots Vistable` and no `Rebuilding vistable`, and time the `.pmx` pause from step 4 natively.
6. **YaPB issue.** `yapb-issue.md` is a draft; post it on github.com/yapb/yapb only with the owner's OK.

## Checks done on 2026-10-26

Done on the head image with the trace patch and the prebuilt vistable, through `docker run` like `freeze-check.sh` rather than `make build-local-image` and `make run`. Details are in `plans/pve-modes.md`.

- **Co-op refuses T on the server side.** The page disables T. With the button re-enabled in the DOM and clicked, the server refused and the player stayed CT. Control: with `wc_coop 0` and no bots, the same click joined TERRORIST.
- **Zombies knockback.** Exercised through a temporary server command that runs `Ham_TakeDamage` on a zombie with the human as inflictor and attacker, not by aiming. 30 damage pushes 180 units/s along the aim, 200 damage is capped at 600, and `wc_zm_knockback 0` pushes nothing.
- **Two players through each mode.**
  - Co-op: 6 bots on T for 2 humans, and `/status.json` says `"coop":true`.
  - Zombies: 1500 HP each, knife only, speed 300, gravity 0.7, and the strip reads "Round 1 · Zombies · 6 / 6 left".
  - Survival with `wc_wave_count 2`: 16 bots in wave 1, `wc_wave_clear` for both waves and `wc_wave_win` for both players, and `/leaderboard` shows best wave 2 and 1 win each, with no bot rows.
  - Not repeated: infection, `fy_` maps, a wipe.

Both headless players run from one browser profile, so they share one auth ID (`ID_…` in the game log); the leaderboard still kept them apart by name. The second player's first join timed out at the main menu, and `close 1` then `open Bob` worked.

## Test helpers in this folder

They work on macOS and Linux. Run `npm install` here once. `npm install` takes the newest `playwright-core`, whose browser may not be downloaded yet: either run `npx playwright install chromium` or set `CHROME` (on macOS, `CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`).

| File | What it does |
|---|---|
| `c.sh "cmd" ...` | Sends console commands to the container `cs-p0` (`CONTAINER=` to change it) through `/proc/1/fd/0` and prints the new log lines. It hides `Rebuilding vistable` lines; read `docker logs` to see the rebuild. Use `status` as the liveness probe; `version` prints nothing on this console. |
| `freeze-check.sh <image> [platform]` | Starts a fresh `cs-p0` with 4 bots, joins one headless player, then runs up to 10 `sv_restart`, reporting `ok` or `FROZEN` after each. Ports 27016 and 27018 must be free (stop `make run`). Its `until` loops have no timeout, so a player that never joins hangs it. The leftover `nohup` subshell keeps the name `freeze-check.sh` until `players.mjs` exits, so don't wait on `pgrep -f freeze-check.sh`. Images built from this branch ship the vistables, so the freeze no longer reproduces; to reproduce it, start the container with the tables deleted (`rm -f /xashds/cstrike/addons/yapb/data/train/*` before `./xash`, as `apps/server/yapb-tables.sh` does). |
| `players.mjs Name ...` | Headless players that log in, download the game files (about 480 MB, cached in the profile), connect and join CT. Control them by appending lines to `cmd.txt`: `shot <i> <file.png>`, `eval <i> <js>`, `type <i> <console text>`, `open <name>`, `close <i>`. `type` doesn't reach the game console (nothing typed shows in the game log); use the page instead, for example `eval` that opens the team menu with an `m` key event and clicks `#team-menu .team-option[data-side="T"]`. `PROFILE=` picks the browser profile folder. |
| `hotswap.sh` | Compiles `wc_gamemode.sma` and copies it into `cs-p0`. Then run `./c.sh "changelevel de_dust2"`. The level change re-runs the server config, so set `wc_gamemode` again afterwards and `sv_restart 1`. Needs the compiler image once: `docker build --platform=linux/386 -f apps/server/Dockerfile --target amxx-plugins -t local/cs16-amxx-test .` from the repository root. |
| `freeze-trace.patch` | Temporary instrumentation for `apps/server`; never commit it. It keeps the last 4096 engine packets in memory. When the engine makes no `recvfrom`/`sendto` call for 3 s, it writes them to `/tmp/pkt.log` and signals the engine thread six times; a C handler appends a backtrace per signal to `/tmp/bt.log` and the process maps go to `/tmp/maps.txt`. Apply it in a worktree with `git apply`, build the image, and copy the files out with `docker cp` after a freeze. Resolve addresses with `addr2line -f -e xash <addr>` (the binary isn't stripped) in a `debian:bookworm-slim` container with `binutils`. `yapb.so` offsets only resolve to `GetEntityAPI` lambdas. |

**Useful console commands:**

- `wc_coop_status`, `wc_zm_status`, `wc_wave_status`;
- `wc_wave_set <n>`, which jumps to wave n;
- `wc_mode_test <id> 0`, which shows a player the plain HUD line;
- `yb kill` (kills every bot), `yb kickall instant`.

Mode cvars apply on the next map or restart. The server polls cvars once a second, and co-op puts `humans_join_team` back to `CT` within that second if it's changed by hand.
