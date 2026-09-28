import { AdminSessions } from "../src/admin/sessions";
import type { Dashboard } from "../src/dashboard";
import type { Env } from "../src/env";
import { Runtime, type Mode } from "../src/runtime";
import { createServer } from "../src/server";
import { Store } from "../src/store";
import { startMockHA, type MockHA } from "./mock-ha";

export interface TestEnv {
  ha: MockHA;
  runtime: Runtime;
  sessions: AdminSessions;
  dashboards: Map<string, Dashboard>;
  url: string;
  wsUrl: string;
  stop(): void;
  /** Logs in and returns the session cookie header value. */
  login(username: string, password: string): Promise<string>;
  /** Fetches a hass-token JWT for the given cookie. */
  hassToken(cookie: string): Promise<{ status: number; body: Record<string, unknown> }>;
}

export const USERS = [
  { username: "guest", password: "guest-pass-123", dashboard: "guest-dash" },
  { username: "badguest", password: "bad-pass-123", dashboard: "bad-dash" },
];

export function testEnvConfig(port: number): Env {
  return {
    port,
    dataDir: ":memory:",
    frontendRepo: "./test/fixtures/frontend-repo",
    ingressPort: port + 1,
    legacyConfigPath: "/nonexistent/config.yaml",
    adminUiDir: "./test/fixtures/admin-ui",
  };
}

export function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

/**
 * Starts mock HA and the proxy. With `configured` (default) the proxy is
 * already connected with the mock's non-admin token and has the test
 * dashboards and guests; otherwise it starts like a fresh installation.
 */
export async function startTestEnv({ configured = true, mode = "standalone" as Mode, adminUiDir = "" } = {}): Promise<TestEnv> {
  const ha = startMockHA();
  const port = randomPort();
  const store = Store.memory();
  const env = testEnvConfig(port);
  const runtime = new Runtime(adminUiDir ? { ...env, adminUiDir } : env, store, mode);
  await runtime.init();

  if (configured) {
    store.set("ha", { url: ha.url, token: ha.endpoint.token });
    store.saveDashboard({ id: "guest-dash", theme: { name: "nord", mode: "dark", guest_can_change_mode: true }, answers: {} });
    store.saveDashboard({ id: "bad-dash", theme: {}, answers: {} });
    store.saveDashboard({ id: "strategy-dash", theme: {}, answers: {} });
    for (const u of USERS) await runtime.guests.create(u);
    await runtime.connect();
  }

  const sessions = new AdminSessions();
  const { server } = createServer(runtime, sessions, port);
  const url = `http://localhost:${server.port}`;

  return {
    ha,
    runtime,
    sessions,
    dashboards: runtime.dashboards,
    url,
    wsUrl: `ws://localhost:${server.port}/api/websocket`,
    stop() {
      server.stop(true);
      runtime.close();
      ha.stop();
    },
    async login(username, password) {
      const res = await fetch(`${url}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: url },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
      const cookies = res.headers.getSetCookie();
      return cookies.map((c) => c.split(";")[0]).join("; ");
    },
    async hassToken(cookie) {
      const res = await fetch(`${url}/api/auth/hass-token`, { headers: { cookie } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
  };
}

/** Small promise-based WS client speaking the HA protocol against the proxy. */
export class GuestWs {
  private ws: WebSocket;
  private nextId = 1;
  private waiters = new Map<number, (msg: Record<string, unknown>) => void>();
  private eventBuffers = new Map<number, Record<string, unknown>[]>();
  readonly received: Record<string, unknown>[] = [];
  private opened: Promise<Record<string, unknown>>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve) => {
      const first = (ev: MessageEvent) => {
        this.ws.removeEventListener("message", first);
        resolve(JSON.parse(String(ev.data)));
      };
      this.ws.addEventListener("message", first);
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      this.received.push(msg);
      if (typeof msg.id === "number") {
        if (msg.type === "event") {
          (this.eventBuffers.get(msg.id) ?? this.eventBuffers.set(msg.id, []).get(msg.id)!).push(msg);
        } else {
          this.waiters.get(msg.id)?.(msg);
        }
      }
    });
  }

  /** Performs the auth handshake; resolves with auth_ok/auth_invalid. */
  async auth(token: string): Promise<Record<string, unknown>> {
    const first = await this.opened;
    if (first.type !== "auth_required") throw new Error(`unexpected ${String(first.type)}`);
    return new Promise((resolve) => {
      const handler = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "auth_ok" || msg.type === "auth_invalid") {
          this.ws.removeEventListener("message", handler);
          resolve(msg);
        }
      };
      this.ws.addEventListener("message", handler);
      this.ws.send(JSON.stringify({ type: "auth", access_token: token }));
    });
  }

  send(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.ws.send(JSON.stringify({ id, ...msg }));
    });
  }

  async events(id: number, expected = 1, timeoutMs = 1000): Promise<Record<string, unknown>[]> {
    const start = Date.now();
    while ((this.eventBuffers.get(id)?.length ?? 0) < expected) {
      if (Date.now() - start > timeoutMs) break;
      await Bun.sleep(10);
    }
    return this.eventBuffers.get(id) ?? [];
  }

  get closed(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => this.ws.addEventListener("close", () => resolve()));
  }

  close(): void {
    this.ws.close();
  }
}
