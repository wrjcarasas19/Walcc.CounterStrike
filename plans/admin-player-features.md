# Admin & Player Features — Plan

Date: 2026-10-05 · Branch: new branch off `main` (suggested `admin-player-features`)

Make the server more fun to run and to play on: more admin controls in the F4
menu (`src/client/src/admin.ts`), player-facing HTML features on top of the
HUD bridge (`src/client/src/hud.ts`), and a few server endpoints in Go
(`src/server/`).

## Progress (all steps built 2026-10-06)

Work is on branch `admin-player-features`, which was created from
`improve-client-server-networking`, not from `main`: `main` doesn't have
`admin.ts` or `hud.ts` yet. **Nothing is committed.** Each step was done by
one agent, one at a time. Detailed notes for each step (APIs, gotchas,
container test recipe) are in
[`admin-player-features-notes.md`](admin-player-features-notes.md). Smoke
tests and helper scripts are in `admin-player-features-tools/`. Each step
below also has its own "Checked in …" note.

**Done**, in order: 0.1 → 0.2 → 1.1 → 1.2 → 2.1 → 2.3 (engine `say`) → 0.3 →
3.1 → 3.2 → 2.3b (AMXX chat and centre messages) → 5.1 → 6.1 → 6.2 → 4.3 →
2.2 (bans) → 4.1 (knife/pistol plugin) → 4.2 (next map and vote) → 7 (radio
wheel) → 8.1 (lobby status) → 8.2 (leaderboard) → 8.3 (invite links).
Every step passed `npm run build`, plus the Go tests in `local/cs16-go-test`
where Go code changed. The server side of 0.3, 3.x, 2.3b, 6.2, 4.3, 2.2, 4.1,
4.2, 7, 8.1 and 8.2 was checked in the container. **No step has been checked
in a browser yet.**

**Left to do:** no implementation step. What remains is the manual checks
below, then review and commit.

**Decisions to review from 8.3:** the invite link section is in the F3
settings panel (the only menu every player can open, in game and on the
login page); `?join=1` is removed from the address on load, so a reload
doesn't rejoin; no extra "Join" click (sound and mouse capture start at the
first input).

**Fixed after 4.2:** `server.cfg` runs only at server start, not on map
change, so friendly fire and time limit set from the Match tab survive a map
change. The tab's "Reset on map change" note now lists only the weapon mode
(the plugin resets it); `CvarDef.serverCfg` was renamed `mapReset`.

**Decisions confirmed 2026-10-06:** 4.2 keeps pausing mapchooser for the
current map when the admin sets a next map (admin wins); 7 (Z replaces the
stock `radio1` key), 8.1 (no team in the lobby; time left needs AMXX) and 8.2
(`mattn/go-sqlite3`, bot rules, only the 20 newest logs kept, one row per
exact name) stay as built.

**Manual checks still open.** Each step's section in the notes file lists the
details.
- Browser checks for every step, on desktop Chrome and on a phone, in the
  Docker image (`make build-local-image`, then `make run`).
- Staging setup:
  - set the GitHub Environment secrets `RCON_PASSWORD` and `ADMIN_PASSWORD`,
    and optionally the variables `BOT_QUOTA` and `LEADERBOARD_BOTS`;
  - the new `cs16-data` volume (`DATA_DIR`: bans, leaderboard database)
    must survive redeploys;
  - treat the old `testwalle` rcon password as compromised;
  - consider HTTPS, since the admin password currently crosses plain HTTP.
- Measure CPU with 10 bots on the staging VPS.
- Server-side gaps: no real player has been banned (needs a WebRTC peer); the
  4.1 buy block is tested with `amxclient_cmd`, not the web buy menu; the map
  vote was won only with bot votes from a test plugin; the leaderboard has
  only counted bots.

**Changes outside this repo:** the `cs16-client` checkout at
`/Users/wcarasas/Repos/webxash3d-fwgs/packages/cs16-client` has uncommitted
bridge changes for 0.0.6 (2.1) and 0.0.7 (6.2). Its `html-hud.patch` and
`BUILD-NOTES.md` are updated, and both tarballs are vendored here.

## Constraints found while planning

These shape the order of the phases. Check them again before starting a phase.

- **rcon gives no reply to the page.** `admin.ts` runs
  `rcon_password` + `rcon <cmd>` with `Cmd_ExecuteString` and can only tell it
  worked from a side effect (today: a map load). Every admin action below needs
  a visible effect to confirm against, or it shows "Sent" instead of "Done".
- **No Metamod, AMX Mod X or bots in the image.** The README lists AMXX and
  Metamod-R, but the Dockerfile only copies the HLDS build and `configs/`;
  `configs/valve/addons/amxmodx/configs/maps.ini` is the only AMXX file. Stock
  CS 1.6 also has no bots. Any feature marked **[needs plugins]** waits on
  Phase 0.3.
- **Engine IP bans don't work.** `sfu.go` gives each WebRTC peer a fake IPv4
  address (slot index plus 3 random bytes, new on every connect). `addip` /
  `banid` would ban a throwaway address. Bans have to be done in Go, by the
  real remote address.
- **The rcon password is in the repo.** `configs/cstrike/server.cfg` has
  `rcon_password "testwalle"`. Fix this before adding more admin power.
- **Changes to the game client need a new tarball.** New HUD bridge events mean
  patching `cs16-client` (`web_bridge.{h,cpp}`), rebuilding, and bumping
  `vendor/cs16-client-0.0.5.tgz` to `0.0.6` (see `BUILD-NOTES.md` in the
  `webxash3d-fwgs` checkout for the npm cache issue).
