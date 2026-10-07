#!/bin/bash
# Regenerates src/client/public/sounds/*.webm and *.mp3 (the announcer):
# builds the pinned tool image (Piper TTS, ffmpeg, sox) and runs make.sh in
# it. Prints each file's size, loudness and true peak; exits non-zero if a
# file is over 30 KB, above -1 dBTP or off the loudness target.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
out="$repo/src/client/public/sounds"
mkdir -p "$out"
docker build -q -t local/cs16-sounds "$here" >/dev/null
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$here/make.sh:/work/make.sh:ro" -v "$out:/out" \
	local/cs16-sounds bash /work/make.sh
