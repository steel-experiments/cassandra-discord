#!/bin/sh
# Container entrypoint (Section 38.2).
#
# Railway and some Docker hosts mount new volumes as root. Start as root,
# make the data directory writable, then permanently drop privileges to the
# unprivileged `node` user before executing the application command.
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"

mkdir -p "$DATA_DIR"

if ! gosu node test -w "$DATA_DIR"; then
  chown -R node:node "$DATA_DIR"
fi

exec gosu node "$@"
