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
COPY --from=go /src/xash ./xash
COPY --from=client /client/src/client/dist ./public
COPY --from=engine /xash/build/filesystem/filesystem_stdio.so ./filesystem_stdio.so

# The legacy HLDS archive includes old GCC runtime libraries in /xashds.
# Because /xashds is on LD_LIBRARY_PATH, they would override Debian's compatible
# 32-bit runtime pair and cannot satisfy the symbols required by the newer
# filesystem_stdio.so.
USER root
RUN rm -f /xashds/libstdc++.so.6 /xashds/libgcc_s.so.1
USER xashds

EXPOSE 27015/udp

# Start server
ENTRYPOINT ["./xash", "+ip", "0.0.0.0", "-port", "27015", "-game", "cstrike"]

# Default start parameters
CMD ["+map de_dust2", "+maxplayers", "16"]
