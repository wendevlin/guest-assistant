import type { BunFile } from "bun";
import { createHash } from "node:crypto";

/**
 * Headers for the guest frontend build. The guest page holds a session and a
 * hass-token and renders admin-written markdown and entity names, so its HTML
 * gets a Content-Security-Policy. Other build files only need nosniff: a CSP
 * on a script response would become the policy of a worker started from it.
 */
const FILE_HEADERS = { "x-content-type-options": "nosniff" };

/**
 * Build files that carry a content hash in their name. A new build gives them
 * new names, so browsers may keep them for good:
 * - bundles, source maps and asset modules: `<name>.<xxhash64>.<ext>`,
 * - translations: `<language>-<md5>.json`,
 * - icon sets: `<sha1>.json`.
 * Everything else keeps its name from build to build (index.html, sw.js,
 * build.json, icons, fonts, locale data, the map worker, …) and is
 * revalidated on every use, so a new build reaches guests on their next load.
 */
const IMMUTABLE = [
  /^\/frontend_(?:latest|es5)\/[^/]+\.[0-9a-f]{16}\.[\w.]+$/,
  /^\/static\/translations\/[^/]+-[0-9a-f]{32}\.json$/,
  /^\/static\/mdi\/[0-9a-f]{40}\.json$/,
];

const isImmutable = (pathname: string) => IMMUTABLE.some((re) => re.test(pathname));

/** Size and modification time stand in for the content: a new build rewrites the file. */
const etagOf = (file: BunFile) => `W/"${file.size.toString(16)}-${Math.trunc(file.lastModified).toString(16)}"`;

/** RFC 9110 weak comparison of If-None-Match against our ETag. */
function notModified(request: Request, etag: string): boolean {
  const header = request.headers.get("if-none-match");
  if (!header) return false;
  if (header.trim() === "*") return true;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => strip(tag) === strip(etag));
}

/**
 * A Host header usable as CSP host-source. The grammar has no IPv6 literals,
 * and anything else could end the directive early.
 */
const CSP_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;

/** `'sha256-…'` sources for the inline scripts of an HTML document, in order. */
function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const [, attrs = "", body = ""] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\ssrc\s*=/i.test(attrs)) continue;
    // The browser hashes the text after the HTML parser normalised newlines.
    const text = body.replace(/\r\n?/g, "\n");
    hashes.add(`'sha256-${createHash("sha256").update(text).digest("base64")}'`);
  }
  return [...hashes];
}

/**
 * The policy for a page whose inline scripts have these hashes. Same-origin by
 * default; the exceptions are what the stock frontend needs:
 * - connect: Web Awesome icons fetch their SVG from data: URLs; older Safari
 *   does not match WebSockets with 'self', so the request's host is listed
 *   for ws: and wss: as well,
 * - styles: Lit components and index.html use inline `<style>`,
 * - images: entity pictures and picture card images may point anywhere or be
 *   data: URLs, the map card draws its sprites from blob: URLs,
 * - media: HLS plays through MediaSource (blob: URLs),
 * - fonts: the calendar card embeds an icon font as a data: URL,
 * - workers: the map card starts its workers from blob: URLs.
 * The iframe card is hidden from guests and nothing else embeds frames.
 */
export function guestPagePolicy(scriptHashes: string[], host: string): string {
  const sockets = CSP_HOST.test(host) ? ` ws://${host} wss://${host}` : "";
  return [
    "default-src 'self'",
    ["script-src 'self'", ...scriptHashes].join(" "),
    `connect-src 'self' data:${sockets}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

interface Page {
  mtime: number;
  html: string;
  hashes: string[];
  /** The HTML with the app name set, for the last name asked for. */
  named?: { appName: string; html: string };
}

/** HTML of the build, read again only when the file changes. */
const pages = new Map<string, Page>();

async function loadPage(file: BunFile): Promise<Page> {
  const key = file.name ?? "";
  const mtime = file.lastModified;
  const cached = pages.get(key);
  if (cached?.mtime === mtime) return cached;
  const html = await file.text();
  const page = { mtime, html, hashes: inlineScriptHashes(html) };
  pages.set(key, page);
  return page;
}

/**
 * The page with the admin's app name as its title: iOS names a web app added
 * to the home screen after `apple-mobile-web-app-title`, falling back to the
 * title. Neither touches a script, so the hashes stay valid.
 */
function namedHtml(page: Page, appName: string): string {
  if (page.named?.appName === appName) return page.named.html;
  // setAttribute only escapes quotes; an ampersand would start a character reference.
  const attribute = appName.replaceAll("&", "&amp;");
  const html = new HTMLRewriter()
    .on("title", { element: (el) => void el.setInnerContent(appName) })
    .on('meta[name="apple-mobile-web-app-title"]', { element: (el) => void el.setAttribute("content", attribute) })
    .transform(page.html);
  page.named = { appName, html };
  return html;
}

export interface ServeOptions {
  /** Name the admin gave the app; the build's own name is used without one. */
  appName?: string;
}

/**
 * Serves a file of the guest frontend build for `request`. HTML is sent from
 * the cache the hashes were computed from, so the policy always fits the page.
 *
 * Caching: HTML and every file without a content hash are revalidated on each
 * use (with an ETag for the latter), hashed files are kept for good. That is
 * what makes a new frontend reach guests on their next load, with or without
 * the service worker, which only stores the page itself for when the proxy is
 * out of reach.
 */
export async function serveFrontendFile(file: BunFile, request: Request, { appName }: ServeOptions = {}): Promise<Response> {
  if (!file.type.startsWith("text/html")) {
    const etag = etagOf(file);
    const headers = {
      ...FILE_HEADERS,
      "cache-control": isImmutable(new URL(request.url).pathname) ? "public, max-age=31536000, immutable" : "no-cache",
      etag,
    };
    if (notModified(request, etag)) return new Response(null, { status: 304, headers });
    return new Response(file, { headers });
  }
  const page = await loadPage(file);
  return new Response(appName ? namedHtml(page, appName) : page.html, {
    headers: {
      ...FILE_HEADERS,
      "content-type": "text/html;charset=utf-8",
      "content-security-policy": guestPagePolicy(page.hashes, new URL(request.url).host),
      // External images must not learn the guest page's address.
      "referrer-policy": "same-origin",
      "cache-control": "no-cache",
    },
  });
}
