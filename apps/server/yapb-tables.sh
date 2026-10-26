#!/bin/sh
# Generates YaPB's visibility table (train/<map>.vis) for every map in the
# image, plus the graph of any map that has none, into
# apps/server/configs/cstrike/addons/yapb/data/. Without a table YaPB rebuilds
# it in the first minutes of the map, on the engine thread, and the server
# can stop for good meanwhile (plans/pve-handoff/README.md). A table is only
# valid for the graph and YaPB version it was made with: run this again after
# changing yapb_version in the Dockerfile or a graph, then rebuild the image.
#
# Usage, from the repository root, after make build-local-image:
#   apps/server/yapb-tables.sh [image] [map ...]
# JOBS (default 4) sets how many maps run at once; TIMEOUT (default 1800)
# the seconds one map may take.
set -eu
IMAGE=${1:-local/cs16-web-server}
[ $# -gt 0 ] && shift
DATA=apps/server/configs/cstrike/addons/yapb/data
JOBS=${JOBS:-4}
TIMEOUT=${TIMEOUT:-1800}
TRAIN=/xashds/cstrike/addons/yapb/data/train
GRAPH=/xashds/cstrike/addons/yapb/data/graph

if [ "${YAPB_TABLES_MAP:-}" ]; then
	# One map: a server with no bots and no players still runs YaPB's frame.
	map=$YAPB_TABLES_MAP
	name=yapb-tables-$map
	docker rm -f "$name" >/dev/null 2>&1 || true
	had_graph=$(docker run --rm --platform linux/386 --entrypoint sh "$IMAGE" -c "test -f $GRAPH/$map.graph && echo 1 || echo 0")
	# The image's own tables are deleted first, so an outdated one isn't
	# taken for the result.
	docker run -d --name "$name" --platform linux/386 -e BOT_QUOTA=0 --entrypoint sh "$IMAGE" \
		-c "rm -f $TRAIN/*; exec ./xash +ip 0.0.0.0 -port 27015 -game cstrike +map $map +maxplayers 2" >/dev/null
	s=0
	until docker exec "$name" test -f "$TRAIN/$map.vis"; do
		sleep 5
		s=$((s + 5))
		if [ $s -ge "$TIMEOUT" ] || [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
			echo "$map: FAILED after $s s"
			docker logs "$name" 2>&1 | tail -n 5
			docker rm -f "$name" >/dev/null
			exit 1
		fi
	done
	# YaPB writes the file in one go once the table is complete.
	sleep 2
	docker cp "$name:$TRAIN/$map.vis" "$DATA/train/$map.vis"
	if [ "$had_graph" = 0 ]; then
		docker cp "$name:$GRAPH/$map.graph" "$DATA/graph/$map.graph"
		echo "$map: table and graph in $s s"
	else
		echo "$map: table in $s s"
	fi
	docker rm -f "$name" >/dev/null
	exit 0
fi

mkdir -p "$DATA/train" "$DATA/graph"
if [ $# -eq 0 ]; then
	set -- $(docker run --rm --platform linux/386 --entrypoint sh "$IMAGE" \
		-c 'cd /xashds/cstrike/maps && ls *.bsp' | sed 's/\.bsp$//')
fi
printf '%s\n' "$@" | xargs -P "$JOBS" -I{} env YAPB_TABLES_MAP={} IMAGE="$IMAGE" "$0" "$IMAGE"
