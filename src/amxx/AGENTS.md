# AMX Mod X plugins (`src/amxx`)

Pawn plugins compiled into the image and loaded by AMX Mod X on the server. Read the root guide first; `README.md` (Customization) has the user-facing table of cvars and commands.

| File | Role |
|---|---|
| `wc_gamemode.sma` | `wc_gamemode 0\|1\|2`: classic, Gun Game, Deathmatch; sets and restores ReGameDLL and YaPB cvars, sends the `WcMode` user message |
| `wc_weaponmode.sma` | `wc_weaponmode 0\|1\|2`: off, knife only, pistols only; ignored while a game mode is on |
| `wc_statslog.sma` | Adds `wc_headshot` and `changed name to` log lines for the leaderboard |
| `wc_killinfo.sma` | Sends the victim the `WcKillInfo` user message for the "Killed by" card |
| `wc_weapons.inc` | Shared weapon code: stripping, giving with full ammo, buy aliases |

## Build and load

- The Dockerfile `amxx-plugins` stage compiles every `.sma` here with the pinned AMX Mod X compiler; the build fails if one does not compile. A new plugin must also be added to the `plugins.ini` line in the Dockerfile `hlds` stage and to the README table.
- There is no host toolchain: `make build-local-image` is the compile step.
- Each file starts with a comment that documents its behaviour, cvars, commands and message formats, and defines `PLUGIN`, `VERSION` and `AUTHOR "Walcc"`. Update the comment and bump `VERSION` with every behaviour change.

## Engine constraints (Xash3D FWGS)

- AMX Mod X cannot hook or bind cvars here; plugins poll once a second. Cvars marked single-player-only are set with `amx_cvar`.
- Players get made-up addresses from the SFU, so address-based admin is off (`adminslots.amxx` is disabled in the Dockerfile). Do not rely on addresses.
- The engine writes no `changed name to` line; `wc_statslog` does. Keep that in mind when a feature depends on names.
- Cvars that `/status.json` should show need `FCVAR_SERVER`.
- Mode cvars (`wc_gamemode`, `wc_weaponmode`, the `wc_gg_*` ones that are not kept) go back to their defaults on every map change; `plugin_init` runs once per map.

## Contracts

- `WcMode` and `WcKillInfo` are hooked by name in `src/cs16-client/source/cl_dll/web_bridge.cpp` and turned into page events read by `src/client`. Their field order is the comment at the top of the plugin; a change touches all three parts and the client version gate.
- Send user messages only to players whose userinfo has `wc_html_hud 1` (set by the page once its client forwards the event), never to bots, except through the `wc_*_test` commands.
- Log lines (`wc_headshot`, `wc_gg_win`, name changes) are parsed by `src/server/statsfollow.go`; keep the stock `"Name<uid><auth><team>"` format and change the parser and its tests with the line.
- Pass player names as format arguments, never as the format string.

## Verify

No unit tests exist. Build and run the image, add bots (`BOT_QUOTA` or `yb add`), and use the plugin's own console commands over rcon or the F4 menu: `wc_weaponmode_status`, `wc_gamemode_status`, `wc_dm_status`, `wc_dm_guns`, `wc_gg_status`, `wc_gg_setlevel`, `wc_mode_test`, `wc_killinfo_status`, `wc_killinfo_test`. Plugin output goes to the server console (`docker compose logs`) and `log_amx` to `cstrike/addons/amxmodx/logs`. Report which commands ran and what they showed.
