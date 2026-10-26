#!/bin/sh
# Send console commands to the engine through the container's stdin and print what it logged.
# Usage: CONTAINER=cs-p0 WAIT=0.5 ./c.sh "status" "wc_wave_status"
C=${CONTAINER:-cs-p0}
before=$(docker logs $C 2>&1 | wc -l)
for cmd in "$@"; do docker exec $C sh -c "printf '%s\n' \"\$1\" > /proc/1/fd/0" _ "$cmd"; sleep ${WAIT:-0.5}; done
sleep 1
docker logs $C 2>&1 | tail -n +$((before+1)) | sed 's/\x1b\[[0-9;]*m//g' | grep -v "Rebuilding vistable"
