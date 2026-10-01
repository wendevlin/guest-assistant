import type { Dashboard } from "../dashboard";
import { isGuestEnabled } from "../guests";
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

/**
 * Builds `requireGuest(request)`: resolves the caller to a dashboard either via
 * the hass-token JWT (Authorization: Bearer) or the better-auth session cookie.
 * Returns a 401/403 Response when access must be denied.
 *
 * Sessions are looked up on every request (one local SQLite query), so a
 * sign-out or a deleted guest takes effect immediately.
 */
export function createGuard(runtime: Pick<Runtime, "auth" | "dashboards">) {
  const dashboards = runtime.dashboards;

  function resolveDashboard(userId: string, dashboardId: string | undefined): GuardResult {
    const dashboard = dashboardId ? dashboards.get(dashboardId) : undefined;
    if (!dashboard) return new Response("Forbidden", { status: 403 });
    if (!dashboard.usable) return new Response("Dashboard not available", { status: 403 });
    return { userId, dashboard };
  }

  return async function requireGuest(request: Request): Promise<GuardResult> {
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const payload = verifyJWT(authHeader.slice(7));
      if (!payload) return new Response("Unauthorized", { status: 401 });
      return resolveDashboard(payload.sub, payload.dashboard);
    }

    if (!request.headers.get("cookie")) return new Response("Unauthorized", { status: 401 });

    const session = await runtime.auth.api.getSession({ headers: request.headers });
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!isGuestEnabled(session.user)) return new Response("Account not active", { status: 403 });

    return resolveDashboard(session.user.id, (session.user as { dashboard?: string }).dashboard);
  };
}

export type RequireGuest = ReturnType<typeof createGuard>;
