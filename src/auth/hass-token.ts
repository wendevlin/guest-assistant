import { isGuestEnabled } from "../guests";
import { JWT_TTL_SECONDS, signJWT } from "../jwt";
import type { Runtime } from "../runtime";

/**
 * GET /api/auth/hass-token
 *
 * Exchanges a valid better-auth session for a short-lived JWT the guest
 * frontend presents in the HA-compatible WebSocket auth handshake.
 */
export function createHassTokenHandler(runtime: Pick<Runtime, "auth" | "dashboards">) {
  return async (request: Request): Promise<Response> => {
    const session = await runtime.auth.api.getSession({ headers: request.headers });
    if (!session) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // The guest page then says the dashboard is not available right now.
    if (!isGuestEnabled(session.user)) {
      return Response.json({ error: "Account not active", reason: [] }, { status: 403 });
    }
    const dashboardId = (session.user as { dashboard?: string }).dashboard;
    const dashboard = dashboardId ? runtime.dashboards.get(dashboardId) : undefined;
    if (!dashboard) {
      return Response.json({ error: "No dashboard assigned" }, { status: 403 });
    }
    if (!dashboard.enabled) {
      return Response.json({ error: "Dashboard not active", reason: [] }, { status: 403 });
    }
    if (dashboard.status !== "ok") {
      return Response.json(
        {
          error: "Dashboard not available",
          reason: dashboard.status === "rejected" ? dashboard.violations.map((v) => v.message) : ["loading"],
        },
        { status: 403 },
      );
    }

    const now = Date.now();
    const token = signJWT({
      sub: session.user.id,
      sid: session.session.id,
      dashboard: dashboard.id,
      iat: now,
      exp: Math.floor(now / 1000) + JWT_TTL_SECONDS,
    });

    return Response.json(
      {
        access_token: token,
        refresh_token: "session",
        expires_in: JWT_TTL_SECONDS,
        dashboard_url_path: dashboard.urlPath,
      },
      { headers: { "cache-control": "no-store" } },
    );
  };
}
