/** Client for the admin JSON API. All paths are relative so the page works behind ingress. */

export interface StateView {
  mode: "standalone" | "app";
  configured: boolean;
  signed_in: "admin" | "setup" | null;
  admin_name: string | null;
  setup_code_required: boolean;
  ha: { url: string; state: "unconfigured" | "connecting" | "connected" | "error"; error: string | null; version: string | null; configured_by: string | null } | null;
  public_url: string | null;
}

export interface ThemeSettings {
  name?: string;
  mode?: "auto" | "light" | "dark";
  guest_can_change_mode?: boolean;
}

export interface QuestionView {
  key: string;
  kind: "navigate_view" | "navigate_outside" | "url" | "media_group";
  subject: string;
  paths: string[];
  options: string[];
  informational: boolean;
  answer: string;
  answered: boolean;
}

export interface DashboardView {
  id: string;
  title: string;
  status: "loading" | "ok" | "rejected";
  violations: Array<{ rule: string; path: string; message: string }>;
  entities: number;
  guests: number;
  theme: ThemeSettings;
  pending: number;
  questions: QuestionView[];
}

export interface DashboardsView {
  configured: DashboardView[];
  available: Array<{ id: string; title: string; require_admin: boolean; added: boolean }>;
}

export interface Guest {
  id: string;
  username: string;
  dashboard: string;
}

export interface DiscoveredHa {
  name: string;
  uuid: string;
  version?: string;
  url: string;
  urls: string[];
  reachable: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`api/${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-guest-assistant": "1" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  state: () => request<StateView>("GET", "state"),
  setupCode: (code: string) => request<{ ok: true }>("POST", "setup/code", { code }),
  discover: () => request<DiscoveredHa[]>("GET", "setup/discover"),
  connect: (url: string) => request<{ authorize_url: string }>("POST", "setup/connect", { url }),
  renewAppUser: () => request<StateView>("POST", "setup/renew", {}),
  login: () => request<{ authorize_url: string }>("POST", "login", {}),
  logout: () => request<{ ok: true }>("POST", "logout", {}),
  dashboards: () => request<DashboardsView>("GET", "dashboards"),
  preview: (id: string) => request<DashboardView>("GET", `dashboards/preview/${enc(id)}`),
  addDashboard: (id: string, theme: ThemeSettings, answers: Record<string, string>) =>
    request<DashboardsView>("POST", "dashboards", { id, theme, answers }),
  updateDashboard: (id: string, changes: { theme?: ThemeSettings; answers?: Record<string, string> }) =>
    request<DashboardsView>("PATCH", `dashboards/${enc(id)}`, changes),
  removeDashboard: (id: string) => request<DashboardsView>("DELETE", `dashboards/${enc(id)}`),
  guests: () => request<Guest[]>("GET", "guests"),
  createGuest: (guest: { username: string; password: string; dashboard: string }) =>
    request<Guest>("POST", "guests", guest),
  updateGuest: (id: string, changes: { password?: string; dashboard?: string }) =>
    request<Guest>("PATCH", `guests/${enc(id)}`, changes),
  deleteGuest: (id: string) => request<{ ok: true }>("DELETE", `guests/${enc(id)}`),
  themes: () => request<string[]>("GET", "themes"),
  saveSettings: (settings: { public_url: string }) => request<StateView>("PUT", "settings", settings),
};

/** A readable random password for guests. */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}
