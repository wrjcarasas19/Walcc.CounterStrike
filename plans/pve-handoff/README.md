# PvE modes: hand-off

State on 2026-10-25, for continuing [../pve-modes.md](../pve-modes.md) on another machine.

## Where things are

- Branch `pickle-rick-gsg9`, not pushed anywhere. All three phases of the plan are implemented and committed:
  - `89082fe` Add co-op against bots (`wc_coop`, `apps/amxx/wc_gm_coop.inc`)
  - `b74b418` Add a Zombies mode against knife-only bots (`wc_gamemode 3`, `apps/amxx/wc_gm_zombies.inc`)
  - `03d4d79` Add Survival waves against bots with leaderboard credit (`wc_gamemode 4`, `apps/amxx/wc_gm_waves.inc`, migration 4 in `apps/server/statsdb.go`)
- The Phase 0 findings and the per-phase notes are in `plans/pve-modes.md`. The Go tests pass, `npx tsc` and `npm run build` pass, and gofmt is clean.
- Untracked and not part of this work: `pickle_rick_multiversus.zip` and `src/` in the repository root.
- **Do not merge or push to `main`.** That push deploys to the staging VPS, and the freeze below is unresolved. Pushing the branch itself is safe, because the workflow only runs on `main`.

To move to the other machine: `git push -u origin pickle-rick-gsg9` here (or `git bundle create pve.bundle main..pickle-rick-gsg9`), then check out the branch there.

## Blocker: the server freezes at round restarts

**Symptom:** with one browser player connected, a round restart (`sv_restart 1`) or a new round sometimes freezes the engine for good:

- `docker logs` shows `Engine packet queue full`;
- the game log stops;
- one CPU core stays at 100%;
- `status` on the console prints nothing.

It happens in plain classic mode, with no PvE mode and no co-op running. Restarts with bots only never froze.

**Bisect on an Apple Silicon Mac** (Docker runs the i386 engine under `qemu-i386` in both the linux/386 and the amd64 images). Each run is `freeze-check.sh`: one player, then up to 10 restarts.

| Image | Restarts | Freezes |
|---|---|---|
| Before this work (`0bd64e5`) | 36 | 0 |
| Phase 1 (`89082fe`) | 26 | 0 |
| Phase 1 + the Phase 2 plugin | 10 | 0 |
| Phase 1 + the Phase 2 page | 21 | 1 |
| Phase 1 + a rebuilt `apps/cs16-client` (a comment change only) | 2 runs | froze at restart 1 in both |
| Phase 2, and the Phase 3 head | every run | froze within 1–5 restarts |
| Phase 3 built for amd64 (still emulated) | 2 runs | froze in 1 |
| Phase 3 with the Phase 1 `cs_emscripten_wasm32.so` bytes swapped in | – | still froze |

**What this suggests:** the Phase 1 image and the "rebuilt cs16-client" image differ only in a 5-byte build timestamp inside `cs_emscripten_wasm32.so` and in that file's hashed name, which `index.js` and `index.html` reference. A difference that small should not change behaviour. The best guess is a timing race, so it may only exist under qemu emulation, but that is not proven.

**Already tried and ruled out:**

- Low power mode: it was off (`pmset powermode 0`) for the runs that froze.
- A Docker Desktop restart.
- The `Ham_CS_Player_ResetMaxSpeed` hook: the `:nohook` image froze too.
- A gdb backtrace through `QEMU_GDB`: under gdb the server was too slow to finish starting.

**Next steps, in order:**

1. **Native x86 Linux (the main reason for moving machines).** Build the head image there:
   ```sh
   docker build --platform=linux/386 -f apps/server/Dockerfile -t local/cs16-web-server:latest .
   ```
   Then run `plans/pve-handoff/freeze-check.sh local/cs16-web-server:latest linux/386` several times, and do the same for an image built from `0bd64e5` as the baseline.
   - No freezes on native x86 for either image: it was emulation; carry on with the open checks below.
   - The head freezes and the baseline doesn't: it is real. Continue with step 2.
2. While it is frozen, get a backtrace natively:
   ```sh
   docker exec -u 0 cs-p0 sh -c 'apt-get update && apt-get install -y gdb'
   ```
   then `gdb -p 1 -batch -ex 'thread apply all bt'`. Process 1 is the Go server, and the engine is linked into it.
   - The suspects are the engine-to-browser send path (`apps/server/sfu.go`, and the packet queue that logs "Engine packet queue full") and whatever runs at round start.
   - Making the cs16-client build reproducible (drop `__DATE__`/`__TIME__`) would make bisecting cleaner.

## Checks not done yet

These were blocked by the freezes:

- **Co-op refuses a human picking T on the server side.** Players join CT automatically through `humans_join_team CT`. The test:
  1. Open the team menu with `chooseteam`, after first picking the CT character menu shown on joining.
  2. With `wc_coop 1` set, click T.
  3. Expect the engine to refuse, and the player to stay CT.

  The page greys T out (`apps/client/src/team/index.ts`), but the server rule is what counts.
- **Zombies knockback.** Headless players can't aim. Add a temporary `log_amx` in the `Ham_TakeDamage` post hook in `apps/amxx/wc_gm_zombies.inc` that prints the velocity before and after. Then, with `wc_gamemode 3`, have a player shoot a zombie (or call the hook from a test command) and read the log.
- After both: one end-to-end pass of each mode with two browser players through `make build-local-image` and `make run`, per the Verify table in `AGENTS.md`. Then mark the open items in `plans/pve-modes.md` as done.

## Test helpers in this folder

They work on macOS and Linux. Run `npm install` here once; on Linux, also run `npx playwright install chromium`, or set `CHROME=/path/to/chrome`.

| File | What it does |
|---|---|
| `c.sh "cmd" ...` | Sends console commands to the container `cs-p0` (`CONTAINER=` to change it) through `/proc/1/fd/0` and prints the new log lines. Use `status` as the liveness probe; `version` prints nothing on this console. |
| `freeze-check.sh <image> [platform]` | Starts a fresh `cs-p0` with 4 bots, joins one headless player, then runs up to 10 `sv_restart`, reporting `ok` or `FROZEN` after each. |
| `players.mjs Name ...` | Headless players that log in, download the game files (about 480 MB, cached in the profile), connect and join CT. Control them by appending lines to `cmd.txt`: `shot <i> <file.png>`, `eval <i> <js>`, `type <i> <console text>`, `open <name>`, `close <i>`. `PROFILE=` picks the browser profile folder; use a fresh one, because an old profile once froze the server on every join. |
| `hotswap.sh` | Compiles `wc_gamemode.sma` and copies it into `cs-p0`. Then run `./c.sh "changelevel de_dust2"`. Needs the compiler image once: `docker build --platform=linux/386 -f apps/server/Dockerfile --target amxx-plugins -t local/cs16-amxx-test .` from the repository root. |

**Useful console commands:**

- `wc_coop_status`, `wc_zm_status`, `wc_wave_status`;
- `wc_wave_set <n>`, which jumps to wave n;
- `wc_mode_test <id> 0`, which shows a player the plain HUD line.

Mode cvars apply on the next map or restart. The server polls cvars once a second.
