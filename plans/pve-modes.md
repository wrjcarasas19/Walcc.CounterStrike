# Play against bots: Co-op, Zombies, Survival waves

Goal: modes that make 2–4 players a team against YaPB bots. Co-op vs Bots (humans CT, bots T, the bot count grows with the number of humans), Zombie bots (knife-only bots with a lot of health against armed humans) and Survival waves (waves of bots that get harder, a boss every few waves, credit on the leaderboard).

Decisions (from the user):
- `wc_coop` is kept over map changes (like `wc_gg_*`), unlike `wc_gamemode` and `wc_weaponmode`.
- Survival waves get leaderboard credit: a log line, a parser change and a new migration in `apps/server/statsdb.go` that adds columns without changing existing rows.
- Infection in Zombies (`wc_zm_infect`) exists but is off by default.

Design choices:
- The three modes go in `apps/amxx/wc_gamemode.sma`, which already has the mode cvars (`MODE_CVARS`), the single restart, random spawns, spawn protection and `WcMode`. Code for each mode goes in its own include so the plugin stays readable: `wc_gm_coop.inc`, `wc_gm_zombies.inc` and `wc_gm_waves.inc`. The Dockerfile `plugins.ini` line stays the same.
- Co-op is a separate cvar, `wc_coop 0|1`, so it works with classic, Deathmatch and Gun Game. Zombies is `wc_gamemode 3` and Survival is `wc_gamemode 4`; both turn co-op on while they run.
- `WcMode` keeps its format. `web_bridge.cpp` passes `mode` and every field through without checking them, so modes 3 and 4 reuse the existing fields (tables below). There's no cs16-client rebuild and no new client version gate; only `apps/client/src/gamemode.ts` has to accept the new mode numbers. Document what each field means per mode in all three places: the plugin header, the `web_bridge.cpp` comment and `gamemode.ts`.
- No ReAPI. It isn't in the image, and it expects ReHLDS, which this engine isn't. Everything uses AMX Mod X (fun, fakemeta, Ham Sandwich, cstrike) and ReGameDLL / YaPB cvars.
- One commit per phase, verified before the next phase starts. Don't push: a push to `main` deploys.

## Phase 0: test assumptions in the running image (nothing committed)

Run these over rcon / the console against `make run`, and write each result here before writing plugin code:

1. `humans_join_team CT` (ReGameDLL) together with `yb_join_team T` (YaPB): humans can't pick T, and bots join T.
2. `yb_jasonmode 1` (YaPB 4.4): all bots knife only and don't buy. If it doesn't work, Zombies strips the bots with `wc_weapons.inc` instead.
3. `set_user_health` above 255 on a bot: the damage is right, and the kill and the "Killed by" card look right in the browser.
4. ReGameDLL 5.30: which `mp_round_infinite` flag letters block only the round timer, and whether `mp_buytime -1` means unlimited buy time.
5. `ExecuteHamB(Ham_CS_RoundRespawn, id)` respawns one dead player in the middle of a round with `mp_forcerespawn 0`.
6. CPU with 10 bots plus 2 browsers (`docker stats`), as a baseline for `wc_coop_max_bots`.

If one fails, change the phase that depends on it here first.

