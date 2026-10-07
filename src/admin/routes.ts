import type { Server } from "bun";
import z from "zod";
import type { Dashboard } from "../dashboard";
import { effectiveAnswer, isAnswered } from "../dashboard/interactions";
import { GuestError, Password, Username } from "../guests";
import { HaClient } from "../ha/client";
import { discoverHomeAssistant } from "../ha/discovery";
import { normalizeHaUrl } from "../ha/endpoint";
import { authorizeUrl, exchangeCode, HaAuthError, probeHa, revokeRefreshToken } from "../ha/oauth";
import { lookupIngressUser, SUPERVISOR_IP } from "../ha/supervisor";
import { RuntimeError, type Runtime } from "../runtime";
import { connectAsApp, connectWithAdmin } from "../setup/connect";
import { ADMIN_COOKIE, AdminSessions, cookie, OAUTH_COOKIE, readCookie, type AdminSession } from "./sessions";
import { createAssetHandler } from "./assets";

/**
 * The admin page and its JSON API.
 *
 * Standalone it lives under /admin/ on the guest port and admins sign in
 * with Home Assistant (OAuth). As an app it is served at the root of the
 * ingress port and the Supervisor tells who the HA user is. All URLs the
 * page uses are relative, so it works under the ingress path prefix too.
 */

type Identity = { kind: "admin" | "setup"; name: string; session?: AdminSession };

/** Mutating API calls need this header: cross-site pages cannot send it without a CORS preflight, which is never granted. */
const CSRF_HEADER = "x-guest-assistant";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });

const Answers = z.record(z.string().max(2000), z.string().max(50));
const DashboardInput = z.strictObject({ id: z.string().min(1).max(200), answers: Answers.optional() });
const DashboardPatch = z.strictObject({ answers: Answers.optional(), enabled: z.boolean().optional() });
const GuestInput = z.strictObject({ username: Username, password: Password, dashboard: z.string().min(1), enabled: z.boolean().optional() });
const GuestPatch = z.strictObject({ password: Password.optional(), dashboard: z.string().min(1).optional(), enabled: z.boolean().optional() });
const SettingsInput = z.strictObject({ public_url: z.union([z.url({ protocol: /^https?$/ }), z.literal("")]) });
const UrlInput = z.strictObject({ url: z.string().min(1).max(500) });
const CodeInput = z.strictObject({ code: z.string().min(1).max(20) });

export interface AdminOptions {
  /** Path the admin page is served under, with trailing slash. */
  base: string;
}

