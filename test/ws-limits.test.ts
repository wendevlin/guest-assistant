import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { Dashboard } from "../src/dashboard";
import { COMMANDS, evaluate, type CommandContext, type CommandSpec } from "../src/proxy/ws-commands";
import { GuestWs, startTestEnv, type TestEnv } from "./helpers";
import { GUEST_DASHBOARD } from "./mock-ha";

type Msg = Record<string, unknown>;

let env: TestEnv;
let token: string;

beforeAll(async () => {
  env = await startTestEnv();
  const cookie = await env.login("guest", "guest-pass-123");
  token = (await env.hassToken(cookie)).body.access_token as string;
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

  static async connect(): Promise<Guest> {
    const ws = new GuestWs(env.wsUrl);
    expect((await ws.auth(token)).type).toBe("auth_ok");
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
