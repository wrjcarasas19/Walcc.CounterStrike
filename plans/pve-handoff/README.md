# PvE modes: hand-off

State on 2026-10-26, for continuing [../pve-modes.md](../pve-modes.md).

## Where things are

- Branch `pickle-rick-gsg9`, not pushed anywhere. All three phases of the plan are implemented and committed:
  - `89082fe` Add co-op against bots (`wc_coop`, `apps/amxx/wc_gm_coop.inc`)
  - `b74b418` Add a Zombies mode against knife-only bots (`wc_gamemode 3`, `apps/amxx/wc_gm_zombies.inc`)
  - `03d4d79` Add Survival waves against bots with leaderboard credit (`wc_gamemode 4`, `apps/amxx/wc_gm_waves.inc`, migration 4 in `apps/server/statsdb.go`)
  - `0cbf7a3` ships YaPB's visibility tables (the freeze fix below), and `b0b3f44` sends one Survival boss per boss wave
- The Go tests pass, `npx tsc` and `npm run build` pass, and gofmt is clean. Every local check is done, on the `linux/amd64` image from `docker compose` too (below). What's left needs the VPS or the owner.
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

## What's left

Steps 1–4 of the previous list were done on 2026-10-26 (results in the next section). What remains needs the owner or the VPS:

1. **On the VPS** (needs SSH access; ask the owner for the host).
   - Before deploying, search the current logs for the old freeze: `docker logs cs16-web-server 2>&1 | grep -E "Engine packet queue full|Rebuilding vistable"` in `/opt/apps/cs`.
   - After the owner deploys, check that a map change logs `Loaded Bots Vistable` and no `Rebuilding vistable`.
2. **YaPB issue.** `yapb-issue.md` is a draft; post it on github.com/yapb/yapb only with the owner's OK.
3. **Found while checking, not fixed** (each needs a decision first):
   - An infected human's own HUD shows **255** health while the server has them at 1500 (`wc_zm_status`). The stock `Health` user message is a byte, so `WebBridge_Health` in `apps/cs16-client/source/cl_dll/web_bridge.cpp` never sees more. Bots aren't affected, and the "Killed by" card shows the real number (Phase 0 item 3). Fixing it means sending the real health in another message, for example a `WcMode` field; that's a contract change across the three parts.
   - Seen once: the infected player's weapon panel still listed the pistol slot and 120 rounds of reserve ammo while the server said knife only. Not looked into.
   - Text the client prints in the top left (`GetSpriteIndex: item_assaultsuit sprite not found`, `d_world sprite not found`, `Error: Decal has invalid texture!`), on de_dust2 and fy_iceworld. Probably not from these modes; not looked into.

## Checks done on 2026-10-26 (second session)

The image built by `docker compose build` (`linux/amd64`, the deploy platform), run with `docker compose up -d`, two headless players (Alice and Bob). Two departures from `make run`, through an override file passed with `-f`: `sudo` needed a password, so a scratch folder replaced `/var/data/cs` on `/xashds/data`; and `stdin_open: true`, because without it the container's stdin is `/dev/null` and `c.sh` reaches nothing.

- **The run path.**
  - One `Loaded Bots Vistable` per map (de_dust2, de_nuke, fy_iceworld) and no `Rebuilding vistable`.
  - `leaderboard.db` appeared in the data folder. `bans.json` didn't, and isn't expected to: `banList.save` in `apps/server/bans.go` runs on the first ban or unban only.
  - The page, `/status.json` and `/leaderboard` answered.
- **Go tests:** `go test ./` passes on the final tree (`-count=1`).
- **The `.pmx` isn't a pause at load.** de_nuke: 1.6 s from `Mapchange` to `Loaded Bots Vistable`, then `server started`. YaPB wrote the 3.9 MB `de_nuke.pmx` 7 s later, after load. While it did, the engine answered 90 `status` probes sent every 0.5 s, and the largest gap between replies was 1.3 s. de_dust2 looked the same (`.pmx` written 13 s after start). That's under qemu; native should be faster.
- **Zombies.**
  - `wc_zm_infect 1`: the first human a zombie kills comes back on T a second later as a full zombie (1500 HP, knife, speed 300, gravity 0.7, "Bob was infected." in chat). The second death ends the round with `Terrorists_Win`, and both start the next round on CT: 11 rounds in a row.
  - Humans win: `yb kill` right after `Round_Start` gives `CTs_Win`.
  - Timer: with `mp_roundtime 1` and `wc_zm_damage 0` (so the humans live), the plugin killed the 6 zombies left exactly 60 s after `Round_Start`. That gave `CTs_Win`, the chat line "time is up. The humans survived!" and the strip "0 / 6 left".
  - fy_iceworld (`changelevel`, then `wc_gamemode 3` and `sv_restart 1`): 6 zombies for 2 humans, infection, `Terrorists_Win`.
