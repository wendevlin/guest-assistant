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
  "label_registry_updated",
  "category_registry_updated",
]);

function filterSubscribedEvent(event: unknown, ctx: CommandContext, original: Obj): unknown | typeof DROP {
  if (!isObj(event)) return DROP;
  const data = isObj(event.data) ? event.data : {};
  switch (original.event_type) {
    case "state_changed":
      return typeof data.entity_id === "string" && A(ctx).has(data.entity_id) ? event : DROP;
    case "entity_registry_updated": {
      const ids = [data.entity_id, data.old_entity_id].filter((x): x is string => typeof x === "string");
      return ids.some((id) => A(ctx).has(id)) ? event : DROP;
    }
    case "device_registry_updated":
      return typeof data.device_id === "string" && ctx.dashboard.allowedDevices.has(data.device_id) ? event : DROP;
    case "lovelace_updated":
      return (data.url_path ?? null) === ctx.dashboard.urlPath ? event : DROP;
    default:
      return event;
  }
}

// ── call_service ─────────────────────────────────────────────────────────

/** Entity-scoped services a guest may call, per domain. */
export const ENTITY_SERVICES: Record<string, readonly string[]> = {
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
const TARGET_SELECTOR_KEYS = ["entity_id", "device_id", "area_id", "label_id", "floor_id"];

function containsTemplate(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{{") || value.includes("{%");
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (isObj(value)) return Object.values(value).some(containsTemplate);
  return false;
}

export function validateCallService(msg: Obj, ctx: CommandContext): Verdict {
  const { domain, service } = msg;
  if (typeof domain !== "string" || typeof service !== "string") return reject("domain/service required");
  if (msg.return_response !== undefined && msg.return_response !== false) return reject("return_response not allowed");

  const target = msg.target;
  if (!isObj(target)) return reject("target.entity_id required");
  const extraTargetKeys = Object.keys(target).filter((k) => k !== "entity_id");
  if (extraTargetKeys.length > 0) return reject(`target may only contain entity_id`);
  const ids = allowedIds(target.entity_id, A(ctx));
  if (!ids) return reject("target.entity_id not allowed");

  if (msg.service_data !== undefined) {
    if (!isObj(msg.service_data)) return reject("service_data must be an object");
    for (const key of TARGET_SELECTOR_KEYS) {
      if (key in msg.service_data) return reject(`service_data.${key} not allowed`);
    }
    if (containsTemplate(msg.service_data)) return reject("templates in service_data not allowed");
  }

  if (domain === "homeassistant") {
    if (!HOMEASSISTANT_SERVICES.has(service)) return reject("service not allowed");
  } else {
    const allowed = ENTITY_SERVICES[domain];
    if (!allowed || !allowed.includes(service)) return reject("service not allowed");
    if (!ids.every((id) => entityDomain(id) === domain)) return reject("target domain mismatch");
  }

  const out: Obj = { id: msg.id, type: "call_service", domain, service, target: { entity_id: ids } };
  if (msg.service_data !== undefined) out.service_data = msg.service_data;
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
  get_services: { fields: [], filterResult: (r, ctx) => F.filterServices(r, ctx.dashboard.allowedDomains) },
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
  "frontend/get_user_data": { fields: ["key"], validate: keyIn(["core", "language", "theme"]) },
  "frontend/subscribe_user_data": { fields: ["key"], subscription: true, validate: keyIn(["core", "language", "theme"]) },
  "frontend/subscribe_system_data": { fields: ["key"], subscription: true, validate: keyIn(["labs"]) },

  // Lovelace (read-only)
  "lovelace/info": { fields: ["url_path"], validate: (msg, ctx) => forward({ id: msg.id, type: "lovelace/info", url_path: ctx.dashboard.urlPath }) },
  "lovelace/config": {
    fields: ["url_path", "force"],
    validate: (msg, ctx) => forward({ id: msg.id, type: "lovelace/config", url_path: ctx.dashboard.urlPath, force: msg.force === true }),
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
  "lovelace/resources": { fields: [] },
  "lovelace/resources/list": { fields: [] },

  // Registries
  "config/entity_registry/list_for_display": { fields: [], filterResult: (r, ctx) => F.filterEntityRegistryDisplay(r, A(ctx)) },
  "config/entity_registry/get": { fields: ["entity_id"], validate: requireEntity("entity_id") },
  "config/entity_registry/get_entries": { fields: ["entity_ids"], validate: requireEntityList("entity_ids") },
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

  // Todo & weather
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

  // Templates & media
  render_template: {
    fields: ["template", "entity_ids", "variables", "timeout", "strict", "report_errors"],
    subscription: true,
    validate: validateRenderTemplate,
  },
  "media_source/resolve_media": {
    fields: ["media_content_id", "expires"],
    validate: (msg, ctx) =>
      typeof msg.media_content_id === "string" && ctx.dashboard.mediaSources.has(msg.media_content_id)
        ? forward(msg)
        : reject("media_content_id not allowed"),
  },

  // Misc read-only
  "sensor/numeric_device_classes": { fields: [] },
  "manifest/list": { fields: ["integrations"] },
  "manifest/get": { fields: ["integration"] },
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
