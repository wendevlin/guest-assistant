/**
 * Extracts everything from a Lovelace dashboard config that the proxy later
 * needs as an allowlist: entity ids, markdown templates, media-source ids.
 *
 * Modelled after the frontend's computeUsedEntities()
 * (frontend/src/panels/lovelace/common/compute-unused-entities.ts) but walks
 * the whole config generically so conditions, visibility rules, features,
 * perform-action targets etc. are covered as well. Over-collecting is fine:
 * every collected id was written into the dashboard by an admin.
 */

export type Obj = Record<string, unknown>;

export interface Extraction {
  entities: Set<string>;
  /** markdown card `content` -> full card config (used as render_template variables) */
  templates: Map<string, Obj>;
  /** `media-source://…` ids referenced as images or in play_media actions */
  mediaSources: Set<string>;
}

/** Keys whose values reference entities (string, string[] or { entity }). */
const ENTITY_KEYS = new Set([
  "entity",
  "entities",
  "entity_id",
  "entity_ids",
  "camera_image",
  "image_entity",
  "badges",
]);

const ENTITY_ID_RE = /^[a-z_0-9]+\.[a-z_0-9]+$/;

export function isEntityId(value: unknown): value is string {
  return typeof value === "string" && ENTITY_ID_RE.test(value);
}

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function entityDomain(entityId: string): string {
  return entityId.slice(0, entityId.indexOf("."));
}

export function extract(config: Obj): Extraction {
  const out: Extraction = {
    entities: new Set(),
    templates: new Map(),
    mediaSources: new Set(),
  };
  walk(config, out);
  return out;
}

function walk(node: unknown, out: Extraction): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return;
  }
  if (!isObj(node)) return;

  if (node.type === "markdown" && typeof node.content === "string") {
    out.templates.set(node.content, node);
  }
  for (const key of ["image", "media_content_id"]) {
    const value = node[key];
    if (typeof value === "string" && value.startsWith("media-source://")) out.mediaSources.add(value);
  }

  for (const [key, value] of Object.entries(node)) {
    if (ENTITY_KEYS.has(key)) collectEntities(value, out.entities);
    walk(value, out);
  }
}

function collectEntities(value: unknown, entities: Set<string>): void {
  if (isEntityId(value)) {
    entities.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEntities(item, entities);
  } else if (isObj(value) && isEntityId(value.entity)) {
    entities.add(value.entity);
  }
}

/** Does the string contain a Jinja template? */
export function hasTemplate(value: unknown): value is string {
  return typeof value === "string" && (value.includes("{{") || value.includes("{%"));
}
