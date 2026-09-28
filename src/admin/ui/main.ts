import { css, html, LitElement, nothing } from "lit";
import { api, type StateView } from "./api";
import "./dashboards";
import "./guests";
import { t } from "./i18n";
import "./settings";
import "./setup";
import { shared, tokens } from "./styles";

type Tab = "dashboards" | "guests" | "settings";

export class GaAdmin extends LitElement {
  static properties = {
    _state: { state: true },
    _tab: { state: true },
    _error: { state: true },
    _themes: { state: true },
  };
  declare _state: StateView | null;
  declare _tab: Tab;
  declare _error: string | null;
  declare _themes: string[];

  static styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
        min-height: 100vh;
        background: var(--bg);
      }
      header {
        background: var(--surface);
        border-bottom: 1px solid var(--border);
      }
      .bar {
        max-width: 960px;
        margin: 0 auto;
        padding: 12px 16px;
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .brand {
        display: flex;
        gap: 10px;
        align-items: center;
        flex: 1;
        min-width: 0;
      }
      .logo {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        background: var(--primary);
        display: grid;
        place-items: center;
        color: var(--primary-contrast);
        flex: none;
      }
      .brand h1 {
        font-size: 18px;
      }
      nav {
        max-width: 960px;
        margin: 0 auto;
        padding: 0 16px;
        display: flex;
        gap: 4px;
        overflow-x: auto;
      }
      nav button {
        border: none;
        border-radius: 0;
        background: none;
        color: var(--text-2);
        border-bottom: 2px solid transparent;
        padding: 10px 14px;
      }
      nav button[aria-selected="true"] {
        color: var(--primary);
        border-bottom-color: var(--primary);
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 24px 16px 48px;
      }
      main.narrow {
        max-width: 560px;
        padding-top: 48px;
      }
      .user {
        display: flex;
        gap: 8px;
        align-items: center;
      }
    `,
  ];

  constructor() {
    super();
    this._state = null;
    this._tab = (location.hash.slice(1) as Tab) || "dashboards";
    if (!["dashboards", "guests", "settings"].includes(this._tab)) this._tab = "dashboards";
    this._themes = [];
    // Errors from the sign-in round trip arrive as ?error=…
    const params = new URLSearchParams(location.search);
    this._error = params.get("error");
    if (this._error) history.replaceState(null, "", location.pathname + location.hash);
  }

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.addEventListener("state", (e) => (this._state = (e as CustomEvent<StateView>).detail));
  }

  private async refresh() {
    try {
      this._state = await api.state();
      if (this._state.signed_in === "admin" && this._state.ha?.state === "connected") {
        this._themes = await api.themes().catch(() => []);
      }
      // Set-up as an app runs in the background: poll until it is done.
      if (this._state.mode === "app" && (!this._state.configured || this._state.ha?.state === "connecting")) {
        setTimeout(() => void this.refresh(), 2000);
      }
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  private selectTab(tab: Tab) {
    this._tab = tab;
    history.replaceState(null, "", `#${tab}`);
  }

  private async logout() {
    await api.logout().catch(() => {});
    await this.refresh();
  }

  private connectionBadge(state: StateView) {
    const s = state.ha?.state ?? "unconfigured";
    const cls = s === "connected" ? "ok" : s === "error" ? "error" : "warn";
    return html`<span class="badge ${cls}" title=${state.ha?.error ?? ""}>${t(`conn.${s}`)}</span>`;
  }

  private renderBody(state: StateView) {
    if (!state.configured) {
      if (state.mode === "app") {
        return html`<div class="card stack">
          <h2>${t("setup.app.title")}</h2>
          <p class="muted">${t("setup.app.intro")}</p>
          <div class="spinner"></div>
        </div>`;
      }
      if (state.signed_in === null) return html`<ga-setup-code @done=${this.refresh}></ga-setup-code>`;
      return html`<ga-connect></ga-connect>`;
    }
    if (state.signed_in !== "admin") {
      if (state.mode === "app") return html`<div class="alert">${t("login.not_admin")}</div>`;
      return html`<ga-login .state=${state}></ga-login>`;
    }
    switch (this._tab) {
      case "dashboards":
        return html`<ga-dashboards .themes=${this._themes}></ga-dashboards>`;
      case "guests":
        return html`<ga-guests .themes=${this._themes}></ga-guests>`;
      case "settings":
        return html`<ga-settings .state=${state}></ga-settings>`;
    }
  }

  render() {
    const state = this._state;
    const signedIn = state?.signed_in === "admin" && state.configured;
    return html`
      <header>
        <div class="bar">
          <div class="brand">
            <div class="logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 4 4 10.5V20h5.5v-5h5v5H20v-9.5z" /></svg>
            </div>
            <h1>${t("title")} <span class="muted" style="font-weight:400">${t("subtitle")}</span></h1>
          </div>
          ${state?.configured ? this.connectionBadge(state) : nothing}
          ${signedIn
            ? html`<div class="user">
                <span class="muted small">${t("signed_in_as", { name: state.admin_name ?? "" })}</span>
                ${state.mode === "standalone" ? html`<button class="plain" @click=${this.logout}>${t("logout")}</button>` : nothing}
              </div>`
            : nothing}
        </div>
        ${signedIn
          ? html`<nav role="tablist">
              ${(["dashboards", "guests", "settings"] as const).map(
                (tab) =>
                  html`<button role="tab" aria-selected=${this._tab === tab} @click=${() => this.selectTab(tab)}>${t(`tabs.${tab}`)}</button>`,
              )}
            </nav>`
          : nothing}
      </header>
      <main class=${signedIn ? "" : "narrow"}>
        <div class="stack">
          ${this._error ? html`<div class="alert">${this._error}</div>` : nothing}
          ${state ? this.renderBody(state) : html`<div class="spinner"></div>`}
        </div>
      </main>
    `;
  }
}
customElements.define("ga-admin", GaAdmin);
