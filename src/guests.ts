import { randomBytes } from "node:crypto";
import z from "zod";
import type { Auth } from "./auth";

/** Same rule as better-auth's username plugin. */
const USERNAME_RE = /^[a-zA-Z0-9_.]+$/;

export const Username = z
  .string()
  .min(3, "username must be at least 3 characters")
  .max(30, "username must be at most 30 characters")
  .regex(USERNAME_RE, "username may only contain letters, digits, '_' and '.'");
export const Password = z.string().min(8, "password must be at least 8 characters").max(200);

export interface Guest {
  id: string;
  username: string;
  dashboard: string;
  /** Inactive guests keep their account but cannot use it. */
  enabled: boolean;
  /** When the guest is switched off automatically (ISO date), or null. */
  disableAt: string | null;
  /** Token of the guest's login link, or null without one. */
  loginLink: string | null;
}

export class GuestError extends Error {}

interface UserRow {
  id: string;
  email: string;
  name: string;
  username?: string | null;
  displayUsername?: string | null;
  dashboard?: string;
  enabled?: boolean | number | null;
  disableAt?: Date | string | null;
  loginLink?: string | null;
}

/**
 * Accounts from before the field existed have no value and count as active.
 * Past its `disableAt` a guest counts as inactive right away, even before
 * the runtime has switched it off (see Runtime.scheduleAutoDisable).
 */
export function isGuestEnabled(user: object): boolean {
  const { enabled, disableAt } = user as { enabled?: unknown; disableAt?: unknown };
  if (enabled === false || enabled === 0) return false;
  const at = disableAtTime(disableAt);
  return at === null || at > Date.now();
}

function disableAtTime(value: unknown): number | null {
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function emailFor(username: string): string {
  return `${username.toLowerCase()}@guest-assistant.local`;
}

function toIso(value: unknown): string | null {
  const time = disableAtTime(value);
  return time === null ? null : new Date(time).toISOString();
}

function toGuest(u: UserRow): Guest {
  return {
    id: u.id,
    username: u.displayUsername || u.username || u.name,
    dashboard: u.dashboard ?? "",
    enabled: isGuestEnabled(u),
    disableAt: toIso(u.disableAt),
    loginLink: u.loginLink || null,
  };
}

/**
 * Guest accounts, stored in better-auth's user table. Every change that
 * affects access ends the guest's sessions; callers also drop live
 * connections (see Runtime).
 */
export class Guests {
  constructor(private readonly auth: () => Auth) {}

  private async adapter() {
    const ctx = await this.auth().$context;
    return { ctx, adapter: ctx.internalAdapter };
  }

  async list(): Promise<Guest[]> {
    const { adapter } = await this.adapter();
    const users = (await adapter.listUsers()) as unknown as UserRow[];
    return users.map(toGuest).sort((a, b) => a.username.localeCompare(b.username));
  }

  async get(id: string): Promise<Guest | undefined> {
    const { adapter } = await this.adapter();
    const user = (await adapter.findUserById(id)) as unknown as UserRow | null;
    return user ? toGuest(user) : undefined;
  }

  async create(input: { username: string; password: string; dashboard: string; enabled?: boolean; disableAt?: Date | null }): Promise<Guest> {
    const username = Username.parse(input.username);
    const password = Password.parse(input.password);
    const { ctx, adapter } = await this.adapter();
    if (await adapter.findUserByEmail(emailFor(username))) throw new GuestError(`A guest named "${username}" already exists`);
    const created = await adapter.createUser(
      {
        email: emailFor(username),
        emailVerified: true,
        name: username,
        username: username.toLowerCase(),
        displayUsername: username,
        dashboard: input.dashboard,
        enabled: input.enabled ?? true,
        disableAt: input.disableAt ?? null,
      },
      { method: "admin" },
    );
    await adapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: await ctx.password.hash(password),
    });
    return toGuest(created as unknown as UserRow);
  }

  /**
   * Returns the updated guest. Password, dashboard and deactivation end the
   * guest's sessions. Switching a guest off also drops its `disableAt`: once
   * switched back on, it stays on until the admin sets a new time.
   */
  async update(id: string, changes: { password?: string; dashboard?: string; enabled?: boolean; disableAt?: Date | null }): Promise<Guest> {
    const { ctx, adapter } = await this.adapter();
    const existing = (await adapter.findUserById(id)) as unknown as UserRow | null;
    if (!existing) throw new GuestError("Guest not found");
    let endSessions = false;
    if (changes.password !== undefined) {
      await adapter.updatePassword(id, await ctx.password.hash(Password.parse(changes.password)));
      endSessions = true;
    }
    const fields: Record<string, string | boolean | Date | null> = {};
    if (changes.dashboard !== undefined && changes.dashboard !== existing.dashboard) {
      fields.dashboard = changes.dashboard;
      endSessions = true;
    }
    if (changes.disableAt !== undefined) fields.disableAt = changes.disableAt;
    if (changes.enabled === false && disableAtTime(existing.disableAt) !== null) {
      fields.disableAt = null;
    } else if (changes.enabled === true && changes.disableAt === undefined && (disableAtTime(existing.disableAt) ?? Infinity) <= Date.now()) {
      // Switched back on after its time ran out: no longer limited.
      fields.disableAt = null;
    }
    // Compared with the stored flag: a guest past its disableAt that is not
    // switched off yet still gets switched off.
    const storedEnabled = existing.enabled !== false && existing.enabled !== 0;
    if (changes.enabled !== undefined && changes.enabled !== storedEnabled) {
      fields.enabled = changes.enabled;
      if (!changes.enabled) endSessions = true;
    }
    if (Object.keys(fields).length > 0) await adapter.updateUser(id, fields);
    if (endSessions) await adapter.deleteUserSessions(id);
    return (await this.get(id))!;
  }

  /**
   * Gives the guest a new login link, replacing the old one, or removes it
   * (null). Sessions signed in with the old link stay; switch the guest off
   * to end them.
   */
  async setLoginLink(id: string, token: string | null): Promise<Guest> {
    const { adapter } = await this.adapter();
    if (!(await adapter.findUserById(id))) throw new GuestError("Guest not found");
    await adapter.updateUser(id, { loginLink: token });
    return (await this.get(id))!;
  }

  /**
   * Checks a guest's username and password without creating a session
   * (companion app logins keep their own record, see companion/tokens.ts).
   * Unknown usernames are checked against a dummy hash, so the answer takes
   * as long as for a wrong password. Disabled guests are returned too; the
   * caller tells them apart.
   */
  async verifyPassword(username: string, password: string): Promise<Guest | null> {
    const { ctx, adapter } = await this.adapter();
    this.dummyHash ??= ctx.password.hash(randomBytes(16).toString("hex"));
    const parsed = Username.safeParse(username);
    const found = parsed.success ? await adapter.findUserByEmail(emailFor(parsed.data), { includeAccounts: true }) : null;
    const credential = found?.accounts.find((a) => a.providerId === "credential" && a.password);
    const ok = await ctx.password.verify({ password, hash: credential?.password ?? (await this.dummyHash) });
    return ok && found && credential ? toGuest(found.user as unknown as UserRow) : null;
  }

  private dummyHash?: Promise<string>;

  async delete(id: string): Promise<void> {
    const { adapter } = await this.adapter();
    await adapter.deleteUserSessions(id);
    await adapter.deleteUser(id);
  }
}
