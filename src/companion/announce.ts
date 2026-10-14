import mdnsFactory from "multicast-dns";
import { networkInterfaces } from "node:os";
import { FALLBACK_HA_VERSION } from "../proxy/ws-filters";
import type { Runtime } from "../runtime";

type Mdns = ReturnType<typeof mdnsFactory>;
type Answer = Parameters<Mdns["respond"]>[0] extends infer P ? (P extends { answers: Array<infer A> } ? A : never) : never;

/** The service Home Assistant announces and the companion apps look for. */
export const HA_SERVICE = "_home-assistant._tcp.local";
const SERVICES_META = "_services._dns-sd._udp.local";
const TTL = 120;
/** Addresses and the HA version are checked this often; a change is announced. */
const REFRESH_MS = 5 * 60_000;
/** Unsolicited announcements after a change (RFC 6762 asks for at least two, a second apart). */
const ANNOUNCE_TIMES = 3;

/** Interfaces of container networks, which phones on the LAN cannot reach. */
const SKIPPED_INTERFACES = /^(lo|docker|hassio|veth|br-|virbr|tun|tap|wg)/;

/** The host's first IPv4 address on a LAN interface, or null. */
export function lanAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | null {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (SKIPPED_INTERFACES.test(name)) continue;
    for (const address of addresses ?? []) {
      const ipv4 = address.family === "IPv4" || (address.family as unknown) === 4;
      if (ipv4 && !address.internal && !address.address.startsWith("172.30.32.") && !address.address.startsWith("172.17.")) return address.address;
    }
  }
  return null;
}

