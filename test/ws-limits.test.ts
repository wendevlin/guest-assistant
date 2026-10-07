import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { Dashboard } from "../src/dashboard";
import * as limits from "../src/proxy/ws";
import { COMMANDS, evaluate, type CommandContext, type CommandSpec } from "../src/proxy/ws-commands";
import { GuestWs, startTestEnv, type TestEnv } from "./helpers";
import { GUEST_DASHBOARD } from "./mock-ha";

type Msg = Record<string, unknown>;

let env: TestEnv;
let token: string;

/**
 * A hass-token for the guest. Signed in through the API, not the HTTP
 * handler: better-auth's sign-in rate limit is shared by every test file.
 */
async function hassToken(username: string, password: string): Promise<string> {
  const signIn = await env.runtime.auth.api.signInUsername({ body: { username, password }, asResponse: true });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return (await env.hassToken(cookie)).body.access_token as string;
}

beforeAll(async () => {
  env = await startTestEnv();
  token = await hassToken("guest", "guest-pass-123");
});

afterAll(() => env.stop());

// Tests freeze the clock, so rate limits only refill when a test moves it on.
afterEach(() => setSystemTime());

function freezeClock(): void {
  setSystemTime(new Date());
}

function advanceClock(ms: number): void {
  setSystemTime(new Date(Date.now() + ms));
}

/** A guest connection that numbers its own commands, so bursts go out without waiting for answers. */
class Guest {
  private nextId = 1;

  private constructor(readonly ws: GuestWs) {}

  static async connect(accessToken = token): Promise<Guest> {
    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(accessToken)).type).toBe("auth_ok");
    return new Guest(ws);
  }

  /**
   * Sends the commands back to back and returns their answers (result or
   * pong) in order; undefined where none came within the timeout.
   */
  async burst(msgs: Msg[], timeoutMs = 2000): Promise<(Msg | undefined)[]> {
    const first = this.nextId;
    for (const msg of msgs) this.ws.sendRaw({ ...msg, id: this.nextId++ });
    const answers = () => {
      const byId = new Map<unknown, Msg>();
      for (const m of this.ws.received) if (m.type !== "event" && !byId.has(m.id)) byId.set(m.id, m);
      return msgs.map((_, i) => byId.get(first + i));
    };
    // performance.now(): Date.now() stands still while a test freezes the clock.
    const started = performance.now();
    while (answers().includes(undefined) && performance.now() - started < timeoutMs) await Bun.sleep(5);
    return answers();
  }

  /** Whether some command got two answers, e.g. the proxy's refusal and HA's result. */
  answeredTwice(): boolean {
    const ids = this.ws.received.filter((m) => typeof m.id === "number" && m.type !== "event").map((m) => m.id);
    return new Set(ids).size !== ids.length;
  }

  close(): Promise<void> {
    this.ws.close();
    return this.ws.closed;
  }
}

function errorCode(answer: Msg | undefined): unknown {
  return (answer?.error as Msg | undefined)?.code;
}

/** Collects console.warn lines while `fn` runs instead of printing them. */
async function captureWarnings(fn: (lines: () => string[]) => Promise<void>): Promise<void> {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await fn(() => warn.mock.calls.map((call) => String(call[0])));
  } finally {
    warn.mockRestore();
  }
}

async function until(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = performance.now();
  while (!condition() && performance.now() - started < timeoutMs) await Bun.sleep(5);
}

// ── GA-20: log lines a guest causes ─────────────────────────────────────

describe("warnings a guest causes are rate limited", () => {
  test("only the first warnings of a minute are logged; the rest are summed up on close", async () => {
    freezeClock();
    await captureWarnings(async (lines) => {
      const guest = await Guest.connect();
      const answers = await guest.burst(Array.from({ length: 50 }, () => ({ type: "execute_script", sequence: [] })));
      expect(answers.every((a) => errorCode(a) === "unauthorized")).toBe(true);

      const rejected = lines().filter((l) => l.includes("rejected execute_script"));
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected.length).toBeLessThan(50);

      await guest.close();
      await until(() => lines().some((l) => l.includes("suppressed")));
      expect(lines().filter((l) => l.includes("suppressed"))).toEqual([
        expect.stringContaining(`suppressed ${50 - rejected.length} more warning(s) about user `),
      ]);
    });
  });

  test("a new minute logs again and first reports what was suppressed", async () => {
    freezeClock();
    await captureWarnings(async (lines) => {
      const guest = await Guest.connect();
      await guest.burst(Array.from({ length: 30 }, () => ({ type: "execute_script", sequence: [] })));
      const before = lines().length;
      expect(lines().some((l) => l.includes("suppressed"))).toBe(false);

      advanceClock(61_000);
      await guest.burst([{ type: "tag/list" }]);
      const after = lines().slice(before);
      expect(after).toEqual([expect.stringContaining("suppressed"), expect.stringContaining("rejected tag/list")]);
      await guest.close();
    });
  });

  test("a logged line stays one short line, whatever the guest sends", async () => {
    await captureWarnings(async (lines) => {
      const guest = await Guest.connect();
      await guest.burst([{ type: `fake\n[ws-proxy] forged line ${"x".repeat(10_000)}` }]);
      const line = lines().find((l) => l.includes("forged line"));
      expect(line).toBeDefined();
      expect(line).not.toContain("\n");
      expect(line!.length).toBeLessThan(400);
      await guest.close();
    });
  });
});

