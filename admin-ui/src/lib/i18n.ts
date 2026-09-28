const en = {
  title: "Guest Assistant",
  subtitle: "Admin",
  loading: "Loading…",
  retry: "Try again",
  cancel: "Cancel",
  save: "Save",
  saved: "Saved",
  close: "Close",
  delete: "Delete",
  add: "Add",
  back: "Back",
  logout: "Sign out",
  signed_in_as: "Signed in as {name}",

  "setup.code.title": "Set up Guest Assistant",
  "setup.code.intro": "To make sure you are the one setting up this proxy, enter the setup code. It is printed in the log of Guest Assistant.",
  "setup.code.label": "Setup code",
  "setup.code.submit": "Continue",
  "setup.connect.title": "Connect Home Assistant",
  "setup.connect.intro":
    "Pick your Home Assistant. You sign in there as an administrator once. Guest Assistant then creates its own Home Assistant user without admin rights and uses only that one. Your admin login is not stored.",
  "setup.connect.searching": "Searching the network…",
  "setup.connect.none": "No Home Assistant found on the network. Enter its address below.",
  "setup.connect.found": "Found on the network",
  "setup.connect.unreachable": "Not reachable from Guest Assistant under any announced address.",
  "setup.connect.manual": "Or enter the address",
  "setup.connect.url": "Home Assistant URL",
  "setup.connect.url_hint": "For example http://homeassistant.local:8123",
  "setup.connect.submit": "Sign in with Home Assistant",
  "setup.connect.search_again": "Search again",
  "setup.app.title": "Setting up",
  "setup.app.intro": "Guest Assistant is creating its own Home Assistant user.",

  "login.title": "Sign in",
  "login.intro": "Sign in with a Home Assistant administrator account.",
  "login.submit": "Sign in with Home Assistant",
  "login.not_admin": "Only Home Assistant administrators can open this page.",

  "tabs.dashboards": "Dashboards",
  "tabs.guests": "Guests",
  "tabs.settings": "Settings",

  "conn.connected": "Connected",
  "conn.connecting": "Connecting",
  "conn.error": "Not connected",
  "conn.unconfigured": "Not set up",

  "dash.intro":
    "A guest dashboard is a permission: guests see and control exactly the entities on it. Dashboards with cards that cannot be analysed are rejected.",
  "dash.empty": "No guest dashboards yet.",
  "dash.add": "Add dashboard",
  "dash.add_title": "Add a guest dashboard",
  "dash.pick": "Dashboard",
  "dash.pick_placeholder": "Choose a dashboard",
  "dash.admin_only": "admins only",
  "dash.analysing": "Analysing…",
  "dash.none_available": "All dashboards are already added.",
  "dash.status.ok": "Active",
  "dash.status.rejected": "Rejected",
  "dash.status.loading": "Loading",
  "dash.entities": "Entities: {count}",
  "dash.guests": "Guests: {count}",
  "dash.pending": "Open: {count}",
  "dash.violations": "Why it is rejected",
  "dash.violations_hint": "Guests of this dashboard cannot sign in until these cards are changed in Home Assistant.",
  "dash.questions": "Your decisions",
  "dash.questions_hint": "Until you decide, the restrictive choice applies.",
  "dash.no_questions": "Nothing to decide on this dashboard.",
  "dash.theme": "Look",
  "dash.remove": "Remove dashboard",
  "dash.remove_confirm": "Remove {name}? Its {count} guest accounts are deleted as well.",
  "dash.new": "New",

  "q.navigate_view": "Navigation to {subject} opens another view of this dashboard. Guests can use it.",
  "q.navigate_outside": "Navigation to {subject} leads outside this dashboard. Guests cannot open that page, so the action is removed for them.",
  "q.url": "A card opens the web page {subject}.",
  "q.media_group": "{subject} can be grouped with other media players.",
  "q.opt.ok": "Understood",
  "q.opt.allow": "Allow",
  "q.opt.block": "Block",
  "q.opt.dashboard": "Allow grouping with players on this dashboard",
  "q.opt.none": "No grouping",

  "theme.name": "Theme",
  "theme.default": "Home Assistant default",
  "theme.mode": "Mode",
  "theme.mode.auto": "Auto (follow the device)",
  "theme.mode.light": "Light",
  "theme.mode.dark": "Dark",
  "theme.switch": "Guests can switch light/dark",
  "theme.switch.yes": "Yes",
  "theme.switch.no": "No",

  "guests.intro": "Guests sign in with these accounts. Each account belongs to one dashboard.",
  "guests.empty": "No guests yet.",
  "guests.no_dashboards": "Add a guest dashboard first.",
  "guests.add": "Add guest",
  "guests.username": "Username",
  "guests.password": "Password",
  "guests.new_password": "New password",
  "guests.new_password_hint": "Leave empty to keep the current password.",
  "guests.generate": "Generate",
  "guests.dashboard": "Dashboard",
  "guests.edit": "Edit",
  "guests.delete_confirm": "Delete the guest {name}?",
  "guests.created": "Guest {name} created. Password: {password}",

  "settings.ha": "Home Assistant",
  "settings.url": "Address",
  "settings.state": "Status",
  "settings.version": "Version",
  "settings.configured_by": "Set up by",
  "settings.reconnect": "Connect a different Home Assistant",
  "settings.reconnect_hint": "Or the same one again, to create a new Guest Assistant user there.",
  "settings.renew": "Recreate the Guest Assistant user",
  "settings.renew_hint": "Creates a new non-admin user for Guest Assistant in Home Assistant and removes the old one.",
  "settings.public_url": "Guest address",
  "settings.public_url_hint": "The address guests open, e.g. https://guests.example.com. With https, cookies are marked secure. Optional.",
  "settings.guest_link": "Guests open",
  "confirm": "Confirm",
  "dash.collapse": "Collapse",
  "dash.expand": "Show details",
  language: "Language",
};

