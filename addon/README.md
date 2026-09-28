# Guest Assistant as a Home Assistant app

Not tested on a real Supervisor yet. What the code does when it runs as an app
(detected by the `SUPERVISOR_TOKEN` variable):

- On first start it creates its own non-admin Home Assistant user through the
  Supervisor and stores only that user's token in `/data`. Nobody has to sign in.
- The admin page is served on the ingress port (8099) and only answers
  requests from the Supervisor (172.30.32.2). It reads the HA user from the
  `X-Remote-User-Id` header and lets only administrators in, because ingress
  also admits non-admin users.
- Guests use port 3001, which is not behind HA's login.
- Guest traffic goes directly to `homeassistant:<port>`; the Supervisor token is
  never used for it.

`config.yaml` here is the app manifest, not a configuration for the proxy.
