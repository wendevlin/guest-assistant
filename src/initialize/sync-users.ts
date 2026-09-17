import type { Auth } from "../auth";
import type { FlatUser } from "./flatten-users";

/**
 * Makes the better-auth user table mirror config.yaml: creates missing users,
 * updates changed passwords/dashboards (invalidating sessions), removes users
 * that are no longer configured.
 *
 * Returns the ids of users whose access changed so callers can drop live
 * connections.
 */
export async function syncUsers(auth: Auth, users: FlatUser[]): Promise<{ changedUserIds: string[] }> {
  const ctx = await auth.$context;
  const adapter = ctx.internalAdapter;
  const existingUsers = await adapter.listUsers();
  const changedUserIds: string[] = [];

  const existingByEmail = new Map<string, (typeof existingUsers)[number]>();
  for (const u of existingUsers) {
    if (u.email) existingByEmail.set(u.email, u);
  }

  const configEmails = new Set<string>();

  for (const configUser of users) {
    const email = emailFor(configUser.username);
    configEmails.add(email);
    const existing = existingByEmail.get(email);

    if (!existing) {
      console.log(`Creating user "${configUser.username}" for dashboard "${configUser.dashboard}".`);
      const created = await adapter.createUser(
        {
          email,
          emailVerified: true,
          name: configUser.username,
          username: configUser.username.toLowerCase(),
          displayUsername: configUser.username,
          dashboard: configUser.dashboard,
        },
        { method: "admin" },
      );
      await adapter.linkAccount({
        userId: created.id,
        providerId: "credential",
        accountId: created.id,
        password: await ctx.password.hash(configUser.password),
      });
      continue;
    }

    let changed = false;
    const credential = await adapter.findCredentialAccount(existing.id);
    const passwordMatches =
      credential?.password !== undefined && credential.password !== null
        ? await ctx.password.verify({ password: configUser.password, hash: credential.password })
        : false;
    if (!passwordMatches) {
      console.log(`Updating password for user "${configUser.username}".`);
      await adapter.updatePassword(existing.id, await ctx.password.hash(configUser.password));
      changed = true;
    }

    const currentDashboard = (existing as { dashboard?: string }).dashboard;
    if (currentDashboard !== configUser.dashboard) {
      console.log(`Moving user "${configUser.username}" to dashboard "${configUser.dashboard}".`);
      await adapter.updateUser(existing.id, { dashboard: configUser.dashboard });
      changed = true;
    }

    if (changed) {
      await adapter.deleteUserSessions(existing.id);
      changedUserIds.push(existing.id);
    }
  }

  for (const [email, existing] of existingByEmail) {
    if (configEmails.has(email)) continue;
    console.log(`Removing user "${existing.name}" (not in config).`);
    await adapter.deleteUserSessions(existing.id);
    await adapter.deleteUser(existing.id);
    changedUserIds.push(existing.id);
  }

  return { changedUserIds };
}

function emailFor(username: string): string {
  return `${username.toLowerCase()}@guest-assistant.local`;
}
