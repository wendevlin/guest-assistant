import { html, LitElement, nothing } from "lit";
import type { ThemeSettings } from "./api";
import { t } from "./i18n";
import { shared, tokens } from "./styles";

/**
 * Edits ThemeSettings. With `inherit` set (guest overrides), every field can
 * also be left to the dashboard. Fires `change` with the new settings.
 */
export class GaThemeEditor extends LitElement {
  static properties = {
    value: { attribute: false },
    themes: { attribute: false },
    inherit: { type: Boolean },
  };

  declare value: ThemeSettings;
  declare themes: string[];
  declare inherit: boolean;

  static styles = [tokens, shared];

  constructor() {
    super();
    this.value = {};
    this.themes = [];
    this.inherit = false;
  }

  private update_(patch: Partial<Record<keyof ThemeSettings, unknown>>) {
    const next: Record<string, unknown> = { ...this.value, ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined || v === "") delete next[k];
    this.value = next as ThemeSettings;
    this.dispatchEvent(new CustomEvent("change", { detail: this.value }));
  }

  render() {
    const v = this.value;
    const inheritOption = this.inherit ? html`<option value="" ?selected=${v.mode === undefined}>${t("theme.inherit")}</option>` : nothing;
    const switchValue = v.guest_can_change_mode === undefined ? "" : v.guest_can_change_mode ? "yes" : "no";
    return html`
      <div class="grid-2">
        <label class="field">
          ${t("theme.name")}
          <select @change=${(e: Event) => this.update_({ name: (e.target as HTMLSelectElement).value || undefined })}>
            <option value="" ?selected=${!v.name}>${this.inherit ? t("theme.inherit") : t("theme.default")}</option>
            ${this.themes.map((name) => html`<option value=${name} ?selected=${v.name === name}>${name}</option>`)}
            ${v.name && !this.themes.includes(v.name) ? html`<option value=${v.name} selected>${v.name}</option>` : nothing}
          </select>
        </label>
        <label class="field">
          ${t("theme.mode")}
          <select @change=${(e: Event) => this.update_({ mode: (e.target as HTMLSelectElement).value || undefined })}>
            ${inheritOption}
            ${(["auto", "light", "dark"] as const).map(
              (m) => html`<option value=${m} ?selected=${(v.mode ?? (this.inherit ? undefined : "auto")) === m}>${t(`theme.mode.${m}`)}</option>`,
            )}
          </select>
        </label>
        <label class="field">
          ${t("theme.switch")}
          <select
            @change=${(e: Event) => {
              const s = (e.target as HTMLSelectElement).value;
              this.update_({ guest_can_change_mode: s === "" ? undefined : s === "yes" });
            }}
          >
            ${this.inherit ? html`<option value="" ?selected=${switchValue === ""}>${t("theme.inherit")}</option>` : nothing}
            <option value="yes" ?selected=${switchValue === "yes"}>${t("theme.switch.yes")}</option>
            <option value="no" ?selected=${switchValue === "no" || (!this.inherit && switchValue === "")}>${t("theme.switch.no")}</option>
          </select>
        </label>
      </div>
    `;
  }
}
customElements.define("ga-theme-editor", GaThemeEditor);
