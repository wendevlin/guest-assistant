import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import type { Database } from "bun:sqlite";

/**
 * Only these better-auth endpoints are reachable. Everything else is disabled
 * via `disabledPaths`. The guest frontend uses sign-in/username, get-session
 * and sign-out. Keep this list in sync with the test in test/auth.test.ts.
 */
export const ENABLED_AUTH_PATHS = ["/sign-in/username", "/sign-out", "/get-session", "/ok", "/error"];

const ALL_KNOWN_AUTH_PATHS = [
  "/account-info",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/get-access-token",
  "/is-username-available",
  "/link-social",
  "/list-accounts",
  "/list-sessions",
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

export const DISABLED_AUTH_PATHS = ALL_KNOWN_AUTH_PATHS.filter((p) => !ENABLED_AUTH_PATHS.includes(p));

export interface AuthOptions {
  db: Database;
  /** URL guests use; decides about secure cookies. */
  publicUrl?: string;
  /** Guest port, for the fallback base URL. */
  port: number;
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

export function createAuth({ db, publicUrl, port }: AuthOptions) {
  const baseURL = new URL(publicUrl ?? `http://localhost:${port}`);
  const secure = baseURL.protocol === "https:";

  return betterAuth({
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
        /** JSON-encoded ThemeSettings overriding the dashboard's. */
        theme: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
