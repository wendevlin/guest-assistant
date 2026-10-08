/**
 * Extracts everything from a Lovelace dashboard config that the proxy later
 * needs as an allowlist: entity ids, markdown templates, media-source ids,
 * media content ids of actions.
 *
 * Modelled after the frontend's computeUsedEntities()
 * (frontend/src/panels/lovelace/common/compute-unused-entities.ts) but walks
 * the whole config generically so conditions, visibility rules, features,
 * perform-action targets etc. are covered as well. Over-collecting is fine:
 * every collected id was written into the dashboard by an admin.
 */

import { canonical, isConditionLeaf } from "./conditions";

export type Obj = Record<string, unknown>;

export interface Extraction {
  entities: Set<string>;
  /** markdown card `content` -> full card config (used as render_template variables) */
  templates: Map<string, Obj>;
  /** `media-source://…` ids referenced as images or in play_media actions */
  mediaSources: Set<string>;
  /** every `media_content_id` in action data: what `media_player.play_media` may play */
  mediaContentIds: Set<string>;
  /** canonical JSON of every condition leaf (see conditions.ts) */
  conditions: Set<string>;
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
    mediaContentIds: new Set(),
    conditions: new Set(),
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
  // An image may also be a `{ media_content_id }` object, reached by the walk.
  const images = [node.image, node.dark_mode_image, node.media_content_id];
  if (isObj(node.state_image)) images.push(...Object.values(node.state_image));
  for (const value of images) {
    if (typeof value === "string" && value.startsWith("media-source://")) out.mediaSources.add(value);
  }
  // Service data of actions (perform-action, call-service, service-button):
  // `media_content_id` directly or inside a media selector value (`media`).
  for (const key of ["data", "service_data"]) {
    const data = node[key];
    if (!isObj(data)) continue;
    for (const id of [data.media_content_id, isObj(data.media) ? data.media.media_content_id : undefined]) {
      if (typeof id === "string") out.mediaContentIds.add(id);
    }
  }

  if (isConditionLeaf(node)) out.conditions.add(canonical(node));
  // Conditions may compare against other entities (`state: input_select.mode`, `above: input_number.min`).
  if (typeof node.condition === "string" || "entity" in node) {
    for (const key of ["state", "state_not", "above", "below"]) {
      for (const value of [node[key]].flat()) if (isEntityId(value)) out.entities.add(value);
    }
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
