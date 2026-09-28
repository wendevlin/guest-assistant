import { describe, expect, test } from "bun:test";
import { Dashboard } from "../src/dashboard";
import { COMMANDS, DROP, evaluate, type CommandContext, type Verdict } from "../src/proxy/ws-commands";
import { GUEST_DASHBOARD } from "./mock-ha";

const dashboard = new Dashboard("guest-dash");
dashboard.applyConfig(GUEST_DASHBOARD);

function ctx(subscriptions = new Map()): CommandContext {
  return { dashboard, subscriptions };
}

function run(msg: Record<string, unknown>): Verdict {
  return evaluate({ id: 1, ...msg }, ctx());
}

function expectReject(msg: Record<string, unknown>) {
  const v = run(msg);
  expect(v.kind).toBe("reject");
}

function expectForward(msg: Record<string, unknown>) {
  const v = run(msg);
  expect(v.kind).toBe("forward");
  return (v as { msg: Record<string, unknown> }).msg;
}

describe("evaluate: default deny", () => {
  test("unknown command types are rejected", () => {
    expectReject({ type: "execute_script", sequence: [] });
    expectReject({ type: "subscribe_trigger", trigger: {} });
    expectReject({ type: "search/related", item_type: "entity", item_id: "light.bedroom" });
    expectReject({ type: "config/entity_registry/list" });
    expectReject({ type: "tag/list" });
    expectReject({ type: "media_source/browse_media" });
  });

  test("unknown fields are rejected even on allowed commands", () => {
    expectReject({ type: "get_states", entity_ids: ["light.bedroom"] });
    expectReject({ type: "subscribe_entities", include: { domains: ["light"] } });
  });
});

