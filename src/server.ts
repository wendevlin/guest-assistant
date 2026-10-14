import type { BunRequest, Server } from "bun";
import { resolve, sep } from "node:path";
import { createAdmin } from "./admin/routes";
import type { AdminSessions } from "./admin/sessions";
import { createGuard, withWidgetCheck } from "./auth/guard";
import { createAuthHandler } from "./auth/handler";
import { createHassTokenHandler } from "./auth/hass-token";
import { createMobileApp } from "./companion/mobile-app";
import { createCompanionAuth } from "./companion/oauth";
import { resolveGuestToken } from "./companion/tokens";
import { serveFrontendFile } from "./csp";
import { revokeSession, revokeTokens } from "./jwt";
import { createHttpRoutes } from "./proxy/http";
import { createWsProxy, type ConnState } from "./proxy/ws";
import { serveManifest, serveUnregisterWorker } from "./pwa";
import type { Runtime } from "./runtime";

// /auth/ is Home Assistant's OAuth (companion apps); never the guest page.
const RESERVED_PREFIXES = ["/api/", "/auth/", "/static/", "/local/", "/admin/"];

/** Standalone, the admin page lives here on the guest port. */
export const ADMIN_BASE = "/admin/";

/**
 * better-auth's rate limiter needs a client IP header. We set it ourselves from
 * the TCP peer so clients cannot spoof it. Behind a reverse proxy this is the
 * proxy's address, i.e. one shared bucket; the limits are sized for that.
 */
const CLIENT_IP_HEADER = "x-guest-assistant-client-ip";

function withClientIp(req: Request, server: Server<ConnState>): Request {
  const headers = new Headers(req.headers);
  headers.delete(CLIENT_IP_HEADER);
  const ip = server.requestIP(req)?.address;
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  return new Request(req, { headers });
}

/** The server guests connect to. Standalone, it also serves the admin page under /admin/. */
const MAX_BODY_BYTES = 1024 * 1024;

export function createServer(runtime: Runtime, sessions: AdminSessions, port: number = runtime.env.port) {
  const requireGuest = createGuard(runtime);
  const endpoint = () => runtime.endpoint;
  const wsProxy = createWsProxy(endpoint, runtime.dashboards, {
    resolveToken: (token) => resolveGuestToken(token, runtime.appTokens),
    haVersion: () => runtime.haVersion,
  });
  // Entity data reaches the companion app's native part only where widgets are allowed.
  const httpRoutes = createHttpRoutes(endpoint, withWidgetCheck(requireGuest));
  const hassToken = createHassTokenHandler(runtime);
  // A sign-out ends the tokens of that session and the connections made
  // with them; the guest's other devices stay signed in.
  const authHandler = createAuthHandler(runtime, (sessionId) => {
    revokeSession(sessionId);
    wsProxy.closeForSession(sessionId);
  });
  const admin = runtime.mode === "standalone" ? createAdmin(runtime, sessions, { base: ADMIN_BASE }) : null;

  // A dashboard that turns invalid drops its guests immediately; a changed
  // allowlist makes them reconnect. Account changes end live connections.
  runtime.on("dashboardChanged", (d) => wsProxy.dashboardChanged(d));
  runtime.on("dashboardRemoved", (id) => wsProxy.closeForDashboard(id));
  runtime.on("guestChanged", (id) => {
    revokeTokens(id);
    wsProxy.closeForUser(id);
  });
  runtime.on("connectionChanged", () => wsProxy.closeAll());
  runtime.on("appSessionsEnded", (ids) => {
    for (const id of ids) wsProxy.closeForSession(id);
  });
  runtime.on("widgetsChanged", (d) => wsProxy.closeNativeForDashboard(d.id));

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
    return file ? serveFrontendFile(file, req, { appName: runtime.appName }) : haStatic(req);
  };

  const manifestHandler = async () => serveManifest(await frontendFile("/manifest.json"), runtime.appName);

  // Companion app support (src/companion/); every route answers 404 while it is off.
  const companionAuth = createCompanionAuth(runtime, {
    async serveAuthorizePage(req) {
      const file = await frontendFile("/authorize.html");
      // A guest frontend from before companion app support has no such page.
      return file
        ? serveFrontendFile(file, req, { appName: runtime.appName })
        : new Response("The guest frontend does not support the companion app yet.", { status: 503 });
    },
  });
  const mobileApp = createMobileApp(runtime, requireGuest);
  const serviceWorkerHandler = async (req: BunRequest) => {
    const file = await frontendFile("/sw.js");
    return file ? serveFrontendFile(file, req) : serveUnregisterWorker();
  };

  async function serveFrontend(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (RESERVED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return new Response("Not Found", { status: 404 });
    }

    let file = await frontendFile(url.pathname);
    if (!file && request.headers.get("accept")?.includes("text/html")) file = await frontendFile("/index.html");
    return file ? serveFrontendFile(file, request, { appName: runtime.appName }) : new Response("Not Found", { status: 404 });
  }

  const adminHandler = (req: BunRequest, server: Server<ConnState>) =>
    admin ? admin(req, server as Server<unknown>) : new Response("Not Found", { status: 404 });

  const server = Bun.serve({
    port,
    // Request bodies are small JSON (sign-in, admin API).
    maxRequestBodySize: MAX_BODY_BYTES,
    routes: {
      "/api/auth/hass-token": { GET: hassToken },
      "/api/auth/*": (req: BunRequest, server: Server<ConnState>) => authHandler(withClientIp(req, server)),
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
      "/api/guest-assistant/session": { GET: mobileApp.session },
      "/api/guest-assistant/app-cookie": { POST: mobileApp.appCookie },
      "/api/mobile_app/registrations": { POST: mobileApp.register },
      "/api/webhook/:id": { POST: mobileApp.webhook },
      "/auth/authorize": { GET: companionAuth.authorize, HEAD: companionAuth.authorize },
      "/auth/login_flow": { POST: companionAuth.loginFlow },
      "/auth/token": { POST: companionAuth.token },
      "/auth/revoke": { POST: companionAuth.revoke },
      // The installable app: its name is set on the admin page, and a build
      // without a service worker replaces one that an earlier build installed.
      "/manifest.json": { GET: manifestHandler, HEAD: manifestHandler },
      "/sw.js": { GET: serviceWorkerHandler, HEAD: serviceWorkerHandler },
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
  return Bun.serve({ port, maxRequestBodySize: MAX_BODY_BYTES, fetch: (req, server) => admin(req, server) });
}
