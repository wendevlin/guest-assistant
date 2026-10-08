import { HaClient, HaCommandError } from "../ha/client";
import { normalizeHaUrl } from "../ha/endpoint";
import { isLocalAddress, provisionProxyUser, revokeProxyToken } from "../ha/provision";
import { coreUrl, supervisorCoreEndpoint } from "../ha/supervisor";
import type { Runtime } from "../runtime";
import type { HaSettings } from "../store";

/**
 * Creates the proxy's own HA user with an admin connection and switches the
 * runtime to it. The admin connection is closed afterwards; only the
 * non-admin user's token is stored.
 */
export async function connectWithAdmin(runtime: Runtime, admin: HaClient, haUrl: string, adminName: string): Promise<void> {
  const url = normalizeHaUrl(haUrl);
  const previous = runtime.haSettings;
  // `admin` can only delete the old proxy user if it lives in the same HA.
  const sameHa = previous?.url === url;
  const user = await provisionProxyUser({
    admin,
    haUrl: url,
    previousUserId: sameHa ? previous.user_id : undefined,
    localOnly: isLocalAddress(url),
  });
  console.log(`Created Home Assistant user "${user.username}" for the proxy (set up by ${adminName}).`);
  await runtime.setHaSettings({ url, token: user.token, user_id: user.userId, configured_by: adminName });
  if (previous && !sameHa) await leavePreviousHa(previous);
}

/**
 * After switching to a different Home Assistant, the old one would still
 * accept the proxy's 10-year token. The proxy revokes it with the token
 * itself; the old user can only be deleted by an admin of that HA.
 */
async function leavePreviousHa(previous: HaSettings): Promise<void> {
  const where = `the previous Home Assistant ${previous.url}`;
  const user = previous.user_id ? `the user "Guest Assistant" (id ${previous.user_id})` : "the user the proxy used";
  try {
    if ((await revokeProxyToken({ url: previous.url, token: previous.token })) > 0) {
      console.warn(`Revoked the proxy's token in ${where}. An administrator there can delete ${user} under Settings > People.`);
      return;
    }
    console.warn(`The proxy's token in ${where} was not created by Guest Assistant and was left alone.`);
  } catch (err) {
    // Already revoked, or the user was deleted: nothing is left to end.
    if (err instanceof HaCommandError && err.code === "auth_invalid") return;
    console.warn(`Could not revoke the proxy's token in ${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.warn(`Its token stays valid until an administrator of that Home Assistant deletes ${user} under Settings > People.`);
}

/** As an app, set-up needs no admin login: the Supervisor token acts as admin. */
export async function connectAsApp(runtime: Runtime, supervisorToken: string): Promise<void> {
  const url = await coreUrl(supervisorToken);
  await HaClient.with(supervisorCoreEndpoint(supervisorToken), (admin) => connectWithAdmin(runtime, admin, url, "Home Assistant app setup"));
}