describe("call_service", () => {
  test("allows entity-targeted services on dashboard entities", () => {
    const msg = expectForward({ type: "call_service", domain: "light", service: "turn_off", target: { entity_id: "light.kitchen" } });
    expect(msg).toEqual({ id: 1, type: "call_service", domain: "light", service: "turn_off", target: { entity_id: ["light.kitchen"] } });
  });

  test("accepts entity_id in service_data (as the HA frontend sends toggles) and moves it to target", () => {
    const msg = expectForward({ type: "call_service", domain: "light", service: "toggle", service_data: { entity_id: "light.kitchen" } });
    expect(msg).toEqual({ id: 1, type: "call_service", domain: "light", service: "toggle", target: { entity_id: ["light.kitchen"] } });
    const withData = expectForward({ type: "call_service", domain: "light", service: "turn_on", service_data: { entity_id: ["light.kitchen"], brightness: 10 } });
    expect(withData).toEqual({ id: 1, type: "call_service", domain: "light", service: "turn_on", target: { entity_id: ["light.kitchen"] }, service_data: { brightness: 10 } });
  });

  test("allows lock.unlock when the lock is on the dashboard", () => {
    expectForward({ type: "call_service", domain: "lock", service: "unlock", target: { entity_id: ["lock.front"] } });
  });

  test("rejects every known bypass", () => {
    // entity not on dashboard
    expectReject({ type: "call_service", domain: "light", service: "turn_off", target: { entity_id: "light.bedroom" } });
    // mixed allowed + forbidden
    expectReject({ type: "call_service", domain: "light", service: "turn_off", target: { entity_id: ["light.kitchen", "light.bedroom"] } });
    // legacy entity_id in service_data
    expectReject({ type: "call_service", domain: "light", service: "turn_off", service_data: { entity_id: "light.bedroom" } });
    expectReject({ type: "call_service", domain: "light", service: "turn_off", service_data: { entity_id: "all" } });
    expectReject({ type: "call_service", domain: "light", service: "turn_off", service_data: { entity_id: ["light.kitchen", "light.bedroom"] } });
    // entity_id in both places, even if both are allowed
    expectReject({ type: "call_service", domain: "light", service: "turn_off", target: { entity_id: "light.kitchen" }, service_data: { entity_id: "all" } });
    expectReject({ type: "call_service", domain: "light", service: "turn_off", target: { entity_id: "light.kitchen" }, service_data: { entity_id: "light.kitchen" } });
    // other selectors next to a legacy entity_id
    expectReject({ type: "call_service", domain: "light", service: "turn_off", service_data: { entity_id: "light.kitchen", area_id: "bedroom" } });
    // area / device / label targets
    expectReject({ type: "call_service", domain: "light", service: "turn_off", target: { area_id: "kitchen" } });
    expectReject({ type: "call_service", domain: "light", service: "turn_off", target: { entity_id: "light.kitchen", device_id: "x" } });
    // "all"
    expectReject({ type: "call_service", domain: "light", service: "turn_off", target: { entity_id: "all" } });
    // no target at all
    expectReject({ type: "call_service", domain: "homeassistant", service: "restart" });
    expectReject({ type: "call_service", domain: "notify", service: "mobile_app", service_data: { message: "hi" } });
    expectReject({ type: "call_service", domain: "shell_command", service: "wipe" });
    // script by name
    expectReject({ type: "call_service", domain: "script", service: "party_mode" });
    // domain mismatch
    expectReject({ type: "call_service", domain: "lock", service: "unlock", target: { entity_id: "light.kitchen" } });
    // service not in allowlist for domain
    expectReject({ type: "call_service", domain: "camera", service: "snapshot", target: { entity_id: "camera.garden" } });
    // templates in data
    expectReject({ type: "call_service", domain: "light", service: "turn_on", target: { entity_id: "light.kitchen" }, service_data: { brightness: "{{ states('lock.front') }}" } });
    // return_response
    expectReject({ type: "call_service", domain: "light", service: "turn_on", target: { entity_id: "light.kitchen" }, return_response: true });
  });

  test("service_data fields that reference other entities or media are checked", () => {
    const d = new Dashboard("media");
    d.applyConfig({
      views: [
        {
          cards: [
            { type: "media-control", entity: "media_player.living" },
            { type: "media-control", entity: "media_player.kitchen" },
            { type: "tile", entity: "script.party" },
            { type: "tile", entity: "automation.lights" },
            {
              type: "button",
              tap_action: {
                action: "perform-action",
                perform_action: "media_player.play_media",
                target: { entity_id: "media_player.living" },
                data: { media_content_id: "media-source://media_source/local/song.mp3", media_content_type: "music" },
              },
            },
          ],
        },
      ],
    });
    const call = (service: string, entity: string, service_data: Record<string, unknown>) =>
      evaluate(
        { id: 1, type: "call_service", domain: entity.split(".")[0], service, target: { entity_id: entity }, service_data },
        { dashboard: d, subscriptions: new Map() },
      ).kind;

    expect(call("join", "media_player.living", { group_members: ["media_player.kitchen"] })).toBe("forward");
    expect(call("join", "media_player.living", { group_members: ["media_player.bedroom"] })).toBe("reject");
    expect(call("join", "media_player.living", { group_members: ["media_player.kitchen", "media_player.bedroom"] })).toBe("reject");
    expect(call("join", "media_player.living", { group_members: "all" })).toBe("reject");
    expect(call("join", "media_player.living", {})).toBe("reject");
    expect(call("join", "media_player.living", { group_members: ["script.party"] })).toBe("reject");

    const song = "media-source://media_source/local/song.mp3";
    expect(call("play_media", "media_player.living", { media_content_id: song, media_content_type: "music" })).toBe("forward");
    expect(call("play_media", "media_player.living", { media_content_id: "https://example.com/a.mp3", media_content_type: "music" })).toBe("forward");
    expect(call("play_media", "media_player.living", { media_content_id: "media-source://camera/camera.bedroom", media_content_type: "video" })).toBe("reject");
    expect(call("play_media", "media_player.living", { media: { media_content_id: "media-source://camera/camera.bedroom" } })).toBe("reject");

    expect(call("turn_on", "script.party", {})).toBe("forward");
    expect(call("turn_on", "script.party", { variables: { target: "lock.front" } })).toBe("reject");
    expect(call("trigger", "automation.lights", { variables: { target: "lock.front" } })).toBe("reject");
    expect(call("turn_on", "homeassistant", {})).toBe("reject");
    expect(
      evaluate(
        { id: 1, type: "call_service", domain: "homeassistant", service: "turn_on", target: { entity_id: "script.party" }, service_data: { variables: { x: 1 } } },
        { dashboard: d, subscriptions: new Map() },
      ).kind,
    ).toBe("reject");
  });

  test("homeassistant.turn_off works across domains for allowed entities only", () => {
    expectForward({ type: "call_service", domain: "homeassistant", service: "turn_off", target: { entity_id: ["light.kitchen", "camera.garden"] } });
    expectReject({ type: "call_service", domain: "homeassistant", service: "turn_off", target: { entity_id: ["light.kitchen", "light.bedroom"] } });
  });
});

