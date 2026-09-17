import type { BunRequest, Server } from "bun";
import { resolve, sep } from "node:path";
import type { Auth } from "./auth";
import { createGuard } from "./auth/guard";
import { createHassTokenHandler } from "./auth/hass-token";
import type { Config } from "./config";
import type { Dashboard } from "./dashboard";
import { createHttpRoutes } from "./proxy/http";
import { createWsProxy, type ConnState } from "./proxy/ws";

export interface ServerDeps {
  config: Config;
  dashboards: Map<string, Dashboard>;
  auth: Auth;
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

export function createServer({ config, dashboards, auth }: ServerDeps, port: number = config.port) {
  const requireGuest = createGuard(auth, dashboards);
  const wsProxy = createWsProxy(config, dashboards);
  const httpRoutes = createHttpRoutes(config, requireGuest);
  const hassToken = createHassTokenHandler(auth, dashboards);

  // A dashboard that turns invalid at runtime drops its guests immediately.
  for (const dashboard of dashboards.values()) {
    dashboard.onChange((d) => {
      if (d.status !== "ok") wsProxy.closeForDashboard(d.id);
    });
  }

  const frontendRoot = resolve(config.frontend_development_repo ?? "./public");

  async function serveFrontend(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (RESERVED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return new Response("Not Found", { status: 404 });
    }

    let target: string;
    try {
      target = resolve(frontendRoot, `.${decodeURIComponent(url.pathname)}`);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (target === frontendRoot || target.startsWith(frontendRoot + sep)) {
      const file = Bun.file(target);
      if (await file.exists()) return new Response(file);
    }

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
      "/api/websocket": (req: BunRequest, server: Server<ConnState>) => wsProxy.upgrade(req, server),
      ...httpRoutes,
      // Everything under /api that is not listed above is denied.
      "/api/*": new Response("Not Found", { status: 404 }),
    },
    websocket: wsProxy.handlers,
    fetch: serveFrontend,
  });

  return { server, wsProxy };
}
