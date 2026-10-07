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
/** A printed code stops working after this; a fresh one is printed instead. */
const SETUP_CODE_TTL_MS = 60 * 60 * 1000;
/** Wrong guesses are limited per client address, so one client cannot lock out the admin. */
const CODE_ATTEMPTS_PER_CLIENT = 10;
/**
 * Ceiling for all addresses together, so many addresses (e.g. an IPv6
 * prefix) cannot guess faster: at 60 a minute, an hourly code out of 10^8
 * is hit with a chance of about 1 in 28,000.
 */
const CODE_ATTEMPTS_TOTAL = 60;
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
  /** Times of the guesses in the last minute, per client address. */
  private codeAttempts = new Map<string, number[]>();
  /** One-time code printed to the log while the proxy is not set up (standalone only). */
  setupCode: string | null = null;
  private setupCodeExpires = 0;

  constructor(private readonly setupCodeTtlMs = SETUP_CODE_TTL_MS) {}

  newSetupCode(): string {
    const digits = Array.from({ length: 8 }, () => randomInt(10)).join("");
    this.setupCode = `${digits.slice(0, 4)}-${digits.slice(4)}`;
    this.setupCodeExpires = Date.now() + this.setupCodeTtlMs;
    return this.setupCode;
  }

  /**
   * Creates a setup code and hands it to `announce` (the log). Until set-up
   * is done, a fresh code replaces it when it expires (after an hour), so a
   * code from an old log does not stay valid forever.
   */
  startSetupCodes(announce: (code: string) => void): void {
    announce(this.newSetupCode());
    const timer = setInterval(() => {
      if (this.setupCode) announce(this.newSetupCode());
      else clearInterval(timer);
    }, this.setupCodeTtlMs);
    timer.unref();
  }

  /** Rate-limited (per client address), constant-time check of the setup code. */
  checkSetupCode(input: string, client: string): "ok" | "wrong" | "throttled" {
    const now = Date.now();
    let total = 0;
    for (const [address, times] of this.codeAttempts) {
      const recent = times.filter((t) => now - t < 60_000);
      if (recent.length) this.codeAttempts.set(address, recent);
      else this.codeAttempts.delete(address);
      total += recent.length;
    }
    // Only admitted guesses are recorded, so the map holds at most CODE_ATTEMPTS_TOTAL entries.
    const mine = this.codeAttempts.get(client) ?? [];
    if (mine.length >= CODE_ATTEMPTS_PER_CLIENT || total >= CODE_ATTEMPTS_TOTAL) return "throttled";
    this.codeAttempts.set(client, [...mine, now]);
    if (!this.setupCode || now >= this.setupCodeExpires) return "wrong";
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
