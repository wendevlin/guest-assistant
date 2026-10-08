import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Dashboard } from "../dashboard";
import { haWsUrl, type HaEndpoint } from "../ha/endpoint";
import { verifyJWT } from "../jwt";
import { commandSpec, DROP, evaluate, type CommandContext, type Obj, type TrackedCommand, type Verdict } from "./ws-commands";

type Phase = "awaiting_auth" | "connecting_ha" | "active" | "closed";

export interface ConnState {
  phase: Phase;
  userId: string | null;
  /** better-auth session the token was issued for; its sign-out closes the connection */
  sessionId: string | null;
  dashboard: Dashboard | null;
  haWs: WebSocket | null;
  /** commands sent upstream that await their result */
  pending: Map<number, TrackedCommand>;
  /** established event streams */
  subscriptions: Map<number, TrackedCommand>;
  /** highest message id accepted on this connection; ids must increase */
  lastId: number;
  /** commands sent to HA */
  sendBucket: TokenBucket;
  /** call_service commands, which take from sendBucket as well */
  callServiceBucket: TokenBucket;
  /** warnings caused by this connection */
  log: LogLimiter;
}

type GuestSocket = ServerWebSocket<ConnState>;

const MAX_MESSAGE_BYTES = 64 * 1024;

// Each guest socket opens its own socket to HA, so these limits bound the
// work one guest can cause in HA and the memory the proxy holds for them.
/** Live subscriptions per connection: a large dashboard holds 100+ (visibility conditions, markdown cards, history). */
export const MAX_SUBSCRIPTIONS = 500;
/** Commands per connection waiting for HA's answer: above SEND_BURST, so only a slow or stalled HA reaches it. */
export const MAX_PENDING = 500;
/** Commands sent to HA at once: the frontend's 30-60 after connecting plus a large dashboard's subscriptions. */
export const SEND_BURST = 300;
/** Commands sent to HA per second after the burst: opening a view or a more-info dialog takes a few dozen. */
export const SEND_PER_SECOND = 20;
/** Service calls at once: repeated taps and slider moves. */
export const CALL_SERVICE_BURST = 30;
/** Service calls per second after the burst: more than a person taps, and each can become a radio command. */
export const CALL_SERVICE_PER_SECOND = 3;
/** Connections per guest account (devices, tabs); beyond it the oldest is closed and its page reconnects. */
export const MAX_CONNECTIONS_PER_USER = 10;
/** Warnings per connection and minute; a guest's flood shows up as one summary line instead. */
const LOG_LINES_PER_MINUTE = 10;
/** Logged lines quote guest input, which may be up to MAX_MESSAGE_BYTES long. */
const MAX_LOG_LINE = 300;

/**
 * Logs the first LOG_LINES_PER_MINUTE warnings of a minute. The rest are only
 * counted and reported in one line when the minute ends or on flush(), so a
 * guest cannot flood the log and real attempts do not drown in it.
 */
class LogLimiter {
  private windowStart = 0;
  private lines = 0;
  private suppressed = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly about: () => string) {}

  warn(line: string): void {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.flush();
      this.windowStart = now;
      this.lines = 0;
    }
    if (this.lines < LOG_LINES_PER_MINUTE) {
      this.lines++;
      // One line per warning, also when guest input contains line breaks.
      const clean = line.replace(/[\u0000-\u001f\u007f]/g, " ");
      console.warn(clean.length > MAX_LOG_LINE ? `${clean.slice(0, MAX_LOG_LINE)}…` : clean);
      return;
    }
    this.suppressed++;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.windowStart + 60_000 - now);
      this.timer.unref();
    }
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.suppressed === 0) return;
    console.warn(`[ws-proxy] suppressed ${this.suppressed} more warning(s) about ${this.about()}`);
    this.suppressed = 0;
  }
}

/** Allows `burst` events at once and `perSecond` on average after that. */
class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
  ) {
    this.tokens = burst;
  }

  take(): boolean {
    const now = Date.now();
    // max(): the wall clock can step back.
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.last) * this.perSecond) / 1000);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

/** Subscriptions established plus those still waiting for HA's answer. */
function subscriptionCount(conn: ConnState): number {
  let count = conn.subscriptions.size;
  for (const { type } of conn.pending.values()) if (commandSpec(type)?.subscription) count++;
  return count;
}

