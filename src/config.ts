import { file, YAML } from "bun";
import z from "zod";

const HomeAssistantConfig = z.object({
  host: z.string().min(1).default("localhost"),
  port: z.number().int().positive().default(8123),
  tls: z.boolean().default(false),
  long_lived_access_token: z.string().min(1),
});

const UserConfig = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const DashboardConfig = z.object({
  id: z.string().min(1),
  users: z.array(UserConfig).default([]),
});

const Config = z.object({
  "home-assistant": HomeAssistantConfig,
  /** Public URL under which guests reach this proxy (cookies, CSRF origin). */
  base_url: z.url().default("http://localhost:3001"),
  port: z.number().int().positive().default(3001),
  dashboards: z.array(DashboardConfig).default([]),
  frontend_development_repo: z.string().optional(),
});

export type Config = z.infer<typeof Config>;
export type HAConfig = Config["home-assistant"];
export type DashboardConfigEntry = z.infer<typeof DashboardConfig>;

export class ConfigError extends Error {}

export function parseConfig(raw: unknown): Config {
  const result = Config.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<Config> {
  let yamlFile = file(path);

  if (!(await yamlFile.exists())) {
    const ymlPath = path.replace(/\.yaml$/, ".yml");
    yamlFile = file(ymlPath);
    if (!(await yamlFile.exists())) {
      throw new ConfigError(`Config file not found: ${path}`);
    }
  }

  const raw = YAML.parse(await yamlFile.text());
  return parseConfig(raw);
}

export function haHttpUrl(ha: HAConfig): string {
  return `${ha.tls ? "https" : "http"}://${ha.host}:${ha.port}`;
}

export function haWsUrl(ha: HAConfig): string {
  return `${ha.tls ? "wss" : "ws"}://${ha.host}:${ha.port}/api/websocket`;
}