describe("lovelace", () => {
  test("lovelace/info is forwarded without parameters", () => {
    expect(expectForward({ type: "lovelace/info" })).toEqual({ id: 1, type: "lovelace/info" });
    expectReject({ type: "lovelace/info", url_path: "other" });
  });

  test("HA's lovelace_updated is held back; the proxy sends its own after re-analysing", () => {
    const sub = { type: "subscribe_events", msg: { type: "subscribe_events", event_type: "lovelace_updated" } };
    const c = ctx(new Map([[5, sub]]));
    const spec = COMMANDS.subscribe_events!;
    expect(spec.filterEvent!({ event_type: "lovelace_updated", data: { url_path: "guest-dash" } }, c, sub.msg)).toBe(DROP);
  });
});

describe("frontend user data", () => {
  const withTheme = (theme: CommandContext["theme"], msg: Record<string, unknown>) =>
    evaluate({ id: 1, ...msg }, { dashboard, theme, subscriptions: new Map() });

  test("the proxy user's preferences are never read from HA", () => {
    expect(run({ type: "frontend/subscribe_user_data", key: "language" })).toEqual({ kind: "reply", result: null, events: [{ value: null }] });
    expect(run({ type: "frontend/get_user_data", key: "language" })).toEqual({ kind: "reply", result: { value: null } });
    expect(run({ type: "frontend/get_user_data", key: "core" })).toEqual({ kind: "reply", result: { value: null } });
    expectReject({ type: "frontend/subscribe_user_data", key: "dashboards" });
  });

  test("theme comes from config.yaml", () => {
    expect(withTheme({ mode: "auto", guest_can_change_mode: false }, { type: "frontend/subscribe_user_data", key: "theme" })).toEqual({
      kind: "reply",
      result: null,
      events: [{ value: { theme: "" } }],
    });
    expect(withTheme({ name: "nord", mode: "dark", guest_can_change_mode: true }, { type: "frontend/get_user_data", key: "theme" })).toEqual({
      kind: "reply",
      result: { value: { theme: "nord", dark: true } },
    });
    expect(withTheme({ mode: "light", guest_can_change_mode: false }, { type: "frontend/get_user_data", key: "theme" })).toEqual({
      kind: "reply",
      result: { value: { theme: "", dark: false } },
    });
  });

  test("saving language/theme is acknowledged locally, other keys are rejected", () => {
    expect(run({ type: "frontend/set_user_data", key: "language", value: { language: "de" } })).toEqual({ kind: "reply", result: null });
    expect(run({ type: "frontend/set_user_data", key: "theme", value: { theme: "x", dark: true } })).toEqual({ kind: "reply", result: null });
    expectReject({ type: "frontend/set_user_data", key: "core", value: { showAdvanced: true } });
    expectReject({ type: "frontend/set_user_data", key: "dashboards", value: {} });
  });
});

