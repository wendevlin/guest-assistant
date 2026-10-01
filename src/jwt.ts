import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signing secret is generated per process. Tokens are short-lived and the
 * frontend re-fetches them from /api/auth/hass-token using its session, so
 * invalidating all tokens on restart is intended.
 */
const JWT_SECRET = randomBytes(32);

/** Lifetime of a hass-token in seconds. */
export const JWT_TTL_SECONDS = 15 * 60;

/**
 * Tokens of a user issued before this time (ms) are refused. Set when the
 * guest is deleted or changed, so a token they still hold does not outlive
 * the change. Per process, like the secret.
 */
const revokedBefore = new Map<string, number>();

export interface GuestTokenPayload {
  /** better-auth user id */
  sub: string;
  /** better-auth session id */
  sid: string;
  /** dashboard id the user is bound to */
  dashboard: string;
  /** issued at, in milliseconds (internal token, not exchanged with HA) */
  iat: number;
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

/** Refuses every token of the user issued up to now. */
export function revokeTokens(userId: string): void {
  revokedBefore.set(userId, Date.now());
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
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (Date.now() / 1000 > payload.exp) return null;
    const revokedAt = revokedBefore.get(payload.sub);
    if (revokedAt !== undefined && payload.iat <= revokedAt) return null;
    return payload as GuestTokenPayload;
  } catch {
    return null;
  }
}
