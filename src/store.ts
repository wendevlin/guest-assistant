import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Answers of the admin to the questions a dashboard analysis raised (question key → option). */
export type Answers = Record<string, string>;

export interface DashboardRecord {
  /** url_path of the HA dashboard; "lovelace" is the default dashboard. */
  id: string;
  answers: Answers;
  /** Inactive dashboards keep their settings and guests, but nobody can use them. */
  enabled: boolean;
  /**
   * Whether the native part of the Home Assistant companion app (widgets,
   * device controls, watch) may use the dashboard's entities. Only matters
   * while companion app support is on.
   */
  widgets: boolean;
}

/** How the proxy reaches HA for guest traffic. */
export interface HaSettings {
  url: string;
  /** Long-lived token of the non-admin HA user the proxy acts as. */
  token: string;
  /** HA user id of that user, if the proxy created it (used to replace it later). */
  user_id?: string;
  /** Who set up the connection, for the admin UI. */
  configured_by?: string;
}

interface Settings {
  ha: HaSettings;
  /** URL guests use to reach the proxy (secure cookies, links in notifications). */
  public_url: string;
  /** Name of the guest app when guests install it, instead of the build's own. */
  app_name: string;
  /** Signs better-auth's session cookies; generated on the first start. */
  auth_secret: string;
  /** Companion app support (src/companion/): off unless the admin switches it on. */
  companion: CompanionSettings;
  /** Signs the access tokens of companion app logins, which outlive restarts. */
  app_jwt_secret: string;
  /** Stable id the companion apps know this instance by (mDNS `uuid`, get_config `instance_id`). */
  instance_id: string;
  /** Last core config read from HA, so companion apps get an answer while HA restarts. */
  last_ha_config: Record<string, unknown>;
}

export interface CompanionSettings {
  /** The proxy answers the Home Assistant companion apps like a Home Assistant server. */
  enabled: boolean;
  /** It announces itself on the local network (mDNS), so the apps list it. */
  discoverable: boolean;
}

/**
 * The proxy's own configuration, kept in the same SQLite database as
 * better-auth's tables (guest accounts live there).
 */
export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS ga_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.exec(
      // (older databases also have a now unused `theme` column)
      "CREATE TABLE IF NOT EXISTS ga_dashboards (id TEXT PRIMARY KEY, answers TEXT NOT NULL DEFAULT '{}', added_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1)",
    );
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(ga_dashboards)").all();
    if (!columns.some((c) => c.name === "enabled")) this.db.exec("ALTER TABLE ga_dashboards ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    if (!columns.some((c) => c.name === "widgets")) this.db.exec("ALTER TABLE ga_dashboards ADD COLUMN widgets INTEGER NOT NULL DEFAULT 0");
    // Companion app logins (src/companion/tokens.ts). Only a hash of the
    // refresh token is kept; the app holds the token itself.
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS ga_app_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, webhook_id TEXT UNIQUE, device TEXT)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS ga_app_tokens_user ON ga_app_tokens (user_id)");
  }

  static open(dataDir: string): Store {
    // The database holds the HA token, session tokens and password hashes.
    // mkdirSync's mode only applies to a directory it creates, so an existing
    // one (the app's /data, older installs) is tightened on every start.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const path = join(dataDir, "guest-assistant.db");
    // The constructor's statements make SQLite create the WAL and SHM files,
    // with the database file's mode; ones it creates later copy the 0600.
    const store = new Store(path);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(path + suffix, 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return store;
  }

  static memory(): Store {
    return new Store(":memory:");
  }

  get<K extends keyof Settings>(key: K): Settings[K] | undefined {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM ga_settings WHERE key = ?").get(key);
    return row ? (JSON.parse(row.value) as Settings[K]) : undefined;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.db
      .query("INSERT INTO ga_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  delete(key: keyof Settings): void {
    this.db.query("DELETE FROM ga_settings WHERE key = ?").run(key);
  }

  listDashboards(): DashboardRecord[] {
    return this.db
      .query<DashboardRow, []>("SELECT id, answers, enabled, widgets FROM ga_dashboards ORDER BY added_at, id")
      .all()
      .map(toRecord);
  }

  getDashboard(id: string): DashboardRecord | undefined {
    const row = this.db.query<DashboardRow, [string]>("SELECT id, answers, enabled, widgets FROM ga_dashboards WHERE id = ?").get(id);
    return row ? toRecord(row) : undefined;
  }

  saveDashboard(record: DashboardRecord): void {
    this.db
      .query(
        "INSERT INTO ga_dashboards (id, answers, added_at, enabled, widgets) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET answers = excluded.answers, enabled = excluded.enabled, widgets = excluded.widgets",
      )
      .run(record.id, JSON.stringify(record.answers), new Date().toISOString(), record.enabled ? 1 : 0, record.widgets ? 1 : 0);
  }

  deleteDashboard(id: string): void {
    this.db.query("DELETE FROM ga_dashboards WHERE id = ?").run(id);
  }
}

interface DashboardRow {
  id: string;
  answers: string;
  enabled: number;
  widgets: number;
}

function toRecord(row: DashboardRow): DashboardRecord {
  let answers: Answers = {};
  try {
    const parsed = JSON.parse(row.answers);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      answers = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Answers;
    }
  } catch {
    // corrupt answers count as unanswered, which is the restrictive choice
  }
  return { id: row.id, answers, enabled: row.enabled !== 0, widgets: row.widgets === 1 };
}
