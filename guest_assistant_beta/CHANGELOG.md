# Changelog

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

