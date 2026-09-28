/**
 * Home Assistant's OAuth2 / IndieAuth flavour: no client registration, the
 * client_id is the URL of the client. HA accepts a redirect_uri on the same
 * scheme and host as the client_id without fetching anything from it.
 * See homeassistant/components/auth/indieauth.py.
 */

export interface HaTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

const TIMEOUT_MS = 10_000;

export class HaAuthError extends Error {}

export function authorizeUrl(haUrl: string, clientId: string, redirectUri: string, state: string): string {
  const url = new URL("/auth/authorize", haUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(haUrl: string, body: Record<string, string>): Promise<HaTokens> {
  const res = await fetch(new URL("/auth/token", haUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<HaTokens> & { error?: string; error_description?: string };
  if (!res.ok || typeof json.access_token !== "string") {
    throw new HaAuthError(`Home Assistant refused the token request: ${json.error_description ?? json.error ?? res.status}`);
  }
  return json as HaTokens;
}

export function exchangeCode(haUrl: string, code: string, clientId: string): Promise<HaTokens> {
  return tokenRequest(haUrl, { grant_type: "authorization_code", code, client_id: clientId });
}

/** Ends the HA session behind a refresh token. Errors are ignored: the token may already be gone. */
export async function revokeRefreshToken(haUrl: string, refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  try {
    await fetch(new URL("/auth/revoke", haUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // best effort
  }
}

/**
 * Logs in with username and password through HA's login flow, the same way
 * the HA login page does, and returns tokens for that user.
 */
export async function passwordLogin(
  haUrl: string,
  { clientId, redirectUri, username, password }: { clientId: string; redirectUri: string; username: string; password: string },
): Promise<HaTokens> {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(new URL(path, haUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new HaAuthError(`Home Assistant login flow failed (${res.status}): ${String(json.message ?? "")}`);
    return json;
  };

  const flow = await post("/auth/login_flow", { client_id: clientId, handler: ["homeassistant", null], redirect_uri: redirectUri });
  if (typeof flow.flow_id !== "string") throw new HaAuthError("Home Assistant did not start a login flow");
  const step = await post(`/auth/login_flow/${flow.flow_id}`, { client_id: clientId, username, password });
  if (step.type !== "create_entry" || typeof step.result !== "string") {
    const errors = step.errors ? JSON.stringify(step.errors) : String(step.type);
    throw new HaAuthError(`Home Assistant rejected the login of the proxy user: ${errors}`);
  }
  return exchangeCode(haUrl, step.result, clientId);
}

export type ProbeResult = { ok: true } | { ok: false; error: string };

/** Checks that a URL points at a reachable Home Assistant with its own login. */
export async function probeHa(haUrl: string): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetch(new URL("/auth/providers", haUrl), { signal: AbortSignal.timeout(5_000), redirect: "manual" });
  } catch (err) {
    return { ok: false, error: `Cannot reach ${haUrl}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const json = (await res.json().catch(() => null)) as unknown;
  // Older HA versions answer with a bare list, newer ones with { providers }.
  const providers = Array.isArray(json) ? json : (json as { providers?: unknown } | null)?.providers;
  if (!res.ok || !Array.isArray(providers)) return { ok: false, error: `${haUrl} does not look like Home Assistant` };
  if (!providers.some((p) => (p as { type?: string }).type === "homeassistant")) {
    return { ok: false, error: "This Home Assistant has no username/password login, which the proxy user needs" };
  }
  return { ok: true };
}
