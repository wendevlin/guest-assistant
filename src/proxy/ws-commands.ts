/**
 * Default-deny command table for the HA WebSocket API.
 *
 * Every command a guest may send is listed here with the exact request
 * fields that are passed through. Anything else (unknown command type or
 * unknown field) is rejected. Result and event filters reduce HA's answers to
 * the guest's allowed entity set.
 *
 * Schemas verified against homeassistant/components/websocket_api/commands.py
 * and the respective component websocket_api modules.
 */

import type { Dashboard } from "../dashboard";
import { entityDomain, isEntityId } from "../dashboard";
import { checkCondition } from "../dashboard/conditions";
import * as F from "./ws-filters";

export type Obj = Record<string, unknown>;

export interface TrackedCommand {
  type: string;
  msg: Obj;
}

export interface CommandContext {
  dashboard: Dashboard;
  /** subscriptions established on this connection (id → command) */
  subscriptions: ReadonlyMap<number, TrackedCommand>;
}

export const DROP: unique symbol = Symbol("drop");

export type Verdict =
  | { kind: "forward"; msg: Obj }
  | { kind: "reply"; result: unknown; events?: unknown[] }
  | { kind: "reject"; message: string };

export interface CommandSpec {
  /** Allowed request fields besides `id` and `type`. */
  fields: readonly string[];
  /** Command establishes an event stream (result followed by events). */
  subscription?: boolean;
  /** Custom validation. Default: forward the picked fields unchanged. */
  validate?: (msg: Obj, ctx: CommandContext) => Verdict;
  filterResult?: (result: unknown, ctx: CommandContext, original: Obj) => unknown;
  filterEvent?: (event: unknown, ctx: CommandContext, original: Obj) => unknown | typeof DROP;
}

// ── helpers ──────────────────────────────────────────────────────────────

function reject(message: string): Verdict {
  return { kind: "reject", message };
}

function forward(msg: Obj): Verdict {
  return { kind: "forward", msg };
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] | null {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return null;
}

/** All ids must be entity ids contained in A. Returns the ids or null. */
function allowedIds(v: unknown, A: ReadonlySet<string>, nonEmpty = true): string[] | null {
  const ids = asStringArray(v);
  if (!ids) return null;
  if (nonEmpty && ids.length === 0) return null;
  return ids.every((id) => isEntityId(id) && A.has(id)) ? ids : null;
}

function requireEntity(field: string, domain?: string) {
  return (msg: Obj, ctx: CommandContext): Verdict => {
    const id = msg[field];
    if (!isEntityId(id) || !ctx.dashboard.entities.has(id)) return reject(`${field} not allowed`);
    if (domain && entityDomain(id) !== domain) return reject(`${field} must be a ${domain} entity`);
    return forward(msg);
  };
}

function requireEntityList(field: string) {
  return (msg: Obj, ctx: CommandContext): Verdict => {
    if (!allowedIds(msg[field], ctx.dashboard.entities)) return reject(`${field} not allowed`);
    return forward(msg);
  };
}

/** Intersection of the allowed set with the ids the guest actually asked for. */
function requestedIds(original: Obj, field: string, ctx: CommandContext): ReadonlySet<string> {
  const ids = asStringArray(original[field]) ?? [];
  return new Set(ids.filter((id) => ctx.dashboard.entities.has(id)));
}

function keyIn(allowed: readonly string[]) {
  return (msg: Obj): Verdict => {
    if (typeof msg.key !== "string" || !allowed.includes(msg.key)) return reject("key not allowed");
    return forward(msg);
  };
}

const A = (ctx: CommandContext) => ctx.dashboard.entities;

// ── subscribe_events ─────────────────────────────────────────────────────

const ALLOWED_EVENT_TYPES = new Set([
  "state_changed",
  "lovelace_updated",
  "themes_updated",
  "panels_updated",
  "core_config_updated",
  "component_loaded",
  "service_registered",
  "service_removed",
  "entity_registry_updated",
  "area_registry_updated",
  "device_registry_updated",
  "floor_registry_updated",
]);

