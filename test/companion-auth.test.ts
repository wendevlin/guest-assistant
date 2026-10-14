import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { AppTokens } from "../src/companion/tokens";
import { ANDROID, CALLBACK, GuestWs, IOS, postForm, startTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;

/** The login limiter counts per minute; each test starts in a fresh one. */
function nextMinute() {
  setSystemTime(new Date(Date.now() + 61_000));
}

beforeAll(async () => {
  env = await startTestEnv();
  env.runtime.setCompanion({ enabled: true });
});

afterEach(() => nextMinute());

afterAll(() => {
  setSystemTime();
  env.stop();
});

const loginFlow = (body: Record<string, unknown>, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(`${env.url}/auth/login_flow`, { method: "POST", headers, body: JSON.stringify(body) });

const states = (token: string, headers: Record<string, string> = {}) =>
  fetch(`${env.url}/api/states/light.kitchen`, { headers: { authorization: `Bearer ${token}`, ...headers } });

describe("switched off", () => {
  test("every companion route answers 404 and earlier app tokens stop working", async () => {
    const tokens = await env.appLogin("guest", "guest-pass-123");
    env.runtime.setCompanion({ enabled: false });
    try {
      expect((await fetch(`${env.url}/auth/authorize?client_id=${ANDROID}`)).status).toBe(404);
      expect((await loginFlow({ client_id: ANDROID, redirect_uri: CALLBACK, username: "guest", password: "guest-pass-123" })).status).toBe(404);
      expect((await postForm(`${env.url}/auth/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: ANDROID })).status).toBe(404);
      expect((await fetch(`${env.url}/api/mobile_app/registrations`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(404);
      expect((await states(tokens.access_token)).status).toBe(401);
      // Switching off ended the login for good.
      expect(env.runtime.appTokens.listAll()).toEqual([]);
    } finally {
      env.runtime.setCompanion({ enabled: true });
    }
    // Switched on again, the old refresh token does not come back.
    const refresh = await postForm(`${env.url}/auth/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: ANDROID });
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("/auth/ never falls back to the guest page", async () => {
    const res = await fetch(`${env.url}/auth/providers`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(404);
  });
});

describe("authorize page and login flow", () => {
  test("/auth/authorize serves the authorize page with its own CSP", async () => {
    const res = await fetch(`${env.url}/auth/authorize?response_type=code&client_id=${encodeURIComponent(IOS)}&redirect_uri=${encodeURIComponent(CALLBACK)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("only the official apps' client ids and redirect URIs get a code", async () => {
    const base = { username: "guest", password: "guest-pass-123" };
    expect((await loginFlow({ ...base, client_id: "https://evil.example", redirect_uri: CALLBACK })).status).toBe(400);
    expect((await loginFlow({ ...base, client_id: ANDROID, redirect_uri: "https://evil.example/cb" })).status).toBe(400);
    // Form posts cannot be sent cross-site without CORS; only JSON is accepted.
    expect((await loginFlow({ ...base, client_id: ANDROID, redirect_uri: CALLBACK }, { "content-type": "text/plain" })).status).toBe(415);
  });

  test("wrong passwords and unknown users look the same and create no session", async () => {
    const guest = (await env.runtime.guests.list()).find((g) => g.username === "guest")!;
    const ctx = await env.runtime.auth.$context;
    const before = (await ctx.internalAdapter.listSessions(guest.id)).length;
    for (const username of ["guest", "nobody"]) {
      const res = await loginFlow({ client_id: ANDROID, redirect_uri: CALLBACK, username, password: "wrong-password" });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ type: "form", errors: { base: "invalid_auth" } });
    }
    await env.appLogin("guest", "guest-pass-123");
    expect((await ctx.internalAdapter.listSessions(guest.id)).length).toBe(before);
  });

  test("a switched-off guest is told so", async () => {
    const guest = await env.runtime.createGuest({ username: "away", password: "away-pass-123", dashboard: "guest-dash", enabled: false });
    const res = await loginFlow({ client_id: ANDROID, redirect_uri: CALLBACK, username: "away", password: "away-pass-123" });
    expect(await res.json()).toMatchObject({ type: "form", errors: { base: "guest_disabled" } });
    await env.runtime.deleteGuest(guest.id);
  });

  test("sign-in attempts are limited per address", async () => {
    const attempt = () => loginFlow({ client_id: ANDROID, redirect_uri: CALLBACK, username: "guest", password: "wrong-password" });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);
  });
});

describe("tokens", () => {
  test("a code is exchanged once, by the app it was issued for, within a minute", async () => {
    const flow = async () =>
      ((await (await loginFlow({ client_id: ANDROID, redirect_uri: CALLBACK, username: "guest", password: "guest-pass-123" })).json()) as { result: string }).result;

    const code = await flow();
    expect((await postForm(`${env.url}/auth/token`, { grant_type: "authorization_code", code, client_id: IOS })).status).toBe(400);
    // Tried with the wrong client id, the code is gone.
    expect((await postForm(`${env.url}/auth/token`, { grant_type: "authorization_code", code, client_id: ANDROID })).status).toBe(400);

    const second = await flow();
    const res = await postForm(`${env.url}/auth/token`, { grant_type: "authorization_code", code: second, client_id: ANDROID });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 900 });
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
    expect((await postForm(`${env.url}/auth/token`, { grant_type: "authorization_code", code: second, client_id: ANDROID })).status).toBe(400);

    const late = await flow();
    setSystemTime(new Date(Date.now() + 61_000));
    expect((await postForm(`${env.url}/auth/token`, { grant_type: "authorization_code", code: late, client_id: ANDROID })).status).toBe(400);
  });

  test("the access token works on HTTP and the WebSocket like the guest page's", async () => {
    const { access_token } = await env.appLogin("guest", "guest-pass-123");
    expect((await states(access_token)).status).toBe(200);
    expect((await fetch(`${env.url}/api/states/light.bedroom`, { headers: { authorization: `Bearer ${access_token}` } })).status).toBe(403);
    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(access_token)).type).toBe("auth_ok");
    const r = await ws.send({ type: "get_states" });
    expect((r.result as Array<{ entity_id: string }>).map((s) => s.entity_id)).not.toContain("light.bedroom");
    ws.close();
  });

  test("refreshing gives a new access token; the refresh token stays the same", async () => {
    const tokens = await env.appLogin("guest", "guest-pass-123");
    const res = await postForm(`${env.url}/auth/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: ANDROID });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 900 });
    expect(body).not.toHaveProperty("refresh_token");
    expect((await states(body.access_token as string)).status).toBe(200);
    // Another app's client id does not fit the login.
    expect((await postForm(`${env.url}/auth/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: IOS })).status).toBe(400);
  });

  test("logins outlive a restart: a new token store still accepts the old tokens", async () => {
    const tokens = await env.appLogin("guest", "guest-pass-123");
    const restarted = new AppTokens(env.runtime.store, () => true);
    expect(restarted.verify(tokens.access_token)?.sub).toBeString();
    expect(restarted.findByRefreshToken(tokens.refresh_token)).toBeDefined();
  });

  test("unknown grant types and garbage are refused", async () => {
    expect((await postForm(`${env.url}/auth/token`, { grant_type: "password", client_id: ANDROID })).status).toBe(400);
    expect((await postForm(`${env.url}/auth/token`, { grant_type: "refresh_token", refresh_token: "nope", client_id: ANDROID })).status).toBe(400);
  });
});

describe("ending app logins", () => {
  async function signedIn(username = "guest", password = "guest-pass-123") {
    const tokens = await env.appLogin(username, password);
    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(tokens.access_token)).type).toBe("auth_ok");
    return { tokens, ws };
  }

  const refresh = (refreshToken: string) =>
    postForm(`${env.url}/auth/token`, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: ANDROID });

  test("Android revokes with the refresh token", async () => {
    const { tokens, ws } = await signedIn();
    const res = await postForm(`${env.url}/auth/revoke`, { token: tokens.refresh_token });
    expect(res.status).toBe(200);
    await ws.closed;
    expect((await states(tokens.access_token)).status).toBe(401);
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
  });

  test("iOS revokes through /auth/token with the access token, also an expired one", async () => {
    const { tokens, ws } = await signedIn();
    setSystemTime(new Date(Date.now() + 16 * 60_000));
    const res = await postForm(`${env.url}/auth/token`, { action: "revoke", token: tokens.access_token });
    expect(res.status).toBe(200);
    await ws.closed;
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    // Unknown tokens get the same answer.
    expect((await postForm(`${env.url}/auth/revoke`, { token: "unknown" })).status).toBe(200);
  });

  test("switching a guest off refuses their tokens at once and refreshes until switched on again", async () => {
    const guest = await env.runtime.createGuest({ username: "visitor", password: "visitor-pass-1", dashboard: "guest-dash" });
    const { tokens, ws } = await signedIn("visitor", "visitor-pass-1");
    await env.runtime.updateGuest(guest.id, { enabled: false });
    await ws.closed;
    expect((await states(tokens.access_token)).status).toBe(401);
    const denied = await refresh(tokens.refresh_token);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe("access_denied");
    // The login is kept: switched on again, the app gets tokens without signing in.
    await env.runtime.updateGuest(guest.id, { enabled: true });
    const again = await refresh(tokens.refresh_token);
    expect(again.status).toBe(200);
    expect((await states(((await again.json()) as { access_token: string }).access_token)).status).toBe(200);
    await env.runtime.deleteGuest(guest.id);
  });

  test("a new dashboard refuses the old token; the next refresh is bound to the new dashboard", async () => {
    const guest = await env.runtime.createGuest({ username: "mover", password: "mover-pass-12", dashboard: "guest-dash" });
    const { tokens } = await signedIn("mover", "mover-pass-12");
    await env.runtime.updateGuest(guest.id, { dashboard: "bad-dash" });
    expect((await states(tokens.access_token)).status).toBe(401);
    const res = await refresh(tokens.refresh_token);
    expect(res.status).toBe(200);
    const fresh = ((await res.json()) as { access_token: string }).access_token;
    expect(env.runtime.appTokens.verify(fresh)?.dashboard).toBe("bad-dash");
    await env.runtime.deleteGuest(guest.id);
  });

  test("a new password and deleting the guest end the logins", async () => {
    const guest = await env.runtime.createGuest({ username: "changer", password: "changer-pass-1", dashboard: "guest-dash" });
    const first = await signedIn("changer", "changer-pass-1");
    await env.runtime.updateGuest(guest.id, { password: "changer-pass-2" });
    await first.ws.closed;
    expect((await refresh(first.tokens.refresh_token)).status).toBe(400);

    const second = await signedIn("changer", "changer-pass-2");
    await env.runtime.deleteGuest(guest.id);
    await second.ws.closed;
    expect((await refresh(second.tokens.refresh_token)).status).toBe(400);
    expect(env.runtime.appTokens.listForUser(guest.id)).toEqual([]);
  });
});
