# Guest Assistant as a Home Assistant app

## Install as a local app

1. On the development machine run `scripts/build-addon.sh`. It builds the
   guest frontend (production build, from the committed `guest-assistant`
   branch of guest-assistant-frontend) and the admin page, and packages
   everything into `dist/addon/guest_assistant/`.
2. Copy that folder into the `addons` share of the HA machine (Samba app):
   `\\homeassistant.local\addons\guest_assistant\` (four files: `config.yaml`,
   `Dockerfile`, `README.md`, `app.tar.gz`).
3. In HA: Settings > Apps > App store > ⋮ > Check for updates. "Guest
   Assistant" appears under "Local apps". Install it; the Supervisor builds
   the image on the device (only `bun install` of the runtime dependencies,
   the frontend is already built).
4. Start it. The admin page opens from the sidebar ("Guest Assistant", admins
   only). Guests use `http://<ha-host>:3001`. To use another port, change it on the
   app's Configuration tab under "Network" and restart the app.

To update: run the script again, copy the folder over the old one, then
"Rebuild" on the app page (or raise `version` in `config.yaml` and use
"Update").

## What the code does as an app

Detected by the `SUPERVISOR_TOKEN` variable:

- On first start it creates its own non-admin Home Assistant user through the
  Supervisor and stores only that user's token in `/data`. Nobody has to sign in.
- The admin page is served on the ingress port (8099) and only answers
  requests from the Supervisor (172.30.32.2). It reads the HA user from the
  `X-Remote-User-Id` header and lets only administrators in, because ingress
  also admits non-admin users.
- Guests use port 3001 (the host port is configurable under "Network"), which
  is not behind HA's login.
- Guest traffic goes directly to `homeassistant:<port>`; the Supervisor token is
  never used for it.

`config.yaml` here is the app manifest, not a configuration for the proxy.
