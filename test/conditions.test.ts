import { describe, expect, test } from "bun:test";
import { Dashboard } from "../src/dashboard";
import { checkCondition, findConditions } from "../src/dashboard/conditions";
import { validate } from "../src/dashboard/validate";
import { evaluate, type Verdict } from "../src/proxy/ws-commands";

/** Leaves the frontend sends to HA verbatim, plus lovelace conditions it translates. */
const CONDITIONS_DASHBOARD = {
  views: [
    {
      cards: [
        {
          type: "tile",
          entity: "light.kitchen",
          visibility: [
            { condition: "state", entity: "light.kitchen", state: "on" },
            { condition: "template", value_template: "{{ is_state('sun.sun', 'below_horizon') }}" },
            {
              condition: "or",
              conditions: [
                { condition: "device", device_id: "abc123", domain: "binary_sensor", entity_id: "binary_sensor.door", type: "is_open" },
                { condition: "light.is_on", target: { area_id: "kitchen" }, options: { behavior: "any" } },
              ],
            },
            { condition: "user", users: ["u1"] },
            { condition: "screen", media_query: "(min-width: 600px)" },
          ],
        },
        {
          type: "conditional",
          conditions: [{ entity: "sensor.temp", state_not: "unavailable" }],
          card: { type: "entity", entity: "sensor.temp" },
        },
        { type: "entity", entity: "sensor.power", visibility: [{ condition: "numeric_state", entity: "sensor.power", above: "input_number.min" }] },
      ],
    },
  ],
};

const dashboard = new Dashboard("cond-dash");
dashboard.applyConfig(CONDITIONS_DASHBOARD);

const check = (condition: unknown) => checkCondition(condition, dashboard.conditions, dashboard.entities);
const TEMPLATE = { condition: "template", value_template: "{{ is_state('sun.sun', 'below_horizon') }}" };
const DEVICE = { condition: "device", device_id: "abc123", domain: "binary_sensor", entity_id: "binary_sensor.door", type: "is_open" };

describe("dashboard analysis", () => {
  test("templates, devices and area targets inside conditions do not reject the dashboard", () => {
    expect(validate(CONDITIONS_DASHBOARD)).toEqual([]);
    expect(dashboard.status).toBe("ok");
  });

  test("entities that conditions compare against are allowed", () => {
    expect(dashboard.entities.has("input_number.min")).toBe(true);
  });

  test("condition types are listed for the admin", () => {
    expect(findConditions(CONDITIONS_DASHBOARD).map((c) => [c.type, c.paths.length])).toEqual([
      ["device", 1],
      ["light.is_on", 1],
      ["numeric_state", 1],
      ["screen", 1],
      ["state", 2],
      ["template", 1],
      ["user", 1],
    ]);
  });

  test("templates outside conditions still reject the dashboard", () => {
    expect(validate({ views: [{ cards: [{ type: "tile", entity: "light.x", name: "{{ states('lock.y') }}" }] }] }).map((v) => v.rule)).toEqual([
      "template",
    ]);
  });
});