export type Key = keyof typeof en;

const de: Partial<Record<Key, string>> = {
  subtitle: "Verwaltung",
  loading: "Lädt…",
  retry: "Erneut versuchen",
  cancel: "Abbrechen",
  save: "Speichern",
  saved: "Gespeichert",
  close: "Schließen",
  delete: "Löschen",
  add: "Hinzufügen",
  back: "Zurück",
  logout: "Abmelden",
  signed_in_as: "Angemeldet als {name}",

  "setup.code.title": "Guest Assistant einrichten",
  "setup.code.intro": "Damit nur du diesen Proxy einrichten kannst, gib den Setup-Code ein. Er steht im Log von Guest Assistant.",
  "setup.code.label": "Setup-Code",
  "setup.code.submit": "Weiter",
  "setup.connect.title": "Home Assistant verbinden",
  "setup.connect.intro":
    "Wähle dein Home Assistant. Du meldest dich dort einmal als Administrator an. Guest Assistant legt dann einen eigenen Home-Assistant-Benutzer ohne Admin-Rechte an und verwendet nur diesen. Dein Admin-Login wird nicht gespeichert.",
  "setup.connect.searching": "Suche im Netzwerk…",
  "setup.connect.none": "Kein Home Assistant im Netzwerk gefunden. Gib die Adresse unten ein.",
  "setup.connect.found": "Im Netzwerk gefunden",
  "setup.connect.unreachable": "Unter keiner angekündigten Adresse von Guest Assistant aus erreichbar.",
  "setup.connect.manual": "Oder Adresse eingeben",
  "setup.connect.url": "Home-Assistant-Adresse",
  "setup.connect.url_hint": "Zum Beispiel http://homeassistant.local:8123",
  "setup.connect.submit": "Mit Home Assistant anmelden",
  "setup.connect.search_again": "Erneut suchen",
  "setup.app.title": "Einrichtung läuft",
  "setup.app.intro": "Guest Assistant legt seinen eigenen Home-Assistant-Benutzer an.",

  "login.title": "Anmelden",
  "login.intro": "Melde dich mit einem Home-Assistant-Administrator-Konto an.",
  "login.submit": "Mit Home Assistant anmelden",
  "login.not_admin": "Nur Home-Assistant-Administratoren können diese Seite öffnen.",

  "tabs.dashboards": "Dashboards",
  "tabs.guests": "Gäste",
  "tabs.settings": "Einstellungen",

  "conn.connected": "Verbunden",
  "conn.connecting": "Verbinde",
  "conn.error": "Nicht verbunden",
  "conn.unconfigured": "Nicht eingerichtet",

  "dash.intro":
    "Ein Gast-Dashboard ist eine Berechtigung: Gäste sehen und steuern genau die Entitäten darauf. Dashboards mit Karten, die sich nicht analysieren lassen, werden abgelehnt.",
  "dash.empty": "Noch keine Gast-Dashboards.",
  "dash.add": "Dashboard hinzufügen",
  "dash.add_title": "Gast-Dashboard hinzufügen",
  "dash.pick": "Dashboard",
  "dash.pick_placeholder": "Dashboard wählen",
  "dash.admin_only": "nur Admins",
  "dash.analysing": "Wird analysiert…",
  "dash.none_available": "Alle Dashboards sind schon hinzugefügt.",
  "dash.status.ok": "Aktiv",
  "dash.status.rejected": "Abgelehnt",
  "dash.status.loading": "Lädt",
  "dash.entities": "Entitäten: {count}",
  "dash.guests": "Gäste: {count}",
  "dash.pending": "Offen: {count}",
  "dash.violations": "Warum es abgelehnt wird",
  "dash.violations_hint": "Gäste dieses Dashboards können sich nicht anmelden, bis diese Karten in Home Assistant geändert sind.",
  "dash.questions": "Deine Entscheidungen",
  "dash.questions_hint": "Solange du nicht entscheidest, gilt die restriktive Variante.",
  "dash.no_questions": "Bei diesem Dashboard gibt es nichts zu entscheiden.",
  "dash.theme": "Aussehen",
  "dash.remove": "Dashboard entfernen",
  "dash.remove_confirm": "{name} entfernen? Die {count} Gastkonten werden ebenfalls gelöscht.",
  "dash.new": "Neu",

  "q.navigate_view": "Die Navigation zu {subject} öffnet eine andere Ansicht dieses Dashboards. Gäste können sie verwenden.",
  "q.navigate_outside": "Die Navigation zu {subject} führt aus diesem Dashboard hinaus. Gäste können diese Seite nicht öffnen, daher wird die Aktion für sie entfernt.",
  "q.url": "Eine Karte öffnet die Webseite {subject}.",
  "q.media_group": "{subject} kann mit anderen Media-Playern gruppiert werden.",
  "q.opt.ok": "Verstanden",
  "q.opt.allow": "Erlauben",
  "q.opt.block": "Blockieren",
  "q.opt.dashboard": "Gruppieren mit Playern dieses Dashboards erlauben",
  "q.opt.none": "Nicht gruppieren",

  "theme.name": "Theme",
  "theme.default": "Home-Assistant-Standard",
  "theme.mode": "Modus",
  "theme.mode.auto": "Automatisch (wie das Gerät)",
  "theme.mode.light": "Hell",
  "theme.mode.dark": "Dunkel",
  "theme.switch": "Gäste können hell/dunkel umschalten",
  "theme.switch.yes": "Ja",
  "theme.switch.no": "Nein",

  "guests.intro": "Mit diesen Konten melden sich Gäste an. Jedes Konto gehört zu einem Dashboard.",
  "guests.empty": "Noch keine Gäste.",
  "guests.no_dashboards": "Füge zuerst ein Gast-Dashboard hinzu.",
  "guests.add": "Gast hinzufügen",
  "guests.username": "Benutzername",
  "guests.password": "Passwort",
  "guests.new_password": "Neues Passwort",
  "guests.new_password_hint": "Leer lassen, um das Passwort zu behalten.",
  "guests.generate": "Erzeugen",
  "guests.dashboard": "Dashboard",
  "guests.edit": "Bearbeiten",
  "guests.delete_confirm": "Gast {name} löschen?",
  "guests.created": "Gast {name} angelegt. Passwort: {password}",

  "settings.ha": "Home Assistant",
  "settings.url": "Adresse",
  "settings.state": "Status",
  "settings.version": "Version",
  "settings.configured_by": "Eingerichtet von",
  "settings.reconnect": "Anderes Home Assistant verbinden",
  "settings.reconnect_hint": "Oder dasselbe noch einmal, um dort einen neuen Guest-Assistant-Benutzer anzulegen.",
  "settings.renew": "Guest-Assistant-Benutzer neu anlegen",
  "settings.renew_hint": "Legt in Home Assistant einen neuen Benutzer ohne Admin-Rechte für Guest Assistant an und entfernt den alten.",
  "settings.public_url": "Adresse für Gäste",
  "settings.public_url_hint": "Die Adresse, die Gäste öffnen, z. B. https://gaeste.example.com. Mit https werden Cookies als sicher markiert. Optional.",
  "settings.guest_link": "Gäste öffnen",
  confirm: "Bestätigen",
  "dash.collapse": "Einklappen",
  "dash.expand": "Details anzeigen",
  language: "Sprache",
};

export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
] as const;
export type Language = (typeof LANGUAGES)[number]["code"];

const STORAGE_KEY = "guest-assistant-admin-language";

/** English unless the admin picked another language on this device. */
function storedLanguage(): Language {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (LANGUAGES.some((l) => l.code === value)) return value as Language;
  } catch {
    // storage unavailable (private mode, blocked site data)
  }
  return "en";
}

export const language: Language = storedLanguage();
const dictionary: Record<string, string> = language === "de" ? { ...en, ...de } : en;
document.documentElement.lang = language;

/** Stores the choice and reloads, so every text is rendered in the new language. */
export function setLanguage(code: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // the choice then only lasts until the reload
  }
  location.reload();
}

export function t(key: Key, params: Record<string, string | number> = {}): string {
  return (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}
