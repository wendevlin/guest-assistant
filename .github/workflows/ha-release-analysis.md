---
description: Checks what a new Home Assistant release changes for Guest Assistant and comments on the frontend pin pull request
on:
  pull_request:
    types: [labeled, synchronize]
  workflow_dispatch:
    inputs:
      pull_request:
        description: Number of the frontend-update pull request to analyse
        required: true
        type: string
# Only the pin pull requests of frontend-update.yaml (label frontend-update).
if: github.event_name == 'workflow_dispatch' || contains(github.event.pull_request.labels.*.name, 'frontend-update')
concurrency:
  group: "ha-release-analysis-${{ github.event.pull_request.number || inputs.pull_request }}"
  cancel-in-progress: true
  job-discriminator: ${{ github.event.pull_request.number || inputs.pull_request }}
engine: copilot
timeout-minutes: 45
max-ai-credits: 1500
permissions:
  contents: read
  pull-requests: read
  # A personal repository: inference runs on the COPILOT_GITHUB_TOKEN secret
  # (a token of the owner with "Copilot Requests: Read"), not on org billing.
  copilot-requests: none
# The diffs are prepared in steps: below, outside the sandbox; the agent
# only reads files.
network: defaults
tools:
  bash: ["cat", "head", "tail", "grep", "wc", "ls", "sed", "awk", "sort", "uniq", "find"]
  github:
    toolsets: [pull_requests]
safe-outputs:
  add-comment:
    target: "*"
    required-labels: [frontend-update]
    hide-older-comments: true
    max: 1
steps:
  - name: Prepare the Home Assistant diffs
    env:
      GH_TOKEN: ${{ github.token }}
      PR: ${{ github.event.pull_request.number || inputs.pull_request }}
    run: scripts/ha-release-diff.sh "$PR" /tmp/gh-aw/ha-release
---

# Home Assistant release analysis for Guest Assistant

Guest Assistant is a default-deny proxy in front of Home Assistant (HA): guests
get exactly one dashboard and may only see and control the entities on it. It
ships a fork of the HA frontend. A pull request with the label
`frontend-update` moves an app to the frontend of a newer HA release. Your job
is to find what that HA release changes that Guest Assistant must react to,
before the pull request is merged.

You do not change code. You post one comment on the pull request.

## Inputs

Everything is prepared in `/tmp/gh-aw/ha-release/`:

- `versions.env`: `PR`, `CHANNEL`, `CORE_FROM`, `CORE_TO`, `FRONTEND_FROM`, `FRONTEND_TO`.
- `core.stat`, `core.diff`: `git diff CORE_FROM..CORE_TO` of home-assistant/core,
  limited to the parts the proxy depends on.
- `frontend.stat`, `frontend.diff`: the same for home-assistant/frontend between
  the two frontend versions.
- `fork-files.txt`: files of the HA frontend that the Guest Assistant fork changes.

If `versions.env` says `SKIP=…`, post a comment that says the analysis was
skipped and why, and stop. The diffs can be large: start from the `.stat`
files and use `grep -n` on the `.diff` files to read the relevant hunks.

The proxy's code is the checked-out repository. The parts that decide what a
guest gets:

- `src/proxy/ws-commands.ts`: `COMMANDS` (allowed WebSocket commands and their
  allowed fields; unknown commands and fields are rejected), `ENTITY_SERVICES`
  (services per domain), `SERVICE_DATA_CHECKS` (service fields that point at
  other entities or media), `ALLOWED_EVENT_TYPES`.
- `src/proxy/ws-filters.ts`: filters HA's answers. Entities are filtered by an
  allowlist, but **fields are removed by denylists**: `scrubEntityEntry`
  (deletes `unique_id`), `DEVICE_SENSITIVE_KEYS`, `LOGBOOK_CONTEXT_KEYS`,
  `scrubConfig` (`get_config`), `HIDDEN_COMPONENTS`. A field HA adds to one of
  these answers reaches guests unless it is added there.
- `src/proxy/http.ts`: the allowed HTTP routes.
- `src/dashboard/validate.ts`: what is hidden from guests. Also denylists:
  `DYNAMIC_CARD_TYPES`, `NEEDS_ENTITIES`, `IMAGE_PREFIXES`,
  `NON_ENTITY_TARGET_KEYS`; `custom:` cards and templates outside markdown are
  hidden. A new card type that picks entities on its own is not hidden.
- `src/dashboard/extract.ts`: `ENTITY_KEYS`, the config keys whose values are
  collected as the guest's allowed entities.
- `src/companion/`: the endpoints of the HA companion apps (`mobile_app`
  webhook, `auth`), answered by the proxy for guests.

## Checklist, in this order

1. **New fields in answers of allowed commands.** Registries
   (`entity_registry`, `device_registry`, `area_registry`, `floor_registry`),
   `get_config`, `get_states`/attributes, `history`, `logbook`, `recorder`
   statistics, `camera`, `todo`, `weather`, `update`. Would the new field reach
   guests through a denylist filter, and does it reveal something about the
   home that is not on the dashboard (identifiers, other entities, users,
   locations, URLs)?
2. **Dashboard config.** New card, badge, row, feature or picture element
   types and new config keys: do they pick entities at runtime, hold templates
   outside markdown `content`, reference entities under a key that is not in
   `ENTITY_KEYS`, or bring new action or target kinds (`area_id`-like
   targets, new `action:` values)?
3. **Services.** New services or service fields in domains of
   `ENTITY_SERVICES` that reference other entities, areas, devices or media.
4. **What the frontend now calls.** New WebSocket commands, subscriptions or
   HTTP routes that the dashboard, cards or more-info dialogs use. These are
   rejected by the proxy (safe), but the feature is broken for guests.
5. **Companion apps.** Changes to `mobile_app` (webhook commands,
   registration, `get_config`), `auth` (token flow, `login_flow`) and the
   frontend's external app bridge (`src/external_app/`).
6. **The fork.** Upstream changes to files in `fork-files.txt` that the next
   merge will have to reconcile.

Report only what you verified in the diffs and the proxy's code; quote the
file and line. Do not list unrelated changes.

## Comment

Post exactly one comment on pull request `PR` with this layout:

```
### Home Assistant CORE_FROM → CORE_TO (frontend FRONTEND_FROM → FRONTEND_TO)

**Blocks the release: N** · **Needs a proxy change: N** · **For information: N**

| # | Finding | Where (HA) | Proxy | Rating | Suggestion |
|---|---------|------------|-------|--------|------------|
| 1 | … | `homeassistant/components/…:123` | `src/proxy/ws-filters.ts` `scrubEntityEntry` | Blocks the release | … |
```

Ratings:

- **Blocks the release**: guests would see or control something that is not
  on their dashboard, or a guest dashboard stops working entirely.
- **Needs a proxy change**: a feature is broken or degraded for guests, or a
  denylist should be extended, without exposing anything.
- **For information**: worth knowing, nothing to do.

End with a short paragraph on how sure you are and what you could not check.
If nothing applies, say so in one line and keep the counts at 0.
