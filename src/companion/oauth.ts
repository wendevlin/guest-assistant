import type { BunRequest, Server } from "bun";
import { randomBytes } from "node:crypto";
import z from "zod";
import { JWT_TTL_SECONDS } from "../jwt";
import { AttemptLimiter } from "../rate-limit";
import type { Runtime } from "../runtime";

/**
 * Home Assistant's OAuth endpoints as the companion apps use them, for guests
 * instead of HA users:
 *
 * 1. The app opens /auth/authorize?client_id=…&redirect_uri=homeassistant://auth-callback
 *    in a web view. The guest frontend's authorize page signs the guest in
 *    through POST /auth/login_flow and navigates to the redirect URI with
 *    the code it got.
 * 2. The app exchanges the code at POST /auth/token for an access and a
 *    refresh token (one companion app login, see tokens.ts), and refreshes
 *    there later.
 * 3. Signing out revokes at POST /auth/revoke (Android) or POST /auth/token
 *    with action=revoke (iOS, which sends the access token).
 *
 * Only the official apps' client ids and redirect URIs are accepted (the same
 * list HA itself trusts without fetching the client's page). Everything here
 * answers 404 while companion app support is off.
 */

export const CLIENT_IDS: ReadonlySet<string> = new Set([
  "https://home-assistant.io/android",
  "https://home-assistant.io/iOS",
  "https://home-assistant.io/iOS/dev-auth",
]);
export const REDIRECT_URIS: ReadonlySet<string> = new Set(["homeassistant://auth-callback", "homeassistant-dev://auth-callback"]);

/** An authorization code is exchanged right after the redirect. */
const CODE_TTL_MS = 60_000;
const MAX_PENDING_CODES = 200;
/** Sign-in attempts, like the guest page's own sign-in. */
const LOGIN_ATTEMPTS_PER_CLIENT = 10;
const LOGIN_ATTEMPTS_TOTAL = 60;
/** Failed code exchanges and refreshes. */
const TOKEN_FAILURES_PER_CLIENT = 30;
const TOKEN_FAILURES_TOTAL = 300;

interface PendingCode {
  userId: string;
  clientId: string;
  redirectUri: string;
  expires: number;
}

const LoginInput = z.object({
  client_id: z.string().max(200),
  redirect_uri: z.string().max(200),
  username: z.string().max(100),
  password: z.string().max(200),
});

const noStore = { "cache-control": "no-store" };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: noStore });
const notFound = () => new Response("Not Found", { status: 404 });
const tokenError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

export interface CompanionAuthOptions {
  /** Serves the frontend build's authorize page. */
  serveAuthorizePage(req: Request): Promise<Response>;
}