describe("render_template", () => {
  test("only dashboard templates, with proxy-controlled variables", () => {
    const msg = expectForward({
      type: "render_template",
      template: "Kitchen is {{ states('light.kitchen') }}",
      variables: { config: { entity: "lock.front" }, user: "Owner" },
    });
    expect(msg.variables).toEqual({ config: { type: "markdown", content: "Kitchen is {{ states('light.kitchen') }}" }, user: "Guest" });
    expect(msg.timeout).toBe(3);
  });

  test("rejects foreign templates", () => {
    expectReject({ type: "render_template", template: "{{ states | map(attribute='entity_id') | list }}" });
    expectReject({ type: "render_template", template: "Kitchen is {{ states('light.kitchen') }}", entity_ids: ["light.bedroom"] });
  });
});

describe("entity-scoped reads", () => {
  test("history/logbook/recorder require allowed entity_ids", () => {
    expectForward({ type: "history/history_during_period", entity_ids: ["light.kitchen"], start_time: "x" });
    expectReject({ type: "history/history_during_period", entity_ids: ["light.kitchen", "person.owner"], start_time: "x" });
    expectReject({ type: "history/stream", entity_ids: [], start_time: "x" });
    expectReject({ type: "logbook/get_events", start_time: "x" });
    expectReject({ type: "logbook/get_events", start_time: "x", entity_ids: ["light.kitchen"], device_ids: ["d"] });
    expectReject({ type: "recorder/statistics_during_period", statistic_ids: ["sensor.energy"], start_time: "x", period: "hour" });
  });

  test("camera commands require an allowed camera", () => {
    expectForward({ type: "camera/stream", entity_id: "camera.garden" });
    expectReject({ type: "camera/stream", entity_id: "camera.bedroom" });
    expectReject({ type: "camera/stream", entity_id: "light.kitchen" });
    expectReject({ type: "camera/stream", entity_id: "camera.garden", format: "mjpeg" });
  });

  test("sign_path only for allowed entity proxies", () => {
    const msg = expectForward({ type: "auth/sign_path", path: "/api/camera_proxy/camera.garden", expires: 9999 });
    expect(msg.expires).toBe(300);
    expectReject({ type: "auth/sign_path", path: "/api/camera_proxy/camera.bedroom" });
    expectReject({ type: "auth/sign_path", path: "/api/states" });
    expectReject({ type: "auth/sign_path", path: "/api/camera_proxy/camera.garden/../../states" });
  });

  test("subscribe_events allows dashboard events only", () => {
    expectForward({ type: "subscribe_events", event_type: "state_changed" });
    expectReject({ type: "subscribe_events" });
    expectReject({ type: "subscribe_events", event_type: "call_service" });
    expectReject({ type: "subscribe_events", event_type: "automation_triggered" });
  });

  test("subscribe_entities injects the allowlist", () => {
    const msg = expectForward({ type: "subscribe_entities" });
    expect((msg.entity_ids as string[]).sort()).toEqual(["camera.garden", "light.kitchen", "lock.front"]);
  });

  test("subscribe_entities on an empty dashboard is answered locally", () => {
    const empty = new Dashboard("empty");
    empty.applyConfig({ views: [] });
    const v = evaluate({ id: 1, type: "subscribe_entities" }, { dashboard: empty, subscriptions: new Map() });
    expect(v).toEqual({ kind: "reply", result: null, events: [{ a: {} }] });
  });

  test("unsubscribe_events only for own subscriptions", () => {
    const subs = new Map([[5, { type: "subscribe_events", msg: {} }]]);
    expect(evaluate({ id: 1, type: "unsubscribe_events", subscription: 5 }, ctx(subs)).kind).toBe("forward");
    expect(evaluate({ id: 1, type: "unsubscribe_events", subscription: 6 }, ctx(subs)).kind).toBe("reject");
  });

  test("lovelace/config is pinned to the assigned dashboard", () => {
    const msg = expectForward({ type: "lovelace/config", url_path: "secret-dash" });
    expect(msg.url_path).toBe("guest-dash");
  });
});
