import { createAuth, type Auth } from "../src/auth";
import type { Config } from "../src/config";
import { Dashboard } from "../src/dashboard";
import { HaClient } from "../src/ha/client";
import { migrate } from "../src/initialize/migrate";
import { syncUsers } from "../src/initialize/sync-users";
import { createServer } from "../src/server";
import { startMockHA, type MockHA } from "./mock-ha";

export interface TestEnv {
  ha: MockHA;
  client: HaClient;
  auth: Auth;
  config: Config;
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

export async function startTestEnv(): Promise<TestEnv> {
  const ha = startMockHA();
  const client = new HaClient(ha.haConfig);
  await client.connect();

  const dashboards = new Map<string, Dashboard>();
  for (const id of ["guest-dash", "bad-dash", "strategy-dash"]) {
    const d = new Dashboard(id);
    await d.load(client);
    dashboards.set(id, d);
  }

  const port = 30000 + Math.floor(Math.random() * 20000);
  const config: Config = {
    "home-assistant": ha.haConfig,
    base_url: `http://localhost:${port}`,
    port,
    dashboards: [],
    frontend_development_repo: "./test/fixtures/public",
  };

  const auth = createAuth(config, ":memory:");
  await migrate(auth);
  await syncUsers(auth, USERS);

  const { server } = createServer({ config, dashboards, auth });
  const url = `http://localhost:${server.port}`;

  return {
    ha,
    client,
    auth,
    config,
    dashboards,
    url,
    wsUrl: `ws://localhost:${server.port}/api/websocket`,
    stop() {
      server.stop(true);
      client.close();
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
