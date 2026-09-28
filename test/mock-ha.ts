/**
 * Minimal Home Assistant stand-in for tests: speaks the WS auth handshake,
 * answers the commands the proxy relies on and records service calls.
 */
import type { ServerWebSocket } from "bun";
import type { HAConfig } from "../src/config";

type Obj = Record<string, unknown>;

export const MOCK_TOKEN = "valid-token";

export const STATES = [
  { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" }, last_changed: "", last_updated: "", context: {} },
  { entity_id: "light.bedroom", state: "off", attributes: { friendly_name: "Bedroom" }, last_changed: "", last_updated: "", context: {} },
  { entity_id: "lock.front", state: "locked", attributes: { friendly_name: "Front door" }, last_changed: "", last_updated: "", context: {} },
  { entity_id: "camera.garden", state: "idle", attributes: {}, last_changed: "", last_updated: "", context: {} },
  { entity_id: "camera.bedroom", state: "idle", attributes: {}, last_changed: "", last_updated: "", context: {} },
  { entity_id: "person.owner", state: "home", attributes: { latitude: 1, longitude: 2 }, last_changed: "", last_updated: "", context: {} },
];

export const REGISTRY = [
  { ei: "light.kitchen", di: "dev-kitchen" },
  { ei: "light.bedroom", di: "dev-bedroom" },
  { ei: "lock.front", di: "dev-lock" },
  { ei: "camera.garden", di: "dev-cam" },
  { ei: "camera.bedroom", di: "dev-cam2" },
  { ei: "person.owner" },
];

export const DEVICES = ["dev-kitchen", "dev-bedroom", "dev-lock", "dev-cam", "dev-cam2"].map((id) => ({
  id,
  name: id,
  connections: [["mac", "aa:bb"]],
  identifiers: [["zha", id]],
  configuration_url: "http://device.local",
}));

export const GUEST_DASHBOARD: Obj = {
  title: "Guest",
  views: [
    {
      title: "Home",
      cards: [
        { type: "tile", entity: "light.kitchen", features: [{ type: "light-brightness" }] },
        { type: "entities", entities: ["lock.front", { entity: "camera.garden", name: "Garden" }] },
        { type: "markdown", content: "Kitchen is {{ states('light.kitchen') }}" },
        {
          type: "conditional",
          conditions: [{ condition: "state", entity: "light.kitchen", state: "on" }],
          card: { type: "button", tap_action: { action: "perform-action", perform_action: "light.turn_off", target: { entity_id: "light.kitchen" } } },
        },
      ],
    },
  ],
};

export const AUTO_ENTITIES_DASHBOARD: Obj = {
  views: [{ cards: [{ type: "custom:auto-entities", filter: { include: [{ domain: "light" }] } }] }],
};

export const STRATEGY_DASHBOARD: Obj = { strategy: { type: "original-states" } };

export interface MockHA {
  port: number;
  haConfig: HAConfig;
  /** recorded call_service commands (WS) */
  serviceCalls: Obj[];
  /** recorded REST service calls */
  restServiceCalls: Array<{ path: string; body: string }>;
  dashboards: Map<string, Obj>;
  /** push an event to every subscription of that event type */
  emitEvent(eventType: string, data: Obj): void;
  stop(): void;
}

interface SockData {
  authed: boolean;
  eventSubs: Map<number, string>;
  /** set by supported_features { coalesce_messages: 1 }: wrap replies in arrays */
  coalesce: boolean;
}

export function startMockHA(port = 0): MockHA {
  const serviceCalls: Obj[] = [];
  const restServiceCalls: Array<{ path: string; body: string }> = [];
  const dashboards = new Map<string, Obj>([
    ["guest-dash", GUEST_DASHBOARD],
    ["bad-dash", AUTO_ENTITIES_DASHBOARD],
    ["strategy-dash", STRATEGY_DASHBOARD],
  ]);
  const sockets = new Set<ServerWebSocket<SockData>>();

  // Like HA, batch replies into one array frame once coalescing is on.
  const deliver = (ws: ServerWebSocket<SockData>, data: string) => ws.send(ws.data.coalesce ? `[${data}]` : data);

  const result = (id: unknown, result: unknown) => JSON.stringify({ id, type: "result", success: true, result });
  const error = (id: unknown, code: string) => JSON.stringify({ id, type: "result", success: false, error: { code, message: code } });
  const event = (id: unknown, event: unknown) => JSON.stringify({ id, type: "event", event });

  const server = Bun.serve<SockData>({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/api/websocket") {
        if (server.upgrade(req, { data: { authed: false, eventSubs: new Map(), coalesce: false } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (req.headers.get("authorization") !== `Bearer ${MOCK_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.pathname === "/api/states") return Response.json(STATES);
      if (url.pathname.startsWith("/api/states/")) {
        const state = STATES.find((s) => s.entity_id === url.pathname.slice("/api/states/".length));
        return state ? Response.json(state) : new Response("Not Found", { status: 404 });
      }
      if (url.pathname.startsWith("/api/services/")) {
        return req.text().then((body) => {
          restServiceCalls.push({ path: url.pathname, body });
          return Response.json([]);
        });
      }
      if (url.pathname.startsWith("/api/history/period")) {
        const ids = (url.searchParams.get("filter_entity_id") ?? "").split(",").filter(Boolean);
        const all = ids.length ? STATES.filter((s) => ids.includes(s.entity_id)) : STATES;
        return Response.json(all.map((s) => [s]));
      }
      if (url.pathname.startsWith("/api/logbook")) {
        return Response.json(
          STATES.map((s) => ({ entity_id: s.entity_id, when: "now", context_entity_id: "person.owner", context_user_id: "u1" })),
        );
      }
      if (url.pathname.startsWith("/api/camera_proxy/")) return new Response("IMG", { headers: { "content-type": "image/jpeg" } });
      if (url.pathname.startsWith("/static/")) return new Response("static-asset");
      return new Response("mock: not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        deliver(ws, JSON.stringify({ type: "auth_required", ha_version: "2026.9.0" }));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as Obj;
        if (!ws.data.authed) {
          if (msg.type === "auth" && msg.access_token === MOCK_TOKEN) {
            ws.data.authed = true;
            deliver(ws, JSON.stringify({ type: "auth_ok", ha_version: "2026.9.0" }));
          } else {
            deliver(ws, JSON.stringify({ type: "auth_invalid", message: "bad token" }));
            ws.close();
          }
          return;
        }
        const id = msg.id;
        switch (msg.type) {
          case "supported_features":
            ws.data.coalesce = (msg.features as Obj | undefined)?.coalesce_messages === 1;
            deliver(ws, result(id, null));
            return;
          case "ping":
            deliver(ws, JSON.stringify({ id, type: "pong" }));
            return;
          case "auth/current_user":
            deliver(ws, result(id, { id: "proxy", name: "guest-proxy", is_admin: false, is_owner: false }));
            return;
          case "lovelace/dashboards/list":
            deliver(ws, result(id, [...dashboards.keys()].map((url_path) => ({ id: url_path, url_path, title: url_path, mode: "storage" }))));
            return;
          case "lovelace/config": {
            const key = (msg.url_path as string | null) ?? "lovelace";
            const cfg = dashboards.get(key);
            deliver(ws, cfg ? result(id, cfg) : error(id, "config_not_found"));
            return;
          }
          case "config/entity_registry/list_for_display":
            deliver(ws, result(id, { entity_categories: { 0: "config" }, entities: REGISTRY }));
            return;
          case "config/device_registry/list":
            deliver(ws, result(id, DEVICES));
            return;
          case "get_states":
            deliver(ws, result(id, STATES));
            return;
          case "get_config":
            deliver(ws, result(id, { latitude: 48.2, longitude: 16.3, location_name: "Secret Base", components: ["light", "conversation"], external_url: "https://x" }));
            return;
          case "get_services":
            deliver(ws, result(id, { light: { turn_on: {} }, lock: { unlock: {} }, notify: { send: {} }, homeassistant: { restart: {} } }));
            return;
          case "get_panels":
            deliver(ws, result(id, { lovelace: { url_path: "lovelace" }, "guest-dash": { url_path: "guest-dash" }, "secret-dash": { url_path: "secret-dash" } }));
            return;
          case "call_service":
            serviceCalls.push(msg);
            deliver(ws, result(id, { context: { id: "ctx" } }));
            return;
          case "subscribe_events":
            ws.data.eventSubs.set(id as number, String(msg.event_type));
            deliver(ws, result(id, null));
            return;
          case "subscribe_entities": {
            deliver(ws, result(id, null));
            const ids = msg.entity_ids as string[] | undefined;
            const a: Obj = {};
            for (const s of STATES) if (!ids || ids.length === 0 || ids.includes(s.entity_id)) a[s.entity_id] = { s: s.state, a: s.attributes };
            deliver(ws, event(id, { a }));
            return;
          }
          case "render_template":
            deliver(ws, result(id, null));
            deliver(ws, event(id, { result: `rendered:${String(msg.template)}:${JSON.stringify(msg.variables)}`, listeners: {} }));
            return;
          case "history/history_during_period": {
            const out: Obj = {};
            for (const s of STATES) out[s.entity_id] = [{ s: s.state }];
            deliver(ws, result(id, out));
            return;
          }
          case "auth/sign_path":
            deliver(ws, result(id, { path: `${String(msg.path)}?authSig=signed` }));
            return;
          case "camera/stream":
            deliver(ws, result(id, { url: `/api/hls/token-${String(msg.entity_id)}/master_playlist.m3u8` }));
            return;
          case "unsubscribe_events":
            ws.data.eventSubs.delete(msg.subscription as number);
            deliver(ws, result(id, null));
            return;
          default:
            deliver(ws, error(id, "unknown_command"));
        }
      },
    },
  });

  return {
    port: server.port!,
    haConfig: { host: "localhost", port: server.port!, tls: false, long_lived_access_token: MOCK_TOKEN },
    serviceCalls,
    restServiceCalls,
    dashboards,
    emitEvent(eventType, data) {
      for (const ws of sockets) {
        for (const [id, type] of ws.data.eventSubs) {
          if (type === eventType) deliver(ws, event(id, { event_type: eventType, data, origin: "LOCAL", time_fired: "", context: {} }));
        }
      }
    },
    stop() {
      server.stop(true);
    },
  };
}
