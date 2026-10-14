import { resolveGuestToken, type AppTokens } from "../companion/tokens";
import type { Dashboard } from "../dashboard";
import { isGuestEnabled } from "../guests";
import type { Runtime } from "../runtime";

export interface GuestIdentity {
  userId: string;
  dashboard: Dashboard;
  /** better-auth session, or the companion app login of an app token */
  sessionId: string;
  /** cookie session, the guest page's hass-token, or a companion app token */
  kind: "cookie" | "session-token" | "app-token";
  name: string;
}

export type GuardResult = GuestIdentity | Response;

export function isDenied(result: GuardResult): result is Response {
  return result instanceof Response;
}

/**
 * The native part of a companion app (widgets, device controls, watch, the
 * app's own requests) sends `Home Assistant/<version> (…)` as its whole
 * User-Agent; the app's WebView sends the browser's with that appended.
 * Only used to switch the widgets feature, never to grant anything: a client
 * that lies about it gets at most what the dashboard already allows.
 */
export function isNativeApp(request: Request): boolean {
  return /^Home Assistant\//.test(request.headers.get("user-agent") ?? "");
}

/**
 * Builds `requireGuest(request)`: resolves the caller to a dashboard either via
 * a token (Authorization: Bearer; the guest page's hass-token or a companion
 * app token) or the better-auth session cookie. Returns a 401/403 Response when
 * access must be denied.
 *
 * Sessions are looked up on every request (one local SQLite query), so a
 * sign-out or a deleted guest takes effect immediately.
 */
export function createGuard(runtime: Pick<Runtime, "auth" | "dashboards"> & { appTokens: AppTokens }) {
  const dashboards = runtime.dashboards;

  function resolveDashboard(identity: Omit<GuestIdentity, "dashboard">, dashboardId: string | undefined): GuardResult {
    const dashboard = dashboardId ? dashboards.get(dashboardId) : undefined;
    if (!dashboard) return new Response("Forbidden", { status: 403 });
    if (!dashboard.usable) return new Response("Dashboard not available", { status: 403 });
    return { ...identity, dashboard };
  }

  return async function requireGuest(request: Request): Promise<GuardResult> {
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const resolved = resolveGuestToken(authHeader.slice(7), runtime.appTokens);
      if (!resolved) return new Response("Unauthorized", { status: 401 });
      const { payload, kind } = resolved;
      return resolveDashboard({ userId: payload.sub, sessionId: payload.sid, kind, name: payload.name ?? "Guest" }, payload.dashboard);
    }

    if (!request.headers.get("cookie")) return new Response("Unauthorized", { status: 401 });

    const session = await runtime.auth.api.getSession({ headers: request.headers });
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!isGuestEnabled(session.user)) return new Response("Account not active", { status: 403 });

    return resolveDashboard(
      { userId: session.user.id, sessionId: session.session.id, kind: "cookie", name: session.user.name || "Guest" },
      (session.user as { dashboard?: string }).dashboard,
    );
  };
}

export type RequireGuest = ReturnType<typeof createGuard>;

/**
 * For routes that hand out entity data (states, cameras, history): the native
 * part of a companion app only gets them where the admin allowed widgets for
 * the dashboard.
 */
export function withWidgetCheck(requireGuest: RequireGuest): RequireGuest {
  return async (request) => {
    const result = await requireGuest(request);
    if (isDenied(result)) return result;
    if (result.kind === "app-token" && isNativeApp(request) && !result.dashboard.widgets) {
      return new Response("Widgets are not enabled for this dashboard", { status: 403 });
    }
    return result;
  };
}
