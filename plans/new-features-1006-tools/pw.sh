#!/bin/bash
# Runs a Playwright script (Node ESM) in the official Playwright image with
# the host network, so the page at http://127.0.0.1:27016 and its WebRTC
# port are reachable. node_modules is installed once into this folder.
# usage: pw.sh <script.mjs> [args...]   env: OUT (screenshots folder,
#        default ./out), BASE (default http://127.0.0.1:27016), and for
#        some checks VIEWPORT, DEATHS, WAIT_SCALE.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$here/out}
mkdir -p "$OUT"
script=$1; shift
docker run --rm --network host --ipc host --init \
	-v "$here:/tools" -v "$OUT:/out" -w /tools \
	-e BASE="${BASE:-http://127.0.0.1:27016}" -e OUT=/out \
	-e ADMIN_PASSWORD="${ADMIN_PASSWORD:-headless-admin}" -e VERBOSE="${VERBOSE:-}" \
	-e ZIP_PORT="${ZIP_PORT:-27090}" -e VIEWPORT="${VIEWPORT:-}" -e DEATHS="${DEATHS:-}" -e WAIT_SCALE="${WAIT_SCALE:-}" \
	mcr.microsoft.com/playwright:v1.63.0-noble \
	bash -c '[ -d node_modules/playwright ] || npm install --no-audit --no-fund --silent; node "$@"' _ "$script" "$@"