// ── GA-08: guest-chosen keys and throwing checks ────────────────────────

describe("guest-chosen keys never reach Object.prototype", () => {
  const dashboard = new Dashboard("guest-dash");
  dashboard.applyConfig(GUEST_DASHBOARD);
  const ctx: CommandContext = { dashboard, subscriptions: new Map() };
  const inherited = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

  test("command types inherited from Object.prototype are rejected", () => {
    for (const type of inherited) expect(evaluate({ id: 1, type }, ctx)).toMatchObject({ kind: "reject" });
  });

  test("call_service with an inherited domain is rejected instead of throwing", () => {
    for (const domain of inherited) {
      const msg = { id: 1, type: "call_service", domain, service: "toggle", target: { entity_id: "light.kitchen" } };
      expect(evaluate(msg, ctx)).toMatchObject({ kind: "reject" });
    }
  });

  test("over the WebSocket both are refused by the proxy and nothing reaches HA", async () => {
    const guest = await Guest.connect();
    const calls = env.ha.serviceCalls.length;
    const [type, domain, ping] = await guest.burst([
      { type: "constructor" },
      { type: "call_service", domain: "constructor", service: "toggle", target: { entity_id: "light.kitchen" } },
      { type: "ping" },
    ]);
    // HA would have answered an unknown command with "unknown_command".
    expect(type?.error).toEqual({ code: "unauthorized", message: "Operation not permitted" });
    expect(domain?.error).toEqual({ code: "unauthorized", message: "Operation not permitted" });
    expect(ping?.type).toBe("pong");
    expect(env.ha.serviceCalls.length).toBe(calls);
    await guest.close();
  });
});

describe("a check or filter that throws", () => {
  /** Replaces a part of a command's spec for the duration of `fn`. */
  async function patched<K extends keyof CommandSpec>(type: string, key: K, value: CommandSpec[K], fn: () => Promise<void>): Promise<void> {
    const spec = COMMANDS[type]!;
    const original = spec[key];
    spec[key] = value;
    try {
      await fn();
    } finally {
      spec[key] = original;
    }
  }
  const boom = () => {
    throw new Error("boom");
  };

  test("a check that throws answers the guest with an error and keeps the connection", async () => {
    await captureWarnings(async (lines) => {
      await patched("get_config", "validate", boom, async () => {
        const guest = await Guest.connect();
        const [failed, ping] = await guest.burst([{ type: "get_config" }, { type: "ping" }]);
        expect(failed).toMatchObject({ type: "result", success: false, error: { code: "unknown_error", message: "Unknown error" } });
        expect(ping?.type).toBe("pong");
        expect(lines()).toContainEqual(expect.stringContaining("error checking get_config"));
        await guest.close();
      });
    });
  });

  test("a filter that throws drops HA's answer instead of passing it on unfiltered", async () => {
    await captureWarnings(async () => {
      await patched("get_states", "filterResult", boom, async () => {
        await patched("subscribe_entities", "filterEvent", boom, async () => {
          const guest = await Guest.connect();
          const [states, subscribed, ping] = await guest.burst([{ type: "get_states" }, { type: "subscribe_entities" }, { type: "ping" }]);
          expect(states).toMatchObject({ type: "result", success: false, error: { code: "unknown_error" } });
          expect(subscribed).toMatchObject({ type: "result", success: true });
          expect(ping?.type).toBe("pong");
          await Bun.sleep(50);
          // mock HA sends every state, and an event right after subscribe_entities
          expect(JSON.stringify(guest.ws.received)).not.toContain("light.bedroom");
          expect(guest.ws.received.filter((m) => m.type === "event")).toEqual([]);
          await guest.close();
        });
      });
    });
  });
});

