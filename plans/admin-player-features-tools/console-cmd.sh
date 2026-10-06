#!/bin/bash
# usage: cmd.sh <name> "<command>"
docker exec $1 bash -c "echo '$2' > /tmp/in"