function filterSubscribedEvent(event: unknown, ctx: CommandContext, original: Obj): unknown | typeof DROP {
  if (!isObj(event)) return DROP;
  const data = isObj(event.data) ? event.data : {};
  switch (original.event_type) {
    case "state_changed":
      return typeof data.entity_id === "string" && A(ctx).has(data.entity_id) ? F.filterStateChangedEvent(event) : DROP;
    case "entity_registry_updated": {
      const ids = [data.entity_id, data.old_entity_id].filter((x): x is string => typeof x === "string");
      if (!ids.some((id) => A(ctx).has(id))) return DROP;
      // `changes` holds the old values. A changed unique_id is left out, as
      // in the registry entries themselves (see ws-filters).
      if (isObj(data.changes) && "unique_id" in data.changes) {
        const changes: Obj = { ...data.changes };
        delete changes.unique_id;
        return { ...event, data: { ...data, changes } };
      }
      return event;
    }
    case "device_registry_updated":
      return typeof data.device_id === "string" && ctx.dashboard.allowedDevices.has(data.device_id) ? event : DROP;
    case "service_registered":
    case "service_removed":
      // Every script is registered as a service of its own, and legacy notify
      // targets are named after people's phones. Only services the guest may
      // call are announced, as in get_services.
      return serviceVisible(data.domain, data.service, ctx) ? event : DROP;
    case "core_config_updated":
      // HA puts the changed settings in the event, e.g. a new location or
      // external URL, which get_config hides from guests. The frontend only
      // uses the event as a signal to fetch get_config again, which is scrubbed.
      return { ...event, data: {} };
    case "lovelace_updated":
      // Never passed through: the proxy re-analyses the dashboard first and
      // then notifies guests itself (see WsProxy.dashboardChanged), so the
      // frontend never reloads against the old allowlist.
      return DROP;
    default:
      return event;
  }
}

// ── call_service ─────────────────────────────────────────────────────────

/** Entity-scoped services a guest may call, per domain. */
const ENTITY_SERVICES: Record<string, readonly string[]> = {
  light: ["turn_on", "turn_off", "toggle"],
  switch: ["turn_on", "turn_off", "toggle"],
  input_boolean: ["turn_on", "turn_off", "toggle"],
  siren: ["turn_on", "turn_off", "toggle"],
  fan: ["turn_on", "turn_off", "toggle", "set_percentage", "set_preset_mode", "oscillate", "set_direction", "increase_speed", "decrease_speed"],
  cover: ["open_cover", "close_cover", "stop_cover", "toggle", "set_cover_position", "open_cover_tilt", "close_cover_tilt", "stop_cover_tilt", "set_cover_tilt_position", "toggle_cover_tilt"],
  valve: ["open_valve", "close_valve", "stop_valve", "set_valve_position", "toggle"],
  climate: ["set_temperature", "set_hvac_mode", "set_fan_mode", "set_preset_mode", "set_swing_mode", "set_swing_horizontal_mode", "set_humidity", "turn_on", "turn_off", "toggle"],
  humidifier: ["turn_on", "turn_off", "toggle", "set_humidity", "set_mode"],
  water_heater: ["set_temperature", "set_operation_mode", "set_away_mode", "turn_on", "turn_off"],
  lock: ["lock", "unlock", "open"],
  alarm_control_panel: ["alarm_arm_home", "alarm_arm_away", "alarm_arm_night", "alarm_arm_vacation", "alarm_arm_custom_bypass", "alarm_disarm"],
  media_player: ["turn_on", "turn_off", "toggle", "volume_up", "volume_down", "volume_set", "volume_mute", "media_play", "media_pause", "media_play_pause", "media_stop", "media_next_track", "media_previous_track", "media_seek", "select_source", "select_sound_mode", "shuffle_set", "repeat_set", "play_media", "clear_playlist", "join", "unjoin"],
  vacuum: ["start", "pause", "stop", "return_to_base", "locate", "clean_spot", "set_fan_speed", "turn_on", "turn_off", "toggle"],
  lawn_mower: ["start_mowing", "pause", "dock"],
  camera: ["turn_on", "turn_off", "enable_motion_detection", "disable_motion_detection"],
  remote: ["turn_on", "turn_off", "toggle"],
  input_number: ["set_value", "increment", "decrement"],
  number: ["set_value"],
  input_select: ["select_option", "select_next", "select_previous", "select_first", "select_last"],
  select: ["select_option", "select_next", "select_previous", "select_first", "select_last"],
  input_text: ["set_value"],
  text: ["set_value"],
  input_datetime: ["set_datetime"],
  date: ["set_value"],
  time: ["set_value"],
  datetime: ["set_value"],
  input_button: ["press"],
  button: ["press"],
  counter: ["increment", "decrement", "reset", "set_value"],
  timer: ["start", "pause", "cancel", "finish", "change"],
  todo: ["add_item", "update_item", "remove_item", "remove_completed_items"],
  scene: ["turn_on"],
  script: ["turn_on", "turn_off", "toggle"],
  automation: ["trigger", "turn_on", "turn_off", "toggle"],
};

