import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseTheme, type ThemeSettings } from "./theme";

/** Answers of the admin to the questions a dashboard analysis raised (question key → option). */
export type Answers = Record<string, string>;

export interface DashboardRecord {
  /** url_path of the HA dashboard; "lovelace" is the default dashboard. */
  id: string;
  theme: ThemeSettings;
  answers: Answers;
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
  /** Set once config.yaml was imported, so it is never imported again. */
  legacy_imported: true;
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
      "CREATE TABLE IF NOT EXISTS ga_dashboards (id TEXT PRIMARY KEY, theme TEXT NOT NULL DEFAULT '{}', answers TEXT NOT NULL DEFAULT '{}', added_at TEXT NOT NULL)",
    );
  }

  static open(dataDir: string): Store {
    mkdirSync(dataDir, { recursive: true });
    return new Store(join(dataDir, "guest-assistant.db"));
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
      .query<{ id: string; theme: string; answers: string }, []>("SELECT id, theme, answers FROM ga_dashboards ORDER BY added_at, id")
      .all()
      .map(toRecord);
  }

  getDashboard(id: string): DashboardRecord | undefined {
    const row = this.db.query<{ id: string; theme: string; answers: string }, [string]>("SELECT id, theme, answers FROM ga_dashboards WHERE id = ?").get(id);
    return row ? toRecord(row) : undefined;
  }

  saveDashboard(record: DashboardRecord): void {
    this.db
      .query(
        "INSERT INTO ga_dashboards (id, theme, answers, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET theme = excluded.theme, answers = excluded.answers",
      )
      .run(record.id, JSON.stringify(record.theme), JSON.stringify(record.answers), new Date().toISOString());
  }

  deleteDashboard(id: string): void {
    this.db.query("DELETE FROM ga_dashboards WHERE id = ?").run(id);
  }
}

function toRecord(row: { id: string; theme: string; answers: string }): DashboardRecord {
  let answers: Answers = {};
  try {
    const parsed = JSON.parse(row.answers);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      answers = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Answers;
    }
  } catch {
    // corrupt answers count as unanswered, which is the restrictive choice
  }
  return { id: row.id, theme: parseTheme(row.theme), answers };
}
