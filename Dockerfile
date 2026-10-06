# syntax=docker/dockerfile:1
FROM debian:bookworm-slim AS engine

RUN dpkg --add-architecture i386
RUN apt update && apt -y --no-install-recommends install aptitude
RUN aptitude -y --without-recommends install git ca-certificates build-essential gcc-multilib g++-multilib libbsd-dev:i386 libsdl2-dev:i386 libfreetype-dev:i386 libopus-dev:i386 libbz2-dev:i386 libvorbis-dev:i386 libopusfile-dev:i386 libogg-dev:i386

ENV PKG_CONFIG_PATH=/usr/lib/i386-linux-gnu/pkgconfig

WORKDIR /xash

# The engine's `go` branch (yohimik/xash3d-fwgs) went private. The pinned commit
# is still served by the public FWGS repo through GitHub's fork network; fetching
# by full hash guarantees the same tree. Point XASH3D_REPO at a mirror you own
# to stop depending on that.
ARG XASH3D_REPO=https://github.com/FWGS/xash3d-fwgs
ARG XASH3D_COMMIT=d3bc7fabeea8586f38a501b4cc6233fa0545f5f0
RUN git init -q . \
    && git remote add origin "$XASH3D_REPO" \
    && git fetch -q --depth=1 origin "$XASH3D_COMMIT" \
    && git checkout -q FETCH_HEAD \
    && git submodule update --init --recursive

