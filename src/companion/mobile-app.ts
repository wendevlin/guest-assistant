import type { BunRequest } from "bun";
import { randomBytes } from "node:crypto";
import z from "zod";
import { isDenied, type RequireGuest } from "../auth/guard";
import { evaluate, type Obj } from "../proxy/ws-commands";
import { FALLBACK_HA_VERSION, scrubComponents, scrubConfig } from "../proxy/ws-filters";
import { AttemptLimiter } from "../rate-limit";
import type { Runtime } from "../runtime";
import type { AppTokenRow, DeviceInfo } from "./tokens";

/**
 * The parts of HA's mobile_app integration the companion apps need to
 * register and keep running. Nothing they send is stored or passed to HA:
 * sensors, locations, events and tags are acknowledged and dropped. Widgets
 * may call services through the webhook where the admin allowed widgets for
 * the dashboard; those calls go through the same checks as the guest page's.
 */

const WEBHOOK_ID = /^[0-9a-f]{64}$/;
const MAX_WEBHOOK_BODY = 256 * 1024;
/** Service calls through the webhook (button widgets, iOS actions). */
const WEBHOOK_CALLS_PER_DEVICE = 30;
const WEBHOOK_CALLS_TOTAL = 300;

const text = z.string().max(200);
const Registration = z.object({
  app_id: text,
  app_name: text,
  app_version: text,
  device_name: text,
  manufacturer: text,
  model: text,
  os_name: text,
  os_version: text.optional(),
});
const RegistrationUpdate = z.object({
  app_version: text.optional(),
  device_name: text.optional(),
  manufacturer: text.optional(),
  model: text.optional(),
  os_version: text.optional(),
});
const WebhookBody = z.object({ type: z.string().max(100), data: z.unknown().optional() });
const ServiceCall = z.object({ domain: z.string(), service: z.string(), service_data: z.record(z.string(), z.unknown()).optional() });

/** What HA reports for metric systems; used until HA's own config was read. */
const METRIC = {
  length: "km",
  accumulated_precipitation: "mm",
  area: "m²",
  mass: "g",
  pressure: "Pa",
  temperature: "°C",
  volume: "L",
  wind_speed: "m/s",
};

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const failure = (code: string, message: string, status = 400) => json({ success: false, error: { code, message } }, status);

/** Android rejects a unit system whose values are not all strings. */
function unitSystem(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return METRIC;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([, v]) => typeof v === "string") ? (value as Record<string, string>) : METRIC;
}

