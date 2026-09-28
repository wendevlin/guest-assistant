import { createHash } from "node:crypto";
import type { Dashboard } from "../dashboard";
import { verifyJWT } from "../jwt";
import type { Runtime } from "../runtime";

export interface GuestIdentity {
  userId: string;
  dashboard: Dashboard;
}

export type GuardResult = GuestIdentity | Response;

export function isDenied(result: GuardResult): result is Response {
  return result instanceof Response;
}

interface CachedSession {
  userId: string;
  dashboardId: string;
  expires: number;
}

const SESSION_CACHE_TTL_MS = 60_000;

/**
 * Builds `requireGuest(request)`: resolves the caller to a dashboard either via
 * the hass-token JWT (Authorization: Bearer) or the better-auth session cookie.
 * Returns a 401/403 Response when access must be denied.
 */
export function createGuard(runtime: Pick<Runtime, "auth" | "dashboards">) {
  const sessionCache = new Map<string, CachedSession>();
  const dashboards = runtime.dashboards;

  function resolveDashboard(userId: string, dashboardId: string | undefined): GuardResult {
    const dashboard = dashboardId ? dashboards.get(dashboardId) : undefined;
    if (!dashboard) return new Response("Forbidden", { status: 403 });
    if (dashboard.status !== "ok") return new Response("Dashboard not available", { status: 403 });
    return { userId, dashboard };
  }

  async function requireGuest(request: Request): Promise<GuardResult> {
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const payload = verifyJWT(authHeader.slice(7));
      if (!payload) return new Response("Unauthorized", { status: 401 });
      return resolveDashboard(payload.sub, payload.dashboard);
    }

    const cookieHeader = request.headers.get("cookie");
    if (!cookieHeader) return new Response("Unauthorized", { status: 401 });

    const cacheKey = createHash("sha256").update(cookieHeader).digest("base64");
    const cached = sessionCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return resolveDashboard(cached.userId, cached.dashboardId);
    }

    const session = await runtime.auth.api.getSession({ headers: request.headers });
    if (!session) {
      sessionCache.delete(cacheKey);
      return new Response("Unauthorized", { status: 401 });
    }

    const dashboardId = (session.user as { dashboard?: string }).dashboard;
    if (dashboardId) {
      sessionCache.set(cacheKey, {
        userId: session.user.id,
        dashboardId,
        expires: Date.now() + SESSION_CACHE_TTL_MS,
      });
    }
    return resolveDashboard(session.user.id, dashboardId);
  }

  /** Forgets cached sessions, e.g. after a guest was moved or deleted. */
  requireGuest.invalidate = () => sessionCache.clear();
  return requireGuest;
}

export type RequireGuest = ReturnType<typeof createGuard>;