/** Hosts only reachable on the local network. */
export function isLocalHost(hostname: string): boolean {
  return (
    !hostname.includes(".") ||
    hostname.endsWith(".local") ||
    /^(10|127)\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

/** A DNS label from the app name: no dots (they separate labels), at most 63 bytes. */
function instanceLabel(name: string): string {
  let label = name.replace(/\./g, " ").replace(/[\p{Cc}]/gu, "").trim() || "Guest Assistant";
  while (Buffer.byteLength(label) > 63) label = label.slice(0, -1);
  return label;
}

export interface AnnouncerOptions {
  /** For tests: creates the mDNS socket. */
  factory?: () => Mdns;
  /** For tests: the host's network interfaces. */
  interfaces?: () => ReturnType<typeof networkInterfaces>;
}

/**
 * Announces the proxy on the local network like Home Assistant does, so the
 * companion apps list it when a guest adds a server. Runs while companion app
 * support and discovery are both switched on. Needs multicast, i.e. host
 * networking in containers; without it the admin page says discovery is not
 * available.
 */
export class Announcer {
  private mdns: Mdns | null = null;
  private records: { answers: Answer[]; names: { instance: string; host: string } } | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private announceTimers: Array<ReturnType<typeof setTimeout>> = [];
  private readonly factory: () => Mdns;
  private readonly interfaces: () => ReturnType<typeof networkInterfaces>;

  constructor(
    private readonly runtime: Runtime,
    { factory = () => mdnsFactory(), interfaces = networkInterfaces }: AnnouncerOptions = {},
  ) {
    this.factory = factory;
    this.interfaces = interfaces;
  }

  /** Follows the settings from now on. */
  start(): void {
    this.runtime.on("settingsChanged", () => this.update());
    this.update();
  }

  /** Starts, stops or re-announces to match the settings and the network. */
  update(): void {
    const { enabled, discoverable } = this.runtime.companion;
    if (!enabled || !discoverable) {
      this.stop("off");
      return;
    }
    if (this.runtime.mode === "app" && this.runtime.hostNetwork === false) {
      this.unavailable("This version of the app runs without host networking, which announcing on the local network needs.");
      return;
    }
    if (!this.runtime.guestPortOpen) {
      this.unavailable("The guest port could not be opened (see the problem above), so there is nothing to announce.");
      return;
    }
    const next = this.buildRecords();
    if (!next) {
      this.unavailable("No network address on the local network was found for this machine.");
      return;
    }
    if (!this.mdns && !this.open()) return;
    const previous = this.records;
    if (previous && JSON.stringify(previous.answers) === JSON.stringify(next.answers)) return;
    if (previous && (previous.names.instance !== next.names.instance || previous.names.host !== next.names.host)) this.goodbye(previous.answers);
    this.records = next;
    this.runtime.discoveryStatus = "active";
    this.runtime.discoveryError = undefined;
    this.announce();
  }

  private open(): boolean {
    try {
      const mdns = this.factory();
      mdns.on("error", (err: Error) => this.unavailable(`Multicast DNS is not available here (${err.message}).`));
      mdns.on("query", (query) => this.answer(query));
      this.mdns = mdns;
    } catch (err) {
      this.unavailable(`Multicast DNS is not available here (${err instanceof Error ? err.message : String(err)}).`);
      return false;
    }
    this.refreshTimer = setInterval(() => this.update(), REFRESH_MS);
    this.refreshTimer.unref();
    console.log("[discovery] announcing Guest Assistant to the companion apps on the local network");
    return true;
  }

  private buildRecords() {
    const ip = lanAddress(this.interfaces());
    if (!ip) return null;
    const runtime = this.runtime;
    const label = instanceLabel(runtime.appName ?? runtime.productName);
    const instance = `${label}.${HA_SERVICE}`;
    const host = `guest-assistant-${runtime.instanceId.slice(0, 8)}.local`;
    const port = runtime.env.port;
    const localUrl = `http://${ip}:${port}`;
    const publicUrl = runtime.publicUrl;
    const publicIsLocal = publicUrl ? isLocalHost(new URL(publicUrl).hostname) : false;
    const internalUrl = publicUrl && publicIsLocal ? publicUrl : localUrl;
    const txt = [
      `location_name=${label}`,
      `uuid=${runtime.instanceId}`,
      `version=${runtime.haVersion ?? FALLBACK_HA_VERSION}`,
      `external_url=${publicUrl && !publicIsLocal ? publicUrl : ""}`,
      `internal_url=${internalUrl}`,
      `base_url=${internalUrl}`,
      "requires_api_password=True",
    ];
    const answers: Answer[] = [
      { name: HA_SERVICE, type: "PTR", ttl: TTL, data: instance },
      { name: instance, type: "SRV", ttl: TTL, data: { port, target: host, priority: 0, weight: 0 } },
      { name: instance, type: "TXT", ttl: TTL, data: txt },
      { name: host, type: "A", ttl: TTL, data: ip },
    ];
    return { answers, names: { instance, host } };
  }

  /** Answers questions about our service, instance or host name. */
  private answer(query: { questions: Array<{ name: string; type: string }> }): void {
    const records = this.records;
    if (!records || !this.mdns) return;
    const [ptr, srv, txt, a] = records.answers as [Answer, Answer, Answer, Answer];
    const { instance, host } = records.names;
    const answers: Answer[] = [];
    const additionals: Answer[] = [];
    for (const q of query.questions) {
      const name = q.name.toLowerCase();
      const any = q.type === "ANY";
      if (name === HA_SERVICE && (q.type === "PTR" || any)) {
        answers.push(ptr);
        additionals.push(srv, txt, a);
      } else if (name === instance.toLowerCase() && (q.type === "SRV" || q.type === "TXT" || any)) {
        answers.push(...(q.type === "TXT" ? [txt] : q.type === "SRV" ? [srv] : [srv, txt]));
        additionals.push(a);
      } else if (name === host && (q.type === "A" || any)) {
        answers.push(a);
      } else if (name === SERVICES_META && (q.type === "PTR" || any)) {
        answers.push({ name: SERVICES_META, type: "PTR", ttl: TTL, data: HA_SERVICE });
      }
    }
    if (answers.length === 0) return;
    const sent = new Set(answers);
    this.mdns.respond({ answers: [...sent], additionals: [...new Set(additionals)].filter((r) => !sent.has(r)) });
  }

  private announce(): void {
    for (const timer of this.announceTimers) clearTimeout(timer);
    this.announceTimers = [];
    for (let i = 0; i < ANNOUNCE_TIMES; i++) {
      const timer = setTimeout(() => {
        if (this.records && this.mdns) this.mdns.respond({ answers: this.records.answers });
      }, i * 1000);
      timer.unref();
      this.announceTimers.push(timer);
    }
  }

  /** Tells listeners the records are gone (TTL 0). */
  private goodbye(answers: Answer[]): void {
    try {
      this.mdns?.respond({ answers: answers.map((r) => ({ ...r, ttl: 0 }) as Answer) });
    } catch {
      // the socket may already be closed
    }
  }

  /** Stops and tells the admin page (and the log, once per reason) why discovery does not work. */
  private unavailable(reason: string): void {
    if (this.runtime.discoveryError !== reason) console.warn(`[discovery] ${reason}`);
    this.stop("unavailable");
    this.runtime.discoveryError = reason;
  }

  stop(status: "off" | "unavailable" = "off"): void {
    for (const timer of this.announceTimers) clearTimeout(timer);
    this.announceTimers = [];
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.mdns) {
      if (this.records) this.goodbye(this.records.answers);
      const mdns = this.mdns;
      this.mdns = null;
      try {
        mdns.destroy();
      } catch {
        // already closed
      }
      if (status === "off") console.log("[discovery] stopped announcing Guest Assistant");
    }
    this.records = null;
    this.runtime.discoveryStatus = status;
    if (status === "off") this.runtime.discoveryError = undefined;
  }
}
