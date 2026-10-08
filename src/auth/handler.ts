import { ALLOWED_AUTH_ENDPOINTS } from "../auth";
import type { Runtime } from "../runtime";

const AUTH_BASE = "/api/auth";

const SECURE_ATTRIBUTE = /;\s*secure\s*(;|$)/i;

/**
 * better-auth marks cookies Secure only when the public URL is https. Behind
 * a TLS-terminating reverse proxy without that setting they would go out
 * without it, so the forwarded protocol counts as well. A client faking the
 * header only keeps its own browser from storing the cookie over plain http.
 * Cookie names stay as they are; better-auth looks them up by name.
 */
function withSecureCookies(request: Request, response: Response, publicUrl: string | undefined): Response {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto !== "https" && !publicUrl?.startsWith("https:")) return response;
  const cookies = response.headers.getSetCookie();
  if (cookies.every((c) => SECURE_ATTRIBUTE.test(c))) return response;
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  for (const c of cookies) headers.append("set-cookie", SECURE_ATTRIBUTE.test(c) ? c : `${c}; Secure`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Handles /api/auth/* (the exact /api/auth/hass-token route is separate).
 * Only the endpoints in ALLOWED_AUTH_ENDPOINTS reach better-auth. A
 * successful sign-out also reports the session it ended, so the hass-tokens
 * issued for it and the connections made with them end too.
 */
export function createAuthHandler(runtime: Pick<Runtime, "auth" | "publicUrl">, onSignOut: (sessionId: string) => void) {
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
    return withSecureCookies(request, response, runtime.publicUrl);
  };
}
