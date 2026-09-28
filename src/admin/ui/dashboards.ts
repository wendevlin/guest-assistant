import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { api, type DashboardsView, type DashboardView, type QuestionView, type ThemeSettings } from "./api";
import { t } from "./i18n";
import { shared, tokens } from "./styles";
import "./theme-editor";

function questionText(q: QuestionView): TemplateResult {
  const subject = html`<code>${q.subject}</code>`;
  const parts = t(`q.${q.kind}`, { subject: "\u0000" }).split("\u0000");
  return html`${parts[0]}${subject}${parts[1] ?? ""}`;
}

/** Answers as the admin currently sees them: stored ones plus the given change. */
function answersWith(questions: QuestionView[], key: string, value: string): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) if (q.answered) answers[q.key] = q.answer;
  answers[key] = value;
  return answers;
}

export function renderQuestions(questions: QuestionView[], onAnswer: (q: QuestionView, value: string) => void): TemplateResult {
  if (questions.length === 0) return html`<p class="muted">${t("dash.no_questions")}</p>`;
  return html`
    <ul class="questions">
      ${questions.map(
        (q) => html`
          <li class=${q.answered ? "" : "open"}>
            <div class="stack" style="gap:8px">
              <div class="row">${q.answered ? nothing : html`<span class="badge warn">${t("dash.new")}</span>`}<span>${questionText(q)}</span></div>
              <div class="row">
                ${q.informational
                  ? q.answered
                    ? nothing
                    : html`<button class="plain" @click=${() => onAnswer(q, "ok")}>${t("q.opt.ok")}</button>`
                  : q.options.map(
                      (opt) => html`
                        <label class="choice">
                          <input type="radio" name=${q.key} .checked=${q.answered && q.answer === opt} @change=${() => onAnswer(q, opt)} />
                          ${t(`q.opt.${opt}` as "q.opt.ok")}
                        </label>
                      `,
                    )}
              </div>
            </div>
          </li>
        `,
      )}
    </ul>
  `;
}

export class GaDashboards extends LitElement {
  static properties = {
    themes: { attribute: false },
    _data: { state: true },
    _open: { state: true },
    _error: { state: true },
    _adding: { state: true },
    _addId: { state: true },
    _preview: { state: true },
    _previewAnswers: { state: true },
    _previewTheme: { state: true },
    _themeDrafts: { state: true },
    _savedTheme: { state: true },
  };
  declare themes: string[];
  declare _data: DashboardsView | null;
  declare _open: string | null;
  declare _error: string | null;
  declare _adding: boolean;
  declare _addId: string;
  declare _preview: DashboardView | "loading" | null;
  declare _previewAnswers: Record<string, string>;
  declare _previewTheme: ThemeSettings;
  declare _themeDrafts: Record<string, ThemeSettings>;
  declare _savedTheme: string | null;

  static styles = [
    tokens,
    shared,
    css`
      .list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .head {
        display: flex;
        gap: 12px;
        align-items: center;
        cursor: pointer;
        background: none;
        border: none;
        border-radius: 0;
        padding: 0;
        width: 100%;
        text-align: start;
        color: inherit;
        min-height: 0;
        font-weight: inherit;
      }
      .head .title {
        flex: 1;
        min-width: 0;
      }
      .head .title strong {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .chev {
        transition: transform 0.15s;
        color: var(--text-2);
      }
      .chev.open {
        transform: rotate(90deg);
      }
      .body {
        margin-top: 16px;
        padding-top: 16px;
        border-top: 1px solid var(--border);
      }
      ul.questions,
      ul.violations {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      ul.questions li,
      ul.violations li {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 10px 14px;
      }
      ul.questions li.open {
        border-color: var(--warn);
      }
      label.choice {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        margin-inline-end: 12px;
        cursor: pointer;
      }
      .badges {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      @media (max-width: 600px) {
        .head {
          flex-wrap: wrap;
        }
        .badges {
          width: 100%;
          justify-content: flex-start;
          padding-inline-start: 24px;
        }
      }
    `,
  ];

