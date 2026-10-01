import { randomBytes } from "node:crypto";
import { HaClient } from "./client";
import { passwordLogin, revokeRefreshToken } from "./oauth";

/** Display name of the HA user the proxy creates for itself. */
const PROXY_USER_NAME = "Guest Assistant";
const USERNAME_BASE = "guest-assistant";
/** Any client id works for HA's password login as long as the redirect URI shares its host. */
const LOGIN_CLIENT_ID = "http://guest-assistant.local/";
const LOGIN_REDIRECT_URI = "http://guest-assistant.local/callback";
const TOKEN_LIFESPAN_DAYS = 3650;

interface HaUserInfo {
  id: string;
  username: string | null;
  name: string;
  is_owner: boolean;
  system_generated: boolean;
  group_ids: string[];
}

export interface ProvisionedUser {
  userId: string;
  username: string;
  token: string;
}

/**
 * Creates the non-admin HA user the proxy acts as and a long-lived token for
 * it, using an admin connection (the admin's OAuth token or, as an app, the
 * Supervisor token). The random password is only used for the one login that
 * creates the token and is then forgotten.
 *
 * A user this proxy created before (`previousUserId`) is deleted afterwards,
 * so re-running the setup does not pile up users.
 */
export async function provisionProxyUser(opts: {
  admin: HaClient;
  haUrl: string;
  previousUserId?: string;
  localOnly: boolean;
}): Promise<ProvisionedUser> {
  const { admin, haUrl } = opts;
  const users = (await admin.sendCommand({ type: "config/auth/list" })) as HaUserInfo[];
  const taken = new Set(users.map((u) => u.username).filter(Boolean));
  let username = USERNAME_BASE;
  for (let i = 2; taken.has(username); i++) username = `${USERNAME_BASE}-${i}`;
  const password = randomBytes(32).toString("base64url");

  const created = (await admin.sendCommand({
    type: "config/auth/create",
    name: PROXY_USER_NAME,
    group_ids: ["system-users"],
    local_only: opts.localOnly,
  })) as { user: { id: string } };
  const userId = created.user.id;

  try {
    await admin.sendCommand({ type: "config/auth_provider/homeassistant/create", user_id: userId, username, password });
    const tokens = await passwordLogin(haUrl, { clientId: LOGIN_CLIENT_ID, redirectUri: LOGIN_REDIRECT_URI, username, password });
    let token: string;
    try {
      token = await HaClient.with({ url: haUrl, token: tokens.access_token }, async (client) => {
        const me = (await client.sendCommand({ type: "auth/current_user" })) as { is_admin?: boolean };
        if (me.is_admin) throw new Error("The new proxy user unexpectedly has admin rights");
        return (await client.sendCommand({
          type: "auth/long_lived_access_token",
          client_name: "Guest Assistant proxy",
          lifespan: TOKEN_LIFESPAN_DAYS,
        })) as string;
      });
    } finally {
      // The login session was only needed to mint the long-lived token.
      await revokeRefreshToken(haUrl, tokens.refresh_token);
    }

    const previous = opts.previousUserId ? users.find((u) => u.id === opts.previousUserId) : undefined;
    if (previous && previous.name === PROXY_USER_NAME && !previous.is_owner && !previous.system_generated) {
      await admin.sendCommand({ type: "config/auth/delete", user_id: previous.id }).catch((err) => {
        console.warn(`Could not delete the previous proxy user ${previous.id}:`, err);
      });
    }
    return { userId, username, token };
  } catch (err) {
    await admin.sendCommand({ type: "config/auth/delete", user_id: userId }).catch(() => {});
    throw err;
  }
}

/**
 * local_only users can only authenticate from the local network. That is
 * the safer choice, but breaks when the proxy reaches HA through a public
 * address, so it is only used for addresses that are clearly local.
 */
export function isLocalAddress(haUrl: string): boolean {
  const host = new URL(haUrl).hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host === "homeassistant" || host === "supervisor") return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return host === "::1" || /^f[cd]/i.test(host) || /^fe80:/i.test(host);
}
