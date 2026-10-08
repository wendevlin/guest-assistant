import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import type { Database } from "bun:sqlite";

/**
 * The better-auth endpoints the guest frontend uses (guest-api.ts there),
 * with their method. Every other request under /api/auth is answered with
 * 404 before it reaches better-auth (auth/handler.ts), so endpoints a
 * better-auth update adds stay off as well.
 */
export const ALLOWED_AUTH_ENDPOINTS: ReadonlyMap<string, string> = new Map([
  ["/sign-in/username", "POST"],
  ["/sign-out", "POST"],
  ["/get-session", "GET"],
]);

/**
 * Second layer: the endpoints better-auth itself is told to disable via
 * `disabledPaths`. It only knows exact paths, so it misses new ones and
 * those with parameters (`/callback/:id`). Checked in test/server.test.ts.
 */
const ALL_KNOWN_AUTH_PATHS = [
  "/account-info",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/error",
  "/get-access-token",
  "/is-username-available",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
  "/ok",
  "/refresh-token",
  "/request-password-reset",
  "/reset-password",
  "/revoke-other-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/send-verification-email",
  "/sign-in/email",
  "/sign-in/social",
  "/sign-up/email",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-email",
  "/verify-password",
];

export const DISABLED_AUTH_PATHS = ALL_KNOWN_AUTH_PATHS.filter((p) => !ALLOWED_AUTH_ENDPOINTS.has(p));

export interface AuthOptions {
  db: Database;
  /** URL guests use; decides about secure cookies. */
  publicUrl?: string;
  /** Guest port, for the fallback base URL. */
  port: number;
  /** Signs session cookies. Generated once and kept in the database. */
  secret: string;
}

/**
 * Origins allowed to post to the auth endpoints: the configured public URL
 * and the host the request was sent to, over http or https (a TLS-terminating
 * reverse proxy forwards plain http). A cross-site page cannot fake either;
 * its Origin header names its own site.
 */
function trustedOriginsFor(publicUrl: string | undefined) {
  return (request?: Request): string[] => {
    const origins = publicUrl ? [new URL(publicUrl).origin] : [];
    if (request) {
      const host = new URL(request.url).host;
      origins.push(`http://${host}`, `https://${host}`);
    }
    return origins;
  };
}

export function createAuth({ db, publicUrl, port, secret }: AuthOptions) {
  const baseURL = new URL(publicUrl ?? `http://localhost:${port}`);
  const secure = baseURL.protocol === "https:";

  return betterAuth({
    secret,
    baseURL: baseURL.origin,
    trustedOrigins: trustedOriginsFor(publicUrl),
    database: db,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    plugins: [username()],
    disabledPaths: DISABLED_AUTH_PATHS,
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/username": { window: 60, max: 10 },
      },
    },
    advanced: {
      // The proxy runs the migrations itself at start-up (Runtime.init).
      database: { validateSchema: false },
      useSecureCookies: secure,
      ipAddress: {
        // Set by server.ts from the TCP peer; never trusted from the client.
        ipAddressHeaders: ["x-guest-assistant-client-ip"],
      },
    },
    user: {
      additionalFields: {
        dashboard: {
          type: "string",
          required: true,
          // Never settable through any client-facing endpoint.
          input: false,
        },
        enabled: {
          type: "boolean",
          required: false,
          defaultValue: true,
          input: false,
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