  constructor() {
    super();
    this.themes = [];
    this._data = null;
    this._open = null;
    this._error = null;
    this._adding = false;
    this._addId = "";
    this._preview = null;
    this._previewAnswers = {};
    this._previewTheme = {};
    this._themeDrafts = {};
    this._savedTheme = null;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  async load() {
    try {
      this._data = await api.dashboards();
      if (this._open === null && this._data.configured.length === 1) this._open = this._data.configured[0]!.id;
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  private async run(action: () => Promise<DashboardsView>) {
    this._error = null;
    try {
      this._data = await action();
      this.dispatchEvent(new CustomEvent("changed", { bubbles: true, composed: true }));
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  private async pick(id: string) {
    this._addId = id;
    this._preview = id ? "loading" : null;
    this._previewAnswers = {};
    if (!id) return;
    try {
      this._preview = await api.preview(id);
    } catch (err) {
      this._preview = null;
      this._error = err instanceof Error ? err.message : String(err);
    }
  }

  private async add() {
    const id = this._addId;
    await this.run(() => api.addDashboard(id, this._previewTheme, this._previewAnswers));
    if (!this._error) {
      this._adding = false;
      this._addId = "";
      this._preview = null;
      this._previewTheme = {};
      this._open = id;
    }
  }

  private statusBadge(d: DashboardView) {
    const cls = d.status === "ok" ? "ok" : d.status === "rejected" ? "error" : "";
    return html`<span class="badge ${cls}">${t(`dash.status.${d.status}`)}</span>`;
  }

  private renderAnalysis(d: DashboardView, onAnswer: (q: QuestionView, value: string) => void) {
    if (d.status === "rejected") {
      return html`
        <div class="stack">
          <h3>${t("dash.violations")}</h3>
          <p class="muted small">${t("dash.violations_hint")}</p>
          <ul class="violations">
            ${d.violations.map((v) => html`<li><div>${v.message}</div><div class="muted small"><code>${v.path}</code></div></li>`)}
          </ul>
        </div>
      `;
    }
    return html`
      <div class="stack">
        <div>
          <h3>${t("dash.questions")}</h3>
          ${d.questions.some((q) => !q.informational) ? html`<p class="muted small">${t("dash.questions_hint")}</p>` : nothing}
        </div>
        ${renderQuestions(d.questions, onAnswer)}
      </div>
    `;
  }

  private renderDashboard(d: DashboardView) {
    const open = this._open === d.id;
    const draft = this._themeDrafts[d.id] ?? d.theme;
    return html`
      <div class="card">
        <button class="head" aria-expanded=${open} @click=${() => (this._open = open ? null : d.id)}>
          <span class="chev ${open ? "open" : ""}">▶</span>
          <span class="title">
            <strong>${d.title}</strong>
            <span class="muted small">/${d.id}</span>
          </span>
          <span class="badges">
            ${d.pending ? html`<span class="badge warn">${t("dash.pending", { count: d.pending })}</span>` : nothing}
            <span class="badge">${t("dash.guests", { count: d.guests })}</span>
            ${d.status === "ok" ? html`<span class="badge">${t("dash.entities", { count: d.entities })}</span>` : nothing}
            ${this.statusBadge(d)}
          </span>
        </button>
        ${open
          ? html`
              <div class="body stack">
                ${this.renderAnalysis(d, (q, value) => this.run(() => api.updateDashboard(d.id, { answers: answersWith(d.questions, q.key, value) })))}
                <div class="stack">
                  <h3>${t("dash.theme")}</h3>
                  <ga-theme-editor
                    .value=${draft}
                    .themes=${this.themes}
                    @change=${(e: CustomEvent<ThemeSettings>) => (this._themeDrafts = { ...this._themeDrafts, [d.id]: e.detail })}
                  ></ga-theme-editor>
                  <div class="row">
                    <button
                      ?disabled=${!this._themeDrafts[d.id]}
                      @click=${async () => {
                        await this.run(() => api.updateDashboard(d.id, { theme: draft }));
                        const { [d.id]: _, ...rest } = this._themeDrafts;
                        this._themeDrafts = rest;
                        this._savedTheme = d.id;
                      }}
                    >
                      ${t("save")}
                    </button>
                    ${this._savedTheme === d.id && !this._themeDrafts[d.id] ? html`<span class="muted small">${t("saved")}</span>` : nothing}
                  </div>
                </div>
                <div class="row">
                  <button
                    class="danger"
                    @click=${() => {
                      if (confirm(t("dash.remove_confirm", { name: d.title, count: d.guests }))) void this.run(() => api.removeDashboard(d.id));
                    }}
                  >
                    ${t("dash.remove")}
                  </button>
                </div>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderAdd() {
    const data = this._data!;
    const available = data.available.filter((d) => !d.added);
    const preview = this._preview;
    return html`
      <div class="card stack">
        <h2>${t("dash.add_title")}</h2>
        ${available.length === 0
          ? html`<p class="muted">${t("dash.none_available")}</p>`
          : html`
              <label class="field">
                ${t("dash.pick")}
                <select @change=${(e: Event) => this.pick((e.target as HTMLSelectElement).value)}>
                  <option value="" ?selected=${!this._addId}>${t("dash.pick_placeholder")}</option>
                  ${available.map(
                    (d) =>
                      html`<option value=${d.id} ?selected=${this._addId === d.id}>
                        ${d.title} (/${d.id})${d.require_admin ? ` – ${t("dash.admin_only")}` : ""}
                      </option>`,
                  )}
                </select>
              </label>
            `}
        ${preview === "loading" ? html`<div class="row"><div class="spinner"></div><span class="muted">${t("dash.analysing")}</span></div>` : nothing}
        ${preview && preview !== "loading"
          ? html`
              <div class="row">${this.statusBadge(preview)}${preview.status === "ok" ? html`<span class="badge">${t("dash.entities", { count: preview.entities })}</span>` : nothing}</div>
              ${this.renderAnalysis(
                {
                  ...preview,
                  questions: preview.questions.map((q) =>
                    q.key in this._previewAnswers ? { ...q, answer: this._previewAnswers[q.key]!, answered: true } : q,
                  ),
                },
                (q, value) => (this._previewAnswers = { ...this._previewAnswers, [q.key]: value }),
              )}
              <div class="stack">
                <h3>${t("dash.theme")}</h3>
                <ga-theme-editor
                  .value=${this._previewTheme}
                  .themes=${this.themes}
                  @change=${(e: CustomEvent<ThemeSettings>) => (this._previewTheme = e.detail)}
                ></ga-theme-editor>
              </div>
            `
          : nothing}
        <div class="row">
          <button class="primary" ?disabled=${!preview || preview === "loading"} @click=${this.add}>${t("add")}</button>
          <button @click=${() => ((this._adding = false), (this._preview = null), (this._addId = ""))}>${t("cancel")}</button>
        </div>
      </div>
    `;
  }

  render() {
    if (!this._data) {
      return this._error ? html`<div class="alert">${this._error}</div>` : html`<div class="spinner"></div>`;
    }
    return html`
      <div class="stack">
        <div class="spread">
          <p class="muted" style="max-width:640px">${t("dash.intro")}</p>
          ${this._adding ? nothing : html`<button class="primary" @click=${() => (this._adding = true)}>${t("dash.add")}</button>`}
        </div>
        ${this._error ? html`<div class="alert">${this._error}</div>` : nothing}
        ${this._adding ? this.renderAdd() : nothing}
        <div class="list">
          ${this._data.configured.length === 0 && !this._adding ? html`<p class="muted">${t("dash.empty")}</p>` : nothing}
          ${this._data.configured.map((d) => this.renderDashboard(d))}
        </div>
      </div>
    `;
  }
}
customElements.define("ga-dashboards", GaDashboards);
