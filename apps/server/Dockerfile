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
COPY apps/server/patches/engine/ /patches/engine/
RUN git apply /patches/engine/*.patch

RUN ./waf configure -T release -d --enable-lto --enable-openmp \
    && ./waf build

FROM golang:1.24-bookworm AS go

# 32-bit libc headers and libgomp for linking the i386 engine via cgo.
RUN apt-get update && apt-get install -y --no-install-recommends gcc-multilib \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY apps/server/go.mod go.mod
COPY apps/server/go.sum go.sum
# goxash3d-fwgs (the CGO wrapper) went private and is not on proxy.golang.org.
# Public forks still carry the pinned commit; the full hash guarantees the same
# tree. Point GOXASH3D_REPO at a mirror you own to stop depending on the fork.
ARG GOXASH3D_REPO=https://github.com/kzzalews/goxash3d-fwgs
ARG GOXASH3D_COMMIT=90b4aa816099db3c45cfa01dd8246f12473bce22
RUN git clone -q "$GOXASH3D_REPO" /github.com/yohimik/goxash3d-fwgs \
    && git -C /github.com/yohimik/goxash3d-fwgs checkout -q --detach "$GOXASH3D_COMMIT" \
    && printf '\nreplace github.com/yohimik/goxash3d-fwgs => /github.com/yohimik/goxash3d-fwgs\n' >> go.mod \
    && go mod download

COPY apps/server/*.go ./
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
RUN go build -o ./xash .

# Community maps added to cstrike/maps. Each *_url may point at a bare .bsp
# (a mirror you own) or at an archive (zip, 7z, rar) holding <map>.bsp;
# either way the .bsp must match *_sha256. A map that needs other files
# (models, sounds, a sky) names them after its sha256; they come from the
# archive's game folder (the one holding maps/<map>.bsp), are checked below
# and listed in maps/<map>.res, which the web server reads to send them to
# browsers (apps/server/maps.go). The defaults are the GameBanana uploads;
# point them at your own mirror to stop depending on it.
#   cs_mansion: gamebanana.com/mods/92163 (Anushapopli)
#   ttt_mario_b1: gamebanana.com/mods/486483 (Lisa Hayes); its .res also
#   lists sound/btfunny/cart_bgm.wav, which the upload doesn't include, so
#   that ambient sound stays silent.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS maps

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libarchive-tools \
    && rm -rf /var/lib/apt/lists/*

ARG fy_iceworld_url=https://files.gamebanana.com/mods/fy_iceworld_2.7z
ARG fy_iceworld_sha256=0fa8cc32a19c94b65a4f303fcd483ddff09a334d3e7275984ee4369957d8c769
ARG aim_map_url=https://files.gamebanana.com/mods/aim_map_3.zip
ARG aim_map_sha256=bf0a879d11c2b73a0b58b7832ea8f91d7979ba0b90071c14d40a712a2e1a5b3c
ARG awp_india_url=https://files.gamebanana.com/mods/awp_india.7z
ARG awp_india_sha256=c3d2311d633ab68aaf3708c49778e923f5a43e2dc2631abf5d602c56f2f2156f
ARG fy_pool_day_url=https://files.gamebanana.com/mods/fy_pool_day_60bca.rar
ARG fy_pool_day_sha256=fb22ba78a20d762a7114bdd56d62ec01794695ac48c6777f1bbd676ab769d208
ARG cs_mansion_url=https://files.gamebanana.com/mods/cs_mansion.7z
ARG cs_mansion_sha256=cd65250fdfd78950e8ea0146629613cb9d86566e3a663ce178e52457b6e1cd54
ARG ttt_mario_b1_url=https://files.gamebanana.com/mods/ttt_mario_b1_bea72.rar
ARG ttt_mario_b1_sha256=fb1af7498adea6d8db58387daeb0f4316b6d08de8a985f43abb9b4105fa1978a
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# /game is copied over cstrike in the hlds stage.
RUN mkdir -p /game/maps \
    # set -e doesn't apply inside a function called from an && list, so every
    # step is chained.
    && fetch() { \
        local name=$1 url=$2 sha=$3 dir found root path; \
        shift 3; \
        dir=$(mktemp -d) \
        && curl -fsSLo "$dir/download" "$url" \
        # A BSP (version 30) starts with 1e 00 00 00; anything else is an archive.
        && if [ "$(od -An -tx1 -N4 "$dir/download" | tr -d ' ')" = 1e000000 ]; then \
            { [ $# = 0 ] || { echo "$name needs its other files: $url must be an archive" >&2; false; }; } \
            && mv "$dir/download" "/game/maps/$name.bsp"; \
        else \
            mkdir "$dir/x" \
            && bsdtar -xf "$dir/download" -C "$dir/x" \
            && found=$(find "$dir/x" -type f -iname "$name.bsp") \
            && { [ -n "$found" ] && [ "$(printf '%s\n' "$found" | wc -l)" = 1 ] \
                || { echo "expected one $name.bsp in $url, found: $found" >&2; false; }; } \
            && root=$(dirname "$(dirname "$found")") \
            && mv "$found" "/game/maps/$name.bsp" \
            && for path in "$@"; do \
                install -D -m 644 "$root/$path" "/game/$path" || return 1; \
            done; \
        fi \
        && rm -rf "$dir" \
        && { [ $# = 0 ] || printf '%s\n' "$@" > "/game/maps/$name.res"; } \
        && echo "$sha  /game/maps/$name.bsp" | sha256sum -c -; \
    } \
    && fetch fy_iceworld "$fy_iceworld_url" "$fy_iceworld_sha256" \
    && fetch aim_map "$aim_map_url" "$aim_map_sha256" \
    && fetch awp_india "$awp_india_url" "$awp_india_sha256" \
    && fetch fy_pool_day "$fy_pool_day_url" "$fy_pool_day_sha256" \
    && fetch cs_mansion "$cs_mansion_url" "$cs_mansion_sha256" \
    && fetch ttt_mario_b1 "$ttt_mario_b1_url" "$ttt_mario_b1_sha256" \
        models/ttt_syko/goomba_mario.mdl \
        models/ttt_syko/mariobros.mdl \
        sound/ttt_mario/rugido_koopa.wav \
        gfx/env/kart_sky01bk.tga \
        gfx/env/kart_sky01dn.tga \
        gfx/env/kart_sky01ft.tga \
        gfx/env/kart_sky01lf.tga \
        gfx/env/kart_sky01rt.tga \
        gfx/env/kart_sky01up.tga \
    && printf '%s  /game/%s\n' \
        a9be967991cac5cec8ad1ed101eab5fd67ac0cc010cf2d9ca8576e8edca13948 models/ttt_syko/goomba_mario.mdl \
        d0a9015479ed532fb1c8b56df4cc8f39a82107508fb21c7efccd7d248468c811 models/ttt_syko/mariobros.mdl \
        a9735304d6b16fee00288e4fd5824a1b42582e9e1e2e7a54595ce4a07e46f6f8 sound/ttt_mario/rugido_koopa.wav \
        55b846355d286e6237228b045f663448a556105325c41358ef25e3acab6e6098 gfx/env/kart_sky01bk.tga \
        e177916fb9588087853f1bf1fbac2e1adaa205bad0555b16b2274f728ab6ac4d gfx/env/kart_sky01dn.tga \
        55b846355d286e6237228b045f663448a556105325c41358ef25e3acab6e6098 gfx/env/kart_sky01ft.tga \
        55b846355d286e6237228b045f663448a556105325c41358ef25e3acab6e6098 gfx/env/kart_sky01lf.tga \
        55b846355d286e6237228b045f663448a556105325c41358ef25e3acab6e6098 gfx/env/kart_sky01rt.tga \
        e177916fb9588087853f1bf1fbac2e1adaa205bad0555b16b2274f728ab6ac4d gfx/env/kart_sky01up.tga \
        | sha256sum -c - \
    && chmod 644 /game/maps/*

# Star Wars player models in place of six of the stock characters (the team
# menu's names are in apps/client/src/team/items.ts; Palpatine, the seventh,
# is made in the player-models-converted stage). They are listed in
# resources.res, which the web server reads to send them to browsers on every
# map (apps/server/maps.go); the server loads the same files, so hitboxes
# match what players see. Grievous and Obi-Wan
# were made as terrorists and are renamed to the counter-terrorists they
# replace; the engine loads a model's textures from <name>T.mdl, so both
# files are renamed. All three are CC BY-NC-ND 4.0 GameBanana uploads, so the
# repository only pins them; point the URLs at your own mirror to stop
# depending on GameBanana.
#   star_wars_t_pack: gamebanana.com/mods/225638 (author unknown); Yoda,
#   Tusken Raider, C-3PO and Jawa for terror, leet, arctic and guerilla
#   general_grievous: gamebanana.com/mods/227623, as gign
#   obi_wan_kenobi: gamebanana.com/mods/228434, as sas
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS player-models

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libarchive-tools \
    && rm -rf /var/lib/apt/lists/*

ARG star_wars_t_pack_url=https://files.gamebanana.com/mods/star_wars_t_pack.7z
ARG star_wars_t_pack_sha256=dcec5ab54812ad8cd989cea27346fb1b35c4173960dd4a7f2556c5e54962b0de
ARG general_grievous_url=https://files.gamebanana.com/mods/general_grievous.rar
ARG general_grievous_sha256=e686820af2e4089cbdb74a1a0849089e9920db2ce0e007e63c9310a7fa1ef1d0
ARG obi_wan_kenobi_url=https://files.gamebanana.com/mods/obi_wan_kenobi_hd.rar
ARG obi_wan_kenobi_sha256=9e297cc3a19e877fedf5cb9fb3fcf3ce2b0c6104db46ac3b3fa7b3712fe93f00
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# /game is copied over cstrike in the hlds stage.
WORKDIR /tmp/models
RUN curl -fsSLo t_pack "$star_wars_t_pack_url" \
    && curl -fsSLo grievous "$general_grievous_url" \
    && curl -fsSLo obi_wan "$obi_wan_kenobi_url" \
    && printf '%s  %s\n' \
        "$star_wars_t_pack_sha256" t_pack \
        "$general_grievous_sha256" grievous \
        "$obi_wan_kenobi_sha256" obi_wan \
        | sha256sum -c - \
    && mkdir t_pack.d grievous.d obi_wan.d \
    && bsdtar -xf t_pack -C t_pack.d \
    && bsdtar -xf grievous -C grievous.d \
    && bsdtar -xf obi_wan -C obi_wan.d \
    && p=/game/models/player \
    && for name in terror leet arctic guerilla; do \
        install -D -m 644 "t_pack.d/Star Wars Player T Pack/models/player/$name/$name.mdl" "$p/$name/$name.mdl" || exit 1; \
    done \
    && install -D -m 644 grievous.d/models/player/terror/terror.mdl "$p/gign/gign.mdl" \
    && install -D -m 644 grievous.d/models/player/terror/terrorT.mdl "$p/gign/gignT.mdl" \
    && install -D -m 644 obi_wan.d/models/player/guerilla/guerilla.mdl "$p/sas/sas.mdl" \
    && install -D -m 644 obi_wan.d/models/player/guerilla/guerillaT.mdl "$p/sas/sasT.mdl" \
    && (cd /game && find models -type f | sort > resources.res) \
    && chmod 644 /game/resources.res \
    && rm -rf /tmp/models

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
# in apps/server/configs/cstrike/addons/metamod/plugins.ini.
# The game DLL is ReGameDLL_CS (dlls/cs.so replaced; Metamod's gamedll_linux
# is unchanged): same game and log lines as Valve's, plus cvars such as
# mp_forcerespawn and mp_round_infinite for the game modes. Only cs.so is
# taken: its game.cfg would reset cvars like mp_buytime on every map, and its
# delta.lst changes how entities are encoded on the wire (HLDS's is kept).
ARG metamod_version=1.3.0.149
ARG metamod_sha256=ede7f59c4e0220afe8c02aa348a130cce527f87d36ffdb674e37a501ce57be94
ARG amxx_version=1.10.0-git5486
ARG amxx_base_sha256=9f5041325cc656dcc292cafb9d2c9cb4deeedb57192d8a7ed43947530e04e5b7
ARG amxx_cstrike_sha256=686d875010792d84ac765d2f78af227ab7000c9b567995ea56b836e0a41fc7a7
ARG yapb_version=4.4.957
ARG yapb_sha256=8c095ac89b9b2ccc70a66a71d608e1a570b5268c57c6083ced8c06161533a4b1
ARG regamedll_version=5.30.0.814
ARG regamedll_sha256=457f5c96a4d10280fcad47f106cbd5be86363a47df1ccab91c514e9d1bc6fd18
RUN mkdir /tmp/addons && cd /tmp/addons \
    && curl -fsSLo metamod.zip "https://github.com/theAsmodai/metamod-r/releases/download/$metamod_version/metamod-bin-$metamod_version.zip" \
    && curl -fsSLo amxx-base.tar.gz "https://www.amxmodx.org/amxxdrop/1.10/amxmodx-$amxx_version-base-linux.tar.gz" \
    && curl -fsSLo amxx-cstrike.tar.gz "https://www.amxmodx.org/amxxdrop/1.10/amxmodx-$amxx_version-cstrike-linux.tar.gz" \
    && curl -fsSLo yapb.tar.xz "https://github.com/yapb/yapb/releases/download/$yapb_version/yapb-$yapb_version-linux.tar.xz" \
    && curl -fsSLo regamedll.zip "https://github.com/rehlds/ReGameDLL_CS/releases/download/$regamedll_version/regamedll-bin-$regamedll_version.zip" \
    && printf '%s  %s\n' \
        "$metamod_sha256" metamod.zip \
        "$amxx_base_sha256" amxx-base.tar.gz \
        "$amxx_cstrike_sha256" amxx-cstrike.tar.gz \
        "$yapb_sha256" yapb.tar.xz \
        "$regamedll_sha256" regamedll.zip \
        | sha256sum -c - \
    && cd /opt/xash/xashds/cstrike \
    && unzip -q /tmp/addons/metamod.zip 'addons/metamod/*' -x '*.dll' \
    && tar -xzf /tmp/addons/amxx-base.tar.gz \
    && tar -xzf /tmp/addons/amxx-cstrike.tar.gz \
    && tar -xJf /tmp/addons/yapb.tar.xz \
    && unzip -qjo /tmp/addons/regamedll.zip bin/linux32/cstrike/dlls/cs.so -d dlls \
    && rm -rf /tmp/addons \
    && sed -i 's|^gamedll_linux .*|gamedll_linux "addons/metamod/metamod_i386.so"|' liblist.gam \
    # No bots until an admin adds them (YaPB's default is 9).
    && sed -i 's|^yb_quota .*|yb_quota "0"|' addons/yapb/conf/yapb.cfg \
    # yapb.cfg runs again on every map change; keep what the admin menu set.
    && sed -i 's|^yb_ignore_cvars_on_changelevel .*|yb_ignore_cvars_on_changelevel "yb_quota,yb_quota_mode,yb_difficulty,yb_autovacate"|' addons/yapb/conf/yapb.cfg \
    # Bot AI is CPU-heavy; run it at YaPB's minimum rate (default 26).
    && sed -i 's|^yb_think_fps .*|yb_think_fps "24.0"|' addons/yapb/conf/yapb.cfg \
    # No text chat from bots; radio and voice chatter (yb_radio_mode 2) stay.
    && sed -i 's|^yb_chat .*|yb_chat "0"|' addons/yapb/conf/yapb.cfg \
    # Players get fake addresses from the SFU, so drop the address-based admin.
    && sed -i 's|^"loopback"|; "loopback"|' addons/amxmodx/configs/users.ini \
    # Slot reservation reads a cvar Xash3D doesn't have and errors on every join.
    && sed -i 's|^adminslots.amxx|;adminslots.amxx|' addons/amxmodx/configs/plugins.ini \
    # Our own plugins, compiled in the amxx-plugins stage from apps/amxx.
    && printf '\n; Web server plugins (apps/amxx)\nwc_weaponmode.amxx\nwc_gamemode.amxx\nwc_statslog.amxx\nwc_killinfo.amxx\n' >> addons/amxmodx/configs/plugins.ini \
    # The players' end-of-map vote and amx_mapmenu pick from maps.ini (stock
    # maps only); add the community maps from the maps stage.
    && printf '%s\n' fy_iceworld aim_map awp_india fy_pool_day cs_mansion ttt_mario_b1 >> addons/amxmodx/configs/maps.ini \
    # Metamod looks for the ReHLDS API in engine_i486.so; loading the GoldSrc
    # engine shipped with HLDS into the Xash3D process crashes it. Xash3D
    # doesn't use that file.
    && rm -f /opt/xash/xashds/engine_i486.so

# Copy default config
COPY apps/server/configs/valve valve
COPY apps/server/configs/cstrike cstrike
COPY --from=maps /game/ cstrike/

# Emperor Palpatine in place of SEAL Team 6 (urban): apps/server/player-models
# holds the CC BY 4.0 source (credits in palpatine/README.md) and
# gltf2mdl.py, which puts it on the stock urban.mdl from HLDS, keeping its
# skeleton, animations and hitboxes; the head is drawn 1.3 times as wide as
# the source's, which looked small on the stock body (the head hitbox is the
# stock one). portrait.py then renders the seven characters' team menu
# pictures (gfx/vgui/<name>.tga, read by apps/client/src/vgui-pictures.ts)
# from these models, holding the stock weapon models; Palpatine's gets more
# light and an edge light, as his black robe vanished on the menu's dark cards.
# The output joins the player-models
# stage's files, and resources.res is written again to list them (the web
# server sends those files to browsers, apps/server/maps.go).
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS player-models-converted

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-numpy \
    python3-pil \
    && rm -rf /var/lib/apt/lists/*

COPY --from=player-models /game/ /game/
COPY --from=hlds /opt/xash/xashds/cstrike/models/player/urban/urban.mdl /stock/urban.mdl
COPY --from=hlds /opt/xash/xashds/cstrike/models/p_m4a1.mdl /opt/xash/xashds/cstrike/models/p_ak47.mdl /stock/
COPY apps/server/player-models/ /src/
WORKDIR /src
RUN mkdir -p /game/models/player/urban \
    && python3 -B gltf2mdl.py --stock /stock/urban.mdl \
        --gltf palpatine/Unity2Skfb.gltf --texture palpatine/Darth_Sidious_D.jpeg \
        --name palpatine --head-width 1.3 --out /game/models/player/urban/urban.mdl \
    && chmod 644 /game/models/player/urban/urban.mdl \
    && mkdir -p /game/gfx/vgui \
    && for name in terror leet arctic guerilla urban sas gign; do \
        case $name in \
            urban|sas|gign) weapon=p_m4a1 seq=ref_aim_carbine ;; \
            *) weapon=p_ak47 seq=ref_aim_ak47 ;; \
        esac; \
        look=; [ $name = urban ] && look='--exposure 1.3 --rim 0.5'; \
        python3 -B portrait.py --model /game/models/player/$name/$name.mdl \
            --weapon /stock/$weapon.mdl --seq $seq $look --out /game/gfx/vgui/$name.tga || exit 1; \
    done \
    && chmod 644 /game/gfx/vgui/*.tga \
    && (cd /game && find models gfx -type f | sort > resources.res) \
    && chmod 644 /game/resources.res

# Compiles the server's own AMX Mod X plugins (apps/amxx/*.sma) with the
# compiler and includes from the same pinned AMXX archive. amxxpc is a 32-bit
# Linux program; CI builds linux/amd64, so add the i386 libraries it needs.
FROM debian:bookworm-slim AS amxx-plugins

RUN dpkg --add-architecture i386 \
    && apt-get update && apt-get install -y --no-install-recommends \
    libc6:i386 \
    libstdc++6:i386 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=hlds /opt/xash/xashds/cstrike/addons/amxmodx/scripting /scripting
COPY apps/amxx /src/amxx
WORKDIR /scripting
RUN mkdir /out \
    && for sma in /src/amxx/*.sma; do \
        out="/out/$(basename "$sma" .sma).amxx"; \
        ./amxxpc "$sma" -o"$out" && test -s "$out" || exit 1; \
    done

# The browser's game client, menu and server DLL (apps/cs16-client), built
# with Emscripten. The emsdk image is amd64-only; the output is wasm, the
# same on every platform. Dependencies first: they change less than the
# source.
FROM --platform=linux/amd64 emscripten/emsdk:4.0.11 AS cs16-client

WORKDIR /cs
COPY apps/cs16-client/3rdparty.txt /3rdparty.txt
COPY apps/cs16-client/patches/ /patches/
RUN grep -v '^#' /3rdparty.txt | while read -r path url commit; do \
        [ -n "$path" ] || continue; \
        mkdir -p "$path" \
        && git -C "$path" init -q \
        && git -C "$path" fetch -q --depth=1 "$url" "$commit" \
        && git -C "$path" checkout -q FETCH_HEAD \
        || exit 1; \
    done \
    && git -C 3rdparty/mainui_cpp apply /patches/mainui_cpp.patch
COPY apps/cs16-client/source/ .
# Only the three libraries the page loads (not pack_extras, which needs
# the folders 3rdparty.txt leaves out).
RUN emcmake cmake -S . -B build \
    && cmake --build build --config Release --target client menu regamedll \
    && mkdir -p /out/cl_dll /out/dlls \
    && mv build/cl_dll/client_emscripten_javascript.wasm /out/cl_dll/client_emscripten_wasm32.wasm \
    && mv build/3rdparty/mainui_cpp/menu_emscripten_javascript.wasm /out/cl_dll/menu_emscripten_wasm32.wasm \
    && mv build/3rdparty/ReGameDLL_CS/regamedll/cs_emscripten_javascript.wasm /out/dlls/cs_emscripten_wasm32.so

# Just the built files, for apps/cs16-client/dist on a development machine:
# docker build -f apps/server/Dockerfile --target cs16-client-dist --output apps/cs16-client/dist .
FROM scratch AS cs16-client-dist
COPY --from=cs16-client /out/ /

# The browser's Half-Life game client and server library (single player,
# apps/hlsdk-portable), built from FWGS/hlsdk-portable with the same emsdk.
# Pinned to August 2025, near the browser engine: from August 2026 the
# client links freevgui, which calls engine VGUI functions the browser engine
# (the xash3d-fwgs stage below, apps/xash3d-fwgs) doesn't have. VGUI is off
# here, so no submodule is needed.
FROM --platform=linux/amd64 emscripten/emsdk:4.0.11 AS hlsdk-portable
ARG HLSDK_REPO=https://github.com/FWGS/hlsdk-portable
ARG HLSDK_COMMIT=d0b128ec9dfc577b1069df9e4ffda5d891f83966
WORKDIR /hlsdk
COPY apps/hlsdk-portable/patches/ /patches/
RUN git init -q . \
    && git remote add origin "$HLSDK_REPO" \
    && git fetch -q --depth=1 origin "$HLSDK_COMMIT" \
    && git checkout -q FETCH_HEAD \
    && git apply /patches/*.patch
RUN emcmake cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --target client server \
    && mkdir -p /out/cl_dll /out/dlls \
    && mv build/cl_dll/client_emscripten_wasm32.wasm /out/cl_dll/ \
    && mv build/dlls/hl_emscripten_wasm32.wasm /out/dlls/hl_emscripten_wasm32.so

# For apps/hlsdk-portable/dist on a development machine:
# docker build -f apps/server/Dockerfile --target hlsdk-portable-dist --output apps/hlsdk-portable/dist .
FROM scratch AS hlsdk-portable-dist
COPY --from=hlsdk-portable /out/ /

# The Half-Life deathmatch server's game library (valve/dlls/hl.so, run by the
# hl-web-server compose service): the same commit and patches as the browser's
# client library above, built for 32-bit Linux like the engine, so the
# client's weapon prediction and messages match the server's code. Valve's
# hl.so from the HLDS archive is a later Steam build the SDK doesn't follow.
FROM debian:bookworm-slim AS hlsdk-portable-server
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git cmake make gcc-multilib g++-multilib \
    && apt-get clean
ARG HLSDK_REPO=https://github.com/FWGS/hlsdk-portable
ARG HLSDK_COMMIT=d0b128ec9dfc577b1069df9e4ffda5d891f83966
WORKDIR /hlsdk
COPY apps/hlsdk-portable/patches/ /patches/
RUN git init -q . \
    && git remote add origin "$HLSDK_REPO" \
    && git fetch -q --depth=1 origin "$HLSDK_COMMIT" \
    && git checkout -q FETCH_HEAD \
    && git apply /patches/*.patch
# hlsdk-portable adds -m32 itself on a 64-bit host (its 64BIT option is off).
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --target server -j"$(nproc)" \
    && mkdir -p /out \
    && cp build/dlls/hl.so /out/hl.so

# The browser engine (apps/xash3d-fwgs): Xash3D FWGS compiled to wasm with
# the same emsdk, as yohimik/webxash3d-fwgs builds its npm package
# xash3d-fwgs (packages/xash3d-fwgs/Dockerfile there). Pinned to the engine
# commit that package's 1.0.0 (npm gitHead fedcda8, the build the page shipped
# vendored until now) has as its submodule: yohimik/xash3d-fwgs 4cbc288,
# whose merge base with FWGS master is eeca965, hence its version
# 1.0.0+commit.eeca965. yohimik's repositories went private; FWGS serves the
# commit through GitHub's fork network and the full hash guarantees the same
# tree. Point XASH3D_WEB_REPO at a mirror you own to stop depending on that.
FROM --platform=linux/amd64 emscripten/emsdk:4.0.11 AS xash3d-fwgs-wasm
ARG XASH3D_WEB_REPO=https://github.com/FWGS/xash3d-fwgs
ARG XASH3D_WEB_COMMIT=4cbc288a28a6ae63fb70d8aba09319265bdcb085
WORKDIR /xash3d-fwgs
COPY apps/xash3d-fwgs/patches/ /patches/
RUN git init -q . \
    && git remote add origin "$XASH3D_WEB_REPO" \
    && git fetch -q --depth=1 origin "$XASH3D_WEB_COMMIT" \
    && git checkout -q FETCH_HEAD \
    && git submodule update --init --recursive \
    && for patch in /patches/*.patch; do \
        [ -e "$patch" ] || continue; \
        git apply "$patch" || exit 1; \
    done
ENV EMCC_CFLAGS="-s USE_SDL=2"
RUN emconfigure ./waf configure --emscripten \
    && emmake ./waf build \
    && mkdir -p /out/cl_dll \
    && mv build/3rdparty/mainui/libmenu.wasm /out/cl_dll/menu_emscripten_wasm32.wasm \
    && mv build/engine/xash.js /out/raw.js \
    && mv build/engine/xash.wasm /out/xash.wasm \
    && mv build/filesystem/filesystem_stdio.wasm /out/filesystem_stdio.wasm \
    && mv build/ref/gl/libref_gles3compat.wasm /out/libref_gles3compat.wasm \
    && mv build/ref/soft/libref_soft.wasm /out/libref_soft.wasm

# The package's TypeScript wrapper (apps/xash3d-fwgs/lib), compiled together
# with the engine's Emscripten glue patched into an ES module.
FROM --platform=$BUILDPLATFORM node:24-alpine AS xash3d-fwgs
WORKDIR /xash3d-fwgs
COPY apps/xash3d-fwgs/package.json apps/xash3d-fwgs/package-lock.json ./
RUN npm ci
COPY apps/xash3d-fwgs/tsconfig.json apps/xash3d-fwgs/tsconfig.build.json ./
COPY apps/xash3d-fwgs/scripts scripts
COPY apps/xash3d-fwgs/lib lib
COPY --from=xash3d-fwgs-wasm /out/ dist/
RUN npm run build:ts

# For apps/xash3d-fwgs/dist on a development machine:
# docker build -f apps/server/Dockerfile --target xash3d-fwgs-dist --output apps/xash3d-fwgs/dist .
FROM scratch AS xash3d-fwgs-dist
COPY --from=xash3d-fwgs /xash3d-fwgs/dist/ /

FROM --platform=$BUILDPLATFORM node:24-alpine AS client

# Same layout as the repository: package.json links ../cs16-client.
WORKDIR /apps/client

COPY apps/client/package.json package.json
COPY apps/client/package-lock.json package-lock.json
COPY apps/cs16-client/package.json ../cs16-client/package.json
COPY --from=cs16-client-dist / ../cs16-client/dist/
COPY apps/hlsdk-portable/package.json ../hlsdk-portable/package.json
COPY --from=hlsdk-portable-dist / ../hlsdk-portable/dist/
COPY apps/xash3d-fwgs/package.json ../xash3d-fwgs/package.json
COPY --from=xash3d-fwgs-dist / ../xash3d-fwgs/dist/
RUN npm ci
COPY apps/client/vite.config.ts vite.config.ts
COPY apps/client/tsconfig.json tsconfig.json
COPY apps/client/index.html index.html
COPY apps/client/public public
COPY apps/client/src src

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
COPY --from=player-models-converted /game/ ./cstrike/
COPY --from=go /src/xash ./xash
COPY --from=client /apps/client/dist ./public
COPY --from=engine /xash/build/filesystem/filesystem_stdio.so ./filesystem_stdio.so
COPY --from=amxx-plugins /out/ ./cstrike/addons/amxmodx/plugins/
COPY --from=hlsdk-portable-server /out/hl.so ./valve/dlls/hl.so

# The legacy HLDS archive includes old GCC runtime libraries in /xashds.
# Because /xashds is on LD_LIBRARY_PATH, they would override Debian's compatible
# 32-bit runtime pair and cannot satisfy the symbols required by the newer
# filesystem_stdio.so.
USER root
RUN rm -f /xashds/libstdc++.so.6 /xashds/libgcc_s.so.1
# YaPB saves each map's vistable and path matrix here; without write access
# it rebuilds them on every map load (minutes of CPU on a big map). A map
# without a graph (waypoints) gets one from YaPB's graph database, or its own
# analysis, saved in graph/; the community maps' graphs are in
# apps/server/configs/cstrike/addons/yapb/data/graph. Only the folder is chowned (new
# files), so the 2 MB of graphs in it aren't copied into another layer.
RUN cd /xashds/cstrike/addons/yapb/data \
    && chown -R xashds:xashds train logs pwf \
    && chmod -R u+rwX train logs pwf \
    && chown xashds:xashds graph \
    && chmod u+rwx graph \
    # The server writes BOT_QUOTA into yapb.cfg at startup (apps/server/bots.go).
    && chown xashds:xashds ../conf/yapb.cfg
# The ban list (apps/server/bans.go) and the leaderboard database
# (leaderboard.db, apps/server/statsdb.go) are saved here; mount a volume on it
# to keep them across container restarts. A new named volume copies this
# directory's owner.
RUN mkdir /xashds/data && chown xashds:xashds /xashds/data
# AMX Mod X writes its logs (log_amx) and data (stats, vaults) here; the
# archive leaves them owned by uid 999, so nothing was written.
RUN chown -R xashds:xashds /xashds/cstrike/addons/amxmodx/logs \
    /xashds/cstrike/addons/amxmodx/data
# The game's log files (log on, a new LMMDDNNN.log per map), which the
# leaderboard reads (apps/server/statsfollow.go). The engine writes them under
# the game folder, which isn't writable by xashds.
RUN mkdir /xashds/cstrike/logs && chown xashds:xashds /xashds/cstrike/logs
USER xashds

EXPOSE 27015/udp

# Start server
ENTRYPOINT ["./xash", "+ip", "0.0.0.0", "-port", "27015", "-game", "cstrike"]

# Default start parameters
CMD ["+map de_dust2", "+maxplayers", "16"]