describe("subscribe_condition", () => {
  test("leaves written on the dashboard pass verbatim, regardless of key order", () => {
    expect(check(TEMPLATE)).toBeUndefined();
    expect(check({ type: "is_open", entity_id: "binary_sensor.door", domain: "binary_sensor", device_id: "abc123", condition: "device" })).toBeUndefined();
    expect(check({ condition: "light.is_on", target: { area_id: "kitchen" }, options: { behavior: "any" } })).toBeUndefined();
  });

  test("the frontend's translations and groupings pass", () => {
    // lovelace state -> core state; state_not -> not(state); siblings grouped under and/or
    expect(check({ condition: "and", conditions: [{ condition: "state", entity_id: "light.kitchen", state: "on" }, TEMPLATE] })).toBeUndefined();
    expect(check({ condition: "not", conditions: [{ condition: "state", entity_id: "sensor.temp", state: "unavailable" }] })).toBeUndefined();
    expect(check({ condition: "or", conditions: [DEVICE] })).toBeUndefined();
    // numeric_state without bounds becomes an is_number template
    expect(check({ condition: "template", value_template: '{{ is_number(states("sensor.power")) }}' })).toBeUndefined();
    expect(check({ condition: "template", value_template: '{{ is_number(state_attr("sensor.power", "current")) }}' })).toBeUndefined();
    // missing entity becomes an always-false condition
    expect(check({ condition: "not", conditions: [{ condition: "and", conditions: [] }] })).toBeUndefined();
  });

  test("state and numeric_state work on any allowed entity", () => {
    expect(check({ condition: "state", entity_id: ["sensor.temp", "light.kitchen"], state: ["on", "off"], attribute: "x" })).toBeUndefined();
    expect(check({ condition: "numeric_state", entity_id: "sensor.power", above: "input_number.min", below: 5 })).toBeUndefined();
  });

  test("anything else is rejected", () => {
    // foreign entities
    expect(check({ condition: "state", entity_id: "lock.front", state: "unlocked" })).toBeDefined();
    expect(check({ condition: "numeric_state", entity_id: "sensor.power", above: "sensor.secret" })).toBeDefined();
    expect(check({ condition: "state", entity_id: "sensor.temp", state: "sensor.secret" })).toBeDefined();
    // templates the admin did not write
    expect(check({ condition: "template", value_template: "{{ states('lock.front') == 'unlocked' }}" })).toBeDefined();
    expect(check({ condition: "template", value_template: '{{ is_number(states("lock.front")) }}' })).toBeDefined();
    expect(check({ condition: "template", value_template: '{{ is_number(states("sensor.power")) }}{{ states("lock.front") }}' })).toBeDefined();
    expect(check({ condition: "numeric_state", entity_id: "sensor.power", value_template: "{{ states('lock.front') }}", above: 1 })).toBeDefined();
    expect(check({ condition: "state", entity_id: "sensor.temp", state: "on", for: "{{ states('lock.front') | int }}" })).toBeDefined();
    expect(check({ condition: "and", enabled: "{{ is_state('lock.front', 'unlocked') }}", conditions: [] })).toBeDefined();
    // changed device, other targets, nested inside an allowed combinator
    expect(check({ ...DEVICE, entity_id: "lock.front" })).toBeDefined();
    expect(check({ condition: "light.is_on", target: { area_id: "bedroom" }, options: { behavior: "any" } })).toBeDefined();
    expect(check({ condition: "or", conditions: [TEMPLATE, { condition: "zone", entity_id: "person.anna", zone: "zone.home" }] })).toBeDefined();
    expect(check({ condition: "trigger", id: "x" })).toBeDefined();
    expect(check("state")).toBeDefined();
  });

  test("the command is forwarded only with an allowed condition", () => {
    const run = (condition: unknown): Verdict =>
      evaluate({ id: 1, type: "subscribe_condition", condition }, { dashboard, subscriptions: new Map() });
    expect(run(TEMPLATE)).toEqual({ kind: "forward", msg: { id: 1, type: "subscribe_condition", condition: TEMPLATE } });
    expect(run({ condition: "state", entity_id: "lock.front", state: "unlocked" }).kind).toBe("reject");
    expect(evaluate({ id: 1, type: "subscribe_condition", condition: TEMPLATE, variables: {} }, { dashboard, subscriptions: new Map() }).kind).toBe(
      "reject",
    );
  });

  test("changed conditions count as an access change", () => {
    const d = new Dashboard("x");
    d.applyConfig(CONDITIONS_DASHBOARD);
    const views = CONDITIONS_DASHBOARD.views.map((v) => ({ ...v, cards: [...v.cards, { type: "tile", entity: "light.kitchen", visibility: [TEMPLATE, { condition: "sun", after: "sunset" }] }] }));
    d.applyConfig({ views });
    expect(d.accessChanged).toBe(true);
  });
});
