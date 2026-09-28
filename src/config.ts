import { file, YAML } from "bun";
import z from "zod";

const HomeAssistantConfig = z.object({
  host: z.string().min(1).default("localhost"),
  port: z.number().int().positive().default(8123),
  tls: z.boolean().default(false),
  long_lived_access_token: z.string().min(1),
});

/** Same rule as better-auth's username plugin; checked here for a clear error at start-up. */
export const USERNAME_RE = /^[a-zA-Z0-9_.]+$/;

/**
 * How the guest UI looks. Set on a dashboard; a user's own `theme` overrides
 * single fields of it.
 */
const ThemeConfig = z.strictObject({
  /** Name of a theme defined in HA; omitted = HA's default theme. */
  name: z.string().min(1).optional(),
  /** auto follows the guest device's light/dark setting. */
  mode: z.enum(["auto", "light", "dark"]).optional(),
  /** Lets guests switch between auto, light and dark on their device. */
  guest_can_change_mode: z.boolean().optional(),
});

const UserConfig = z.object({
  username: z
    .string()
    .min(3, "username must be at least 3 characters")
    .max(30, "username must be at most 30 characters")
    .regex(USERNAME_RE, "username may only contain letters, digits, '_' and '.'"),
  password: z.string().min(8, "password must be at least 8 characters"),
  theme: ThemeConfig.optional(),
});

const DashboardConfig = z.object({
  id: z.string().min(1),
  theme: ThemeConfig.optional(),
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

export interface GuestTheme {
  name?: string;
  mode: "auto" | "light" | "dark";
  guest_can_change_mode: boolean;
}

/** The theme for a user: defaults, then the dashboard's, then the user's own settings. */
export function themeForUser(config: Pick<Config, "dashboards">, username: string): GuestTheme {
  const theme: GuestTheme = { mode: "auto", guest_can_change_mode: false };
  const wanted = username.toLowerCase();
  for (const dashboard of config.dashboards) {
    const user = dashboard.users.find((u) => u.username.toLowerCase() === wanted);
    if (user) return { ...theme, ...dashboard.theme, ...user.theme };
  }
  return theme;
}

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
