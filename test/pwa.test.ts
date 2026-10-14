import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AdminSessions } from "../src/admin/sessions";
import { Runtime } from "../src/runtime";
import { createServer } from "../src/server";
import { Store } from "../src/store";
import { randomPort, testEnvConfig } from "./helpers";

const INLINE = 'import("/frontend_latest/entrypoint.0123456789abcdef.js")';
const INDEX = `<!doctype html><html><head><title>Guest Assistant</title><meta name=apple-mobile-web-app-title content="Guest Assistant"><link rel=manifest href=/manifest.json></head><body><ha-guest-assistant></ha-guest-assistant><script>${INLINE}</script></body></html>`;
const MANIFEST = { id: "/", name: "Guest Assistant", short_name: "Guest Assistant", start_url: "/", display: "standalone" };

/** A guest frontend build with the kinds of files a real one has. */
const FILES: Record<string, string> = {
  "index.html": INDEX,
  "manifest.json": JSON.stringify(MANIFEST),
  "sw.js": "self.addEventListener('fetch', () => {});",
  "build.json": '{"build":"2026.10.14-abcdef123"}',
  "frontend_latest/entrypoint.0123456789abcdef.js": "export {};",
  "frontend_latest/entrypoint.0123456789abcdef.js.map": "{}",
  "frontend_latest/12.fedcba9876543210.js.LICENSE.txt": "MIT",
  "frontend_latest/34.00112233445566aa.woff2": "font",
  "frontend_latest/maplibre-gl-worker.20260930.2.js": "worker",
  "frontend_latest/manifest.json": "{}",
  "frontend_es5/entrypoint.0123456789abcdef.js": "var a;",
  "static/translations/de-0123456789abcdef0123456789abcdef.json": "{}",
  "static/translations/de-dev.json": "{}",
  "static/mdi/0123456789abcdef0123456789abcdef01234567.json": "{}",
  "static/mdi/iconMetadata.json": "{}",
  "static/fonts/roboto/Roboto-Regular.woff2": "font",
  "static/icons/favicon.ico": "ico",
};

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

let repo: string;
let dist: string;
let server: ReturnType<typeof createServer>["server"];
let runtime: Runtime;
let url: string;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "pwa-"));
  dist = join(repo, "guest-assistant/dist");
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  const port = randomPort();
  runtime = new Runtime({ ...testEnvConfig(port), frontendRepo: repo }, Store.memory(), "standalone");
  await runtime.init();
  server = createServer(runtime, new AdminSessions(), port).server;
  url = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  runtime.close();
  rmSync(repo, { recursive: true });
});

describe("caching", () => {
  // A new build must reach guests on their next load: only files whose name
  // changes with their content may be kept without asking.
  test("only content-hashed files are immutable", async () => {
    const immutable = [
      "/frontend_latest/entrypoint.0123456789abcdef.js",
      "/frontend_latest/entrypoint.0123456789abcdef.js.map",
      "/frontend_latest/12.fedcba9876543210.js.LICENSE.txt",
      "/frontend_latest/34.00112233445566aa.woff2",
      "/frontend_es5/entrypoint.0123456789abcdef.js",
      "/static/translations/de-0123456789abcdef0123456789abcdef.json",
      "/static/mdi/0123456789abcdef0123456789abcdef01234567.json",
    ];
    const revalidated = [
      "/sw.js",
      "/build.json",
      "/frontend_latest/maplibre-gl-worker.20260930.2.js",
      "/frontend_latest/manifest.json",
      "/static/translations/de-dev.json",
      "/static/mdi/iconMetadata.json",
      "/static/fonts/roboto/Roboto-Regular.woff2",
      "/static/icons/favicon.ico",
    ];
    for (const path of immutable) {
      const res = await fetch(`${url}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("public, max-age=31536000, immutable");
    }
    for (const path of revalidated) {
      const res = await fetch(`${url}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
      expect(res.headers.get("etag"), path).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    }
  });

  test("the page is revalidated on every load, also as SPA fallback", async () => {
    for (const path of ["/", "/index.html", "/guest-dash/0"]) {
      const res = await fetch(`${url}${path}`, { headers: { accept: "text/html" } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
      expect(res.headers.get("content-security-policy"), path).toContain(sha256(INLINE));
    }
  });

  test("an unchanged file is answered with 304, a changed one in full", async () => {
    const path = "/static/icons/favicon.ico";
    const first = await fetch(`${url}${path}`);
    const etag = first.headers.get("etag")!;
    for (const header of [etag, etag.slice(2), `W/"other", ${etag}`, "*"]) {
      const res = await fetch(`${url}${path}`, { headers: { "if-none-match": header } });
      expect(res.status, header).toBe(304);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toBe("");
    }
    expect((await fetch(`${url}${path}`, { method: "HEAD", headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await fetch(`${url}${path}`, { headers: { "if-none-match": 'W/"other"' } })).status).toBe(200);

    writeFileSync(join(dist, path), "new icon");
    utimesSync(join(dist, path), 5_000, 5_000);
    const changed = await fetch(`${url}${path}`, { headers: { "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe("new icon");
    expect(changed.headers.get("etag")).not.toBe(etag);
  });
});

describe("app name", () => {
  test("without one, the build's manifest and page are sent as they are", async () => {
    const res = await fetch(`${url}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.json()).toEqual(MANIFEST);
    expect(await (await fetch(`${url}/`, { headers: { accept: "text/html" } })).text()).toBe(INDEX);
  });

  test("names the manifest, the title and the iOS home screen title", async () => {
    const name = `Tom &amp; <b>"Jerry"</b>`;
    runtime.setAppName(name);
    try {
      expect(await (await fetch(`${url}/manifest.json`)).json()).toEqual({ ...MANIFEST, name, short_name: name });

      const res = await fetch(`${url}/`, { headers: { accept: "text/html" } });
      const html = await res.text();
      expect(html).toContain("<title>Tom &amp;amp; &lt;b&gt;\"Jerry\"&lt;/b&gt;</title>");
      // Escaped so that a browser reads exactly the name back.
      expect(html).toContain('content="Tom &amp;amp; <b>&quot;Jerry&quot;</b>"');
      // The inline script is untouched, so the policy still fits.
      expect(html).toContain(`<script>${INLINE}</script>`);
      expect(res.headers.get("content-security-policy")).toContain(sha256(INLINE));
    } finally {
      runtime.setAppName(undefined);
    }
    expect(((await (await fetch(`${url}/manifest.json`)).json()) as { name: string }).name).toBe("Guest Assistant");
  });

  test("a build without a manifest has none", async () => {
    rmSync(join(dist, "manifest.json"));
    try {
      expect((await fetch(`${url}/manifest.json`)).status).toBe(404);
    } finally {
      writeFileSync(join(dist, "manifest.json"), FILES["manifest.json"]!);
    }
  });
});

describe("service worker", () => {
  test("is the build's own", async () => {
    const res = await fetch(`${url}/sw.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILES["sw.js"]!);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  // Browsers keep an installed worker whose script now 404s.
  test("a build without one gets a worker that removes itself", async () => {
    rmSync(join(dist, "sw.js"));
    try {
      const res = await fetch(`${url}/sw.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const body = await res.text();
      expect(body).toContain("self.registration.unregister()");
      expect(body).toContain("caches.delete");
      expect(body).not.toContain('"fetch"');
    } finally {
      writeFileSync(join(dist, "sw.js"), FILES["sw.js"]!);
    }
  });
});
