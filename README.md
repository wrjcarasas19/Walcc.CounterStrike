# Counter-Strike 1.6 Web Server <img alt="Counter-Strike 1.6 icon" align="right" width="128" height="128" src="./src/client/public/apple-touch-icon.png" />

This repository provides a **plug-and-play Docker image** for running a fully functional **Counter-Strike 1.6** client and dedicated server via the web. Powered by **Xash3D FWGS**, **WebRTC**, and modern web tooling, this setup allows for in-browser gameplay and remote multiplayer support.

## 🏆 Features

- ✅ Web-based CS 1.6 client (HTML + TypeScript + Vite)
- ✅ Dedicated CS 1.6 server (Go + CGO + Xash3D FWGS)
- ✅ WebRTC support for browser-to-server networking
- ✅ Metamod-R, AMX Mod X and YaPB bots included
- ✅ Invite links: Settings (F3, or the Settings button on the login page) → "Copy invite link"; opening `/?join=1` loads the game and joins with the saved nickname (or asks for one first)
- ✅ Dockerized & easy to deploy
- ✅ i386 (32-bit) architecture support

## 🙏 Acknowledgements

Special thanks to **[yohimik](https://github.com/yohimik)** for his outstanding work on the [Xash3D-FWGS Emscripten Web Port](https://github.com/yohimik/webxash3d-fwgs) and the [Xash3D-FWGS CGO Wrapper](https://github.com/yohimik/goxash3d-fwgs), which made this possible!

## 🚀 Getting Started

### docker compose (recommended)

```yaml
---
services:
  cs16-web-server:
    image: ghcr.io/balintsoos/cs16-web-server:latest
    container_name: cs16-web-server
    command: ["+map de_dust2", "+maxplayers 14"]
    restart: always
    platform: linux/386
    environment:
      IP: 127.0.0.1
      PORT: 27018
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:-}
      RCON_PASSWORD: ${RCON_PASSWORD:-}
      BOT_QUOTA: ${BOT_QUOTA:-0}
      LEADERBOARD_BOTS: ${LEADERBOARD_BOTS:-0}
    volumes:
      - cs16-data:/xashds/data
    ports:
      - "27016:27016"
      - "27018:27018/tcp"
      - "27018:27018/udp"

volumes:
  cs16-data:
```

### docker cli

```shell
docker run -d \
  -name=cs16-web-server \
  -e IP=127.0.0.1 \
  -e PORT=27018 \
  -e ADMIN_PASSWORD \
  -e BOT_QUOTA=6 \
  -v cs16-data:/xashds/data \
  -p 27016:27016 \
  -p 27018:27018/tcp \
  -p 27018:27018/udp \
  --platform linux/386 \
  --restart always \
  ghcr.io/balintsoos/cs16-web-server:latest \
  +map de_dust2 +maxplayers 14
```

Then open http://127.0.0.1:27016 in your browser!

## 🌍 Environment Variables

| Variable           | Description                                                                                                                                    | Example            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `IP`               | Server IP address for WebRTC connection                                                                                                        | `123.45.67.89`     |
| `PORT`             | UDP port for CS server (must be open)                                                                                                          | `27018`            |
| `ADMIN_PASSWORD`   | Login for the F4 admin menu (admin API), at least 8 characters; unset: the menu uses `RCON_PASSWORD`                                           | `long-pass-phrase` |
| `RCON_PASSWORD`    | rcon password, only needed without `ADMIN_PASSWORD`; unset disables rcon. Letters, digits and `_.~!@#%^*=+,:?-`, ≤ 64                          | `Xk9_m2.Lq7`       |
| `BOT_QUOTA`        | Players (humans + YaPB bots) to keep in the game, 0–32; bots leave as humans join. Default `0` (no bots)                                       | `6`                |
| `DATA_DIR`         | Directory of the ban list (`bans.json`) and the leaderboard (`leaderboard.db`); default `data` in the working dir, `/xashds/data` in the image | `/xashds/data`     |
| `LEADERBOARD_BOTS` | `1` lists YaPB bots on the leaderboard too; default `0` (bots get no row, but kills on them and deaths by them count)                          | `1`                |

With docker compose, put the passwords in a `.env` file next to
`docker-compose.yml` (ignored by git; see `.env.example`). Never set them in
`server.cfg`, which is part of the image.

With `ADMIN_PASSWORD` set, the F4 menu logs in to the server's admin API
(`/admin/*`) and the server runs the commands itself; the browser never
sees the rcon password, and rcon requests from players are dropped. If
`RCON_PASSWORD` isn't set too, the server makes up a random one for its own
use. The login is a session cookie that lasts 8 hours or until the server
restarts. Five wrong passwords from one address lock that address out of
the login for 5 minutes. The server counts the address the connection
comes from and doesn't trust `X-Forwarded-For`, so behind a reverse proxy
everybody shares the proxy's address (and its lockout). The server itself
only speaks plain HTTP: put it behind HTTPS if the password must not cross
the network in the clear (rcon from the game is encrypted by WebRTC).

`BOT_QUOTA` fills the server with bots (YaPB `yb_quota_mode fill`): with
`BOT_QUOTA=6`, an empty server has 6 bots and a single player joining
finds 5. Spectators don't count. An invalid value logs a warning and
means 0. It is only the starting value: the Bots tab of the F4 menu ("Fill
to N", add/kick) changes it at runtime, and that change is kept over map
changes until the server restarts.

Bans: with `ADMIN_PASSWORD` set, the Players tab of the F4 menu has a Ban
button next to Kick. It kicks the player and bans the address their
connection came from (IPv4: that address; IPv6: its whole /64), and lists
the banned addresses with an Unban button. A banned address can't connect
(the game's WebSocket gets 403), and every connection from it is closed
when the ban is made. Like the login lockout, the address is the one the
connection comes from, not `X-Forwarded-For`: behind a reverse proxy every
player has the proxy's address, so the server refuses to ban an address
that is the admin's own. Bans are saved in `bans.json` in `DATA_DIR`; mount
a volume there (the compose file above does) to keep them across
restarts. Without `ADMIN_PASSWORD` (rcon only) there is no Ban button, but
a saved ban list still applies. The engine's own `banid` / `addip` don't
work here: the engine only sees made-up addresses for WebRTC players.

Lobby status: `GET /status.json` returns the current map, the player count
and max players, each player's name and score (bots marked), the time left
and the next map (the last two need AMX Mod X). The login page shows it as
"de_dust2 · 5/16 players" with the names, refreshed every 5 seconds.
**Player names are public:** anyone who opens the page (or the endpoint)
sees who is playing, as in any server browser. The server reads it with
the engine's own server queries (A2S_INFO / PLAYER / RULES, no rcon), so it
works with or without `ADMIN_PASSWORD`; answers are cached for 2 seconds
and each address may ask 5 times a second (bursts of 20; behind a reverse
proxy everyone shares the proxy's address). Setting `sv_password` or
`sv_expose_player_list 0` hides the names but not the count.

Leaderboard: `GET /leaderboard` returns the top 20 players by kills since
the leaderboard was started, with deaths, K/D, headshot % and rounds
played; the login page shows it as a "Top players" section. **Names aren't
verified:** totals are kept per player name, and anyone can join under any
name and add to (or spoil) its totals; a rename starts a new row. The
server turns on the game's logging (`log on`, one `cstrike/logs/L*.log` per
map, inside the container) and reads the kill, team and round lines as
they are written; the totals, and how far each log file was read, are
saved in `leaderboard.db` (SQLite) in `DATA_DIR`, so mount a volume there
(the compose file does) to keep them. A restart neither counts a line
twice nor skips one. Kills count like the scoreboard's session stats:
enemy kills only; teamkills and suicides count as deaths. Headshots come
from our `wc_statslog.amxx` plugin (stock CS 1.6 doesn't log them). Bots
get no row unless `LEADERBOARD_BOTS=1`. Only the 20 newest log files are
kept (older ones are deleted once read); the logs also contain every rcon
command, including the rcon password, so don't publish them. Answers are
cached for 5 seconds and rate limited like `/status.json`. If the database
can't be opened, the server logs a warning, doesn't turn logging on and
`/leaderboard` answers 404. To start over, stop the server and delete
`leaderboard.db`.

## ⚙️ Customization

Client UI/UX:

- Modify files in src/client

Plugins included in the image (pinned versions with checksums in the
`Dockerfile`):

| Plugin    | Version        | Notes                                                                                     |
| --------- | -------------- | ----------------------------------------------------------------------------------------- |
| Metamod-R | 1.3.0.149      | Loaded through `liblist.gam`; plugin list in `configs/cstrike/addons/metamod/plugins.ini` |
| AMX Mod X | 1.10.0-git5486 | Base + cstrike packages; `adminslots.amxx` is off (it errors on Xash3D)                   |
| YaPB      | 4.4.957        | Bots; `yb_quota` defaults to 0, so add them with `yb add` / `yb_quota <n>`                |

The server console and rcon run `amx_*`, `meta` and `yb` commands. On
Xash3D, cvars that AMX Mod X marks as single-player-only (like
`amx_nextmap`) can't be set from the console; use
`amx_cvar amx_nextmap <map>`.

Our own AMX Mod X plugins are in `src/amxx/`. The Docker build compiles
every `.sma` there with the AMX Mod X compiler (`amxx-plugins` stage); add
each new one to the `plugins.ini` line in the `hlds` stage:

| Plugin               | Cvar                                            | Notes                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wc_weaponmode.amxx` | `wc_weaponmode 0\|1\|2` (off / knife / pistols) | Knife only or pistols only; C4, armour, defuse kit and night vision stay allowed, grenades and the shield don't. Blocks buys and pickups and strips other weapons. Kept over `sv_restart`, set back to 0 on every map change. Match tab presets. `wc_weaponmode_status` lists each player's weapons. |
| `wc_statslog.amxx`   | none                                            | Logs `"Killer<..>" triggered "wc_headshot" against "Victim<..>" with "weapon"` for every headshot kill, for the leaderboard (stock CS 1.6 logs kills without saying headshot).                                                                                                                       |

AMX Mod X logs (`log_amx`) are in `cstrike/addons/amxmodx/logs`; the
game's own logs (read by the leaderboard) are in `cstrike/logs`.

Custom plugins:

- Mount a volume to /xashds inside the container
- Or copy plugin files into the Docker build context

## 🛠️ Development

### Build Docker image:

```shell
docker build --platform=linux/386 -t cs16-web-server .
```

### Install client dependencies, build and serve client:

```shell
nvm install
npm install
npm run build
npm run serve
```

### Install server dependencies:

```shell
goenv install
go mod download
```

## 📜 License

This project is licensed under the MIT License.
See the [LICENSE](./LICENSE) file for more information.

Counter-Strike and all related trademarks, logos, and intellectual property are the property of Valve Corporation. This project is not affiliated with or endorsed by Valve Corporation.
