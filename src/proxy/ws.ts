import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Dashboard } from "../dashboard";
import { haWsUrl, type HaEndpoint } from "../ha/endpoint";
import { verifyJWT } from "../jwt";
import { commandSpec, DROP, evaluate, type CommandContext, type Obj, type TrackedCommand, type Verdict } from "./ws-commands";

type Phase = "awaiting_auth" | "connecting_ha" | "active" | "closed";

export interface ConnState {
  phase: Phase;
  userId: string | null;
  dashboard: Dashboard | null;
  haWs: WebSocket | null;
  /** commands sent upstream that await their result */
  pending: Map<number, TrackedCommand>;
  /** established event streams */
  subscriptions: Map<number, TrackedCommand>;
  /** highest message id accepted on this connection; ids must increase */
  lastId: number;
  /** warnings caused by this connection */
  log: LogLimiter;
}

type GuestSocket = ServerWebSocket<ConnState>;

const MAX_MESSAGE_BYTES = 64 * 1024;
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

  function register(ws: GuestSocket): void {
    const { userId, dashboard } = ws.data;
    all.add(ws);
    if (userId) (byUser.get(userId) ?? byUser.set(userId, new Set()).get(userId)!).add(ws);
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
        send(ws, { id, type: "result", success: true, result: verdict.result });
        for (const event of verdict.events ?? []) send(ws, { id, type: "event", event });
        return;
      case "forward": {
        const type = String(verdict.msg.type);
        if (type === "unsubscribe_events") {
          ws.data.subscriptions.delete(verdict.msg.subscription as number);
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
      dashboard: null,
      haWs: null,
      pending: new Map(),
      subscriptions: new Map(),
      lastId: 0,
      log: new LogLimiter(() => `user ${data.userId}`),
    };
    if (server.upgrade(req, { data })) return undefined;
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  function closeForUser(userId: string): void {
    for (const ws of [...(byUser.get(userId) ?? [])]) terminate(ws);
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

  return { handlers, upgrade, closeForUser, closeForDashboard, closeAll, dashboardChanged };
}
