#!/bin/bash
# usage: run.sh <name> <gamedll_linux path> <plugins.ini content (printf)> [extra args]
name=$1; dll=$2; pl=$3; shift 3
docker rm -f $name >/dev/null 2>&1
docker run -d --ulimit core=-1 --name $name --platform linux/386 -v /private/tmp/claude-501/-Users-wcarasas-Repos-Walcc-CounterStrike/40191e16-bc0d-4445-ad2c-38b1ecda8823/scratchpad/spike2/dbg:/dbg:ro -e RCON_PASSWORD=spikepw --entrypoint bash local/cs16-spike2 -c "
rm -f engine_i486.so; cp /dbg/*.so cstrike/addons/metamod/ 2>/dev/null
sed -i 's|^gamedll_linux .*|gamedll_linux \"$dll\"|' cstrike/liblist.gam
printf '$pl' > cstrike/addons/metamod/plugins.ini
ulimit -c unlimited; rm -f /tmp/in; mkfifo /tmp/in; (tail -f /tmp/in) | exec ./xash +ip 0.0.0.0 -port 27015 -game cstrike $* +map de_dust2 +maxplayers 16" >/dev/null
for i in $(seq 1 90); do rtk proxy docker logs $name 2>&1 | grep -qa 'signal 11\|Segmentation\|Sys_Error\|Host_Error\|Server started\|Game started\|Add all bots' && break; sleep 2; done
sleep 5
