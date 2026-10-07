import { ALLOWED_AUTH_ENDPOINTS } from "../auth";
import type { Runtime } from "../runtime";

const AUTH_BASE = "/api/auth";

/**
 * Handles /api/auth/* (the exact /api/auth/hass-token route is separate).
 * Only the endpoints in ALLOWED_AUTH_ENDPOINTS reach better-auth.
 */
export function createAuthHandler(runtime: Pick<Runtime, "auth">) {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const path = pathname.startsWith(`${AUTH_BASE}/`) ? pathname.slice(AUTH_BASE.length) : "";
    if (ALLOWED_AUTH_ENDPOINTS.get(path) !== request.method) {
      return new Response("Not Found", { status: 404 });
    }

    return runtime.auth.handler(request);
  };
}