# Fixes the fork's NET_SendLong freeing split-packet fragments twice, which
# aborted the server whenever it sent a packet larger than the split size.
COPY patches/engine/ /patches/engine/
RUN git apply /patches/engine/*.patch

RUN ./waf configure -T release -d --enable-lto --enable-openmp \
    && ./waf build

FROM golang:1.24-bookworm AS go

# 32-bit libc headers and libgomp for linking the i386 engine via cgo.
RUN apt-get update && apt-get install -y --no-install-recommends gcc-multilib \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY go.mod go.mod
COPY go.sum go.sum
# goxash3d-fwgs (the CGO wrapper) went private and is not on proxy.golang.org.
# Public forks still carry the pinned commit; the full hash guarantees the same
# tree. Point GOXASH3D_REPO at a mirror you own to stop depending on the fork.
ARG GOXASH3D_REPO=https://github.com/kzzalews/goxash3d-fwgs
ARG GOXASH3D_COMMIT=90b4aa816099db3c45cfa01dd8246f12473bce22
RUN git clone -q "$GOXASH3D_REPO" /github.com/yohimik/goxash3d-fwgs \
    && git -C /github.com/yohimik/goxash3d-fwgs checkout -q --detach "$GOXASH3D_COMMIT" \
    && printf '\nreplace github.com/yohimik/goxash3d-fwgs => /github.com/yohimik/goxash3d-fwgs\n' >> go.mod \
    && go mod download

COPY src/server src/server
COPY --from=engine /xash/build/engine/libxash.a /github.com/yohimik/goxash3d-fwgs/pkg/libxash.a
COPY --from=engine /xash/build/public/libbuild_vcs.a /github.com/yohimik/goxash3d-fwgs/pkg/libbuild_vcs.a
COPY --from=engine /xash/build/public/libpublic.a /github.com/yohimik/goxash3d-fwgs/pkg/libpublic.a
COPY --from=engine /xash/build/3rdparty/libbacktrace/libbacktrace.a /github.com/yohimik/goxash3d-fwgs/pkg/libbacktrace.a

ENV GOARCH=386
# Cross-compiling to 386 disables cgo by default, which drops the wrapper's C glue.
ENV CGO_ENABLED=1
ENV CC="gcc -m32 -D__i386__"
ENV CGO_CFLAGS="-fopenmp -m32"
ENV CGO_LDFLAGS="-fopenmp -m32"
RUN go build -o ./xash ./src/server

FROM debian:bookworm-slim AS hlds

ARG hlds_build=8308
ARG hlds_url="https://github.com/DevilBoy-eXe/hlds/releases/download/$hlds_build/hlds_build_$hlds_build.zip"

RUN groupadd -r xash && useradd -r -g xash -m -d /opt/xash xash
RUN usermod -a -G games xash

RUN apt-get -y update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    xz-utils \
    && apt-get -y clean

USER xash
WORKDIR /opt/xash
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN mkdir -p /opt/xash/xashds

RUN curl -sLJO "$hlds_url" \
    && unzip "hlds_build_$hlds_build.zip" -d "/opt/xash/hlds_build_$hlds_build" \
    && cp -R "hlds_build_$hlds_build/hlds"/* xashds/ \
    && rm -rf "hlds_build_$hlds_build" "hlds_build_$hlds_build.zip"

# Fix warnings:
# couldn't exec listip.cfg
# couldn't exec banned.cfg
RUN touch /opt/xash/xashds/valve/listip.cfg
RUN touch /opt/xash/xashds/valve/banned.cfg

WORKDIR /opt/xash/xashds

# Metamod-R, AMX Mod X and YaPB bots (32-bit builds, like the engine).
# liblist.gam loads Metamod, which loads the game DLL and the plugins listed
# in configs/cstrike/addons/metamod/plugins.ini.
ARG metamod_version=1.3.0.149
ARG metamod_sha256=ede7f59c4e0220afe8c02aa348a130cce527f87d36ffdb674e37a501ce57be94
ARG amxx_version=1.10.0-git5486
ARG amxx_base_sha256=9f5041325cc656dcc292cafb9d2c9cb4deeedb57192d8a7ed43947530e04e5b7
ARG amxx_cstrike_sha256=686d875010792d84ac765d2f78af227ab7000c9b567995ea56b836e0a41fc7a7
ARG yapb_version=4.4.957
ARG yapb_sha256=8c095ac89b9b2ccc70a66a71d608e1a570b5268c57c6083ced8c06161533a4b1
RUN mkdir /tmp/addons && cd /tmp/addons \
    && curl -fsSLo metamod.zip "https://github.com/theAsmodai/metamod-r/releases/download/$metamod_version/metamod-bin-$metamod_version.zip" \
    && curl -fsSLo amxx-base.tar.gz "https://www.amxmodx.org/amxxdrop/1.10/amxmodx-$amxx_version-base-linux.tar.gz" \
    && curl -fsSLo amxx-cstrike.tar.gz "https://www.amxmodx.org/amxxdrop/1.10/amxmodx-$amxx_version-cstrike-linux.tar.gz" \
    && curl -fsSLo yapb.tar.xz "https://github.com/yapb/yapb/releases/download/$yapb_version/yapb-$yapb_version-linux.tar.xz" \
    && printf '%s  %s\n' \
        "$metamod_sha256" metamod.zip \
        "$amxx_base_sha256" amxx-base.tar.gz \
        "$amxx_cstrike_sha256" amxx-cstrike.tar.gz \
        "$yapb_sha256" yapb.tar.xz \
        | sha256sum -c - \
    && cd /opt/xash/xashds/cstrike \
    && unzip -q /tmp/addons/metamod.zip 'addons/metamod/*' -x '*.dll' \
    && tar -xzf /tmp/addons/amxx-base.tar.gz \
    && tar -xzf /tmp/addons/amxx-cstrike.tar.gz \
    && tar -xJf /tmp/addons/yapb.tar.xz \
    && rm -rf /tmp/addons \
    && sed -i 's|^gamedll_linux .*|gamedll_linux "addons/metamod/metamod_i386.so"|' liblist.gam \
    # No bots until an admin adds them (YaPB's default is 9).
    && sed -i 's|^yb_quota .*|yb_quota "0"|' addons/yapb/conf/yapb.cfg \
    # yapb.cfg runs again on every map change; keep what the admin menu set.
    && sed -i 's|^yb_ignore_cvars_on_changelevel .*|yb_ignore_cvars_on_changelevel "yb_quota,yb_quota_mode,yb_difficulty,yb_autovacate"|' addons/yapb/conf/yapb.cfg \
    # Players get fake addresses from the SFU, so drop the address-based admin.
    && sed -i 's|^"loopback"|; "loopback"|' addons/amxmodx/configs/users.ini \
    # Slot reservation reads a cvar Xash3D doesn't have and errors on every join.
    && sed -i 's|^adminslots.amxx|;adminslots.amxx|' addons/amxmodx/configs/plugins.ini \
    # Our own plugins, compiled in the amxx-plugins stage from src/amxx.
    && printf '\n; Web server plugins (src/amxx)\nwc_weaponmode.amxx\nwc_statslog.amxx\n' >> addons/amxmodx/configs/plugins.ini \
    # Metamod looks for the ReHLDS API in engine_i486.so; loading the GoldSrc
    # engine shipped with HLDS into the Xash3D process crashes it. Xash3D
    # doesn't use that file.
    && rm -f /opt/xash/xashds/engine_i486.so

# Copy default config
COPY configs/valve valve
COPY configs/cstrike cstrike

# Compiles the server's own AMX Mod X plugins (src/amxx/*.sma) with the
# compiler and includes from the same pinned AMXX archive. amxxpc is a 32-bit
# Linux program; CI builds linux/amd64, so add the i386 libraries it needs.
FROM debian:bookworm-slim AS amxx-plugins

RUN dpkg --add-architecture i386 \
    && apt-get update && apt-get install -y --no-install-recommends \
    libc6:i386 \
    libstdc++6:i386 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=hlds /opt/xash/xashds/cstrike/addons/amxmodx/scripting /scripting
COPY src/amxx /src/amxx
WORKDIR /scripting
RUN mkdir /out \
    && for sma in /src/amxx/*.sma; do \
        out="/out/$(basename "$sma" .sma).amxx"; \
        ./amxxpc "$sma" -o"$out" && test -s "$out" || exit 1; \
    done

FROM --platform=$BUILDPLATFORM node:24-alpine AS client

WORKDIR /client

COPY package.json package.json
COPY package-lock.json package-lock.json
COPY vendor/cs16-client-0.0.7.tgz vendor/cs16-client-0.0.7.tgz
COPY vendor/xash3d-fwgs-1.0.0.tgz vendor/xash3d-fwgs-1.0.0.tgz
RUN npm ci
COPY vite.config.ts vite.config.ts
COPY tsconfig.json tsconfig.json
COPY src/client src/client

RUN npm run build

FROM debian:bookworm-slim AS final

ENV XASH3D_BASEDIR=/xashds

RUN dpkg --add-architecture i386
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgcc-s1:i386 \
    libstdc++6:i386 \
    libgomp1:i386 \
    ca-certificates \
    openssl \
    && apt-get clean

RUN groupadd xashds && useradd -m -g xashds xashds
USER xashds
WORKDIR /xashds
ENV LD_LIBRARY_PATH=/xashds

COPY --from=hlds /opt/xash/xashds .
COPY --from=go /src/xash ./xash
COPY --from=client /client/src/client/dist ./public
COPY --from=engine /xash/build/filesystem/filesystem_stdio.so ./filesystem_stdio.so
COPY --from=amxx-plugins /out/ ./cstrike/addons/amxmodx/plugins/

# The legacy HLDS archive includes old GCC runtime libraries in /xashds.
# Because /xashds is on LD_LIBRARY_PATH, they would override Debian's compatible
# 32-bit runtime pair and cannot satisfy the symbols required by the newer
# filesystem_stdio.so.
USER root
RUN rm -f /xashds/libstdc++.so.6 /xashds/libgcc_s.so.1
# YaPB saves each map's vistable and path matrix here; without write access
# it rebuilds them on every map load (minutes of CPU on a big map).
RUN cd /xashds/cstrike/addons/yapb/data \
    && chown -R xashds:xashds train logs pwf \
    && chmod -R u+rwX train logs pwf \
    # The server writes BOT_QUOTA into yapb.cfg at startup (src/server/bots.go).
    && chown xashds:xashds ../conf/yapb.cfg
# The ban list (src/server/bans.go) and the leaderboard database
# (leaderboard.db, src/server/statsdb.go) are saved here; mount a volume on it
# to keep them across container restarts. A new named volume copies this
# directory's owner.
RUN mkdir /xashds/data && chown xashds:xashds /xashds/data
# AMX Mod X writes its logs (log_amx) and data (stats, vaults) here; the
# archive leaves them owned by uid 999, so nothing was written.
RUN chown -R xashds:xashds /xashds/cstrike/addons/amxmodx/logs \
    /xashds/cstrike/addons/amxmodx/data
# The game's log files (log on, a new LMMDDNNN.log per map), which the
# leaderboard reads (src/server/statsfollow.go). The engine writes them under
# the game folder, which isn't writable by xashds.
RUN mkdir /xashds/cstrike/logs && chown xashds:xashds /xashds/cstrike/logs
USER xashds

EXPOSE 27015/udp

# Start server
ENTRYPOINT ["./xash", "+ip", "0.0.0.0", "-port", "27015", "-game", "cstrike"]

# Default start parameters
CMD ["+map de_dust2", "+maxplayers", "16"]