export function createMobileApp(runtime: Runtime, requireGuest: RequireGuest) {
  const calls = new AttemptLimiter(WEBHOOK_CALLS_PER_DEVICE, WEBHOOK_CALLS_TOTAL);
  /** Unknown webhook ids are logged a few times a minute at most. */
  const unknownLog = new AttemptLimiter(10, 10);

  const enabled = () => runtime.companion.enabled;

  // ── registration ──────────────────────────────────────────────────────

  async function register(req: BunRequest): Promise<Response> {
    if (!enabled()) return new Response("Not Found", { status: 404 });
    const guest = await requireGuest(req);
    if (isDenied(guest)) return guest;
    // Only an app that signed in through /auth/token has a login to attach to.
    if (guest.kind !== "app-token") return new Response("Forbidden", { status: 403 });
    let parsed;
    try {
      parsed = Registration.safeParse(await req.json());
    } catch {
      return json({ message: "Invalid JSON" }, 400);
    }
    if (!parsed.success) return json({ message: "Invalid registration" }, 400);

    const webhookId = randomBytes(32).toString("hex");
    runtime.appTokens.setRegistration(guest.sessionId, webhookId, parsed.data);
    console.log(`Guest ${guest.name} registered the companion app on "${parsed.data.device_name}".`);
    // All four keys: Android fails on a missing one. No secret, so the app
    // does not encrypt; no cloudhook or remote UI, so it only uses this URL.
    return json({ cloudhook_url: null, remote_ui_url: null, secret: null, webhook_id: webhookId }, 201);
  }

  // ── webhook ───────────────────────────────────────────────────────────

  async function appConfig(row: AppTokenRow) {
    const ha = (await runtime.haConfig()) ?? {};
    const scrubbed = scrubConfig(ha) as Obj;
    // No `entities`: Android would register its sensors again on every sync
    // for each one missing from it.
    return {
      latitude: 0,
      longitude: 0,
      elevation: 0,
      unit_system: unitSystem(scrubbed.unit_system),
      location_name: runtime.appName ?? "Guest Assistant",
      time_zone: typeof scrubbed.time_zone === "string" ? scrubbed.time_zone : "UTC",
      components: scrubComponents(ha.components, { companion: true }),
      version: runtime.haVersion ?? (typeof ha.version === "string" ? ha.version : FALLBACK_HA_VERSION),
      theme_color: "#03A9F4",
      hass_device_id: row.id,
      instance_id: runtime.instanceId,
    };
  }

  function safeRegistration(device: DeviceInfo) {
    return {
      app_data: {},
      app_id: device.app_id,
      app_name: device.app_name,
      app_version: device.app_version,
      device_name: device.device_name,
      manufacturer: device.manufacturer,
      model: device.model,
      os_version: device.os_version ?? null,
      supports_encryption: false,
    };
  }

  async function callService(row: AppTokenRow, data: unknown): Promise<Response> {
    const guest = await runtime.guests.get(row.user_id);
    const dashboard = guest?.enabled ? runtime.dashboards.get(guest.dashboard) : undefined;
    if (!dashboard?.usable || !dashboard.widgets) return failure("not_allowed", "Widgets are not enabled for this dashboard");
    const call = ServiceCall.safeParse(data);
    if (!call.success) return failure("invalid_format", "Invalid service call");
    if (!calls.take(row.id)) return failure("rate_limited", "Too many actions, try again in a moment", 429);

    const verdict = evaluate({ id: 1, type: "call_service", ...call.data }, { dashboard, subscriptions: new Map() });
    if (verdict.kind !== "forward") {
      console.warn(`[webhook] rejected call_service from guest ${guest?.username}: ${verdict.kind === "reject" ? verdict.message : "not forwardable"}`);
      return failure("not_allowed", "Operation not permitted");
    }
    if (!runtime.client) return failure("not_connected", "Not connected to Home Assistant", 503);
    const { id: _, ...command } = verdict.msg;
    try {
      await runtime.client.sendCommand(command);
    } catch (err) {
      return failure("service_error", err instanceof Error ? err.message : "Service call failed");
    }
    return json({});
  }

  async function webhook(req: BunRequest<"/api/webhook/:id">): Promise<Response> {
    if (!enabled()) return new Response("Not Found", { status: 404 });
    const webhookId = req.params.id;
    if (!WEBHOOK_ID.test(webhookId)) return new Response("Not Found", { status: 404 });
    const row = runtime.appTokens.findByWebhookId(webhookId);
    if (!row) {
      // 410 makes the apps register again, which needs a valid login.
      if (unknownLog.take("all")) console.warn("[webhook] request for an unknown or removed companion app registration");
      return new Response(null, { status: 410 });
    }
    if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BODY) return new Response("Payload Too Large", { status: 413 });
    const raw = await req.text();
    if (raw.length > MAX_WEBHOOK_BODY) return new Response("Payload Too Large", { status: 413 });
    let body;
    try {
      body = WebhookBody.safeParse(JSON.parse(raw));
    } catch {
      return json({}, 400);
    }
    if (!body.success) return failure("invalid_format", "Invalid webhook message");
    runtime.appTokens.touch(row.id);
    const { type, data } = body.data;

    switch (type) {
      case "get_config":
        return json(await appConfig(row));
      case "update_registration": {
        const update = RegistrationUpdate.safeParse(data);
        if (!row.device) return new Response(null, { status: 410 });
        const device = { ...row.device, ...(update.success ? update.data : {}) };
        runtime.appTokens.updateDevice(row.id, device);
        // Never empty: the apps register again after an empty answer.
        return json(safeRegistration(device));
      }
      case "register_sensor":
        return json({ success: true }, 201);
      case "update_sensor_states": {
        // Acknowledged, nothing is kept.
        const out: Record<string, { success: true }> = {};
        if (Array.isArray(data)) {
          for (const sensor of data) {
            const uid = (sensor as { unique_id?: unknown } | null)?.unique_id;
            if (typeof uid === "string" && uid.length <= 200) out[uid] = { success: true };
          }
        }
        return json(out);
      }
      case "get_zones":
        return json([]);
      case "update_location":
      case "fire_event":
      case "scan_tag":
        return json({});
      case "render_template": {
        // Templates the app brings never match the ones written on the
        // dashboard, the only ones guests may render.
        const out: Record<string, { error: string }> = {};
        if (typeof data === "object" && data !== null && !Array.isArray(data)) {
          for (const key of Object.keys(data).slice(0, 50)) out[key] = { error: "Templates are not available for guests" };
        }
        return json(out);
      }
      case "call_service":
        return callService(row, data);
      default:
        return failure("not_supported", `${type} is not available for guests`);
    }
  }

  // ── guest session info ────────────────────────────────────────────────

  /** Name and dashboard of the caller; the guest page needs them in the companion app, where it has no cookie. */
  async function session(req: BunRequest): Promise<Response> {
    const guest = await requireGuest(req);
    if (isDenied(guest)) return guest;
    return json({ name: guest.name, dashboard_url_path: guest.dashboard.urlPath });
  }

  return { register, webhook, session };
}
