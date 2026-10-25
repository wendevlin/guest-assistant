import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Guest } from "../src/guests";
import { GuestWs, startTestEnv, type TestEnv } from "./helpers";

let env: TestEnv;
let guest: Guest;

beforeAll(async () => {
  env = await startTestEnv();
  guest = await env.runtime.createGuest({ username: "sitter", password: "sitter-pass-1", dashboard: "guest-dash" });
});

afterAll(() => env.stop());

async function signInWithLink(token: string): Promise<{ status: number; cookie: string }> {
  const res = await fetch(`${env.url}/api/auth/sign-in/link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.url },
    body: JSON.stringify({ token }),
  });
  return { status: res.status, cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

/**
 * Signed in through the API, not the handler: better-auth's sign-in rate
 * limit is shared by every test in this process.
 */
async function signIn(): Promise<string> {
  const res = await env.runtime.auth.api.signInUsername({ body: { username: "sitter", password: "sitter-pass-1" }, asResponse: true });
  return res.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
}

function closedWithin(ws: GuestWs, ms: number): Promise<boolean> {
  return Promise.race([ws.closed.then(() => true), Bun.sleep(ms).then(() => false)]);
}

describe("login link", () => {
  test("signs in any number of times until it is replaced or removed", async () => {
    const first = (await env.runtime.createLoginLink(guest.id)).loginLink!;
    const a = await signInWithLink(first);
    const b = await signInWithLink(first);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await env.hassToken(a.cookie)).status).toBe(200);
    expect((await env.hassToken(b.cookie)).status).toBe(200);
    // The token is not part of the session data the guest page gets.
    const session = (await (await fetch(`${env.url}/api/auth/get-session`, { headers: { cookie: a.cookie } })).json()) as { user: { name: string } };
    expect(session.user.name).toBe("sitter");
    expect(JSON.stringify(session)).not.toContain(first);

    const second = (await env.runtime.createLoginLink(guest.id)).loginLink!;
    expect(second).not.toBe(first);
    expect((await signInWithLink(first)).status).toBe(401);
    // Sessions signed in with the old link stay.
    expect((await env.hassToken(a.cookie)).status).toBe(200);

    await env.runtime.removeLoginLink(guest.id);
    expect((await signInWithLink(second)).status).toBe(401);
  });

  test("signs nobody in while the guest is off, and works again once it is back on", async () => {
    const token = (await env.runtime.createLoginLink(guest.id)).loginLink!;
    await env.runtime.updateGuest(guest.id, { enabled: false });
    expect((await signInWithLink(token)).status).toBe(403);

    await env.runtime.updateGuest(guest.id, { enabled: true });
    const { status, cookie } = await signInWithLink(token);
    expect(status).toBe(200);
    expect((await env.hassToken(cookie)).status).toBe(200);
  });
});

describe("auto disable", () => {
  test("switches the guest off at the set time and ends its connections", async () => {
    // Any change to the guest ends its connections, so connect afterwards.
    const updated = await env.runtime.updateGuest(guest.id, { disableAt: new Date(Date.now() + 500) });
    expect(updated.disableAt).not.toBeNull();
    const cookie = await signIn();
    const token = (await env.hassToken(cookie)).body.access_token as string;
    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(token)).type).toBe("auth_ok");
    expect(await closedWithin(ws, 2000)).toBe(true);

    const after = (await env.runtime.guests.get(guest.id))!;
    expect(after.enabled).toBe(false);
    // Cleared, so switching the guest back on does not switch it off again.
    expect(after.disableAt).toBeNull();
    expect((await env.hassToken(cookie)).status).toBe(401);

    await env.runtime.updateGuest(guest.id, { enabled: true });
    expect((await env.runtime.guests.get(guest.id))!.enabled).toBe(true);
  });

  test("a guest past its time is denied before the timer switches it off", async () => {
    const cookie = await signIn();
    expect((await env.hassToken(cookie)).status).toBe(200);
    // Bypasses the runtime, which only accepts future times, and its timer.
    await env.runtime.guests.update(guest.id, { disableAt: new Date(Date.now() - 1000) });
    expect((await env.hassToken(cookie)).status).toBe(403);
    expect((await env.runtime.guests.get(guest.id))!.enabled).toBe(false);

    // Switching it back on drops the time that ran out.
    await env.runtime.updateGuest(guest.id, { enabled: true });
    const back = (await env.runtime.guests.get(guest.id))!;
    expect(back).toMatchObject({ enabled: true, disableAt: null });
  });

  test("a guest that is already off only loses its time", async () => {
    const off = await env.runtime.createGuest({
      username: "later",
      password: "later-pass-1",
      dashboard: "guest-dash",
      enabled: false,
      disableAt: new Date(Date.now() + 200),
    });
    await Bun.sleep(400);
    expect((await env.runtime.guests.get(off.id))!).toMatchObject({ enabled: false, disableAt: null });
  });

  test("refuses a time in the past", async () => {
    expect(env.runtime.updateGuest(guest.id, { disableAt: new Date(Date.now() - 1000) })).rejects.toThrow("must be in the future");
  });
});
