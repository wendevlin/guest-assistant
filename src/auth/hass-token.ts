import { JWT_TTL_SECONDS, signJWT } from "../jwt";
import type { Dashboard } from "../dashboard";
import type { Auth } from "./index";

/**
 * GET /api/auth/hass-token
 *
 * Exchanges a valid better-auth session for a short-lived JWT the guest
 * frontend presents in the HA-compatible WebSocket auth handshake.
 */
export function createHassTokenHandler(auth: Auth, dashboards: Map<string, Dashboard>) {
  return async (request: Request): Promise<Response> => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const dashboardId = (session.user as { dashboard?: string }).dashboard;
    const dashboard = dashboardId ? dashboards.get(dashboardId) : undefined;
    if (!dashboard) {
      return Response.json({ error: "No dashboard assigned" }, { status: 403 });
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

    const token = signJWT({
      sub: session.user.id,
      sid: session.session.id,
      dashboard: dashboard.id,
      exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS,
    });

    return Response.json({
      access_token: token,
      refresh_token: "session",
      expires_in: JWT_TTL_SECONDS,
      dashboard_url_path: dashboard.urlPath,
    });
  };
}
