import type { BunRequest, Server } from "bun";
import { resolve, sep } from "node:path";
import type { Auth } from "./auth";
import { createGuard } from "./auth/guard";
import { createHassTokenHandler } from "./auth/hass-token";
import { themeForUser, type Config } from "./config";
import type { Dashboard } from "./dashboard";
import type { HaClient } from "./ha/client";
import { createHttpRoutes } from "./proxy/http";
import { createWsProxy, type ConnState } from "./proxy/ws";

export interface ServerDeps {
  config: Config;
  dashboards: Map<string, Dashboard>;
  auth: Auth;
  /** The proxy's own HA connection; reported to the frontend via /api/guest-assistant/status. */
  client?: Pick<HaClient, "connected">;
}

const RESERVED_PREFIXES = ["/api/", "/static/", "/local/", "/hacsfiles/"];

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

export function createServer({ config, dashboards, auth, client }: ServerDeps, port: number = config.port) {
  const requireGuest = createGuard(auth, dashboards);
  const wsProxy = createWsProxy(config, dashboards);
  const httpRoutes = createHttpRoutes(config, requireGuest);
  const hassToken = createHassTokenHandler(auth, dashboards, (username) => themeForUser(config, username));

  // A dashboard that turns invalid at runtime drops its guests immediately;
  // a changed allowlist makes them reconnect.
  for (const dashboard of dashboards.values()) {
    dashboard.onChange((d) => wsProxy.dashboardChanged(d));
  }

  // Like HA core's `development_repo`: point at the frontend repository root,
  // the build output inside it is served.
  const frontendRoot = config.frontend_development_repo
    ? resolve(config.frontend_development_repo, "guest-assistant/dist")
    : resolve("./public");

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

  const server = Bun.serve({
    port,
    routes: {
      "/api/auth/hass-token": { GET: hassToken },
      "/api/auth/*": (req: BunRequest, server: Server<ConnState>) => auth.handler(withClientIp(req, server)),
      // Lets the frontend tell "proxy unreachable" from "proxy cannot reach
      // HA" while it reconnects. Public like HA's own /manifest.json; it only
      // reveals whether the upstream connection is up.
      "/api/guest-assistant/status": {
        GET: () =>
          Response.json(
            { home_assistant: client?.connected === false ? "disconnected" : "connected" },
            { headers: { "cache-control": "no-store" } },
          ),
      },
      "/api/websocket": (req: BunRequest, server: Server<ConnState>) => wsProxy.upgrade(req, server),
      ...httpRoutes,
      "/static/*": { GET: staticHandler, HEAD: staticHandler },
      // Everything under /api that is not listed above is denied.
      "/api/*": new Response("Not Found", { status: 404 }),
    },
    websocket: wsProxy.handlers,
    fetch: serveFrontend,
  });

  return { server, wsProxy };
}
