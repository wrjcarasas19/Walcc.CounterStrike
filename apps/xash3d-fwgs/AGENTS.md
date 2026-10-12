# Browser engine (`apps/xash3d-fwgs`)

The `xash3d-fwgs` package the page imports (`apps/client/src/engine.ts`, `webrtc.ts`): the Xash3D FWGS engine, its filesystem, renderers and generic main menu compiled to WebAssembly with Emscripten, plus the TypeScript wrapper (`Xash3D`, `Net`) around them. It comes from [yohimik/webxash3d-fwgs](https://github.com/yohimik/webxash3d-fwgs) (`packages/xash3d-fwgs`), npm `xash3d-fwgs` 1.0.0, which the page used to ship as a vendored tgz. The engine source isn't kept here: the Dockerfile `xash3d-fwgs-wasm` stage fetches the commit pinned in `XASH3D_WEB_COMMIT` and applies `patches/`; the `xash3d-fwgs` stage compiles the wrapper. Read the root guide first.

| Path | Tracked | What it is |
|---|---|---|
| `lib/` | yes | The TypeScript wrapper, upstream's `packages/xash3d-fwgs/lib` at npm 1.0.0's commit (`fedcda8`), unchanged; `lib/generated/xash.d.ts` types the engine glue |
| `scripts/patch-emscripten-js.mjs` | yes | Turns Emscripten's glue (`dist/raw.js`) into the ES module `lib/generated/xash.js`: ES export, start on demand, the `sendto`/`recvfrom` hooks `lib/net.ts` fills, and the object the wrapper reads (`Module`, `FS`, heaps, `addFunction`). Upstream's `.mts` as plain JavaScript; it fails if a replacement no longer matches |
| `patches/` | yes | Our changes to the engine source, applied in name order with `git apply` at the engine's root. `0001-emscripten-name-for-function.patch`: save/restore names for the game library's functions (see below) |
| `package.json`, `package-lock.json`, `tsconfig*.json` | yes | Package exports (same paths and file names as npm 1.0.0) and the pinned TypeScript that compiles `lib/` |
| `LICENSE.md` | yes | Upstream's MIT licence for the wrapper; the engine itself is GPL-3.0-or-later |
| `dist/` | no | `xash.wasm`, `raw.js`, `filesystem_stdio.wasm`, `libref_gles3compat.wasm`, `libref_soft.wasm`, `cl_dll/menu_emscripten_wasm32.wasm` and the compiled wrapper from the last build |

`XASH3D_WEB_COMMIT` is `4cbc288` of yohimik's engine fork, the submodule webxash3d-fwgs pinned for npm 1.0.0; its version suffix `commit.eeca965` is that fork's merge base with FWGS master. The fork went private; FWGS serves the commit through GitHub's fork network. It is a different branch from the server's engine (`XASH3D_COMMIT`, the fork's `go` branch): the two talk the same network protocol but are built separately.

## Function names for save/restore

Level changes and saved games store each entity's think/touch/use/blocked function by name: the game library (`apps/hlsdk-portable`, `dlls/util.cpp` `CSave::WriteFunction`) calls the engine's `pfnNameForFunction`/`pfnFunctionFromName` (`engine/server/sv_game.c`), which end in `COM_NameForFunction`/`COM_FunctionFromName` (`engine/platform/posix/lib_posix.c`). Upstream names a function with `dladdr`, which returns no symbol under Emscripten, so every carried entity lost its functions (`Error: Invalid function pointer in entity!`). The patch adds an `EM_JS` lookup for Emscripten: a function pointer is an index into the shared `wasmTable`, whose entry is the same JS function object as the side module's export, so it maps `wasmTable.get(ptr)` to an export name of the library `dlopen` returned (`LDSO.loadedLibsByHandle`, a Map built once per loaded library). The reverse needs no change: `dlsym` returns the table index the game library already uses (`getFunctionAddress`), so `m_pfnThink == &CBaseEntity::SUB_Remove` still holds after a restore. It depends on Emscripten's `libdylink.js` internals (`LDSO`, `wasmTable`); check it when moving emsdk. Only functions the game library exports can be named, as on Linux: hlsdk marks them `EXPORT`.

## Build

```sh
# in apps/client
npm run build:xash3d-fwgs   # docker build --platform=linux/amd64 -f apps/server/Dockerfile --target xash3d-fwgs-dist --output apps/xash3d-fwgs/dist .
npm install                 # links the package into node_modules
```

The Docker image builds these stages itself. The emsdk image is amd64-only, and the build fetches every engine submodule. No host toolchain exists.

## Rules

- Keep the export paths and file names in `package.json`: `apps/client/src/engine.ts` imports them, and the wrapper's defaults (`lib/constants.ts`) name them.
- Engine changes go in `patches/` as `git apply` patches against `XASH3D_WEB_COMMIT`; regenerate them when the commit moves. A comment in each patch says why.
- Keep `lib/` and the patch script as upstream wrote them (they aren't Prettier-formatted), so they diff cleanly against upstream; a change there must keep the wrapper API `apps/client` uses (`Xash3D`, `Xash3DOptions`, `Net`, `Packet`, `Cmd_ExecuteString`, `em.Module`, `em.FS`).
- Move upstream by changing `XASH3D_WEB_COMMIT` and its Dockerfile comment together, then check `apps/cs16-client` and `apps/hlsdk-portable` still load: their game libraries call engine APIs by table, so a newer engine can break them (see `apps/hlsdk-portable/AGENTS.md` on VGUI).
- `EMCC_CFLAGS` and the `waf` flags in the stage are upstream's; Emscripten link flags live in the engine's `engine/wscript`.

## Verify

1. `npm run build:xash3d-fwgs` (in `apps/client`), then compare `dist/` with the previous build: the same file list, and for an engine change the `WebAssembly.Module.exports`/`imports` of `xash.wasm` in Node (only what the change adds should differ).
2. In `apps/client`: `npm install`, `npx tsc -p tsconfig.json`, `npm run build`.
3. `make build-local-image`, `make run`, join a Counter-Strike game and start "Play Half-Life" in a browser; see `apps/hlsdk-portable/AGENTS.md` "Verify" for the engine log and the local CORS workaround.
