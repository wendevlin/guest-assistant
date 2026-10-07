import { HaClient } from "./client";
import type { HaEndpoint } from "./endpoint";

/**
 * Running as a Home Assistant app (add-on). The Supervisor gives the app a
 * token with admin rights on HA core. The proxy uses it only for admin work
 * (creating its own non-admin user, checking who opens the admin page),
 * never for guest traffic.
 */

/** Ingress requests always come from the Supervisor at this address. */
export const SUPERVISOR_IP = "172.30.32.2";

export function supervisorCoreEndpoint(token: string): HaEndpoint {
  return { url: "http://supervisor/core", wsUrl: "ws://supervisor/core/websocket", token };
}

async function supervisorGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`http://supervisor${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Supervisor ${path} answered ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

/** Where the app reaches HA core directly (guest traffic). */
export async function coreUrl(token: string): Promise<string> {
  const info = await supervisorGet<{ port?: number; ssl?: boolean }>(token, "/core/info");
  return `${info.ssl ? "https" : "http"}://homeassistant:${info.port ?? 8123}`;
}

/** Path of this app's panel in the HA frontend, for links in notifications. */
export async function ingressPanelPath(token: string): Promise<string | undefined> {
  try {
    const info = await supervisorGet<{ slug?: string }>(token, "/addons/self/info");
    return info.slug ? `/hassio/ingress/${info.slug}` : undefined;
  } catch {
    return undefined;
  }
}

interface CoreUser {
  id: string;
  name: string;
  is_owner: boolean;
  is_active: boolean;
  group_ids: string[];
}

/** Short, so an admin who loses admin rights in HA loses the admin page within seconds. */
const ADMIN_CACHE_MS = 10_000;
const adminCache = new Map<string, { admin: boolean; name: string; until: number }>();

/**
 * Ingress lets any logged-in HA user open the app's page (non-admins can
 * create ingress sessions too), so the admin page checks the user itself.
 */
export async function lookupIngressUser(token: string, userId: string): Promise<{ admin: boolean; name: string }> {
  const cached = adminCache.get(userId);
  if (cached && cached.until > Date.now()) return cached;
  const users = (await HaClient.with(supervisorCoreEndpoint(token), (c) => c.sendCommand({ type: "config/auth/list" }))) as CoreUser[];
  const user = users.find((u) => u.id === userId);
  const entry = {
    admin: !!user && user.is_active && (user.is_owner || user.group_ids.includes("system-admin")),
    name: user?.name ?? "unknown",
    until: Date.now() + ADMIN_CACHE_MS,
  };
  adminCache.set(userId, entry);
  return entry;
}
