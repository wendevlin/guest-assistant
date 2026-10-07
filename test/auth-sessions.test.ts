import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestEnv, type TestEnv } from "./helpers";

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
