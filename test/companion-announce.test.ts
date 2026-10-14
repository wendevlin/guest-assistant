import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { networkInterfaces } from "node:os";
import { Announcer, HA_SERVICE, isLocalHost, lanAddress } from "../src/companion/announce";
import { Runtime } from "../src/runtime";
import { Store } from "../src/store";
import { randomPort, testEnvConfig } from "./helpers";

type Record = { name: string; type: string; ttl: number; data: unknown };
type Packet = { answers: Record[]; additionals?: Record[] };

/** Stands in for multicast-dns: records what is sent, lets tests ask questions. */
class FakeMdns extends EventEmitter {
  sent: Packet[] = [];
  destroyed = false;
  respond(packet: Packet) {
    this.sent.push(packet);
  }
  destroy() {
    this.destroyed = true;
  }
  ask(name: string, type: string) {
    this.sent = [];
    this.emit("query", { questions: [{ name, type }] });
    return this.sent[0];
  }
}

const IFACES = (address = "192.168.1.20") =>
  ({
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    eth0: [{ address, family: "IPv4", internal: false }],
  }) as unknown as ReturnType<typeof networkInterfaces>;

let runtime: Runtime;
let fake: FakeMdns | null;
let announcer: Announcer;
let created: number;

beforeEach(() => {
  runtime = new Runtime(testEnvConfig(randomPort()), Store.memory(), "standalone");
  fake = null;
  created = 0;
  announcer = new Announcer(runtime, {
    factory: () => {
      created++;
      fake = new FakeMdns();
      return fake as never;
    },
    interfaces: () => IFACES(),
  });
  announcer.start();
});

afterEach(() => {
  announcer.stop();
  runtime.close();
});

const txtOf = (packet: Packet | undefined) => {
  const txt = [...(packet?.answers ?? []), ...(packet?.additionals ?? [])].find((r) => r.type === "TXT");
  return Object.fromEntries((txt?.data as string[]).map((e) => e.split(/=(.*)/s).slice(0, 2)));
};

describe("announcer", () => {
  test("stays silent unless companion support and discovery are both on", () => {
    expect(created).toBe(0);
    runtime.setCompanion({ enabled: true });
    expect(created).toBe(0);
    expect(runtime.discoveryStatus).toBe("off");
    runtime.setCompanion({ discoverable: true });
    expect(created).toBe(1);
    expect(runtime.discoveryStatus).toBe("active");
  });

  test("answers the apps' query like Home Assistant, under the app name", () => {
    runtime.setAppName("Our Guests");
    runtime.setCompanion({ enabled: true, discoverable: true });
    const packet = fake!.ask(HA_SERVICE, "PTR");
    expect(packet?.answers[0]).toMatchObject({ name: HA_SERVICE, type: "PTR", data: `Our Guests.${HA_SERVICE}` });
    const srv = packet?.additionals?.find((r) => r.type === "SRV");
    expect(srv?.data).toMatchObject({ port: runtime.env.port });
    expect(packet?.additionals?.find((r) => r.type === "A")?.data).toBe("192.168.1.20");
    const txt = txtOf(packet);
    expect(txt).toMatchObject({
      location_name: "Our Guests",
      uuid: runtime.instanceId,
      internal_url: `http://192.168.1.20:${runtime.env.port}`,
      base_url: `http://192.168.1.20:${runtime.env.port}`,
      external_url: "",
    });
    expect(txt.version).toMatch(/^\d{4}\.\d+\.\d+$/);
    // Questions about other services are not ours to answer.
    expect(fake!.ask("_googlecast._tcp.local", "PTR")).toBeUndefined();
  });

  test("a public https address becomes the external URL", async () => {
    runtime.setCompanion({ enabled: true, discoverable: true });
    await runtime.setPublicUrl("https://guests.example.com");
    const txt = txtOf(fake!.ask(HA_SERVICE, "PTR"));
    expect(txt.external_url).toBe("https://guests.example.com");
    expect(txt.internal_url).toBe(`http://192.168.1.20:${runtime.env.port}`);
  });

  test("a renamed app says goodbye under the old name; switching off says goodbye and closes", () => {
    runtime.setCompanion({ enabled: true, discoverable: true });
    const first = fake!;
    first.sent = [];
    runtime.setAppName("Renamed");
    const goodbye = first.sent.find((p) => p.answers.every((r) => r.ttl === 0));
    expect(goodbye?.answers[0]?.data).toBe(`Guest Assistant.${HA_SERVICE}`);

    first.sent = [];
    runtime.setCompanion({ enabled: false });
    expect(first.sent.some((p) => p.answers.every((r) => r.ttl === 0))).toBe(true);
    expect(first.destroyed).toBe(true);
    expect(runtime.discoveryStatus).toBe("off");
  });

  test("socket errors make discovery unavailable instead of crashing", () => {
    runtime.setCompanion({ enabled: true, discoverable: true });
    fake!.emit("error", new Error("EADDRINUSE"));
    expect(runtime.discoveryStatus).toBe("unavailable");
  });
});

describe("helpers", () => {
  test("lanAddress skips loopback and container bridges", () => {
    expect(lanAddress(IFACES("10.0.0.5"))).toBe("10.0.0.5");
    expect(lanAddress({ lo: IFACES().lo } as ReturnType<typeof networkInterfaces>)).toBeNull();
  });

  test("isLocalHost", () => {
    for (const host of ["192.168.1.2", "10.1.2.3", "172.20.0.1", "homeassistant.local", "nas"]) expect(isLocalHost(host)).toBe(true);
    for (const host of ["guests.example.com", "8.8.8.8", "172.40.0.1"]) expect(isLocalHost(host)).toBe(false);
  });
});
