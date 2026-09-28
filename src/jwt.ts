import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GuestTheme } from "./config";

/**
 * Signing secret is generated per process. Tokens are short-lived and the
 * frontend re-fetches them from /api/auth/hass-token using its session, so
 * invalidating all tokens on restart is intended.
 */
const JWT_SECRET = randomBytes(32);

/** Lifetime of a hass-token in seconds. */
export const JWT_TTL_SECONDS = 15 * 60;

export interface GuestTokenPayload {
  /** better-auth user id */
  sub: string;
  /** better-auth session id */
  sid: string;
  /** dashboard id the user is bound to */
  dashboard: string;
  /** theme settings from config.yaml, answered to the frontend by the WS proxy */
  theme: GuestTheme;
  exp: number;
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

export function signJWT(payload: GuestTokenPayload): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${base64url(sig)}`;
}

export function verifyJWT(token: string): GuestTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  const expected = createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest();
  const actual = Buffer.from(signature, "base64url");

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.dashboard !== "string" ||
      typeof payload.theme !== "object" ||
      payload.theme === null ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() / 1000 > payload.exp) return null;
    return payload as GuestTokenPayload;
  } catch {
    return null;
  }
}
