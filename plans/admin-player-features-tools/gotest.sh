#!/bin/bash
# Runs gofmt, vet and tests for src/server in the go-test image.
# The image was built before 8.2 added github.com/mattn/go-sqlite3, so the
# repo's go.mod / go.sum are copied in (with the image's replace line for the
# engine wrapper) and new modules are downloaded into a named volume.
# Build and module caches are kept in named volumes (the cgo SQLite build
# takes minutes under emulation the first time).
cd /Users/wcarasas/Repos/Walcc.CounterStrike
docker run --rm \
	-v "$PWD/src/server:/src/src/server" \
	-v "$PWD/go.mod:/host/go.mod:ro" -v "$PWD/go.sum:/host/go.sum:ro" \
	-v cs16-go-modcache:/go/pkg/mod -v cs16-go-buildcache:/root/.cache/go-build \
	local/cs16-go-test bash -c '
cp /host/go.mod /host/go.sum . &&
printf "\nreplace github.com/yohimik/goxash3d-fwgs => /github.com/yohimik/goxash3d-fwgs\n" >> go.mod &&
go mod download &&
gofmt -l src/server; go vet ./src/server/ && go test '"${1:-}"' ./src/server/...' 2>&1
