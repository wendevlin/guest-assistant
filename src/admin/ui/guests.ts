import { css, html, LitElement, nothing } from "lit";
import { api, generatePassword, type DashboardsView, type Guest, type ThemeSettings } from "./api";
import { t } from "./i18n";
import { shared, tokens } from "./styles";
import "./theme-editor";

interface Draft {
  username: string;
  password: string;
  dashboard: string;
  theme: ThemeSettings;
}

export class GaGuests extends LitElement {
  static properties = {
    themes: { attribute: false },
    _guests: { state: true },
    _dashboards: { state: true },
    _error: { state: true },
    _notice: { state: true },
    _editing: { state: true },
    _draft: { state: true },
  };
  declare themes: string[];
  declare _guests: Guest[] | null;
  declare _dashboards: DashboardsView["configured"];
  declare _error: string | null;
  declare _notice: string | null;
  /** "new" or a guest id */
  declare _editing: string | null;
  declare _draft: Draft;

  static styles = [
    tokens,
    shared,
    css`
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        text-align: start;
        padding: 10px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      th {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-2);
      }
      td.actions {
        text-align: end;
        white-space: nowrap;
      }
      .table-wrap {
        overflow-x: auto;
      }
      .password {
        display: flex;
        gap: 8px;
      }
      .password input {
        flex: 1;
      }
    `,
  ];

  constructor() {
    super();
    this.themes = [];
    this._guests = null;
    this._dashboards = [];
    this._error = null;
    this._notice = null;
    this._editing = null;
    this._draft = { username: "", password: "", dashboard: "", theme: {} };
  }

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  async load() {
    try {
      const [guests, dashboards] = await Promise.all([api.guests(), api.dashboards()]);
      this._guests = guests;
      this._dashboards = dashboards.configured;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  private startNew() {
    this._notice = null;
    this._editing = "new";
    this._draft = { username: "", password: generatePassword(), dashboard: this._dashboards[0]?.id ?? "", theme: {} };
  }

  private startEdit(g: Guest) {
    this._notice = null;
    this._editing = g.id;
    this._draft = { username: g.username, password: "", dashboard: g.dashboard, theme: g.theme };
  }

  private async save(e: Event) {
    e.preventDefault();
    this._error = null;
    const d = this._draft;
    try {
      if (this._editing === "new") {
        await api.createGuest({ username: d.username, password: d.password, dashboard: d.dashboard, theme: d.theme });
        this._notice = t("guests.created", { name: d.username, password: d.password });
      } else if (this._editing) {
        await api.updateGuest(this._editing, { dashboard: d.dashboard, theme: d.theme, ...(d.password ? { password: d.password } : {}) });
      }
      this._editing = null;
      await this.load();
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  private async removeGuest(g: Guest) {
    if (!confirm(t("guests.delete_confirm", { name: g.username }))) return;
    try {
      await api.deleteGuest(g.id);
      await this.load();
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  private renderForm() {
    const d = this._draft;
    const isNew = this._editing === "new";
    const set = (patch: Partial<Draft>) => (this._draft = { ...this._draft, ...patch });
    return html`
      <form class="card stack" @submit=${this.save}>
        <h2>${isNew ? t("guests.add") : d.username}</h2>
        <div class="grid-2">
          ${isNew
            ? html`<label class="field">
                ${t("guests.username")}
                <input
                  required
                  minlength="3"
                  maxlength="30"
                  pattern="[a-zA-Z0-9_.]+"
                  autocomplete="off"
                  .value=${d.username}
                  @input=${(e: Event) => set({ username: (e.target as HTMLInputElement).value })}
                />
              </label>`
            : nothing}
          <label class="field">
            ${isNew ? t("guests.password") : t("guests.new_password")}
            <span class="password">
              <input
                ?required=${isNew}
                minlength="8"
                autocomplete="new-password"
                .value=${d.password}
                @input=${(e: Event) => set({ password: (e.target as HTMLInputElement).value })}
              />
              <button type="button" @click=${() => set({ password: generatePassword() })}>${t("guests.generate")}</button>
            </span>
            ${isNew ? nothing : html`<span class="small">${t("guests.new_password_hint")}</span>`}
          </label>
          <label class="field">
            ${t("guests.dashboard")}
            <select required @change=${(e: Event) => set({ dashboard: (e.target as HTMLSelectElement).value })}>
              ${this._dashboards.map((db) => html`<option value=${db.id} ?selected=${d.dashboard === db.id}>${db.title}</option>`)}
            </select>
          </label>
        </div>
        <div class="stack" style="gap:8px">
          <h3>${t("guests.theme")}</h3>
          <ga-theme-editor inherit .value=${d.theme} .themes=${this.themes} @change=${(e: CustomEvent<ThemeSettings>) => set({ theme: e.detail })}></ga-theme-editor>
        </div>
        <div class="row">
          <button class="primary" type="submit">${t("save")}</button>
          <button type="button" @click=${() => (this._editing = null)}>${t("cancel")}</button>
        </div>
      </form>
    `;
  }

  render() {
    if (!this._guests) return this._error ? html`<div class="alert">${this._error}</div>` : html`<div class="spinner"></div>`;
    const titles = new Map(this._dashboards.map((d) => [d.id, d.title]));
    return html`
      <div class="stack">
        <div class="spread">
          <p class="muted">${t("guests.intro")}</p>
          ${this._editing || this._dashboards.length === 0 ? nothing : html`<button class="primary" @click=${this.startNew}>${t("guests.add")}</button>`}
        </div>
        ${this._dashboards.length === 0 ? html`<div class="alert warn">${t("guests.no_dashboards")}</div>` : nothing}
        ${this._error ? html`<div class="alert">${this._error}</div>` : nothing}
        ${this._notice ? html`<div class="alert ok">${this._notice}</div>` : nothing}
        ${this._editing ? this.renderForm() : nothing}
        ${this._guests.length === 0
          ? html`<p class="muted">${t("guests.empty")}</p>`
          : html`
              <div class="card table-wrap" style="padding:8px 16px">
                <table>
                  <thead>
                    <tr>
                      <th>${t("guests.username")}</th>
                      <th>${t("guests.dashboard")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${this._guests.map(
                      (g) => html`
                        <tr>
                          <td><strong>${g.username}</strong></td>
                          <td>${titles.get(g.dashboard) ?? g.dashboard}</td>
                          <td class="actions">
                            <button class="plain" @click=${() => this.startEdit(g)}>${t("guests.edit")}</button>
                            <button class="plain danger" @click=${() => this.removeGuest(g)}>${t("delete")}</button>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `}
      </div>
    `;
  }
}
customElements.define("ga-guests", GaGuests);