const HOMEASSISTANT_SERVICES = new Set(["turn_on", "turn_off", "toggle"]);

/**
 * Whether a guest may see a service: exactly the services `call_service`
 * accepts for some entity on the dashboard. Everything else HA registers,
 * such as one service per script or a notify service per phone, stays hidden.
 */
function serviceVisible(domain: unknown, service: unknown, ctx: CommandContext): boolean {
  if (typeof domain !== "string" || typeof service !== "string") return false;
  if (domain === "homeassistant") return HOMEASSISTANT_SERVICES.has(service);
  if (!ctx.dashboard.allowedDomains.has(domain) || !Object.hasOwn(ENTITY_SERVICES, domain)) return false;
  return ENTITY_SERVICES[domain]!.includes(service);
}

const TARGET_SELECTOR_KEYS = ["entity_id", "device_id", "area_id", "label_id", "floor_id"];

/**
 * service_data fields that reference other entities or media and would
 * otherwise let a guest act on things outside the allowlist through an
 * allowed entity. Each check returns an error message or null.
 */
const SERVICE_DATA_CHECKS: Record<string, (data: Obj, ctx: CommandContext, ids: string[]) => string | null> = {
  "media_player.join": (data, ctx, ids) => {
    if (!ids.every((id) => ctx.dashboard.mediaGroupAllowed(id))) return "grouping not allowed for this player";
    const members = allowedIds(data.group_members, A(ctx));
    if (!members || !members.every((id) => entityDomain(id) === "media_player")) return "group_members not allowed";
    return null;
  },
  "media_player.unjoin": (_data, ctx, ids) =>
    ids.every((id) => ctx.dashboard.mediaGroupAllowed(id)) ? null : "grouping not allowed for this player",
  "media_player.play_media": (data, ctx) => {
    // Only content that an action on the dashboard plays: any other id could
    // be a URL of the guest's choosing or a media-source id that addresses
    // other entities (media-source://camera/…) or local media.
    if (data.media !== undefined && !isObj(data.media)) return "media not allowed";
    const ids = [data.media_content_id, isObj(data.media) ? data.media.media_content_id : undefined].filter((v) => v !== undefined);
    if (ids.length === 0) return "media_content_id required";
    return ids.every((v) => typeof v === "string" && ctx.dashboard.mediaContentIds.has(v)) ? null : "media_content_id not allowed";
  },
  // Script/automation variables can carry entity ids into the script.
  "script.turn_on": (data) => ("variables" in data ? "variables not allowed" : null),
  "automation.trigger": (data) => ("variables" in data ? "variables not allowed" : null),
};

