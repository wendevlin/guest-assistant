import { AdminSessions } from "./admin/sessions";
import { readEnv } from "./env";
import { ingressPanelPath } from "./ha/supervisor";
import { Runtime } from "./runtime";
import { ADMIN_BASE, createIngressServer, createServer } from "./server";
import { connectAsApp } from "./setup/connect";
import { importLegacyConfig } from "./setup/legacy-import";
import { Store } from "./store";

const env = readEnv();
const store = Store.open(env.dataDir);
const runtime = new Runtime(env, store, env.supervisorToken ? "app" : "standalone");
await runtime.init();
await importLegacyConfig(runtime, env.legacyConfigPath);

const sessions = new AdminSessions();
const { server } = createServer(runtime, sessions);
console.log(`Guest Assistant listening on ${server.url}`);

if (runtime.mode === "app") {
  const ingress = createIngressServer(runtime, sessions);
  console.log(`Admin page served to Home Assistant ingress on port ${ingress.port}`);
  runtime.appPanelPath = await ingressPanelPath(env.supervisorToken!);
} else {
  console.log(`Admin page: ${new URL(ADMIN_BASE, runtime.publicUrl ?? server.url)}`);
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
  const code = sessions.newSetupCode();
  console.log(
    [
      "",
      "Guest Assistant is not set up yet.",
      `Open ${new URL(ADMIN_BASE, server.url)} and enter the setup code:`,
      "",
      `    ${code}`,
      "",
    ].join("\n"),
  );
}
