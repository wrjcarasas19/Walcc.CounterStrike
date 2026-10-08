#!/bin/bash
# A.2 load checks: many light voice clients (check-voice-crowd.mjs) against
# a server of their own, with the server container's CPU each second.
# The server allows 4 signaling WebSockets per address, so each argument is
# one Playwright container (its own address on a docker network made here)
# with up to 4 clients, given as their talk windows (see
# check-voice-crowd.mjs), e.g.
#   voice-crowd.sh "2-20 2-20 2-20 2-20" "6-26 -"   (5 talkers, 1 listener)
# All containers share one timeline (START). Output: each container's
# report, then the server's CPU about every second (% of one core, from
# the container's cgroup) over the timeline.
# env: IMAGE (default local/cs16-web-server:latest), DURATION (s, default
# 30), KEEP=1 (leave the server and network up).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
IMAGE=${IMAGE:-local/cs16-web-server:latest}
DURATION=${DURATION:-30}
NET=cs16-voice
SRV=cs16-voice-srv
SRV_IP=10.177.77.10
OUT=${OUT:-$here/out}
mkdir -p "$OUT"

docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet 10.177.77.0/24 "$NET" >/dev/null
docker rm -f "$SRV" >/dev/null 2>&1 || true
docker run -d --name "$SRV" --network "$NET" --ip "$SRV_IP" --platform linux/386 \
	-e IP="$SRV_IP" -e PORT=27018 -e BOT_QUOTA=0 \
	"$IMAGE" "+map de_dust2" +maxplayers 14 >/dev/null
cleanup() {
	if [ -z "${KEEP:-}" ]; then
		docker rm -f "$SRV" >/dev/null 2>&1 || true
		docker network rm "$NET" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT
for _ in $(seq 1 90); do
	curl -sf "http://$SRV_IP:27016/status.json" >/dev/null && break
	sleep 1
done
echo "$SRV up ($IMAGE)"

# Long enough for every container to start Chromium and connect.
START=$(( $(date +%s%3N) + 40000 ))
rm -f "$OUT"/crowd-*.log
pids=()
i=0
for windows in "$@"; do
	label=$(printf "\\x$(printf %x $((97 + i)))")
	# shellcheck disable=SC2086
	NETWORK=$NET BASE="http://$SRV_IP:27016" START=$START DURATION=$DURATION LABEL=$label \
		"$here/pw.sh" check-voice-crowd.mjs $(wc -w <<<"$windows") $windows >"$OUT/crowd-$label.log" 2>&1 &
	pids+=($!)
	i=$((i + 1))
done

usage() { docker exec "$SRV" sh -c 'grep usage_usec /sys/fs/cgroup/cpu.stat' | awk '{print $2}'; }
now=$(date +%s%3N)
sleep "$(awk "BEGIN{print ($START - $now) / 1000}")"
# Each sample: seconds since START, and the CPU % since the last sample.
cpu=()
prev=$(usage)
prevt=$(date +%s%3N)
while [ $((prevt - START)) -lt $((DURATION * 1000)) ]; do
	sleep 1
	cur=$(usage)
	t=$(date +%s%3N)
	cpu+=("$(( (t - START) / 1000 ))s:$(( (cur - prev) / (10 * (t - prevt)) ))")
	prev=$cur
	prevt=$t
done
for pid in "${pids[@]}"; do wait "$pid" || true; done
for log in "$OUT"/crowd-*.log; do grep -v '^\s*$' "$log"; done
echo "server CPU (s since START: % of one core): ${cpu[*]}"
docker logs "$SRV" 2>&1 | grep -i "voice\|panic" | grep -v "voice_\|BotVoice" | tail -20 || true
