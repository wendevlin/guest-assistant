#!/bin/sh
# Packages Guest Assistant as a local Home Assistant app (add-on):
#   dist/addon/guest_assistant/
# Copy that folder into the `addons` share of the HA machine (Samba app), then
# Settings > Apps > App store > ⋮ > Check for updates, and install
# "Guest Assistant" from "Local apps". The Supervisor builds the image there.
#
# The guest frontend and the admin page are built here, because building the
# HA frontend needs far more memory and time than an HA Green has. The image
# on the device only installs the runtime dependencies.
#
# The guest frontend is built from the committed HEAD of the
# guest-assistant-frontend branch `guest-assistant` in a separate worktree
# (.build/frontend), so a running `script/develop*` in the checkout is not
# disturbed. Uncommitted frontend changes are not included.
#
# Usage: scripts/build-addon.sh [--skip-frontend | --frontend DIR]
#   --skip-frontend  reuse the frontend built by the previous run
#   --frontend DIR   use an already built guest frontend (e.g. the unpacked
#                    release asset of guest-assistant-frontend, as in CI)

set -e

cd "$(dirname "$0")/.."
ROOT=$(pwd)

OUT="$ROOT/dist/addon/guest_assistant"

if [ "$1" = "--frontend" ]; then
  FRONTEND_DIST=$(cd "${2:?--frontend needs a directory}" && pwd)
else
  if [ -z "$GUEST_ASSISTANT_FRONTEND_REPO" ] && [ -f .env ]; then
    GUEST_ASSISTANT_FRONTEND_REPO=$(sed -n 's/^GUEST_ASSISTANT_FRONTEND_REPO=//p' .env)
  fi
  FRONTEND_REPO=$(cd "${GUEST_ASSISTANT_FRONTEND_REPO:?set GUEST_ASSISTANT_FRONTEND_REPO to the guest-assistant-frontend checkout}" && pwd)
  WORKTREE="$ROOT/.build/frontend"
  FRONTEND_DIST="$WORKTREE/guest-assistant/dist"

  if [ "$1" != "--skip-frontend" ]; then
    if [ ! -d "$WORKTREE" ]; then
      git -C "$FRONTEND_REPO" worktree add --detach "$WORKTREE" guest-assistant
    else
      git -C "$WORKTREE" checkout --detach guest-assistant
    fi
    # Share the checkout's dependencies instead of installing them a second time.
    [ -e "$WORKTREE/node_modules" ] || ln -s "$FRONTEND_REPO/node_modules" "$WORKTREE/node_modules"
    echo "Building the guest frontend from $(git -C "$WORKTREE" log -1 --format='%h %s')"
    "$WORKTREE/guest-assistant/script/build_guest_assistant"
  fi
fi
[ -f "$FRONTEND_DIST/index.html" ] || { echo "No frontend build in $FRONTEND_DIST, run without --skip-frontend" >&2; exit 1; }

bun run build:admin

rm -rf "$OUT"
mkdir -p "$OUT/app/admin-ui"
# Without `image` the Supervisor builds the Dockerfile instead of pulling the release image.
grep -v '^image:' guest_assistant/config.yaml > "$OUT/config.yaml"
cp guest_assistant/Dockerfile guest_assistant/entrypoint.sh guest_assistant/README.md guest_assistant/DOCS.md guest_assistant/icon.png guest_assistant/logo.png "$OUT/"
cp -r package.json bun.lock tsconfig.json src "$OUT/app/"
cp admin-ui/package.json "$OUT/app/admin-ui/"
cp -r admin-ui/dist "$OUT/app/admin-ui/dist"
cp -r "$FRONTEND_DIST" "$OUT/app/public"

# One archive instead of ~2800 files: copying that many small files over Samba
# fails half-way too easily, and the Supervisor then sees a broken app folder.
# The Dockerfile unpacks it with ADD, which keeps the owners in the archive:
# make them root, so the proxy (user `bun`, uid 1000) cannot change its code.
if tar --version 2>/dev/null | grep -q GNU; then
  tar -C "$OUT/app" --owner=0 --group=0 --numeric-owner -czf "$OUT/app.tar.gz" .
else
  tar -C "$OUT/app" --uid 0 --gid 0 -czf "$OUT/app.tar.gz" .
fi
rm -rf "$OUT/app"

echo "Packaged $(sed -n 's/^version: *//p' guest_assistant/config.yaml | tr -d '"') in $OUT ($(du -sh "$OUT" | cut -f1))"
