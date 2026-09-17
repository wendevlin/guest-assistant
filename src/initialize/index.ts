import { createAuth, type Auth } from "../auth";
import { ConfigError, loadConfig, type Config } from "../config";
import { Dashboard } from "../dashboard";
import { HaClient } from "../ha/client";
import { flattenUsers } from "./flatten-users";
import { migrate } from "./migrate";
import { syncUsers } from "./sync-users";

export interface Runtime {
  config: Config;
  dashboards: Map<string, Dashboard>;
  client: HaClient;
  auth: Auth;
}

interface HADashboardInfo {
  url_path: string;
}

export async function initialize(configPath = "config.yaml"): Promise<Runtime> {
  const config = await loadConfig(configPath);

  const client = new HaClient(config["home-assistant"]);
  await client.connect();

  // The proxy must never run with an admin token: HA's own admin checks are a
  // second line of defence behind this proxy.
  const currentUser = (await client.sendCommand({ type: "auth/current_user" })) as {
    is_admin?: boolean;
    is_owner?: boolean;
    name?: string;
  };
  if (currentUser.is_admin || currentUser.is_owner) {
    throw new ConfigError(
      `The configured HA token belongs to an admin/owner user ("${currentUser.name}"). ` +
        "Create a dedicated non-admin user in Home Assistant and use its long-lived access token.",
    );
  }

  const haDashboards = (await client.sendCommand({ type: "lovelace/dashboards/list" })) as HADashboardInfo[];
  const availableIds = new Set(["lovelace", ...haDashboards.map((d) => d.url_path)]);
  console.log(`Available dashboards: ${[...availableIds].join(", ")}`);

  const validDashboards = config.dashboards.filter((d) => {
    if (!availableIds.has(d.id)) {
      console.warn(`Dashboard "${d.id}" not found in Home Assistant, skipping.`);
      return false;
    }
    return true;
  });

  const dashboards = new Map<string, Dashboard>();
  for (const d of validDashboards) {
    const dashboard = new Dashboard(d.id);
    await dashboard.load(client);
    dashboards.set(d.id, dashboard);
  }

  const reloadAll = async () => {
    for (const dashboard of dashboards.values()) {
      await dashboard.load(client).catch((err) => console.error(`Failed to reload dashboard "${dashboard.id}":`, err));
    }
  };

  await client.subscribeEvents("lovelace_updated", (event) => {
    const data = event.data as { url_path?: string | null } | undefined;
    const changedPath = data?.url_path ?? null;
    for (const dashboard of dashboards.values()) {
      if (dashboard.urlPath !== changedPath) continue;
      console.log(`Dashboard "${dashboard.id}" changed, re-analysing...`);
      dashboard.load(client).catch((err) => console.error(`Failed to reload dashboard "${dashboard.id}":`, err));
    }
  });

  let deviceRefresh: ReturnType<typeof setTimeout> | null = null;
  await client.subscribeEvents("entity_registry_updated", () => {
    if (deviceRefresh) clearTimeout(deviceRefresh);
    deviceRefresh = setTimeout(() => {
      for (const dashboard of dashboards.values()) {
        if (dashboard.status !== "ok") continue;
        dashboard.refreshDevices(client).catch((err) => console.error(`Failed to refresh devices for "${dashboard.id}":`, err));
      }
    }, 2_000);
  });

  client.onReconnect(() => {
    console.log("Reconnected to Home Assistant, re-analysing dashboards...");
    void reloadAll();
  });

  const cleanedConfig: Config = { ...config, dashboards: validDashboards };
  const users = flattenUsers(cleanedConfig);
  if (users.length === 0) {
    throw new ConfigError("No dashboards with users defined in config; nothing to serve.");
  }

  const auth = createAuth(cleanedConfig);
  await migrate(auth);
  await syncUsers(auth, users);

  console.log(`Initialized with ${users.length} user(s) across ${validDashboards.length} dashboard(s).`);

  return { config: cleanedConfig, dashboards, client, auth };
}
