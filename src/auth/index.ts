import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { Config } from "../config";

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

export function createAuth(config: Pick<Config, "base_url">, databasePath = "data/guest-assistant.db") {
  if (databasePath !== ":memory:") {
    mkdirSync(databasePath.replace(/[^/]+$/, "") || ".", { recursive: true });
  }
  const baseURL = new URL(config.base_url);
  const secure = baseURL.protocol === "https:";

  return betterAuth({
    baseURL: baseURL.origin,
    trustedOrigins: [baseURL.origin],
    database: new Database(databasePath),
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
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
