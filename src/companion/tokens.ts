import { createHash, randomBytes } from "node:crypto";
import { decodeJWT, JWT_TTL_SECONDS, signJWT, tokenKid, verifyJWT, type GuestTokenPayload } from "../jwt";
import type { Store } from "../store";

/** Header `kid` of companion app access tokens. */
export const APP_TOKEN_KID = "app";

/** Logins unused for this long are removed (the app then asks to sign in again). */
export const APP_TOKEN_MAX_IDLE_DAYS = 90;

/** What a companion app tells about itself when it registers. */
export interface DeviceInfo {
  app_id: string;
  app_name: string;
  app_version: string;
  device_name: string;
  manufacturer: string;
  model: string;
  os_name: string;
  os_version?: string;
}

/**
 * One companion app login: created when an app exchanges its authorization
 * code, ended by the app (revoke), the admin (remove device), or a change to
 * the guest. The id is the `sid` of the access tokens minted for it.
 */
export interface AppTokenRow {
  id: string;
  user_id: string;
  client_id: string;
  /**
   * Bumped when the guest's dashboard changes or the guest is switched off:
   * access tokens of an older generation are refused, the next refresh mints
   * one for the current dashboard.
   */
  generation: number;
  created_at: string;
  last_used_at: string;
  webhook_id: string | null;
  device: DeviceInfo | null;
}

interface Row extends Omit<AppTokenRow, "device"> {
  token_hash: string;
  device: string | null;
}

const COLUMNS = "id, user_id, client_id, token_hash, generation, created_at, last_used_at, webhook_id, device";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function toRow(row: Row): AppTokenRow {
  let device: DeviceInfo | null = null;
  try {
    device = row.device ? (JSON.parse(row.device) as DeviceInfo) : null;
  } catch {
    // a corrupt record only loses the device name
  }
  const { token_hash: _, ...rest } = row;
  return { ...rest, device };
}

/**
 * Companion app logins, kept in SQLite: the apps hold their refresh token for
 * months and the proxy restarts on every update.
 *
 * Their access tokens are signed with a secret kept in the database (the
 * guest page's tokens use a per-process one), because the apps' native part
 * keeps using a token until it expires. In exchange every use is checked
 * against the login's row, so removing a row ends its tokens at once.
 */
export class AppTokens {
  private readonly secret: Buffer;

  constructor(
    private readonly store: Store,
    /** Companion app support is switched on; otherwise no app token is accepted. */
    private readonly enabled: () => boolean,
  ) {
    let secret = store.get("app_jwt_secret");
    if (!secret) {
      secret = randomBytes(32).toString("base64url");
      store.set("app_jwt_secret", secret);
    }
    this.secret = Buffer.from(secret, "base64url");
  }

  private get db() {
    return this.store.db;
  }

  /** Starts a login. The refresh token is returned once and only its hash is kept. */
  create(userId: string, clientId: string): { row: AppTokenRow; refreshToken: string } {
    const refreshToken = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const id = `dev_${randomBytes(16).toString("hex")}`;
    this.db
      .query(`INSERT INTO ga_app_tokens (${COLUMNS}) VALUES (?, ?, ?, ?, 0, ?, ?, NULL, NULL)`)
      .run(id, userId, clientId, hash(refreshToken), now, now);
    return { row: this.get(id)!, refreshToken };
  }

  get(id: string): AppTokenRow | undefined {
    const row = this.db.query<Row, [string]>(`SELECT ${COLUMNS} FROM ga_app_tokens WHERE id = ?`).get(id);
    return row ? toRow(row) : undefined;
  }

  findByRefreshToken(token: string): AppTokenRow | undefined {
    const row = this.db.query<Row, [string]>(`SELECT ${COLUMNS} FROM ga_app_tokens WHERE token_hash = ?`).get(hash(token));
    return row ? toRow(row) : undefined;
  }

  findByWebhookId(webhookId: string): AppTokenRow | undefined {
    const row = this.db.query<Row, [string]>(`SELECT ${COLUMNS} FROM ga_app_tokens WHERE webhook_id = ?`).get(webhookId);
    return row ? toRow(row) : undefined;
  }

