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
 * Serves a file of the guest frontend build. HTML is sent from the cache the
 * hashes were computed from, so the policy always fits the page.
 */
export async function serveFrontendFile(file: BunFile, host: string): Promise<Response> {
  if (!file.type.startsWith("text/html")) return new Response(file, { headers: FILE_HEADERS });
  const page = await loadPage(file);
  return new Response(page.html, {
    headers: {
      ...FILE_HEADERS,
      "content-type": "text/html;charset=utf-8",
      "content-security-policy": guestPagePolicy(page.hashes, host),
      // External images must not learn the guest page's address.
      "referrer-policy": "same-origin",
    },
  });
}
