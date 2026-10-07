import { ALLOWED_AUTH_ENDPOINTS } from "../auth";
import type { Runtime } from "../runtime";

const AUTH_BASE = "/api/auth";

/**
 * Handles /api/auth/* (the exact /api/auth/hass-token route is separate).
 * Only the endpoints in ALLOWED_AUTH_ENDPOINTS reach better-auth. A
 * successful sign-out also reports the session it ended, so the hass-tokens
 * issued for it and the connections made with them end too.
 */
export function createAuthHandler(runtime: Pick<Runtime, "auth">, onSignOut: (sessionId: string) => void) {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const path = pathname.startsWith(`${AUTH_BASE}/`) ? pathname.slice(AUTH_BASE.length) : "";
    if (ALLOWED_AUTH_ENDPOINTS.get(path) !== request.method) {
      return new Response("Not Found", { status: 404 });
    }

    // Looked up before better-auth deletes the session; without refresh, so
    // this lookup does not extend a session that is about to end.
    const signedOut =
      path === "/sign-out"
        ? await runtime.auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } })
        : null;

    const response = await runtime.auth.handler(request);
    if (signedOut && response.ok) onSignOut(signedOut.session.id);
    return response;
  };
}
