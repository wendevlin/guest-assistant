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

/** MediaPlayerEntityFeature.BROWSE_MEDIA (frontend src/data/feature/media-player_entity_feature.ts). */
const MEDIA_PLAYER_BROWSE_MEDIA = 131072;

/**
 * Attributes of an allowed entity as guests get them. Media browsing is
 * denied (it can list local media and cameras), so media players do not
 * announce it and the frontend hides its "Browse media" buttons. Anything
 * changed is a copy; the input is left as it is.
 */
export function guestAttributes(entityId: string, attributes: unknown): unknown {
  if (!entityId.startsWith("media_player.") || !isObj(attributes)) return attributes;
  const features = attributes.supported_features;
  if (typeof features !== "number" || (features & MEDIA_PLAYER_BROWSE_MEDIA) === 0) return attributes;
  return { ...attributes, supported_features: features & ~MEDIA_PLAYER_BROWSE_MEDIA };
}

/** A state object ({ entity_id, state, attributes, … }) as guests get it. */
export function guestState(state: unknown): unknown {
  if (!isObj(state) || typeof state.entity_id !== "string") return state;
  const attributes = guestAttributes(state.entity_id, state.attributes);
  return attributes === state.attributes ? state : { ...state, attributes };
}

/** get_states result (and REST /api/states): array of state objects. */
export function filterStates(result: unknown, A: EntitySet): unknown {
  if (!Array.isArray(result)) return [];
  return result.filter((s) => isObj(s) && typeof s.entity_id === "string" && A.has(s.entity_id)).map(guestState);
}

/**
 * subscribe_entities event: { a: {id: state}, c: {id: diff}, r: [id] }.
 * Compressed states carry their attributes in `a`, diffs the changed ones in `+.a`.
 */
export function filterSubscribeEntitiesEvent(event: unknown, A: EntitySet): unknown {
  if (!isObj(event)) return event;
  const out: Obj = { ...event };
  if (isObj(event.a)) out.a = mapValues(pickKeys(event.a, A), withGuestAttributes);
  if (isObj(event.c)) {
    out.c = mapValues(pickKeys(event.c, A), (id, diff) =>
      isObj(diff) && isObj(diff["+"]) ? { ...diff, "+": withGuestAttributes(id, diff["+"]) } : diff,
    );
  }
  if (Array.isArray(event.r)) out.r = event.r.filter((id) => typeof id === "string" && A.has(id));
  return out;
}

/** A compressed state or diff with its attributes (`a`) as guests get them. */
function withGuestAttributes(entityId: string, compressed: unknown): unknown {
  if (!isObj(compressed)) return compressed;
  const attributes = guestAttributes(entityId, compressed.a);
  return attributes === compressed.a ? compressed : { ...compressed, a: attributes };
}

/** state_changed event: { data: { entity_id, new_state, old_state } } */
export function filterStateChangedEvent(event: Obj): Obj {
  if (!isObj(event.data)) return event;
  const data = event.data;
  return { ...event, data: { ...data, new_state: guestState(data.new_state), old_state: guestState(data.old_state) } };
}

/**
 * Registry fields guests do not get: `unique_id` is chosen by the integration
 * and often is a MAC address or serial number. The guest UI falls back to the
 * entity id where it reads it (more-info of scripts).
 */
function scrubEntityEntry(entry: Obj): Obj {
  const copy: Obj = { ...entry };
  delete copy.unique_id;
  return copy;
}

/** config/entity_registry/list: array of entries; e.g. the light color favorites read `options` from it. */
export function filterEntityRegistry(result: unknown, A: EntitySet): unknown {
  if (!Array.isArray(result)) return [];
  return result.filter((e): e is Obj => isObj(e) && typeof e.entity_id === "string" && A.has(e.entity_id)).map(scrubEntityEntry);
}

/** config/entity_registry/get: one extended entry of an allowed entity. */
export function filterEntityRegistryEntry(result: unknown, A: EntitySet): unknown {
  if (!isObj(result) || typeof result.entity_id !== "string" || !A.has(result.entity_id)) return null;
  return scrubEntityEntry(result);
}

/** config/entity_registry/get_entries: { entity_id: entry | null } */
export function filterEntityRegistryEntries(result: unknown, A: EntitySet): unknown {
  if (!isObj(result)) return {};
  return mapValues(pickKeys(result, A), (_id, entry) => (isObj(entry) ? scrubEntityEntry(entry) : null));
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

function mapValues(obj: Obj, fn: (key: string, value: unknown) => unknown): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(obj)) out[key] = fn(key, value);
  return out;
}
