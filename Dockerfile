# syntax=docker/dockerfile:1
# SteamCMD crashes under the QEMU i386 emulation used for the final image.
# This stage only produces game data, so run it natively on the builder.
FROM --platform=$BUILDPLATFORM cm2network/steamcmd:root AS gamefiles

RUN apt update && apt -y --no-install-recommends install zip

USER steam
RUN ./steamcmd.sh +force_install_dir /home/steam/gamefiles +login anonymous +app_update 90 +quit

WORKDIR /home/steam/gamefiles
RUN zip -r gamefiles.zip valve cstrike

# The CGO wrapper used to build this binary is no longer publicly available.
# Reuse the project's published server runtime instead of requiring credentials
# for a source repository consumers cannot access.
FROM ghcr.io/balintsoos/cs16-web-server:latest AS server-runtime

FROM debian:bookworm-slim AS hlds

ARG hlds_build=8308
ARG hlds_url="https://github.com/DevilBoy-eXe/hlds/releases/download/$hlds_build/hlds_build_$hlds_build.zip"

RUN groupadd -r xash && useradd -r -g xash -m -d /opt/xash xash
RUN usermod -a -G games xash

RUN apt-get -y update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
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

# Copy default config
COPY configs/valve valve
COPY configs/cstrike cstrike

FROM --platform=$BUILDPLATFORM node:24-alpine AS client

WORKDIR /client

COPY package.json package.json
COPY package-lock.json package-lock.json
COPY vendor/cs16-client-0.0.2.tgz vendor/cs16-client-0.0.2.tgz
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
COPY --from=server-runtime /xashds/xash ./xash
COPY --from=client /client/src/client/dist ./public
COPY --from=server-runtime /xashds/filesystem_stdio.so ./filesystem_stdio.so
COPY --from=gamefiles /home/steam/gamefiles/gamefiles.zip ./public/gamefiles.zip
EXPOSE 27015/udp

# Start server
ENTRYPOINT ["./xash", "+ip", "0.0.0.0", "-port", "27015", "-game", "cstrike"]

# Default start parameters
CMD ["+map de_dust2", "+maxplayers", "16"]
