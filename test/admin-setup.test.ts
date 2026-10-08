import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AdminSessions } from "../src/admin/sessions";
import { HaClient } from "../src/ha/client";
import * as provision from "../src/ha/provision";
import { startTestEnv, type TestEnv } from "./helpers";
import { ADMIN_TOKEN, MOCK_TOKEN, startMockHA, type MockHA } from "./mock-ha";

type Json = Record<string, any>;

/** A setup code that is surely wrong: every digit shifted by one. */
const wrong = (code: string) => code.replace(/\d/g, (d) => String((Number(d) + 1) % 10));

/** Admin API client with a cookie jar; `base` lets a test pick the address it connects from. */
function adminApi(env: TestEnv, base = env.url) {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (res: Response) => {
    for (const c of res.headers.getSetCookie().map((h) => h.split(";")[0]!)) {
      const [k, ...v] = c.split("=");
      if (v.join("=") === "") jar.delete(k!);
      else jar.set(k!, v.join("="));
    }
  };
  return {
    jar,
    async call(method: string, path: string, body?: unknown) {
      const res = await fetch(`${base}/admin/api/${path}`, {
        method,
        headers: {
          origin: base,
          cookie: cookieHeader(),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(method !== "GET" ? { "x-guest-assistant": "1" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      store(res);
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
    },
    /** Plays the login page of `ha`: the admin signs in there and is sent back to the proxy. */
    async completeOAuth(ha: MockHA, authorizeUrl: string) {
      const url = new URL(authorizeUrl);
      const code = ha.issueCode(url.searchParams.get("client_id")!, ADMIN_TOKEN);
      const res = await fetch(`${url.searchParams.get("redirect_uri")}?code=${code}&state=${url.searchParams.get("state")}`, {
        headers: { cookie: cookieHeader() },
        redirect: "manual",
      });
      store(res);
      return res;
    },
    /** Connects (another) Home Assistant through the admin page, like "Connect a different Home Assistant". */
    async connect(ha: MockHA) {
      const start = await this.call("POST", "setup/connect", { url: ha.url });
      expect(start.status).toBe(200);
      const done = await this.completeOAuth(ha, start.body.authorize_url);
      expect(done.headers.get("location")).toBe("/admin/");
    },
  };
}

/** Collects console.warn lines while a test runs. */
function captureWarnings() {
  const lines: string[] = [];
  const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  return { lines, restore: () => spy.mockRestore() };
}

describe("setup code", () => {
  test("wrong guesses from one address do not lock out another", () => {
    const sessions = new AdminSessions();
    const code = sessions.newSetupCode();
    for (let i = 0; i < 10; i++) expect(sessions.checkSetupCode(wrong(code), "192.0.2.1")).toBe("wrong");
    expect(sessions.checkSetupCode(code, "192.0.2.1")).toBe("throttled");
    expect(sessions.checkSetupCode(code, "192.0.2.2")).toBe("ok");
  });

  test("many addresses together cannot guess faster than the overall ceiling", () => {
    const sessions = new AdminSessions();
    const code = sessions.newSetupCode();
    for (let i = 0; i < 60; i++) expect(sessions.checkSetupCode(wrong(code), `198.51.100.${i}`)).toBe("wrong");
    expect(sessions.checkSetupCode(code, "203.0.113.1")).toBe("throttled");
  });

  test("a code expires and a fresh one is announced until set-up is done", async () => {
    const sessions = new AdminSessions(300);
    const codes: string[] = [];
    sessions.startSetupCodes((code) => codes.push(code));
    expect(codes).toHaveLength(1);
    await Bun.sleep(450);
    expect(codes).toHaveLength(2);
    expect(codes[1]).toMatch(/^\d{4}-\d{4}$/);
    expect(sessions.checkSetupCode(codes[0]!, "192.0.2.1")).toBe("wrong");
    expect(sessions.checkSetupCode(codes[1]!, "192.0.2.1")).toBe("ok");

    // Set-up is done: no more codes are printed.
    sessions.setupCode = null;
    await Bun.sleep(400);
    expect(codes).toHaveLength(2);
  });

  describe("on the admin page", () => {
    let env: TestEnv;
    beforeAll(async () => {
      env = await startTestEnv({ configured: false });
    });
    afterAll(() => env.stop());

    test("guesses are throttled per client address", async () => {
      const code = env.sessions.newSetupCode();
      // Connect over IPv4 explicitly, so the address the proxy sees is known.
      const a = adminApi(env, env.url.replace("localhost", "127.0.0.1"));
      for (let i = 0; i < 10; i++) {
        const res = await a.call("POST", "setup/code", { code: wrong(code) });
        expect(res.status).toBe(403);
        expect(res.body.error).toContain("expired");
      }
      expect((await a.call("POST", "setup/code", { code })).status).toBe(429);
      // The guesses counted against the client's address, not against everyone.
      expect(env.sessions.checkSetupCode(code, "127.0.0.1")).toBe("throttled");
      expect(env.sessions.checkSetupCode(code, "192.0.2.1")).toBe("ok");
    });
  });
});

describe("signing in at the chosen Home Assistant", () => {
  let env: TestEnv;
  let a: ReturnType<typeof adminApi>;
  beforeAll(async () => {
    env = await startTestEnv({ configured: false });
    const code = env.sessions.newSetupCode();
    a = adminApi(env);
    expect((await a.call("POST", "setup/code", { code })).status).toBe(200);
  });
  afterAll(() => env.stop());

  test("an address that redirects elsewhere is refused", async () => {
    // A look-alike that forwards to the real HA must not pass the check and then serve its own login page.
    const lookalike = Bun.serve({ port: 0, fetch: (req) => Response.redirect(`${env.ha.url}${new URL(req.url).pathname}`, 302) });
    try {
      const res = await a.call("POST", "setup/connect", { url: `http://localhost:${lookalike.port}` });
      expect(res.status).toBe(400);
      expect(res.body.authorize_url).toBeUndefined();
    } finally {
      lookalike.stop(true);
    }
  });

  test("the sign-in goes to exactly the probed, normalised origin", async () => {
    const start = await a.call("POST", "setup/connect", { url: `  ${env.ha.url}/lovelace/0?edit=1  ` });
    expect(start.status).toBe(200);
    const authorize = new URL(start.body.authorize_url);
    expect(authorize.origin).toBe(env.ha.url);
    expect(authorize.pathname).toBe("/auth/authorize");
    // The code is redeemed at the same origin, and that is the HA the proxy then uses.
    const done = await a.completeOAuth(env.ha, start.body.authorize_url);
    expect(done.headers.get("location")).toBe("/admin/");
    expect(env.runtime.haSettings?.url).toBe(env.ha.url);
  });
});

describe("connecting a different Home Assistant", () => {
  let env: TestEnv;
  let a: ReturnType<typeof adminApi>;
  const others: MockHA[] = [];
  const otherHa = () => {
    const ha = startMockHA();
    others.push(ha);
    return ha;
  };
  let warnings: ReturnType<typeof captureWarnings> | undefined;

  beforeAll(async () => {
    env = await startTestEnv({ configured: false });
    const code = env.sessions.newSetupCode();
    a = adminApi(env);
    expect((await a.call("POST", "setup/code", { code })).status).toBe(200);
    await a.connect(env.ha);
  });
  afterEach(() => warnings?.restore());
  afterAll(() => {
    env.stop();
    for (const ha of others) ha.stop();
  });

  test("the old proxy token is revoked in the previous Home Assistant", async () => {
    const old = env.runtime.haSettings!;
    expect(old.url).toBe(env.ha.url);
    const second = otherHa();
    warnings = captureWarnings();
    await a.connect(second);

    expect(env.runtime.haSettings?.url).toBe(second.url);
    expect(env.runtime.state).toBe("connected");
    expect(second.users.filter((u) => u.name === "Guest Assistant")).toHaveLength(1);

    // The previous HA no longer accepts the proxy's long-lived token...
    expect(env.ha.revoked).toContain(old.token);
    await expect(HaClient.with({ url: env.ha.url, token: old.token }, async () => "connected")).rejects.toThrow("authentication failed");
    // ...but only one of its admins can delete the old user, so the log says so.
    expect(env.ha.users.some((u) => u.id === old.user_id)).toBe(true);
    expect(warnings.lines.join("\n")).toContain(`Revoked the proxy's token in the previous Home Assistant ${env.ha.url}`);
    expect(warnings.lines.join("\n")).toContain(old.user_id!);
  });

  test("an unreachable previous Home Assistant does not block the switch", async () => {
    const gone = env.runtime.haSettings!;
    others.find((ha) => ha.url === gone.url)!.stop();
    const third = otherHa();
    warnings = captureWarnings();
    await a.connect(third);

    expect(env.runtime.haSettings?.url).toBe(third.url);
    const log = warnings.lines.join("\n");
    expect(log).toContain(`Could not revoke the proxy's token in the previous Home Assistant ${gone.url}`);
    expect(log).toContain(`deletes the user "Guest Assistant" (id ${gone.user_id})`);
  });

  test("revoking gives up after a short timeout", async () => {
    // Accepts the WebSocket but never says a word, like a host that hangs.
    const silent = Bun.serve({ port: 0, fetch: (req, server) => (server.upgrade(req) ? undefined : new Response(null, { status: 400 })), websocket: { message() {} } });
    try {
      const started = Date.now();
      await expect(provision.revokeProxyToken({ url: `http://localhost:${silent.port}`, token: "x" }, 200)).rejects.toThrow("no answer");
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      silent.stop(true);
    }
  });
});

describe("connecting a different Home Assistant with a token the proxy did not mint", () => {
  test("the token is left alone", async () => {
    const env = await startTestEnv();
    const second = startMockHA();
    const warnings = captureWarnings();
    try {
      const a = adminApi(env);
      a.jar.set("ga_admin", env.sessions.create("admin", "Tester").id);
      await a.connect(second);
      expect(env.runtime.haSettings?.url).toBe(second.url);
      expect(env.ha.revoked).not.toContain(MOCK_TOKEN);
      expect(warnings.lines.join("\n")).toContain("was not created by Guest Assistant");
    } finally {
      warnings.restore();
      env.stop();
      second.stop();
    }
  });
});
