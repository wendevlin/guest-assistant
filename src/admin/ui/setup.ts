import { css, html, LitElement, nothing } from "lit";
import { api, ApiError, type DiscoveredHa, type StateView } from "./api";
import { t } from "./i18n";
import { shared, tokens } from "./styles";

/** Setup code (standalone, before set-up). Fires `done` once accepted. */
export class GaSetupCode extends LitElement {
  static properties = { _error: { state: true }, _busy: { state: true } };
  declare _error: string | null;
  declare _busy: boolean;
  static styles = [tokens, shared];

  constructor() {
    super();
    this._error = null;
    this._busy = false;
  }

  private async submit(e: Event) {
    e.preventDefault();
    const input = this.renderRoot.querySelector("input")!;
    this._busy = true;
    this._error = null;
    try {
      await api.setupCode(input.value);
      this.dispatchEvent(new CustomEvent("done"));
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._busy = false;
    }
  }

  render() {
    return html`
      <form class="card stack" @submit=${this.submit}>
        <h2>${t("setup.code.title")}</h2>
        <p class="muted">${t("setup.code.intro")}</p>
        ${this._error ? html`<div class="alert">${this._error}</div>` : nothing}
        <label class="field">
          ${t("setup.code.label")}
          <input name="code" autocomplete="one-time-code" inputmode="numeric" placeholder="1234-5678" required autofocus />
        </label>
        <div class="row"><button class="primary" type="submit" ?disabled=${this._busy}>${t("setup.code.submit")}</button></div>
      </form>
    `;
  }
}
customElements.define("ga-setup-code", GaSetupCode);

/** Pick a Home Assistant (discovered or typed) and sign in there as admin. */
export class GaConnect extends LitElement {
  static properties = {
    cancellable: { type: Boolean },
    _found: { state: true },
    _searching: { state: true },
    _selected: { state: true },
    _error: { state: true },
    _busy: { state: true },
  };
  declare cancellable: boolean;
  declare _found: DiscoveredHa[];
  declare _searching: boolean;
  declare _selected: string;
  declare _error: string | null;
  declare _busy: boolean;
  static styles = [
    tokens,
    shared,
    css`
      .options {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .option {
        display: flex;
        gap: 12px;
        align-items: center;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px 14px;
        cursor: pointer;
      }
      .option.unreachable {
        opacity: 0.6;
        cursor: default;
      }
      .option.selected {
        border-color: var(--primary);
        box-shadow: 0 0 0 1px var(--primary);
      }
    `,
  ];

  constructor() {
    super();
    this.cancellable = false;
    this._found = [];
    this._searching = false;
    this._selected = "";
    this._error = null;
    this._busy = false;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.search();
  }

  private async search() {
    this._searching = true;
    try {
      this._found = await api.discover();
      const first = this._found.find((f) => f.reachable);
      if (!this._selected && first) this._selected = first.url;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._searching = false;
    }
  }

  private async submit(e: Event) {
    e.preventDefault();
    if (!this._selected) return;
    this._busy = true;
    this._error = null;
    try {
      const { authorize_url } = await api.connect(this._selected);
      window.location.assign(authorize_url);
    } catch (err) {
      this._error = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      this._busy = false;
    }
  }

  render() {
    return html`
      <form class="card stack" @submit=${this.submit}>
        <h2>${t("setup.connect.title")}</h2>
        <p class="muted">${t("setup.connect.intro")}</p>
        ${this._error ? html`<div class="alert">${this._error}</div>` : nothing}
        <div class="stack">
          <div class="spread">
            <h3>${t("setup.connect.found")}</h3>
            <button type="button" class="plain" @click=${this.search} ?disabled=${this._searching}>${t("setup.connect.search_again")}</button>
          </div>
          ${this._searching
            ? html`<div class="row"><div class="spinner"></div><span class="muted">${t("setup.connect.searching")}</span></div>`
            : this._found.length === 0
              ? html`<p class="muted">${t("setup.connect.none")}</p>`
              : html`<div class="options">
                  ${this._found.map(
                    (ha) => html`
                      <label class="option ${this._selected === ha.url ? "selected" : ""} ${ha.reachable ? "" : "unreachable"}">
                        <input
                          type="radio"
                          name="ha"
                          .checked=${this._selected === ha.url}
                          ?disabled=${!ha.reachable}
                          @change=${() => (this._selected = ha.url)}
                        />
                        <span class="stack" style="gap:2px">
                          <strong>${ha.name}</strong>
                          <span class="muted small">${ha.url}${ha.version ? html` · ${ha.version}` : nothing}</span>
                          ${ha.reachable ? nothing : html`<span class="small">${t("setup.connect.unreachable")}</span>`}
                        </span>
                      </label>
                    `,
                  )}
                </div>`}
        </div>
        <label class="field">
          ${t("setup.connect.manual")}
          <input
            type="text"
            inputmode="url"
            placeholder=${t("setup.connect.url_hint")}
            .value=${this._found.some((f) => f.url === this._selected) ? "" : this._selected}
            @input=${(e: Event) => (this._selected = (e.target as HTMLInputElement).value.trim())}
          />
        </label>
        <div class="row">
          <button class="primary" type="submit" ?disabled=${this._busy || !this._selected}>${t("setup.connect.submit")}</button>
          ${this.cancellable
            ? html`<button type="button" @click=${() => this.dispatchEvent(new CustomEvent("cancel"))}>${t("cancel")}</button>`
            : nothing}
        </div>
      </form>
    `;
  }

}

customElements.define("ga-connect", GaConnect);

/** Login for an already set-up proxy (standalone). */
export class GaLogin extends LitElement {
  static properties = { state: { attribute: false }, _busy: { state: true }, _error: { state: true } };
  declare state: StateView;
  declare _busy: boolean;
  declare _error: string | null;
  static styles = [tokens, shared];

  constructor() {
    super();
    this._busy = false;
    this._error = null;
  }

  private async login() {
    this._busy = true;
    try {
      const { authorize_url } = await api.login();
      window.location.assign(authorize_url);
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
      this._busy = false;
    }
  }

  render() {
    return html`
      <div class="card stack">
        <h2>${t("login.title")}</h2>
        <p class="muted">${t("login.intro")}</p>
        ${this._error ? html`<div class="alert">${this._error}</div>` : nothing}
        <div class="row"><button class="primary" @click=${this.login} ?disabled=${this._busy}>${t("login.submit")}</button></div>
      </div>
    `;
  }
}
customElements.define("ga-login", GaLogin);
