// <stream-view>: one day's focus episodes as a list with durations, the `#tag`
// totals for the day, and a day picker — all RECONSTRUCTED from the pointer's
// revisions (lib/history.ts): no transition rows are stored. Read-only.
// Events: `stream-day { day }`.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { intentTotals, tagTotals, type Episode } from "../lib/history.ts";
import type { Intent } from "../lib/intents.ts";
import { formatDuration } from "../lib/model.ts";

export interface StreamDayDetail { day: string }

@customElement("stream-view")
export class StreamView extends LitElement {
  static override styles = css`
    :host { display: block; font: 13.5px/1.45 system-ui, sans-serif; color: #1e2430; }
    .bar { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #5a6270; margin: 0; font-weight: 600; }
    select { font: inherit; font-size: 12.5px; padding: 2px 6px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; }
    .total { color: #5a6270; font-size: 12.5px; margin-left: auto; }
    .src { color: #8a94a6; font-size: 11.5px; width: 100%; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 3px 10px 3px 0; border-bottom: 1px solid #eef0f4; vertical-align: top; }
    th { color: #5a6270; font-weight: 600; font-size: 12px; }
    td.time, td.dur { font-variant-numeric: tabular-nums; white-space: nowrap; color: #5a6270; font-size: 12.5px; }
    td.dur { text-align: right; color: #1e2430; }
    .kind { font-size: 11px; color: #8a94a6; border: 1px solid #e3e6ec; border-radius: 10px; padding: 0 6px; margin-left: 6px; }
    .kind.interrupt { color: #8a5a00; border-color: #ffe082; }
    .kind.back { color: #0d47a1; border-color: #90caf9; }
    .open { color: #1565c0; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 10px; font-size: 12.5px; }
    .tags .t { color: #5a6270; }
    .tags .t b { color: #1e2430; font-variant-numeric: tabular-nums; }
    .empty, .err { color: #8a94a6; font-size: 13px; }
    .err { color: #c62828; }
    .intents { margin-top: 10px; font-size: 12.5px; color: #5a6270; }
  `;

  @property({ attribute: false }) days: string[] = [];
  @property({ type: String }) day = "";
  @property({ attribute: false }) episodes: Episode[] = [];
  @property({ attribute: false }) intents: Map<string, Intent> = new Map();
  @property({ type: Boolean }) loading = false;
  @property({ type: String }) error: string | null = null;
  /** How many pointer revisions the history was read from. */
  @property({ type: Number }) revisions = 0;

  private titleOf(path: string): string {
    return this.intents.get(path)?.title ?? path.replace(/^.*\//, "").replace(/\.md$/, "");
  }

  override render() {
    const days = this.days.includes(this.day) || !this.day ? this.days : [this.day, ...this.days];
    const total = this.episodes.reduce((s, e) => s + e.seconds, 0);
    const tags = tagTotals(this.episodes, (p) => this.intents.get(p)?.tags ?? []);
    const byIntent = intentTotals(this.episodes);
    return html`
      <div class="bar">
        <h2>stream</h2>
        <select .value=${this.day} @change=${(e: Event) => this.dispatchEvent(new CustomEvent<StreamDayDetail>("stream-day", { detail: { day: (e.target as HTMLSelectElement).value }, bubbles: true, composed: true }))}>
          ${days.map((d) => html`<option value=${d} ?selected=${d === this.day}>${d}</option>`)}
        </select>
        <span class="total">${this.episodes.length} episode${this.episodes.length === 1 ? "" : "s"} · ${formatDuration(total)}</span>
        <span class="src">reconstructed from the pointer's ${this.revisions} revision${this.revisions === 1 ? "" : "s"} (<code>revisions</code> + <code>docs_read { at }</code>), not a log of transitions</span>
      </div>
      ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
      ${this.loading ? html`<div class="empty">loading…</div>` : this.episodes.length === 0 ? html`<div class="empty">no focus on this day</div>` : html`
        <table data-episodes>
          <thead><tr><th>from</th><th>intent</th><th style="text-align:right">for</th></tr></thead>
          <tbody>${this.episodes.map((e) => html`<tr>
            <td class="time">${e.start.slice(11, 16)}Z${e.carried ? html` <span class="kind" title="in focus since the day before">carried</span>` : nothing}</td>
            <td>${this.titleOf(e.intent)}${e.kind !== "switch" && !e.carried ? html`<span class="kind ${e.kind}">${e.kind}</span>` : nothing}</td>
            <td class="dur ${e.endedBy === "now" ? "open" : ""}" title=${e.endedBy === "now" ? "still in focus" : e.endedBy === "day-end" ? "ran past the end of the day" : `until ${e.end.slice(11, 16)}Z`}>${formatDuration(e.seconds)}${e.endedBy === "now" ? " …" : ""}</td>
          </tr>`)}</tbody>
        </table>
        <div class="tags">${tags.map((t) => html`<span class="t">#${t.tag} <b>${formatDuration(t.seconds)}</b></span>`)}</div>
        <div class="intents">${byIntent.map((i) => `${this.titleOf(i.intent)} ${formatDuration(i.seconds)}`).join(" · ")}</div>
      `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "stream-view": StreamView }
}
