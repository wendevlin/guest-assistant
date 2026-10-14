import { AdminSessions } from "./admin/sessions";
import { Announcer } from "./companion/announce";
import { readEnv } from "./env";
import { ingressPanelPath, selfInfo } from "./ha/supervisor";
import { describeListenError } from "./listen-error";
import { Runtime } from "./runtime";
import { ADMIN_BASE, createIngressServer, createServer } from "./server";
import { connectAsApp } from "./setup/connect";
import { Store } from "./store";

const baseEnv = readEnv();
const mode = baseEnv.supervisorToken ? "app" : "standalone";
// As an app: the Supervisor picks the ingress port (`ingress_port: 0`, so it
// cannot collide with another app on the host network) and tells whether
// this is the beta app.
const app = mode === "app" ? await selfInfo(baseEnv.supervisorToken!) : undefined;
const env = {
  ...baseEnv,
  ingressPort: app?.ingress_port || baseEnv.ingressPort,
  flavor: app?.slug?.endsWith("guest_assistant_beta") ? ("beta" as const) : baseEnv.flavor,
};
const store = Store.open(env.dataDir);
const runtime = new Runtime(env, store, mode);
runtime.hostNetwork = app?.host_network;
runtime.appPanelPath = ingressPanelPath(app);
await runtime.init();
if (env.flavor === "beta") console.log("This is Guest Assistant Beta.");

const sessions = new AdminSessions();
let guestServer: ReturnType<typeof createServer>["server"] | undefined;
try {
  guestServer = createServer(runtime, sessions).server;
  console.log(`Guest Assistant listening on ${guestServer.url}`);
} catch (err) {
  const message = describeListenError(err, env.port, "guest", mode);
  if (!message) throw err;
  if (mode === "standalone") {
    // The admin page lives on the same port: nothing could be reached.
    console.error(message);
    process.exit(1);
  }
  // As an app the admin page still opens through the sidebar and explains it.
  runtime.guestPortOpen = false;
  runtime.reportStartupProblem(message);
}
// Announces the proxy to the companion apps while the admin has switched that on.
new Announcer(runtime).start();

if (mode === "app") {
  try {
    const ingress = createIngressServer(runtime, sessions);
    console.log(`Admin page served to Home Assistant ingress on port ${ingress.port}`);
  } catch (err) {
    const message = describeListenError(err, env.ingressPort, "ingress", mode);
    if (!message) throw err;
    // Without it there is nothing left to show the problem on: stop, the
    // Supervisor shows the app as stopped and this line in its log.
    console.error(message);
    process.exit(1);
  }
} else if (guestServer) {
  console.log(`Admin page: ${new URL(ADMIN_BASE, runtime.publicUrl ?? guestServer.url)}`);
}

if (runtime.haSettings) {
  await runtime.connect();
} else if (runtime.mode === "app") {
  // As an app nothing needs to be asked: the Supervisor token is the admin.
  const setUp = async (attempt = 1): Promise<void> => {
    try {
      await connectAsApp(runtime, env.supervisorToken!);
    } catch (err) {
      console.error(`Setting up the Home Assistant user failed (attempt ${attempt}):`, err);
      setTimeout(() => void setUp(attempt + 1), Math.min(60_000, 5_000 * attempt));
    }
  };
  void setUp();
} else {
  // A fresh code is printed every hour until set-up is done.
  sessions.startSetupCodes((code) =>
    console.log(
      [
        "",
        "Guest Assistant is not set up yet.",
        `Open ${new URL(ADMIN_BASE, guestServer!.url)} and enter the setup code:`,
        "",
        `    ${code}`,
        "",
        "It is valid for one hour; then a new one is printed here.",
        "",
      ].join("\n"),
    ),
  );
}
