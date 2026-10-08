import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAuthHandler } from "../src/auth/handler";
import { GuestWs, startTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;

beforeAll(async () => {
  env = await startTestEnv();
  await env.runtime.createGuest({ username: "traveller", password: "traveller-pass-1", dashboard: "guest-dash" });
});

afterAll(() => env.stop());

/**
 * Signed in through the API, not the handler: better-auth's sign-in rate
 * limit is shared by every test in this process.
 */
async function signIn(): Promise<string> {
  const res = await env.runtime.auth.api.signInUsername({
    body: { username: "traveller", password: "traveller-pass-1" },
    asResponse: true,
  });
  return res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
}

async function tokenFor(cookie: string): Promise<string> {
  const t = await env.hassToken(cookie);
  expect(t.status).toBe(200);
  return t.body.access_token as string;
}

function states(token: string): Promise<Response> {
  return fetch(`${env.url}/api/states/light.kitchen`, { headers: { authorization: `Bearer ${token}` } });
}

function signOut(cookie: string, body: object = {}): Promise<Response> {
  return fetch(`${env.url}/api/auth/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: env.url },
    body: JSON.stringify(body),
  });
}

async function connect(token: string): Promise<GuestWs> {
  const ws = new GuestWs(env.wsUrl);
  expect((await ws.auth(token)).type).toBe("auth_ok");
  return ws;
}

function closedWithin(ws: GuestWs, ms: number): Promise<boolean> {
  return Promise.race([ws.closed.then(() => true), Bun.sleep(ms).then(() => false)]);
}

describe("sign-out", () => {
  test("ends the tokens and connections of that session, not the guest's other sessions", async () => {
    const phone = await signIn();
    const laptop = await signIn();
    const phoneToken = await tokenFor(phone);
    const laptopToken = await tokenFor(laptop);
    const phoneWs = await connect(phoneToken);
    const laptopWs = await connect(laptopToken);

    // A sign-out better-auth refuses revokes nothing. (Its origin check is
    // off under NODE_ENV=test, so an invalid body stands in for it.)
    expect((await signOut(phone, { callbackURL: 1 })).status).toBe(400);
    expect((await states(phoneToken)).status).toBe(200);
    expect(await closedWithin(phoneWs, 100)).toBe(false);

    expect((await signOut(phone)).status).toBe(200);
    expect(await closedWithin(phoneWs, 1000)).toBe(true);
    expect((await states(phoneToken)).status).toBe(401);
    const again = new GuestWs(env.wsUrl);
    expect((await again.auth(phoneToken)).type).toBe("auth_invalid");
    await again.closed;

    // The laptop stays signed in, with its token and its connection.
    expect((await states(laptopToken)).status).toBe(200);
    expect((await laptopWs.send({ type: "get_states" })).success).toBe(true);
    expect(await closedWithin(laptopWs, 100)).toBe(false);
    expect((await env.hassToken(laptop)).status).toBe(200);
    laptopWs.close();
  });
});

describe("better-auth allowlist", () => {
  test("only the endpoints the guest frontend uses reach better-auth", async () => {
    const auth = env.runtime.auth;
    const handler = auth.handler;
    let reached = 0;
    auth.handler = (request: Request) => {
      reached++;
      return handler(request);
    };
    try {
      const refused: Array<[string, string]> = [
        ["GET", "/callback/x"],
        ["POST", "/callback/x"],
        ["GET", "/reset-password/x"],
        ["GET", "/error"],
        ["GET", "/ok"],
        ["POST", "/update-user"],
        ["GET", "/a-future-endpoint"],
        // allowed paths with another method
        ["GET", "/sign-in/username"],
        ["GET", "/sign-out"],
        ["POST", "/get-session"],
        ["HEAD", "/get-session"],
        ["GET", "/get-session/"],
      ];
      for (const [method, path] of refused) {
        const res = await fetch(`${env.url}/api/auth${path}`, {
          method,
          headers: { "content-type": "application/json", origin: env.url },
          body: method === "POST" ? "{}" : undefined,
        });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
      }
      expect(reached).toBe(0);

      const cookie = await signIn();
      const session = await fetch(`${env.url}/api/auth/get-session`, { headers: { cookie } });
      expect(session.status).toBe(200);
      expect(((await session.json()) as { user: { username: string } }).user.username).toBe("traveller");
      expect(reached).toBe(1);
      // A route of its own, not part of better-auth.
      expect((await env.hassToken(cookie)).status).toBe(200);
    } finally {
      auth.handler = handler;
    }
  });
});

describe("cookies behind a TLS-terminating proxy", () => {
  const forwarded = { "x-forwarded-proto": "https" };

  test("are Secure when the request was forwarded from https", async () => {
    // Sent to the handler directly with a client address of its own; HTTP
    // sign-ins share one rate-limit bucket (see signIn()).
    const handler = createAuthHandler(env.runtime, () => {});
    const res = await handler(
      new Request(`${env.url}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: env.url, "x-guest-assistant-client-ip": "192.0.2.1", ...forwarded },
        body: JSON.stringify({ username: "traveller", password: "traveller-pass-1" }),
      }),
    );
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) expect(c).toMatch(/;\s*Secure(;|$)/i);
    // Names are unchanged, so the session still works.
    expect(cookies[0]).toStartWith("better-auth.session_token=");
    const cookie = cookies.map((v) => v.split(";")[0]).join("; ");
    expect((await env.hassToken(cookie)).status).toBe(200);

    const out = await fetch(`${env.url}/api/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: env.url, ...forwarded },
      body: "{}",
    });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().length).toBeGreaterThan(0);
    for (const c of out.headers.getSetCookie()) expect(c).toMatch(/;\s*Secure(;|$)/i);
  });

  test("stay as they are over plain http", async () => {
    const out = await signOut("");
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().length).toBeGreaterThan(0);
    for (const c of out.headers.getSetCookie()) expect(c).not.toMatch(/;\s*Secure(;|$)/i);
  });
});
