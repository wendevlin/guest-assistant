# Changelog

## 0.10.0-beta.3

- The Guests tab of the admin page works on a phone in portrait: the
  dashboard moves under the username, so the switch and the buttons fit.
- Copying a login link works when the admin page is opened over plain http,
  and the link button shows a check mark once the link is copied.

## 0.10.0-beta.2

- The guest page is built on the Home Assistant 2026.10.4 frontend.
- Login links now sign guests in on the guest page.

## 0.10.0-beta.1

First beta of the coming 0.10.0. It includes everything from the 0.9.0 betas.

- Guests can get a login link on the Guests tab: it signs them in without
  username and password, as often as needed, while the account is active.
  "New link" or "Remove link" stops the old one. Turn it into a QR code with
  any QR tool. The link needs a guest page update that follows in a later
  beta; until then it opens the normal login.
- "Switch off automatically" on a guest switches the account off at a date
  and time you pick, for example after a babysitting evening. The guest is
  signed out right then.

## 0.9.0-beta.4

- The guest page is built on the Home Assistant 2026.10.1 frontend.

## 0.9.0-beta.3

- The guest page is built on the Home Assistant 2026.10.1 frontend.

## 0.9.0-beta.2

- Camera pictures, live streams and media player covers now show in the
  companion app too.
- The dashboard's menu in the companion app has "App settings", which opens
  the app's own settings, for example to switch to another server.

## 0.9.0-beta.1

First beta, the coming 0.9.0. It runs beside the stable app: own guests,
dashboards and Home Assistant user, guest port 3124 (Configuration tab).

- Guests can use the Home Assistant companion app. Switch on "Allow the
  companion app" on the Settings tab: guests then add Guest Assistant as a
  server in the app, sign in with their guest account and see their
  dashboard there. Sensors, location and notifications from the app are not
  used. It is off by default, because Guest Assistant then answers the app
  like a Home Assistant server would.
- Widgets, device controls and watch faces of the app can be allowed per
  dashboard (Dashboards tab, "Widgets in the companion app"). They only
  offer the entities of that dashboard.
- "Show in the app's server list on this network" announces Guest Assistant
  on the local network, so the app lists it under the app name. The
  Settings tab also shows a link that opens the app with Guest Assistant
  filled in.
- The Guests tab lists the phones a guest signed in with the app on; each
  one can be signed out there.
- The app uses host networking, which announcing on the local network
  needs. The guest port is set on the Configuration tab ("Guest port")
  instead of under "Network".
- A port that is already in use no longer crashes the app: the admin page
  and a notification in Home Assistant say which port and how to change it.

