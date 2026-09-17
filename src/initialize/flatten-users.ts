import type { Config } from "../config";

export type FlatUser = {
  username: string;
  password: string;
  dashboard: string;
};

export function flattenUsers(config: Config): FlatUser[] {
  const allUsers: FlatUser[] = [];
  for (const dashboard of config.dashboards) {
    if (dashboard.users.length === 0) {
      console.warn(`Dashboard "${dashboard.id}" has no users — skipping.`);
      continue;
    }
    for (const user of dashboard.users) {
      allUsers.push({
        username: user.username,
        password: user.password,
        dashboard: dashboard.id,
      });
    }
  }

  // Deduplicate by username (must be globally unique), warn on duplicates
  const seen = new Map<string, FlatUser>();
  for (const user of allUsers) {
    if (seen.has(user.username)) {
      console.warn(
        `Duplicate username "${user.username}" — ignoring duplicate.`,
      );
    } else {
      seen.set(user.username, user);
    }
  }

  return [...seen.values()];
}
