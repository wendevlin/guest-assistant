import { HaClient } from "../ha/client";
import { normalizeHaUrl } from "../ha/endpoint";
import { isLocalAddress, provisionProxyUser } from "../ha/provision";
import { coreUrl, supervisorCoreEndpoint } from "../ha/supervisor";
import type { Runtime } from "../runtime";

/**
 * Creates the proxy's own HA user with an admin connection and switches the
 * runtime to it. The admin connection is closed afterwards; only the
 * non-admin user's token is stored.
 */
export async function connectWithAdmin(runtime: Runtime, admin: HaClient, haUrl: string, adminName: string): Promise<void> {
  const url = normalizeHaUrl(haUrl);
  const previous = runtime.haSettings;
  const user = await provisionProxyUser({
    admin,
    haUrl: url,
    // Only replace the old proxy user if it lives in the same HA.
    previousUserId: previous?.url === url ? previous.user_id : undefined,
    localOnly: isLocalAddress(url),
  });
  console.log(`Created Home Assistant user "${user.username}" for the proxy (set up by ${adminName}).`);
  await runtime.setHaSettings({ url, token: user.token, user_id: user.userId, configured_by: adminName });
}

/** As an app, set-up needs no admin login: the Supervisor token acts as admin. */
export async function connectAsApp(runtime: Runtime, supervisorToken: string): Promise<void> {
  const url = await coreUrl(supervisorToken);
  await HaClient.with(supervisorCoreEndpoint(supervisorToken), (admin) => connectWithAdmin(runtime, admin, url, "Home Assistant app setup"));
}
