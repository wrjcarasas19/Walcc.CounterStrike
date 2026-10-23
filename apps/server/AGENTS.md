# Go server (`apps/server`)

Package `main` at the root of this folder (its own `go.mod`), built as `/xashds/xash` in the image. It links the Xash3D FWGS engine through `github.com/yohimik/goxash3d-fwgs` (cgo, 32-bit) and runs the dedicated server in-process (`main.go` calls `HostMain`), while serving HTTP on `:27016` (`runSFU` in `sfu.go`). Read the root guide first.

This folder also holds the image the whole repository builds: `Dockerfile` (build context: the repository root), `configs/` (copied into the image's `cstrike/` and `valve/`: `server.cfg`, map cycle, Metamod/AMXX/YaPB config, bot graphs, per-prefix map configs), `patches/engine/` (applied to the pinned engine source in the `engine` stage) and `player-models/` (Python tools run in the `player-models-converted` stage that put a Mixamo-rigged glTF character on a stock player model and render the team menu pictures from the player models, and the source of the Palpatine model with its credits).

## Files

| File | Role |
|---|---|
| `main.go` | Reads the environment, decides admin and rcon mode, opens `DATA_DIR`, starts the leaderboard follower and the SFU, hands the engine its arguments |
| `game.go` | The engine's game folder from `-game` (`cstrike` from the ENTRYPOINT, `valve` for the `hl-web-server` compose service). Under anything but `cstrike` the admin API, leaderboard, `/duel`, `/names/*` and `BOT_QUOTA` are off; `/status.json` reports the folder as `game` |
| `sfu.go`, `recv.go`, `drop.go`, `fsa.go` | `/websocket` signalling, pion WebRTC peers, data channel to and from the engine's packet queues, per-address limits, the engine's `sendto` and `recvfrom` callbacks, slot table |
| `static.go` | Serves `public/` (the Vite build): gzip from memory, immutable caching under `/assets/`, `.webm` and `.mp3` MIME types |
| `admin.go`, `admin_*.go`, `console.go`, `rcon.go` | `/admin/login`, `/admin/logout`, `/admin/session`, `/admin/command`: session cookie, lockout, allowed actions per tab, rcon to the engine |
| `status.go` | `/status.json` from the engine's A2S queries, without rcon |
| `maps.go` | `/maps/index.json` and `/maps/files/` from `cstrike/maps/*.res` |
| `bans.go` | `bans.json`: IPv4 address or IPv6 /64, checked on every WebSocket |
| `bots.go` | `BOT_QUOTA` written into `yapb.cfg` at startup |
| `statsdb.go`, `statslog.go`, `statsfollow.go` | SQLite leaderboard built from the engine's log files, with migrations and claimed-name enforcement |
| `leaderboard.go`, `duel.go`, `names.go` | `/leaderboard`, `/duel`, `/names/*` |

Environment: `IP`, `PORT`, `ADMIN_PASSWORD`, `RCON_PASSWORD`, `BOT_QUOTA`, `LEADERBOARD_BOTS`, `DATA_DIR`, `XASH3D_BASEDIR`. Their rules and fallbacks are in `main.go` and the README's table; keep both in step.

## Build and test

- The package only compiles inside the Dockerfile `go` stage (it needs `libxash.a` from the `engine` stage and a 32-bit toolchain). Run the tests there:

  ```sh
  # from the repository root
  docker build --platform=linux/amd64 -f apps/server/Dockerfile --target go -t local/cs16-go-test .
  docker run --rm local/cs16-go-test go test ./
  ```

  Rebuild the image after every source change; the stage copies this folder's `*.go` files in.
- Tests use `httptest`, fakes such as `fakeConsole`, and temporary directories; none starts the engine. Put a test next to every handler or parser change.
- The Dockerfile appends a `replace` for goxash3d-fwgs to `go.mod` at build time. Do not commit that `replace`, and keep `go.mod` and `go.sum` tidy.
- Format with `gofmt`.

- `player-models/`: there is no Python on this machine's path with numpy and Pillow; run the tools in a `debian:bookworm-slim` container with `python3-numpy python3-pil` (what the stage installs). `preview.py <model.mdl> <out.png>` renders the reference pose and a few animation frames, which is quicker than building the image to see a model. `gltf2mdl.py` reads the result back and fails the build if it is incomplete.

## Contracts with other parts

- JSON shapes and status codes of `/status.json` (its `game` field picks what the page joins as, `apps/client/src/servergame.ts`), `/leaderboard`, `/duel`, `/names/*`, `/maps/index.json` and `/admin/*` are consumed by `apps/client`. Change both sides in the same commit.
- The log lines `statsfollow.go` parses (`killed`, `wc_headshot`, `wc_gg_win`, `changed name to`, `connected, address`) are written by the engine and by `apps/amxx`. A format change touches the plugin, this parser and its tests.
- `.res` files and the files `/maps/files/` may serve are produced by the Dockerfile `maps` stage; the allowed extensions are listed in `maps.go`.
- Leaderboard schema changes are numbered migrations in `statsdb.go`. Totals, duels and read offsets are updated in one transaction; keep that invariant.

## Logging and security

- Write plain lines: the pion logger `log` in `sfu.go` (`log.Errorf`, `log.Warnf`) or `fmt.Fprintf(os.Stderr, "<subsystem>: ...")` with the existing prefixes (`admin:`, `names:`, `leaderboard:`, `duel:`). No JSON, no trace IDs.
- Never log or return `ADMIN_PASSWORD`, `RCON_PASSWORD`, session cookies, device tokens or recovery codes. Only SHA-256 hashes of tokens and codes are stored.
- Addresses are the connection's own; `X-Forwarded-For` is ignored on purpose. Bans, the login lockout and the per-address connection limit depend on that.
- With `ADMIN_PASSWORD` set, players' rcon is blocked and the server uses a random rcon password of its own. Keep the admin API off when the password is invalid.
- The rcon password is a single plain token passed as an engine argument (`rcon.go`); keep its validation when touching engine arguments.
