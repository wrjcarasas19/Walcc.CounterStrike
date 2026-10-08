#!/bin/bash
# Runs a script from this folder in the Playwright image, reusing the
# new-features-1006 tools (lib.mjs, node_modules, cache/ with the game zip):
# the whole plans/ folder is mounted and the working directory is
# new-features-1006-tools, so `import '../new-features-1006-tools/lib.mjs'`
# and its `cache/` work. usage: pw.sh <script.mjs> [args...]
# env: OUT (default ./out), BASE, ADMIN_PASSWORD, VERBOSE, ZIP_PORT,
# VOICE_ENABLE (check-engine-voice.mjs), START, DURATION, LABEL
# (check-voice-crowd.mjs), DEATHS (check-voice-teams.mjs), NETWORK (docker
# network, default host).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
plans=$(dirname "$here")
OUT=${OUT:-$here/out}
mkdir -p "$OUT"
script=$1; shift
docker run --rm --network "${NETWORK:-host}" --ipc host --init \
	-v "$plans:/plans" -v "$OUT:/out" -w /plans/new-features-1006-tools \
	-e BASE="${BASE:-http://127.0.0.1:27016}" -e OUT=/out \
	-e ADMIN_PASSWORD="${ADMIN_PASSWORD:-headless-admin}" -e VERBOSE="${VERBOSE:-}" \
	-e ZIP_PORT="${ZIP_PORT:-27090}" -e VOICE_ENABLE="${VOICE_ENABLE:-1}" \
	${START:+-e START="$START"} ${DURATION:+-e DURATION="$DURATION"} ${LABEL:+-e LABEL="$LABEL"} \
	${DEATHS:+-e DEATHS="$DEATHS"} \
	mcr.microsoft.com/playwright:v1.63.0-noble \
	bash -c '[ -d node_modules/playwright ] || npm install --no-audit --no-fund --silent; node "$@"' _ "/plans/new-features-1007-tools/$script" "$@"
