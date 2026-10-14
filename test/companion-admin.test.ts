import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { ADMIN_COOKIE } from "../src/admin/sessions";
import { MAX_CONNECTIONS_PER_APP_LOGIN } from "../src/proxy/ws";
import { describeListenError } from "../src/listen-error";
import { AttemptLimiter } from "../src/rate-limit";
import { GuestWs, NATIVE_UA, startTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;
let cookie: string;

type Json = Record<string, any>;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${env.url}/admin/api/${path}`, {
    method,
    headers: {
      cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-guest-assistant": "1" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Json };
}

beforeAll(async () => {
  env = await startTestEnv();
  cookie = `${ADMIN_COOKIE}=${env.sessions.create("admin", "Alice").id}`;
});

afterAll(() => env.stop());

describe("admin: companion app", () => {
  test("off by default; the settings switch it on and off", async () => {
    const state = (await call("GET", "state")).body;
    expect(state.companion).toEqual({ enabled: false, discoverable: false, discovery: "off", discovery_error: null });
    expect(state).toMatchObject({ flavor: "stable", problems: [] });
    const on = await call("PUT", "settings", { companion: { enabled: true } });
    expect(on.body.companion).toMatchObject({ enabled: true, discoverable: false });
    expect((await call("PUT", "settings", { companion: { enabled: "yes" } })).status).toBe(400);
  });

  test("widgets are a per-dashboard switch, off by default", async () => {
    const dashboards = (await call("GET", "dashboards")).body.configured as Json[];
    expect(dashboards.find((d) => d.id === "guest-dash")?.widgets).toBe(false);
    const patched = await call("PATCH", "dashboards/guest-dash", { widgets: true });
    expect((patched.body.configured as Json[]).find((d) => d.id === "guest-dash")?.widgets).toBe(true);
    expect(env.runtime.store.getDashboard("guest-dash")?.widgets).toBe(true);
    await call("PATCH", "dashboards/guest-dash", { widgets: false });
  });

  test("guests list their app devices, and the admin can sign one out", async () => {
    const tokens = await env.appLogin("guest", "guest-pass-123");
    await fetch(`${env.url}/api/mobile_app/registrations`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ app_id: "io.robbie.HomeAssistant", app_name: "Home Assistant", app_version: "2026.10 (1)", device_name: "Anna's iPhone", manufacturer: "Apple", model: "iPhone17,1", os_name: "iOS", os_version: "26.0" }),
    });
    const ws = new GuestWs(env.wsUrl);
    await ws.auth(tokens.access_token);

    const guests = (await call("GET", "guests")).body as unknown as Json[];
    const guest = guests.find((g) => g.username === "guest")!;
    const device = (guest.devices as Json[]).find((d) => d.name === "Anna's iPhone")!;
    expect(device.app).toBe("Home Assistant 2026.10 (1) (iOS)");
    expect(device.id).toMatch(/^dev_/);

    expect((await call("DELETE", `guests/other/devices/${device.id}`)).status).toBe(404);
    const after = await call("DELETE", `guests/${guest.id}/devices/${device.id}`);
    expect(after.status).toBe(200);
    await ws.closed;
    expect(((after.body as unknown as Json[]).find((g) => g.id === guest.id)!.devices as Json[]).some((d) => d.id === device.id)).toBe(false);
    expect((await fetch(`${env.url}/api/states/light.kitchen`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
  });
});

describe("WebSocket for companion apps", () => {
  test("auth_required reports HA's version, which the apps pick features by", async () => {
    const ws = new WebSocket(env.wsUrl);
    const first = await new Promise<Json>((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data))), { once: true }));
    expect(first).toEqual({ type: "auth_required", ha_version: "2026.9.0" });
    ws.close();
  });

  test("one app login holds a few connections; more push out its own oldest", async () => {
    setSystemTime(new Date(Date.now() + 61_000));
    const tokens = await env.appLogin("guest", "guest-pass-123");
    const conns: GuestWs[] = [];
    for (let i = 0; i <= MAX_CONNECTIONS_PER_APP_LOGIN; i++) {
      const ws = new GuestWs(env.wsUrl, { "user-agent": NATIVE_UA });
      await ws.auth(tokens.access_token);
      conns.push(ws);
    }
    await conns[0]!.closed;
    expect((await conns.at(-1)!.send({ type: "ping" })).type).toBe("pong");
    for (const ws of conns) ws.close();
    setSystemTime();
  });
});

describe("AttemptLimiter", () => {
  test("limits per client and in total within the window", () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const limiter = new AttemptLimiter(2, 3);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, false]);
    expect(limiter.blocked("a")).toBe(true);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.take("c")).toBe(false);
    setSystemTime(new Date("2026-01-01T00:01:01Z"));
    expect(limiter.take("a")).toBe(true);
    setSystemTime();
  });
});

describe("start-up problems", () => {
  test("a port in use is explained with what to do about it", () => {
    const inUse = Object.assign(new Error("Failed to start server. Is port 3123 in use?"), { code: "EADDRINUSE" });
    const app = describeListenError(inUse, 3123, "guest", "app")!;
    expect(app).toContain("port 3123");
    expect(app).toContain("already uses that port");
    expect(app).toContain("Configuration tab");
    expect(describeListenError(inUse, 3123, "guest", "standalone")).toContain("PORT");
    expect(describeListenError(inUse, 8099, "ingress", "app")).toContain("Restart the app");
    expect(describeListenError(new Error("boom"), 3123, "guest", "app")).toBeNull();
  });

  test("shows on the admin page and as a notification in Home Assistant", async () => {
    const before = env.ha.serviceCalls.length;
    env.runtime.reportStartupProblem("Guest Assistant cannot open the guest page (port 3123): taken.");
    expect((await call("GET", "state")).body.problems).toEqual(["Guest Assistant cannot open the guest page (port 3123): taken."]);
    await Bun.sleep(50);
    const notification = env.ha.serviceCalls.slice(before).find((c) => c.domain === "persistent_notification" && c.service === "create");
    expect(notification?.service_data).toMatchObject({ title: "Guest Assistant has a problem", notification_id: "guest_assistant__startup" });
    env.runtime.startupProblems.length = 0;
  });
});
