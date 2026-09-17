import type { BunRequest } from "bun";
import { isDenied, type RequireGuest } from "../auth/guard";
import { haHttpUrl, type Config } from "../config";
import type { Dashboard } from "../dashboard";
import { filterLogbookEntries } from "./ws-filters";

/**
 * HTTP routes proxied to Home Assistant.
 *
 * There is deliberately no catch-all: every path a guest may reach is listed
 * here and (except for public asset paths) guarded by `requireGuest`.
 */

const HOP_BY_HOP_REQUEST_HEADERS = ["host", "cookie", "authorization", "connection", "content-length", "transfer-encoding", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-ha-access"];
const STRIPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "set-cookie", "transfer-encoding"];

type Handler = (req: BunRequest) => Promise<Response> | Response;

export function createHttpRoutes(config: Config, requireGuest: RequireGuest) {
  const ha = config["home-assistant"];
  const base = haHttpUrl(ha);

  async function proxy(request: Request, init?: { method?: string }): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_REQUEST_HEADERS.includes(key.toLowerCase())) headers.set(key, value);
    });
    headers.set("authorization", `Bearer ${ha.long_lived_access_token}`);

    const upstream = await fetch(`${base}${url.pathname}${url.search}`, {
      method: init?.method ?? "GET",
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

  /** Route that requires a guest identity and passes the request through. */
  function guarded(handler: (req: BunRequest, dashboard: Dashboard) => Promise<Response>): Handler {
    return async (req) => {
      const guest = await requireGuest(req);
      if (isDenied(guest)) return guest;
      return handler(req, guest.dashboard);
    };
  }

  const passthrough = guarded((req) => proxy(req));

  const entityRoute = guarded(async (req, dashboard) => {
    const entityId = (req.params as { entity_id?: string }).entity_id;
    if (!entityId || !dashboard.entities.has(entityId)) return new Response("Forbidden", { status: 403 });
    return proxy(req);
  });

  function allowedQueryEntities(url: URL, param: string, dashboard: Dashboard): string[] | null {
    const raw = url.searchParams.get(param);
    if (!raw) return null;
    const ids = raw.split(",").filter(Boolean);
    if (ids.length === 0 || !ids.every((id) => dashboard.entities.has(id))) return null;
    return ids;
  }

  const states = guarded(async (req, dashboard) => {
    const upstream = await proxy(req);
    if (!upstream.ok) return new Response(upstream.statusText, { status: upstream.status });
    const list = (await upstream.json()) as Array<{ entity_id?: string }>;
    return Response.json(Array.isArray(list) ? list.filter((s) => s.entity_id && dashboard.entities.has(s.entity_id)) : []);
  });

  const history = guarded(async (req, dashboard) => {
    const url = new URL(req.url);
    if (!allowedQueryEntities(url, "filter_entity_id", dashboard)) return new Response("Forbidden", { status: 403 });
    const upstream = await proxy(req);
    if (!upstream.ok) return new Response(upstream.statusText, { status: upstream.status });
    const result = (await upstream.json()) as Array<Array<{ entity_id?: string }>>;
    if (!Array.isArray(result)) return Response.json([]);
    return Response.json(
      result.filter((series) => Array.isArray(series) && series.length > 0 && series[0]?.entity_id && dashboard.entities.has(series[0].entity_id)),
    );
  });

  const logbook = guarded(async (req, dashboard) => {
    const url = new URL(req.url);
    if (!allowedQueryEntities(url, "entity", dashboard)) return new Response("Forbidden", { status: 403 });
    const upstream = await proxy(req);
    if (!upstream.ok) return new Response(upstream.statusText, { status: upstream.status });
    return Response.json(filterLogbookEntries(await upstream.json(), dashboard.entities));
  });

  const publicAsset: Handler = (req) => proxy(req);

  const GET = <T extends Handler>(handler: T) => ({ GET: handler, HEAD: handler });

  return {
    "/api/states": GET(states),
    "/api/states/:entity_id": GET(entityRoute),
    "/api/camera_proxy/:entity_id": GET(entityRoute),
    "/api/camera_proxy_stream/:entity_id": GET(entityRoute),
    "/api/image_proxy/:entity_id": GET(entityRoute),
    "/api/media_player_proxy/:entity_id": GET(entityRoute),
    "/api/calendars/:entity_id": GET(entityRoute),
    "/api/history/period": GET(history),
    "/api/history/period/*": GET(history),
    "/api/logbook": GET(logbook),
    "/api/logbook/*": GET(logbook),
    "/api/hls/*": GET(passthrough),
    "/api/image/serve/*": GET(passthrough),
    "/api/brands/*": GET(passthrough),
    "/api/tts_proxy/*": GET(passthrough),
    // Public in HA as well (www/ folder, static frontend assets, HACS files).
    "/static/*": GET(publicAsset),
    "/local/*": GET(publicAsset),
    "/hacsfiles/*": GET(publicAsset),
  };
}