- **Survival.**
  - `wc_wave_set 4`, then clearing wave 4, gives wave 5 with one boss: an M249, 6000 HP for 2 humans, "boss incoming" in chat, and the strip "Wave 5 / 10 · Boss · 0 / 32 killed".
  - A wipe (`amx_slay` both) logs `lost on wave 5`, prints "everyone is down. You reached wave 5. Starting again from wave 1." and starts wave 1 seven seconds later.
  - `wc_wave_set 10` then clearing it logs `wc_wave_win` for both players and changes the map. On the fresh database `/leaderboard` then showed `bestWave` 10 and `survivalWins` 1 for each, after showing `bestWave` 4 when wave 4 was cleared. So migration 4 works on a fresh database.
  - **Bug found and fixed** (`b0b3f44`): every time a boss died, the next bot to respawn became a new boss, because the plugin tested `g_waveBoss`, which the boss's death clears. Wave 10 had 9 bosses in 30 s. The plugin now sends one boss per boss wave (`wc_gamemode.sma` 1.8). After the fix, wave 5 had one boss across all 32 bots.
- **`wc_mode_test <id> 0`:** that player gets the plain top-centre line "Wave 1/10 | 0/16 killed", and the other player the HTML strip only. The tested player's HTML strip stays on screen, frozen at its last state, because the page isn't told to drop it. A client that really has no HTML HUD has no strip, so this only happens in the test.
- Screenshots of the above (`zm-*.png`, `wv-*.png` in this folder) are ignored by git.

Ways to make the helpers less fiddly:

- To keep bots from shooting idle headless players, set `yb_ignore_enemies 1`. Without it, wave 4 wiped both players in 13 s, before `yb kill` could clear it.
- `players.mjs` only picks a team on its first join. After a `changelevel`, the players sit at team 0. Click them in with `eval <i>` on `#team-menu .team-option[data-side="CT"]`, then again on the first visible `.team-option` (the character).
- `npm install` here took a `playwright-core` with no browser downloaded. `CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` worked.

## Checks done on 2026-10-26 (first session)

Done on the head image with the trace patch and the prebuilt vistable, through `docker run` like `freeze-check.sh` rather than `make build-local-image` and `make run`. Details are in `plans/pve-modes.md`.

- **Co-op refuses T on the server side.** The page disables T. With the button re-enabled in the DOM and clicked, the server refused and the player stayed CT. Control: with `wc_coop 0` and no bots, the same click joined TERRORIST.
- **Zombies knockback.** Exercised through a temporary server command that runs `Ham_TakeDamage` on a zombie with the human as inflictor and attacker, not by aiming. 30 damage pushes 180 units/s along the aim, 200 damage is capped at 600, and `wc_zm_knockback 0` pushes nothing.
- **Two players through each mode.**
  - Co-op: 6 bots on T for 2 humans, and `/status.json` says `"coop":true`.
  - Zombies: 1500 HP each, knife only, speed 300, gravity 0.7, and the strip reads "Round 1 · Zombies · 6 / 6 left".
  - Survival with `wc_wave_count 2`: 16 bots in wave 1, `wc_wave_clear` for both waves and `wc_wave_win` for both players, and `/leaderboard` shows best wave 2 and 1 win each, with no bot rows.
  - Not repeated in that session: infection, `fy_` maps, a wipe (done in the second session, above).

Both headless players run from one browser profile, so they share one auth ID (`ID_…` in the game log); the leaderboard still kept them apart by name. The second player's first join timed out at the main menu, and `close 1` then `open Bob` worked.

## Test helpers in this folder

They work on macOS and Linux. Run `npm install` here once. `npm install` takes the newest `playwright-core`, whose browser may not be downloaded yet: either run `npx playwright install chromium` or set `CHROME` (on macOS, `CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`).

| File | What it does |
|---|---|
| `c.sh "cmd" ...` | Sends console commands to the container `cs-p0` (`CONTAINER=` to change it) through `/proc/1/fd/0` and prints the new log lines. The container needs an open stdin (`docker run -i`, or `stdin_open: true` in a compose override for `cs16-web-server`). It hides `Rebuilding vistable` lines; read `docker logs` to see the rebuild. Use `status` as the liveness probe; `version` prints nothing on this console. |
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