function containsTemplate(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{{") || value.includes("{%");
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (isObj(value)) return Object.values(value).some(containsTemplate);
  return false;
}

function validateCallService(msg: Obj, ctx: CommandContext): Verdict {
  const { domain, service } = msg;
  if (typeof domain !== "string" || typeof service !== "string") return reject("domain/service required");
  if (msg.return_response !== undefined && msg.return_response !== false) return reject("return_response not allowed");

  let serviceData: Obj | undefined;
  if (msg.service_data !== undefined) {
    if (!isObj(msg.service_data)) return reject("service_data must be an object");
    serviceData = { ...msg.service_data };
  }

  // The entity comes either from `target.entity_id` or, as the HA frontend
  // sends it for toggles, from `service_data.entity_id`; never from both.
  // Either way it is forwarded as `target.entity_id` only.
  let rawIds: unknown;
  if (msg.target !== undefined) {
    const target = msg.target;
    if (!isObj(target)) return reject("target must be an object");
    const extraTargetKeys = Object.keys(target).filter((k) => k !== "entity_id");
    if (extraTargetKeys.length > 0) return reject(`target may only contain entity_id`);
    if (serviceData && "entity_id" in serviceData) return reject("entity_id in both target and service_data");
    rawIds = target.entity_id;
  } else if (serviceData && "entity_id" in serviceData) {
    rawIds = serviceData.entity_id;
    delete serviceData.entity_id;
  } else {
    return reject("entity_id required");
  }
  const ids = allowedIds(rawIds, A(ctx));
  if (!ids) return reject("entity_id not allowed");

  if (serviceData) {
    for (const key of TARGET_SELECTOR_KEYS) {
      if (key in serviceData) return reject(`service_data.${key} not allowed`);
    }
    if (containsTemplate(serviceData)) return reject("templates in service_data not allowed");
  }

  if (domain === "homeassistant") {
    if (!HOMEASSISTANT_SERVICES.has(service)) return reject("service not allowed");
    // homeassistant.* hands its service_data on to each entity's own domain,
    // where the per-service checks below would not run.
    if (serviceData && Object.keys(serviceData).length > 0) return reject("service_data not allowed for homeassistant services");
  } else {
    const allowed = ENTITY_SERVICES[domain];
    if (!allowed || !allowed.includes(service)) return reject("service not allowed");
    if (!ids.every((id) => entityDomain(id) === domain)) return reject("target domain mismatch");
    const check = SERVICE_DATA_CHECKS[`${domain}.${service}`];
    const error = check?.(serviceData ?? {}, ctx, ids);
    if (error) return reject(error);
  }

  const out: Obj = { id: msg.id, type: "call_service", domain, service, target: { entity_id: ids } };
  if (serviceData && Object.keys(serviceData).length > 0) out.service_data = serviceData;
  return forward(out);
}

// ── render_template ──────────────────────────────────────────────────────

function validateRenderTemplate(msg: Obj, ctx: CommandContext): Verdict {
  const template = msg.template;
  if (typeof template !== "string") return reject("template required");
  const cardConfig = ctx.dashboard.templates.get(template);
  if (!cardConfig) return reject("template not allowed");

  if (msg.entity_ids !== undefined && !allowedIds(msg.entity_ids, A(ctx), false)) return reject("entity_ids not allowed");

  const out: Obj = {
    id: msg.id,
    type: "render_template",
    template,
    // Variables are fixed by the proxy; a guest must not be able to redirect
    // `{{ states(config.entity) }}` to another entity.
    variables: { config: cardConfig, user: "Guest" },
    timeout: typeof msg.timeout === "number" ? Math.min(msg.timeout, 3) : 3,
    strict: msg.strict === true,
    report_errors: msg.report_errors === true,
  };
  if (msg.entity_ids !== undefined) out.entity_ids = msg.entity_ids;
  return forward(out);
}

// ── subscribe_condition ──────────────────────────────────────────────────

function validateSubscribeCondition(msg: Obj, ctx: CommandContext): Verdict {
  const error = checkCondition(msg.condition, ctx.dashboard.conditions, A(ctx));
  return error ? reject(error) : forward(msg);
}

// ── auth/sign_path ───────────────────────────────────────────────────────

const SIGNABLE_PATHS: Array<{ re: RegExp; domain: string }> = [
  { re: /^\/api\/camera_proxy\/([a-z0-9_]+\.[a-z0-9_]+)$/, domain: "camera" },
  { re: /^\/api\/camera_proxy_stream\/([a-z0-9_]+\.[a-z0-9_]+)$/, domain: "camera" },
  { re: /^\/api\/image_proxy\/([a-z0-9_]+\.[a-z0-9_]+)$/, domain: "image" },
  { re: /^\/api\/media_player_proxy\/([a-z0-9_]+\.[a-z0-9_]+)(\?.*)?$/, domain: "media_player" },
];

function validateSignPath(msg: Obj, ctx: CommandContext): Verdict {
  const path = msg.path;
  if (typeof path !== "string") return reject("path required");
  for (const { re, domain } of SIGNABLE_PATHS) {
    const m = re.exec(path);
    if (!m) continue;
    const id = m[1]!;
    if (!A(ctx).has(id) || entityDomain(id) !== domain) return reject("path not allowed");
    const expires = typeof msg.expires === "number" ? Math.min(Math.max(1, msg.expires), 300) : 30;
    return forward({ id: msg.id, type: "auth/sign_path", path, expires });
  }
  return reject("path not allowed");
}

// ── subscribe_entities ───────────────────────────────────────────────────

function validateSubscribeEntities(msg: Obj, ctx: CommandContext): Verdict {
  const ids = [...A(ctx)];
  if (ids.length === 0) {
    // HA treats an empty entity_ids list as "all entities".
    return { kind: "reply", result: null, events: [{ a: {} }] };
  }
  return forward({ id: msg.id, type: "subscribe_entities", entity_ids: ids });
}

// ── frontend user data ───────────────────────────────────────────────────

/** Value of a frontend user-data key as the proxy answers it; undefined = not allowed. */
function localUserData(key: unknown, ctx: CommandContext): unknown {
  switch (key) {
    case "language":
      return null;
    case "theme":
      // Unset: the frontend follows HA's default theme and the themes set on
      // the dashboard and its views; dark mode follows the device.
      return null;
    case "core":
      return null;
    default:
      return undefined;
  }
}

// ── the table ────────────────────────────────────────────────────────────

const HISTORY_FIELDS = ["entity_ids", "start_time", "end_time", "minimal_response", "no_attributes", "significant_changes_only", "include_start_time_state"];
const LOGBOOK_FIELDS = ["entity_ids", "start_time", "end_time"];

export const COMMANDS: Record<string, CommandSpec> = {
  // Subscriptions
  subscribe_events: {
    fields: ["event_type"],
    subscription: true,
    validate: (msg) =>
      typeof msg.event_type === "string" && ALLOWED_EVENT_TYPES.has(msg.event_type) ? forward(msg) : reject("event_type not allowed"),
    filterEvent: filterSubscribedEvent,
  },
  subscribe_entities: {
    fields: ["entity_ids"],
    subscription: true,
    validate: validateSubscribeEntities,
    filterEvent: (event, ctx) => F.filterSubscribeEntitiesEvent(event, A(ctx)),
  },
  unsubscribe_events: {
    fields: ["subscription"],
    validate: (msg, ctx) =>
      typeof msg.subscription === "number" && ctx.subscriptions.has(msg.subscription) ? forward(msg) : reject("unknown subscription"),
  },

  // Core
  ping: { fields: [] },
  get_states: { fields: [], filterResult: (r, ctx) => F.filterStates(r, A(ctx)) },
  get_config: { fields: [], filterResult: (r) => F.scrubConfig(r) },
  get_services: {
    fields: [],
    filterResult: (r, ctx) => F.filterServices(r, ctx.dashboard.allowedDomains, (domain, service) => serviceVisible(domain, service, ctx)),
  },
  get_panels: { fields: [], filterResult: (r, ctx) => F.filterPanels(r, ctx.dashboard.id) },
  supported_features: { fields: ["features"] },
  call_service: { fields: ["domain", "service", "target", "service_data", "return_response"], validate: validateCallService },

  // Auth & brands
  "auth/current_user": {
    fields: [],
    validate: () => ({
      kind: "reply",
      result: { id: "guest", name: "Guest", is_owner: false, is_admin: false, credentials: [], mfa_modules: [] },
    }),
  },
  "auth/sign_path": { fields: ["path", "expires"], validate: validateSignPath },
  "brands/access_token": { fields: [] },

  // Frontend
  "frontend/get_themes": { fields: [] },
  "frontend/get_translations": { fields: ["language", "category", "integration", "config_flow"] },
  "frontend/get_icons": { fields: ["category", "integration"] },
  // User data belongs to the HA user behind the proxy token, so it is never
  // read from or written to HA. "language" is answered as unset (guests pick
  // it on their device), "theme" is unset (HA's default theme applies), and saving either is
  // acknowledged without effect: the frontend keeps the choice locally.
  "frontend/get_user_data": {
    fields: ["key"],
    validate: (msg, ctx) => {
      const value = localUserData(msg.key, ctx);
      return value === undefined ? reject("key not allowed") : { kind: "reply", result: { value } };
    },
  },
  "frontend/subscribe_user_data": {
    fields: ["key"],
    subscription: true,
    validate: (msg, ctx) => {
      const value = localUserData(msg.key, ctx);
      return value === undefined ? reject("key not allowed") : { kind: "reply", result: null, events: [{ value }] };
    },
  },
  "frontend/set_user_data": {
    fields: ["key", "value"],
    validate: (msg) => (msg.key === "language" || msg.key === "theme" ? { kind: "reply", result: null } : reject("key not allowed")),
  },
  "frontend/subscribe_system_data": { fields: ["key"], subscription: true, validate: keyIn(["core", "labs"]) },

  // Lovelace (read-only)
  // HA's lovelace/info takes no parameters (it only reports the resource mode).
  "lovelace/info": { fields: [], validate: (msg) => forward({ id: msg.id, type: "lovelace/info" }) },
  "lovelace/config": {
    fields: ["url_path", "force"],
    validate: (msg, ctx) => forward({ id: msg.id, type: "lovelace/config", url_path: ctx.dashboard.urlPath, force: msg.force === true }),
    // Links the admin has not allowed are removed (see dashboard/interactions.ts).
    filterResult: (r, ctx) => ctx.dashboard.guestConfig(r),
  },
  "lovelace/dashboards/list": {
    fields: [],
    validate: (_msg, ctx) => ({
      kind: "reply",
      result:
        ctx.dashboard.urlPath === null
          ? []
          : [
              {
                id: ctx.dashboard.id,
                title: ctx.dashboard.id,
                url_path: ctx.dashboard.urlPath,
                mode: "storage",
                show_in_sidebar: true,
                require_admin: false,
                icon: null,
              },
            ],
    }),
  },
  // Lovelace resources are custom JavaScript (custom cards, plugins such as
  // wallpanel). Guest dashboards cannot use custom cards, so guests get an
  // empty list and no foreign code runs in the guest UI.
  "lovelace/resources": { fields: [], validate: () => ({ kind: "reply", result: [] }) },

  // Registries
  "config/entity_registry/list": { fields: [], filterResult: (r, ctx) => F.filterEntityRegistry(r, A(ctx)) },
  "config/entity_registry/list_for_display": { fields: [], filterResult: (r, ctx) => F.filterEntityRegistryDisplay(r, A(ctx)) },
  "config/entity_registry/get": {
    fields: ["entity_id"],
    validate: requireEntity("entity_id"),
    filterResult: (r, ctx) => F.filterEntityRegistryEntry(r, A(ctx)),
  },
  "config/entity_registry/get_entries": {
    fields: ["entity_ids"],
    validate: requireEntityList("entity_ids"),
    filterResult: (r, ctx) => F.filterEntityRegistryEntries(r, A(ctx)),
  },
  "config/device_registry/list": { fields: [], filterResult: (r, ctx) => F.filterDeviceRegistry(r, ctx.dashboard.allowedDevices) },
  "config/area_registry/list": { fields: [] },
  "config/floor_registry/list": { fields: [] },

  // History & recorder
  "history/history_during_period": {
    fields: HISTORY_FIELDS,
    validate: requireEntityList("entity_ids"),
    filterResult: (r, ctx, original) => F.filterEntityKeyedDict(r, requestedIds(original, "entity_ids", ctx)),
  },
  "history/stream": {
    fields: HISTORY_FIELDS,
    subscription: true,
    validate: requireEntityList("entity_ids"),
    filterEvent: (e, ctx, original) => F.filterHistoryStreamEvent(e, requestedIds(original, "entity_ids", ctx)),
  },
  "logbook/get_events": {
    fields: LOGBOOK_FIELDS,
    validate: requireEntityList("entity_ids"),
    filterResult: (r, ctx) => F.filterLogbookEntries(r, A(ctx)),
  },
  "logbook/event_stream": {
    fields: LOGBOOK_FIELDS,
    subscription: true,
    validate: requireEntityList("entity_ids"),
    filterEvent: (e, ctx) => F.filterLogbookStreamEvent(e, A(ctx)),
  },
  "recorder/get_statistics_metadata": { fields: ["statistic_ids"], validate: requireEntityList("statistic_ids") },
  "recorder/statistics_during_period": {
    fields: ["statistic_ids", "start_time", "end_time", "period", "units", "types"],
    validate: requireEntityList("statistic_ids"),
    filterResult: (r, ctx, original) => F.filterStatisticsDict(r, requestedIds(original, "statistic_ids", ctx)),
  },
  "recorder/statistic_during_period": {
    fields: ["statistic_id", "types", "units", "fixed_period", "calendar", "rolling_window"],
    validate: requireEntity("statistic_id"),
  },

  // Camera
  "camera/stream": {
    fields: ["entity_id", "format"],
    validate: (msg, ctx) => {
      if (msg.format !== undefined && msg.format !== "hls") return reject("format not allowed");
      return requireEntity("entity_id", "camera")(msg, ctx);
    },
  },
  "camera/capabilities": { fields: ["entity_id"], validate: requireEntity("entity_id", "camera") },
  "camera/webrtc/get_client_config": { fields: ["entity_id"], validate: requireEntity("entity_id", "camera") },
  "camera/webrtc/offer": { fields: ["entity_id", "offer"], subscription: true, validate: requireEntity("entity_id", "camera") },
  "camera/webrtc/candidate": { fields: ["entity_id", "session_id", "candidate"], validate: requireEntity("entity_id", "camera") },

  // Todo, weather & update
  "todo/item/list": { fields: ["entity_id"], validate: requireEntity("entity_id", "todo") },
  "todo/item/subscribe": { fields: ["entity_id"], subscription: true, validate: requireEntity("entity_id", "todo") },
  "todo/item/move": { fields: ["entity_id", "uid", "previous_uid"], validate: requireEntity("entity_id", "todo") },
  "weather/subscribe_forecast": {
    fields: ["entity_id", "forecast_type"],
    subscription: true,
    validate: (msg, ctx) => {
      if (!["daily", "hourly", "twice_daily"].includes(String(msg.forecast_type))) return reject("forecast_type not allowed");
      return requireEntity("entity_id", "weather")(msg, ctx);
    },
  },
  // more-info of update entities with the RELEASE_NOTES feature
  "update/release_notes": { fields: ["entity_id"], validate: requireEntity("entity_id", "update") },

  // Templates & media
  render_template: {
    fields: ["template", "entity_ids", "variables", "timeout", "strict", "report_errors"],
    subscription: true,
    validate: validateRenderTemplate,
  },
  // Dashboard visibility conditions, evaluated by HA (see dashboard/conditions.ts)
  subscribe_condition: { fields: ["condition"], subscription: true, validate: validateSubscribeCondition },
  "media_source/resolve_media": {
    fields: ["media_content_id", "expires"],
    validate: (msg, ctx) =>
      typeof msg.media_content_id === "string" && ctx.dashboard.mediaSources.has(msg.media_content_id)
        ? forward(msg)
        : reject("media_content_id not allowed"),
  },

  // Maps (map card, person more-info): a token for HA's map tile proxy, which
  // the frontend adds to its /api/map_tiles/* requests (see proxy/http.ts).
  "map_tiles/access_token": { fields: [] },

  // manifest/list and manifest/get are not offered: they describe every
  // installed integration, and only admin views of the frontend use them.
};

// ── evaluation ───────────────────────────────────────────────────────────

/**
 * Evaluates a guest command. Unknown types and unexpected fields are rejected;
 * otherwise the command-specific validator decides.
 */
export function evaluate(msg: Obj, ctx: CommandContext): Verdict {
  const type = msg.type;
  if (typeof type !== "string") return reject("type required");
  const spec = COMMANDS[type];
  if (!spec) return reject(`command "${type}" not permitted`);

  const picked: Obj = { id: msg.id, type };
  for (const key of Object.keys(msg)) {
    if (key === "id" || key === "type") continue;
    if (!spec.fields.includes(key)) return reject(`field "${key}" not permitted for ${type}`);
    picked[key] = msg[key];
  }

  return spec.validate ? spec.validate(picked, ctx) : forward(picked);
}
