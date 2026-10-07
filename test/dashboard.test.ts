import { describe, expect, test } from "bun:test";
import { Dashboard } from "../src/dashboard";
import { extract } from "../src/dashboard/extract";
import { sanitize, validate } from "../src/dashboard/validate";
import { AUTO_ENTITIES_DASHBOARD, GUEST_DASHBOARD, STRATEGY_DASHBOARD } from "./mock-ha";

describe("extract", () => {
  test("collects entities from cards, rows, conditions and actions", () => {
    const { entities, templates } = extract(GUEST_DASHBOARD);
    expect([...entities].sort()).toEqual(["camera.garden", "light.kitchen", "lock.front"]);
    expect([...templates.keys()]).toEqual(["Kitchen is {{ states('light.kitchen') }}"]);
  });

  test("covers visibility, badges, sections, features, camera_image and target arrays", () => {
    const { entities, mediaSources } = extract({
      views: [
        {
          type: "sections",
          badges: ["sensor.temp", { type: "entity", entity: "binary_sensor.door", visibility: [{ condition: "state", entity: "input_boolean.guest_mode", state: "on" }] }],
          sections: [
            {
              cards: [
                { type: "picture-entity", entity: "camera.front", camera_image: "camera.front_hd", image: "media-source://media_source/local/photo.jpg" },
                { type: "button", tap_action: { action: "call-service", service: "scene.turn_on", target: { entity_id: ["scene.movie", "scene.dinner"] } } },
                { type: "history-graph", entities: [{ entity: "sensor.power" }] },
              ],
            },
          ],
        },
      ],
    });
    expect([...entities].sort()).toEqual([
      "binary_sensor.door",
      "camera.front",
      "camera.front_hd",
      "input_boolean.guest_mode",
      "scene.dinner",
      "scene.movie",
      "sensor.power",
      "sensor.temp",
    ]);
    expect([...mediaSources]).toEqual(["media-source://media_source/local/photo.jpg"]);
  });

  test("ignores strings that are not entity ids", () => {
    const { entities } = extract({ views: [{ cards: [{ type: "entities", entities: ["not an entity", "Light.Kitchen", "light.kitchen"] }] }] });
    expect([...entities]).toEqual(["light.kitchen"]);
  });
});

describe("validate", () => {
  test("accepts a clean dashboard", () => {
    expect(validate(GUEST_DASHBOARD)).toEqual([]);
  });

  test("rejects custom cards", () => {
    const v = validate(AUTO_ENTITIES_DASHBOARD);
    expect(v.map((x) => x.rule)).toEqual(["custom-card"]);
    expect(v[0]!.path).toBe("$.views[0].cards[0]");
  });

  test("rejects strategy dashboards and views", () => {
    expect(validate(STRATEGY_DASHBOARD).map((x) => x.rule)).toEqual(["strategy"]);
    expect(validate({ views: [{ strategy: { type: "area" } }] }).map((x) => x.rule)).toEqual(["strategy"]);
  });

  test("rejects dynamic, energy and iframe cards", () => {
    const rules = validate({
      views: [
        {
          cards: [
            { type: "area", area: "kitchen" },
            { type: "energy-usage-graph" },
            { type: "iframe", url: "https://example.com" },
            { type: "map", entities: ["person.owner"], geo_location_sources: ["all"] },
            { type: "logbook", hours_to_show: 24 },
          ],
        },
      ],
    }).map((x) => x.rule);
    expect(rules).toEqual(["dynamic-card", "energy-card", "dynamic-card", "dynamic-card", "missing-entities"]);
  });

  test("rejects actions without entity targets or with area/device targets", () => {
    const rules = validate({
      views: [
        {
          cards: [
            { type: "button", tap_action: { action: "perform-action", perform_action: "script.party", target: { area_id: "living" } } },
            { type: "button", tap_action: { action: "perform-action", perform_action: "script.party" } },
            { type: "button", tap_action: { action: "navigate", navigation_path: "/lovelace/1" } },
            { type: "button", hold_action: { action: "call-service", service: "light.turn_on", service_data: { entity_id: "all" } } },
          ],
        },
      ],
    }).map((x) => x.rule);
    // navigate actions are questions for the admin, not violations (see interactions.test.ts)
    expect(rules).toEqual(["non-entity-target", "no-entity-target", "no-entity-target", "non-entity-target", "no-entity-target"]);
  });

  test("rejects templates outside markdown content", () => {
    const v = validate({ views: [{ cards: [{ type: "markdown", title: "{{ states.sensor | list }}", content: "ok {{ 1 }}" }] }] });
    expect(v.map((x) => x.rule)).toEqual(["template"]);
  });
});

