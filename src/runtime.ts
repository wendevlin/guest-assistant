import { createAuth, type Auth } from "./auth";
import { migrate } from "./auth/migrate";
import { Dashboard } from "./dashboard";
import type { Env } from "./env";
import { Guests } from "./guests";
import { HaClient, HaCommandError } from "./ha/client";
import type { HaEndpoint } from "./ha/endpoint";
import type { HaSettings, Store } from "./store";
import { parseTheme, resolveTheme, type GuestTheme, type ThemeSettings } from "./theme";

export type ConnectionState = "unconfigured" | "connecting" | "connected" | "error";
export type Mode = "standalone" | "app";

export interface HaDashboardInfo {
  id: string;
  title: string;
  require_admin: boolean;
}

interface Listeners {
  dashboardChanged: Array<(d: Dashboard) => void>;
  dashboardRemoved: Array<(id: string) => void>;
  guestChanged: Array<(guestId: string) => void>;
  connectionChanged: Array<() => void>;
}

const RETRY_MS = 30_000;

/**
 * Everything the proxy knows at runtime: the connection to Home Assistant,
 * the guest dashboards and the guest accounts. All of it can change while
 * the server runs (admin UI); listeners let the proxy drop connections that
 * lost their permission.
 */
export class Runtime {
  readonly dashboards = new Map<string, Dashboard>();
  readonly guests: Guests;
  client: HaClient | null = null;
  state: ConnectionState = "unconfigured";
  error?: string;
  haVersion?: string;
  /** As an app: path of the ingress panel, used in HA notifications. */
  appPanelPath?: string;

  private _auth: Auth;
  private listeners: Listeners = { dashboardChanged: [], dashboardRemoved: [], guestChanged: [], connectionChanged: [] };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** dashboard id → pending question keys the admin was last notified about */
  private notified = new Map<string, string>();
  private generation = 0;

  constructor(
    readonly env: Env,
    readonly store: Store,
    readonly mode: Mode,
  ) {
    this._auth = this.buildAuth();
    this.guests = new Guests(() => this._auth);
  }

  get auth(): Auth {
    return this._auth;
  }

  get haSettings(): HaSettings | undefined {
    return this.store.get("ha");
  }

  /** The connection guest traffic uses, or null while not configured. */
  get endpoint(): HaEndpoint | null {
    const ha = this.haSettings;
    return ha ? { url: ha.url, token: ha.token } : null;
  }

  get publicUrl(): string | undefined {
    return this.store.get("public_url");
  }

  private buildAuth(): Auth {
    return createAuth({ db: this.store.db, publicUrl: this.publicUrl, port: this.env.port });
  }

  async init(): Promise<void> {
    await migrate(this._auth);
  }

  async setPublicUrl(url: string | undefined): Promise<void> {
    if (url) this.store.set("public_url", new URL(url).origin);
    else this.store.delete("public_url");
    this._auth = this.buildAuth();
  }

  on<K extends keyof Listeners>(event: K, listener: Listeners[K][number]): void {
    (this.listeners[event] as Array<typeof listener>).push(listener);
  }

  private emit<K extends keyof Listeners>(event: K, ...args: Parameters<Listeners[K][number]>): void {
    for (const l of this.listeners[event]) (l as (...a: typeof args) => void)(...args);
  }

  // ── connection ──────────────────────────────────────────────────────────

  /** Stores a new HA connection and switches to it; open guest connections are dropped. */
  async setHaSettings(settings: HaSettings): Promise<void> {
    this.store.set("ha", settings);
    this.emit("connectionChanged");
    await this.connect();
  }

  /**
   * (Re)connects with the stored settings and loads all guest dashboards.
   * Failures leave the runtime in state "error" and retry later, except
   * for problems only the admin can fix.
   */
  async connect(): Promise<void> {
    const generation = ++this.generation;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client?.close();
    this.client = null;
    for (const d of this.dashboards.values()) d.markLoading();

    const endpoint = this.endpoint;
    if (!endpoint) {
      this.state = "unconfigured";
      return;
    }
    this.state = "connecting";
    this.error = undefined;
    const client = new HaClient(endpoint);
    try {
      await client.connect();
      // HA's own admin checks are a second line of defence behind this proxy,
      // so it must never act as an admin.
      const me = (await client.sendCommand({ type: "auth/current_user" })) as { is_admin?: boolean; is_owner?: boolean; name?: string };
      if (me.is_admin || me.is_owner) {
        client.close();
        this.fail(`The Home Assistant user "${me.name}" the proxy uses is an administrator. Set up the connection again.`, false);
        return;
      }
      if (generation !== this.generation) {
        client.close();
        return;
      }
      this.client = client;
      this.haVersion = client.haVersion;
      await this.subscribe(client);
      await this.loadDashboards();
      this.state = "connected";
      console.log(`Serving ${this.dashboards.size} guest dashboard(s).`);
    } catch (err) {
      client.close();
      if (generation !== this.generation) return;
      const authFailed = err instanceof HaCommandError && err.code === "auth_invalid";
      this.fail(
        authFailed
          ? "Home Assistant no longer accepts the proxy's token (the user or token was removed). Set up the connection again."
          : `Cannot connect to Home Assistant: ${err instanceof Error ? err.message : String(err)}`,
        !authFailed,
      );
    }
  }