// ── GA-07: resource limits ──────────────────────────────────────────────

describe("resource limits per guest connection", () => {
  const SUBSCRIBE = { type: "subscribe_events", event_type: "state_changed" };
  const PING = { type: "ping" };
  const TOGGLE = { type: "call_service", domain: "light", service: "toggle", target: { entity_id: "light.kitchen" } };
  const times = (n: number, msg: Msg): Msg[] => Array.from({ length: n }, () => msg);

  test("a connect burst like the frontend's passes; a flood beyond it is refused, not forwarded", async () => {
    freezeClock();
    await captureWarnings(async () => {
      const guest = await Guest.connect();
      // After connecting the frontend sends 30-60 commands, then a large
      // dashboard subscribes 100+ times (conditions, templates, history).
      const startup = await guest.burst([...times(60, { type: "get_config" }), ...times(150, SUBSCRIBE)]);
      expect(startup.every((a) => a?.success === true)).toBe(true);

      const flood = await guest.burst(times(limits.SEND_BURST, PING));
      const passed = limits.SEND_BURST - startup.length;
      expect(flood.slice(0, passed).every((a) => a?.type === "pong")).toBe(true);
      expect(flood.slice(passed).every((a) => errorCode(a) === "rate_limited")).toBe(true);
      expect(flood.at(-1)?.error).toEqual({ code: "rate_limited", message: "Too many requests, try again in a moment" });

      // Answered by the proxy itself, and unsubscribing: neither is limited.
      const [user, unsubscribed] = await guest.burst([{ type: "auth/current_user" }, { type: "unsubscribe_events", subscription: startup[60]!.id }]);
      expect(user?.success).toBe(true);
      expect(unsubscribed?.success).toBe(true);

      // The bucket refills over time.
      advanceClock(1000);
      const later = await guest.burst(times(limits.SEND_PER_SECOND + 1, PING));
      expect(later.map((a) => a?.type === "pong")).toEqual([...Array(limits.SEND_PER_SECOND).fill(true), false]);

      await Bun.sleep(50);
      expect(guest.answeredTwice()).toBe(false);
      await guest.close();
    });
  });

  test("service calls have a stricter limit of their own that leaves other commands alone", async () => {
    freezeClock();
    await captureWarnings(async () => {
      const guest = await Guest.connect();
      const calls = env.ha.serviceCalls.length;
      const answers = await guest.burst(times(100, TOGGLE));
      expect(answers.slice(0, limits.CALL_SERVICE_BURST).every((a) => a?.success === true)).toBe(true);
      expect(answers.slice(limits.CALL_SERVICE_BURST).every((a) => errorCode(a) === "rate_limited")).toBe(true);
      expect(env.ha.serviceCalls.length - calls).toBe(limits.CALL_SERVICE_BURST);

      // Refused calls took nothing from what the rest of the dashboard needs.
      const others = await guest.burst(times(limits.SEND_BURST - limits.CALL_SERVICE_BURST, PING));
      expect(others.every((a) => a?.type === "pong")).toBe(true);

      advanceClock(1000);
      const later = await guest.burst(times(limits.CALL_SERVICE_PER_SECOND + 1, TOGGLE));
      expect(later.map((a) => a?.success)).toEqual([...Array(limits.CALL_SERVICE_PER_SECOND).fill(true), false]);
      expect(env.ha.serviceCalls.length - calls).toBe(limits.CALL_SERVICE_BURST + limits.CALL_SERVICE_PER_SECOND);
      await guest.close();
    });
  });

  test("subscriptions are capped, counting those HA has not confirmed yet", async () => {
    freezeClock();
    await captureWarnings(async () => {
      const guest = await Guest.connect();
      const accepted: number[] = [];
      // Up to 50 below the cap, in batches the rate limit lets through.
      for (let remaining = limits.MAX_SUBSCRIPTIONS - 50; remaining > 0; remaining -= 200) {
        const answers = await guest.burst(times(Math.min(remaining, 200), SUBSCRIBE));
        expect(answers.every((a) => a?.success === true)).toBe(true);
        accepted.push(...answers.map((a) => a!.id as number));
        advanceClock(60_000);
      }
      // Sent at once: when the 51st is checked, the 50 before it are unconfirmed.
      const last = await guest.burst(times(100, SUBSCRIBE));
      expect(last.slice(0, 50).every((a) => a?.success === true)).toBe(true);
      expect(last.slice(50).every((a) => errorCode(a) === "too_many_subscriptions")).toBe(true);

      // Unsubscribing frees a slot; subscriptions the proxy answers itself hold none.
      const [unsubscribed, again, over, local] = await guest.burst([
        { type: "unsubscribe_events", subscription: accepted[0] },
        SUBSCRIBE,
        SUBSCRIBE,
        { type: "frontend/subscribe_user_data", key: "language" },
      ]);
      expect(unsubscribed?.success).toBe(true);
      expect(again?.success).toBe(true);
      expect(over?.error).toEqual({ code: "too_many_subscriptions", message: "Too many subscriptions" });
      expect(local?.success).toBe(true);
      expect(guest.answeredTwice()).toBe(false);
      await guest.close();
    });
  });

  test("commands waiting for HA are capped; unsubscribing still goes through", async () => {
    freezeClock();
    await captureWarnings(async () => {
      const guest = await Guest.connect();
      const [subscribed] = await guest.burst([SUBSCRIBE]);
      const icons = { type: "frontend/get_icons", category: "entity_component" };
      env.ha.unanswered.add(icons.type);
      try {
        for (let remaining = limits.MAX_PENDING; remaining > 0; remaining -= 200) {
          // Forwarded: HA keeps them waiting, so there is no answer.
          const answers = await guest.burst(times(Math.min(remaining, 200), icons), 100);
          expect(answers.every((a) => a === undefined)).toBe(true);
          advanceClock(60_000);
        }
        const [over, ping, unsubscribed] = await guest.burst([icons, PING, { type: "unsubscribe_events", subscription: subscribed!.id }]);
        expect(over?.error).toEqual({ code: "too_many_pending", message: "Too many commands waiting for Home Assistant" });
        expect(errorCode(ping)).toBe("too_many_pending");
        expect(unsubscribed?.success).toBe(true);
      } finally {
        env.ha.unanswered.delete(icons.type);
      }
      await guest.close();
    });
  });

  test("a guest account keeps its newest connections; the oldest one is closed", async () => {
    const username = "many_tabs";
    const password = "many-tabs-pass-1";
    await env.runtime.createGuest({ username, password, dashboard: "guest-dash" });
    const own = await hassToken(username, password);

    await captureWarnings(async (lines) => {
      const guests: Guest[] = [];
      for (let i = 0; i < limits.MAX_CONNECTIONS_PER_USER; i++) guests.push(await Guest.connect(own));
      let oldestClosed = false;
      void guests[0]!.ws.closed.then(() => (oldestClosed = true));

      guests.push(await Guest.connect(own));
      await until(() => oldestClosed);
      expect(oldestClosed).toBe(true);
      for (const guest of guests.slice(1)) expect((await guest.burst([PING]))[0]?.type).toBe("pong");
      expect(lines()).toContainEqual(expect.stringContaining(`more than ${limits.MAX_CONNECTIONS_PER_USER} connections; closing the oldest`));
      await Promise.all(guests.slice(1).map((guest) => guest.close()));
    });
  });
});

// ── GA-25: error texts from HA ──────────────────────────────────────────

describe("condition subscriptions pass on the outcome only", () => {
  // A template condition the admin wrote may read any entity. HA quotes its
  // value in errors, e.g. when `| int` gets a state that is not a number.
  const SECRET = "ValueError: Template error: int got invalid input 'code-1234' when rendering template \"{{ states('sensor.door_code') | int > 0 }}\"";
  const filter = (event: unknown) => {
    const dashboard = new Dashboard("guest-dash");
    dashboard.applyConfig(GUEST_DASHBOARD);
    return COMMANDS["subscribe_condition"]!.filterEvent!(event, { dashboard, subscriptions: new Map() }, {});
  };

  test("the result passes, template errors next to it do not", () => {
    expect(filter({ result: true })).toEqual({ result: true });
    expect(filter({ result: false, template_errors: [SECRET] })).toEqual({ result: false });
  });

  test("an error becomes a generic one, so the frontend still hides the card", () => {
    expect(filter({ error: `In 'template' condition: ${SECRET}`, template_errors: [SECRET] })).toEqual({ error: "Condition could not be evaluated" });
    expect(filter({ error: { code: "x", message: SECRET } })).toEqual({ error: "Condition could not be evaluated" });
  });
});