export function createAdmin(runtime: Runtime, sessions: AdminSessions, { base }: AdminOptions) {
  const appMode = runtime.mode === "app";
  const serveAsset = createAssetHandler(runtime.env.adminUiDir);
  const supervisorToken = runtime.env.supervisorToken;

  function browserOrigin(req: Request): string {
    return req.headers.get("origin") ?? new URL(req.url).origin;
  }

  async function identify(req: Request, server: Server<unknown>): Promise<Identity | null> {
    if (appMode) {
      // Only the Supervisor's ingress proxy may talk to this port; it strips
      // these headers from client requests and sets them itself.
      if (server.requestIP(req)?.address.replace(/^::ffff:/, "") !== SUPERVISOR_IP) return null;
      const userId = req.headers.get("x-remote-user-id");
      if (!userId || !supervisorToken) return null;
      const user = await lookupIngressUser(supervisorToken, userId);
      return user.admin ? { kind: "admin", name: req.headers.get("x-remote-user-display-name") ?? user.name } : null;
    }
    const session = sessions.get(readCookie(req, ADMIN_COOKIE));
    if (!session) return null;
    if (session.kind === "setup" && runtime.haSettings) return null;
    return { kind: session.kind, name: session.name, session };
  }

  function requireAdmin(identity: Identity | null): asserts identity is Identity & { kind: "admin" } {
    if (identity?.kind !== "admin") throw new HttpError(401, "Not signed in");
  }

  /** Connecting HA is allowed before set-up (with the setup code) and for admins. */
  function requireSetupRights(identity: Identity | null): asserts identity is Identity {
    if (identity?.kind === "admin") return;
    if (identity?.kind === "setup" && !runtime.haSettings) return;
    throw new HttpError(401, "Not allowed");
  }

  async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    return parsed.data;
  }

  // ── views ─────────────────────────────────────────────────────────────

  /** Anyone reaching the port may ask; connection details are for admins only. */
  function stateView(identity: Identity | null) {
    const ha = identity?.kind === "admin" ? runtime.haSettings : undefined;
    return {
      mode: runtime.mode,
      configured: !!runtime.haSettings,
      signed_in: identity?.kind ?? null,
      admin_name: identity?.name ?? null,
      setup_code_required: !appMode && !runtime.haSettings,
      ha: ha
        ? {
            url: ha.url,
            state: runtime.state,
            error: runtime.error ?? null,
            version: runtime.haVersion ?? null,
            configured_by: ha.configured_by ?? null,
          }
        : null,
      public_url: identity?.kind === "admin" ? (runtime.publicUrl ?? null) : null,
    };
  }

  function dashboardView(d: Dashboard, title: string, guests: number) {
    return {
      id: d.id,
      title,
      status: d.status,
      enabled: d.enabled,
      violations: d.violations,
      issues: d.issues,
      entities: d.entities.size,
      guests,
      pending: d.pending.length,
      conditions: d.conditionUses,
      questions: d.questions.map((q) => ({
        key: q.key,
        kind: q.kind,
        subject: q.subject,
        paths: q.paths,
        options: q.options,
        informational: q.informational,
        answer: effectiveAnswer(q, d.answers),
        answered: isAnswered(q, d.answers),
      })),
    };
  }

  async function dashboardsView() {
    const [available, guests] = await Promise.all([runtime.listHaDashboards().catch(() => []), runtime.guests.list()]);
    const titles = new Map(available.map((d) => [d.id, d.title]));
    const configured = [...runtime.dashboards.values()].map((d) =>
      dashboardView(d, titles.get(d.id) ?? d.id, guests.filter((g) => g.dashboard === d.id).length),
    );
    return {
      configured,
      available: available.map((d) => ({ ...d, added: runtime.dashboards.has(d.id) })),
    };
  }

  // ── OAuth ─────────────────────────────────────────────────────────────

  function startOAuth(req: Request, haUrl: string, purpose: "setup" | "login") {
    const origin = browserOrigin(req);
    const clientId = `${origin}${base}`;
    const pending = sessions.startOAuth({ haUrl, clientId, redirectUri: `${origin}${base}callback`, purpose });
    return json(
      { authorize_url: authorizeUrl(haUrl, clientId, pending.redirectUri, pending.state) },
      200,
      { "set-cookie": cookie(OAUTH_COOKIE, pending.state, { path: base, secure: origin.startsWith("https:"), maxAge: 600 }) },
    );
  }

  async function oauthCallback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const state = url.searchParams.get("state");
    const pending = sessions.takeOAuth(state);
    const back = (error?: string) => {
      const headers = new Headers({ location: error ? `${base}?error=${encodeURIComponent(error)}` : base, "cache-control": "no-store" });
      headers.append("set-cookie", cookie(OAUTH_COOKIE, "", { path: base, secure: false, maxAge: 0 }));
      return { headers, response: () => new Response(null, { status: 303, headers }) };
    };
    // The state must come back to the browser that started the login.
    if (!pending || readCookie(req, OAUTH_COOKIE) !== state) return back("The sign-in link expired. Please try again.").response();
    const code = url.searchParams.get("code");
    if (!code) return back("Home Assistant did not sign you in.").response();

    let adminName: string;
    try {
      const tokens = await exchangeCode(pending.haUrl, code, pending.clientId);
      try {
        adminName = await HaClient.with({ url: pending.haUrl, token: tokens.access_token }, async (admin) => {
          const me = (await admin.sendCommand({ type: "auth/current_user" })) as { name: string; is_admin: boolean };
          if (!me.is_admin) throw new HttpError(403, `${me.name} is not a Home Assistant administrator.`);
          if (pending.purpose === "setup") {
            await connectWithAdmin(runtime, admin, pending.haUrl, me.name);
            sessions.dropSetupSessions();
            sessions.setupCode = null;
          }
          return me.name;
        });
      } finally {
        // The admin's HA session was only needed for this request.
        await revokeRefreshToken(pending.haUrl, tokens.refresh_token);
      }
    } catch (err) {
      const message = err instanceof HttpError || err instanceof HaAuthError || err instanceof Error ? err.message : String(err);
      console.error("Admin sign-in failed:", message);
      return back(message).response();
    }

    const session = sessions.create("admin", adminName);
    const { headers } = back();
    headers.append("set-cookie", cookie(ADMIN_COOKIE, session.id, { path: base, secure: pending.redirectUri.startsWith("https:") }));
    console.log(`Admin ${adminName} signed in.`);
    return new Response(null, { status: 303, headers });
  }

  // ── API ───────────────────────────────────────────────────────────────

  async function api(req: Request, path: string, identity: Identity | null, server: Server<unknown>): Promise<Response> {
    const method = req.method;
    const route = `${method} ${path}`;
    if (method !== "GET" && req.headers.get(CSRF_HEADER) !== "1") throw new HttpError(403, "Missing request header");

    switch (route) {
      case "GET state":
        return json(stateView(identity));

      case "POST setup/code": {
        if (appMode || runtime.haSettings) throw new HttpError(409, "Already set up");
        const { code } = await body(req, CodeInput);
        // Throttled per TCP peer: a stranger's guesses do not lock out the admin.
        // Behind a reverse proxy all clients share its address.
        const client = server.requestIP(req)?.address.replace(/^::ffff:/, "") ?? "";
        const result = sessions.checkSetupCode(code, client);
        if (result === "throttled") throw new HttpError(429, "Too many attempts, wait a minute");
        if (result === "wrong") throw new HttpError(403, "Wrong or expired setup code. Use the newest one in the log.");
        const session = sessions.create("setup", "setup");
        return json({ ok: true }, 200, {
          "set-cookie": cookie(ADMIN_COOKIE, session.id, { path: base, secure: browserOrigin(req).startsWith("https:") }),
        });
      }

      case "GET setup/discover":
        requireSetupRights(identity);
        if (appMode) return json([]);
        return json(await discoverHomeAssistant());

      case "POST setup/connect": {
        requireSetupRights(identity);
        if (appMode) throw new HttpError(400, "Not available when running as an app");
        const { url } = await body(req, UrlInput);
        let haUrl: string;
        try {
          haUrl = normalizeHaUrl(url);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : "Invalid URL");
        }
        const probe = await probeHa(haUrl);
        if (!probe.ok) throw new HttpError(400, probe.error);
        return startOAuth(req, haUrl, "setup");
      }

      case "POST setup/renew": {
        // As an app: recreate the proxy user with the Supervisor token.
        requireAdmin(identity);
        if (!appMode || !supervisorToken) throw new HttpError(400, "Only available when running as an app");
        await connectAsApp(runtime, supervisorToken);
        return json(stateView(identity));
      }

      case "POST login": {
        const ha = runtime.haSettings;
        if (appMode || !ha) throw new HttpError(400, "Sign-in with Home Assistant is not available");
        return startOAuth(req, ha.url, "login");
      }

      case "POST logout":
        sessions.delete(identity?.session?.id);
        return json({ ok: true }, 200, { "set-cookie": cookie(ADMIN_COOKIE, "", { path: base, secure: false, maxAge: 0 }) });
    }

    requireAdmin(identity);

    switch (route) {
      case "GET dashboards":
        return json(await dashboardsView());
      case "POST dashboards": {
        const input = await body(req, DashboardInput);
        await runtime.addDashboard(input.id, input.answers);
        return json(await dashboardsView());
      }
      case "GET guests":
        return json(await runtime.guests.list());
      case "POST guests": {
        const input = await body(req, GuestInput);
        return json(await runtime.createGuest(input), 201);
      }
      case "PUT settings": {
        const { public_url } = await body(req, SettingsInput);
        await runtime.setPublicUrl(public_url || undefined);
        return json(stateView(identity));
      }
    }

    const preview = route.match(/^GET dashboards\/preview\/(.+)$/);
    if (preview) {
      const d = await runtime.preview(decodeURIComponent(preview[1]!));
      return json(dashboardView(d, d.id, 0));
    }
    const dashboard = path.match(/^dashboards\/(.+)$/);
    if (dashboard) {
      const id = decodeURIComponent(dashboard[1]!);
      if (method === "PATCH") {
        await runtime.updateDashboard(id, await body(req, DashboardPatch));
        return json(await dashboardsView());
      }
      if (method === "DELETE") {
        await runtime.removeDashboard(id);
        return json(await dashboardsView());
      }
    }
    const guest = path.match(/^guests\/([^/]+)$/);
    if (guest) {
      const id = decodeURIComponent(guest[1]!);
      if (method === "PATCH") return json(await runtime.updateGuest(id, await body(req, GuestPatch)));
      if (method === "DELETE") {
        await runtime.deleteGuest(id);
        return json({ ok: true });
      }
    }
    throw new HttpError(404, "Not found");
  }

  // ── entry point ───────────────────────────────────────────────────────

  return async function handle(req: Request, server: Server<unknown>): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === base.replace(/\/$/, "")) return Response.redirect(`${base}${url.search}`, 308);
    // The URL is already normalised: `/admin/../x` matched the admin route but arrives as `/x`.
    if (!url.pathname.startsWith(base)) return new Response("Not Found", { status: 404 });
    const path = url.pathname.slice(base.length);

    try {
      if (path.startsWith("api/")) return await api(req, path.slice(4), await identify(req, server), server);
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
      if (path === "callback" && !appMode) return await oauthCallback(req);
      return await serveAsset(path);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      if (err instanceof RuntimeError || err instanceof GuestError || err instanceof z.ZodError) {
        return json({ error: err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : err.message }, 400);
      }
      console.error(`Admin request ${req.method} ${url.pathname} failed:`, err);
      return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
    }
  };
}
