#!/bin/sh
# Prepares the diffs of a Home Assistant release for the release analysis
# (.github/workflows/ha-release-analysis.md), from a frontend-update pull
# request:
#
#   scripts/ha-release-diff.sh <pull request number> <output directory>
#
# Reads the versions from the pull request's body (lines "Core:",
# "Previous core:", "Frontend:", "Previous frontend:", written by
# frontend-update.yaml) and writes to the output directory:
#
#   versions.env               PR, CHANNEL, CORE_FROM/TO, FRONTEND_FROM/TO, or SKIP=<reason>
#   core.stat, core.diff       home-assistant/core between the two core releases
#   frontend.stat, frontend.diff  home-assistant/frontend between the two frontends
#   fork-files.txt             frontend files the guest-assistant fork changes
#
# Only the parts of Home Assistant the proxy depends on are diffed. Needs gh
# (GH_TOKEN) and network access to github.com. PR_BODY replaces the pull
# request's body, to try it without one.

set -e

pr=${1:?usage: scripts/ha-release-diff.sh <pull request> <output directory>}
out=${2:?usage: scripts/ha-release-diff.sh <pull request> <output directory>}
mkdir -p "$out"
out=$(cd "$out" && pwd)

CORE_PATHS="
homeassistant/auth
homeassistant/components/auth
homeassistant/components/calendar
homeassistant/components/camera
homeassistant/components/config
homeassistant/components/frontend
homeassistant/components/history
homeassistant/components/image
homeassistant/components/logbook
homeassistant/components/lovelace
homeassistant/components/map
homeassistant/components/media_player
homeassistant/components/media_source
homeassistant/components/mobile_app
homeassistant/components/recorder/websocket_api.py
homeassistant/components/template
homeassistant/components/todo
homeassistant/components/tts
homeassistant/components/update
homeassistant/components/weather
homeassistant/components/webhook
homeassistant/components/websocket_api
homeassistant/helpers/area_registry.py
homeassistant/helpers/condition.py
homeassistant/helpers/device_registry.py
homeassistant/helpers/entity_registry.py
homeassistant/helpers/floor_registry.py
homeassistant/helpers/label_registry.py
homeassistant/helpers/service.py
homeassistant/helpers/template
homeassistant/helpers/template.py
"
FRONTEND_PATHS="
src/data
src/panels/lovelace
src/external_app
src/dialogs/more-info
src/state-summary
"

body=${PR_BODY:-$(gh pr view "$pr" --json body --jq .body)}
field() { printf '%s\n' "$body" | sed -n "s/^$1: *\\([^ ]*\\) *\$/\\1/p" | head -n 1; }
channel=$(field Channel)
core_to=$(field Core)
core_from=$(field "Previous core")
frontend_to=$(field Frontend)
frontend_from=$(field "Previous frontend")

core=https://github.com/home-assistant/core.git
frontend=https://github.com/home-assistant/frontend.git

# Pins from before the channels do not name their core release: take the
# release before the new one in the same channel.
if [ -z "$core_from" ] || [ "$core_from" = unknown ]; then
  pattern='^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$'
  [ "$channel" = beta ] && pattern='^[0-9]{4}\.[0-9]{1,2}\.[0-9]+(b[0-9]+)?$'
  core_from=$(git ls-remote --tags --refs "$core" 'refs/tags/*' |
    sed 's|.*refs/tags/||' | grep -E "$pattern" |
    awk -F'[.b]' '{ rank = (NF == 4) ? $4 : 99999; printf "%04d.%02d.%04d.%05d %s\n", $1, $2, $3, rank, $0 }' |
    sort | awk -v to="$core_to" '$2 == to { print prev; exit } { prev = $2 }')
fi
if [ -z "$frontend_from" ] || [ "$frontend_from" = unknown ]; then
  frontend_from=$(curl -fsSL "https://raw.githubusercontent.com/home-assistant/core/$core_from/homeassistant/components/frontend/manifest.json" |
    sed -n 's/.*"home-assistant-frontend==\([0-9]\{8\}\.[0-9]*\)".*/\1/p')
fi

{
  echo "PR=$pr"
  echo "CHANNEL=$channel"
  echo "CORE_FROM=$core_from"
  echo "CORE_TO=$core_to"
  echo "FRONTEND_FROM=$frontend_from"
  echo "FRONTEND_TO=$frontend_to"
} > "$out/versions.env"

if [ -z "$core_to" ] || [ -z "$core_from" ] || [ -z "$frontend_to" ] || [ -z "$frontend_from" ]; then
  echo "SKIP=the pull request does not name the versions to compare" >> "$out/versions.env"
  exit 0
fi

# Partial, shallow fetches of the two tags only: blobs are fetched for the
# files the diff touches.
# diff_repo <name> <url> <from tag> <to tag> <paths>
diff_repo() {
  dir="$out/repo-$1"
  git init -q "$dir"
  git -C "$dir" fetch -q --depth=1 --filter=blob:none "$2" "refs/tags/$3:refs/tags/$3" "refs/tags/$4:refs/tags/$4"
  # shellcheck disable=SC2086 # the path lists are word lists
  git -C "$dir" diff --stat=200 "$3" "$4" -- $5 > "$out/$1.stat"
  # shellcheck disable=SC2086
  git -C "$dir" diff "$3" "$4" -- $5 > "$out/$1.diff"
}

diff_repo core "$core" "$core_from" "$core_to" "$CORE_PATHS"
diff_repo frontend "$frontend" "$frontend_from" "$frontend_to" "$FRONTEND_PATHS"
rm -rf "$out/repo-core"

# Files outside guest-assistant/ that the fork changes: its channel branch is
# built on the new frontend, so comparing the two trees is enough.
branch=guest-assistant
[ "$channel" = beta ] && branch=guest-assistant-beta
if git -C "$out/repo-frontend" fetch -q --depth=1 --filter=blob:none \
  https://github.com/wendevlin/guest-assistant-frontend.git "refs/heads/$branch:refs/heads/fork"; then
  git -C "$out/repo-frontend" diff --name-only "$frontend_to" fork |
    grep -v '^guest-assistant/' > "$out/fork-files.txt" || true
else
  echo "(could not read the fork's branch $branch)" > "$out/fork-files.txt"
fi
rm -rf "$out/repo-frontend"

wc -l "$out"/*.diff "$out"/*.stat "$out/fork-files.txt"