Results (2026-10-24, image from 2026-10-24 03:45, `linux/386` under emulation on Apple Silicon, de_dust2, commands sent to the engine console on the container's stdin, no browser):

1. `yb_join_team T`: bots added afterwards all join T (`yb list`). Existing bots stay where they are, so the plugin moves them. `humans_join_team` exists (ReGameDLL 5.30.0.814-dev, default `any`); the human side wasn't checked without a browser. Also: `yb kickall instant` sets `yb_quota` to 0.
2. `yb_jasonmode 1`: bots buy nothing, even with $16000 (with it off they buy rifles, armour and grenades). They keep the spawn pistol, so Zombies also strips pistols and the C4 on spawn.
3. Not checkable without the plugin and a browser; checked in Phase 2 with `wc_zm_status`. The "Killed by" card sends the killer's health as a short (0–32767, `wc_killinfo.sma`), so health over 255 fits.
4. `mp_round_infinite a` blocks only the round timer: no round end 80 s into a 60 s round, while elimination (`Terrorists_Win`) and the bomb (`Bomb_Defused`) still end it. `mp_buytime -1` is accepted (ReGameDLL: no limit). The winner is on `Team "CT" triggered "..."` lines (6 log arguments, the team in argument 1); `World triggered "Round_End"` doesn't name it.
5. Needs plugin code; checked in Phase 3 (`wc_wave_status`).
6. 10 bots, no browser: 18–27% of one core, 359 MiB. With 2 headless Chromium players (Playwright) and 9 bots in co-op (Phase 1 image): 33–37%, 337 MiB.

Phase 1 also showed: with `humans_join_team CT` the game skips the team menu on joining and opens the CT character menu; the team menu (M) shows the Terrorists greyed out.

## Phase 1: Co-op vs Bots (`wc_coop`)

Behaviour:
- `wc_coop 1` sets `humans_join_team CT`, `yb_join_team T`, `mp_autoteambalance 0` and `mp_limitteams 0`. It moves humans on T to CT and bots on CT to T (`cs_set_user_team`), then does the usual single restart. `wc_coop 0` puts the saved values back and restarts.
- Bot count: while co-op is on, the plugin owns `yb_quota` (`yb_quota_mode fill`). The quota is humans + humans × `wc_coop_ratio` (default 3), capped at humans + `wc_coop_max_bots` (default 10). `Poll()` recalculates it every second. The `yb_quota` from before co-op (the F4 Bots tab or `BOT_QUOTA`) is saved and put back when co-op ends.
- `wc_coop_adapt 1` (default 0): `yb_difficulty` goes up one after the humans win two rounds in a row, and down one after they lose two in a row (range 1–4). It reads the `Round_End` log events (`register_logevent`).
- `wc_coop` and its settings are kept over map changes (decision above). On the new map, `plugin_cfg` applies co-op again if `wc_coop` is 1.
- Bomb and hostage maps work as they are: humans defend the sites as CT on `de_` maps and rescue the hostages on `cs_` maps.
- `wc_coop_status` (server command) prints the cvars it set, the human count, the quota and the difficulty.

Changes:
- `apps/amxx/wc_gm_coop.inc` (new) and `wc_gamemode.sma`: hook into `Poll()`, `plugin_cfg` and the restart; header comment; bump `VERSION`.
- `apps/server/admin_actions.go` and `admin_actions_test.go`: `wc_coop {0,1}`, `wc_coop_ratio {1,6}`, `wc_coop_max_bots {1,20}`, `wc_coop_adapt {0,1}`.
- `apps/server/status.go`: `/status.json` reports `coop` (needs `FCVAR_SERVER` on `wc_coop`).
- `apps/client/src/admin/cvars.ts`, `match.ts` and `presets.ts`: Co-op fields in the Match tab and a "Co-op vs bots" preset.
- `apps/client/src/team`: grey out Terrorists while co-op is on (read from `/status.json`). The game already refuses the choice; this only makes the page clearer.
- `README.md` (features, plugin table, cvars) and `apps/amxx/AGENTS.md` (file table).

Verify: `go test` (Go stage), `npx tsc` and `npm run build`, `make build-local-image`, `make run`. Two browsers: with one human there are 3 bots on T, and with two humans there are 6. The T button is greyed out. `wc_coop 0` puts back the previous `yb_quota`. After `changelevel`, co-op is still on.

## Phase 2: Zombie bots (`wc_gamemode 3`)

Behaviour:
- Co-op is forced on while the mode runs. Rounds are normal (not infinite).
- Zombies (bots on T):
  - Knife only through `yb_jasonmode 1` (or the Phase 0 fallback).
  - Health: `wc_zm_health` (1000) + `wc_zm_health_per_human` (250) × humans.
  - Speed `wc_zm_speed` (300), set again after every weapon switch because the game resets it. Gravity `wc_zm_gravity` (0.7).
  - Knife damage × `wc_zm_damage` (2.0).
  - Knockback when shot: Ham `TakeDamage` pushes the zombie along the shooter's aim × `wc_zm_knockback` (1.0).
  - Green glow (`set_user_rendering`).
- No new models: the T models (Tusken Raider, Jawa, Yoda, C-3PO) plus the glow are enough, so there's nothing extra to download.
- Humans (CT): `mp_buy_anywhere 1`, ammo refilled on reload (`mp_refill_bpammo_weapons 3`), free kevlar and helmet, `mp_startmoney 16000` in the preset.
- Objectives off: no C4, hostages hidden and `yb_ignore_objectives 1`, the same way Deathmatch does it now.
- How a round ends:
  - All humans dead: T (zombies) win.
  - All zombies dead: CT win.
  - Timer runs out: CT win. The round timer is blocked with the `mp_round_infinite` flag from Phase 0, and one second before time is up the plugin kills the remaining zombies (`user_silentkill`). That gives a CT win by elimination on every map type (`de_`, `cs_`, `fy_`, `aim_`).
- `wc_zm_infect 1` (default 0): a human killed by a zombie comes back as a zombie on T for the rest of the round and goes back to CT at the next round. While infected, their kills on CT players count as normal enemy kills on the leaderboard; document that in the README.
- `WcMode` for mode 3:

  | Field | Meaning |
  |---|---|
  | `level` | round number |
  | `kills` | zombies left |
  | `killsNeeded` | zombies at the start of the round |
  | `weapon` | `"Zombies"` |
  | `protection` | as now |
  | other fields | 0 / `""` |

  Without the HTML HUD, the same text goes out as a HUD line ("Zombies 5/9 left").
- Leaderboard: no parser change needed. Bot kills and round wins already count.
- `wc_zm_status` lists each zombie's health, speed, gravity and team.

Changes:
- `apps/amxx/wc_gm_zombies.inc` (new); a new mode column in `MODE_CVARS` (`yb_jasonmode`, `mp_buy_anywhere`, `mp_round_infinite`, refill, armour, C4, objectives); `MODE_NAMES`; header comment; `VERSION`.
- `admin_actions.go`: `wc_gamemode` max 3, plus the `wc_zm_*` cvars. In `admin_actions_test.go` the out-of-range case moves from 3 to 5.
- `status.go`: accept `gameMode` 3 (add a constant).
- Client: `gamemode.ts` (`parseModeState` accepts 3, plus the strip text), the `hud.ts` strip, the mode name in the lobby, a "Zombies" preset, and the F4 Match fields.
- README and `apps/amxx/AGENTS.md`.

Verify: as Phase 1, plus `wc_gamemode_status` and `wc_zm_status`. Play a round to each ending (humans win, zombies win, time runs out) on one `de_` map and one `fy_` map. Check the strip in the browser and the HUD line on a client without the HTML HUD (`wc_mode_test <userid> 0`). Check `wc_zm_infect 1` once.

## Phase 3: Survival waves (`wc_gamemode 4`), with leaderboard credit

Behaviour:
- Co-op is forced on. Rounds never end (`mp_round_infinite 1`). `mp_forcerespawn 0`, because the plugin decides who respawns.
- Wave N (1-based):
  - Bots to kill: (`wc_wave_size` (6) + 2 × N) × humans.
  - At most `wc_coop_max_bots` bots alive at once. A killed bot respawns at a random spawn away from the humans (the existing spawn picker) until the wave's count is reached.
  - Bot health × (1 + 0.15 × N). `yb_difficulty` = min(1 + N / 2, 4).
  - Bot guns by wave, given with the Deathmatch equip code (`yb_botbuy 0`): waves 1–2 pistols, 3–4 SMGs and shotguns, 5–7 rifles, 8 and up rifles plus AWP.
- Boss: every `wc_wave_boss_every` waves (5), one bot gets 3000 × humans health, an M249 and a red glow. Its spawn is announced in a toast and a centre message.
- Dead humans spectate until the wave is cleared.
- Break (`wc_wave_break`, 12 s) between waves:
  - Dead humans respawn.
  - Everyone gets $2000 + $500 × N (`cs_set_user_money`).
  - Buying anywhere is allowed only during the break.
  - Spawn protection is on.
- Losing: all humans dead at once shows "Reached wave N" for 5 s, then the game restarts at wave 1.
- Winning: clearing `wc_wave_count` (10) waves gives a centre message and freezes everyone for 5 s, like the Gun Game win, then the next map (`amx_nextmap`).
- `WcMode` for mode 4:

  | Field | Meaning |
  |---|---|
  | `level` / `levels` | wave / `wc_wave_count` |
  | `kills` / `killsNeeded` | bots killed this wave / wave size |
  | `weapon` | `"Wave"`, `"Boss"` or `"Break"` |
  | `next` | seconds left in the break, as text (`""` otherwise) |
  | `winner` | `"Humans"` once won (`""` before) |
  | `protection` | as now |

  The page draws "Wave 4/10 · 12/20" and shows toasts for "Wave cleared", "Boss incoming" and "Survived!", reusing the announcer's existing sounds.
- `wc_wave_status` prints the wave, kills, bots alive and the boss. `wc_wave_set <n>` jumps to wave n (for tests).

Leaderboard credit:
- Log lines in the stock format, from `wc_gamemode.amxx`, for each human on CT when a wave is cleared (alive or dead):
  - `"Name<uid><auth><CT>" triggered "wc_wave_clear" (wave "N")`
  - and, when the last wave is cleared, `"Name<uid><auth><CT>" triggered "wc_wave_win"`.
- `apps/server/statsdb.go`, migration 4 (adds columns, doesn't change existing rows):
  `ALTER TABLE players ADD COLUMN best_wave INTEGER NOT NULL DEFAULT 0; ALTER TABLE players ADD COLUMN survival_wins INTEGER NOT NULL DEFAULT 0`.
  The upsert keeps `best_wave = MAX(best_wave, excluded.best_wave)` and adds `survival_wins`.
- `apps/server/statsfollow.go`: parse both lines (the `(wave "N")` property is new; reject anything that doesn't match). Same rules as `wc_gg_win`: bots only with `LEADERBOARD_BOTS=1`, claimed names go to the claimed row, unknown players count for nothing. Update the header comment.
- `apps/server/leaderboard.go`: `bestWave` and `survivalWins` in the JSON. Tests in `statsfollow_test.go`, `leaderboard_test.go` and the migration test.
- `apps/client/src/leaderboard.ts`: two columns ("Best wave", "Survived"), parsed like `ggWins`.

Changes (besides the leaderboard):
- `apps/amxx/wc_gm_waves.inc` (new); a `MODE_CVARS` column; `MODE_NAMES`; header comment, including the two log lines; `VERSION`.
- `admin_actions.go`: `wc_gamemode` max 4, plus the `wc_wave_*` cvars; tests.
- `status.go`: accept `gameMode` 4.
- Client: `gamemode.ts`, `hud.ts`, the lobby mode name, a "Survival" preset, the Match fields, the announcer toasts.
- README (features, plugin table, cvars, leaderboard section) and `apps/amxx/AGENTS.md` (log lines under Contracts).

Verify: `go test` (parser, migration on a copy of a database that has rows, JSON), `npx tsc`, `npm run build`, `make build-local-image`, `make run`. In a browser:
- `wc_wave_set 4` brings the boss on wave 5.
- A full wipe restarts at wave 1.
- `wc_wave_count 2` gives a quick win, and the leaderboard then shows best wave 2 and 1 win for the human but nothing for the bots.
- `docker stats` stays in line with the Phase 0 baseline.

## Risks

- YaPB isn't written for zombie play. Knife-only bots can get stuck, especially on `cs_mansion` and `ttt_mario_b1`, which have no graphs. If they play badly, limit the Zombies and Survival presets to maps that have graphs.
- Server CPU with many bots: `wc_coop_max_bots` (default 10) is the limit; Phase 0 sets the baseline.
- Health above 255: Phase 0 checks how it shows in the browser client.
- `MODE_CVARS` grows by two columns. Each value the modes set must have a classic value, so ending a mode or changing the map restores it.
