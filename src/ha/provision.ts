import { randomBytes } from "node:crypto";
import { HaClient, HaCommandError } from "./client";
import type { HaEndpoint } from "./endpoint";
import { passwordLogin, revokeRefreshToken } from "./oauth";

/** Display name of the HA user the proxy creates for itself. */
const PROXY_USER_NAME = "Guest Assistant";
const USERNAME_BASE = "guest-assistant";
/** Any client id works for HA's password login as long as the redirect URI shares its host. */
const LOGIN_CLIENT_ID = "http://guest-assistant.local/";
const LOGIN_REDIRECT_URI = "http://guest-assistant.local/callback";
const TOKEN_LIFESPAN_DAYS = 3650;
/** client_name of the long-lived token the proxy mints for its user. */
const TOKEN_CLIENT_NAME = "Guest Assistant proxy";
const REVOKE_TIMEOUT_MS = 5_000;

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
          client_name: TOKEN_CLIENT_NAME,
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

interface HaRefreshToken {
  id: string;
  client_name: string | null;
  type: string;
  is_current?: boolean;
}

/**
 * Deletes the long-lived token the proxy minted for its user in a Home
 * Assistant it no longer uses, logged in with that token: a user may delete
 * its own tokens, while deleting the user needs an admin of that Home
 * Assistant. Tokens named otherwise are left alone (the stored token may not
 * be one the proxy minted). Returns how many were deleted.
 *
 * Fails after a short timeout: the old Home Assistant may be gone.
 */
export async function revokeProxyToken(endpoint: HaEndpoint, timeoutMs = REVOKE_TIMEOUT_MS): Promise<number> {
  const clients: HaClient[] = [];
  const connect = async () => {
    const client = new HaClient(endpoint);
    clients.push(client);
    await client.connect();
    return client;
  };
  const revoke = async () => {
    const client = await connect();
    const tokens = (await client.sendCommand({ type: "auth/refresh_tokens" })) as HaRefreshToken[];
    const own = tokens.filter((t) => t.client_name === TOKEN_CLIENT_NAME && t.type === "long_lived_access_token");
    const current = own.find((t) => t.is_current);
    for (const other of own.filter((t) => t !== current)) {
      await client.sendCommand({ type: "auth/delete_refresh_token", refresh_token_id: other.id });
    }
    if (current) {
      // HA drops the connection as soon as the token it runs on is gone,
      // without answering. Close it first (instead of HaClient reconnecting)
      // and check that HA refuses the token now.
      client.sendCommand({ type: "auth/delete_refresh_token", refresh_token_id: current.id }).catch(() => {});
      client.close();
      const refused = await connect().then(
        () => false,
        (err: unknown) => {
          if (err instanceof HaCommandError && err.code === "auth_invalid") return true;
          throw err;
        },
      );
      if (!refused) throw new Error("Home Assistant still accepts the token");
    }
    return own.length;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
  });
  try {
    return await Promise.race([revoke(), timeout]);
  } finally {
    clearTimeout(timer);
    for (const client of clients) client.close();
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
