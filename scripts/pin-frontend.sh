#!/bin/sh
# Pins the guest frontend that CI puts into the app image: writes the release
# name to .github/frontend-release and the SHA-256 of its asset to
# .github/frontend-release.sha256 (sha256sum format). CI refuses an asset with
# another hash, so a release asset replaced later cannot reach the image.
#
# The hash is taken from what GitHub serves right now. Pin a release you know
# (built from the guest-assistant branch of wendevlin/guest-assistant-frontend)
# and commit both files together.
#
# Usage: scripts/pin-frontend.sh <release>   (e.g. 2026.10.01-a43d77ee5)

set -e

cd "$(dirname "$0")/.."

release=${1:?usage: scripts/pin-frontend.sh <release tag of wendevlin/guest-assistant-frontend>}
case $release in
  *[!A-Za-z0-9._-]*) echo "Not a release tag: $release" >&2; exit 1 ;;
esac
asset=guest-assistant-frontend.tar.gz

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$asset" "https://github.com/wendevlin/guest-assistant-frontend/releases/download/$release/$asset"
tar -tzf "$tmp/$asset" >/dev/null

if command -v sha256sum >/dev/null; then
  sum=$(sha256sum "$tmp/$asset")
else
  sum=$(shasum -a 256 "$tmp/$asset")
fi
hash=${sum%% *}

printf '%s\n' "$release" > .github/frontend-release
printf '%s  %s\n' "$hash" "$asset" > .github/frontend-release.sha256
echo "Pinned the guest frontend $release ($asset, SHA-256 $hash)"
