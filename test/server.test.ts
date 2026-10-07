import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DISABLED_AUTH_PATHS } from "../src/auth";
import { GuestWs, rawGet, startTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;
let cookie: string;
let token: string;

beforeAll(async () => {
  env = await startTestEnv();
  cookie = await env.login("guest", "guest-pass-123");
  const t = await env.hassToken(cookie);
  token = t.body.access_token as string;
});

afterAll(() => env.stop());

describe("auth surface", () => {
  test("login, session and hass-token work", async () => {
    const session = await fetch(`${env.url}/api/auth/get-session`, { headers: { cookie } });
    expect(session.status).toBe(200);
    const body = (await session.json()) as { user: { dashboard?: string } };
    expect(body.user.dashboard).toBe("guest-dash");

    const t = await env.hassToken(cookie);
    expect(t.status).toBe(200);
    expect(t.body.dashboard_url_path).toBe("guest-dash");
    expect(t.body).not.toHaveProperty("theme_mode_selectable");
    expect(typeof t.body.access_token).toBe("string");
  });

  test("hass-token requires a session", async () => {
    expect((await fetch(`${env.url}/api/auth/hass-token`)).status).toBe(401);
  });

  test("sign-out and deletion take effect immediately, also for tokens still held", async () => {
    const guest = await env.runtime.createGuest({ username: "leaving", password: "leaving-pass-1", dashboard: "guest-dash" });
    // Signed in through the API, not the handler: better-auth's sign-in rate
    // limit is shared by every test in this process.
    const signIn = await env.runtime.auth.api.signInUsername({ body: { username: "leaving", password: "leaving-pass-1" }, asResponse: true });
    const c = signIn.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const t = (await env.hassToken(c)).body.access_token as string;
    const bearer = { authorization: `Bearer ${t}` };
    expect((await fetch(`${env.url}/api/states/light.kitchen`, { headers: { cookie: c } })).status).toBe(200);
    expect((await fetch(`${env.url}/api/states/light.kitchen`, { headers: bearer })).status).toBe(200);

    // The session cookie stops working with the sign-out, not a minute later.
    const out = await fetch(`${env.url}/api/auth/sign-out`, { method: "POST", headers: { cookie: c, origin: env.url } });
    expect(out.status).toBe(200);
    expect((await fetch(`${env.url}/api/states/light.kitchen`, { headers: { cookie: c } })).status).toBe(401);
    // The JWT is independent of the session ...
    expect((await fetch(`${env.url}/api/states/light.kitchen`, { headers: bearer })).status).toBe(200);

    // ... until the guest is changed or deleted.
    await env.runtime.deleteGuest(guest.id);
    expect((await fetch(`${env.url}/api/states/light.kitchen`, { headers: bearer })).status).toBe(401);
    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(t)).type).toBe("auth_invalid");
    await ws.closed;
  });

  test("cards that cannot be checked are hidden; only a rejected dashboard denies a token", async () => {
    const badCookie = await env.login("badguest", "bad-pass-123");
    const t = await env.hassToken(badCookie);
    expect(t.status).toBe(200);
    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(t.body.access_token as string)).type).toBe("auth_ok");
    const config = await ws.send({ type: "lovelace/config", url_path: "bad-dash" });
    expect(config.result).toEqual({ views: [{ cards: [] }] });
    const states = await ws.send({ type: "get_states" });
    expect(states.result).toEqual([]);
    ws.close();

    // A strategy cannot be hidden piecewise: guests get the reason instead of a token.
    const { AUTO_ENTITIES_DASHBOARD, STRATEGY_DASHBOARD } = await import("./mock-ha");
    const dashboard = env.dashboards.get("bad-dash")!;
    env.ha.dashboards.set("bad-dash", STRATEGY_DASHBOARD);
    await dashboard.load(env.runtime.client!);
    const denied = await env.hassToken(badCookie);
    expect(denied.status).toBe(403);
    expect(denied.body.reason).toEqual([expect.stringContaining("strategy")]);
    env.ha.dashboards.set("bad-dash", AUTO_ENTITIES_DASHBOARD);
    await dashboard.load(env.runtime.client!);
  });

  test("dashboard cannot be changed through update-user", async () => {
    const res = await fetch(`${env.url}/api/auth/update-user`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: env.url },
      body: JSON.stringify({ dashboard: "lovelace" }),
    });
    expect(res.status).toBe(404);
    const t = await env.hassToken(cookie);
    expect(t.body.dashboard_url_path).toBe("guest-dash");
  });

  test("all non-essential better-auth endpoints are disabled", async () => {
    for (const path of DISABLED_AUTH_PATHS) {
      for (const method of ["GET", "POST"]) {
        const res = await fetch(`${env.url}/api/auth${path}`, {
          method,
          headers: { "content-type": "application/json", cookie, origin: env.url },
          body: method === "POST" ? "{}" : undefined,
        });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
  });

  test("wrong password is rejected", async () => {
    const res = await fetch(`${env.url}/api/auth/sign-in/username`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.url },
      body: JSON.stringify({ username: "guest", password: "nope" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("HTTP proxy", () => {
  test("unauthenticated requests never reach HA", async () => {
    const before = env.ha.restServiceCalls.length;
    expect((await fetch(`${env.url}/api/states`)).status).toBe(401);
    expect((await fetch(`${env.url}/api/camera_proxy/camera.garden`)).status).toBe(401);
    expect((await fetch(`${env.url}/api/history/period?filter_entity_id=person.owner`)).status).toBe(401);
    const svc = await fetch(`${env.url}/api/services/lock/unlock`, { method: "POST", body: '{"entity_id":"all"}' });
    expect(svc.status).toBe(404);
    expect(env.ha.restServiceCalls.length).toBe(before);
  });

  test("authenticated requests cannot call services or read arbitrary API paths", async () => {
    const headers = { cookie };
    expect((await fetch(`${env.url}/api/services/lock/unlock`, { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await fetch(`${env.url}/api/template`, { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await fetch(`${env.url}/api/config`, { headers })).status).toBe(404);
    expect((await fetch(`${env.url}/api/error_log`, { headers })).status).toBe(404);
    expect([404, 405]).toContain((await fetch(`${env.url}/api/states/light.kitchen`, { method: "POST", headers, body: "{}" })).status);
    expect(env.ha.restServiceCalls).toHaveLength(0);
  });

  test("/api/states is filtered to the dashboard", async () => {
    const res = await fetch(`${env.url}/api/states`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ entity_id: string }>).map((s) => s.entity_id).sort();
    expect(ids).toEqual(["camera.garden", "light.kitchen", "lock.front"]);
  });

  test("entity routes enforce membership (cookie and bearer)", async () => {
    expect((await fetch(`${env.url}/api/states/light.kitchen`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${env.url}/api/states/light.bedroom`, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${env.url}/api/camera_proxy/camera.garden`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await fetch(`${env.url}/api/camera_proxy/camera.bedroom`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await fetch(`${env.url}/api/camera_proxy/camera.garden`, { headers: { authorization: "Bearer garbage" } })).status).toBe(401);
  });

  test("history requires allowed filter_entity_id and filters the response", async () => {
    expect((await fetch(`${env.url}/api/history/period?filter_entity_id=person.owner`, { headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${env.url}/api/history/period`, { headers: { cookie } })).status).toBe(403);
    const ok = await fetch(`${env.url}/api/history/period/2026-01-01T00:00:00Z?filter_entity_id=light.kitchen,lock.front`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    const series = (await ok.json()) as Array<Array<{ entity_id: string }>>;
    expect(series.map((s) => s[0]!.entity_id).sort()).toEqual(["light.kitchen", "lock.front"]);
  });

  test("logbook requires an allowed entity and strips foreign context", async () => {
    expect((await fetch(`${env.url}/api/logbook`, { headers: { cookie } })).status).toBe(403);
    const ok = await fetch(`${env.url}/api/logbook/2026-01-01T00:00:00Z?entity=light.kitchen`, { headers: { cookie } });
    const entries = (await ok.json()) as Array<Record<string, unknown>>;
    expect(entries.map((e) => e.entity_id).sort()).toEqual(["camera.garden", "light.kitchen", "lock.front"]);
    expect(entries.every((e) => !("context_user_id" in e))).toBe(true);
  });

  test("status endpoint reports the proxy's connection to HA", async () => {
    const res = await fetch(`${env.url}/api/guest-assistant/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ home_assistant: "connected" });
  });

  test("paths that leave their route are refused, with or without a session", async () => {
    // Each of these matches a route on the raw path but normalises to a
    // different HA endpoint. None may be forwarded.
    const escapes = [
      "/local/../api/states",
      "/static/../api/states",
      "/hacsfiles/../api/states",
      "/local/%2e%2e/api/states",
      "/local/%2E%2E/api/camera_proxy/camera.bedroom",
      "/local/..%2fapi%2fstates",
      "/static/x/../../api/history/period?filter_entity_id=person.owner",
      "/api/hls/../states",
      "/api/brands/../camera_proxy/camera.bedroom",
      "/api/history/period/../../states?filter_entity_id=light.kitchen",
      "/api/logbook/../states?entity=light.kitchen",
      "/api/camera_proxy/camera.garden/../camera.bedroom",
    ];
    for (const target of escapes) {
      const variants: Record<string, string>[] = [{}, { cookie }, { authorization: `Bearer ${token}` }];
      for (const headers of variants) {
        const res = await rawGet(env.url, target, headers);
        expect({ target, status: res.status }).toEqual({ target, status: 404 });
        expect(res.body).not.toContain("entity_id");
        expect(res.body).not.toContain("IMG");
      }
    }
  });

  test("the proxy's HA token is never sent on public paths", async () => {
    const before = env.ha.publicRequests.length;
    for (const path of ["/local/plan.png", "/hacsfiles/card.js", "/static/does-not-exist.js"]) {
      expect((await fetch(`${env.url}${path}`, { headers: { cookie } })).status).toBe(200);
    }
    const seen = env.ha.publicRequests.slice(before);
    expect(seen.map((r) => r.path)).toEqual(["/local/plan.png", "/hacsfiles/card.js", "/static/does-not-exist.js"]);
    expect(seen.every((r) => r.authorization === null)).toBe(true);
  });

  test("the admin page only answers paths under /admin/", async () => {
    // Normalises to /abcdefapi/state, which a naive slice would read as api/state.
    expect((await rawGet(env.url, "/admin/../abcdefapi/state")).status).toBe(404);
  });

  test("public assets pass through without auth, frontend is served", async () => {
    expect(await (await fetch(`${env.url}/static/icons/x.png`)).text()).toBe("static-asset");
    const index = await fetch(`${env.url}/some/spa/route`, { headers: { accept: "text/html" } });
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("guest-frontend");
    expect((await fetch(`${env.url}/../../etc/passwd`, { headers: { accept: "text/plain" } })).status).toBe(404);
    expect((await fetch(`${env.url}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
  });
});

describe("WebSocket proxy", () => {
  async function connect(): Promise<GuestWs> {
    const ws = new GuestWs(env.wsUrl);
    const res = await ws.auth(token);
    expect(res.type).toBe("auth_ok");
    return ws;
  }

  test("a reused message id never lets an answer skip its filter", async () => {
    const ws = await connect();
    // Each command is followed at once by a ping with the same id. Before ids
    // had to increase, the ping replaced the command in the pending map and
    // HA's unfiltered answer went straight to the guest.
    const commands: Record<number, Record<string, unknown>> = {
      110: { type: "get_states" },
      120: { type: "history/history_during_period", entity_ids: ["light.kitchen"], start_time: "2026-01-01T00:00:00Z" },
      130: { type: "get_panels" },
    };
    for (const [id, cmd] of Object.entries(commands)) {
      ws.sendRaw({ id: Number(id), ...cmd });
      ws.sendRaw({ id: Number(id), type: "ping" });
    }
    await Bun.sleep(300);
    const answers = ws.received.filter((m) => typeof m.id === "number" && m.id >= 110);
    const ok = new Map(answers.filter((m) => m.success === true).map((m) => [m.id as number, m.result]));

    expect((ok.get(110) as Array<{ entity_id: string }>).map((s) => s.entity_id).sort()).toEqual(["camera.garden", "light.kitchen", "lock.front"]);
    expect(Object.keys(ok.get(120) as object)).toEqual(["light.kitchen"]);
    expect(Object.keys(ok.get(130) as object)).toEqual(["guest-dash"]);
    const refused = answers.filter((m) => (m.error as { code?: string } | undefined)?.code === "id_reuse").map((m) => m.id);
    expect(refused).toEqual([110, 120, 130]);
    expect(answers.some((m) => m.type === "pong")).toBe(false);
    ws.close();
  });

  test("message ids must be increasing integers", async () => {
    const ws = await connect();
    for (const id of [5, 3, 5, 6, 6.5, -1]) ws.sendRaw({ id, type: "ping" });
    await Bun.sleep(300);
    expect(ws.received.filter((m) => m.type === "pong").map((m) => m.id)).toEqual([5, 6]);
    const errors = ws.received.filter((m) => m.type === "result" && m.success === false);
    expect(errors.map((m) => [m.id, (m.error as { code: string }).code])).toEqual([
      [3, "id_reuse"],
      [5, "id_reuse"],
      [6.5, "unauthorized"],
      [-1, "unauthorized"],
    ]);
    ws.close();
  });

  test("a live subscription's id cannot be taken over", async () => {
    const ws = await connect();
    ws.sendRaw({ id: 50, type: "subscribe_entities" });
    await Bun.sleep(200);
    ws.sendRaw({ id: 50, type: "subscribe_events", event_type: "themes_updated" });
    ws.sendRaw({ id: 51, type: "unsubscribe_events", subscription: 50 });
    await Bun.sleep(200);
    const reuse = ws.received.find((m) => m.id === 50 && (m.error as { code?: string } | undefined)?.code === "id_reuse");
    expect(reuse).toBeDefined();
    expect(ws.received.find((m) => m.id === 51)?.success).toBe(true);
    ws.close();
  });

  test("rejects invalid tokens", async () => {
    const ws = new GuestWs(env.wsUrl);
    const res = await ws.auth("nonsense");
    expect(res.type).toBe("auth_invalid");
    await ws.closed;
  });

  test("the theme is unset for guests, the proxy user's own is never read", async () => {
    const ws = await connect();
    const res = await ws.send({ type: "frontend/subscribe_user_data", key: "theme" });
    expect(res.success).toBe(true);
    const [event] = await ws.events(res.id as number);
    expect(event!.event).toEqual({ value: null });
  });

  test("get_states, registries, config and panels are filtered", async () => {
    const ws = await connect();
    const states = await ws.send({ type: "get_states" });
    expect(((states.result as Array<{ entity_id: string }>).map((s) => s.entity_id)).sort()).toEqual(["camera.garden", "light.kitchen", "lock.front"]);

    const reg = await ws.send({ type: "config/entity_registry/list_for_display" });
    expect((reg.result as { entities: Array<{ ei: string }> }).entities.map((e) => e.ei).sort()).toEqual(["camera.garden", "light.kitchen", "lock.front"]);

    const devices = await ws.send({ type: "config/device_registry/list" });
    expect((devices.result as Array<{ id: string }>).map((d) => d.id).sort()).toEqual(["dev-cam", "dev-kitchen", "dev-lock"]);

    const config = await ws.send({ type: "get_config" });
    expect((config.result as { latitude: number; components: string[] }).latitude).toBe(0);
    expect((config.result as { components: string[] }).components).toEqual(["light"]);

    const panels = await ws.send({ type: "get_panels" });
    expect(Object.keys(panels.result as object)).toEqual(["guest-dash"]);

    const services = await ws.send({ type: "get_services" });
    expect(Object.keys(services.result as object).sort()).toEqual(["homeassistant", "light", "lock"]);

    const user = await ws.send({ type: "auth/current_user" });
    expect((user.result as { is_admin: boolean }).is_admin).toBe(false);
    ws.close();
  });

  test("subscribe_entities and state_changed events are filtered", async () => {
    const ws = await connect();
    const sub = await ws.send({ type: "subscribe_entities" });
    expect(sub.success).toBe(true);
    const [init] = await ws.events(sub.id as number);
    expect(Object.keys((init!.event as { a: object }).a).sort()).toEqual(["camera.garden", "light.kitchen", "lock.front"]);

    const ev = await ws.send({ type: "subscribe_events", event_type: "state_changed" });
    env.ha.emitEvent("state_changed", { entity_id: "light.bedroom", new_state: { state: "on" } });
    env.ha.emitEvent("state_changed", { entity_id: "light.kitchen", new_state: { state: "off" } });
    const events = await ws.events(ev.id as number, 1);
    expect(events).toHaveLength(1);
    expect((events[0]!.event as { data: { entity_id: string } }).data.entity_id).toBe("light.kitchen");
    ws.close();
  });

  test("call_service bypasses are blocked, legit calls reach HA", async () => {
    const ws = await connect();
    const before = env.ha.serviceCalls.length;
    const denied = await Promise.all([
      ws.send({ type: "call_service", domain: "light", service: "turn_off", service_data: { entity_id: "all" } }),
      ws.send({ type: "call_service", domain: "light", service: "turn_off", target: { area_id: "bedroom" } }),
      ws.send({ type: "call_service", domain: "lock", service: "unlock", target: { entity_id: "lock.front" }, service_data: { entity_id: "lock.back" } }),
      ws.send({ type: "call_service", domain: "homeassistant", service: "restart" }),
      ws.send({ type: "execute_script", sequence: [] }),
      ws.send({ type: "render_template", template: "{{ states | list }}" }),
      ws.send({ type: "camera/stream", entity_id: "camera.bedroom" }),
      ws.send({ type: "auth/sign_path", path: "/api/states" }),
    ]);
    for (const d of denied) {
      expect(d.success).toBe(false);
      expect((d.error as { code: string }).code).toBe("unauthorized");
    }
    expect(env.ha.serviceCalls.length).toBe(before);

    const ok = await ws.send({ type: "call_service", domain: "light", service: "turn_off", target: { entity_id: "light.kitchen" } });
    expect(ok.success).toBe(true);
    expect(env.ha.serviceCalls.at(-1)).toMatchObject({ domain: "light", service: "turn_off", target: { entity_id: ["light.kitchen"] } });

    // the HA frontend's toggle sends the entity in service_data
    const toggle = await ws.send({ type: "call_service", domain: "light", service: "toggle", service_data: { entity_id: "light.kitchen" } });
    expect(toggle.success).toBe(true);
    const forwarded = env.ha.serviceCalls.at(-1)!;
    expect(forwarded).toMatchObject({ domain: "light", service: "toggle", target: { entity_id: ["light.kitchen"] } });
    expect(forwarded.service_data).toBeUndefined();
    ws.close();
  });

  test("coalesced (array) frames from HA are filtered element by element", async () => {
    const ws = await connect();
    const sf = await ws.send({ type: "supported_features", features: { coalesce_messages: 1 } });
    expect(sf.success).toBe(true);
    const [states, config, panels] = await Promise.all([
      ws.send({ type: "get_states" }),
      ws.send({ type: "get_config" }),
      ws.send({ type: "get_panels" }),
    ]);
    expect((states.result as Array<{ entity_id: string }>).map((s) => s.entity_id).sort()).toEqual(["camera.garden", "light.kitchen", "lock.front"]);
    expect((config.result as { latitude: number; components: string[] }).latitude).toBe(0);
    expect((config.result as { components: string[] }).components).toEqual(["light"]);
    expect(Object.keys(panels.result as object)).toEqual(["guest-dash"]);
    ws.close();
  });

  test("render_template runs dashboard templates with fixed variables", async () => {
    const ws = await connect();
    const res = await ws.send({
      type: "render_template",
      template: "Kitchen is {{ states('light.kitchen') }}",
      variables: { config: { entity: "lock.front" } },
    });
    expect(res.success).toBe(true);
    const [ev] = await ws.events(res.id as number);
    const rendered = (ev!.event as { result: string }).result;
    expect(rendered).toContain('"user":"Guest"');
    expect(rendered).not.toContain("lock.front");
    ws.close();
  });

  test("history results are filtered even if HA returns more", async () => {
    const ws = await connect();
    const res = await ws.send({ type: "history/history_during_period", entity_ids: ["light.kitchen"], start_time: "2026-01-01T00:00:00Z" });
    expect(Object.keys(res.result as object)).toEqual(["light.kitchen"]);
    ws.close();
  });

  test("a dashboard edit that keeps the allowlist is announced with lovelace_updated", async () => {
    const ws = await connect();
    const sub = await ws.send({ type: "subscribe_events", event_type: "lovelace_updated" });
    expect(sub.success).toBe(true);
    const dashboard = env.dashboards.get("guest-dash")!;
    const { GUEST_DASHBOARD } = await import("./mock-ha");
    env.ha.dashboards.set("guest-dash", { ...GUEST_DASHBOARD, title: "Renamed" });
    // HA's own event is dropped; the proxy re-analyses the dashboard ...
    env.ha.emitEvent("lovelace_updated", { url_path: "guest-dash", mode: "storage" });
    // ... and exactly one event from the proxy arrives afterwards
    const events = await ws.events(sub.id as number, 2, 300);
    expect(dashboard.accessChanged).toBe(false);
    expect(events).toHaveLength(1);
    expect((events[0]!.event as { data: { url_path: string } }).data.url_path).toBe("guest-dash");
    env.ha.dashboards.set("guest-dash", GUEST_DASHBOARD);
    await dashboard.load(env.runtime.client!);
    ws.close();
  });

  test("a dashboard edit that changes the allowlist makes guests reconnect", async () => {
    const ws = await connect();
    const dashboard = env.dashboards.get("guest-dash")!;
    const { GUEST_DASHBOARD } = await import("./mock-ha");
    const views = GUEST_DASHBOARD.views as Array<{ cards: unknown[] }>;
    env.ha.dashboards.set("guest-dash", { views: [{ cards: [...views[0]!.cards, { type: "tile", entity: "light.bedroom" }] }] });
    await dashboard.load(env.runtime.client!);
    expect(dashboard.status).toBe("ok");
    expect(dashboard.accessChanged).toBe(true);
    await ws.closed;

    // after reconnecting, the new entity is part of the initial states
    const again = await connect();
    const sub = await again.send({ type: "subscribe_entities" });
    const [init] = await again.events(sub.id as number);
    expect(Object.keys((init!.event as { a: object }).a)).toContain("light.bedroom");
    again.close();

    env.ha.dashboards.set("guest-dash", GUEST_DASHBOARD);
    await dashboard.load(env.runtime.client!);
  });

  test("a card added that cannot be checked is hidden, guests stay connected", async () => {
    const ws = await connect();
    const sub = await ws.send({ type: "subscribe_events", event_type: "lovelace_updated" });
    const dashboard = env.dashboards.get("guest-dash")!;
    const { GUEST_DASHBOARD } = await import("./mock-ha");
    const views = GUEST_DASHBOARD.views as Array<{ cards: unknown[] }>;
    env.ha.dashboards.set("guest-dash", {
      views: [{ cards: [...views[0]!.cards, { type: "custom:mushroom-light-card", entity: "light.bedroom" }] }],
    });
    await dashboard.load(env.runtime.client!);
    expect(dashboard.status).toBe("ok");
    expect(dashboard.issues.map((i) => [i.rule, i.hidden])).toEqual([["custom-card", "$.views[0].cards[4]"]]);
    // The entity only on the hidden card is not allowed, so nothing changed for guests.
    expect(dashboard.entities.has("light.bedroom")).toBe(false);
    expect(dashboard.accessChanged).toBe(false);
    expect(await ws.events(sub.id as number)).toHaveLength(1);

    const config = (await ws.send({ type: "lovelace/config", url_path: "guest-dash" })).result as { views: Array<{ cards: unknown[] }> };
    expect(config.views[0]!.cards).toHaveLength(4);
    const denied = await ws.send({ type: "call_service", domain: "light", service: "turn_on", target: { entity_id: "light.bedroom" } });
    expect(denied.success).toBe(false);
    ws.close();

    env.ha.dashboards.set("guest-dash", GUEST_DASHBOARD);
    await dashboard.load(env.runtime.client!);
    expect(dashboard.issues).toEqual([]);
  });

  test("a dashboard that becomes unusable drops its connections", async () => {
    const ws = await connect();
    const dashboard = env.dashboards.get("guest-dash")!;
    env.ha.dashboards.set("guest-dash", { strategy: { type: "original-states" } });
    await dashboard.load(env.runtime.client!);
    expect(dashboard.status).toBe("rejected");
    await ws.closed;
    expect((await env.hassToken(cookie)).status).toBe(403);

    // restore
    const { GUEST_DASHBOARD } = await import("./mock-ha");
    env.ha.dashboards.set("guest-dash", GUEST_DASHBOARD);
    await dashboard.load(env.runtime.client!);
    expect(dashboard.status).toBe("ok");
  });
});
