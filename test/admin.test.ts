import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminSessions } from "../src/admin/sessions";
import { Runtime } from "../src/runtime";
import { createIngressServer } from "../src/server";
import { importLegacyConfig } from "../src/setup/legacy-import";
import { Store } from "../src/store";
import { GuestWs, randomPort, startTestEnv, testEnvConfig, type TestEnv } from "./helpers";
import { ADMIN_TOKEN, MOCK_TOKEN, USER_TOKEN, startMockHA } from "./mock-ha";

type Json = Record<string, any>;

function cookiesFrom(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]!);
}

function adminApi(env: TestEnv) {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res: Response) => {
    for (const c of cookiesFrom(res)) {
      const [k, ...v] = c.split("=");
      if (v.join("=") === "") jar.delete(k!);
      else jar.set(k!, v.join("="));
    }
  };
  return {
    jar,
    cookieHeader,
    store,
    async call(method: string, path: string, body?: unknown, { csrf = true } = {}) {
      const res = await fetch(`${env.url}/admin/api/${path}`, {
        method,
        headers: {
          origin: env.url,
          cookie: cookieHeader(),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(csrf && method !== "GET" ? { "x-guest-assistant": "1" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      store(res);
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
    },
    /** Plays the HA login page: the given user "signs in" and HA redirects back. */
    async completeOAuth(authorizeUrl: string, userToken: string) {
      const url = new URL(authorizeUrl);
      const code = env.ha.issueCode(url.searchParams.get("client_id")!, userToken);
      const res = await fetch(`${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}`, {
        headers: { cookie: cookieHeader() },
        redirect: "manual",
      });
      store(res);
      return res;
    },
  };
}

describe("fresh installation (standalone)", () => {
  let env: TestEnv;
  let code: string;
  beforeAll(async () => {
    env = await startTestEnv({ configured: false });
    code = env.sessions.newSetupCode();
  });
  afterAll(() => env.stop());

  test("reports that set-up is needed and refuses admin calls", async () => {
    const a = adminApi(env);
    const state = await a.call("GET", "state");
    expect(state.body).toMatchObject({ configured: false, setup_code_required: true, signed_in: null, mode: "standalone" });
    expect((await a.call("GET", "dashboards")).status).toBe(401);
    expect((await a.call("GET", "setup/discover")).status).toBe(401);
    expect((await a.call("POST", "setup/connect", { url: env.ha.url })).status).toBe(401);
  });

  test("the built admin page is served with relative asset URLs", async () => {
    const res = await fetch(`${env.url}/admin/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('src="./app-abcd1234.js"');
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const js = await fetch(`${env.url}/admin/app-abcd1234.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${env.url}/admin/../package.json`)).status).toBe(404);
    expect((await fetch(`${env.url}/admin/%2e%2e/%2e%2e/package.json`)).status).toBe(404);
    expect((await fetch(`${env.url}/admin`, { redirect: "manual" })).status).toBe(308);
  });

  test("mutating calls need the CSRF header", async () => {
    const a = adminApi(env);
    expect((await a.call("POST", "setup/code", { code }, { csrf: false })).status).toBe(403);
  });

  test("a wrong setup code is rejected", async () => {
    const a = adminApi(env);
    expect((await a.call("POST", "setup/code", { code: "0000-0000" })).status).toBe(403);
  });

  test("setup: code, pick HA, admin OAuth, proxy user is created and used", async () => {
    const a = adminApi(env);
    expect((await a.call("POST", "setup/code", { code })).status).toBe(200);
    expect((await a.call("GET", "state")).body.signed_in).toBe("setup");

    const start = await a.call("POST", "setup/connect", { url: env.ha.url });
    expect(start.status).toBe(200);
    const authorize = new URL(start.body.authorize_url);
    expect(authorize.origin).toBe(env.ha.url);
    expect(authorize.pathname).toBe("/auth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe(`${env.url}/admin/`);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${env.url}/admin/callback`);

    const done = await a.completeOAuth(start.body.authorize_url, ADMIN_TOKEN);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/admin/");
    expect(a.jar.has("ga_admin")).toBe(true);

    // The proxy created its own non-admin user and connected with it.
    const proxyUsers = env.ha.users.filter((u) => u.name === "Guest Assistant");
    expect(proxyUsers).toHaveLength(1);
    expect(proxyUsers[0]).toMatchObject({ is_admin: false, local_only: true, group_ids: ["system-users"] });
    expect(env.runtime.state).toBe("connected");
    const ha = env.runtime.haSettings!;
    expect(ha.user_id).toBe(proxyUsers[0]!.id);
    expect(ha.token).not.toBe(ADMIN_TOKEN);
    expect(ha.configured_by).toBe("Owner");
    // The admin's session and the one-off login of the proxy user were ended.
    expect(env.ha.revoked.filter((t) => t.startsWith("refresh-"))).toHaveLength(2);

    const state = await a.call("GET", "state");
    expect(state.body).toMatchObject({ configured: true, signed_in: "admin", admin_name: "Owner", ha: { state: "connected", url: env.ha.url } });

    // Set-up is over: the code no longer works.
    expect((await adminApi(env).call("POST", "setup/code", { code })).status).toBe(409);

    // Dashboards and guests are managed through the API.
    const available = await a.call("GET", "dashboards");
    expect(available.body.available.map((d: Json) => d.id)).toContain("guest-dash");
    const added = await a.call("POST", "dashboards", { id: "guest-dash", theme: { mode: "light" } });
    expect(added.status).toBe(200);
    expect(added.body.configured).toMatchObject([{ id: "guest-dash", status: "ok", entities: 3, title: "Title guest-dash" }]);
    expect((await a.call("POST", "dashboards", { id: "nope" })).status).toBe(400);

    const guest = await a.call("POST", "guests", { username: "visitor", password: "visitor-pass-1", dashboard: "guest-dash" });
    expect(guest.status).toBe(201);
    expect((await a.call("POST", "guests", { username: "visitor", password: "visitor-pass-1", dashboard: "guest-dash" })).status).toBe(400);
    expect((await a.call("POST", "guests", { username: "x y", password: "visitor-pass-1", dashboard: "guest-dash" })).status).toBe(400);

    const cookie = await env.login("visitor", "visitor-pass-1");
    const token = await env.hassToken(cookie);
    expect(token.status).toBe(200);
    expect(token.body.dashboard_url_path).toBe("guest-dash");

    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(token.body.access_token as string)).type).toBe("auth_ok");
    const states = await ws.send({ type: "get_states" });
    expect((states.result as Json[]).map((s) => s.entity_id).sort()).toEqual(["camera.garden", "light.kitchen", "lock.front"]);
    ws.close();
  });

  test("the sign-in state must come back to the browser that started it", async () => {
    const a = adminApi(env);
    const start = await a.call("POST", "login", {});
    expect(start.status).toBe(200);
    a.jar.delete("ga_oauth");
    const res = await a.completeOAuth(start.body.authorize_url, ADMIN_TOKEN);
    expect(res.headers.get("location")).toContain("error=");
    expect(a.jar.has("ga_admin")).toBe(false);
  });

  test("non-admin HA users cannot sign in", async () => {
    const a = adminApi(env);
    const start = await a.call("POST", "login", {});
    const res = await a.completeOAuth(start.body.authorize_url, USER_TOKEN);
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("Alice is not a Home Assistant administrator");
    expect(a.jar.has("ga_admin")).toBe(false);
  });

  test("connection details are only shown to admins", async () => {
    const state = await adminApi(env).call("GET", "state");
    expect(state.body).toMatchObject({ configured: true, signed_in: null, ha: null, public_url: null });
  });

  test("admins sign in again with HA; no admin token is kept", async () => {
    const a = adminApi(env);
    const start = await a.call("POST", "login", {});
    const before = env.runtime.haSettings!;
    await a.completeOAuth(start.body.authorize_url, ADMIN_TOKEN);
    expect((await a.call("GET", "state")).body.signed_in).toBe("admin");
    expect(env.runtime.haSettings).toEqual(before);
    expect((await a.call("POST", "logout", {})).status).toBe(200);
    expect((await a.call("GET", "dashboards")).status).toBe(401);
  });

  test("setting up again replaces the previous proxy user", async () => {
    const a = adminApi(env);
    await a.completeOAuth((await a.call("POST", "login", {})).body.authorize_url, ADMIN_TOKEN);
    const previous = env.runtime.haSettings!.user_id;
    const start = await a.call("POST", "setup/connect", { url: env.ha.url });
    expect(start.status).toBe(200);
    await a.completeOAuth(start.body.authorize_url, ADMIN_TOKEN);
    const proxyUsers = env.ha.users.filter((u) => u.name === "Guest Assistant");
    expect(proxyUsers).toHaveLength(1);
    expect(proxyUsers[0]!.id).not.toBe(previous);
    expect(env.runtime.state).toBe("connected");
    expect(env.runtime.dashboards.get("guest-dash")?.status).toBe("ok");
  });

  test("an unreachable or wrong URL is refused before redirecting", async () => {
    const a = adminApi(env);
    await a.completeOAuth((await a.call("POST", "login", {})).body.authorize_url, ADMIN_TOKEN);
    const res = await a.call("POST", "setup/connect", { url: "http://127.0.0.1:1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Cannot reach");
  });
});

describe("admin decisions on a dashboard", () => {
  let env: TestEnv;
  let a: ReturnType<typeof adminApi>;
  beforeAll(async () => {
    env = await startTestEnv();
    a = adminApi(env);
    a.jar.set("ga_admin", env.sessions.create("admin", "Tester").id);
  });
  afterAll(() => env.stop());

  const connectGuest = async (username: string, password: string) => {
    const cookie = await env.login(username, password);
    const token = (await env.hassToken(cookie)).body.access_token as string;
    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(token)).type).toBe("auth_ok");
    return { ws, cookie };
  };
  const guestConfig = async (ws: GuestWs) => (await ws.send({ type: "lovelace/config", url_path: "links-dash" })).result as Json;
  const cardActions = (config: Json) => (config.views[0].cards as Json[]).map((c) => c.tap_action ?? c.hold_action ?? null);

  test("preview lists the questions before a dashboard is added", async () => {
    const res = await a.call("GET", "dashboards/preview/links-dash");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.questions.map((q: Json) => [q.kind, q.subject, q.answer, q.answered])).toEqual([
      ["navigate_view", "/links-dash/sub", "ok", false],
      ["url", "https://example.com/wifi", "block", false],
      ["navigate_outside", "/config/dashboard", "ok", false],
      ["media_group", "media_player.kitchen", "none", false],
      ["media_group", "media_player.living", "none", false],
    ]);
  });

  test("unanswered questions apply the restrictive choice and notify the admin in HA", async () => {
    const added = await a.call("POST", "dashboards", { id: "links-dash" });
    const view = (added.body.configured as Json[]).find((d) => d.id === "links-dash")!;
    expect(view.pending).toBe(5);
    await Bun.sleep(50);
    const notification = env.ha.serviceCalls.find((c) => c.domain === "persistent_notification" && c.service === "create");
    expect(notification).toBeDefined();
    expect((notification!.service_data as Json).notification_id).toBe("guest_assistant_links_dash");

    expect((await a.call("POST", "guests", { username: "links", password: "links-pass-1", dashboard: "links-dash" })).status).toBe(201);
    const { ws } = await connectGuest("links", "links-pass-1");
    const config = await guestConfig(ws);
    expect(cardActions(config)).toEqual([
      { action: "navigate", navigation_path: "/links-dash/sub" },
      { action: "none" },
      { action: "none" },
      null,
      null,
      null,
    ]);
    // the subview is part of the analysis
    const states = await ws.send({ type: "get_states" });
    expect((states.result as Json[]).map((s) => s.entity_id)).toContain("light.bedroom");

    const join = await ws.send({
      type: "call_service",
      domain: "media_player",
      service: "join",
      target: { entity_id: "media_player.living" },
      service_data: { group_members: ["media_player.kitchen"] },
    });
    expect(join.success).toBe(false);
    ws.close();
  });

  test("answers take effect for connected guests and clear the notification", async () => {
    const { ws } = await connectGuest("links", "links-pass-1");
    const sub = await ws.send({ type: "subscribe_events", event_type: "lovelace_updated" });
    const res = await a.call("PATCH", "dashboards/links-dash", {
      answers: {
        "navigate:/links-dash/sub": "ok",
        "navigate:/config/dashboard": "ok",
        "url:https://example.com/wifi": "allow",
        "media_group:media_player.living": "dashboard",
        "media_group:media_player.kitchen": "none",
      },
    });
    expect(res.status).toBe(200);
    expect((res.body.configured as Json[]).find((d) => d.id === "links-dash")!.pending).toBe(0);
    // the frontend is told to reload the (differently rewritten) config
    expect(await ws.events(sub.id as number, 1)).toHaveLength(1);
    expect(cardActions(await guestConfig(ws))[1]).toEqual({ action: "url", url_path: "https://example.com/wifi" });

    const join = await ws.send({
      type: "call_service",
      domain: "media_player",
      service: "join",
      target: { entity_id: "media_player.living" },
      service_data: { group_members: ["media_player.kitchen"] },
    });
    expect(join.success).toBe(true);
    const kitchen = await ws.send({
      type: "call_service",
      domain: "media_player",
      service: "join",
      target: { entity_id: "media_player.kitchen" },
      service_data: { group_members: ["media_player.living"] },
    });
    expect(kitchen.success).toBe(false);
    await Bun.sleep(50);
    expect(env.ha.serviceCalls.some((c) => c.domain === "persistent_notification" && c.service === "dismiss")).toBe(true);
    ws.close();
  });

  test("a dashboard edit with a new link asks again and blocks it meanwhile", async () => {
    const { LINKS_DASHBOARD } = await import("./mock-ha");
    const edited = structuredClone(LINKS_DASHBOARD) as Json;
    edited.views[0].cards.push({ type: "button", entity: "light.kitchen", tap_action: { action: "url", url_path: "https://evil.example" } });
    env.ha.dashboards.set("links-dash", edited);
    env.ha.emitEvent("lovelace_updated", { url_path: "links-dash", mode: "storage" });
    await Bun.sleep(100);
    const d = env.runtime.dashboards.get("links-dash")!;
    expect(d.pending.map((q) => q.key)).toEqual(["url:https://evil.example"]);
    const { ws } = await connectGuest("links", "links-pass-1");
    const actions = cardActions(await guestConfig(ws));
    expect(actions[1]).toEqual({ action: "url", url_path: "https://example.com/wifi" });
    expect(actions[6]).toEqual({ action: "none" });
    ws.close();
    env.ha.dashboards.set("links-dash", LINKS_DASHBOARD);
  });

  test("editing and deleting guests ends their access", async () => {
    const guests = (await a.call("GET", "guests")).body as Json[];
    const links = guests.find((g) => g.username === "links")!;
    const { ws, cookie } = await connectGuest("links", "links-pass-1");

    const moved = await a.call("PATCH", `guests/${links.id}`, { dashboard: "guest-dash" });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({ id: links.id, username: "links", dashboard: "guest-dash" });
    // the look is set per dashboard only
    expect((await a.call("PATCH", `guests/${links.id}`, { theme: { mode: "dark" } })).status).toBe(400);
    await ws.closed;
    expect((await env.hassToken(cookie)).status).toBe(401);

    const again = await connectGuest("links", "links-pass-1");
    expect((await a.call("DELETE", `guests/${links.id}`)).status).toBe(200);
    await again.ws.closed;
    expect((await env.hassToken(again.cookie)).status).toBe(401);
    expect((await fetch(`${env.url}/api/states`, { headers: { cookie: again.cookie } })).status).toBe(401);
  });

  let guestCookie = "";
  test("theme changes reach guests with their next token", async () => {
    const { ws, cookie } = await connectGuest("guest", "guest-pass-123");
    guestCookie = cookie;
    expect((await a.call("PATCH", "dashboards/guest-dash", { theme: { name: "midnight", mode: "light" } })).status).toBe(200);
    await ws.closed;
    const token = await env.hassToken(cookie);
    expect(token.body.theme_mode_selectable).toBe(false);
    const again = new GuestWs(env.wsUrl);
    await again.auth(token.body.access_token as string);
    const theme = await again.send({ type: "frontend/get_user_data", key: "theme" });
    expect(theme.result).toEqual({ value: { theme: "midnight", dark: false } });
    again.close();
  });

  test("themes and settings", async () => {
    expect((await a.call("GET", "themes")).body).toEqual(["midnight", "nord"]);
    const saved = await a.call("PUT", "settings", { public_url: "https://guests.example.com/ignored-path" });
    expect(saved.body.public_url).toBe("https://guests.example.com");
    expect((await a.call("PUT", "settings", { public_url: "javascript:alert(1)" })).status).toBe(400);
    expect((await a.call("PUT", "settings", { public_url: "" })).body.public_url).toBeNull();
  });

  test("removing a dashboard removes its guests", async () => {
    expect((await a.call("POST", "guests", { username: "tmp", password: "tmp-pass-12", dashboard: "links-dash" })).status).toBe(201);
    const res = await a.call("DELETE", "dashboards/links-dash");
    expect(res.status).toBe(200);
    expect((res.body.configured as Json[]).some((d) => d.id === "links-dash")).toBe(false);
    const guests = (await a.call("GET", "guests")).body as Json[];
    expect(guests.some((g) => g.username === "tmp")).toBe(false);
  });

  test("guests cannot reach the admin API with their session", async () => {
    // (sign-in is rate limited, so the session from above is reused)
    const res = await fetch(`${env.url}/admin/api/guests`, { headers: { cookie: guestCookie } });
    expect(res.status).toBe(401);
  });
});

