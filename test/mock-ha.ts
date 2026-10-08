/**
 * Minimal Home Assistant stand-in for tests: speaks the WS auth handshake,
 * answers the commands the proxy relies on and records service calls.
 */
import type { ServerWebSocket } from "bun";
import type { HaEndpoint } from "../src/ha/endpoint";

type Obj = Record<string, unknown>;

/** Long-lived token of the pre-existing non-admin proxy user. */
export const MOCK_TOKEN = "valid-token";
/** Access token of an HA administrator (what OAuth hands out for "admin"). */
export const ADMIN_TOKEN = "admin-token";
/** Access token of a regular HA user. */
export const USER_TOKEN = "user-token";

interface MockUser {
  id: string;
  name: string;
  username: string | null;
  password?: string;
  is_owner: boolean;
  is_admin: boolean;
  system_generated: boolean;
  local_only: boolean;
  group_ids: string[];
}

export const STATES = [
  { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" }, last_changed: "", last_updated: "", context: {} },
  { entity_id: "light.bedroom", state: "off", attributes: { friendly_name: "Bedroom" }, last_changed: "", last_updated: "", context: {} },
  { entity_id: "lock.front", state: "locked", attributes: { friendly_name: "Front door" }, last_changed: "", last_updated: "", context: {} },
  { entity_id: "camera.garden", state: "idle", attributes: {}, last_changed: "", last_updated: "", context: {} },
  { entity_id: "camera.bedroom", state: "idle", attributes: {}, last_changed: "", last_updated: "", context: {} },
  { entity_id: "person.owner", state: "home", attributes: { latitude: 1, longitude: 2 }, last_changed: "", last_updated: "", context: {} },
  { entity_id: "media_player.living", state: "idle", attributes: { supported_features: 524288 | 1 }, last_changed: "", last_updated: "", context: {} },
  { entity_id: "media_player.kitchen", state: "idle", attributes: { supported_features: 524288 }, last_changed: "", last_updated: "", context: {} },
  // PAUSE | BROWSE_MEDIA
  { entity_id: "media_player.tv", state: "off", attributes: { supported_features: 1 | 131072 }, last_changed: "", last_updated: "", context: {} },
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

/** get_services as HA answers it: every script and every legacy notify target is a service of its own. */
export const SERVICES = {
  light: { turn_on: {}, turn_off: {}, toggle: {} },
  lock: { lock: {}, unlock: {}, open: {} },
  camera: { turn_on: {}, snapshot: {}, record: {}, play_stream: {} },
  notify: { send_message: {}, mobile_app_owners_phone: {} },
  script: { turn_on: {}, turn_off: {}, toggle: {}, reload: {}, wake_up: {}, disarm_and_unlock_front_door: {} },
  homeassistant: { turn_on: {}, turn_off: {}, toggle: {}, restart: {}, reload_all: {} },
};

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

/** Links and a groupable media player: raises questions for the admin. */
export const LINKS_DASHBOARD: Obj = {
  views: [
    {
      path: "main",
      cards: [
        { type: "tile", entity: "light.kitchen", tap_action: { action: "navigate", navigation_path: "/links-dash/sub" } },
        { type: "button", entity: "light.kitchen", tap_action: { action: "url", url_path: "https://example.com/wifi" } },
        { type: "button", entity: "light.kitchen", hold_action: { action: "navigate", navigation_path: "/config/dashboard" } },
        { type: "media-control", entity: "media_player.living" },
        { type: "media-control", entity: "media_player.kitchen" },
        { type: "media-control", entity: "media_player.tv" },
      ],
    },
    { path: "sub", subview: true, cards: [{ type: "tile", entity: "light.bedroom" }] },
  ],
};

export interface MockHA {
  port: number;
  url: string;
  /** Endpoint of the pre-existing non-admin proxy user. */
  endpoint: HaEndpoint;
  users: MockUser[];
  /** Simulates the HA login page: returns an authorization code for this token's user. */
  issueCode(clientId: string, userToken: string): string;
  revoked: string[];
  /** recorded call_service commands (WS) */
  serviceCalls: Obj[];
  /** recorded REST service calls */
  restServiceCalls: Array<{ path: string; body: string }>;
  /** requests to the public static paths, with the authorization header they carried */
  publicRequests: Array<{ path: string; authorization: string | null }>;
  dashboards: Map<string, Obj>;
  /** push an event to every subscription of that event type */
  emitEvent(eventType: string, data: Obj): void;
  /** command types left unanswered, e.g. to keep them pending in the proxy */
  unanswered: Set<string>;
  stop(): void;
}

interface SockData {
  authed: boolean;
  user: MockUser | null;
  /** the token this connection authenticated with */
  token?: string;
  eventSubs: Map<number, string>;
  /** set by supported_features { coalesce_messages: 1 }: wrap replies in arrays */
  coalesce: boolean;
}

export function startMockHA(port = 0): MockHA {
  const serviceCalls: Obj[] = [];
  const restServiceCalls: Array<{ path: string; body: string }> = [];
  const publicRequests: Array<{ path: string; authorization: string | null }> = [];
  const dashboards = new Map<string, Obj>([
    ["guest-dash", GUEST_DASHBOARD],
    ["bad-dash", AUTO_ENTITIES_DASHBOARD],
    ["strategy-dash", STRATEGY_DASHBOARD],
    ["links-dash", LINKS_DASHBOARD],
  ]);
  const sockets = new Set<ServerWebSocket<SockData>>();
  const revoked: string[] = [];
  const unanswered = new Set<string>();

  const users: MockUser[] = [
    { id: "owner", name: "Owner", username: "owner", is_owner: true, is_admin: true, system_generated: false, local_only: false, group_ids: ["system-admin"] },
    { id: "proxy", name: "guest-proxy", username: "guest-proxy", is_owner: false, is_admin: false, system_generated: false, local_only: false, group_ids: ["system-users"] },
    { id: "alice", name: "Alice", username: "alice", is_owner: false, is_admin: false, system_generated: false, local_only: false, group_ids: ["system-users"] },
  ];
  /** token → user id */
  const tokens = new Map<string, string>([
    [MOCK_TOKEN, "proxy"],
    [ADMIN_TOKEN, "owner"],
    [USER_TOKEN, "alice"],
  ]);
  /** long-lived token → client_name */
  const llatNames = new Map<string, string>();
  /** authorization code → { user, client_id } */
  const codes = new Map<string, { userId: string; clientId: string }>();
  const flows = new Map<string, { clientId: string; redirectUri: string }>();
  let counter = 0;
  const userFor = (token: unknown) => users.find((u) => u.id === tokens.get(String(token))) ?? null;
  const mint = (prefix: string, userId: string) => {
    const token = `${prefix}-${++counter}`;
    tokens.set(token, userId);
    return token;
  };
  const userInfo = (u: MockUser) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    is_owner: u.is_owner,
    is_active: true,
    local_only: u.local_only,
    system_generated: u.system_generated,
    group_ids: u.group_ids,
    credentials: u.username ? [{ type: "homeassistant" }] : [],
  });

  async function authRoute(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/auth/providers") {
      return Response.json({ providers: [{ name: "Home Assistant Local", id: null, type: "homeassistant" }], preselect_remember_me: false });
    }
    if (url.pathname === "/auth/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const entry = codes.get(form.get("code") ?? "");
      if (form.get("grant_type") !== "authorization_code" || !entry || entry.clientId !== form.get("client_id")) {
        return Response.json({ error: "invalid_request", error_description: "Invalid code" }, { status: 400 });
      }
      codes.delete(form.get("code")!);
      return Response.json({
        access_token: mint("access", entry.userId),
        refresh_token: mint("refresh", entry.userId),
        expires_in: 1800,
        token_type: "Bearer",
      });
    }
    if (url.pathname === "/auth/revoke" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const token = form.get("token");
      if (token) {
        revoked.push(token);
        tokens.delete(token);
      }
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/auth/login_flow" && req.method === "POST") {
      const body = (await req.json()) as { client_id: string; redirect_uri: string; handler: unknown[] };
      if (new URL(body.client_id).host !== new URL(body.redirect_uri).host) return Response.json({ message: "Invalid redirect URI" }, { status: 400 });
      const flowId = `flow-${++counter}`;
      flows.set(flowId, { clientId: body.client_id, redirectUri: body.redirect_uri });
      return Response.json({ type: "form", flow_id: flowId, step_id: "init", data_schema: [], errors: {} });
    }
    const flowStep = url.pathname.match(/^\/auth\/login_flow\/(.+)$/);
    if (flowStep && req.method === "POST") {
      const flow = flows.get(flowStep[1]!);
      const body = (await req.json()) as { client_id: string; username: string; password: string };
      if (!flow || flow.clientId !== body.client_id) return Response.json({ message: "Invalid flow" }, { status: 400 });
      const user = users.find((u) => u.username === body.username && u.password === body.password);
      if (!user) return Response.json({ type: "form", flow_id: flowStep[1], errors: { base: "invalid_auth" } });
      flows.delete(flowStep[1]!);
      const code = `code-${++counter}`;
      codes.set(code, { userId: user.id, clientId: body.client_id });
      return Response.json({ type: "create_entry", result: code });
    }
    return null;
  }

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
        if (server.upgrade(req, { data: { authed: false, user: null, eventSubs: new Map(), coalesce: false } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname.startsWith("/auth/")) {
        return authRoute(req, url).then((r) => r ?? new Response("mock: not found", { status: 404 }));
      }
      // Served without login, like HA's static paths.
      if (["/static/", "/local/", "/hacsfiles/"].some((p) => url.pathname.startsWith(p))) {
        publicRequests.push({ path: url.pathname, authorization: req.headers.get("authorization") });
        return new Response("static-asset");
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
      if (url.pathname.startsWith("/api/map_tiles/")) return new Response(`tile ${url.pathname}${url.search}`);
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
          const user = msg.type === "auth" ? userFor(msg.access_token) : null;
          if (user) {
            ws.data.authed = true;
            ws.data.user = user;
            ws.data.token = String(msg.access_token);
            deliver(ws, JSON.stringify({ type: "auth_ok", ha_version: "2026.9.0" }));
          } else {
            deliver(ws, JSON.stringify({ type: "auth_invalid", message: "bad token" }));
            ws.close();
          }
          return;
        }
        if (unanswered.has(String(msg.type))) return;
        const id = msg.id;
        const me = ws.data.user!;
        const adminOnly = new Set(["config/auth/list", "config/auth/create", "config/auth/delete", "config/auth_provider/homeassistant/create"]);
        if (adminOnly.has(String(msg.type)) && !me.is_admin) {
          deliver(ws, error(id, "unauthorized"));
          return;
        }
        switch (msg.type) {
          case "config/auth/list":
            deliver(ws, result(id, users.map(userInfo)));
            return;
          case "config/auth/create": {
            const user: MockUser = {
              id: `user-${++counter}`,
              name: String(msg.name),
              username: null,
              is_owner: false,
              is_admin: ((msg.group_ids as string[] | undefined) ?? []).includes("system-admin"),
              system_generated: false,
              local_only: msg.local_only === true,
              group_ids: (msg.group_ids as string[] | undefined) ?? [],
            };
            users.push(user);
            deliver(ws, result(id, { user: userInfo(user) }));
            return;
          }
          case "config/auth_provider/homeassistant/create": {
            const user = users.find((u) => u.id === msg.user_id);
            if (!user) { deliver(ws, error(id, "not_found")); return; }
            if (users.some((u) => u.username === msg.username)) { deliver(ws, error(id, "username_exists")); return; }
            user.username = String(msg.username);
            user.password = String(msg.password);
            deliver(ws, result(id, null));
            return;
          }
          case "config/auth/delete": {
            const index = users.findIndex((u) => u.id === msg.user_id);
            if (index >= 0) users.splice(index, 1);
            for (const [token, userId] of tokens) if (userId === msg.user_id) tokens.delete(token);
            deliver(ws, result(id, null));
            return;
          }
          case "auth/long_lived_access_token": {
            const token = mint("llat", me.id);
            llatNames.set(token, String(msg.client_name));
            deliver(ws, result(id, token));
            return;
          }
          // The mock uses the token itself as refresh token id.
          case "auth/refresh_tokens":
            deliver(
              ws,
              result(
                id,
                [...tokens].filter(([, userId]) => userId === me.id).map(([token]) => ({
                  id: token,
                  client_name: llatNames.get(token) ?? null,
                  type: llatNames.has(token) ? "long_lived_access_token" : "normal",
                  is_current: token === ws.data.token,
                })),
              ),
            );
            return;
          case "auth/delete_refresh_token": {
            const token = String(msg.refresh_token_id);
            if (tokens.get(token) !== me.id) { deliver(ws, error(id, "invalid_token_id")); return; }
            tokens.delete(token);
            revoked.push(token);
            // Like HA, connections that used the token are closed, this one before it is answered.
            for (const s of sockets) if (s.data.token === token) s.close();
            if (ws.data.token !== token) deliver(ws, result(id, {}));
            return;
          }
          case "frontend/get_themes":
            deliver(ws, result(id, { themes: { nord: {}, midnight: {} }, default_theme: "default", default_dark_theme: null }));
            return;
          case "supported_features":
            ws.data.coalesce = (msg.features as Obj | undefined)?.coalesce_messages === 1;
            deliver(ws, result(id, null));
            return;
          case "ping":
            deliver(ws, JSON.stringify({ id, type: "pong" }));
            return;
          case "auth/current_user":
            deliver(ws, result(id, { id: me.id, name: me.name, is_admin: me.is_admin, is_owner: me.is_owner }));
            return;
          case "lovelace/dashboards/list":
            deliver(
              ws,
              result(
                id,
                [...dashboards.keys()].filter((k) => k !== "lovelace").map((url_path) => ({ id: url_path, url_path, title: `Title ${url_path}`, mode: "storage", require_admin: false })),
              ),
            );
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
            deliver(ws, result(id, SERVICES));
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

  const url = `http://localhost:${server.port}`;
  return {
    port: server.port!,
    url,
    endpoint: { url, token: MOCK_TOKEN },
    users,
    revoked,
    issueCode(clientId, userToken) {
      const userId = tokens.get(userToken);
      if (!userId) throw new Error("unknown token");
      const code = `code-${++counter}`;
      codes.set(code, { userId, clientId });
      return code;
    },
    serviceCalls,
    restServiceCalls,
    publicRequests,
    dashboards,
    unanswered,
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