  private fail(message: string, retry: boolean): void {
    this.state = "error";
    this.error = message;
    this.client = null;
    console.error(message);
    for (const d of this.dashboards.values()) d.markLoading();
    if (retry) this.retryTimer = setTimeout(() => void this.connect(), RETRY_MS);
  }

  private async subscribe(client: HaClient): Promise<void> {
    await client.subscribeEvents("lovelace_updated", (event) => {
      const data = event.data as { url_path?: string | null } | undefined;
      const changed = data?.url_path ?? null;
      for (const dashboard of this.dashboards.values()) {
        if (dashboard.urlPath !== changed) continue;
        console.log(`Dashboard "${dashboard.id}" changed, re-analysing...`);
        void this.loadDashboard(dashboard);
      }
    });

    let deviceRefresh: ReturnType<typeof setTimeout> | null = null;
    await client.subscribeEvents("entity_registry_updated", () => {
      if (deviceRefresh) clearTimeout(deviceRefresh);
      deviceRefresh = setTimeout(() => {
        for (const dashboard of this.dashboards.values()) {
          if (dashboard.status !== "ok" || !this.client) continue;
          dashboard.refreshDevices(this.client).catch((err) => console.error(`Failed to refresh devices for "${dashboard.id}":`, err));
        }
      }, 2_000);
    });

    client.onReconnect(() => {
      console.log("Reconnected to Home Assistant, re-analysing dashboards...");
      for (const dashboard of this.dashboards.values()) void this.loadDashboard(dashboard);
    });
  }

  // ── dashboards ──────────────────────────────────────────────────────────

  private async loadDashboards(): Promise<void> {
    const records = this.store.listDashboards();
    const known = new Set(records.map((r) => r.id));
    for (const id of [...this.dashboards.keys()]) {
      if (!known.has(id)) this.dashboards.delete(id);
    }
    for (const record of records) {
      const dashboard = this.dashboards.get(record.id) ?? this.track(new Dashboard(record.id, record.answers));
      await this.loadDashboard(dashboard);
    }
  }

  private track(dashboard: Dashboard): Dashboard {
    this.dashboards.set(dashboard.id, dashboard);
    dashboard.onChange((d) => {
      this.emit("dashboardChanged", d);
      void this.notifyAdmin(d);
    });
    return dashboard;
  }

  private async loadDashboard(dashboard: Dashboard): Promise<void> {
    if (!this.client) return;
    try {
      await dashboard.load(this.client);
    } catch (err) {
      console.error(`Failed to load dashboard "${dashboard.id}":`, err);
    }
  }

  /** Dashboards in HA the proxy user can read. "lovelace" is the default dashboard. */
  async listHaDashboards(): Promise<HaDashboardInfo[]> {
    const client = this.requireClient();
    const list = (await client.sendCommand({ type: "lovelace/dashboards/list" })) as Array<{
      url_path: string;
      title?: string;
      require_admin?: boolean;
      mode?: string;
    }>;
    const dashboards = list.map((d) => ({ id: d.url_path, title: d.title ?? d.url_path, require_admin: d.require_admin === true }));
    // Newer HA versions list the default dashboard themselves.
    if (!dashboards.some((d) => d.id === "lovelace")) dashboards.unshift({ id: "lovelace", title: "Overview", require_admin: false });
    return dashboards;
  }

  /** Analyses a dashboard without adding it (for the admin UI). */
  async preview(id: string, answers: Record<string, string> = {}): Promise<Dashboard> {
    const dashboard = new Dashboard(id, answers);
    await dashboard.load(this.requireClient(), { quiet: true });
    return dashboard;
  }

  async addDashboard(id: string, theme: ThemeSettings = {}, answers: Record<string, string> = {}): Promise<Dashboard> {
    const available = await this.listHaDashboards();
    if (!available.some((d) => d.id === id)) throw new RuntimeError(`Dashboard "${id}" does not exist in Home Assistant`);
    if (this.dashboards.has(id)) throw new RuntimeError(`Dashboard "${id}" is already a guest dashboard`);
    this.store.saveDashboard({ id, theme, answers });
    const dashboard = this.track(new Dashboard(id, answers));
    await this.loadDashboard(dashboard);
    return dashboard;
  }