describe("running as an app", () => {
  let env: TestEnv;
  let ingress: ReturnType<typeof createIngressServer>;
  beforeAll(async () => {
    env = await startTestEnv({ mode: "app" });
    ingress = createIngressServer(env.runtime, env.sessions, randomPort());
  });
  afterAll(() => {
    ingress.stop(true);
    env.stop();
  });

  test("the admin page is not on the guest port", async () => {
    expect((await fetch(`${env.url}/admin/`)).status).toBe(404);
  });

  test("ingress identity headers are only trusted from the Supervisor", async () => {
    const res = await fetch(`http://localhost:${ingress.port}/api/guests`, { headers: { "x-remote-user-id": "owner" } });
    expect(res.status).toBe(401);
    const state = await fetch(`http://localhost:${ingress.port}/api/state`, { headers: { "x-remote-user-id": "owner" } });
    expect(((await state.json()) as Json).signed_in).toBeNull();
    // there is no OAuth login as an app
    const login = await fetch(`http://localhost:${ingress.port}/api/login`, { method: "POST", headers: { "x-guest-assistant": "1" } });
    expect(login.status).toBe(400);
  });
});

describe("config.yaml import", () => {
  test("imports connection, dashboards and guests once", async () => {
    const ha = startMockHA();
    const dir = mkdtempSync(join(tmpdir(), "ga-import-"));
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      [
        "home-assistant:",
        "  host: localhost",
        `  port: ${ha.port}`,
        `  long_lived_access_token: ${MOCK_TOKEN}`,
        "base_url: https://guests.example.com",
        "dashboards:",
        "  - id: guest-dash",
        "    theme: { mode: dark }",
        "    users:",
        "      - username: Visitor",
        "        password: visitor-pass-1",
        "        theme: { guest_can_change_mode: true }",
      ].join("\n"),
    );
    const port = randomPort();
    const runtime = new Runtime({ ...testEnvConfig(port), legacyConfigPath: path }, Store.memory(), "standalone");
    await runtime.init();
    expect(await importLegacyConfig(runtime, path)).toBe(true);
    expect(await importLegacyConfig(runtime, path)).toBe(false);
    expect(runtime.haSettings).toMatchObject({ url: `http://localhost:${ha.port}`, token: MOCK_TOKEN, configured_by: "config.yaml" });
    expect(runtime.publicUrl).toBe("https://guests.example.com");
    expect(runtime.store.listDashboards()).toEqual([{ id: "guest-dash", theme: { mode: "dark" }, answers: {} }]);
    const guests = await runtime.guests.list();
    expect(guests).toMatchObject([{ username: "Visitor", dashboard: "guest-dash" }]);
    await runtime.connect();
    expect(runtime.state).toBe("connected");
    // old per-user overrides are ignored
    expect(runtime.themeFor("guest-dash")).toEqual({ mode: "dark", guest_can_change_mode: false });
    runtime.close();
    ha.stop();
  });
});

describe("connection safety", () => {
  test("an admin token is never used for guest traffic", async () => {
    const ha = startMockHA();
    const store = Store.memory();
    store.set("ha", { url: ha.url, token: ADMIN_TOKEN });
    const runtime = new Runtime(testEnvConfig(randomPort()), store, "standalone");
    await runtime.init();
    await runtime.connect();
    expect(runtime.state).toBe("error");
    expect(runtime.error).toContain("administrator");
    expect(runtime.client).toBeNull();
    runtime.close();
    ha.stop();
  });

  test("setup codes are rate limited", () => {
    const sessions = new AdminSessions();
    const code = sessions.newSetupCode();
    for (let i = 0; i < 10; i++) expect(sessions.checkSetupCode("1111-1111")).toBe("wrong");
    expect(sessions.checkSetupCode(code)).toBe("throttled");
  });
});
