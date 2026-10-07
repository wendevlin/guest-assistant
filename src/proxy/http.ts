import type { BunRequest } from "bun";
import { isDenied, type RequireGuest } from "../auth/guard";
import type { Dashboard } from "../dashboard";
import type { HaEndpoint } from "../ha/endpoint";
import { filterLogbookEntries, filterStates, guestState } from "./ws-filters";

/**
 * HTTP routes proxied to Home Assistant.
 *
 * There is deliberately no catch-all: every path a guest may reach is listed
 * here and (except for public asset paths) guarded by `requireGuest`.
 */

const HOP_BY_HOP_REQUEST_HEADERS = ["host", "cookie", "authorization", "connection", "content-length", "transfer-encoding", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-ha-access"];
const STRIPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "set-cookie", "transfer-encoding"];

/** Percent-encoded '.', '/' or '\': HA could decode them into a different path. */
const ENCODED_PATH_SEPARATOR = /%(2e|2f|5c)/i;

type Handler = (req: BunRequest) => Promise<Response> | Response;
/** Decides whether a (normalised) path may be forwarded by a route. */
type PathRule = (pathname: string) => boolean;

/** The path itself or anything below it. */
const under =
  (base: string): PathRule =>
  (pathname) =>
    pathname === base || pathname.startsWith(`${base}/`);
const exactly =
  (path: string): PathRule =>
  (pathname) =>
    pathname === path;

/**
 * The path and query to forward to HA, or null if the request left the route
 * that admitted it.
 *
 * Bun matches routes on the raw request target but hands handlers the
 * normalised URL: `GET /local/../api/states` matches `/local/*` and arrives
 * here as `/api/states`. So the normalised path is checked against the
 * route's own rule, and only that path is forwarded.
 */
function upstreamTarget(request: Request, rule: PathRule): string | null {
  const url = new URL(request.url);
  if (ENCODED_PATH_SEPARATOR.test(url.pathname) || !rule(url.pathname)) return null;
  return `${url.pathname}${url.search}`;
}

const notFound = () => new Response("Not Found", { status: 404 });

