import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DISABLED_AUTH_PATHS } from "../src/auth";
import { GuestWs, startTestEnv, type TestEnv } from "./helpers";

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
    expect(typeof t.body.access_token).toBe("string");
  });

  test("hass-token requires a session", async () => {
    expect((await fetch(`${env.url}/api/auth/hass-token`)).status).toBe(401);
  });

  test("users of rejected dashboards cannot get a token", async () => {
    const badCookie = await env.login("badguest", "bad-pass-123");
    const t = await env.hassToken(badCookie);
    expect(t.status).toBe(403);
    expect(t.body.reason).toEqual([expect.stringContaining("custom:auto-entities")]);
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

  test("rejects invalid tokens", async () => {
    const ws = new GuestWs(env.wsUrl);
    const res = await ws.auth("nonsense");
    expect(res.type).toBe("auth_invalid");
    await ws.closed;
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

  test("a dashboard that becomes invalid drops its connections", async () => {
    const ws = await connect();
    const dashboard = env.dashboards.get("guest-dash")!;
    env.ha.dashboards.set("guest-dash", { views: [{ cards: [{ type: "custom:auto-entities" }] }] });
    await dashboard.load(env.client);
    expect(dashboard.status).toBe("rejected");
    await ws.closed;
    expect((await env.hassToken(cookie)).status).toBe(403);

    // restore
    const { GUEST_DASHBOARD } = await import("./mock-ha");
    env.ha.dashboards.set("guest-dash", GUEST_DASHBOARD);
    await dashboard.load(env.client);
    expect(dashboard.status).toBe("ok");
  });
});
