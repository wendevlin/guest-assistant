import { resolve, sep } from "node:path";

/**
 * Serves the built admin page (admin-ui/, built with `bun run build:admin`).
 * Every URL inside it is relative, so the same files work under /admin/ and
 * behind HA's ingress prefix.
 */
const HEADERS = {
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function createAssetHandler(root: string) {
  const dir = resolve(root);

  return async function serveAsset(path: string): Promise<Response> {
    const name = path === "" ? "index.html" : path;
    let target: string;
    try {
      target = resolve(dir, decodeURIComponent(name));
    } catch {
      return new Response("Not Found", { status: 404 });
    }
    if (!target.startsWith(dir + sep)) return new Response("Not Found", { status: 404 });
    const file = Bun.file(target);
    if (!(await file.exists())) {
      if (name === "index.html") {
        return new Response("The admin page is not built yet. Run `bun run build:admin`.", { status: 503, headers: HEADERS });
      }
      return new Response("Not Found", { status: 404 });
    }
    // Bundled chunks carry a content hash in their name.
    const immutable = /-[a-z0-9]{8}\.(js|css|svg|png|woff2?)$/.test(name);
    return new Response(file, {
      headers: { ...HEADERS, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  };
}
