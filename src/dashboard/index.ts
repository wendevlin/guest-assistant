import type { HaClient } from "../ha/client";
import { HaCommandError } from "../ha/client";
import { findConditions, type ConditionUse } from "./conditions";
import { entityDomain, extract, isObj, type Obj } from "./extract";
import {
  decide,
  findQuestions,
  isAnswered,
  MEDIA_PLAYER_GROUPING,
  rewriteForGuests,
  type Decisions,
  type Question,
} from "./interactions";
import { validate, type Violation } from "./validate";

export type { Violation } from "./validate";
export type { ConditionUse } from "./conditions";
export type { Question } from "./interactions";
export { entityDomain, isEntityId } from "./extract";

export type DashboardStatus = "loading" | "ok" | "rejected";

interface RegistryDisplayEntry {
  ei: string;
  di?: string;
}

interface StateLike {
  entity_id?: string;
  attributes?: { supported_features?: number };
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
  private _conditions = new Set<string>();
  private _conditionUses: ConditionUse[] = [];
  private listeners: Array<(d: Dashboard) => void> = [];
  private _questions: Question[] = [];
  private _answers: Readonly<Record<string, string>> = {};
  private _decisions: Decisions = { allowedUrls: new Set(), groupablePlayers: new Set() };
  private quiet = false;

  /**
   * Whether the last (re)load changed what guests may access (entities,
   * templates, media sources, conditions). Open guest connections then hold state
   * filtered by the old allowlist and must start over.
   */
  accessChanged = false;

  /** Switched off by the admin: guests are denied, as if the analysis had failed. */
  enabled = true;

  constructor(id: string, answers: Readonly<Record<string, string>> = {}) {
    this.id = id;
    this._answers = answers;
  }

  /** Guests may use the dashboard: it is switched on and passed the analysis. */
  get usable(): boolean {
    return this.enabled && this.status === "ok";
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
  /** Canonical JSON of the condition leaves written on the dashboard (see conditions.ts). */
  get conditions(): ReadonlySet<string> {
    return this._conditions;
  }
  /** Condition types that show or hide content, shown to the admin. */
  get conditionUses(): readonly ConditionUse[] {
    return this._conditionUses;
  }

  /** Everything the admin has to decide about this dashboard (see interactions.ts). */
  get questions(): readonly Question[] {
    return this._questions;
  }
  get answers(): Readonly<Record<string, string>> {
    return this._answers;
  }
  /** Questions without a valid answer; the restrictive option applies to them. */
  get pending(): Question[] {
    return this._questions.filter((q) => !isAnswered(q, this._answers));
  }

  /** Whether guests may group this media player with the dashboard's other players. */
  mediaGroupAllowed(entityId: string): boolean {
    return this._decisions.groupablePlayers.has(entityId);
  }

  /** The dashboard config as guests get it (blocked links replaced). */
  guestConfig(config: unknown): unknown {
    return rewriteForGuests(config, this.urlPath, this._decisions);
  }

  /**
   * Stores the admin's answers. Guests get a lovelace_updated so their
   * frontend fetches the (differently rewritten) config again.
   */
  setAnswers(answers: Readonly<Record<string, string>>): void {
    this._answers = answers;
    this._decisions = decide(this._questions, answers);
    this.accessChanged = false;
    this.emit();
  }

  /** Notified after every (re)load, e.g. to close connections of rejected dashboards. */
  onChange(listener: (d: Dashboard) => void): void {
    this.listeners.push(listener);
  }

  /** For tests and synthetic setups; `groupablePlayers` comes from HA's states in `load`. */
  applyConfig(config: Obj, groupablePlayers: Iterable<string> = []): void {
    const before = this.accessKey();
    const violations = validate(config);
    const extraction = extract(config);
    this._entities = extraction.entities;
    this._domains = new Set([...extraction.entities].map(entityDomain));
    this._templates = extraction.templates;
    this._mediaSources = extraction.mediaSources;
    this._conditions = extraction.conditions;
    this._conditionUses = findConditions(config);
    const players = [...groupablePlayers].filter((id) => extraction.entities.has(id));
    this._questions = findQuestions(config, this.urlPath, players);
    this._decisions = decide(this._questions, this._answers);
    this.violations = violations;
    this.status = violations.length === 0 ? "ok" : "rejected";
    this.accessChanged = this.accessKey() !== before;
  }

  private accessKey(): string {
    return JSON.stringify([
      [...this._entities].sort(),
      [...this._templates.keys()].sort(),
      [...this._mediaSources].sort(),
      [...this._conditions].sort(),
    ]);
  }

  /** Denies access until the next successful load, e.g. while switching HA connections. */
  markLoading(): void {
    this.status = "loading";
  }

  /** Loads config from HA, extracts and validates, then resolves device ids. */
  async load(client: HaClient, { quiet = false } = {}): Promise<void> {
    this.quiet = quiet;
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
      if (err instanceof HaCommandError && err.code === "unauthorized") {
        this.reject([
          {
            rule: "admin-only",
            path: "$",
            message: "Dashboard is visible to administrators only; the proxy's non-admin user cannot read it",
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

    this.applyConfig(config, await groupablePlayers(client));
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
    this.accessChanged = this.status !== "rejected";
    this._entities = new Set();
    this._domains = new Set();
    this._devices = new Set();
    this._templates = new Map();
    this._mediaSources = new Set();
    this._conditions = new Set();
    this._conditionUses = [];
    this._questions = [];
    this._decisions = decide([], {});
    this.violations = violations;
    this.status = "rejected";
    this.log();
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this);
  }

  private log(): void {
    if (this.quiet) return;
    if (this.status === "ok") {
      const pending = this.pending.length;
      console.log(
        `Dashboard "${this.id}": ${this._entities.size} entities, ${this._templates.size} template(s), ${this._devices.size} device(s)` +
          (pending ? `, ${pending} question(s) for the admin` : ""),
      );
      return;
    }
    console.error(`Dashboard "${this.id}" REJECTED, its guests cannot log in:`);
    for (const v of this.violations) {
      console.error(`  [${v.rule}] ${v.path}: ${v.message}`);
    }
  }
}

/** Media players that can be grouped; only those raise a grouping question. */
async function groupablePlayers(client: HaClient): Promise<string[]> {
  const states = (await client.sendCommand({ type: "get_states" })) as StateLike[];
  if (!Array.isArray(states)) return [];
  return states
    .filter(
      (s) =>
        typeof s.entity_id === "string" &&
        s.entity_id.startsWith("media_player.") &&
        ((s.attributes?.supported_features ?? 0) & MEDIA_PLAYER_GROUPING) !== 0,
    )
    .map((s) => s.entity_id as string);
}
