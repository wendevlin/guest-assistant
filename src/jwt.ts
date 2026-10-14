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

/**
 * Signed-out sessions whose tokens are refused, with the time (ms) after
 * which every token issued for them has expired. Only that one session is
 * affected; the guest's other devices stay signed in.
 */
const revokedSessions = new Map<string, number>();

export interface GuestTokenPayload {
  /** better-auth user id */
  sub: string;
  /** better-auth session id, or the companion app login (src/companion/tokens.ts) */
  sid: string;
  /** dashboard id the user is bound to */
  dashboard: string;
  /** issued at, in milliseconds (internal token, not exchanged with HA) */
  iat: number;
  exp: number;
  /** display name of the guest */
  name?: string;
  /** companion app tokens: generation of the login, see AppTokens */
  gen?: number;
}

export interface SignOptions {
  /** Defaults to the per-process secret. */
  secret?: Uint8Array;
  /** Marks tokens signed with another secret, so the verifier knows which one to use. */
  kid?: string;
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

export function signJWT(payload: GuestTokenPayload, { secret = JWT_SECRET, kid }: SignOptions = {}): string {
  const header = base64url(JSON.stringify(kid ? { alg: "HS256", typ: "JWT", kid } : { alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${base64url(sig)}`;
}

/** Refuses every token of the user issued up to now. */
export function revokeTokens(userId: string): void {
  revokedBefore.set(userId, Date.now());
}

/** Refuses every token issued for the session, e.g. after its sign-out. */
export function revokeSession(sessionId: string): void {
  const now = Date.now();
  for (const [sid, until] of revokedSessions) if (until < now) revokedSessions.delete(sid);
  // A token fetched while the sign-out was in flight may be issued a moment
  // after this; the extra minute covers it.
  revokedSessions.set(sessionId, now + (JWT_TTL_SECONDS + 60) * 1000);
}

/** The `kid` of a token's header, without checking anything else. */
export function tokenKid(token: string): string | undefined {
  try {
    const header = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString());
    return typeof header?.kid === "string" ? header.kid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks signature and shape only: not expiry, not revocation. Callers decide
 * about those (an expired companion app token still names the login to revoke).
 */
export function decodeJWT(token: string, secret: Uint8Array = JWT_SECRET): GuestTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  const expected = createHmac("sha256", secret)
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
      typeof payload.exp !== "number" ||
      (payload.name !== undefined && typeof payload.name !== "string") ||
      (payload.gen !== undefined && typeof payload.gen !== "number")
    ) {
      return null;
    }
    return payload as GuestTokenPayload;
  } catch {
    return null;
  }
}

/** Verifies a hass-token of the guest page (per-process secret, in-memory revocation). */
export function verifyJWT(token: string): GuestTokenPayload | null {
  if (tokenKid(token) !== undefined) return null;
  const payload = decodeJWT(token);
  if (!payload) return null;
  if (Date.now() / 1000 > payload.exp) return null;
  const revokedAt = revokedBefore.get(payload.sub);
  if (revokedAt !== undefined && payload.iat <= revokedAt) return null;
  if (revokedSessions.has(payload.sid)) return null;
  return payload;
}
