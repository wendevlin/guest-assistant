import type { BunFile } from "bun";

/**
 * The parts of the guest frontend that make it an installable web app and
 * that the proxy has a say in: the name under the icon and the service worker.
 */

const HEADERS = { "x-content-type-options": "nosniff", "cache-control": "no-cache" };

/** The build's manifest.json, read again only when the file changes. */
let manifest: { name: string; mtime: number; data: Record<string, unknown> } | undefined;

async function loadManifest(file: BunFile): Promise<Record<string, unknown> | null> {
  const name = file.name ?? "";
  if (manifest?.name === name && manifest.mtime === file.lastModified) return manifest.data;
  try {
    const data: unknown = await file.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    manifest = { name, mtime: file.lastModified, data: data as Record<string, unknown> };
    return manifest.data;
  } catch {
    return null;
  }
}

/**
 * The web app manifest of the build with the admin's app name. Public, like
 * HA's own: browsers fetch it before anyone signs in, and the name is on the
 * login page anyway.
 */
export async function serveManifest(file: BunFile | null, appName: string | undefined): Promise<Response> {
  if (!file) return new Response("Not Found", { status: 404 });
  const data = await loadManifest(file);
  if (!data) return new Response("Not Found", { status: 404 });
  const body = appName ? { ...data, name: appName, short_name: appName } : data;
  return new Response(JSON.stringify(body), {
    headers: { ...HEADERS, "content-type": "application/manifest+json;charset=utf-8" },
  });
}

/**
 * Sent as /sw.js when the build has none, e.g. after going back to a frontend
 * from before the guest app had a service worker. Browsers keep a service
 * worker whose script now 404s, so this one takes its place, drops its cache
 * and unregisters. Without a fetch handler, open pages go to the network.
 */
const UNREGISTER_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.registration.unregister()),
  );
});
`;

export function serveUnregisterWorker(): Response {
  return new Response(UNREGISTER_WORKER, {
    headers: { ...HEADERS, "content-type": "text/javascript;charset=utf-8" },
  });
}
