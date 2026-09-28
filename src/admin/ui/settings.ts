import { css, html, LitElement, nothing } from "lit";
import { api, type StateView } from "./api";
import { t } from "./i18n";
import { shared, tokens } from "./styles";
import "./setup";

export class GaSettings extends LitElement {
  static properties = {
    state: { attribute: false },
    _reconnect: { state: true },
    _publicUrl: { state: true },
    _error: { state: true },
    _saved: { state: true },
    _busy: { state: true },
  };
  declare state: StateView;
  declare _reconnect: boolean;
  declare _publicUrl: string | null;
  declare _error: string | null;
  declare _saved: boolean;
  declare _busy: boolean;

  static styles = [
    tokens,
    shared,
    css`
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 8px 20px;
        margin: 0;
      }
      dt {
        color: var(--text-2);
      }
      dd {
        margin: 0;
        word-break: break-all;
      }
    `,
  ];

  constructor() {
    super();
    this._reconnect = false;
    this._publicUrl = null;
    this._error = null;
    this._saved = false;
    this._busy = false;
  }

  private changed(state: StateView) {
    this.dispatchEvent(new CustomEvent("state", { detail: state, bubbles: true, composed: true }));
  }

  private async savePublicUrl(e: Event) {
    e.preventDefault();
    this._error = null;
    try {
      this.changed(await api.saveSettings({ public_url: this._publicUrl ?? this.state.public_url ?? "" }));
      this._publicUrl = null;
      this._saved = true;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  private async renew() {
    this._busy = true;
    this._error = null;
    try {
      this.changed(await api.renewAppUser());
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._busy = false;
    }
  }

  render() {
    const ha = this.state.ha;
    if (this._reconnect) return html`<ga-connect cancellable @cancel=${() => (this._reconnect = false)}></ga-connect>`;
    const guestLink = this.state.public_url ?? (this.state.mode === "standalone" ? window.location.origin : null);
    return html`
      <div class="stack">
        ${this._error ? html`<div class="alert">${this._error}</div>` : nothing}
        <div class="card stack">
          <h2>${t("settings.ha")}</h2>
          ${ha
            ? html`
                <dl>
                  <dt>${t("settings.url")}</dt>
                  <dd>${ha.url}</dd>
                  <dt>${t("settings.state")}</dt>
                  <dd>${t(`conn.${ha.state}`)}</dd>
                  ${ha.version ? html`<dt>${t("settings.version")}</dt><dd>${ha.version}</dd>` : nothing}
                  ${ha.configured_by ? html`<dt>${t("settings.configured_by")}</dt><dd>${ha.configured_by}</dd>` : nothing}
                </dl>
                ${ha.error ? html`<div class="alert">${ha.error}</div>` : nothing}
              `
            : nothing}
          ${this.state.mode === "app"
            ? html`
                <p class="muted small">${t("settings.renew_hint")}</p>
                <div class="row"><button @click=${this.renew} ?disabled=${this._busy}>${t("settings.renew")}</button></div>
              `
            : html`
                <p class="muted small">${t("settings.reconnect_hint")}</p>
                <div class="row"><button @click=${() => (this._reconnect = true)}>${t("settings.reconnect")}</button></div>
              `}
        </div>
        <form class="card stack" @submit=${this.savePublicUrl}>
          <h2>${t("settings.public_url")}</h2>
          <p class="muted small">${t("settings.public_url_hint")}</p>
          <input
            type="url"
            placeholder="https://"
            .value=${this._publicUrl ?? this.state.public_url ?? ""}
            @input=${(e: Event) => ((this._publicUrl = (e.target as HTMLInputElement).value.trim()), (this._saved = false))}
          />
          ${guestLink ? html`<p class="small muted">${t("settings.guest_link")}: <code>${guestLink}</code></p>` : nothing}
          <div class="row">
            <button type="submit" ?disabled=${this._publicUrl === null}>${t("save")}</button>
            ${this._saved ? html`<span class="muted small">${t("saved")}</span>` : nothing}
          </div>
        </form>
      </div>
    `;
  }
}
customElements.define("ga-settings", GaSettings);
