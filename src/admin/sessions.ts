import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export interface AdminSession {
  id: string;
  /** "setup" only allows connecting a Home Assistant (after the setup code). */
  kind: "admin" | "setup";
  name: string;
  expires: number;
}

export interface PendingOAuth {
  state: string;
  haUrl: string;
  clientId: string;
  redirectUri: string;
  /** "setup" creates the proxy user afterwards, "login" only signs the admin in. */
  purpose: "setup" | "login";
  expires: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SETUP_SESSION_TTL_MS = 30 * 60 * 1000;
const OAUTH_TTL_MS = 10 * 60 * 1000;
const CODE_ATTEMPTS_PER_MINUTE = 10;
const MAX_PENDING_OAUTH = 200;

export const ADMIN_COOKIE = "ga_admin";
export const OAUTH_COOKIE = "ga_oauth";

/**
 * Admin sessions live in memory only: a restart means logging in with Home
 * Assistant again. No HA admin token is kept; it is revoked right after login.
 */
export class AdminSessions {
  private sessions = new Map<string, AdminSession>();
  private oauth = new Map<string, PendingOAuth>();
  private codeAttempts: number[] = [];
  /** One-time code printed to the log while the proxy is not set up (standalone only). */
  setupCode: string | null = null;

  newSetupCode(): string {
    const digits = Array.from({ length: 8 }, () => randomInt(10)).join("");
    this.setupCode = `${digits.slice(0, 4)}-${digits.slice(4)}`;
    return this.setupCode;
  }

  /** Rate-limited, constant-time check of the setup code. */
  checkSetupCode(input: string): "ok" | "wrong" | "throttled" {
    const now = Date.now();
    this.codeAttempts = this.codeAttempts.filter((t) => now - t < 60_000);
    if (this.codeAttempts.length >= CODE_ATTEMPTS_PER_MINUTE) return "throttled";
    this.codeAttempts.push(now);
    if (!this.setupCode) return "wrong";
    const a = Buffer.from(input.replace(/\D/g, ""));
    const b = Buffer.from(this.setupCode.replace(/\D/g, ""));
    return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "wrong";
  }

  create(kind: AdminSession["kind"], name: string): AdminSession {
    const session: AdminSession = {
      id: randomBytes(32).toString("base64url"),
      kind,
      name,
      expires: Date.now() + (kind === "admin" ? SESSION_TTL_MS : SETUP_SESSION_TTL_MS),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): AdminSession | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expires < Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  delete(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  /** Setup sessions become useless once the proxy is set up. */
  dropSetupSessions(): void {
    for (const [id, s] of this.sessions) if (s.kind === "setup") this.sessions.delete(id);
  }

  startOAuth(pending: Omit<PendingOAuth, "state" | "expires">): PendingOAuth {
    const now = Date.now();
    for (const [state, p] of this.oauth) if (p.expires < now) this.oauth.delete(state);
    // Starting a sign-in needs no login; keep what strangers can pile up bounded.
    while (this.oauth.size >= MAX_PENDING_OAUTH) this.oauth.delete(this.oauth.keys().next().value!);
    const entry = { ...pending, state: randomBytes(24).toString("base64url"), expires: now + OAUTH_TTL_MS };
    this.oauth.set(entry.state, entry);
    return entry;
  }

  /** Returns and forgets the pending login; a state can be used once. */
  takeOAuth(state: string | null): PendingOAuth | undefined {
    if (!state) return undefined;
    const entry = this.oauth.get(state);
    this.oauth.delete(state);
    return entry && entry.expires >= Date.now() ? entry : undefined;
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export function cookie(name: string, value: string, opts: { path: string; secure: boolean; maxAge?: number }): string {
  const parts = [`${name}=${value}`, `Path=${opts.path}`, "HttpOnly", "SameSite=Lax"];
  if (opts.secure) parts.push("Secure");
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}
