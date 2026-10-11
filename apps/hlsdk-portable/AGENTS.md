# Half-Life game code (`apps/hlsdk-portable`)

The Half-Life game client and server library the page loads for "Play Half-Life" (single player in the browser), compiled to WebAssembly with Emscripten from [FWGS/hlsdk-portable](https://github.com/FWGS/hlsdk-portable). Unlike `apps/cs16-client`, the source isn't kept here: the Dockerfile `hlsdk-portable` stage fetches the commit pinned in `HLSDK_COMMIT` and applies `patches/`. Read the root guide first.

| Path | Tracked | What it is |
|---|---|---|
| `patches/emscripten-side-modules.patch` | yes | Builds `client` and `hl` as Emscripten side modules (`-sSIDE_MODULE=1`, `.wasm`) instead of shared libraries, which CMake can't make for Emscripten, and skips `strip` |
| `package.json` | yes | The `hlsdk-portable` package `apps/client` imports the `.wasm` files from |
| `dist/` | no | `cl_dll/client_emscripten_wasm32.wasm`, `dlls/hl_emscripten_wasm32.so` from the last build |

The npm package of the same name that the engine's README points to was unpublished in September 2026, so we build it ourselves. The engine (`apps/client/vendor/xash3d-fwgs-1.0.0.tgz`) preloads the server library as `dlls/hl_emscripten_wasm32.so`, the name it opens for `-game valve`; keep that file name. The main menu is the engine package's generic one, not a build from here.

`HLSDK_COMMIT` is from August 2025, close to the engine the page ships (`xash3d-fwgs 1.0.0+commit.eeca965`, build 3773; the server's engine commit from the same fork is from July 2025). Don't move it past August 2026 without a newer engine: from then on the client links freevgui, whose `XashSurface` calls VGUI API entries (`SetPaintOffset`) this engine doesn't provide, and the game stops with `RuntimeError: null function` as soon as a map starts. At the pinned commit VGUI is off by default (`USE_VGUI`), so the client uses the engine's own HUD and menus.

## Known limitation: map changes that carry entities, and saves

The browser engine can't name the game library's functions: `COM_NameForFunction` (engine `platform/posix/lib_posix.c`) relies on `dladdr`, which returns no symbol name in an Emscripten build, and the offset fallback (`XASH_ALLOW_SAVERESTORE_OFFSETS`) is only enabled for static builds. When a level change carries entities whose think/touch/use functions are set, the engine logs `Error: Invalid function pointer in entity!` and those entities stop working on the next map. In a browser test the opening tram ride crossed `c0a0 → c0a0a → c0a0b` fine and stalled after `c0a0b → c0a0c`. Saving the game goes through the same code. Fixing it means rebuilding the browser engine (it ships prebuilt in `apps/client/vendor/xash3d-fwgs-1.0.0.tgz`) with a name lookup for Emscripten or with that fallback enabled; nothing in this folder can work around it.

## Build

```sh
# in apps/client
npm run build:hlsdk-portable   # docker build -f apps/server/Dockerfile --target hlsdk-portable-dist --output apps/hlsdk-portable/dist .
npm install                    # links the package into node_modules
```

The Docker image builds this stage itself. The emsdk image is amd64-only. No host toolchain exists.

## Rules

- Move upstream by changing `HLSDK_COMMIT` in the Dockerfile and keeping its comment; check the patch still applies.
- Keep the patch to build settings. Game code changes would need a different layout (a vendored tree, like `apps/cs16-client`).
- The code is under Valve's Half Life 1 SDK license (non-commercial, see upstream `LICENSE`), as is ReGameDLL in `apps/cs16-client`.
- Game files come from the same zip as Counter-Strike (`apps/client/src/gamefiles.ts`, its `valve/` folder); nothing here is a game asset.

## Verify

1. `npm run build:hlsdk-portable` (in `apps/client`), then check the exports the engine looks up: the client's `Initialize`, `HUD_Redraw`, `CL_CreateMove`; the server's `GiveFnptrsToDll`, `GetEntityAPI2` and entity names such as `worldspawn` and `monster_scientist` (`WebAssembly.Module.exports` in Node lists them).
2. `make build-local-image`, `make run`, press "Play Half-Life" on the login page, start a New Game and watch the tram ride. To read the engine's own log (map changes, errors), start the engine with `-dev 2` added to its arguments in `apps/client/src/engine.ts` for the test only; it prints to the browser console. Report what was seen.
3. The game-files zip's storage sends no CORS headers for a local origin, so a browser on `127.0.0.1` can't download it; serve the same file from a local server with `Access-Control-Allow-Origin` (for example through a Playwright route) when testing locally. This affects Counter-Strike the same way.
