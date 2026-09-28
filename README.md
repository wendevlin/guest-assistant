# Guest Assistant

A guest-facing proxy in front of Home Assistant (HA). Guests log in to the
proxy with their own username and password and get exactly one HA dashboard.
They can see and control only the entities that appear on that dashboard.
Nothing else leaks through: not the states, not the history, not the cameras,
not the service calls.

```
Browser ──► guest-assistant (Bun) ──► Home Assistant
             own login (better-auth)     own non-admin HA user,
             default-deny proxy          created during set-up
             admin page (/admin/)
```

## How it works

1. The proxy connects to HA as its own **non-admin** user (admin tokens are
   refused), loads every guest dashboard and analyses it:
   - all referenced entity ids become the guest's allowlist,
   - markdown card templates and `media-source://` images are recorded verbatim,
   - the dashboard is **rejected** if it contains anything that cannot be
     analysed (see below). Users of a rejected dashboard cannot log in,
   - links, navigation and groupable media players become questions for the
     admin (see "Questions for the admin").
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
| Service calls | `target.entity_id` ⊆ allowlist, service from a per-domain allowlist, `homeassistant.turn_on/off/toggle` (without service data); no area/device/label targets, no `all`, no templates. Fields that point at other things are checked too: `media_player.join`/`unjoin` only if the admin allowed grouping for that player and `group_members` ⊆ allowlist, `play_media` only with `media-source://` ids written into the dashboard, no `variables` for `script.turn_on` / `automation.trigger` |
| History, logbook, statistics | only for allowed entities, responses filtered |
| Cameras | stream, WebRTC and signed snapshot URLs for allowed cameras only |
| Templates | only markdown templates that appear verbatim in the dashboard; `variables` are fixed by the proxy |
| Registries | entity/device registries reduced to allowed entities and their devices |
| Config | location, URLs and Assist are hidden |
| User data | never read from or written to the proxy's HA user: `language` is picked on the guest's device, `theme` comes from the dashboard settings on the admin page |

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
| dashboard visible to administrators only | the proxy's non-admin user cannot read it |
| `custom:*` cards, rows, badges, features | unknown semantics (e.g. `auto-entities`) |
| `area`, `iframe`, `energy-*` cards, `map` with `geo_location_sources` | show entities dynamically or embed foreign content |
| `logbook`, `history-graph`, `statistics-graph`, `statistic`, `map` without explicit `entities`/`entity` | would show everything |
| `call-service`/`perform-action` with `area_id`/`device_id`/`label_id`/`floor_id` or without an entity target | cannot be mapped to the allowlist |
| templates outside markdown `content` | cannot be allowlisted |
| picture card images that are not `media-source://`, `/local/`, `/api/image/serve/`, `http(s)://` or `data:` | unverifiable source |

Rejections are logged with the rule and the path inside the config.

Markdown templates are treated as trusted admin content. A template such as
`{{ states | list }}` in a guest markdown card deliberately reveals everything;
do not put such templates on guest dashboards.

## Setting up

There is no configuration file. Everything is managed on the admin page.

**Standalone** (Docker, a server next to HA, development):

1. Start the proxy. The log prints a one-time setup code and the admin page,
   `http://<proxy>:3001/admin/`.
2. Enter the code, then pick your Home Assistant. The proxy looks for
   instances on the network (zeroconf; needs host networking in Docker) and
   tries every address each one announces. You can also type an address.
3. Sign in to Home Assistant as an administrator. HA's normal OAuth login is
   used, so no app registration is needed.
4. The proxy creates its own **non-admin** HA user ("Guest Assistant"), mints
   a long-lived token for it and stores only that token. The admin's token is
   revoked right after the request, and so is the one-off login of the new
   user. On a local address the new user is `local_only`.
5. Add guest dashboards and guests.

Later admin logins go through Home Assistant's login again, and only HA
administrators get in. Admin sessions live in memory, so a restart asks you
to sign in again. "Connect a different Home Assistant" in the settings runs
steps 2 to 4 again and replaces the proxy's old HA user.

