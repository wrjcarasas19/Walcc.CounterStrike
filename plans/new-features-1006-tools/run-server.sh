#!/bin/bash
# Starts the image as the web server for the headless checks, on the host
# ports the page uses (27016 HTTP, 27018 WebRTC), and waits for /status.json.
# usage: run-server.sh [map] [bots]   env: NAME (default cs16-headless),
#        IMAGE (default local/cs16-web-server:latest), ADMIN_PASSWORD,
#        DATA_VOLUME (a docker volume for DATA_DIR, /xashds/data, so the
#        leaderboard, claims and bans survive a new container),
#        LEADERBOARD_BOTS (1: bots on the leaderboard and in /duel).
set -eu
NAME=${NAME:-cs16-headless}
IMAGE=${IMAGE:-local/cs16-web-server:latest}
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --platform linux/386 \
	-e IP=127.0.0.1 -e PORT=27018 \
	-e ADMIN_PASSWORD="${ADMIN_PASSWORD:-headless-admin}" -e BOT_QUOTA="${2:-4}" \
	-p 27016:27016 -p 27018:27018/tcp -p 27018:27018/udp \
	${DATA_VOLUME:+-v "$DATA_VOLUME:/xashds/data"} \
	${LEADERBOARD_BOTS:+-e LEADERBOARD_BOTS="$LEADERBOARD_BOTS"} \
	"$IMAGE" "+map ${1:-de_dust2}" +maxplayers 14 >/dev/null
for _ in $(seq 1 60); do
	curl -sf http://127.0.0.1:27016/status.json >/dev/null && { echo "$NAME up"; exit 0; }
	sleep 1
done
echo "$NAME didn't answer /status.json" >&2
docker logs --tail 30 "$NAME" >&2
exit 1
