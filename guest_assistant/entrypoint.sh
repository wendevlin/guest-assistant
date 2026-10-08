#!/bin/sh
# Starts the proxy as the base image's unprivileged user `bun` (uid 1000).
#
# The Supervisor mounts /data owned by root, and earlier versions ran the proxy
# as root and left a root-owned database there. So, as root, hand the data
# directory and everything in it to `bun` (-h: change symlinks themselves,
# never what they point to), make it 0700 and drop privileges. Started as
# another user (docker run --user), the command just runs as that user.
set -e

if [ "$(id -u)" = 0 ]; then
  data_dir=${DATA_DIR:-/data}
  mkdir -p "$data_dir"
  chown -R -h bun:bun "$data_dir"
  chmod 700 "$data_dir"
  exec su-exec bun "$@"
fi
exec "$@"
