import mdnsFactory from "multicast-dns";
import { probeHa } from "./oauth";

export interface DiscoveredHa {
  name: string;
  uuid: string;
  version?: string;
  /** Best URL for the proxy to reach this instance: the first announced one that answers like HA. */
  url: string;
  /** All URLs the instance announced. */
  urls: string[];
  /** Whether any of them answered like Home Assistant. */
  reachable: boolean;
}

interface Service {
  name?: string;
  txt: Record<string, string>;
  target?: string;
  port?: number;
}

/**
 * Looks for Home Assistant instances on the local network. They announce
 * themselves via zeroconf as `_home-assistant._tcp.local` with their URLs in
 * the TXT record. Needs multicast, i.e. host networking in containers;
 * returns an empty list where that is not available.
 */
export async function discoverHomeAssistant(timeoutMs = 2500): Promise<DiscoveredHa[]> {
  let mdns: ReturnType<typeof mdnsFactory>;
  try {
    mdns = mdnsFactory();
  } catch {
    return [];
  }
  const services = new Map<string, Service>();
  const addresses = new Map<string, string>();
  const service = (name: string) => services.get(name) ?? services.set(name, { txt: {} }).get(name)!;

  mdns.on("error", () => {});
  mdns.on("response", (response) => {
    for (const record of [...response.answers, ...(response.additionals ?? [])]) {
      const name = String(record.name);
      if (record.type === "PTR" && name === "_home-assistant._tcp.local") {
        service(String(record.data)).name = String(record.data).replace(/\._home-assistant\._tcp\.local$/, "");
      } else if (record.type === "TXT" && name.endsWith("._home-assistant._tcp.local")) {
        const entries = Array.isArray(record.data) ? record.data : [record.data];
        for (const entry of entries) {
          const [key, ...rest] = String(entry).split("=");
          if (key) service(name).txt[key] = rest.join("=");
        }
      } else if (record.type === "SRV" && name.endsWith("._home-assistant._tcp.local")) {
        const data = record.data as { target: string; port: number };
        Object.assign(service(name), { target: data.target, port: data.port });
      } else if (record.type === "A") {
        addresses.set(name, String(record.data));
      }
    }
  });

  try {
    mdns.query({ questions: [{ name: "_home-assistant._tcp.local", type: "PTR" }] });
  } catch {
    mdns.destroy();
    return [];
  }
  await Bun.sleep(timeoutMs);
  mdns.destroy();

  const found = new Map<string, DiscoveredHa>();
  for (const [key, s] of services) {
    const uuid = s.txt.uuid ?? key;
    const address = s.target ? addresses.get(s.target) : undefined;
    const fromAddress = address && s.port ? `http://${address}:${s.port}` : undefined;
    const urls = [s.txt.internal_url, s.txt.base_url, s.txt.external_url, fromAddress].filter((u): u is string => !!u);
    const unique = [...new Set(urls.map((u) => u.replace(/\/+$/, "")))];
    if (unique.length === 0) continue;
    found.set(uuid, {
      name: s.txt.location_name || s.name || uuid,
      uuid,
      version: s.txt.version,
      url: unique[0]!,
      urls: unique,
      reachable: false,
    });
  }
  // An announced internal URL is not always usable (e.g. a reverse proxy on
  // port 80 that only serves the external host name), so each one is tried.
  await Promise.all(
    [...found.values()].map(async (ha) => {
      const results = await Promise.all(ha.urls.map(async (url) => (await probeHa(url)).ok));
      const index = results.indexOf(true);
      if (index >= 0) Object.assign(ha, { url: ha.urls[index]!, reachable: true });
    }),
  );
  return [...found.values()].sort((a, b) => Number(b.reachable) - Number(a.reachable) || a.name.localeCompare(b.name));
}
