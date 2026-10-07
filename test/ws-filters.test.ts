import { describe, expect, test } from "bun:test";
import * as F from "../src/proxy/ws-filters";
import { DEVICES, REGISTRY, STATES } from "./mock-ha";

const A = new Set(["light.kitchen", "lock.front"]);

describe("ws-filters", () => {
  test("filterStates", () => {
    const out = F.filterStates(STATES, A) as Array<{ entity_id: string }>;
    expect(out.map((s) => s.entity_id).sort()).toEqual(["light.kitchen", "lock.front"]);
  });

  test("filterSubscribeEntitiesEvent", () => {
    const out = F.filterSubscribeEntitiesEvent(
      { a: { "light.kitchen": {}, "person.owner": {} }, c: { "lock.front": {}, "light.bedroom": {} }, r: ["light.bedroom", "lock.front"] },
      A,
    );
    expect(out).toEqual({ a: { "light.kitchen": {} }, c: { "lock.front": {} }, r: ["lock.front"] });
  });

  test("filterEntityRegistryDisplay uses the real `entities` key", () => {
    const out = F.filterEntityRegistryDisplay({ entity_categories: { 0: "config" }, entities: REGISTRY }, A) as { entities: unknown[] };
    expect(out.entities).toEqual([{ ei: "light.kitchen", di: "dev-kitchen" }, { ei: "lock.front", di: "dev-lock" }]);
  });

  test("filterEntityRegistry keeps only allowed entries", () => {
    const entries = [
      { entity_id: "light.kitchen", options: { light: { favorite_colors: [{ hs_color: [30, 80] }] } } },
      { entity_id: "light.bedroom", options: {} },
    ];
    expect(F.filterEntityRegistry(entries, A)).toEqual([entries[0]]);
    expect(F.filterEntityRegistry({ not: "a list" }, A)).toEqual([]);
  });

  test("filterDeviceRegistry drops foreign devices and sensitive fields", () => {
    const out = F.filterDeviceRegistry(DEVICES, new Set(["dev-lock"])) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("dev-lock");
    expect(out[0]!.connections).toEqual([]);
    expect(out[0]!.configuration_url).toBeNull();
  });

  test("filterLogbookEntries strips context of foreign entities", () => {
    const out = F.filterLogbookEntries(
      [
        { entity_id: "light.kitchen", context_entity_id: "person.owner", context_user_id: "u", context_id: "c" },
        { entity_id: "lock.front", context_entity_id: "light.kitchen", context_user_id: "u" },
        { entity_id: "person.owner" },
      ],
      A,
    );
    expect(out).toEqual([{ entity_id: "light.kitchen" }, { entity_id: "lock.front", context_entity_id: "light.kitchen", context_user_id: "u" }]);
  });

  test("scrubConfig hides location and assist", () => {
    const out = F.scrubConfig({ latitude: 48, longitude: 16, location_name: "Secret", components: ["conversation", "light"], external_url: "x" }) as Record<string, unknown>;
    expect(out.latitude).toBe(0);
    expect(out.location_name).toBe("Home");
    expect(out.external_url).toBeNull();
    expect(out.components).toEqual(["light"]);
  });

  test("filterPanels and filterServices", () => {
    expect(F.filterPanels({ lovelace: 1, "guest-dash": 2, secret: 3 }, "guest-dash")).toEqual({ "guest-dash": 2 });
    const services = { light: { turn_on: {}, reload: {} }, sensor: { reload: {} }, notify: { send: {} }, homeassistant: { turn_on: {}, restart: {} } };
    expect(F.filterServices(services, new Set(["light", "sensor"]), (_domain, service) => service === "turn_on")).toEqual({
      light: { turn_on: {} },
      sensor: {},
      homeassistant: { turn_on: {} },
    });
  });
});
