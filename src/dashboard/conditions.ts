/**
 * Visibility conditions on a dashboard.
 *
 * The HA frontend evaluates stateful conditions in core: it sends them with
 * `subscribe_condition` and gets back only true/false. Lovelace `state` and
 * `numeric_state` conditions are translated to the core shape first, sibling
 * conditions are grouped into `and`/`or`, and entity-less conditions get the
 * card's entity. `screen`, `user`, `view_columns`, `location` and `time`
 * stay in the browser.
 *
 * A guest may subscribe to any `and`/`or`/`not` combination of leaves where
 * each leaf is either
 * - written verbatim on the dashboard (template, device, zone, sun, platform
 *   conditions, …), or
 * - a plain `state`/`numeric_state` condition on allowed entities, which only
 *   tells the guest what the entity's state already does, or
 * - the `is_number` template the frontend generates for a `numeric_state`
 *   condition without bounds, on an allowed entity.
 * Combining allowed leaves reveals nothing beyond the leaves themselves.
 */
import { hasTemplate, isEntityId, isObj, type Obj } from "./extract";

const LOGICAL = new Set(["and", "or", "not"]);
/** Evaluated in the browser, never sent to HA. */
export const CLIENT_CONDITIONS = new Set(["screen", "user", "view_columns", "location", "time"]);
/** Keys the frontend copies from a lovelace condition onto its core translation. */
const ROW_KEYS = ["alias", "note", "enabled"];
const STATE_KEYS = new Set(["condition", "entity_id", "attribute", "state", "match", "for", ...ROW_KEYS]);
const NUMERIC_STATE_KEYS = new Set(["condition", "entity_id", "attribute", "above", "below", ...ROW_KEYS]);
const TEMPLATE_KEYS = new Set(["condition", "value_template", ...ROW_KEYS]);

const JSON_STRING = String.raw`("(?:[^"\\]|\\.)*")`;
const IS_NUMBER_STATE = new RegExp(String.raw`^\{\{ is_number\(states\(${JSON_STRING}\)\) \}\}$`);
const IS_NUMBER_ATTR = new RegExp(String.raw`^\{\{ is_number\(state_attr\(${JSON_STRING}, ${JSON_STRING}\)\) \}\}$`);

/** JSON with sorted object keys, so equal conditions compare equal. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObj(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

/** A node with a `condition` key that is not `and`/`or`/`not`. */
export function isConditionLeaf(node: Obj): boolean {
  return typeof node.condition === "string" && !LOGICAL.has(node.condition);
}

/**
 * Condition type of a node inside a `visibility` or `conditions` list:
 * the `condition` key, or `state` for the legacy `{ entity, state }` shape.
 */
function conditionType(node: Obj): string | undefined {
  if (typeof node.condition === "string") return node.condition;
  if ("entity" in node && ("state" in node || "state_not" in node)) return "state";
  return undefined;
}

export interface ConditionUse {
  type: string;
  paths: string[];
}

/** Every condition type used on the dashboard and where, for the admin. */
export function findConditions(config: Obj): ConditionUse[] {
  const uses = new Map<string, string[]>();
  const visit = (node: unknown, path: string, inList: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`, inList));
      return;
    }
    if (!isObj(node)) return;
    const type = inList ? conditionType(node) : undefined;
    if (type && !LOGICAL.has(type)) {
      const paths = uses.get(type) ?? [];
      paths.push(path);
      uses.set(type, paths);
    }
    for (const [key, value] of Object.entries(node)) {
      visit(value, `${path}.${key}`, key === "visibility" || key === "conditions");
    }
  };
  visit(config, "$", false);
  return [...uses.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, paths]) => ({ type, paths }));
}

/**
 * Checks a `subscribe_condition` request. Returns an error message, or
 * undefined if the guest may subscribe.
 */
export function checkCondition(
  condition: unknown,
  leaves: ReadonlySet<string>,
  entities: ReadonlySet<string>,
): string | undefined {
  if (!isObj(condition) || typeof condition.condition !== "string") return "invalid condition";

  if (LOGICAL.has(condition.condition)) {
    for (const key of Object.keys(condition)) {
      if (key !== "condition" && key !== "conditions" && !ROW_KEYS.includes(key)) return `field "${key}" not permitted`;
    }
    if (condition.enabled !== undefined && typeof condition.enabled !== "boolean") return "enabled must be a boolean";
    if (hasTemplate(condition.alias) || hasTemplate(condition.note)) return "templates not permitted";
    const children = condition.conditions;
    if (children === undefined) return undefined;
    for (const child of Array.isArray(children) ? children : [children]) {
      const error = checkCondition(child, leaves, entities);
      if (error) return error;
    }
    return undefined;
  }

  if (leaves.has(canonical(condition))) return undefined;
  if (isEntityCondition(condition, entities) || isNumberTemplate(condition, entities)) return undefined;
  return "condition not on the dashboard";
}

/** `state` / `numeric_state` on allowed entities, without templates. */
function isEntityCondition(condition: Obj, entities: ReadonlySet<string>): boolean {
  const keys = condition.condition === "state" ? STATE_KEYS : condition.condition === "numeric_state" ? NUMERIC_STATE_KEYS : null;
  if (!keys || !Object.keys(condition).every((key) => keys.has(key))) return false;
  if (containsTemplate(condition)) return false;
  if (condition.enabled !== undefined && typeof condition.enabled !== "boolean") return false;

  const ids = Array.isArray(condition.entity_id) ? condition.entity_id : [condition.entity_id];
  if (ids.length === 0 || !ids.every((id) => isEntityId(id) && entities.has(id))) return false;
  if (condition.attribute !== undefined && typeof condition.attribute !== "string") return false;

  // Comparison values may name other entities; those must be allowed too.
  const values = condition.condition === "state" ? [condition.state].flat() : [condition.above, condition.below];
  return values.every((value) => {
    if (value === undefined && condition.condition === "numeric_state") return true;
    if (typeof value === "number" || typeof value === "boolean") return true;
    if (typeof value !== "string") return false;
    return !isEntityId(value) || entities.has(value);
  });
}

/** The template the frontend generates for a `numeric_state` condition without bounds. */
function isNumberTemplate(condition: Obj, entities: ReadonlySet<string>): boolean {
  if (condition.condition !== "template" || typeof condition.value_template !== "string") return false;
  if (!Object.keys(condition).every((key) => TEMPLATE_KEYS.has(key))) return false;
  if (condition.enabled !== undefined && typeof condition.enabled !== "boolean") return false;
  if (hasTemplate(condition.alias) || hasTemplate(condition.note)) return false;
  const match = IS_NUMBER_STATE.exec(condition.value_template) ?? IS_NUMBER_ATTR.exec(condition.value_template);
  if (!match) return false;
  try {
    const entityId: unknown = JSON.parse(match[1]!);
    if (match[2] !== undefined && typeof JSON.parse(match[2]) !== "string") return false;
    return isEntityId(entityId) && entities.has(entityId);
  } catch {
    return false;
  }
}

function containsTemplate(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTemplate);
  if (isObj(value)) return Object.values(value).some(containsTemplate);
  return hasTemplate(value);
}
