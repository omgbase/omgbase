// <query-console>: a textarea for OQX (Cmd/Ctrl+Enter runs), the result as a
// table whose `_id`/`_path` cells are links into the explorer, "more" for the
// next page, the result's `hints` as a yellow bar, the engine's error with its
// `data.fix`, and a "syntax" button that opens `query_syntax` in a drawer
// (fetched once by the page). Properties: `query`, `result`, `error`,
// `running`, `syntax`, `shown` (rows so far). Events: `console-run { query }`,
// `console-more`, `console-open { link }`, `console-syntax`, `console-input {
// query }`.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "@shoelace-style/shoelace/dist/components/drawer/drawer.js";
import { cellOf, columnsOf, footerText, isRunShortcut, scalarLine, type CellLink, type ToolErrorInfo } from "../lib/console.ts";
import type { QueryResult } from "../lib/query.ts";

export interface ConsoleRunDetail { query: string }
export interface ConsoleOpenDetail { link: CellLink }

@customElement("query-console")
export class QueryConsole extends LitElement {
  static override styles = css`
    /* The host never grows past its container: a wide result table scrolls
       inside .results (both axes) while the query, buttons and footer stay put. */
    :host { display: flex; flex-direction: column; min-height: 0; min-width: 0; max-width: 100%; overflow: hidden; font: 13px/1.5 system-ui, sans-serif; color: #1e2430; }
    .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
    .bar .title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #5a6270; font-weight: 600; }
    .bar .spacer { flex: 1; }
    button { font: inherit; font-size: 12.5px; padding: 2px 10px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; cursor: pointer; }
    button.primary { background: #1565c0; color: #fff; border-color: #1565c0; }
    button:disabled { opacity: 0.5; cursor: default; }
    textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 6px 8px; border: 1px solid #c9cdd6; border-radius: 4px; }
    .hints { margin: 6px 0 0; padding: 6px 10px; border-radius: 6px; background: #fff8e1; border: 1px solid #ffe082; color: #6d4c00; font-size: 12.5px; }
    .hints code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .error { margin: 6px 0 0; padding: 6px 10px; border-radius: 6px; background: #fff5f5; border: 1px solid #ef9a9a; color: #c62828; font-size: 12.5px; }
    .error .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
    .error pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #1e2430; background: #fff; border: 1px solid #e8eaef; border-radius: 4px; padding: 4px 8px; }
    .results { margin-top: 6px; overflow: auto; min-height: 0; min-width: 0; max-width: 100%; flex: 1; }
    table { border-collapse: collapse; font-size: 12.5px; }
    th, td { text-align: left; padding: 2px 10px 2px 0; border-bottom: 1px solid #eef0f4; vertical-align: top; white-space: nowrap; max-width: 36em; overflow: hidden; text-overflow: ellipsis; }
    th { color: #5a6270; font-weight: 600; position: sticky; top: 0; background: #fff; }
    td { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    td a { color: #1565c0; cursor: pointer; text-decoration: none; }
    td a:hover { text-decoration: underline; }
    .scalar { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 6px 0; }
    .values li { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .foot { display: flex; gap: 10px; align-items: center; font-size: 12px; color: #5a6270; margin-top: 6px; }
    sl-drawer pre { white-space: pre-wrap; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; }
    sl-drawer::part(panel) { width: min(760px, 90vw); }
  `;

  @property({ type: String }) query = "";
  @property({ attribute: false }) result: QueryResult | null = null;
  @property({ attribute: false }) rows: Record<string, unknown>[] = [];
  @property({ attribute: false }) error: ToolErrorInfo | null = null;
  @property({ type: Boolean }) running = false;
  @property({ type: String }) syntax: string | null = null;

  @state() private drawerOpen = false;

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private run(): void {
    if (this.running || !this.query.trim()) return;
    this.emit<ConsoleRunDetail>("console-run", { query: this.query });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (isRunShortcut(e)) { e.preventDefault(); this.run(); }
  }

  private openSyntax(): void {
    this.drawerOpen = true;
    if (this.syntax === null) this.emit("console-syntax", {});
  }

  private renderCell(value: unknown) {
    const c = cellOf(value);
    if (!c.link) return html`${c.text}`;
    const link = c.link;
    return html`<a href=${link.kind === "doc" ? `#doc=${link.path}` : "#"} title=${link.kind === "doc" ? "open this document" : `open the ${link.of} ${link.id}`} @click=${(e: Event) => { e.preventDefault(); this.emit<ConsoleOpenDetail>("console-open", { link }); }}>${c.text}</a>`;
  }

  private renderResults() {
    const r = this.result;
    if (!r) return nothing;
    const scalar = scalarLine(r);
    if (r.values) {
      return html`<div class="scalar">${scalar}</div><ol class="values">${r.values.map((v) => html`<li>${this.renderCell(v)}</li>`)}</ol>`;
    }
    if (scalar) return html`<div class="scalar" data-scalar>${scalar}</div>`;
    const rows = this.rows;
    const cols = columnsOf(rows);
    if (rows.length === 0) return html`<div class="foot">no rows</div>`;
    return html`<table data-results>
      <thead><tr>${cols.map((c) => html`<th>${c}</th>`)}</tr></thead>
      <tbody>${rows.map((row) => html`<tr>${cols.map((c) => html`<td>${this.renderCell(row[c])}</td>`)}</tr>`)}</tbody>
    </table>`;
  }

  override render() {
    const r = this.result;
    const err = this.error;
    return html`
      <div class="bar">
        <span class="title">query console</span>
        <span class="spacer"></span>
        <button type="button" @click=${this.openSyntax}>syntax</button>
        <button type="button" class="primary" ?disabled=${this.running || !this.query.trim()} @click=${this.run} title="⌘/Ctrl + Enter">${this.running ? "running…" : "run"}</button>
      </div>
      <textarea spellcheck="false" .value=${this.query} placeholder="select _title, layer from docs where …   (⌘/Ctrl+Enter runs)"
        @input=${(e: Event) => { this.query = (e.target as HTMLTextAreaElement).value; this.emit("console-input", { query: this.query }); }}
        @keydown=${this.onKeydown}></textarea>
      ${r?.hints?.length ? html`<div class="hints" data-hints>${r.hints.map((h) => html`<div>${renderBackticks(h)}</div>`)}</div>` : nothing}
      ${err ? html`<div class="error" data-error><span class="code">${err.code}</span> — ${err.message}${err.hint ? html` <span>(${err.hint})</span>` : nothing}${err.fix ? html`<div>the engine's corrected call (<code>data.fix</code>):</div><pre>${err.fix}</pre>` : nothing}</div>` : nothing}
      <div class="results">${this.renderResults()}</div>
      ${r && !scalarLine(r) ? html`<div class="foot" data-foot>
        <span>${footerText(r, this.rows.length)}</span>
        ${r.truncated && r.cursor ? html`<button type="button" ?disabled=${this.running} @click=${() => this.emit("console-more", {})}>more</button>` : nothing}
      </div>` : nothing}
      <sl-drawer label="OQX syntax (query_syntax)" ?open=${this.drawerOpen} @sl-after-hide=${() => { this.drawerOpen = false; }}>
        <pre>${this.syntax ?? "fetching query_syntax…"}</pre>
      </sl-drawer>
    `;
  }
}

/** A hint's backtick runs as <code>. */
function renderBackticks(text: string) {
  return text.split("`").map((part, i) => (i % 2 === 1 ? html`<code>${part}</code>` : html`${part}`));
}

declare global {
  interface HTMLElementTagNameMap { "query-console": QueryConsole }
}
