# Counter-Strike 1.6 web server

One Docker image runs a Counter-Strike 1.6 dedicated server (Xash3D FWGS, 32-bit) and serves the browser page that plays on it over WebRTC. The global engineering defaults apply everywhere; this file adds repository facts and the few places this repository differs. Read the guide of every part you change before changing it.

## Parts

| Path | Guide | What it is |
|---|---|---|
| `src/server/` | [src/server/AGENTS.md](src/server/AGENTS.md) | Go program that links the engine (cgo) and serves HTTP on 27016: the page, `/websocket` signalling, the WebRTC SFU, admin API, leaderboard, claimed names, map files |
| `src/client/` | [src/client/AGENTS.md](src/client/AGENTS.md) | The page (TypeScript + Vite, no framework): login and lobby, HTML HUD, F3 settings, F4 admin menu, announcer, "Killed by" card |
| `src/cs16-client/` | [src/cs16-client/AGENTS.md](src/cs16-client/AGENTS.md) | The game client, main menu and ReGameDLL compiled to wasm with Emscripten: upstream Velaron/cs16-client plus our HTML HUD bridge |
| `src/amxx/` | [src/amxx/AGENTS.md](src/amxx/AGENTS.md) | Our AMX Mod X plugins (`wc_*.sma`): game modes, weapon modes, extra log lines, kill info |
| `configs/` | this file | Files copied into the image's `cstrike/` and `valve/` folders: `server.cfg`, map cycle, Metamod/AMXX/YaPB config, bot graphs, per-prefix map configs |
| `patches/engine/` | this file | Patches applied to the pinned engine source in the Dockerfile `engine` stage |
| `vendor/` | this file | `xash3d-fwgs-1.0.0.tgz`, the engine's browser package the page imports (`package.json`) |

All of it is one app, one container and one image. There is no `deploy/bundles.yml`, no app registry and no second service. `README.md` is the user manual (features, environment variables, plugin and map tables, customization); update it in the same change when behaviour it describes changes.

## Build and run

- Docker is required for everything except editing the page: the engine, the Go server, the AMXX compiler and the Emscripten build run only as Dockerfile stages. `go` is not installed on this machine; Node is (`.nvmrc`: 24).
- Build with an explicit platform. `make build-local-image` builds `linux/386` (what the image runs as); `docker-compose.yml` and the workflow build `linux/amd64`. On Apple Silicon a build without `--platform` targets arm64 and fails at `gcc-multilib`.
- `make run` is `docker compose up -d`: container `cs16-web-server`, labels `project: cs` and `app: server`, host path `/var/data/cs` mounted on `/xashds/data`, and the external network `proxy`. Create the network once with `docker network create proxy`. Then open http://127.0.0.1:27016.
- Passwords and bot settings come from `.env` next to the compose file (`.env.example`); never write them into `configs/` or the Dockerfile.
- Ports: 27016 TCP carries the page, `/websocket` and every HTTP route; `PORT` (27018) TCP and UDP carries WebRTC, advertised at the address in `IP`; 27015/udp is the engine inside the container only.
- Every upstream (engine commit, goxash3d-fwgs, HLDS build, Metamod, AMX Mod X, YaPB, ReGameDLL, community maps) is a Dockerfile `ARG` with a pinned commit or sha256. Change the version and its checksum together, and keep the comment that says where it comes from.
- The image runs as user `xashds`, with no health check and no image labels; the compose file supplies the labels. Keep it that way unless the task is about the container itself.

## Verify

| Changed | Check |
|---|---|
| `src/server` | `docker build --platform=linux/amd64 --target go -t local/cs16-go-test . && docker run --rm local/cs16-go-test go test ./src/server/` |
| `src/client` | `npx tsc -p tsconfig.json`, then `npm run build` (needs `src/cs16-client/dist`; see that guide) |
| `src/cs16-client`, `src/amxx`, `configs`, `patches`, `Dockerfile` | `make build-local-image`, `make run`, join a game in a browser, read `docker compose logs cs16-web-server` |
| `.github/workflows/deploy.yml` | Validate the YAML. There is no dry run: a push to `main` deploys |

A browser check needs the full image. `npm run dev` serves the page alone, with nothing behind `/websocket`, `/status.json`, `/leaderboard` or `/admin/`, so only pure page behaviour can be checked there. There is no Playwright setup; add it only when a task needs it.

## Logging and data

- The Go server and the engine write plain text lines to stdout and stderr; startup problems begin with `WARNING:`. `docker compose logs` is the only reader. Keep this format: do not add JSON events, trace IDs or a logging library to this repository.
- The engine's game log (`cstrike/logs/L*.log`) and the lines `src/amxx` adds to it are parsed by the leaderboard follower in `src/server`. Changing a line format means changing the parser and its tests in the same commit.
- `/xashds/data` holds `bans.json` and `leaderboard.db` (SQLite). A table change is a numbered migration in `src/server/statsdb.go`; ask before a change that alters existing rows.
- Game files for the browser (about 480 MB) come from the URL in `src/client/src/gamefiles.ts` and are cached in IndexedDB, keyed by that URL. A new zip needs a new URL.

## Deployment

- `.github/workflows/deploy.yml` runs on every push to `main`: it builds `ghcr.io/<owner>/cs16-web-server:<sha>` and `:latest`, then deploys to the staging VPS (GitHub Environment `staging-vps`, directory `/opt/apps/cs`) over SSH and waits for HTTP on 27016. Pushing to `main` is the deployment; there is no production environment and no promotion step.
- Rollback is `workflow_dispatch` with `skip_build` and an `image_tag` set to an earlier commit SHA.
- The deploy job rewrites `docker-compose.yml` with `yq` (drops `build`, sets the image, IP, port and a named volume). Keep that file valid for both local use and the VPS, and keep the workflow's `yq` expression in step with its structure.
- Deployment variables and secrets live on the GitHub Environment, documented at the top of the workflow. Never commit them.

## Conventions

- Commit subjects are one short imperative sentence with no type prefix, for example `Lower the server's CPU use`.
- Prettier with single quotes for TypeScript (`.prettierrc`), `gofmt` for Go, tabs in the AMXX sources.
- Comments say why and name the file on the other side of a contract (`src/server/maps.go`, `web_bridge.h`). Keep that habit when adding or moving one.
