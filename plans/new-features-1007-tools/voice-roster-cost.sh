#!/bin/bash
# A.3: the roster poll's cost. Runs check-voice-roster-cost.mjs against a
# fresh server with voice on (the poll runs: 4 wc_roster console commands a
# second) and then with VOICE=0 (no poll), and prints the server
# container's mean CPU (% of one core, from its cgroup) over the measured
# window next to the page's numbers.
# usage: voice-roster-cost.sh [seconds]   env: IMAGE, BOTS (default 4)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tools=$here/../new-features-1006-tools
seconds=${1:-60}
usage() { docker exec cs16-headless sh -c 'grep usage_usec /sys/fs/cgroup/cpu.stat' | awk '{print $2}'; }
for voice in 1 0; do
	VOICE=$voice "$tools/run-server.sh" de_dust2 "${BOTS:-4}" >/dev/null
	log=$(mktemp)
	"$here/pw.sh" check-voice-roster-cost.mjs "$seconds" >"$log" 2>&1 &
	pid=$!
	until grep -q '^START' "$log" 2>/dev/null; do
		kill -0 "$pid" 2>/dev/null || { cat "$log"; exit 1; }
		sleep 0.2
	done
	u0=$(usage) t0=$(date +%s%N)
	until grep -q '^END' "$log" 2>/dev/null; do sleep 0.2; done
	u1=$(usage) t1=$(date +%s%N)
	wait "$pid" || true
	echo "== VOICE=$voice"
	grep -v '^START\|^END' "$log"
	awk -v u="$((u1 - u0))" -v t="$((t1 - t0))" 'BEGIN { printf "server CPU: %.1f%% of one core\n", u * 1000 * 100 / t }'
	rm -f "$log"
done
docker rm -f cs16-headless >/dev/null