export function createCompanionAuth(runtime: Runtime, { serveAuthorizePage }: CompanionAuthOptions) {
  const codes = new Map<string, PendingCode>();
  const logins = new AttemptLimiter(LOGIN_ATTEMPTS_PER_CLIENT, LOGIN_ATTEMPTS_TOTAL);
  const tokenFailures = new AttemptLimiter(TOKEN_FAILURES_PER_CLIENT, TOKEN_FAILURES_TOTAL);

  const enabled = () => runtime.companion.enabled;
  const clientOf = (req: Request, server: Server<unknown>) => server.requestIP(req)?.address.replace(/^::ffff:/, "") ?? "";

  function issueCode(pending: Omit<PendingCode, "expires">): string | null {
    const now = Date.now();
    for (const [code, p] of codes) if (p.expires <= now) codes.delete(code);
    if (codes.size >= MAX_PENDING_CODES) return null;
    const code = randomBytes(32).toString("hex");
    codes.set(code, { ...pending, expires: now + CODE_TTL_MS });
    return code;
  }

  function takeCode(code: string | null): PendingCode | undefined {
    if (!code) return undefined;
    const pending = codes.get(code);
    codes.delete(code);
    return pending && pending.expires > Date.now() ? pending : undefined;
  }

  /** The guest's dashboard if it may get tokens: active guest, assigned and switched-on dashboard. */
  async function guestFor(userId: string) {
    const guest = await runtime.guests.get(userId);
    if (!guest) return { error: "gone" as const };
    if (!guest.enabled) return { error: "disabled" as const };
    const dashboard = runtime.dashboards.get(guest.dashboard);
    if (!dashboard?.enabled) return { error: "dashboard" as const };
    return { guest, dashboard };
  }

  // ── /auth/authorize ───────────────────────────────────────────────────

  async function authorize(req: BunRequest): Promise<Response> {
    if (!enabled()) return notFound();
    // The iOS app checks the server with a plain GET of this URL first and
    // needs a 2xx; the page itself checks the query.
    return serveAuthorizePage(req);
  }

  // ── /auth/login_flow ──────────────────────────────────────────────────

  async function loginFlow(req: BunRequest, server: Server<unknown>): Promise<Response> {
    if (!enabled()) return notFound();
    // A JSON body cannot be sent cross-site without a CORS preflight, which is never granted.
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Expected JSON" }, 415);
    let parsed;
    try {
      parsed = LoginInput.safeParse(await req.json());
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!parsed.success) return json({ error: "Invalid request" }, 400);
    const input = parsed.data;
    if (!CLIENT_IDS.has(input.client_id) || !REDIRECT_URIS.has(input.redirect_uri)) return json({ error: "invalid_client" }, 400);

    if (!logins.take(clientOf(req, server))) return json({ error: "Too many attempts, wait a minute" }, 429);

    const form = (base: string) => json({ type: "form", flow_id: null, step_id: "init", errors: { base } }, 400);
    const guest = await runtime.guests.verifyPassword(input.username, input.password);
    if (!guest) return form("invalid_auth");
    const checked = await guestFor(guest.id);
    if (checked.error === "disabled") return form("guest_disabled");
    if (checked.error) return form("dashboard_unavailable");

    const code = issueCode({ userId: guest.id, clientId: input.client_id, redirectUri: input.redirect_uri });
    if (!code) return json({ error: "Too many sign-ins at once, try again in a minute" }, 429);
    return json({ type: "create_entry", flow_id: null, result: code });
  }

  // ── /auth/token and /auth/revoke ──────────────────────────────────────

  async function formParams(req: Request): Promise<URLSearchParams> {
    try {
      return new URLSearchParams(await req.text());
    } catch {
      return new URLSearchParams();
    }
  }

  function revokeToken(token: string | null): Response {
    if (token) {
      // Android sends the refresh token, iOS the access token (which may
      // have expired, it still names the login).
      const row = runtime.appTokens.findByRefreshToken(token) ?? runtime.appTokens.get(runtime.appTokens.verify(token, { ignoreExpiry: true })?.sid ?? "");
      if (row) runtime.endAppSession(row.id);
    }
    // Like HA: always 200, so nobody learns whether a token existed.
    return new Response(null, { status: 200, headers: noStore });
  }

  async function token(req: BunRequest, server: Server<unknown>): Promise<Response> {
    if (!enabled()) return notFound();
    const params = await formParams(req);
    if (params.get("action") === "revoke") return revokeToken(params.get("token"));

    const client = clientOf(req, server);
    if (tokenFailures.blocked(client)) return tokenError("slow_down", "Too many failed requests, wait a minute", 429);
    const fail = (error: string, description: string, status = 400) => {
      tokenFailures.take(client);
      return tokenError(error, description, status);
    };
    const clientId = params.get("client_id") ?? "";

    switch (params.get("grant_type")) {
      case "authorization_code": {
        const pending = takeCode(params.get("code"));
        if (!pending || pending.clientId !== clientId) return fail("invalid_request", "Invalid code");
        const checked = await guestFor(pending.userId);
        if (checked.error) return fail("access_denied", "The guest account cannot be used", 403);
        const { row, refreshToken } = runtime.appTokens.create(checked.guest.id, clientId);
        console.log(`Guest ${checked.guest.username} signed in with the companion app (${clientId}).`);
        return json({
          access_token: runtime.appTokens.sign(row, { id: checked.guest.id, name: checked.guest.username }, checked.dashboard.id),
          token_type: "Bearer",
          refresh_token: refreshToken,
          expires_in: JWT_TTL_SECONDS,
          ha_auth_provider: "homeassistant",
        });
      }

      case "refresh_token": {
        const row = runtime.appTokens.findByRefreshToken(params.get("refresh_token") ?? "");
        // invalid_grant makes Android remove the server and iOS ask to sign
        // in again: only for logins that are gone for good. Refresh tokens
        // are never rotated, the apps would not pick up a new one.
        if (!row || row.client_id !== clientId) return fail("invalid_grant", "Invalid refresh token");
        const checked = await guestFor(row.user_id);
        if (checked.error === "gone") {
          runtime.endAppSession(row.id);
          return fail("invalid_grant", "Invalid refresh token");
        }
        // A switched-off guest or dashboard may come back; keep the login.
        // A dashboard that is only reloading still gets a token: every
        // request checks whether it can be used.
        if (checked.error) return tokenError("access_denied", "The guest account cannot be used right now", 403);
        runtime.appTokens.touch(row.id);
        return json({
          access_token: runtime.appTokens.sign(row, { id: checked.guest.id, name: checked.guest.username }, checked.dashboard.id),
          token_type: "Bearer",
          expires_in: JWT_TTL_SECONDS,
        });
      }

      default:
        return tokenError("unsupported_grant_type", "Unsupported grant type");
    }
  }

  async function revoke(req: BunRequest): Promise<Response> {
    if (!enabled()) return notFound();
    return revokeToken((await formParams(req)).get("token"));
  }

  return { authorize, loginFlow, token, revoke };
}
