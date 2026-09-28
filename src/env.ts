import { resolve } from "node:path";

/**
 * Start-up settings that cannot live in the database because they are needed
 * before it is opened, or describe the environment the proxy runs in.
 * Everything else (Home Assistant connection, dashboards, guests) is managed
 * in the admin UI.
 */
export interface Env {
  /** Port guests connect to. In standalone mode the admin UI lives under /admin/ on it. */
  port: number;
  /** Directory for the SQLite database. */
  dataDir: string;
  /** Root of a guest-assistant-frontend checkout; its guest-assistant/dist is served. */
  frontendRepo?: string;
  /**
   * Set when running as a Home Assistant app (add-on): the Supervisor token.
   * The admin UI is then only reachable through ingress.
   */
  supervisorToken?: string;
  /** Port the Supervisor's ingress proxy talks to (app mode only). */
  ingressPort: number;
  /** Old config file that is imported once when the database is still empty. */
  legacyConfigPath: string;
}

function intVar(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`${name} must be a port number, got "${raw}"`);
  return n;
}

export function readEnv(): Env {
  const supervisorToken = process.env.SUPERVISOR_TOKEN || undefined;
  return {
    port: intVar("PORT", 3001),
    dataDir: resolve(process.env.DATA_DIR ?? (supervisorToken ? "/data" : "data")),
    frontendRepo: process.env.GUEST_ASSISTANT_FRONTEND_REPO || undefined,
    supervisorToken,
    ingressPort: intVar("INGRESS_PORT", 8099),
    legacyConfigPath: process.env.CONFIG_FILE ?? "config.yaml",
  };
}
