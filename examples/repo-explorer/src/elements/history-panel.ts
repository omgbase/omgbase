// <history-panel>: a document's revisions (`from revisions where _doc_id == …
// order by _seq desc`) as a list — seq, time, origin/actor, reason, hash,
// current — and, for the selected one, the body as of that revision
// (`docs_read { at }`) beside the current body with a client-side unified diff
// (lib/diff.ts). Properties: `revisions`, `selected` (a rev), `current` (the
// live body), `at` (the selected revision's read), `loading`, `error`.
// Event: `history-select { rev | null }`.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { diffLineKind, diffStats, editScript, formatStats, splitLines, unifiedDiff } from "../lib/diff.ts";
import { formatTime } from "../lib/feed.ts";
import { byline, type RevisionRow } from "../lib/history.ts";
import type { DocAt } from "../lib/document.ts";

export interface HistorySelectDetail { rev: string | null }

@customElement("history-panel")
export class HistoryPanel extends LitElement {
  static override styles = css`
    :host { display: block; font: 13px/1.5 system-ui, sans-serif; color: #1e2430; }
    .query { font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #8a94a6; margin: 0 0 6px; word-break: break-all; }
    table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
    th, td { text-align: left; padding: 3px 10px 3px 0; border-bottom: 1px solid #eef0f4; vertical-align: top; white-space: nowrap; }
    th { color: #5a6270; font-weight: 600; }
    tr.rev { cursor: pointer; }
    tr.rev:hover td { background: #f7f8fa; }
    tr.rev.selected td { background: #e3edfb; }
    td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
    td.hash { color: #8a94a6; }
    .current { font-size: 11px; padding: 0 6px; border-radius: 9px; background: #e6f4ea; color: #1e6b2e; }
    .empty { color: #8a94a6; font-size: 12.5px; }
    .err { color: #b3261e; font-size: 12.5px; }
    .compare { margin-top: 12px; }
    .compare .hdr { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 6px; }
    .compare .hdr b { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
    .compare .stats .add { color: #1e6b2e; } .compare .stats .del { color: #b3261e; }
    .toggle { display: inline-flex; border: 1px solid #c9cdd6; border-radius: 4px; overflow: hidden; font-size: 12px; }
    .toggle button { font: inherit; border: 0; background: #fff; padding: 2px 8px; cursor: pointer; color: #5a6270; }
    .toggle button.on { background: #e3edfb; color: #0d47a1; }
    button.close { font: inherit; font-size: 12px; padding: 1px 8px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; cursor: pointer; }
    pre { margin: 0; padding: 8px 10px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: #fff; border: 1px solid #e8eaef; border-radius: 6px; max-height: 60vh; }
    pre .add { background: #e6ffed; color: #1a4d1f; display: block; }
    pre .del { background: #ffeef0; color: #7a1c1c; display: block; }
    pre .hunk { color: #6f42c1; display: block; }
    pre .ctx { display: block; }
    .side { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .side h4 { margin: 0 0 4px; font-size: 12px; color: #5a6270; font-weight: 600; }
    .note { color: #8a94a6; font-size: 12px; margin-top: 4px; }
  `;

  @property({ attribute: false }) revisions: RevisionRow[] | null = null;
  @property({ type: String }) selected: string | null = null;
  @property({ type: String }) current: string | null = null;
  @property({ attribute: false }) at: DocAt | null = null;
  @property({ type: Boolean }) loading = false;
  @property({ type: String }) error: string | null = null;
  @property({ type: String }) query: string | null = null;

  @state() private mode: "diff" | "side" = "diff";

  private select(rev: string | null): void {
    this.dispatchEvent(new CustomEvent<HistorySelectDetail>("history-select", { detail: { rev }, bubbles: true, composed: true }));
  }

  private renderCompare() {
    const at = this.at;
    if (!this.selected) return nothing;
    if (!at) return html`<div class="compare"><div class="note">${this.loading ? "reading the revision…" : this.error ?? ""}</div></div>`;
    const current = this.current ?? "";
    const script = editScript(splitLines(at.raw), splitLines(current));
    const stats = diffStats(script);
    const diff = unifiedDiff(at.raw, current);
    return html`<div class="compare" data-compare>
      <div class="hdr">
        <b>${at.rev}</b><span>→ current</span>
        <span class="stats"><span class="add">+${stats.added}</span> <span class="del">−${stats.removed}</span> (${formatStats(stats)})</span>
        ${at.path ? html`<span class="note">path as of the revision: ${at.path}</span>` : nothing}
        ${at.renderedHashMatch ? nothing : html`<span class="note">renderedHashMatch: false (document-level trivia changed since)</span>`}
        <span class="toggle">
          <button type="button" class=${this.mode === "diff" ? "on" : ""} @click=${() => { this.mode = "diff"; }}>unified diff</button>
          <button type="button" class=${this.mode === "side" ? "on" : ""} @click=${() => { this.mode = "side"; }}>side by side</button>
        </span>
        <button type="button" class="close" @click=${() => this.select(null)}>close</button>
      </div>
      ${this.mode === "diff"
        ? (diff === "" ? html`<div class="note">no textual change between this revision and the current body</div>` : html`<pre>${diff.split("\n").map((line) => html`<span class=${diffLineKind(line)}>${line}</span>`)}</pre>`)
        : html`<div class="side">
            <div><h4>${at.rev}</h4><pre>${at.raw}</pre></div>
            <div><h4>current</h4><pre>${current}</pre></div>
          </div>`}
      <div class="note">the diff is computed in the browser (Myers, 3 lines of context — the same rule as docs_diff_unified) from two docs_read { at } reads</div>
    </div>`;
  }

  override render() {
    const rows = this.revisions;
    return html`
      ${this.query ? html`<div class="query">${this.query}</div>` : nothing}
      ${rows === null
        ? html`<div class="empty">${this.error ?? "loading revisions…"}</div>`
        : rows.length === 0
          ? html`<div class="empty">no revisions</div>`
          : html`<table data-revisions>
            <thead><tr><th>seq</th><th>when</th><th>by</th><th>reason</th><th>rev</th><th>hash</th><th></th></tr></thead>
            <tbody>${rows.map((r) => html`<tr class="rev ${this.selected === r.rev ? "selected" : ""}" data-rev=${r.rev} @click=${() => this.select(this.selected === r.rev ? null : r.rev)}>
              <td>${r.seq}</td>
              <td title=${r.ts}>${formatTime(r.ts)}</td>
              <td>${byline(r)}</td>
              <td>${r.reason ?? ""}</td>
              <td class="mono">${r.rev}</td>
              <td class="mono hash" title=${r.hash}>${r.hash.slice(0, 12)}</td>
              <td>${r.isCurrent ? html`<span class="current">current</span>` : nothing}</td>
            </tr>`)}</tbody>
          </table>`}
      ${this.error && rows !== null ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.renderCompare()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "history-panel": HistoryPanel }
}
