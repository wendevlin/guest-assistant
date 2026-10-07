import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AdminSessions } from "../src/admin/sessions";
import { startTestEnv, type TestEnv } from "./helpers";
import { ADMIN_TOKEN, type MockHA } from "./mock-ha";

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
