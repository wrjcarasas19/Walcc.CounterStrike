# Web page (`apps/client`)

The browser side: TypeScript built by Vite, no framework. `index.html` holds the whole DOM, `src/style.css` the styles, and `src/*.ts` the behaviour. Vite's root is this folder, which also holds its config, `tsconfig.json`, `package.json`, `.nvmrc` and `vendor/xash3d-fwgs-1.0.0.tgz` (the engine's browser package); run `npm` here. The build lands in `dist/` and `apps/server/Dockerfile` copies it to `/xashds/public`, where `apps/server/static.go` serves it. Read the root guide first.

## Modules

| Module | Role |
|---|---|
| `main.ts` | Phases (idle, loading, connecting, in game) and the lifecycle: game files, engine, connect, reconnect, detach |
| `desktop.ts`, `modal.ts`, `lobby.ts`, `name-status.ts` | Login page, lobby from `/status.json`, modal windows, claimed-name status |
| `engine.ts`, `webrtc.ts`, `gamefiles.ts`, `maps.ts` | Creates `Xash3DWebRTC` from `xash3d-fwgs` for `cstrike` or `valve` (Half-Life, libraries from `hlsdk-portable`), `/websocket` signalling on the page's own host, the game-files zip cached in IndexedDB, maps and their files from `/maps/` |
| `hud.ts`, `rounds.ts`, `stats.ts`, `chat.ts`, `killcard.ts`, `killinfo.ts`, `gamemode.ts` | The HTML HUD, fed by `Module.hudEvent(type, payload)` from the game client |
| `announcer.ts`, `announcer-rules.ts` | Announcer sounds from `public/sounds` |
| `settings/` | `schema.ts` defines every setting (the panel is built from it); `store.ts` keeps them in `localStorage` under `player-settings` |
| `admin/` | F4 admin menu: `index.ts` lists the tabs, each tab is a module, `core.ts` has login and shared helpers, `presets.ts` the Match tab presets |
| `wheel/`, `invite/`, `names/`, `leaderboard.ts`, `player.ts` | Chat wheel, invite links (`/?join=1`), claimed names API, leaderboard window, saved nickname |

`vite.config.ts` imports `admin/presets`, `settings/schema` and `wheel/items` so their self-checks run at build time: an invalid preset, setting or chat line fails `npm run build`.

## Commands

```sh
npm run build:cs16-client   # once, and after changing apps/cs16-client (Docker)
npm run build:hlsdk-portable # once, and after changing apps/hlsdk-portable (Docker)
npm install
npm run dev                 # page only: no server behind it
npx tsc -p tsconfig.json    # strict type check; vite build does not run it
npm run build               # dist/
```

`npm run dev` cannot join a game: `/websocket`, `/status.json`, `/leaderboard`, `/admin/` and the map files exist only in the image. For anything that touches them, build the image (`make build-local-image`, `make run`) and open http://127.0.0.1:27016. There are no unit tests and no Playwright setup; `settings/schema.ts` is DOM-free so it could be tested with Node if a task adds a runner.

## Rules

- Game client events are the contract in `apps/cs16-client/source/cl_dll/web_bridge.h`. A new event needs the client change, a bump of `apps/cs16-client/package.json`, and a version gate here (`versionAtLeast`, `MODE_EVENT_CLIENT_VERSION` in `gamemode.ts`) so an older cached client degrades instead of breaking. `__CS16_CLIENT_VERSION__` comes from `vite.config.ts`.
- Server responses are defined in `apps/server`; change the handler, its test and the caller here together.
- Add a setting in `settings/schema.ts` and read it through `getSettings()` or `onSettingsChange()`; map it to an engine cvar in `CVARS` there. Engine commands built from settings go through the schema's safety check.
- Add an admin tab as a module exporting `AdminTab`, listed in `admin/index.ts`; the server's allowed actions must accept its commands.
- `public/sounds` holds generated announcer sounds; see its README before adding one. No third-party game audio.
- Keep the page working without `localStorage` and IndexedDB (private mode): every read and write is wrapped, and defaults apply.
- Logging stays off: nothing is sent to the server, and `console` is used only for failures. There is no debug flag to document.
- Voice chat is removed on purpose (`engine.ts` blocks the microphone and starts the engine with `+voice_enable 0`); do not reintroduce it without being asked.
- Prettier, single quotes.

## Half-Life

"Play Half-Life" (`playHalfLife` in `main.ts`) is single player: the engine runs the game's server itself from the same game-files zip (its `valve/` folder only), with the engine's generic main menu and HUD. None of the Counter-Strike parts run: no connection, nickname, lobby polling after start, HTML HUD, F3 settings, F4 admin or announcer. Saves live in the engine's in-memory filesystem and are lost when the page closes. Map changes that carry entities, and saves, are broken by the browser engine itself; see `apps/hlsdk-portable/AGENTS.md`.

## Browser check

Exercise the changed flow in the real image: login page, lobby, F3 settings, F4 admin (needs `ADMIN_PASSWORD` in `.env`), and in-game HUD after joining. A visual change gets a screenshot of the changed state. Chromium can join a game headless if the task needs an in-game screenshot; the first load downloads the game files (about 480 MB), cached afterwards.
