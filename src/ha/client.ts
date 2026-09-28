import { haWsUrl, type HaEndpoint } from "./endpoint";

interface WSMessage {
  type: string;
  id?: number;
  success?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  event?: Record<string, unknown>;
  ha_version?: string;
  message?: string;
}

export class HaCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type EventHandler = (event: Record<string, unknown>) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Subscription {
  eventType: string;
  handler: EventHandler;
}

const COMMAND_TIMEOUT_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * Persistent, reconnecting connection to Home Assistant used by the proxy
 * itself (dashboard loading, registry lookups, lovelace_updated).
 *
 * Guest connections do NOT use this client; each guest gets its own upstream
 * socket in proxy/ws.ts so HA can apply per-connection subscription state.
 */
export class HaClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscriptions = new Map<number, Subscription>();
  private reconnectDelay = RECONNECT_MIN_MS;
  private closed = false;
  private reconnectListeners: Array<() => void> = [];
  private connectPromise: Promise<void> | null = null;
  private authenticated = false;
  haVersion: string | undefined;

  constructor(private readonly ha: HaEndpoint) {}

  /** Connects, runs `fn` and closes again. Used for one-off admin operations. */
  static async with<T>(endpoint: HaEndpoint, fn: (client: HaClient) => Promise<T>): Promise<T> {
    const client = new HaClient(endpoint);
    try {
      await client.connect();
      return await fn(client);
    } finally {
      client.close();
    }
  }

  /** Resolves once authenticated. Rejects only on the first connection attempt. */
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      this.open(resolve, reject);
    });
    return this.connectPromise;
  }

  /** True while the proxy's own connection to HA is authenticated. */
  get connected(): boolean {
    return this.authenticated;
  }

  /** Called after every successful (re)connect except the first. */
  onReconnect(listener: () => void): void {
    this.reconnectListeners.push(listener);
  }

  close(): void {
    this.closed = true;
    this.authenticated = false;
    this.ws?.close();
  }

  sendCommand(payload: Record<string, unknown>): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new HaCommandError("not_connected", "Not connected to Home Assistant"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HaCommandError("timeout", `Command ${String(payload.type)} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  /**
   * Subscribes to an event type. The subscription is re-established
   * automatically after a reconnect.
   */
  async subscribeEvents(eventType: string, handler: EventHandler): Promise<void> {
    const id = await this.subscribeRaw(eventType, handler);
    this.subscriptions.set(id, { eventType, handler });
  }

  private subscribeRaw(eventType: string, handler: EventHandler): Promise<number> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new HaCommandError("not_connected", "Not connected to Home Assistant"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HaCommandError("timeout", "subscribe_events timed out"));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: () => {
          this.subscriptions.set(id, { eventType, handler });
          resolve(id);
        },
        reject,
        timer,
      });
      ws.send(JSON.stringify({ id, type: "subscribe_events", event_type: eventType }));
    });
  }

  private open(onFirstOk?: () => void, onFirstFail?: (err: Error) => void): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(haWsUrl(this.ha));
    } catch (err) {
      onFirstFail?.(new HaCommandError("connect_failed", `Invalid Home Assistant URL ${this.ha.url}: ${String(err)}`));
      return;
    }
    this.ws = ws;
    let authenticated = false;
    const isFirst = onFirstOk !== undefined;

    ws.addEventListener("message", (event) => {
      let msg: WSMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: this.ha.token }));
        return;
      }
      if (msg.type === "auth_ok") {
        authenticated = true;
        this.authenticated = true;
        this.haVersion = msg.ha_version;
        this.reconnectDelay = RECONNECT_MIN_MS;
        console.log(`Connected to Home Assistant ${msg.ha_version ?? ""}`.trim());
        if (isFirst) {
          onFirstOk?.();
        } else {
          void this.resubscribe().then(() => {
            for (const l of this.reconnectListeners) l();
          });
        }
        return;
      }
      if (msg.type === "auth_invalid") {
        const err = new HaCommandError("auth_invalid", `Home Assistant authentication failed: ${msg.message ?? ""}`);
        if (isFirst) {
          this.closed = true;
          onFirstFail?.(err);
        } else {
          console.error(err.message);
        }
        ws.close();
        return;
      }

      if (msg.id === undefined) return;

      if (msg.type === "result") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new HaCommandError(msg.error?.code ?? "unknown", msg.error?.message ?? "Command failed"));
        return;
      }

      if (msg.type === "event") {
        const sub = this.subscriptions.get(msg.id);
        if (sub && msg.event) sub.handler(msg.event);
      }
    });

    const onGone = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authenticated = false;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new HaCommandError("disconnected", "Connection to Home Assistant lost"));
      }
      this.pending.clear();
      if (isFirst && !authenticated) {
        onFirstFail?.(
          new HaCommandError("connect_failed", `Failed to connect to Home Assistant at ${this.ha.url}`),
        );
        return;
      }
      if (this.closed) return;
      console.warn(`Connection to Home Assistant lost, reconnecting in ${this.reconnectDelay / 1000}s`);
      setTimeout(() => this.open(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    };
    ws.addEventListener("close", onGone);
    ws.addEventListener("error", onGone);
  }

  private async resubscribe(): Promise<void> {
    const old = [...this.subscriptions.values()];
    this.subscriptions.clear();
    for (const sub of old) {
      try {
        await this.subscribeRaw(sub.eventType, sub.handler);
      } catch (err) {
        console.error(`Failed to re-subscribe to ${sub.eventType}:`, err);
      }
    }
  }
}