**As a Home Assistant app** the Supervisor token acts as administrator, so
set-up needs no input. The admin page is only reachable through ingress. See
`addon/README.md`; the packaging there is not tested on a real Supervisor yet.

**Upgrading from config.yaml:** on the first start with an empty database an
existing `config.yaml` is imported once (connection, dashboards, themes,
guests). After that the file is ignored and can be deleted.

### Questions for the admin

Some things on a dashboard cannot be decided by the proxy. They do not
reject the dashboard. Instead they show up on the admin page as questions,
and until they are answered the restrictive choice applies:

| On the dashboard | Until answered | Options |
|---|---|---|
| `navigate` to a view of the same dashboard | works (all views are part of the analysis) | acknowledge |
| `navigate` anywhere else | removed for guests (they cannot open other pages) | acknowledge |
| `url` action (opens a web page) | removed for guests | allow, block |
| media player that supports grouping | no `media_player.join`/`unjoin` | allow grouping with players on this dashboard, no grouping |

Blocked actions are replaced by `action: none` in the config guests receive.
When a dashboard edit in HA adds something new, it is blocked right away, and
the admin gets a persistent notification in HA until they answer.

### Start-up settings

A few settings are environment variables (Bun also reads a `.env` file, see
`.env.example`):

| Variable | Default | |
|---|---|---|
| `PORT` | `3001` | guest port; standalone, the admin page is under `/admin/` |
| `DATA_DIR` | `data` (`/data` as an app) | SQLite database |
| `GUEST_ASSISTANT_FRONTEND_REPO` | | serve the guest frontend from a `guest-assistant-frontend` checkout instead of `./public` |
| `CONFIG_FILE` | `config.yaml` | old config file to import once |
| `INGRESS_PORT` | `8099` | admin page as an app |
| `ADMIN_UI_DIR` | `admin-ui/dist` | built admin page |

Guests change their language (and, if allowed, light/dark mode) in the
settings dialog; the choice is stored on their device only.

## Running

```
bun install            # installs the proxy and the admin-ui workspace
bun run build:admin    # builds the admin page into admin-ui/dist
bun run start          # or: bun run dev (rebuilds the admin page and restarts the proxy on changes)
bun run typecheck      # tsc for the proxy, svelte-check for the admin page
bun test
```

The guest frontend is served from `./public`, or, like HA core's
`development_repo`, from a frontend checkout: set
`GUEST_ASSISTANT_FRONTEND_REPO` to the root of the sibling repository
`guest-assistant-frontend` (a fork of the Home Assistant frontend) and the
proxy serves its `guest-assistant/dist`. `guest-assistant/script/develop`
there builds into that directory.

The admin page lives in `admin-ui/`: Svelte 5 with shadcn-svelte components,
built by Bun alone (`admin-ui/build.ts` with `bun-plugin-svelte` and
`bun-plugin-tailwind`, no Vite, no SvelteKit). Its output uses relative URLs,
so it works under `/admin/` and behind HA's ingress prefix. The proxy serves
the built files from `admin-ui/dist` (`ADMIN_UI_DIR`). Add components with
`bunx shadcn-svelte@latest add <name>` inside `admin-ui/`; bits-ui state
attributes are mapped to the components' `data-*` variants in `src/app.css`.

## Endpoints the frontend uses

- Admin page: `/admin/` and its JSON API under `/admin/api/` (mutating calls need the header `x-guest-assistant: 1`)
- `POST /api/auth/sign-in/username`, `GET /api/auth/get-session`, `POST /api/auth/sign-out`
- `GET /api/auth/hass-token` → `{ access_token, refresh_token, expires_in, dashboard_url_path }`
- `WS /api/websocket` (HA-compatible handshake with the hass-token)
- `GET /api/states`, `/api/camera_proxy/:entity_id`, `/api/history/period…`, `/api/logbook…`, `/api/hls/*`, `/api/image/serve/*`, `/api/brands/*`
- `GET /static/*`, `/local/*`, `/hacsfiles/*` (public, as in HA)
