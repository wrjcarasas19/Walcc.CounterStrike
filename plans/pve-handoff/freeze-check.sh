#!/bin/sh
# Fresh container from image $1, one headless browser player, then up to 10 sv_restart, checking after each
# that the engine still answers "status" ("version" prints nothing on this console, so it can't be the probe).
# Usage: ./freeze-check.sh local/cs16-web-server:latest [linux/amd64|linux/386]
H=$(cd "$(dirname "$0")" && pwd)
pkill -TERM -f players.mjs; sleep 4
docker rm -f cs-p0 >/dev/null 2>&1
docker run -d -i --name cs-p0 --platform ${2:-linux/amd64} -e IP=127.0.0.1 -e PORT=27018 -e BOT_QUOTA=4 \
  -p 27016:27016 -p 27018:27018 -p 27018:27018/udp "$1" +map de_dust2 +maxplayers 14 >/dev/null
until docker logs cs-p0 2>&1 | grep -q "Connecting Bot"; do sleep 2; done; sleep 15
(cd "$H" && PROFILE=${PROFILE:-profile-fresh} nohup node players.mjs Alice > players.log 2>&1 &)
until grep -qE 'joined CT|join failed' "$H/players.log"; do sleep 3; done
grep -E "joined|failed" "$H/players.log" | cut -c1-80
sleep 10
for i in 1 2 3 4 5 6 7 8 9 10; do
  docker exec cs-p0 sh -c 'printf "sv_restart 1\n" > /proc/1/fd/0'; sleep 14
  r=$(WAIT=1 "$H/c.sh" "status" | grep -m1 "map:")
  echo "$(date +%H:%M:%S) $1 restart $i: $([ -n "$r" ] && echo ok || echo FROZEN)"
  [ -z "$r" ] && break
done
