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
  /** Signs better-auth's session cookies; generated on the first start. */
  auth_secret: string;
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
  }

  static open(dataDir: string): Store {
    // The database holds the HA token, session tokens and password hashes.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const path = join(dataDir, "guest-assistant.db");
    const store = new Store(path);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(path + suffix, 0o600);
      } catch {
        // The WAL files appear with the first write; the directory mode covers them.
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
      .query<DashboardRow, []>("SELECT id, answers, enabled FROM ga_dashboards ORDER BY added_at, id")
      .all()
      .map(toRecord);
  }

  getDashboard(id: string): DashboardRecord | undefined {
    const row = this.db.query<DashboardRow, [string]>("SELECT id, answers, enabled FROM ga_dashboards WHERE id = ?").get(id);
    return row ? toRecord(row) : undefined;
  }

  saveDashboard(record: DashboardRecord): void {
    this.db
      .query(
        "INSERT INTO ga_dashboards (id, answers, added_at, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET answers = excluded.answers, enabled = excluded.enabled",
      )
      .run(record.id, JSON.stringify(record.answers), new Date().toISOString(), record.enabled ? 1 : 0);
  }

  deleteDashboard(id: string): void {
    this.db.query("DELETE FROM ga_dashboards WHERE id = ?").run(id);
  }
}

interface DashboardRow {
  id: string;
  answers: string;
  enabled: number;
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
  return { id: row.id, answers, enabled: row.enabled !== 0 };
}
