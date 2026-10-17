# Counter-Strike 1.6 web server

One Docker image runs a Counter-Strike 1.6 dedicated server (Xash3D FWGS, 32-bit) and serves the browser page that plays on it over WebRTC. The page can also run Half-Life single player entirely in the browser (proof of concept, no server involved). The global engineering defaults apply everywhere; this file adds repository facts and the few places this repository differs. Each part lives in its own folder under `apps/` with its own guide; read the guide of every app you change before changing it.

## Apps

| Path | Guide | What it is |
|---|---|---|
| `apps/server/` | [apps/server/AGENTS.md](apps/server/AGENTS.md) | Go program that links the engine (cgo) and serves HTTP on 27016: the page, `/websocket` signalling, the WebRTC SFU, admin API, leaderboard, claimed names, map files. Also holds the image: `Dockerfile`, `configs/` (copied into the image's `cstrike/` and `valve/`) and `patches/engine/` |
| `apps/client/` | [apps/client/AGENTS.md](apps/client/AGENTS.md) | The page (TypeScript + Vite, no framework): login and lobby, HTML HUD, F3 settings, F4 admin menu, announcer, "Killed by" card. Holds `package.json` |
| `apps/cs16-client/` | [apps/cs16-client/AGENTS.md](apps/cs16-client/AGENTS.md) | The game client, main menu and ReGameDLL compiled to wasm with Emscripten: upstream Velaron/cs16-client plus our HTML HUD bridge |
| `apps/hlsdk-portable/` | [apps/hlsdk-portable/AGENTS.md](apps/hlsdk-portable/AGENTS.md) | The Half-Life game client and server library compiled to wasm for "Play Half-Life": upstream FWGS/hlsdk-portable fetched at a pinned commit, plus a build patch |
| `apps/xash3d-fwgs/` | [apps/xash3d-fwgs/AGENTS.md](apps/xash3d-fwgs/AGENTS.md) | The browser engine package `xash3d-fwgs` the page imports: Xash3D FWGS (yohimik's web fork) compiled to wasm at a pinned commit plus `patches/`, and the TypeScript wrapper from yohimik/webxash3d-fwgs |
| `apps/amxx/` | [apps/amxx/AGENTS.md](apps/amxx/AGENTS.md) | Our AMX Mod X plugins (`wc_*.sma`): game modes, weapon modes, extra log lines, kill info |

The six apps build into one image: `apps/server/Dockerfile` is built with the repository root as context. The root `docker-compose.yml` runs it as `cs16-web-server` (Counter-Strike) and, only with `--profile hl`, as `hl-web-server` (Half-Life deathmatch for the local network, `-game valve`, ports 27026 and 27028, address `LAN_IP` from `.env`). There is no `deploy/bundles.yml` and no app registry beyond this table. `README.md` is the user manual (features, environment variables, plugin and map tables, customization); update it in the same change when behaviour it describes changes.

## Build and run

- Docker is required for everything except editing the page: the engine, the Go server, the AMXX compiler and the Emscripten build run only as Dockerfile stages. `go` is not installed on this machine; Node is (`apps/client/.nvmrc`: 24). Run `npm` inside `apps/client`.
- Run `docker build` from the repository root with `-f apps/server/Dockerfile`. Build with an explicit platform. `make build-local-image` builds `linux/386` (what the image runs as); `docker-compose.yml` and the workflow build `linux/amd64`. On Apple Silicon a build without `--platform` targets arm64 and fails at `gcc-multilib`.
- `make run` is `docker compose up -d`: container `cs16-web-server`, labels `project: cs` and `app: server`, host path `/var/data/cs` mounted on `/xashds/data`, and the external network `proxy`. Create the network once with `docker network create proxy`. Then open http://127.0.0.1:27016.
- Passwords and bot settings come from `.env` next to the compose file (`.env.example`); never write them into `apps/server/configs/` or the Dockerfile.
- Ports: 27016 TCP carries the page, `/websocket` and every HTTP route; `PORT` (27018) TCP and UDP carries WebRTC, advertised at the address in `IP`; 27015/udp is the engine inside the container only. `hl-web-server` maps host 27026 to its 27016 and uses `PORT` 27028.
- Every upstream (engine commit, browser engine commit, goxash3d-fwgs, hlsdk-portable, HLDS build, Metamod, AMX Mod X, YaPB, ReGameDLL, community maps) is a Dockerfile `ARG` with a pinned commit or sha256. Change the version and its checksum together, and keep the comment that says where it comes from.
- The image runs as user `xashds`, with no health check and no image labels; the compose file supplies the labels. Keep it that way unless the task is about the container itself.

## Verify

| Changed | Check |
|---|---|
| `apps/server` (Go files) | `docker build --platform=linux/amd64 -f apps/server/Dockerfile --target go -t local/cs16-go-test . && docker run --rm local/cs16-go-test go test ./` |
| `apps/client` | In `apps/client`: `npx tsc -p tsconfig.json`, then `npm run build` (needs `apps/cs16-client/dist`, `apps/hlsdk-portable/dist` and `apps/xash3d-fwgs/dist`; see those guides) |
| `apps/cs16-client`, `apps/hlsdk-portable`, `apps/xash3d-fwgs`, `apps/amxx`, `apps/server/configs`, `apps/server/patches`, `apps/server/Dockerfile` | `make build-local-image`, `make run`, join a game in a browser, read `docker compose logs cs16-web-server` |
| `.github/workflows/deploy.yml` | Validate the YAML. There is no dry run: a push to `main` deploys |

A browser check needs the full image. `npm run dev` serves the page alone, with nothing behind `/websocket`, `/status.json`, `/leaderboard` or `/admin/`, so only pure page behaviour can be checked there. There is no Playwright setup; add it only when a task needs it.

## Logging and data

- The Go server and the engine write plain text lines to stdout and stderr; startup problems begin with `WARNING:`. `docker compose logs` is the only reader. Keep this format: do not add JSON events, trace IDs or a logging library to this repository.
- The engine's game log (`cstrike/logs/L*.log`) and the lines `apps/amxx` adds to it are parsed by the leaderboard follower in `apps/server`. Changing a line format means changing the parser and its tests in the same commit.
- `/xashds/data` holds `bans.json` and `leaderboard.db` (SQLite). A table change is a numbered migration in `apps/server/statsdb.go`; ask before a change that alters existing rows.
- Game files for the browser (about 480 MB) come from the URL in `apps/client/src/gamefiles.ts` and are cached in IndexedDB, keyed by that URL. A new zip needs a new URL.

## Deployment

- `.github/workflows/deploy.yml` runs on every push to `main`: it builds `ghcr.io/<owner>/cs16-web-server:<sha>` and `:latest`, then deploys to the staging VPS (GitHub Environment `staging-vps`, directory `/opt/apps/cs`) over SSH and waits for HTTP on 27016. Pushing to `main` is the deployment; there is no production environment and no promotion step.
- Rollback is `workflow_dispatch` with `skip_build` and an `image_tag` set to an earlier commit SHA.
- The deploy job rewrites `docker-compose.yml` with `yq` (drops `build`, sets the image, IP, port and a named volume, and gives `hl-web-server` the same image, ports, IP and network, since on the VPS it runs instead of Counter-Strike; it stays in profile `hl`, so the deploy's `up` doesn't start it, and the deploy removes it before `up`). Keep that file valid for both local use and the VPS, and keep the workflow's `yq` expression in step with its structure.
- Deployment variables and secrets live on the GitHub Environment, documented at the top of the workflow. Never commit them.

## Conventions

- Commit subjects are one short imperative sentence with no type prefix, for example `Lower the server's CPU use`.
- Prettier with single quotes for TypeScript (`.prettierrc`), `gofmt` for Go, tabs in the AMXX sources.
- Comments say why and name the file on the other side of a contract (`apps/server/maps.go`, `web_bridge.h`). Keep that habit when adding or moving one.