  listForUser(userId: string): AppTokenRow[] {
    return this.db
      .query<Row, [string]>(`SELECT ${COLUMNS} FROM ga_app_tokens WHERE user_id = ? ORDER BY created_at`)
      .all(userId)
      .map(toRow);
  }

  listAll(): AppTokenRow[] {
    return this.db.query<Row, []>(`SELECT ${COLUMNS} FROM ga_app_tokens ORDER BY created_at`).all().map(toRow);
  }

  touch(id: string): void {
    this.db.query("UPDATE ga_app_tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  /** Stores what the app registered with; a new registration replaces the webhook id. */
  setRegistration(id: string, webhookId: string, device: DeviceInfo): void {
    this.db.query("UPDATE ga_app_tokens SET webhook_id = ?, device = ? WHERE id = ?").run(webhookId, JSON.stringify(device), id);
  }

  updateDevice(id: string, device: DeviceInfo): void {
    this.db.query("UPDATE ga_app_tokens SET device = ? WHERE id = ?").run(JSON.stringify(device), id);
  }

  delete(id: string): boolean {
    return this.db.query("DELETE FROM ga_app_tokens WHERE id = ?").run(id).changes > 0;
  }

  /** Removes the logins of a guest; returns their ids. */
  deleteForUser(userId: string): string[] {
    const ids = this.listForUser(userId).map((r) => r.id);
    this.db.query("DELETE FROM ga_app_tokens WHERE user_id = ?").run(userId);
    return ids;
  }

  /** Removes every login; returns their ids. */
  deleteAll(): string[] {
    const ids = this.listAll().map((r) => r.id);
    this.db.exec("DELETE FROM ga_app_tokens");
    return ids;
  }

  /** Refuses the current access tokens of a guest's logins; their refresh tokens keep working. */
  bumpGeneration(userId: string): void {
    this.db.query("UPDATE ga_app_tokens SET generation = generation + 1 WHERE user_id = ?").run(userId);
  }

  /** Removes logins unused for `days`; returns their ids. */
  prune(days = APP_TOKEN_MAX_IDLE_DAYS): string[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const ids = this.db.query<{ id: string }, [string]>("SELECT id FROM ga_app_tokens WHERE last_used_at < ?").all(cutoff).map((r) => r.id);
    this.db.query("DELETE FROM ga_app_tokens WHERE last_used_at < ?").run(cutoff);
    return ids;
  }

  /** An access token for the login, bound to the guest's current dashboard. */
  sign(row: AppTokenRow, user: { id: string; name?: string }, dashboardId: string): string {
    const now = Date.now();
    return signJWT(
      { sub: user.id, sid: row.id, dashboard: dashboardId, name: user.name, gen: row.generation, iat: now, exp: Math.floor(now / 1000) + JWT_TTL_SECONDS },
      { secret: this.secret, kid: APP_TOKEN_KID },
    );
  }

  /**
   * Checks an access token: signature, expiry (unless `ignoreExpiry`), and
   * that its login still exists for that guest in that generation.
   * Synchronous (bun:sqlite), so the WebSocket handshake stays synchronous.
   */
  verify(token: string, { ignoreExpiry = false } = {}): GuestTokenPayload | null {
    if (!this.enabled() || tokenKid(token) !== APP_TOKEN_KID) return null;
    const payload = decodeJWT(token, this.secret);
    if (!payload) return null;
    if (!ignoreExpiry && Date.now() / 1000 > payload.exp) return null;
    const row = this.get(payload.sid);
    if (!row || row.user_id !== payload.sub || row.generation !== payload.gen) return null;
    return payload;
  }
}

export type TokenKind = "session-token" | "app-token";

export interface ResolvedToken {
  payload: GuestTokenPayload;
  kind: TokenKind;
}

/** Verifies a token of either kind: the guest page's hass-token or a companion app token. */
export function resolveGuestToken(token: string, appTokens: AppTokens): ResolvedToken | null {
  if (tokenKid(token) === APP_TOKEN_KID) {
    const payload = appTokens.verify(token);
    return payload ? { payload, kind: "app-token" } : null;
  }
  const payload = verifyJWT(token);
  return payload ? { payload, kind: "session-token" } : null;
}
