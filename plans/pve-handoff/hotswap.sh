#!/bin/sh
# Compile wc_gamemode.sma and copy it into the running test container; then run "changelevel de_dust2" via c.sh.
# Needs the compiler image once: docker build --platform=linux/386 -f apps/server/Dockerfile --target amxx-plugins -t local/cs16-amxx-test .
H=$(cd "$(dirname "$0")" && pwd)
cd "$H/../.."
mkdir -p "$H/out"
docker run --rm --platform=linux/386 -v "$PWD/apps/amxx:/src/amxx:ro" -v "$H/out:/out" -w /scripting local/cs16-amxx-test \
  sh -c './amxxpc /src/amxx/wc_gamemode.sma -o/out/wc_gamemode.amxx' | grep -iE "warning|error|Done"
docker cp "$H/out/wc_gamemode.amxx" ${CONTAINER:-cs-p0}:/xashds/cstrike/addons/amxmodx/plugins/wc_gamemode.amxx