describe("sanitize", () => {
  test("only a strategy on the dashboard blocks it", () => {
    expect(sanitize(STRATEGY_DASHBOARD).blockers.map((x) => x.rule)).toEqual(["strategy"]);
    expect(sanitize(AUTO_ENTITIES_DASHBOARD).blockers).toEqual([]);
  });

  test("hides the smallest list entry around a problem", () => {
    const { config, issues } = sanitize({
      views: [
        { strategy: { type: "area" } },
        {
          badges: [{ type: "custom:mushroom-badge", entity: "sensor.a" }, "sensor.b"],
          cards: [
            { type: "entities", entities: ["light.a", { type: "custom:slider-row", entity: "light.secret" }] },
            { type: "tile", entity: "light.b", features: [{ type: "custom:feature" }, { type: "light-brightness" }] },
            { type: "conditional", conditions: [], card: { type: "iframe", url: "https://example.com" } },
            { type: "tile", entity: "light.c", name: "{{ states('lock.y') }}" },
          ],
        },
      ],
    });
    expect(issues.map((i) => [i.rule, i.hidden, i.effect])).toEqual([
      ["strategy", "$.views[0]", "hidden"],
      ["custom-card", "$.views[1].badges[0]", "hidden"],
      ["custom-card", "$.views[1].cards[0].entities[1]", "hidden"],
      ["custom-card", "$.views[1].cards[1].features[0]", "hidden"],
      ["dynamic-card", "$.views[1].cards[2]", "hidden"],
      ["template", "$.views[1].cards[3]", "hidden"],
    ]);
    expect(config).toEqual({
      views: [
        {
          badges: ["sensor.b"],
          cards: [
            { type: "entities", entities: ["light.a"] },
            { type: "tile", entity: "light.b", features: [{ type: "light-brightness" }] },
          ],
        },
      ],
    });
  });

  test("a bad action only stops doing anything", () => {
    const { config, issues } = sanitize({
      views: [{ cards: [{ type: "button", entity: "light.a", tap_action: { action: "perform-action", perform_action: "script.x", target: { area_id: "a" } } }] }],
    });
    expect(issues.map((i) => [i.hidden, i.effect])).toEqual([
      ["$.views[0].cards[0].tap_action", "disabled"],
      ["$.views[0].cards[0].tap_action", "disabled"],
    ]);
    expect(config).toEqual({ views: [{ cards: [{ type: "button", entity: "light.a", tap_action: { action: "none" } }] }] });
  });

  test("keepPositions leaves null in place of hidden entries", () => {
    const { config } = sanitize(AUTO_ENTITIES_DASHBOARD, { keepPositions: true });
    expect(config).toEqual({ views: [{ cards: [null] }] });
  });
});

describe("Dashboard.applyConfig", () => {
  test("derives domains and status", () => {
    const d = new Dashboard("guest-dash");
    d.applyConfig(GUEST_DASHBOARD);
    expect(d.status).toBe("ok");
    expect([...d.allowedDomains].sort()).toEqual(["camera", "light", "lock"]);
  });

  test("parts that cannot be checked are hidden and not allowed", () => {
    const d = new Dashboard("bad");
    d.applyConfig({
      views: [{ cards: [{ type: "tile", entity: "light.ok" }, { type: "custom:mushroom-light-card", entity: "light.secret" }] }],
    });
    expect(d.status).toBe("ok");
    expect(d.usable).toBe(true);
    expect(d.issues.map((i) => i.hidden)).toEqual(["$.views[0].cards[1]"]);
    expect([...d.entities]).toEqual(["light.ok"]);
    expect(d.guestConfig({ views: [{ cards: [{ type: "custom:x", entity: "light.secret" }, { type: "tile", entity: "light.ok" }] }] })).toEqual({
      views: [{ cards: [{ type: "tile", entity: "light.ok" }] }],
    });
  });

  test("strategy dashboards are rejected", () => {
    const d = new Dashboard("bad");
    d.applyConfig(STRATEGY_DASHBOARD);
    expect(d.status).toBe("rejected");
    expect(d.violations.map((v) => v.rule)).toEqual(["strategy"]);
    expect(d.entities.size).toBe(0);
    expect(d.guestConfig(STRATEGY_DASHBOARD)).toEqual({ views: [] });
  });
});