  async updateDashboard(id: string, changes: { theme?: ThemeSettings; answers?: Record<string, string> }): Promise<void> {
    const record = this.store.getDashboard(id);
    const dashboard = this.dashboards.get(id);
    if (!record || !dashboard) throw new RuntimeError(`Dashboard "${id}" is not a guest dashboard`);
    const updated = { ...record, ...changes };
    this.store.saveDashboard(updated);
    if (changes.theme) {
      // Theme settings travel in the guests' tokens: make them reconnect.
      this.emit("dashboardRemoved", id);
    }
    if (changes.answers) dashboard.setAnswers(updated.answers);
  }

  /** Removes a guest dashboard together with its guests. */
  async removeDashboard(id: string): Promise<void> {
    for (const guest of await this.guests.list()) {
      if (guest.dashboard === id) await this.deleteGuest(guest.id);
    }
    this.store.deleteDashboard(id);
    this.dashboards.delete(id);
    this.emit("dashboardRemoved", id);
    void this.dismissNotification(id);
  }

  dashboardTheme(id: string): ThemeSettings {
    return this.store.getDashboard(id)?.theme ?? {};
  }

  themeFor(dashboardId: string, guestTheme: unknown): GuestTheme {
    return resolveTheme(this.dashboardTheme(dashboardId), parseTheme(guestTheme));
  }

  async listThemes(): Promise<string[]> {
    const result = (await this.requireClient().sendCommand({ type: "frontend/get_themes" })) as { themes?: Record<string, unknown> };
    return Object.keys(result.themes ?? {}).sort();
  }

  // ── guests ──────────────────────────────────────────────────────────────

  async createGuest(input: { username: string; password: string; dashboard: string; theme?: ThemeSettings }) {
    if (!this.store.getDashboard(input.dashboard)) throw new RuntimeError(`Dashboard "${input.dashboard}" is not a guest dashboard`);
    return this.guests.create(input);
  }

  async updateGuest(id: string, changes: { password?: string; dashboard?: string; theme?: ThemeSettings }) {
    if (changes.dashboard !== undefined && !this.store.getDashboard(changes.dashboard)) {
      throw new RuntimeError(`Dashboard "${changes.dashboard}" is not a guest dashboard`);
    }
    const guest = await this.guests.update(id, changes);
    this.emit("guestChanged", id);
    return guest;
  }

  async deleteGuest(id: string): Promise<void> {
    await this.guests.delete(id);
    this.emit("guestChanged", id);
  }

  // ── admin notifications ────────────────────────────────────────────────

  /**
   * Tells the admin in HA when a dashboard has open questions, e.g. after an
   * edit added a web link. Until they answer, the restrictive option applies.
   */
  private async notifyAdmin(dashboard: Dashboard): Promise<void> {
    const pending = dashboard.status === "ok" ? dashboard.pending : [];
    const signature = pending.map((q) => q.key).sort().join("\n");
    if (signature === (this.notified.get(dashboard.id) ?? "")) return;
    this.notified.set(dashboard.id, signature);
    if (!signature) {
      await this.dismissNotification(dashboard.id);
      return;
    }
    const target = this.appPanelPath ?? (this.publicUrl ? `${this.publicUrl}/admin/` : undefined);
    const link = target ? `\n\n[Open Guest Assistant](${target})` : "";
    await this.callService("persistent_notification", "create", {
      notification_id: notificationId(dashboard.id),
      title: "Guest Assistant needs your input",
      message:
        `The guest dashboard **${dashboard.id}** has ${pending.length} open question(s) about links, navigation or media players. ` +
        `Until you answer them in the Guest Assistant admin page, guests get the restrictive choice.${link}`,
    });
  }

  private async dismissNotification(id: string): Promise<void> {
    await this.callService("persistent_notification", "dismiss", { notification_id: notificationId(id) });
  }

  private async callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendCommand({ type: "call_service", domain, service, service_data: data });
    } catch (err) {
      console.warn(`Could not call ${domain}.${service}:`, err instanceof Error ? err.message : err);
    }
  }

  private requireClient(): HaClient {
    if (!this.client) throw new RuntimeError("Not connected to Home Assistant");
    return this.client;
  }

  close(): void {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.client?.close();
    this.client = null;
  }
}

export class RuntimeError extends Error {}

function notificationId(dashboardId: string): string {
  return `guest_assistant_${dashboardId.replace(/[^a-z0-9_]/gi, "_")}`;
}
