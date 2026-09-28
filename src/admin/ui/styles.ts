import { css } from "lit";

export const tokens = css`
  :host {
    --primary: #009ac7;
    --primary-contrast: #fff;
    --bg: #f6f7f9;
    --surface: #fff;
    --surface-2: #f0f2f5;
    --text: #1b1f24;
    --text-2: #5c6570;
    --border: #dde1e6;
    --ok: #2e7d32;
    --ok-bg: #e7f4e8;
    --warn: #a15c00;
    --warn-bg: #fff3dd;
    --error: #c62828;
    --error-bg: #fdecec;
    --radius: 12px;
    color: var(--text);
    font-family: Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 15px;
    line-height: 1.45;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --primary: #29b6e8;
      --primary-contrast: #06212b;
      --bg: #111418;
      --surface: #1b1f24;
      --surface-2: #242a31;
      --text: #e3e6ea;
      --text-2: #9aa4ae;
      --border: #333a42;
      --ok: #81c784;
      --ok-bg: #1d2b1e;
      --warn: #ffb74d;
      --warn-bg: #2e2415;
      --error: #ef9a9a;
      --error-bg: #321b1b;
    }
  }
`;

export const shared = css`
  * {
    box-sizing: border-box;
  }
  h1,
  h2,
  h3 {
    margin: 0;
    font-weight: 500;
  }
  h2 {
    font-size: 20px;
  }
  h3 {
    font-size: 16px;
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--text-2);
  }
  .small {
    font-size: 13px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .spread {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
  }
  button {
    font: inherit;
    font-weight: 500;
    border-radius: 999px;
    padding: 8px 18px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--primary);
    cursor: pointer;
    min-height: 40px;
  }
  button.primary {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--primary-contrast);
  }
  button.danger {
    color: var(--error);
  }
  button.plain {
    border-color: transparent;
    background: transparent;
    padding: 8px 10px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible,
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  label.field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    color: var(--text-2);
  }
  input,
  select {
    font: inherit;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 9px 12px;
    min-height: 40px;
    width: 100%;
  }
  input[type="radio"],
  input[type="checkbox"] {
    width: auto;
    min-height: 0;
    accent-color: var(--primary);
  }
  .alert {
    border-radius: 8px;
    padding: 12px 14px;
    background: var(--error-bg);
    color: var(--error);
  }
  .alert.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .alert.ok {
    background: var(--ok-bg);
    color: var(--ok);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 500;
    border-radius: 999px;
    padding: 2px 10px;
    background: var(--surface-2);
    color: var(--text-2);
    white-space: nowrap;
  }
  .badge.ok {
    background: var(--ok-bg);
    color: var(--ok);
  }
  .badge.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .badge.error {
    background: var(--error-bg);
    color: var(--error);
  }
  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px;
    background: var(--surface-2);
    border-radius: 4px;
    padding: 1px 5px;
    word-break: break-all;
  }
  .spinner {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 3px solid var(--border);
    border-top-color: var(--primary);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .grid-2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
  }
`;
