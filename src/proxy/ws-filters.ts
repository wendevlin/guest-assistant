/**
 * Pure filter functions applied to HA responses/events before they reach a
 * guest. Every function receives the allowed entity set `A` (and, where
 * needed, allowed device ids) and returns a filtered copy.
 */

type Obj = Record<string, unknown>;
type EntitySet = ReadonlySet<string>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** get_states result: array of state objects. */
export function filterStates(result: unknown, A: EntitySet): unknown {
  if (!Array.isArray(result)) return [];
  return result.filter((s) => isObj(s) && typeof s.entity_id === "string" && A.has(s.entity_id));
}

/** subscribe_entities event: { a: {id: state}, c: {id: diff}, r: [id] } */
export function filterSubscribeEntitiesEvent(event: unknown, A: EntitySet): unknown {
  if (!isObj(event)) return event;
  const out: Obj = { ...event };
  if (isObj(event.a)) out.a = pickKeys(event.a, A);
  if (isObj(event.c)) out.c = pickKeys(event.c, A);
  if (Array.isArray(event.r)) out.r = event.r.filter((id) => typeof id === "string" && A.has(id));
  return out;
}

/** config/entity_registry/list: array of entries; e.g. the light color favorites read `options` from it. */
export function filterEntityRegistry(result: unknown, A: EntitySet): unknown {
  if (!Array.isArray(result)) return [];
  return result.filter((e) => isObj(e) && typeof e.entity_id === "string" && A.has(e.entity_id));
}

/** config/entity_registry/list_for_display: { entity_categories, entities: [{ ei, di, … }] } */
export function filterEntityRegistryDisplay(result: unknown, A: EntitySet): unknown {
  if (!isObj(result)) return result;
  const entities = Array.isArray(result.entities)
    ? result.entities.filter((e) => isObj(e) && typeof e.ei === "string" && A.has(e.ei))
    : [];
  return { ...result, entities };
}

const DEVICE_SENSITIVE_KEYS = ["connections", "identifiers", "configuration_url", "serial_number", "config_entries", "config_entries_subentries", "primary_config_entry", "hw_version", "sw_version"];

/** config/device_registry/list: array of device dicts. */
export function filterDeviceRegistry(result: unknown, devices: ReadonlySet<string>): unknown {
  if (!Array.isArray(result)) return [];
  return result
    .filter((d) => isObj(d) && typeof d.id === "string" && devices.has(d.id))
    .map((d) => {
      const copy: Obj = { ...(d as Obj) };
      for (const key of DEVICE_SENSITIVE_KEYS) {
        if (key in copy) copy[key] = Array.isArray(copy[key]) ? [] : null;
      }
      return copy;
    });
}

/** history/history_during_period result and history/stream `states`: dict keyed by entity_id. */
export function filterEntityKeyedDict(result: unknown, A: EntitySet): unknown {
  if (!isObj(result)) return {};
  return pickKeys(result, A);
}

/** history/stream event: { states: {…}, start_time, end_time } */
export function filterHistoryStreamEvent(event: unknown, A: EntitySet): unknown {
  if (!isObj(event)) return event;
  return { ...event, states: filterEntityKeyedDict(event.states, A) };
}

/** recorder/statistics_during_period: dict keyed by statistic_id. */
export const filterStatisticsDict = filterEntityKeyedDict;

const LOGBOOK_CONTEXT_KEYS = [
  "context_entity_id",
  "context_entity_id_name",
  "context_domain",
  "context_service",
  "context_user_id",
  "context_source",
  "context_event_type",
  "context_name",
  "context_message",
  "context_state",
  "context_id",
];

/** logbook entries: array of { entity_id?, context_* … } */
export function filterLogbookEntries(entries: unknown, A: EntitySet): unknown[] {
  if (!Array.isArray(entries)) return [];
  const out: unknown[] = [];
  for (const entry of entries) {
    if (!isObj(entry)) continue;
    if (typeof entry.entity_id !== "string" || !A.has(entry.entity_id)) continue;
    const copy: Obj = { ...entry };
    const ctxEntity = copy.context_entity_id;
    if (typeof ctxEntity !== "string" || !A.has(ctxEntity)) {
      for (const key of LOGBOOK_CONTEXT_KEYS) delete copy[key];
    }
    out.push(copy);
  }
  return out;
}

/** logbook/event_stream event: { events: [...], start_time, end_time, partial? } */
export function filterLogbookStreamEvent(event: unknown, A: EntitySet): unknown {
  if (!isObj(event)) return event;
  return { ...event, events: filterLogbookEntries(event.events, A) };
}

/** get_panels: { key: panel } → only the guest's own dashboard panel. */
export function filterPanels(result: unknown, dashboardId: string): unknown {
  if (!isObj(result)) return {};
  const panel = result[dashboardId];
  return panel === undefined ? {} : { [dashboardId]: panel };
}

/** get_config: strip location, URLs and the Assist entry point. */
export function scrubConfig(result: unknown): unknown {
  if (!isObj(result)) return result;
  const copy: Obj = { ...result };
  if (Array.isArray(copy.components)) {
    copy.components = copy.components.filter((c) => c !== "conversation");
  }
  copy.latitude = 0;
  copy.longitude = 0;
  copy.elevation = 0;
  copy.location_name = "Home";
  copy.external_url = null;
  copy.internal_url = null;
  copy.allowlist_external_dirs = [];
  copy.allowlist_external_urls = [];
  copy.whitelist_external_dirs = [];
  return copy;
}

/**
 * get_services: { domain: { service: … } } → only domains the guest may use,
 * and in them only the services `visible` lets through. A domain stays
 * present even if none of its services do, as the frontend looks domains up.
 */
export function filterServices(
  result: unknown,
  domains: ReadonlySet<string>,
  visible: (domain: string, service: string) => boolean,
): unknown {
  if (!isObj(result)) return {};
  const out: Obj = {};
  for (const [domain, services] of Object.entries(result)) {
    if (domain !== "homeassistant" && !domains.has(domain)) continue;
    out[domain] = isObj(services) ? Object.fromEntries(Object.entries(services).filter(([service]) => visible(domain, service))) : {};
  }
  return out;
}

function pickKeys(obj: Obj, allowed: EntitySet): Obj {
  const out: Obj = {};
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) out[key] = obj[key];
  }
  return out;
}
