#!/bin/bash
# Sends one typed admin action to the server, as the F4 menu does.
# usage: admin.sh '{"action":"cvar","name":"wc_gamemode","value":1}'
# env: BASE (default http://127.0.0.1:27016), ADMIN_PASSWORD.
set -eu
BASE=${BASE:-http://127.0.0.1:27016}
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
curl -sf -c "$jar" -H 'Content-Type: application/json' \
	-d "{\"password\":\"${ADMIN_PASSWORD:-headless-admin}\"}" "$BASE/admin/login" >/dev/null
curl -s -b "$jar" -H 'Content-Type: application/json' -d "$1" "$BASE/admin/command"
echo
