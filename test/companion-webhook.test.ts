import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GuestWs, NATIVE_UA, startTestEnv, type AppTokensResponse, type TestEnv } from "./helpers";

let env: TestEnv;
let tokens: AppTokensResponse;
let webhookId: string;

const REGISTRATION = {
  app_id: "io.homeassistant.companion.android",
  app_name: "Home Assistant",
  app_version: "2026.10.1",
  device_name: "Pixel 9",
  manufacturer: "Google",
  model: "Pixel 9",
  os_name: "Android",
  os_version: "16",
  supports_encryption: false,
  app_data: { push_websocket_channel: true },
};

const register = (token: string, body: unknown = REGISTRATION) =>
  fetch(`${env.url}/api/mobile_app/registrations`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": NATIVE_UA },
    body: JSON.stringify(body),
  });

const hook = async (type: string, data?: unknown, id = webhookId) => {
  const res = await fetch(`${env.url}/api/webhook/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": NATIVE_UA },
    body: JSON.stringify(data === undefined ? { type } : { type, data }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
};

beforeAll(async () => {
  env = await startTestEnv();
  env.runtime.setCompanion({ enabled: true });
  env.runtime.setAppName("Our Guests");
  tokens = await env.appLogin("guest", "guest-pass-123");
  const res = await register(tokens.access_token);
  webhookId = ((await res.json()) as { webhook_id: string }).webhook_id;
});

afterAll(() => env.stop());

describe("registration", () => {
  test("answers with all four keys the apps expect, without secret or cloud URLs", async () => {
    const res = await register(tokens.access_token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ cloudhook_url: null, remote_ui_url: null, secret: null, webhook_id: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Registering again replaced the webhook id; the old one is gone.
    expect((await hook("get_config")).status).toBe(410);
    webhookId = body.webhook_id as string;
    expect((await hook("get_config")).status).toBe(200);
  });

  test("needs a companion app login, not the guest page's session", async () => {
    // Through the API: better-auth's sign-in rate limit is shared by every test in this process.
    const signIn = await env.runtime.auth.api.signInUsername({ body: { username: "guest", password: "guest-pass-123" }, asResponse: true });
    const cookie = signIn.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const pageToken = (await env.hassToken(cookie)).body.access_token as string;
    expect((await register(pageToken)).status).toBe(403);
    const withCookie = await fetch(`${env.url}/api/mobile_app/registrations`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(REGISTRATION),
    });
    expect(withCookie.status).toBe(403);
    expect((await register("nonsense")).status).toBe(401);
  });

  test("rejects incomplete registrations", async () => {
    const { device_name: _, ...partial } = REGISTRATION;
    expect((await register(tokens.access_token, partial)).status).toBe(400);
  });

  test("the device shows up for the admin", () => {
    const rows = env.runtime.appTokens.listAll();
    expect(rows.some((r) => r.device?.device_name === "Pixel 9" && r.webhook_id === webhookId)).toBe(true);
  });
});

describe("webhook", () => {
  test("get_config has what Android requires, no location and no entities", async () => {
    const { status, body } = await hook("get_config");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      latitude: 0,
      longitude: 0,
      elevation: 0,
      location_name: "Our Guests",
      time_zone: "Europe/Vienna",
      version: "2026.9.0",
      unit_system: { length: "km", temperature: "°C" },
    });
    expect(body).not.toHaveProperty("entities");
    expect(body.components).toEqual(expect.arrayContaining(["light", "mobile_app", "webhook"]));
    for (const hidden of ["conversation", "cloud", "assist_pipeline"]) expect(body.components).not.toContain(hidden);
    expect(typeof body.instance_id).toBe("string");
  });

  test("get_config keeps answering from the stored copy while HA is away", async () => {
    const client = env.runtime.client;
    env.runtime.client = null;
    // A fresh runtime cache would ask HA; the stored copy answers instead.
    (env.runtime as unknown as { haConfigCache?: unknown }).haConfigCache = undefined;
    try {
      const { status, body } = await hook("get_config");
      expect(status).toBe(200);
      expect(body.time_zone).toBe("Europe/Vienna");
    } finally {
      env.runtime.client = client;
    }
  });

  test("update_registration answers the registration, never empty", async () => {
    const { status, body } = await hook("update_registration", { app_version: "2026.11.0", device_name: "Pixel 9 Pro" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ app_version: "2026.11.0", device_name: "Pixel 9 Pro", supports_encryption: false, app_data: {} });
  });

  test("sensors and locations are acknowledged and dropped", async () => {
    expect(await hook("register_sensor", { unique_id: "battery_level", type: "sensor", name: "Battery", state: 80 })).toEqual({
      status: 201,
      body: { success: true },
    });
    const states = await hook("update_sensor_states", [
      { unique_id: "battery_level", state: 79, type: "sensor" },
      { unique_id: "charger", state: false, type: "binary_sensor" },
      { nonsense: true },
    ]);
    expect(states).toEqual({ status: 200, body: { battery_level: { success: true }, charger: { success: true } } });
    expect(await hook("update_location", { gps: [48.2, 16.3], gps_accuracy: 10 })).toEqual({ status: 200, body: {} });
    expect(await hook("get_zones")).toEqual({ status: 200, body: [] });
    expect(await hook("fire_event", { event_type: "x" })).toEqual({ status: 200, body: {} });
  });

  test("templates and other features are not available", async () => {
    expect((await hook("render_template", { t1: { template: "{{ states | list }}" } })).body).toEqual({
      t1: { error: "Templates are not available for guests" },
    });
    for (const type of ["stream_camera", "conversation_process", "enable_encryption", "made_up"]) {
      const { status, body } = await hook(type, {});
      expect(status).toBe(400);
      expect(body.success).toBe(false);
    }
  });

  test("unknown and malformed ids, invalid and oversized bodies", async () => {
    expect((await hook("get_config", undefined, "a".repeat(64))).status).toBe(410);
    expect((await hook("get_config", undefined, "not-hex")).status).toBe(404);
    const bad = await fetch(`${env.url}/api/webhook/${webhookId}`, { method: "POST", body: "{nope" });
    expect(bad.status).toBe(400);
    const big = await fetch(`${env.url}/api/webhook/${webhookId}`, { method: "POST", body: JSON.stringify({ type: "x", data: "y".repeat(300 * 1024) }) });
    expect(big.status).toBe(413);
  });
});

describe("widgets", () => {
  const setWidgets = (widgets: boolean) => env.runtime.updateDashboard("guest-dash", { widgets });

  test("without widgets, the native app gets empty entity data and no service calls", async () => {
    await setWidgets(false);
    const native = new GuestWs(env.wsUrl, { "user-agent": NATIVE_UA });
    expect((await native.auth(tokens.access_token)).type).toBe("auth_ok");
    expect((await native.send({ type: "get_states" })).result).toEqual([]);
    expect((await native.send({ type: "config/device_registry/list" })).result).toEqual([]);
    expect((await native.send({ type: "auth/current_user" })).success).toBe(true);
    const call = await native.send({ type: "call_service", domain: "light", service: "toggle", target: { entity_id: "light.kitchen" } });
    expect(call.success).toBe(false);
    // The push channel the minimal Android flavour keeps open, and unsubscribing it.
    const channel = await native.send({ type: "mobile_app/push_notification_channel", webhook_id: webhookId, support_confirm: true });
    expect(channel.success).toBe(true);
    expect((await native.send({ type: "unsubscribe_events", subscription: channel.id })).success).toBe(true);
    native.close();

    // The app's web view (a browser User-Agent) gets the dashboard as usual.
    const webview = new GuestWs(env.wsUrl);
    await webview.auth(tokens.access_token);
    expect(((await webview.send({ type: "get_states" })).result as unknown[]).length).toBeGreaterThan(0);
    webview.close();

    const camera = await fetch(`${env.url}/api/states/light.kitchen`, { headers: { authorization: `Bearer ${tokens.access_token}`, "user-agent": NATIVE_UA } });
    expect(camera.status).toBe(403);
    expect((await hook("call_service", { domain: "light", service: "toggle", service_data: { entity_id: "light.kitchen" } })).status).toBe(400);
  });

  test("with widgets, the native app gets the dashboard's entities and may control them", async () => {
    await setWidgets(true);
    const native = new GuestWs(env.wsUrl, { "user-agent": NATIVE_UA });
    await native.auth(tokens.access_token);
    const states = (await native.send({ type: "get_states" })).result as Array<{ entity_id: string }>;
    expect(states.map((s) => s.entity_id)).toContain("light.kitchen");
    expect(states.map((s) => s.entity_id)).not.toContain("light.bedroom");
    native.close();

    const before = env.ha.serviceCalls.length;
    expect(await hook("call_service", { domain: "light", service: "toggle", service_data: { entity_id: "light.kitchen" } })).toEqual({ status: 200, body: {} });
    expect(env.ha.serviceCalls.length).toBe(before + 1);
    expect(env.ha.serviceCalls.at(-1)).toMatchObject({ domain: "light", service: "toggle", target: { entity_id: ["light.kitchen"] } });
    // Entities off the dashboard and services guests may not use stay refused.
    expect((await hook("call_service", { domain: "light", service: "toggle", service_data: { entity_id: "light.bedroom" } })).status).toBe(400);
    expect((await hook("call_service", { domain: "homeassistant", service: "restart" })).status).toBe(400);
    expect(env.ha.serviceCalls.length).toBe(before + 1);
    await setWidgets(false);
  });

  test("switching widgets closes the native connections, not the web view's", async () => {
    await setWidgets(true);
    const native = new GuestWs(env.wsUrl, { "user-agent": NATIVE_UA });
    const webview = new GuestWs(env.wsUrl);
    await native.auth(tokens.access_token);
    await webview.auth(tokens.access_token);
    await setWidgets(false);
    await native.closed;
    expect((await webview.send({ type: "ping" })).type).toBe("pong");
    webview.close();
  });
});
