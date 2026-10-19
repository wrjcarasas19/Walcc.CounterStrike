# cs16-client (browser build)

The game client, main menu and server DLL the page loads, compiled to
WebAssembly with Emscripten. `source/` is
[Velaron/cs16-client](https://github.com/Velaron/cs16-client) at
`08a2f2df` with this project's changes (the HTML HUD bridge) applied; edit it
here like the rest of the repo.

| Path                       | What it is                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `source/`                  | The client source, without its `3rdparty/` dependencies                                       |
| `3rdparty.txt`             | Those dependencies (upstream's git submodules), pinned by commit                              |
| `patches/mainui_cpp.patch` | Our change to `3rdparty/mainui_cpp` (the `menu` event), applied after it is fetched           |
| `package.json`             | The `cs16-client` package `apps/client` imports the `.wasm` files from (`dist/`)               |
| `dist/`                    | Build output, not in git: `cl_dll/client_*.wasm`, `cl_dll/menu_*.wasm`, `dlls/cs_*.so`        |

## Building

The Dockerfile's `cs16-client` stage fetches `3rdparty.txt`, applies the
patch, copies `source/` over it and builds the `client`, `menu` and `regamedll`
targets; the web client stage then uses the result, so `docker build -f apps/server/Dockerfile .`
needs nothing else. The `emscripten/emsdk:4.0.11` image is amd64-only: on Apple
Silicon it runs under emulation (a clean build takes about 5 minutes; Docker
caches it until something here changes).

For `npm run dev` or `npm run build` outside Docker, build `dist/` once (and
again after changing the source):

```sh
# in apps/client
npm run build:cs16-client   # docker build -f apps/server/Dockerfile --target cs16-client-dist --output apps/cs16-client/dist .
npm install                 # links apps/cs16-client as node_modules/cs16-client
```

To move a dependency, change its commit in `3rdparty.txt` (a commit GitHub
still serves for that URL). The upstream repo's `3rdparty/yapb` and
`3rdparty/cs16client-extras` are left out: the web build only packs them into
`extras.pk3`, which the page doesn't load.

## Where it came from

`github.com/yohimik/webxash3d-fwgs` and `github.com/yohimik/cs16-client`, the
original web port, now return 404. Its `packages/cs16-client` at monorepo
commit `9bde682` (public mirror
`https://github.com/daShao999/WebXash3D-Fwgs-yohimik`) pinned the
cs16-client submodule to `08a2f2df` ("feat: min"), which only adds
`-Oz --closure 1 --minify-wasm-imports` to the client link flags on top of
`6a9023cf`. Both are still served through the GitHub fork network of
`Velaron/cs16-client`. Until this folder existed the build output was
committed as `vendor/cs16-client-<version>.tgz` (0.0.2 to 0.0.10), built from
that checkout plus `patches/cs16-client/*.patch`; git history has both. To see
our changes against upstream, check out `08a2f2df` and compare it with
`source/`.

## Our changes

All of them are in `source/cl_dll` unless noted. `web_bridge.h` documents the
event contract: each event calls `Module.hudEvent(type, payload)` on the page.

- **HTML HUD** (`web_bridge.{h,cpp}`): cvar `hud_html` (default `1` and locked
  on in the Emscripten build; `0` elsewhere) hides the stock health, armour,
  money, ammo, round clock, death notices, scoreboard and chat, and the Health,
  Battery, ArmorType, Money, CurWeapon, AmmoX, WeaponList, RoundTime,
  BombDrop, DeathMsg, ResetHUD and InitHUD handlers send their values to the
  page. `CHud::Redraw` calls the bridge once a frame.
- **Scoreboard**: `scoreboard { visible }` and `scores` (a JSON snapshot on open
  and every 0.5 s while visible, or always with `hud_html_scores 1`, which the
  admin Players tab sets). Each player has `userid`, read from the engine's
  `player_info_t` through `IEngineStudio.PlayerInfo`.
- **Round and map end**: `round { winner, reason, message, ctScore, tScore }`
  from the HUD_PRINTCENTER titles, `intermission { active, map }`; `kill` has
  `killerUserid` / `victimUserid`.
- **Chat**: `chat { kind, slot, name, team, dead, teamOnly, location, text }`
  from SayText, plus `notice` and `radio` from TextMsg.
- **Server plugin events**: `WebBridge_Init` hooks the user messages `WcMode`
  (`apps/amxx/wc_gamemode.sma`) and `WcKillInfo` (`apps/amxx/wc_killinfo.sma`)
  by name and sends `mode` and `killinfo`.
- **Buy menu** (`menu.cpp`): with cvar `hud_html_buymenu 1` (the page sets
  it), a buy menu the server sends as a text menu (`ShowMenu` with a title
  key from `s_buyMenus`) goes to the page as `buymenu { open, menu, team,
  map }` and isn't drawn; the menu stays open in `CHudMenu`, so slot keys,
  `slot10` and the server's own close work as before, and every close sends
  `buymenu { open: false }`.
- **High-DPI screens** (`hud.cpp`, `CHud::VidInit`): the HUD's true screen
  size (`TrueWidth`/`TrueHeight`, used by the sniper scope and crosshair) comes
  from `PARM_SCREEN_WIDTH`/`HEIGHT`, the framebuffer the HUD draws in, instead
  of the `width`/`height` cvars, which hold the window size in CSS pixels.
  Upstream's cvars put the scope in the top-left corner whenever
  `devicePixelRatio` isn't 1.
- **Menu** (`patches/mainui_cpp.patch`, `BaseMenu.cpp`): `menu { visible }`
  when the main menu opens or closes, so the page hides its HUD under it.

Checking that the bridge made it into the client: each EM_JS function is an
import `env.js_hud_<event>` that `--minify-wasm-imports` doesn't rename.

```sh
strings dist/cl_dll/client_emscripten_wasm32.wasm | grep -c hudEvent   # 16
```

Keep EM_JS parameter lists unpadded (`(int a, int b)`, not `( int a, int b )`):
the side-module loader takes the last space-separated word of each parameter
as the JS argument name, so a trailing space gives an empty name.
