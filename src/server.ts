import type { BunRequest, Server } from "bun";
import { resolve, sep } from "node:path";
import { createAdmin } from "./admin/routes";
import type { AdminSessions } from "./admin/sessions";
import { createGuard } from "./auth/guard";
import { createHassTokenHandler } from "./auth/hass-token";
import { createHttpRoutes } from "./proxy/http";
import { createWsProxy, type ConnState } from "./proxy/ws";
import type { Runtime } from "./runtime";

const RESERVED_PREFIXES = ["/api/", "/static/", "/local/", "/hacsfiles/", "/admin/"];

/** Standalone, the admin page lives here on the guest port. */
export const ADMIN_BASE = "/admin/";

/**
 * better-auth's rate limiter needs a client IP header. We set it ourselves from
 * the TCP peer so clients cannot spoof it. Behind a reverse proxy this is the
 * proxy's address, i.e. one shared bucket; the limits are sized for that.
 */
export const CLIENT_IP_HEADER = "x-guest-assistant-client-ip";

function withClientIp(req: Request, server: Server<ConnState>): Request {
  const headers = new Headers(req.headers);
  headers.delete(CLIENT_IP_HEADER);
  const ip = server.requestIP(req)?.address;
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  return new Request(req, { headers });
}

/** The server guests connect to. Standalone, it also serves the admin page under /admin/. */
export function createServer(runtime: Runtime, sessions: AdminSessions, port: number = runtime.env.port) {
  const requireGuest = createGuard(runtime);
  const endpoint = () => runtime.endpoint;
  const wsProxy = createWsProxy(endpoint, runtime.dashboards);
  const httpRoutes = createHttpRoutes(endpoint, requireGuest);
  const hassToken = createHassTokenHandler(runtime);
  const admin = runtime.mode === "standalone" ? createAdmin(runtime, sessions, { base: ADMIN_BASE }) : null;

  // A dashboard that turns invalid drops its guests immediately; a changed
  // allowlist makes them reconnect. Account changes end live connections.
  runtime.on("dashboardChanged", (d) => wsProxy.dashboardChanged(d));
  runtime.on("dashboardRemoved", (id) => wsProxy.closeForDashboard(id));
  runtime.on("guestChanged", (id) => {
    requireGuest.invalidate();
    wsProxy.closeForUser(id);
  });
  runtime.on("connectionChanged", () => wsProxy.closeAll());

  // Like HA core's `development_repo`: point at the frontend repository root,
  // the build output inside it is served.
  const frontendRoot = runtime.env.frontendRepo ? resolve(runtime.env.frontendRepo, "guest-assistant/dist") : resolve("./public");

  /** Resolves a request path inside the frontend build, or null if outside/missing. */
  async function frontendFile(pathname: string) {
    let target: string;
    try {
      target = resolve(frontendRoot, `.${decodeURIComponent(pathname)}`);
    } catch {
      return null;
    }
    if (target !== frontendRoot && !target.startsWith(frontendRoot + sep)) return null;
    const file = Bun.file(target);
    return (await file.exists()) ? file : null;
  }

  // The frontend build ships its own /static (translations, icons, fonts,
  // locale data, map assets). Serve those first and fall back to HA for
  // anything else under /static.
  const haStatic = httpRoutes["/static/*"].GET;
  const staticHandler = async (req: BunRequest) => {
    const file = await frontendFile(new URL(req.url).pathname);
    return file ? new Response(file) : haStatic(req);
  };

  async function serveFrontend(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (RESERVED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return new Response("Not Found", { status: 404 });
    }

    const file = await frontendFile(url.pathname);
    if (file) return new Response(file);

    if (request.headers.get("accept")?.includes("text/html")) {
      const index = Bun.file(resolve(frontendRoot, "index.html"));
      if (await index.exists()) {
        return new Response(index, { headers: { "Content-Type": "text/html" } });
      }
    }
    return new Response("Not Found", { status: 404 });
  }

  const adminHandler = (req: BunRequest, server: Server<ConnState>) =>
    admin ? admin(req, server as Server<unknown>) : new Response("Not Found", { status: 404 });

  const server = Bun.serve({
    port,
    routes: {
      "/api/auth/hass-token": { GET: hassToken },
      "/api/auth/*": (req: BunRequest, server: Server<ConnState>) => runtime.auth.handler(withClientIp(req, server)),
      // Lets the frontend tell "proxy unreachable" from "proxy cannot reach
      // HA" while it reconnects. Public like HA's own /manifest.json; it only
      // reveals whether the upstream connection is up.
      "/api/guest-assistant/status": {
        GET: () =>
          Response.json(
            { home_assistant: runtime.client?.connected ? "connected" : "disconnected" },
            { headers: { "cache-control": "no-store" } },
          ),
      },
      "/api/websocket": (req: BunRequest, server: Server<ConnState>) => wsProxy.upgrade(req, server),
      ...httpRoutes,
      "/static/*": { GET: staticHandler, HEAD: staticHandler },
      // Everything under /api that is not listed above is denied.
      "/api/*": new Response("Not Found", { status: 404 }),
      "/admin": adminHandler,
      "/admin/*": adminHandler,
    },
    websocket: wsProxy.handlers,
    fetch: serveFrontend,
  });

  return { server, wsProxy };
}

/** As an app, the admin page is served on the ingress port only. */
export function createIngressServer(runtime: Runtime, sessions: AdminSessions, port: number = runtime.env.ingressPort) {
  const admin = createAdmin(runtime, sessions, { base: "/" });
  return Bun.serve({ port, fetch: (req, server) => admin(req, server) });
}
