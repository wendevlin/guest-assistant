import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { haWsUrl, type Config } from "../config";
import type { Dashboard } from "../dashboard";
import { verifyJWT } from "../jwt";
import { COMMANDS, DROP, evaluate, type CommandContext, type Obj, type TrackedCommand } from "./ws-commands";

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
}

type GuestSocket = ServerWebSocket<ConnState>;

const MAX_MESSAGE_BYTES = 64 * 1024;

export function createWsProxy(config: Config, dashboards: Map<string, Dashboard>) {
  const upstreamUrl = haWsUrl(config["home-assistant"]);
  const token = config["home-assistant"].long_lived_access_token;
  const byUser = new Map<string, Set<GuestSocket>>();
  const byDashboard = new Map<string, Set<GuestSocket>>();

  function send(ws: GuestSocket, msg: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendError(ws: GuestSocket, id: unknown, message: string): void {
    send(ws, { id, type: "result", success: false, error: { code: "unauthorized", message } });
  }

  function register(ws: GuestSocket): void {
    const { userId, dashboard } = ws.data;
    if (userId) (byUser.get(userId) ?? byUser.set(userId, new Set()).get(userId)!).add(ws);
    if (dashboard) (byDashboard.get(dashboard.id) ?? byDashboard.set(dashboard.id, new Set()).get(dashboard.id)!).add(ws);
  }

  function unregister(ws: GuestSocket): void {
    const { userId, dashboard } = ws.data;
    if (userId) byUser.get(userId)?.delete(ws);
    if (dashboard) byDashboard.get(dashboard.id)?.delete(ws);
  }

  function terminate(ws: GuestSocket): void {
    ws.data.phase = "closed";
    ws.data.haWs?.close();
    ws.data.haWs = null;
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
    if (dashboard.status !== "ok") return fail("Dashboard not available");

    ws.data.userId = payload.sub;
    ws.data.dashboard = dashboard;
    ws.data.phase = "connecting_ha";
    register(ws);

    const haWs = new WebSocket(upstreamUrl);
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

    if (dashboard.status !== "ok") {
      terminate(ws);
      return;
    }

    const id = msg.id;
    if (typeof id !== "number") {
      sendError(ws, id, "id required");
      return;
    }

    const ctx: CommandContext = { dashboard, subscriptions: ws.data.subscriptions };
    const verdict = evaluate(msg, ctx);

    switch (verdict.kind) {
      case "reject":
        console.warn(`[ws-proxy] rejected ${String(msg.type)} from user ${ws.data.userId}: ${verdict.message}`);
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
      const spec = COMMANDS[tracked.type];
      if (msg.success && spec?.subscription) ws.data.subscriptions.set(id, tracked);
      if (msg.success && spec?.filterResult) {
        send(ws, { ...msg, result: spec.filterResult(msg.result, ctx, tracked.msg) });
      } else {
        send(ws, msg);
      }
      return;
    }

    if (msg.type === "event") {
      const tracked = ws.data.subscriptions.get(id);
      if (!tracked) return;
      const spec = COMMANDS[tracked.type];
      if (spec?.filterEvent) {
        const filtered = spec.filterEvent(msg.event, ctx, tracked.msg);
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

  return { handlers, upgrade, closeForUser, closeForDashboard };
}

export type WsProxy = ReturnType<typeof createWsProxy>;
