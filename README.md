# Guest Assistant

A guest-facing proxy in front of Home Assistant (HA). Guests log in to the
proxy with their own username and password and get exactly one HA dashboard.
They can see and control only the entities that appear on that dashboard.
Nothing else leaks through: not the states, not the history, not the cameras,
not the service calls.

```
Browser ──► guest-assistant (Bun) ──► Home Assistant
             own login (better-auth)     non-admin long-lived token
             default-deny proxy
```

## How it works

1. At start-up the proxy connects to HA with a **non-admin** long-lived token
   (admin tokens are refused), loads every configured dashboard and analyses
   it:
   - all referenced entity ids become the guest's allowlist,
   - markdown card templates and `media-source://` images are recorded verbatim,
   - the dashboard is **rejected** if it contains anything that cannot be
     analysed (see below). Users of a rejected dashboard cannot log in.
2. Dashboard edits in HA are picked up live (`lovelace_updated`); if a
   dashboard becomes invalid, its guests are disconnected immediately.
3. Every WebSocket command a guest sends is checked against a command table
   (`src/proxy/ws-commands.ts`). Unknown commands and unknown fields are
   rejected. Entity parameters must be inside the allowlist; HA's answers are
   filtered to the allowlist as well.
4. HTTP requests to HA are limited to an explicit route list
   (`src/proxy/http.ts`), each behind the guest's session. There is no
   catch-all.

### What a guest can do

| Area | Allowed |
|---|---|
| States | only entities on the dashboard (WS `get_states`, `subscribe_entities`, REST `/api/states`) |
| Service calls | `target.entity_id` ⊆ allowlist, service from a per-domain allowlist, `homeassistant.turn_on/off/toggle`; no `service_data.entity_id`, no area/device/label targets, no `all`, no templates |
| History, logbook, statistics | only for allowed entities, responses filtered |
| Cameras | stream, WebRTC and signed snapshot URLs for allowed cameras only |
| Templates | only markdown templates that appear verbatim in the dashboard; `variables` are fixed by the proxy |
| Registries | entity/device registries reduced to allowed entities and their devices |
| Config | location, URLs and Assist are hidden |

Everything else (`execute_script`, `search/related`, `tag/list`, media
browsing, energy, arbitrary REST paths, better-auth account management, …) is
denied.

If an entity is on the dashboard, every entity service of its domain is
allowed, including `lock.unlock` or `alarm_control_panel.alarm_disarm`.
Putting an entity on a guest dashboard **is** the permission grant.

### Dashboards that are rejected

| Rule | Why |
|---|---|
| `strategy` on dashboard or view level, or an auto-generated dashboard without saved config | cards are generated client-side from *all* states |
| `custom:*` cards, rows, badges, features | unknown semantics (e.g. `auto-entities`) |
| `area`, `iframe`, `energy-*` cards, `map` with `geo_location_sources` | show entities dynamically or embed foreign content |
| `logbook`, `history-graph`, `statistics-graph`, `statistic`, `map` without explicit `entities`/`entity` | would show everything |
| actions `navigate`/`url`; `call-service`/`perform-action` with `area_id`/`device_id`/`label_id`/`floor_id` or without an entity target | cannot be mapped to the allowlist |
| templates outside markdown `content` | cannot be allowlisted |
| picture card images that are not `media-source://`, `/local/`, `/api/image/serve/`, `http(s)://` or `data:` | unverifiable source |

Rejections are logged with the rule and the path inside the config.

Markdown templates are treated as trusted admin content. A template such as
`{{ states | list }}` in a guest markdown card deliberately reveals everything;
do not put such templates on guest dashboards.

## Configuration

`config.yaml` (see `config.example.yaml`):

```yaml
home-assistant:
  host: homeassistant.local
  port: 8123
  tls: false
  long_lived_access_token: "..."   # token of a NON-admin HA user

base_url: "http://tablet-proxy.local:3001"   # URL guests use (cookies, CSRF)
port: 3001

dashboards:
  - id: "guest-dashboard"          # url_path of the HA dashboard ("lovelace" = default)
    users:
      - username: "guest"
        password: "change-me"
```

Users are synced from the config on every start: created, updated (password or
dashboard change invalidates sessions) and removed when no longer listed.
Passwords are stored hashed in `data/guest-assistant.db`.

## Running

```
bun install
bun run start          # or: bun run dev (watch mode)
bun run typecheck
bun test
```

The guest frontend is served from `./public` or from
`frontend_development_repo` (a build of the HA guest frontend).

## Endpoints the frontend uses

- `POST /api/auth/sign-in/username`, `GET /api/auth/get-session`, `POST /api/auth/sign-out`
- `GET /api/auth/hass-token` → `{ access_token, refresh_token, expires_in, dashboard_url_path }`
- `WS /api/websocket` (HA-compatible handshake with the hass-token)
- `GET /api/states`, `/api/camera_proxy/:entity_id`, `/api/history/period…`, `/api/logbook…`, `/api/hls/*`, `/api/image/serve/*`, `/api/brands/*`
- `GET /static/*`, `/local/*`, `/hacsfiles/*` (public, as in HA)
