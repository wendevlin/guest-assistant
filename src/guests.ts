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
}

/** Accounts from before the field existed have no value and count as active. */
export function isGuestEnabled(user: object): boolean {
  const enabled = (user as { enabled?: unknown }).enabled;
  return enabled !== false && enabled !== 0;
}

function emailFor(username: string): string {
  return `${username.toLowerCase()}@guest-assistant.local`;
}

function toGuest(u: UserRow): Guest {
  return {
    id: u.id,
    username: u.displayUsername || u.username || u.name,
    dashboard: u.dashboard ?? "",
    enabled: isGuestEnabled(u),
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

  async create(input: { username: string; password: string; dashboard: string; enabled?: boolean }): Promise<Guest> {
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

  /** Returns the updated guest. Password, dashboard and deactivation end the guest's sessions. */
  async update(id: string, changes: { password?: string; dashboard?: string; enabled?: boolean }): Promise<Guest> {
    const { ctx, adapter } = await this.adapter();
    const existing = (await adapter.findUserById(id)) as unknown as UserRow | null;
    if (!existing) throw new GuestError("Guest not found");
    let endSessions = false;
    if (changes.password !== undefined) {
      await adapter.updatePassword(id, await ctx.password.hash(Password.parse(changes.password)));
      endSessions = true;
    }
    const fields: Record<string, string | boolean> = {};
    if (changes.dashboard !== undefined && changes.dashboard !== existing.dashboard) {
      fields.dashboard = changes.dashboard;
      endSessions = true;
    }
    if (changes.enabled !== undefined && changes.enabled !== isGuestEnabled(existing)) {
      fields.enabled = changes.enabled;
      if (!changes.enabled) endSessions = true;
    }
    if (Object.keys(fields).length > 0) await adapter.updateUser(id, fields);
    if (endSessions) await adapter.deleteUserSessions(id);
    return (await this.get(id))!;
  }

  async delete(id: string): Promise<void> {
    const { adapter } = await this.adapter();
    await adapter.deleteUserSessions(id);
    await adapter.deleteUser(id);
  }
}
