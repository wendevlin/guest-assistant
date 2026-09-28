/**
 * Where and as whom the proxy talks to Home Assistant.
 */
export interface HaEndpoint {
  /** Base URL of HA's HTTP server, e.g. http://homeassistant.local:8123 (no trailing slash). */
  url: string;
  /** WebSocket URL; defaults to `<url>/api/websocket`. The Supervisor proxy uses a different path. */
  wsUrl?: string;
  token: string;
}

export function haWsUrl(endpoint: Pick<HaEndpoint, "url" | "wsUrl">): string {
  return endpoint.wsUrl ?? `${endpoint.url.replace(/^http/, "ws")}/api/websocket`;
}

/**
 * Normalises what an admin typed or discovery found into a base URL:
 * adds http:// and HA's default port when missing, drops paths and slashes.
 * Throws on anything that is not an http(s) URL.
 */
export function normalizeHaUrl(input: string): string {
  let raw = input.trim();
  if (!/^[a-z]+:\/\//i.test(raw)) {
    const hasPort = /^(\[[^\]]+\]|[^/:]+):\d+/.test(raw);
    raw = `http://${raw}${hasPort ? "" : ":8123"}`;
  }
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported");
  if (url.username || url.password) throw new Error("URLs with credentials are not supported");
  return url.origin;
}