- **`ScorePlayer.id` must be checked.** It is documented as slot order. `kick`
  needs a userid (`kick #<userid>`) or an exact name; if `id` is the slot, the
  bridge has to send the userid too. *Checked in 2.1:* `id` is the slot
  (1-based entity index), and the engine's `kick` (FWGS `SV_Kick_f`) takes
  only `#<userid>` or an exact name. `cs16-client` 0.0.6 adds `userid` (read
  through the studio API's `PlayerInfo`) and the cvar `hud_html_scores`,
  because `scores` was only sent while the scoreboard was visible.

## Definition of done for every step

On top of each step's own definition of done:

- `npm run build` succeeds with no TypeScript errors; Prettier formatting kept.
- `go test ./src/server/...` passes; new Go code has tests in the style of
  `maps_test.go` / `static_test.go`.
- Checked by hand in the Docker image (`make build-local-image`, then
  `make run`) on desktop Chrome, plus a phone check for any new UI.
- Any text that goes into a command line is validated against an allowlist
  pattern (like `MAP_PATTERN` / `PASSWORD_PATTERN`), never only escaped.
- New UI follows the login page / HUD styling and works with the keyboard
  (Esc closes, focus is trapped in the menu, keys don't reach the game).
- `README.md` updated when a new environment variable, port or plugin is
  added.

---

## Phase 0 — Foundation

### 0.1 Move the rcon password out of the repo

**Change:**
- Remove `rcon_password` from `configs/cstrike/server.cfg`.
- Read `RCON_PASSWORD` in `src/server/main.go` and pass it to the engine as a
  start argument (`+rcon_password <value>`). Leave rcon disabled (empty
  password) if the variable isn't set, and log a warning.
- Add `RCON_PASSWORD` to `docker-compose.yml` (from a `.env` file that is
  ignored by git) and to the README's variable table.
- Change the password on the staging VPS, since the old one is in git history.

**Definition of done:**
- [ ] `grep -r rcon_password configs/` finds nothing.
- [ ] With `RCON_PASSWORD` set, the F4 map change works.
- [ ] Without it, the F4 map change fails with the existing timeout message
      and the server logs the warning.
- [ ] The password isn't printed in server logs or sent to the page.
- [ ] Staging uses a new password.

### 0.2 Turn the admin menu into tabs with a shared rcon helper

**Change:**
- Split `admin.ts` into a small shell (open/close, key handling, password,
  status line) and one module per tab: `Map` (today's form), `Match`, `Bots`,
  `Players`.
- Add one `sendRcon(command: string): void` that sets `rcon_password` and runs
  the command. Command arguments are built only from typed values (numbers,
  enum names, validated names), never from free text.
- Add `expectEffect(check, timeoutMs)` so each tab can wait for a HUD event
  (`reset`, `scores`, map load) and show "Done" or a clear error. This
  generalises the `pending` timer that exists today for map changes.
- Keep the password for the session after the first successful command, as
  today.

**Definition of done:**
- [ ] The Map tab behaves exactly as the menu does today, including the
      15-second timeout message for a wrong password.
- [ ] Tabs can be switched with the mouse and with the keyboard; Esc and F4
      still close the menu; no key reaches the game while it's open.
- [ ] A new tab only needs a module and one entry in a list.
- [ ] Fits a phone screen in portrait without the page scrolling sideways.

### 0.3 Spike: Metamod, AMX Mod X and bots on the Xash3D server

This is time-boxed (about 1 day). The aim is a yes/no answer and notes, not
finished features.

**Change:**
- Try Metamod-R (or Metamod-P if R doesn't load under Xash3D) + AMX Mod X 1.10
  in the `hlds` Docker stage, with `liblist.gam` pointing at Metamod.
- Try YaPB for bots. It supports Xash3D and can run as a Metamod plugin.
- Confirm that `amx_*` commands and `yb` commands work over rcon.

**Definition of done:**
- [ ] A section added to this file with: what loads, versions, any crash or
      missing feature, and the image size change.
- [ ] Decision written down: go or no-go for each **[needs plugins]** step.
- [x] A section added to this file with: what loads, versions, any crash or
      missing feature, and the image size change.
- [x] Decision written down: go or no-go for each **[needs plugins]** step.
- [ ] If go: the plugins are installed from a pinned version/checksum in the
      Dockerfile, and the server still starts and serves a full round with
      the HTML HUD. *(Installed and checked with bots through the server
      console; the HTML HUD check in a browser is still manual.)*

### 0.3 results (spike done 2026-10-05)

**Decision: go.** Metamod-R + AMX Mod X + YaPB load and run on the Xash3D
server and are now in the image.

| Step | Decision | Notes |
| --- | --- | --- |
| 2.3 center message | Go | `amx_csay <color> <text>` and `amx_say <text>` work from the console (logged by `adminchat.amxx`). On-screen look still to check in a browser. |
| 3.1 Bots tab | Go | YaPB commands below; bots join, buy, fight, rounds end. |
| 3.2 Default bot quota | Go | `yb_quota <n>` + `yb_quota_mode fill`; image default `yb_quota "0"`. |
| 4.1 Knife / pistol modes | Go | `.sma` compiles with the bundled `amxxpc` (i386); needs build-stage tweaks, see below. Also YaPB has `yb weapons knife\|pistol\|...` for the bots' side. |
| 4.2 Map vote / next map | Go, with a change | `amx_nextmap` is a cvar but can't be set from the console on Xash3D; use `amx_cvar amx_nextmap <map>`. `amx_votemap` works. |

**How the server loads game DLLs.** The engine is linked into the Go binary
(`xash`, i386, dynamically linked against glibc 2.36). `SV_LoadProgs` uses
`dlopen(fullPath, RTLD_NOW)` on `gamedll_linux` from `cstrike/liblist.gam`
(`lib_posix.c`), so any i386 Linux `.so` built for glibc ≤ 2.36 works.
`liblist.gam` now points at `addons/metamod/metamod_i386.so`.

**What was tried:**
- *Metamod-R 1.3.0.149* (official release zip, i386): **works** once
  `/xashds/engine_i486.so` is removed. Metamod's ReHLDS lookup calls
  `dlopen("engine_i486.so", RTLD_NOW)` (not `RTLD_NOLOAD`), which loads the
  GoldSrc engine shipped in the HLDS archive (found via
  `LD_LIBRARY_PATH=/xashds`) into the Xash3D process, `dlclose`s it and then
  calls `dlsym` on the stale handle, a segfault right after the banner.
  Xash3D never uses that file, so the Dockerfile deletes it. Found with a
  backtrace from the qemu guest core dump.
- *Metamod-FWGS* release (`metamod-fwgs_linux_x86.zip`): needs glibc 2.38,
  won't load on bookworm. Built from source (commit `d80b2fe`) it has the same
  `engine_i486.so` crash and also works once that file is gone. Not used,
  since Metamod-R has an official prebuilt release.
- *AMX Mod X 1.10.0-git5486* (base + cstrike, official `amxxdrop`): loads
  as a Metamod plugin with Ham Sandwich and CSX; all 21 default plugins run.
  Its gamedata has no signatures for the Xash3D engine, so it logs
  "GameConfig CRC mismatch" and disables the `client_disconnected` /
  `client_remove` forwards and **cvar hooking/binding** (`hook_cvar_change`,
  `bind_pcvar_*`). Plugins written for 4.1 must poll cvars with
  `get_pcvar_num` instead. `adminslots.amxx` fails with "Invalid CVAR
  pointer" on every join, so the Dockerfile turns it off. Cvars marked
  `FCVAR_SPONLY` (`amx_nextmap`, `amx_debug`, ...) can't be set from the
  console ("can't set ... in multiplayer", `cvar.c` checks maxclients > 1);
  the API (`amx_cvar`, `set_cvar_*`) still sets them.
- *YaPB 4.4.957* (official `linux.tar.xz`, as a Metamod plugin): loads ("YaPB
  ... @ Xash3D Engine", flags BotVoice, Metamod). All 25 maps in the image
  (and so everything `mapcycle.txt` can list; today it lists only
  `de_dust2`) have a bundled graph, so no map lacks navigation. YaPB rebuilds
  a vistable on each map's first load (slow under qemu, seconds on x86).
  Default config adds 9 bots, so the Dockerfile sets `yb_quota "0"`.
- Stable for 10+ minutes with 10 bots on de_dust2, several rounds
  (`Terrorists_Win` / `Round_End` in the log), a map change on time limit
  (de_dust2 → de_aztec after `amx_cvar amx_nextmap de_aztec` +
  `mp_timelimit 1`), `sv_restart 1`, and all plugins still running after the
  change. No crashes. Tested under qemu (linux/386 on an arm64 Mac): about
  19 % of one host CPU and 360 MiB with 10 bots; measure on the VPS for 3.1.

**YaPB commands (for 3.1 / 3.2):**
- Add: `yb add [difficulty] [personality] [team] [model] [name]`; aliases
  `yb add_ct`, `yb add_t` (team 1 = T, 2 = CT in `yb add`).
- Kick one: `yb kick [team]`, `yb kick_ct`, `yb kick_t`. Kick all:
  `yb kickall` (kicks one by one; `yb removebots instant` for all at once),
  `yb kickall_ct`, `yb kickall_t`. (Engine `kick #<userid>` works on a bot,
  but YaPB adds one back; see 3.1.)
- Difficulty: cvar `yb_difficulty 0..4` (changes existing bots too).
- Quota: cvars `yb_quota <n>` and `yb_quota_mode normal|fill|match`
  ("fill" keeps N players in total, counting humans). `yb fill [team]
  [count] [difficulty]` adds in one go.
- List: `yb list` (index, name, team, difficulty, frags). Bots show as
  `<BOT>` in logs and `Bot` in `status`.

**AMX Mod X commands (for 2.3 / 4.2):**
- `amx_csay <color> <text>` (colors: white, red, green, blue, yellow,
  magenta, cyan, orange, ocean, maroon; from `adminchat.sma`, only `red`
  tested), `amx_say <text>`.
- Next map: `amx_nextmap` is a cvar (from `nextmap.amxx`); set it with
  `amx_cvar amx_nextmap <map>`. `mapchooser.amxx` holds its own vote near the
  end of the map and overwrites `amx_nextmap`; turn it off in 4.2 if the
  admin's choice must win.
- Vote: `amx_votemap <map> [map] [map] [map]` (up to 4 maps, not 5); the
  plan's "up to 5" should become 4. A vote with no human answers fails
  ("got 0, needed 1"); bots don't vote unless told to (`yb vote <map_id>`).
- `amxx plugins`, `meta list` for checks. The address-based `loopback` admin
  in `users.ini` is commented out (the SFU gives fake addresses); the server
  console / rcon has full access anyway.

**Compiling `.sma` (4.1):** the bundled `amxxpc` is an i386 ELF that needs
`libstdc++6:i386`. It compiled a test plugin in the runtime image. The `hlds`
stage is i386 locally (`--platform=linux/386`) but amd64 in CI
(`deploy.yml` builds `linux/amd64`), so 4.1 should compile in a stage that
adds the i386 architecture and installs `libc6:i386 libstdc++6:i386` (like
the `final` stage), using the scripting folder from the same AMXX archive.

**Image size:** `docker images` 1.47 GB → 1.49 GB; `/xashds` 803 MB → 822 MB
(addons 22 MB, minus `engine_i486.so`); compressed image 505.5 MB → 510.9 MB.

**Still manual:** a full round with the HTML HUD in a browser (scores show
bots, kill feed, timer), how `amx_csay` and AMXX menus (`amx_votemap`) look
in the web client, and bot CPU on the staging VPS.

---

## Phase 1 — Admin: match controls (cvars only, no plugins)

### 1.1 Match tab

**Change:** Controls that each send one cvar or command:

| Control | Command | Confirmed by |
| --- | --- | --- |
| Restart round | `sv_restart 1` | `timer` jumps (round clock resent at round start; `reset` is only sent on map load or reconnect) |
| Friendly fire on/off | `mp_friendlyfire 0/1` | "Sent" (no visible effect) |
| Time limit (minutes) | `mp_timelimit <n>` | `timer` changes after restart |
| Round time | `mp_roundtime <n>` | next round's `timer` |
| Start money | `mp_startmoney <n>` | `money` after restart |
| Freeze time | `mp_freezetime <n>` | "Sent" |
| Buy time | `mp_buytime <n>` | "Sent" |

Number inputs have min/max limits that match the engine's own limits (for
example `mp_startmoney` 800–16000).

**Definition of done:**
- [ ] Every control sends the right command (checked with the server log).
- [ ] Out-of-range or non-number input can't be submitted.
- [ ] "Restart round" shows "Done" after the round clock restarts (a `timer`
      event that isn't the previous value minus one), or an error after the
      timeout.
- [ ] Settings stay in place across a map change if `server.cfg` doesn't set
      them; the ones it does set are listed in the tab as "reset on map
      change". *(Corrected after 4.2: `server.cfg` runs only at server
      start, so all 1.1 cvars stay in place; only the 4.1 weapon mode is
      listed as reset.)*

### 1.2 Game mode presets

**Change:** One button per preset sends a group of cvars and then
`sv_restart 1`:

- **Casual:** friendly fire off, `mp_startmoney 16000`, `mp_freezetime 0`,
  `mp_buytime 0.5`, `mp_roundtime 3`.
- **Competitive:** friendly fire on, `mp_startmoney 800`, `mp_freezetime 6`,
  `mp_roundtime 1.75`, `mp_maxrounds 30`.
- **Warmup:** `mp_startmoney 16000`, `mp_freezetime 0`, `mp_roundtime 9`,
  `mp_buytime 9`.

Presets are defined in one data table so new ones are easy to add.

**Definition of done:**
- [ ] Each preset applies all its cvars and restarts the round; the HUD shows
      the new money and timer.
- [ ] The tab shows which preset was applied last in this session.
- [ ] Pressing a preset twice quickly doesn't send it twice.

---

## Phase 2 — Admin: players and messages

### 2.1 Players tab: list and kick

**Change:**
- Show the players from the latest `scores` HUD event (name, team, frags,
  bot marker).
- Kick with `kick #<userid>`. First confirm what `ScorePlayer.id` is; if it is
  the slot, add `userid` to the `scores` payload in the bridge (new
  `cs16-client` tarball).
- Ask for confirmation before kicking.

**Definition of done:**
- [ ] The list updates live while the tab is open.
- [ ] Kicking a player removes them from the server and the list; a player
      whose name has quotes, spaces or non-ASCII characters can be kicked.
- [ ] The local player can't kick themselves from the list.

### 2.2 Bans in Go, by real address

**Change:**
- Add a ban list in `sfu.go`, keyed by the remote address the WebSocket came
  from, saved to a JSON file under the server directory.
- Banning a connected player needs Go to know which slot the player is in,
  and rcon can't reach Go. So the "Ban" button comes with the admin API in
  4.3; this step only builds the ban list and the check.
- `websocketHandler` refuses banned addresses with 403.

*Checked in 2.2:* the list is in `src/server/bans.go` (not `sfu.go`),
saved as `bans.json` in `DATA_DIR` (default `data` in the working
directory, so `/xashds/data` in the image; the Dockerfile creates it owned
by `xashds`, and `docker-compose.yml`, `deploy.yml` and the README mount the
named volume `cs16-data` there). The key is the TCP peer address like the
login lockout (`addressKey`: IPv4 as is, IPv6 per /64; `X-Forwarded-For`
not trusted). `websocketHandler` answers 403 before the per-address limit
and the upgrade; bans are loaded and enforced even with the admin API off.
The admin API got `bans`, `ban {userid, slot}` and `unban {address}`
(`src/server/admin_bans.go`): `ban` runs `status`, takes the row of the
slot (`ScorePlayer.id - 1`), maps its fake address to the peer's real one
(`peerSlot.key`, set when the game channel opens), refuses bots, the
admin's own address (behind a proxy everyone would be banned) and a slot
that changed, saves the ban, runs `kick #<userid>` (taking the ban back if
the userid is gone, which also proves the row was that player's) and then
closes every PeerConnection from that address. A ban file that can't be
read is left alone: nobody is banned and changes are refused until it is
fixed. Checked in the image: bot ban refused (live `status` parsed), empty
slot 409, a hand-written `bans.json` in the volume loaded after a restart,
`bans` lists it, the banned address's WebSocket gets 403 (also with only
`RCON_PASSWORD`) while another container's gets 101, `unban` → 101 again
and the empty list survives a restart, a corrupt file → warning + 500 on
changes and the file kept. Not reproducible here: a ban through the API of
a real WebRTC player (needs a browser; the flow is covered by unit tests
with a fake console and peers).

**Definition of done:**
- [x] A banned address can't open the game page's WebSocket; other players
      aren't affected. *(403 vs 101 checked in the container. Other players
      behind the same address are banned too, by design.)*
- [x] Bans survive a container restart if the directory is a volume.
      *(Checked with a hand-written file and an unban; a ban made from the
      menu is saved the same way, covered by unit tests.)*
- [x] Bans can be listed and removed. *(Through the API in the container;
      the Players tab's list and Unban button are a manual browser check.)*
- [x] Unit tests for adding, matching and removing bans.

### 2.3 Server messages

**Change:** A text field that sends `say <text>` (chat line) and, with AMXX,
`amx_csay` (center of the screen) **[needs plugins for center]**. The text is
limited to printable characters without `"` `;` `\` and to 120 characters.

*Checked in 2.3 (FWGS d3bc7fab source):* the text is tokenized twice (in
the browser, then again on the server after rcon), so `$` (cvar expansion
with `cmd_scripting 1`), `//` (comment), `{` `}` `'` `,` (split into words of
their own) and `^` (console colour codes) are rejected too. Without plugins,
`say` reaches players only as a console line (`svc_print`), shown at the top
left for a few seconds, not in the HUD chat, and the server prints each word
in quotes (`<hostname>: "word1" "word2"`, from `SV_RemoteCommand` quoting
every argument and `SV_ConSay_f` printing `Cmd_Args` as is). There is no
HUD event for it, so the tab says "Sent", not "Done". A real chat line
needs `amx_say` / `amx_csay` (0.3).

*Checked in 2.3b (AMXX in the image):* the Message tab now has **Chat**
(`amx_say`, a real chat line `(ALL) <hostname> :   text`, sent as a
`TextMsg` print_chat) and **Center of screen** (`amx_csay <colour>`,
colour from a fixed list of the 10 `adminchat.sma` names, default yellow,
shows `<hostname> :   text` for 6 s with `amx_show_activity 2`). The engine
`say` target is dropped: it was only a worse copy of Chat. Sent straight
over rcon, both are broken by the re-quoting: `adminchat.sma` reads
`Cmd_Args` (`"w1" "w2" `, with a trailing space) and `remove_quotes` only
strips when *both* ends are `"`, so chat shows every word quoted and
`amx_csay` cuts the colour at the wrong offset (`" "w1" "w2"`). Fix: the
tab sends `alias web_msg amx_say <text>`, `web_msg`, `alias web_msg` (empty
alias = nothing, so a lost definition never repeats an old message);
`Cmd_Alias_f` joins the words without quotes and running the alias puts a
copy in the command buffer, so `read_args` gets the plain text. `%` is now
rejected too: the game's `MsgFunc_TextMsg` uses the text as a C format
string. Several spaces in a row become one. Verified in the server console
by typing exactly what `SV_RemoteCommand` runs (each word quoted, trailing
space): direct `amx_say` / `amx_csay` show the quotes; the alias sequence
prints `(ALL) My CS 1.6 Web Server :   Hello world! (go) #1 @all ~ok? a&b
[x] <3 | =+*` (plus a backquoted word) and `My CS 1.6 Web Server :  Server restarts in 5
minutes.`. Server console and rcon run as id 0, which `cmd_access` treats
as full access on a dedicated server (console verified; rcon inferred from
source, same `Cmd_ExecuteString` path). Inferred, not seen: the chat box
and center look in the browser, and that clearing the alias right after
running it is safe over rcon (the alias text is copied into the buffer).
Still "Sent", not "Done": no HUD event for chat or HUD text.

**Definition of done:**
- [ ] The message appears in every player's chat. *(Server side verified;
      browser check with 2+ clients is manual.)*
- [x] Characters that could end the command are rejected in the form, not
      silently removed.

---

## Phase 3 — Admin: bots **[needs plugins]**

### 3.1 Bots tab

**Change:** Using YaPB commands (names to be checked in the 0.3 spike):
add a bot to CT / T, kick one or all bots, set difficulty (0–4), set a
quota ("fill to N players").

*Checked in 3.1 (YaPB 4.4.957, server console in the image):*

| Control | Command | Confirmed by |
| --- | --- | --- |
| Add CT / T bot | `yb add_ct` / `yb add_t` | `scores`: one more bot on that team (15 s) |
| Kick a bot | `yb kick` (a dead bot first, random team) | `scores`: one bot fewer (5 s) |
| Kick all bots | `yb kickall instant` | `scores`: no bots (5 s) |
| Difficulty 0-4 | `yb_difficulty <n>` | "Sent" (changes bots already playing too) |
| Fill to N players | `yb_quota_mode fill` then `yb_quota <n>` (0-32) | "Sent" |

- `yb add*` raises `yb_quota` by one and `yb kick` lowers it by one;
  `yb kickall` sets it to 0. Without `instant`, kickall only zeroes the
  quota and the quota check removes bots one every 0.4 s.
- A bot joins about 5 s after `yb add` here (qemu); after a map change
  YaPB waits `yb_join_delay` (5 s) first.
- Adding to a team fails with "Team is stacked" when `mp_limitteams` would
  be broken (`server.cfg` has `mp_autoteambalance 1`); the tab's timeout
  message says to add to the other team first.
- yapb.cfg runs again on every map change and put `yb_quota_mode` back to
  `normal` and `yb_difficulty` to 3 (only `yb_quota` was kept, by
  `yb_ignore_cvars_on_changelevel`), so "fill to N" became "N bots". The
  Dockerfile now adds `yb_quota_mode` and `yb_difficulty` to that list;
  checked: both survive `changelevel`.
- YaPB couldn't write `addons/yapb/data/train` (owned by the build user,
  directory mode without `x`), so it rebuilt each map's vistable and path
  matrix on every load (2.5 minutes of CPU for de_dust2 under qemu). The
  Dockerfile now gives the runtime user write access; the files are kept
  for the life of the container (checked: the second load of de_dust2
  loads them instead of rebuilding). A volume for `data/train` would keep
  them across restarts.
- Engine `kick #<userid>` works on a bot, but it doesn't lower `yb_quota`,
  so YaPB adds a bot back (same name) a few seconds later. The Players
  tab's kick shows "Done" (the userid is gone) even though a bot comes
  back; use the Bots tab to remove bots for good.
- "Fill to N" counts humans on a team (`getHumansCount(true)`, so not
  spectators) plus bots, every 0.4 s (`maintainQuota` in YaPB's
  `manager.cpp`). Tested only with bots (0 humans: `yb_quota 5` in fill
  mode gave 5 bots); humans joining and leaving is a manual check.
- With 7 bots at difficulty 4 on de_dust2 they moved and fought (frags
  and deaths in `yb list` within a minute; buying and round ends were seen
  in 0.3); fill mode, quota and difficulty were kept over a `changelevel`.

**Definition of done:**
- [ ] Added bots appear in the `scores` event and the tab shows "Done".
      *(Commands checked on the server console; the tab in a browser is
      manual.)*
- [ ] "Fill to N" keeps the total at N as humans join and leave. *(Fill
      mode checked with bots only and kept across map changes; with humans
      it's manual.)*
- [x] Bots buy, move and fight on `de_dust2` and every map in
      `mapcycle.txt`; maps without navigation data are listed in this file.
      *(`mapcycle.txt` lists only de_dust2; all 25 maps in the image have a
      YaPB graph, see 0.3 results, so none is listed.)*
- [ ] Server CPU with 10 bots measured on the staging VPS and noted here.
      *(Manual. Under qemu: about 19 % of one host CPU and 360 MiB.)*

### 3.2 Default bot quota

**Change:** `BOT_QUOTA` environment variable (default `0`) so a near-empty
server isn't boring.

*Checked in 3.2:* start arguments (`+yb_quota_mode fill +yb_quota 6`) don't
work: YaPB runs `yapb.cfg` when the first map loads, after the start
arguments, and it put both back to `0` / `normal` without a message. So the
Go server (`src/server/bots.go`) validates `BOT_QUOTA` (0-32, else a warning
on stderr and 0) and rewrites the `yb_quota` and `yb_quota_mode` lines in
`cstrike/addons/yapb/conf/yapb.cfg` before the engine starts (`fill` for
N > 0, `normal` for 0 so the Bots tab's add/kick keep counting bots); the
Dockerfile gives the runtime user that file. Checked in the image:
`BOT_QUOTA=6` with no humans gave 6 bots in fill mode; the Bots tab's
commands (`yb_quota_mode fill`, `yb_quota 3`) brought it to 3 and that was
kept over a `changelevel` ("differs from the stored in the config (3/6).
Ignoring."); unset and `33` gave 0 bots (`33` with the warning). Also in
`docker-compose.yml`, `.env.example`, the README and `deploy.yml` (GitHub
Environment variable `BOT_QUOTA`).

**Definition of done:**
- [ ] With `BOT_QUOTA=6`, a single player joining finds 5 bots; the README
      explains the variable. *(README done; 6 bots with no humans checked in
      the image; a human joining is a manual browser check.)*

---

## Phase 4 — Admin: plugin modes and map voting **[needs plugins]**

### 4.1 Knife-only and pistols-only modes

**Change:** A small AMXX plugin (source in the repo, compiled in the Docker
build) with a cvar `wc_weaponmode 0|1|2` (off / knife / pistols). The Match
tab gets the two extra presets.

**Definition of done:**
- [ ] In knife mode players can't buy or pick up guns; in pistol mode only
      pistols; turning it off restores normal buying. *(Checked in the
      container with YaPB bots, with buys sent through `amxclient_cmd`,
      which runs the same plugin hooks as a real client's command. A real
      player buying through the web client's buy menu is a manual browser
      check.)*
- [x] Mode is kept after a round restart and reset on map change.

*Checked in 4.1:* `src/amxx/wc_weaponmode.sma` is compiled in a new
`amxx-plugins` Docker stage (i386 libraries added; checked on linux/386 and
linux/amd64; a compile error fails the build), copied into
`addons/amxmodx/plugins/` and added to AMXX's `plugins.ini`. The cvar
`wc_weaponmode` (`FCVAR_SERVER`, not `FCVAR_SPONLY`) is set from the console,
over rcon and through the admin API (`cvar` action, range 0–2). The plugin
polls it once a second. AMX Mod X can't hook cvars on Xash3D, and the
cstrike module's `CS_OnBuyAttempt` **never fires** here, so the plugin hooks
the buy commands itself: every buy alias, `menuselect` by the player's
`m_iMenu`, and autobuy/rebuy. It blocks pickups with `Ham_Touch` on
`weaponbox`, `armoury_entity` and `weapon_shield` (by world model), and once a
second, and 0.1 s after each spawn, takes away any weapon the mode doesn't
allow. In pistols mode a player with no pistol at spawn gets the team's
default one. **Knife only:** knife, C4 (the bomb objective still works),
armour, defuse kit and night vision. **Pistols only:** the same plus pistols
and pistol ammo. Grenades and the shield are not allowed in either mode.
YaPB bots also get `yb_jasonmode 1` (knife) or `yb_restricted_weapons`
(pistols), so they don't try to buy what the plugin refuses. `plugin_init`
sets the cvar back to 0 on every map change, not server.cfg; the Match tab
lists "Weapon mode normal" under "Reset on map change". The Match tab also
has a "Weapon mode" select and the presets **Knife only** and **Pistols
only**; Casual, Competitive and Warmup set it back to normal. Seen in the
container: bots keep only a knife (plus C4) or only pistols over several
rounds; a T picks up the dropped C4 in knife and pistols mode, a CT standing
on an AK-47 doesn't get it until the mode is off; aliases, menus, rebuy,
grenades and primary ammo are refused with the money unchanged, while
pistols, armour and pistol ammo are bought; `sv_restart 1` keeps the mode;
`changelevel` resets it to 0 and bots buy rifles again; `log_amx` writes to
`addons/amxmodx/logs` now that the Dockerfile chowns `logs` and `data`.
**Not handled:** a shield bought before the mode was turned on stays until
the player dies, and a weapon bought through some path the plugin doesn't
hook is taken away within a second, but the money isn't refunded.

### 4.2 Map vote and next map

**Change:** Map tab gets "Set as next map" (`amx_nextmap`) and "Start vote"
(`amx_votemap` with up to 4 picked maps).

**Definition of done:**
- [x] The next map is used when the time limit ends. *(Checked in the
      container through the admin API; the Map tab button itself is a
      manual browser check.)*
- [ ] A vote shows the in-game menu to every player and changes to the winner.
      *(The vote starts through the API and console, fails with no votes,
      and changes to the winner when YaPB bots are made to vote through
      AMX Mod X's own vote handler. The menu as real players see it in the
      web client, and voting with the number keys, are manual browser
      checks.)*

*Checked in 4.2:* new admin actions (`src/server/admin_maps.go`, mirrored in
`actions.ts` for rcon): `set_nextmap {map}` sends `amx_cvar amx_nextmap <map>`
and `amxx pause mapchooser.amxx`; `votemap {maps: [1–4 names]}` sends
`amx_votemap <maps>`; `nextmap {}` (admin API only) reads `amx_nextmap` back
as `{nextMap}`. Map names must match `MAP_PATTERN`, have a `.bsp` on the
server, and be at most 31 characters (AMX Mod X keeps 32-byte names). The
server answers the vote with 409 if a vote is running ("There is already
one voting...") or the last one ended less than `amx_vote_delay` (10 s)
ago, and 502 if AMX Mod X didn't start it. Map tab: the map list as before,
**Change map**, **Set as next map** (with "Next map: X" read through the API;
rcon only says "Sent"), and a **Map vote** field: Add to vote puts the
selected map in a list of up to 4 removable picks, **Start vote** waits up
to 29 s for the map change (`reset` HUD event) and otherwise says the vote
failed. *How AMX Mod X behaves here:* `nextmap.amxx` changes to
`amx_nextmap` at intermission (time limit or max rounds, after
`mp_chattime`) and sets it back to the next `mapcycle.txt` entry on every
map load, so "next map" only lasts one map. `amx_votemap` (adminvote.amxx)
shows the menu for `amx_vote_time` + 2 = 12 s; a map wins with at least
`amx_votemap_ratio` (0.40) of the votes and at least one vote, and from the
server console the winner is loaded 2 s later with `changelevel` (no next
map involved); one map is a yes/no vote. Bots never get AMX Mod X menus, so
with only bots every vote fails ("got 0, needed 1").
**Decision (revisit if wanted): the admin's next map wins by pausing
`mapchooser.amxx` for the rest of the map** rather than turning it off in
the Dockerfile. `mapchooser.amxx` holds the players' own vote (5 random
maps from AMX Mod X's `maps.ini`, plus "extend") about two minutes before
the end and overwrites `amx_nextmap` if anyone voted, which was seen in the
container. Pausing keeps that vote on every map where the admin didn't pick
a next map; AMX Mod X loads its plugins again on each map, so the pause
ends by itself (checked: `running` again after the change). The cost: once
the admin sets a next map, players can't vote to extend that map either.
Turning mapchooser off for good would be one `sed` line in the `hlds`
stage, like `adminslots`. Seen in the container: `set_nextmap de_aztec`
through the API, then `mp_timelimit 2`: no mapchooser vote and the server
changed to de_aztec at the time limit; without the pause, two bots voting
through mapchooser's handler replaced `de_inferno` with `de_prodigy`;
`amx_votemap de_dust2 de_inferno` with two bot votes for de_inferno changed
the map 14 s later; with no votes it failed after 12 s.
**Found, not fixed:** `server.cfg` runs only when the server starts
("execing server.cfg" appears once), not on map change, so a `mp_timelimit`
set from the Match tab survives a map change. The Match tab's "Reset on map
change: Friendly fire on, Time limit 30 min, ..." note (1.1) is wrong for
those two cvars.

### 4.3 Admin API in Go (replaces browser rcon)

**Change:**
- `POST /admin/login` checks `ADMIN_PASSWORD` and sets a signed, HTTP-only
  session cookie (rate limited per address).
- `POST /admin/command` takes a typed action (`{ "action": "kick", "userid":
  3 }`), turns it into an engine command on the server, and returns the
  result. Check in goxash3d whether Go can run console commands and read the
  output; if not, write that down here and keep rcon.
- The F4 menu uses this API when it's there and falls back to rcon.

**Definition of done:**
- [x] The rcon password is never typed in or sent by the browser. *(With
      `ADMIN_PASSWORD` set; without it the menu falls back to rcon as
      before.)*
- [x] Only listed actions are accepted; anything else gets 400.
- [x] Wrong password 5 times from one address locks it out for 5 minutes.
- [ ] Ban (2.2) works from the Players tab. *(Built in 2.2: Ban button
      next to Kick, hidden in rcon mode with a note saying why; the server
      side is checked in the container and by unit tests, but banning a
      real player needs a browser check.)*

*Checked in 4.3 (goxash3d-fwgs 90b4aa8, FWGS d3bc7fab):* goxash3d only
wraps `Host_Main` and the `recvfrom`/`sendto` callbacks, but the engine is
linked statically, so cgo can call any exported engine function
(`drop.go` calls `Cbuf_AddText`, which is not thread-safe and so only runs
inside the `recvfrom` callback, on the engine thread). **Reading output
works without touching engine internals:** Go owns the sockets, so it
injects `\xff\xff\xff\xffrcon "<pw>" <cmd>` into the packet queue from a
fake address no player has (`254.0.0.1`, `console.go`) and catches the
replies in the `sendto` callback. `SV_RemoteCommand` runs the command inside
`SV_BeginRedirect`/`SV_EndRedirect`, and `Rcon_Print` sends every finished
line as an out-of-band `print\n<text>` packet plus one more at the end with
the rest (empty, or a line without its newline), which marks the end of the
output. (The alternative, `host.rd` + `Cmd_ExecuteString` directly, needs
the engine's struct layouts in cgo.) Only what prints while the command
runs comes back: `kick #99` answers "Client is not on the server",
`changelevel` returns before the map loads, `yb add` before the bot joins,
the alias for `amx_say` before AMX Mod X prints. So the menu still confirms
effects through HUD events (`expectEffect`). The engine logs every rcon
packet with its password (`Rcon from 254.0.0.1:12345: rcon "<pw>" ...`), as
it did for browser rcon; with `RCON_PASSWORD` unset the server uses a random
one per start. With the API on, rcon packets from players are dropped in
`ReadLoop` (the server never reassembles split packets, so a request can't
be smuggled in pieces).

API: `GET /admin/session` → `{loggedIn}` (404 when `ADMIN_PASSWORD` is unset
or shorter than 8, and the menu uses rcon); `POST /admin/login`
`{password}` → HMAC-signed cookie `cs_admin` (key random per process, 8 h,
HttpOnly, SameSite=Strict, Path=/admin/, Secure over https or with
`X-Forwarded-Proto: https`); `POST /admin/logout`; `POST /admin/command`
with one action: `changelevel {map}` (must exist in `cstrike/maps`), `cvar
{name, value}` (same cvars and limits as `cvars.ts`; 8 since 4.1 added
`wc_weaponmode`), `restart`, `kick
{userid}`, `say {text}`, `csay {text, color}` (same allowlist as
`message-text.ts`, same alias trick), `bot_add {team}`, `bot_kick`,
`bot_kick_all`, `bot_difficulty {level}`, `bot_quota {players}`. Exactly
those fields, JSON numbers without sign or exponent; else 400. Response
`{output}` (what the engine printed, colour codes removed), 504 if the
engine doesn't answer within 20 s. POSTs need `Content-Type:
application/json` (415) and, if the browser sends them, a same-host
`Origin` and a non-cross-site `Sec-Fetch-Site` (403). Lockout is per TCP
peer address (`r.RemoteAddr`, like the WebSocket limits; IPv6 per /64);
`X-Forwarded-For` is not trusted, so behind a proxy everyone shares one
lockout. The server only serves plain HTTP: the admin password crosses the
network in the clear unless an HTTPS proxy is put in front (README).
Presets send their cvars one action at a time; the client runs actions in
order and drops the queued ones after a failure.

---

## Phase 5 — Player: settings panel

### 5.1 HTML settings

**Change:**
- New panel opened from the login page and in game (key to be picked, e.g.
  F3), with: mouse sensitivity, crosshair colour/size/translucency
  (`cl_crosshair_color`, `cl_crosshair_size`, `cl_crosshair_translucent`,
  `cl_dynamiccrosshair`), volume, HUD scale and opacity (CSS variables on
  `#hud`).
- Saved in `localStorage` like `player.ts` does for the name, and applied in
  `main.ts` before `connect`.

**Definition of done:**
- [ ] Each change is visible in game at once, without reconnecting.
- [ ] Settings survive a page reload; a "Reset to defaults" button works.
- [ ] Saved values are validated when read back (bad or old values fall back
      to defaults).
- [ ] Works on phone with touch controls on.

*Checked in 5.1:* the cvars exist in cs16-client `ammo.cpp` and are re-read
every frame: `cl_crosshair_color "R G B"` (default `50 250 50`; the panel
offers the 5 `adjust_crosshair` colours), `cl_crosshair_size
auto|small|medium|large`, `cl_crosshair_translucent 0|1`,
`cl_dynamiccrosshair 0|1`. `sensitivity` (client, default 3) and `volume`
(engine, 0-1, default 0.7) are plain console cvars. Key: F3 (unbound in
stock CS 1.6; the browser's find-next is cancelled). Touch: a gear button
at the top edge, in a gap of cs16-client's default touch layout. Open/close,
focus trap and key blocking moved from the admin shell to
`src/client/src/modal.ts`, shared by both menus.

---

## Phase 6 — Player: match stats

### 6.1 Session stats from the kill feed

**Change:** Count kills, deaths, headshots and kill streaks from the `kill`
HUD events for every player, from the time the page joined. Show the local
player's K/D and headshot % on the scoreboard, and "Double kill" / "Triple
kill" toasts.

**Definition of done:**
- [ ] Numbers match a hand count over 3 rounds.
- [ ] Stats reset on map change (`reset`) and toasts can be turned off in
      settings (5.1).

*Checked in 6.1:* the `kill` event only carries names (cs16-client
`death.cpp` sends `g_PlayerInfoList[slot].name`, not the slot); killer is
`""` for suicides and world kills, a non-player victim has `victimTeam ""`
and the object name as `victim`, teamkills are only recognisable by equal
teams. Stats are keyed by name (the server keeps connected names unique);
renames are followed through `scores` userids. The local player is the
connect name until a `scores` snapshot gives the server's name. Teamkills
and suicides count as deaths for the victim but never as kills. A multi-kill
is local enemy kills at most 4 s apart (kill to kill). Logic in
`src/client/src/stats.ts` (no DOM); the scoreboard shows "You this session"
(K, D, K/D, HS %, best streak); toast toggle `killStreakToasts` (label
"Multi-kill toasts"). 6.2 could add killer/victim slots to the `kill` payload
when it bumps the tarball.

### 6.2 Round and map summary

**Change:**
- Add `round` (winner, reason) and `intermission` events to the HUD bridge in
  `cs16-client`, then bump the tarball to `0.0.7` (`0.0.6` went to 2.1).
- After a round: a short banner with the winner and the round MVP (most kills
  that round). At map end: a summary screen with each player's stats and the
  next map.

**Definition of done:**
- [ ] The bridge events are documented in `web_bridge.h` and the patch is
      updated (`html-hud.patch`).
- [ ] Banner appears for every round end type (elimination, bomb, defuse,
      time).
- [ ] The summary appears at map end and goes away when the next map loads.

*Checked in 6.2:* the round end source is the HUD_PRINTCENTER `TextMsg`
title: the game dll sends exactly one per round end (`EndRoundMessage`), and
it names both winner and reason (`#CTs_Win`, `#Terrorists_Win`,
`#Target_Bombed`, `#Bomb_Defused`, `#Target_Saved`, `#Round_Draw`, hostage /
VIP / escape titles, `#Game_Commencing`; all present in the image's
`cs.so`). SendAudio (`%!MRAD_ctwin`...) only has the winner. In the container
with YaPB the log showed `CTs_Win`, `Terrorists_Win`, `Target_Saved`,
`Bomb_Defused` and `Target_Bombed` (bots frozen after the plant); note that
all CTs dying after the plant ends the round at once as `Terrorists_Win`.
cs16-client 0.0.7: `round { winner: CT|T|"", reason, message, ctScore,
tScore }` with reason `elimination|bomb|defuse|time|hostages|vip_escaped|
vip_killed|escaped|escape_prevented|draw|commencing`, sent the frame after the
title so the TeamScore is included; `intermission { active, map }` from the
engine's intermission flag; `kill` also has `killerUserid` / `victimUserid`
(stats.ts follows renames with them). **No next map:** it is a server cvar
(`amx_nextmap`, set by mapchooser) the client can't read, and AMXX only
announces it as a localised chat line; the summary says "The next map loads
in a few seconds" instead. 8.1's `/status.json` could add it if Go can read
it. There is no round start event: the page calls `startRound()` when a
`timer` event jumps up by more than 2 s (RoundTime at round start / freeze
end), so kills after the round end title still count for the old round. The
banner (`#hud-round`, 5 s, hidden on round start) shows winner, reason, team
score and the round MVP (most enemy kills that round, ties: headshots, then
fewer deaths); none for `commencing`. The summary (`#hud-summary`) replaces
the forced intermission scoreboard: map result from the team scores, map
MVP, and one row per player (server score + session K/D/HS/best streak;
players who left with stats are listed as "left"); it is part of `#hud`
(no pointer events, no focus) and is removed on `reset`. Logic in
`src/client/src/rounds.ts` (no DOM).

---

## Phase 7 — Player: quick chat and radio wheel

**Change:** Hold a key (e.g. `Z`) to show a wheel with the radio commands and
a few chat lines (`say_team "..."`); a touch button opens it on phones.

**Definition of done:**
- [ ] Choosing an item sends the command; releasing without choosing does
      nothing. *(Implemented; every command accepted by the game in the
      container; browser check open.)*
- [ ] The mouse doesn't turn the player while the wheel is open; the pointer
      lock comes back after. *(Implemented through `modal.ts`; browser check
      open.)*
- [ ] Usable with one thumb on a phone. *(Slide or tap from a touch button;
      phone check open.)*

*Checked in 7:* the 21 direct radio commands (`coverme` ... `enemydown`, the
game dll's `radioInfo` table behind the radio1/2/3 menus) all exist in the
image's `cs.so`; sent by a YaPB bot through `amxclient_cmd` in the
container, each one produced `SendAudio` + `TextMsg #Game_radio` for both
teammates. The game drops a radio command sent less than 1.5 s after the
previous one (`GetRadioTimeout`) and allows 60 per round, silently; dead
players and spectators can't use the radio. `say_team "Drop me a weapon
please"` (the quoted form the browser sends: FWGS `Cmd_ForwardToServer`
passes `Cmd_Args()` raw, the same as the engine's own chat line) arrived as
one line without quotes (`SayText #Cstrike_Chat_CT`). Key: **Z by default,
which replaces the stock `radio1` key** (the wheel's first page has the same
6 commands; X / C still open the radio2 / radio3 menus); setting "Radio wheel
(hold)" in F3 offers Z, V (unbound in stock CS 1.6) or Off. The key is
matched by character like the engine's binds. Hold the key and move the
mouse (relative movement, like turning) or press 1-9; releasing sends the
highlighted item or nothing; a tap shorter than 0.3 s leaves the wheel open
to click an item. Four pages (Commands, Group, Report, Team chat with 8
fixed lines), switched with Q / E, arrow keys, the mouse wheel or the page
buttons. Touch: a button under the settings gear; slide from it and let go,
or tap it and then tap an item. Hold, keyup and Esc go through `modal.ts`
(new `onToggleKeyUp`, toggle key may be a function, `anyModalOpen()`). The
engine's own chat line gives no event, so the page guesses it is open after
Y / U until Enter, and then lets the wheel key type its letter. Logic in
`src/client/src/wheel/items.ts` (no DOM).

---

## Phase 8 — Server: lobby and leaderboard

### 8.1 Lobby status on the login page

**Change:**
- `GET /status.json` returns map, players (names, team, frags), max players
  and time left, cached for 2 seconds.
- First find a data source: the SFU already counts connections; for map and
  names, try an A2S_INFO / A2S_PLAYER query sent through the engine's
  network callbacks. Write down which way works.
- The login page shows "de_dust2 · 5/16 players" and the names.

**Definition of done:**
- [ ] Data on the login page matches the in-game scoreboard within 5 seconds.
      *(`/status.json` matched `status` and `yb list` in the container
      (names, frags, count, map; `amx_timeleft` to the second) and showed a
      map change within 2 s; the page refreshes every 5 s, so the worst
      case is about 7 s. The page itself and the comparison with the
      in-game scoreboard are manual browser checks.)*
- [x] The endpoint can't be used to slow the engine down (cache plus a rate
      limit).
- [x] Unit tests for the handler with a fake data source.

*Checked in 8.1:* **data source: the engine's own server queries, sent the
way 4.3 sends rcon.** Go queues connectionless packets from a second fake
address (`queryAddr` 254.0.0.2, `status.go`) and the `sendto` callback
hands the answers to `engineQuery`. FWGS d3bc7fab (`sv_query.c`) answers
A2S_INFO (`I`: map, players incl. bots, max players, bots), A2S_PLAYER
(`D`: name, frags, connection time, which is -1 for fake clients, so
**YaPB bots are marked**) and A2S_RULES (`E`: every `FCVAR_SERVER` cvar,
which includes `mp_timelimit`, AMX Mod X's `amx_timeleft` "MM:SS" and
`amx_nextmap`), **with no challenge**. Two quirks: the engine tokenizes the
packet before comparing, so `TSource Engine Query` must be sent quoted
(unquoted it reads as `TSource` and gets no answer, going by the code),
and there is no A2S_PLAYER answer at all with no players, with
`sv_password` set or with `sv_expose_player_list 0`. No rcon is involved,
so it works without `ADMIN_PASSWORD` (the query client is always created,
`blockPlayerRcon` is untouched) and the engine logs nothing per query
(only with `sv_log_outofband 1` and `developer 2`). Running `status`
through `console.Run` would also have worked, but it logs the rcon
password on every call and needs the admin API. **No team:** none of the
queries carry it (nor does `status`), so the JSON has no team; the list
is sorted by score. **Time left:** `amx_timeleft`, which timeleft.amxx
rewrites every 0.8 s from `mp_timelimit` and the game time; with no AMX
Mod X or `mp_timelimit 0` it is `null` (precision: about 1 s plus the 2 s
cache). **Next map:** `amx_nextmap` from the rules; 6.2's map summary now
fetches `/status.json` at intermission and shows "Next map: X." when the
status is still on the map that ended (otherwise the old text). API:
`GET`/`HEAD /status.json` → `{map, playerCount, maxPlayers, bots, players:
[{name, frags, bot?}], timeLimit, timeLeft, nextMap?}`, 503 if the engine
doesn't answer within 1.5 s (e.g. during a map load), 429 + Retry-After
over 5 requests/s per address (bursts of 20; `clientKey`, so IPv6 per /64
and no `X-Forwarded-For`). Cached 2 s with one shared query (also caches
failures). Banned addresses may read it (it's what a server browser
shows). Seen in the container: about 250 requests in 10 s caused 5 query
rounds (3 packets each); 60 parallel requests from one address got 20 ×
200 and 40 × 429; same output with and without `ADMIN_PASSWORD`; admin
commands still work alongside. Login page: a panel "On the server" at the
top of the form (map · n/max players, time left, a scrolling list of names
with a Bot tag and the score), refreshed every 5 s while the tab is visible,
stopped when the game starts, kept as last shown if a request fails.

### 8.2 Persistent stats and leaderboard

**Change:**
- Set `mp_logfile 1` and have Go follow the `logs/` directory, reading kill,
  team and round lines.
- Store totals per player name in SQLite (a volume), and serve
  `/leaderboard` (top 20 by kills, K/D, headshot %).

**Definition of done:**
- [x] Stats from a full map show up in the leaderboard and survive a
      restart. *(In the container with YaPB bots and `LEADERBOARD_BOTS=1`:
      a 3-minute map, then `docker restart`, then another map; the totals
      matched an independent count over all 6 log files, nothing doubled.
      No human player was involved; the login page panel is a manual
      browser check.)*
- [x] Log parser has tests with real log lines, including names with quotes.
      *(Real lines from the image, incl. names with `<`, `>`, `%` and a
      name that looks like a whole player token. The engine refuses `"` in
      names (`Info_SetValueForStarKey`), so the quote cases are hand-made
      lines.)*
- [x] Bots are left out by default.
- [x] The README notes that names aren't verified, so anyone can use any
      name.

*Checked in 8.2:* **logging:** Xash3D's `mp_logfile` is already 1 by
default; `log on` is what's needed, and it stays on over map changes. The
Go server adds `+log on +mp_logecho 0` to the engine's start arguments
(only when `DATA_DIR/leaderboard.db` opens), since `server.cfg` only runs
at startup and could be edited away. The engine (FWGS `sv_log.c`) writes
`cstrike/logs/LMMDDNNN.log` (not `/xashds/logs`; the folder must exist
and be writable, so the Dockerfile creates it for `xashds`), one new file
per map load plus a nearly empty one for `log on` before the first map,
one `write()` per line, no buffering, lines `MM/DD/YYYY - hh:mm:ss: ...`
**without GoldSrc's `L ` prefix** (both are accepted). Bots are `BOT` in
the game dll's lines and `ID_BOT` in the engine's / AMXX's; humans are
`ID_<hash>`; the engine's own `connected` line has the slot where the auth
goes. The log also gets every rcon command **with the password**
(`Rcon: "rcon <pw> ..."`). **Headshots:** stock CS 1.6 doesn't log them;
our `src/amxx/wc_statslog.sma` logs `"K<..>" triggered "wc_headshot"
against "V<..>" with "w"` on each headshot DeathMsg (checked: one per
headshot kill, just before the `killed` line). **Counting** (same as
6.1): enemy kills only; teamkills and suicides are deaths (teamkills also
counted, not shown); headshot % = headshot kills / kills; rounds = on T/CT
when a round that had a `Round_Start` ends (so the `Game_Commencing`
round and `sv_restart` don't count). Bots get no row unless
`LEADERBOARD_BOTS=1`, but a human's kill of a bot counts as a kill.
**Storage:** `mattn/go-sqlite3` (cgo; the `go` stage's `gcc -m32` builds
it for 386, both locally and in CI's amd64 build), `leaderboard.db` in
`DATA_DIR` with totals per name and, per log file, a hash of its first
line plus the offset read, updated in one transaction, so restarts
neither double-count nor skip and a new container's `L1006000.log` isn't
mistaken for the old one. Only complete lines are read; who is on which
team is rebuilt after a restart by re-reading the current file up to the
stored offset without counting. Only the 20 newest log files are kept
(older ones deleted once fully read). **Endpoint:** `GET /leaderboard`
→ `{players: [{rank, name, kills, deaths, kd, headshots,
headshotPercent|null, rounds}], bots}`, top 20 by kills (then fewer
deaths, then name), cached 5 s, rate limited like `/status.json`, 404 if
the database can't be opened (logging is then not turned on). Login page:
a closed "Top players" section under the lobby status (`leaderboard.ts`),
shown only if the endpoint answers, refreshed when opened (at most every
30 s), names via textContent, fixed table layout with ellipsis.

### 8.3 Invite links

**Change:** A "Copy invite link" button on the HUD menu; opening
`/?join=1` skips straight to connecting once the name is set.

**Definition of done:**
- [ ] The link opens the game and connects with the saved name; with no saved
      name, it focuses the name field first. *(Built: `?join=1` with a saved
      name starts the download and connects through `connect()` / `start()`
      without a click; without one the nickname field is focused and the
      next Download goes on to connect. The decision and URL logic pass a
      smoke test; the browser and phone checks are still manual.)*

*Checked in 8.3:* **"HUD menu" = the F3 settings panel**, the only menu
every player can open both in game (F3, gear button with touch controls)
and on the login page (Settings button); the in-canvas main menu belongs to
the engine and F4 is for admins. An "Invite friends" section at the top of
the panel shows the link in a read-only field with a "Copy invite link"
button: `navigator.clipboard` in secure contexts, else (plain HTTP staging)
select + `execCommand('copy')`, else the link stays selected with a
"copy by hand" hint. The link is `location.origin + location.pathname +
?join=1`, nothing else. **No user gesture needed:** downloading and the
WebRTC connect don't need one; the engine's AudioContext is resumed by
emscripten on the first keydown/mousedown/touchstart and pointer lock is
taken on the first click on the canvas, as after a normal Connect (whose
click is usually older than the browser's ~5 s activation window by the
time `start()` runs anyway). So no extra Join button. `join` is removed
from the address bar with `history.replaceState` on load (the intent is
kept in memory), so a reload after "Connection lost" or a failed download
(Retry reloads) doesn't join by itself.

---

## Order and dependencies

1. 0.1 → 0.2 → Phase 1 → 2.1 / 2.3 (no plugins, fastest gain)
2. 0.3 spike, then Phase 3 (bots) if it's a go
3. Phase 5 and 6.1 (client only, can run in parallel with 2)
4. 6.2 (needs a new `cs16-client` build)
5. 4.3 → 2.2, then the rest of Phase 4
6. Phase 7, then Phase 8

## Out of scope

- Steam accounts or verified identities.
- Custom skins, models or sounds that need clients to download new files.
- Several servers or a server browser.