/** Why a command may not be sent to HA now, or null if it may. */
function overLimit(conn: ConnState, type: string): { code: string; message: string } | null {
  if (conn.pending.size >= MAX_PENDING) return { code: "too_many_pending", message: "Too many commands waiting for Home Assistant" };
  if (commandSpec(type)?.subscription && subscriptionCount(conn) >= MAX_SUBSCRIPTIONS) {
    return { code: "too_many_subscriptions", message: "Too many subscriptions" };
  }
  // The call_service bucket first: refused calls then do not use up the
  // tokens the rest of the dashboard needs.
  if (type === "call_service" && !conn.callServiceBucket.take()) return { code: "rate_limited", message: "Too many actions, try again in a moment" };
  if (!conn.sendBucket.take()) return { code: "rate_limited", message: "Too many requests, try again in a moment" };
  return null;
}

export function createWsProxy(endpoint: () => HaEndpoint | null, dashboards: ReadonlyMap<string, Dashboard>) {
  const all = new Set<GuestSocket>();
  const byUser = new Map<string, Set<GuestSocket>>();
  const byDashboard = new Map<string, Set<GuestSocket>>();

  function send(ws: GuestSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendError(ws: GuestSocket, id: unknown, message: string, code = "unauthorized"): void {
    send(ws, { id, type: "result", success: false, error: { code, message } });
  }

  /** Shared: every warning about a closed connection comes from a new one. */
  const connectionLog = new LogLimiter(() => "closed connections");

  function register(ws: GuestSocket): void {
    const { userId, dashboard } = ws.data;
    all.add(ws);
    if (userId) {
      const conns = byUser.get(userId) ?? byUser.set(userId, new Set()).get(userId)!;
      conns.add(ws);
      // Sets keep insertion order, so the first is the oldest. Closing it
      // rather than refusing the new one keeps a guest from locking themselves
      // out; a page still open on it reconnects on its own.
      const [oldest] = conns;
      if (conns.size > MAX_CONNECTIONS_PER_USER && oldest) {
        connectionLog.warn(`[ws-proxy] user ${userId} has more than ${MAX_CONNECTIONS_PER_USER} connections; closing the oldest`);
        terminate(oldest);
      }
    }
    if (dashboard) (byDashboard.get(dashboard.id) ?? byDashboard.set(dashboard.id, new Set()).get(dashboard.id)!).add(ws);
  }

  function unregister(ws: GuestSocket): void {
    const { userId, dashboard } = ws.data;
    all.delete(ws);
    if (userId) byUser.get(userId)?.delete(ws);
    if (dashboard) byDashboard.get(dashboard.id)?.delete(ws);
  }

  function terminate(ws: GuestSocket): void {
    ws.data.phase = "closed";
    ws.data.haWs?.close();
    ws.data.haWs = null;
    ws.data.log.flush();
    unregister(ws);
    ws.close();
  }

  // ── handshake ──────────────────────────────────────────────────────────

  function handleAuth(ws: GuestSocket, msg: Obj): void {
    const fail = (message: string) => {
      send(ws, { type: "auth_invalid", message });
      terminate(ws);
    };

    if (msg.type !== "auth" || typeof msg.access_token !== "string") return fail("Expected auth");
    const payload = verifyJWT(msg.access_token);
    if (!payload) return fail("Invalid token");
    const dashboard = dashboards.get(payload.dashboard);
    if (!dashboard) return fail("Invalid dashboard");
    if (!dashboard.usable) return fail("Dashboard not available");
    const ha = endpoint();
    if (!ha) return fail("Not connected to Home Assistant");
    const token = ha.token;

    ws.data.userId = payload.sub;
    ws.data.sessionId = payload.sid;
    ws.data.dashboard = dashboard;
    ws.data.phase = "connecting_ha";
    register(ws);

    const haWs = new WebSocket(haWsUrl(ha));
    ws.data.haWs = haWs;

    haWs.addEventListener("message", (event) => {
      if (ws.data.haWs !== haWs) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      // With `supported_features: { coalesce_messages: 1 }` HA batches several
      // messages into one array frame. Every element must pass the filters.
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      for (const haMsg of batch) {
        if (typeof haMsg === "object" && haMsg !== null && !Array.isArray(haMsg)) {
          handleUpstreamFrame(haMsg as Obj);
        }
      }
    });

    function handleUpstreamFrame(haMsg: Obj): void {
      switch (haMsg.type) {
        case "auth_required":
          haWs.send(JSON.stringify({ type: "auth", access_token: token }));
          return;
        case "auth_ok":
          ws.data.phase = "active";
          send(ws, { type: "auth_ok", ha_version: haMsg.ha_version });
          return;
        case "auth_invalid":
          console.error("[ws-proxy] upstream rejected the long-lived token");
          send(ws, { type: "auth_invalid", message: "Upstream auth failed" });
          terminate(ws);
          return;
        default:
          if (ws.data.phase === "active") handleUpstreamMessage(ws, haMsg);
      }
    }

    haWs.addEventListener("close", () => {
      if (ws.data.haWs === haWs) terminate(ws);
    });
    haWs.addEventListener("error", () => {
      if (ws.data.haWs === haWs) terminate(ws);
    });
  }

  // ── guest → HA ─────────────────────────────────────────────────────────

  function handleGuestMessage(ws: GuestSocket, msg: Obj): void {
    const { haWs, dashboard } = ws.data;
    if (!haWs || !dashboard) return;

    if (!dashboard.usable) {
      terminate(ws);
      return;
    }

    const id = msg.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      sendError(ws, id, "id required");
      return;
    }
    // Results and events are matched to the guest's command, and so to its
    // filter, by id. A reused id would let one command's answer pass through
    // another command's filter. Like HA, ids must increase; then a new id can
    // never collide with a pending command or a live subscription.
    if (id <= ws.data.lastId) {
      sendError(ws, id, "Identifier values have to increase.", "id_reuse");
      return;
    }
    ws.data.lastId = id;

    const ctx: CommandContext = { dashboard, subscriptions: ws.data.subscriptions };
    let verdict: Verdict;
    try {
      verdict = evaluate(msg, ctx);
    } catch (err) {
      // A bug in a check must still answer the guest: an exception escaping
      // this handler makes Bun drop the socket without a reply.
      ws.data.log.warn(`[ws-proxy] error checking ${String(msg.type)} from user ${ws.data.userId}: ${String(err)}`);
      sendError(ws, id, "Unknown error", "unknown_error");
      return;
    }

    switch (verdict.kind) {
      case "reject":
        ws.data.log.warn(`[ws-proxy] rejected ${String(msg.type)} from user ${ws.data.userId}: ${verdict.message}`);
        sendError(ws, id, "Operation not permitted");
        return;
      case "reply":
        // Answered by the proxy: costs HA nothing and keeps no state here, so
        // the limits below do not apply.
        send(ws, { id, type: "result", success: true, result: verdict.result });
        for (const event of verdict.events ?? []) send(ws, { id, type: "event", event });
        return;
      case "forward": {
        const type = String(verdict.msg.type);
        if (type === "unsubscribe_events") {
          // Never limited: it frees resources in HA, a refused one would leave
          // a stream running that the frontend has dropped, and each one ends
          // a subscription, so they add at most MAX_SUBSCRIPTIONS to pending.
          ws.data.subscriptions.delete(verdict.msg.subscription as number);
        } else {
          const limited = overLimit(ws.data, type);
          if (limited) {
            ws.data.log.warn(`[ws-proxy] refused ${type} from user ${ws.data.userId}: ${limited.code}`);
            sendError(ws, id, limited.message, limited.code);
            return;
          }
        }
        ws.data.pending.set(id, { type, msg: verdict.msg });
        haWs.send(JSON.stringify(verdict.msg));
        return;
      }
    }
  }

  // ── HA → guest ─────────────────────────────────────────────────────────

  function handleUpstreamMessage(ws: GuestSocket, msg: Obj): void {
    const dashboard = ws.data.dashboard!;
    const ctx: CommandContext = { dashboard, subscriptions: ws.data.subscriptions };
    const id = msg.id;

    if (typeof id !== "number") {
      // Every result/event carries the id of a guest command; anything else
      // is not something a guest asked for.
      return;
    }

    if (msg.type === "result") {
      const tracked = ws.data.pending.get(id);
      ws.data.pending.delete(id);
      if (!tracked) return; // never forward results we did not ask for
      const spec = commandSpec(tracked.type);
      let out = msg;
      if (msg.success && spec?.filterResult) {
        try {
          out = { ...msg, result: spec.filterResult(msg.result, ctx, tracked.msg) };
        } catch (err) {
          // Never pass HA's answer on unfiltered; an error lets the guest stop waiting.
          ws.data.log.warn(`[ws-proxy] error filtering ${tracked.type} for user ${ws.data.userId}: ${String(err)}`);
          sendError(ws, id, "Unknown error", "unknown_error");
          return;
        }
      }
      if (msg.success && spec?.subscription) ws.data.subscriptions.set(id, tracked);
      send(ws, out);
      return;
    }

    if (msg.type === "pong") {
      // `ping` is answered with a pong, not a result; without this its
      // pending entry would stay forever.
      if (ws.data.pending.delete(id)) send(ws, msg);
      return;
    }

    if (msg.type === "event") {
      const tracked = ws.data.subscriptions.get(id);
      if (!tracked) return;
      const spec = commandSpec(tracked.type);
      if (spec?.filterEvent) {
        let filtered: unknown;
        try {
          filtered = spec.filterEvent(msg.event, ctx, tracked.msg);
        } catch (err) {
          // Dropped: never passed on unfiltered.
          ws.data.log.warn(`[ws-proxy] error filtering ${tracked.type} for user ${ws.data.userId}: ${String(err)}`);
          return;
        }
        if (filtered === DROP) return;
        send(ws, { ...msg, event: filtered });
      } else {
        send(ws, msg);
      }
      return;
    }

    send(ws, msg);
  }

  // ── Bun.serve glue ─────────────────────────────────────────────────────

  const handlers: WebSocketHandler<ConnState> = {
    maxPayloadLength: MAX_MESSAGE_BYTES,
    idleTimeout: 120,

    open(ws) {
      send(ws, { type: "auth_required", ha_version: "2026.9" });
    },

    message(ws, message) {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return;

      switch (ws.data.phase) {
        case "awaiting_auth":
          handleAuth(ws, msg as Obj);
          return;
        case "active":
          handleGuestMessage(ws, msg as Obj);
          return;
        default:
          return; // connecting or closed: ignore
      }
    },

    close(ws) {
      ws.data.phase = "closed";
      ws.data.haWs?.close();
      ws.data.haWs = null;
      ws.data.log.flush();
      unregister(ws);
    },
  };

  function upgrade(req: Request, server: Server<ConnState>): Response | undefined {
    const data: ConnState = {
      phase: "awaiting_auth",
      userId: null,
      sessionId: null,
      dashboard: null,
      haWs: null,
      pending: new Map(),
      subscriptions: new Map(),
      lastId: 0,
      sendBucket: new TokenBucket(SEND_BURST, SEND_PER_SECOND),
      callServiceBucket: new TokenBucket(CALL_SERVICE_BURST, CALL_SERVICE_PER_SECOND),
      log: new LogLimiter(() => `user ${data.userId}`),
    };
    if (server.upgrade(req, { data })) return undefined;
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  function closeForUser(userId: string): void {
    for (const ws of [...(byUser.get(userId) ?? [])]) terminate(ws);
  }

  /** Closes the connections made with tokens of a session that was signed out. */
  function closeForSession(sessionId: string): void {
    for (const ws of [...all]) if (ws.data.sessionId === sessionId) terminate(ws);
  }

  function closeForDashboard(dashboardId: string): void {
    for (const ws of [...(byDashboard.get(dashboardId) ?? [])]) terminate(ws);
  }

  /**
   * Called after a dashboard was re-analysed. If what guests may access
   * changed, their connections are closed: the frontend reconnects,
   * resubscribes with the new allowlist and reloads the dashboard config.
   * Otherwise they get the lovelace_updated event that was held back.
   */
  function dashboardChanged(dashboard: Dashboard): void {
    if (!dashboard.usable || dashboard.accessChanged) {
      closeForDashboard(dashboard.id);
      return;
    }
    const event = {
      event_type: "lovelace_updated",
      data: { url_path: dashboard.urlPath, mode: "storage" },
      origin: "LOCAL",
      time_fired: new Date().toISOString(),
      context: { id: crypto.randomUUID().replaceAll("-", ""), parent_id: null, user_id: null },
    };
    for (const ws of byDashboard.get(dashboard.id) ?? []) {
      for (const [id, sub] of ws.data.subscriptions) {
        if (sub.type === "subscribe_events" && sub.msg.event_type === "lovelace_updated") {
          send(ws, { id, type: "event", event });
        }
      }
    }
  }

  /** Drops every guest connection, e.g. when the HA connection changed. */
  function closeAll(): void {
    for (const ws of [...all]) terminate(ws);
  }

  return { handlers, upgrade, closeForUser, closeForSession, closeForDashboard, closeAll, dashboardChanged };
}
