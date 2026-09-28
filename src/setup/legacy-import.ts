import { file, YAML } from "bun";
import z from "zod";
import { Password, Username } from "../guests";
import { normalizeHaUrl } from "../ha/endpoint";
import type { Runtime } from "../runtime";
import { ThemeSettings } from "../theme";

/**
 * Earlier versions were configured with a config.yaml. On the first start
 * with an empty database it is imported once; afterwards the admin UI is the
 * only place where settings change and the file is ignored.
 */
const LegacyConfig = z.object({
  "home-assistant": z.object({
    host: z.string().min(1).default("localhost"),
    port: z.number().int().positive().default(8123),
    tls: z.boolean().default(false),
    long_lived_access_token: z.string().min(1),
  }),
  base_url: z.url().optional(),
  dashboards: z
    .array(
      z.object({
        id: z.string().min(1),
        theme: ThemeSettings.optional(),
        users: z.array(z.object({ username: Username, password: Password, theme: ThemeSettings.optional() })).default([]),
      }),
    )
    .default([]),
  frontend_development_repo: z.string().optional(),
});

export async function importLegacyConfig(runtime: Runtime, path: string): Promise<boolean> {
  if (runtime.store.get("legacy_imported") || runtime.store.get("ha")) return false;
  const yamlFile = file(path);
  if (!(await yamlFile.exists())) return false;

  const parsed = LegacyConfig.safeParse(YAML.parse(await yamlFile.text()));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n");
    console.warn(`Not importing ${path}, it is not a valid old configuration:\n${issues}`);
    return false;
  }
  const config = parsed.data;
  const ha = config["home-assistant"];
  console.log(`Importing ${path}. From now on, settings are managed in the admin UI and the file is ignored.`);

  if (config.base_url && !config.base_url.startsWith("http://localhost")) await runtime.setPublicUrl(config.base_url);
  for (const d of config.dashboards) runtime.store.saveDashboard({ id: d.id, theme: d.theme ?? {}, answers: {} });

  // Accounts synced from the file by the old version are already in the
  // database; they are updated to the file's state instead of duplicated.
  const existing = new Map((await runtime.guests.list()).map((g) => [g.username.toLowerCase(), g]));
  for (const d of config.dashboards) {
    for (const u of d.users) {
      const guest = existing.get(u.username.toLowerCase());
      if (guest) await runtime.guests.update(guest.id, { password: u.password, dashboard: d.id, theme: u.theme ?? {} });
      else await runtime.guests.create({ username: u.username, password: u.password, dashboard: d.id, theme: u.theme });
    }
  }

  runtime.store.set("legacy_imported", true);
  runtime.store.set("ha", {
    url: normalizeHaUrl(`${ha.tls ? "https" : "http"}://${ha.host}:${ha.port}`),
    token: ha.long_lived_access_token,
    configured_by: "config.yaml",
  });
  if (config.frontend_development_repo && !runtime.env.frontendRepo) {
    console.warn(`frontend_development_repo is now set with GUEST_ASSISTANT_FRONTEND_REPO=${config.frontend_development_repo}`);
  }
  return true;
}
