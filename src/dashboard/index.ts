import type { HaClient } from "../ha/client";
import { HaCommandError } from "../ha/client";
import { entityDomain, extract, isObj, type Obj } from "./extract";
import { validate, type Violation } from "./validate";

export type { Violation } from "./validate";
export { entityDomain, isEntityId } from "./extract";

export type DashboardStatus = "loading" | "ok" | "rejected";

interface RegistryDisplayEntry {
  ei: string;
  di?: string;
}

/**
 * One HA dashboard used as an authorization source. `status` is "ok" only
 * when the config was loaded and passed validation; anything else denies
 * access for every user bound to this dashboard.
 */
export class Dashboard {
  readonly id: string;
  status: DashboardStatus = "loading";
  violations: Violation[] = [];

  private _entities = new Set<string>();
  private _domains = new Set<string>();
  private _devices = new Set<string>();
  private _templates = new Map<string, Obj>();
  private _mediaSources = new Set<string>();
  private listeners: Array<(d: Dashboard) => void> = [];

  constructor(id: string) {
    this.id = id;
  }

  /** The url_path value HA expects (null for the default dashboard). */
  get urlPath(): string | null {
    return this.id === "lovelace" ? null : this.id;
  }

  get entities(): ReadonlySet<string> {
    return this._entities;
  }
  get allowedDomains(): ReadonlySet<string> {
    return this._domains;
  }
  get allowedDevices(): ReadonlySet<string> {
    return this._devices;
  }
  get templates(): ReadonlyMap<string, Obj> {
    return this._templates;
  }
  get mediaSources(): ReadonlySet<string> {
    return this._mediaSources;
  }

  /** Notified after every (re)load, e.g. to close connections of rejected dashboards. */
  onChange(listener: (d: Dashboard) => void): void {
    this.listeners.push(listener);
  }

  /** For tests and synthetic setups. */
  applyConfig(config: Obj): void {
    const violations = validate(config);
    const extraction = extract(config);
    this._entities = extraction.entities;
    this._domains = new Set([...extraction.entities].map(entityDomain));
    this._templates = extraction.templates;
    this._mediaSources = extraction.mediaSources;
    this.violations = violations;
    this.status = violations.length === 0 ? "ok" : "rejected";
  }

  /** Loads config from HA, extracts and validates, then resolves device ids. */
  async load(client: HaClient): Promise<void> {
    let config: unknown;
    try {
      config = await client.sendCommand({ type: "lovelace/config", url_path: this.urlPath });
    } catch (err) {
      if (err instanceof HaCommandError && err.code === "config_not_found") {
        this.reject([
          {
            rule: "auto-generated",
            path: "$",
            message: "Dashboard has no saved config (auto-generated); take control of it in HA first",
          },
        ]);
        return;
      }
      throw err;
    }

    if (!isObj(config)) {
      this.reject([{ rule: "invalid-config", path: "$", message: "Dashboard config is not an object" }]);
      return;
    }

    this.applyConfig(config);
    if (this.status === "ok") {
      await this.refreshDevices(client);
    }
    this.log();
    this.emit();
  }

  /**
   * Recomputes the device ids belonging to allowed entities. Called on load and
   * whenever the entity registry changes.
   */
  async refreshDevices(client: HaClient): Promise<void> {
    const result = (await client.sendCommand({ type: "config/entity_registry/list_for_display" })) as {
      entities?: RegistryDisplayEntry[];
    };
    const devices = new Set<string>();
    for (const entry of result.entities ?? []) {
      if (entry.di && this._entities.has(entry.ei)) devices.add(entry.di);
    }
    this._devices = devices;
  }

  private reject(violations: Violation[]): void {
    this._entities = new Set();
    this._domains = new Set();
    this._devices = new Set();
    this._templates = new Map();
    this._mediaSources = new Set();
    this.violations = violations;
    this.status = "rejected";
    this.log();
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this);
  }

  private log(): void {
    if (this.status === "ok") {
      console.log(
        `Dashboard "${this.id}": ${this._entities.size} entities, ${this._templates.size} template(s), ${this._devices.size} device(s)`,
      );
      return;
    }
    console.error(`Dashboard "${this.id}" REJECTED, its users cannot log in:`);
    for (const v of this.violations) {
      console.error(`  [${v.rule}] ${v.path}: ${v.message}`);
    }
  }
}
