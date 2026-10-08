import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminSessions } from "../src/admin/sessions";
import { guestPagePolicy, serveFrontendFile } from "../src/csp";
import { Runtime } from "../src/runtime";
import { createServer } from "../src/server";
import { Store } from "../src/store";
import { randomPort, testEnvConfig } from "./helpers";

/** A build whose index.html has two inline scripts and one external one. */
const FRONTEND = "./test/fixtures/frontend-csp";
const DIST = `${FRONTEND}/guest-assistant/dist`;

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** The directives of a CSP header, by name. */
function directives(header: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of (header ?? "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

let server: ReturnType<typeof createServer>["server"];
let runtime: Runtime;
let url: string;

// Serving the frontend needs no Home Assistant.
beforeAll(async () => {
  const port = randomPort();
  runtime = new Runtime({ ...testEnvConfig(port), frontendRepo: FRONTEND }, Store.memory(), "standalone");
  await runtime.init();
  server = createServer(runtime, new AdminSessions(), port).server;
  url = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  runtime.close();
});

describe("guest page", () => {
  test("carries a CSP that allows exactly its own inline scripts", async () => {
    const res = await fetch(`${url}/`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("guest-frontend-csp");
    const csp = directives(res.headers.get("content-security-policy"));
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("script-src")).toEqual(["'self'", sha256("window.first = 1;"), sha256('import("/frontend_latest/app.js")')]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'self'"]);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  test("the SPA fallback and /index.html get the same policy", async () => {
    const root = (await fetch(`${url}/`, { headers: { accept: "text/html" } })).headers.get("content-security-policy");
    expect(root).toContain("script-src 'self' 'sha256-");
    for (const path of ["/guest-dash/0", "/index.html"]) {
      const res = await fetch(`${url}${path}`, { headers: { accept: "text/html" } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("guest-frontend-csp");
      expect(res.headers.get("content-security-policy")).toBe(root);
    }
  });

  test("lists the request's host for WebSockets", async () => {
    const res = await fetch(`${url}/`, { headers: { accept: "text/html", host: "guest.example:8123" } });
    expect(directives(res.headers.get("content-security-policy")).get("connect-src")).toEqual([
      "'self'",
      "data:",
      "ws://guest.example:8123",
      "wss://guest.example:8123",
    ]);
  });

  test("hosts that are no valid CSP source are left out", () => {
    for (const host of ["[::1]:3001", "x; script-src *", "a b", ""]) {
      expect(directives(guestPagePolicy([], host)).get("connect-src")).toEqual(["'self'", "data:"]);
    }
    expect(directives(guestPagePolicy([], "home.example.org")).get("connect-src")).toEqual([
      "'self'",
      "data:",
      "ws://home.example.org",
      "wss://home.example.org",
    ]);
  });
});

describe("build files", () => {
  test("are served unchanged with nosniff and without a page policy", async () => {
    for (const path of ["/frontend_latest/app.js", "/static/translations/en.json"]) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(await Bun.file(`${DIST}${path}`).text());
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBeNull();
    }
    expect((await fetch(`${url}/frontend_latest/app.js`)).headers.get("content-type")).toContain("javascript");
  });
});

describe("hash cache", () => {
  // A rebuilt frontend (GUEST_ASSISTANT_FRONTEND_REPO) must not be served
  // with the hashes of the previous build, or its scripts are blocked.
  test("follows changes of index.html", async () => {
    const dir = mkdtempSync(join(tmpdir(), "csp-"));
    const path = join(dir, "index.html");
    try {
      const serve = async () => {
        const res = await serveFrontendFile(Bun.file(path), "localhost");
        return { body: await res.text(), scripts: directives(res.headers.get("content-security-policy")).get("script-src") };
      };
      // The HTML parser turns CRLF into LF before the browser hashes.
      writeFileSync(path, "<script>one()\r\n</script>");
      utimesSync(path, 1_000, 1_000);
      expect(await serve()).toEqual({ body: "<script>one()\r\n</script>", scripts: ["'self'", sha256("one()\n")] });

      writeFileSync(path, "<script>two()</script>");
      utimesSync(path, 2_000, 2_000);
      expect(await serve()).toEqual({ body: "<script>two()</script>", scripts: ["'self'", sha256("two()")] });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
