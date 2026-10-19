# Game client (`apps/cs16-client`)

The game client, main menu and ReGameDLL the page loads, compiled to WebAssembly with Emscripten. `source/` is Velaron/cs16-client at commit `08a2f2df` with our changes applied in place. `README.md` here explains the layout, the build, where the code came from and every change we made; read it before touching anything, then the root guide.

| Path | Tracked | What it is |
|---|---|---|
| `source/` | yes | The client source without its `3rdparty/` dependencies |
| `3rdparty.txt` | yes | Those dependencies, pinned by commit; fetched in the Dockerfile `cs16-client` stage |
| `patches/mainui_cpp.patch` | yes | Our change to the menu library (`menu` event), applied after fetching |
| `package.json` | yes | The `cs16-client` package `apps/client` imports the `.wasm` files from; its `version` gates page features |
| `dist/` | no | `cl_dll/client_*.wasm`, `cl_dll/menu_*.wasm`, `dlls/cs_*.so` from the last build |

## Build

```sh
# in apps/client
npm run build:cs16-client   # docker build -f apps/server/Dockerfile --target cs16-client-dist --output apps/cs16-client/dist .
npm install                 # links the package into node_modules
```

The Docker image (`apps/server/Dockerfile`) builds this stage itself; the command above is for `npm run dev` or `npm run build` outside Docker. The emsdk image is amd64-only; a clean build takes about five minutes under emulation on Apple Silicon and is cached until something here changes. No host toolchain exists.

## Rules

- Our changes live in `source/cl_dll/web_bridge.{h,cpp}` and small hooks in the HUD message handlers; the README lists them. Keep additions small and in the same style so a diff against upstream `08a2f2df` stays readable. Leave upstream folders the web build does not use (`android/`, `toolchains/`, …) untouched.
- `web_bridge.h` is the event contract: every event calls `Module.hudEvent(type, payload)` on the page. Adding or changing an event means updating `apps/client`, bumping `package.json`'s `version`, and gating the page on it (`versionAtLeast`), because returning players run a cached older client.
- Server messages `WcMode` and `WcKillInfo` are hooked by name; their field order is defined in `apps/amxx`. Change the plugin, this bridge and the page together.
- Keep `EM_JS` parameter lists unpadded (`(int a, int b)`): the side-module loader takes the last word of each parameter as the JS argument name.
- To move a dependency, change its commit in `3rdparty.txt` to one GitHub still serves for that URL; do not vendor the folder.
- `hud_html` is locked on in the Emscripten build; stock HUD elements hidden by it must stay hidden.

## Verify

1. `npm run build:cs16-client` (in `apps/client`), then confirm the bridge survived minification: `strings dist/cl_dll/client_emscripten_wasm32.wasm | grep -c hudEvent` prints the number of events (16 at the last count; adjust with the contract).
2. `npm run build` (in `apps/client`) for the page, or `make build-local-image` for the whole image.
3. `make run`, join a game in a browser and check the changed event reaches the HTML HUD (the page's HUD, kill card or mode strip). Report what was seen.