export function createHttpRoutes(endpoint: () => HaEndpoint | null, requireGuest: RequireGuest) {
  /**
   * Forwards a request to HA. The proxy's token is only sent for requests
   * whose guest identity was checked; public paths are public in HA too.
   */
  async function proxy(request: Request, target: string, { authenticate }: { authenticate: boolean }): Promise<Response> {
    const ha = endpoint();
    if (!ha) return new Response("Service Unavailable", { status: 503 });
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_REQUEST_HEADERS.includes(key.toLowerCase())) headers.set(key, value);
    });
    if (authenticate) headers.set("authorization", `Bearer ${ha.token}`);

    const upstream = await fetch(`${ha.url}${target}`, {
      method: "GET",
      headers,
      redirect: "manual",
    });

    const responseHeaders = new Headers(upstream.headers);
    for (const h of STRIPPED_RESPONSE_HEADERS) responseHeaders.delete(h);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  /** Route that stays inside `rule`, requires a guest identity and hands the target to `handler`. */
  function guarded(rule: PathRule, handler: (req: BunRequest, dashboard: Dashboard, target: string) => Promise<Response>): Handler {
    return async (req) => {
      const target = upstreamTarget(req, rule);
      if (!target) return notFound();
      const guest = await requireGuest(req);
      if (isDenied(guest)) return guest;
      return handler(req, guest.dashboard, target);
    };
  }

  const passthrough = (base: string) => guarded(under(base), (req, _dashboard, target) => proxy(req, target, { authenticate: true }));

  /**
   * `<base>/<entity_id>` for an entity on the guest's dashboard; nothing below
   * or beside it. `filter`, if given, rewrites HA's JSON answer.
   */
  function entityRoute(base: string, filter?: (body: unknown) => unknown): Handler {
    return async (req) => {
      const entityId = (req.params as { entity_id?: string }).entity_id;
      const target = entityId ? upstreamTarget(req, exactly(`${base}/${entityId}`)) : null;
      if (!entityId || !target) return notFound();
      const guest = await requireGuest(req);
      if (isDenied(guest)) return guest;
      if (!guest.dashboard.entities.has(entityId)) return new Response("Forbidden", { status: 403 });
      const upstream = await proxy(req, target, { authenticate: true });
      if (!filter || !upstream.ok) return upstream;
      return Response.json(filter(await upstream.json()));
    };
  }

  function allowedQueryEntities(url: URL, param: string, dashboard: Dashboard): string[] | null {
    const raw = url.searchParams.get(param);
    if (!raw) return null;
    const ids = raw.split(",").filter(Boolean);
    if (ids.length === 0 || !ids.every((id) => dashboard.entities.has(id))) return null;
    return ids;
  }

  const states = guarded(exactly("/api/states"), async (req, dashboard, target) => {
    const upstream = await proxy(req, target, { authenticate: true });
    if (!upstream.ok) return new Response(upstream.statusText, { status: upstream.status });
    return Response.json(filterStates(await upstream.json(), dashboard.entities));
  });

  const history = guarded(under("/api/history/period"), async (req, dashboard, target) => {
    const url = new URL(req.url);
    if (!allowedQueryEntities(url, "filter_entity_id", dashboard)) return new Response("Forbidden", { status: 403 });
    const upstream = await proxy(req, target, { authenticate: true });
    if (!upstream.ok) return new Response(upstream.statusText, { status: upstream.status });
    const result = (await upstream.json()) as Array<Array<{ entity_id?: string }>>;
    if (!Array.isArray(result)) return Response.json([]);
    return Response.json(
      result.filter((series) => Array.isArray(series) && series.length > 0 && series[0]?.entity_id && dashboard.entities.has(series[0].entity_id)),
    );
  });

  const logbook = guarded(under("/api/logbook"), async (req, dashboard, target) => {
    const url = new URL(req.url);
    if (!allowedQueryEntities(url, "entity", dashboard)) return new Response("Forbidden", { status: 403 });
    const upstream = await proxy(req, target, { authenticate: true });
    if (!upstream.ok) return new Response(upstream.statusText, { status: upstream.status });
    return Response.json(filterLogbookEntries(await upstream.json(), dashboard.entities));
  });

  /** Public in HA as well, so no guest identity and no token. */
  function publicAsset(base: string): Handler {
    return (req) => {
      const target = upstreamTarget(req, under(base));
      return target ? proxy(req, target, { authenticate: false }) : notFound();
    };
  }

  const GET = <T extends Handler>(handler: T) => ({ GET: handler, HEAD: handler });

  return {
    "/api/states": GET(states),
    "/api/states/:entity_id": GET(entityRoute("/api/states", guestState)),
    "/api/camera_proxy/:entity_id": GET(entityRoute("/api/camera_proxy")),
    "/api/camera_proxy_stream/:entity_id": GET(entityRoute("/api/camera_proxy_stream")),
    "/api/image_proxy/:entity_id": GET(entityRoute("/api/image_proxy")),
    "/api/media_player_proxy/:entity_id": GET(entityRoute("/api/media_player_proxy")),
    "/api/calendars/:entity_id": GET(entityRoute("/api/calendars")),
    "/api/history/period": GET(history),
    "/api/history/period/*": GET(history),
    "/api/logbook": GET(logbook),
    "/api/logbook/*": GET(logbook),
    "/api/hls/*": GET(passthrough("/api/hls")),
    "/api/image/serve/*": GET(passthrough("/api/image/serve")),
    "/api/brands/*": GET(passthrough("/api/brands")),
    "/api/tts_proxy/*": GET(passthrough("/api/tts_proxy")),
    // Map tiles, glyphs and sprites through HA's tile proxy (map card, person
    // more-info); requests carry the map_tiles/access_token token.
    "/api/map_tiles/*": GET(passthrough("/api/map_tiles")),
    // Public in HA as well (www/ folder, static frontend assets). HACS files
    // are not offered: lovelace resources are answered empty, so the guest
    // UI never loads custom cards.
    "/static/*": GET(publicAsset("/static")),
    "/local/*": GET(publicAsset("/local")),
  };
}
