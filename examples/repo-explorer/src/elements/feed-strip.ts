// <feed-strip>: the live feed as a thin activity strip — `changes_since`
// polled with a cursor (lib/feed.ts), newest first; clicking an entry opens
// its document. Properties: `entries`, `live`, `polling`, `pollSeconds`,
// `error`, `cursor`. Events: `open-doc { path }`, `feed-live { on }`,
// `feed-interval { seconds }`.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { byline, formatTime, type FeedEntry } from "../lib/feed.ts";

@customElement("feed-strip")
export class FeedStrip extends LitElement {
  static override styles = css`
    :host { display: flex; align-items: center; gap: 10px; font: 12.5px/1.4 system-ui, sans-serif; color: #1e2430; min-height: 28px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 1px 9px; border-radius: 12px; font-size: 11.5px; font-weight: 600; background: #e8eaef; color: #4a5160; cursor: pointer; flex: none; }
    .pill.live { background: #e6f4ea; color: #1e6b2e; }
    .pill.live .dot { width: 7px; height: 7px; border-radius: 50%; background: #2e7d32; animation: blink 1.6s infinite; }
    .pill.polling .dot { background: #1565c0; animation: none; }
    .pill.paused { background: #fff3e0; color: #8a5a00; }
    @keyframes blink { 50% { opacity: 0.35; } }
    .entries { display: flex; gap: 6px; overflow-x: auto; flex: 1; min-width: 0; padding: 2px 0; }
    .entry { flex: none; display: inline-flex; gap: 6px; align-items: baseline; padding: 1px 8px; border: 1px solid #e3e6ec; border-radius: 6px; background: #fff; cursor: pointer; white-space: nowrap; }
    .entry.fresh { animation: arrive 1.5s ease-out; }
    @keyframes arrive { from { box-shadow: 0 0 0 3px #a5d6a7; } to { box-shadow: 0 0 0 0 transparent; } }
    .entry:hover { background: #f4f6fa; }
    .entry .time { color: #1565c0; font-variant-numeric: tabular-nums; }
    .entry .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
    .entry .by { color: #8a94a6; font-size: 11px; }
    .entry.plain { cursor: default; color: #5a6270; }
    .empty { color: #8a94a6; }
    .err { color: #b3261e; }
    input { font: inherit; font-size: 12px; width: 3.5em; padding: 0 4px; border: 1px solid #c9cdd6; border-radius: 4px; }
    label { color: #5a6270; font-size: 12px; flex: none; }
  `;

  @property({ attribute: false }) entries: FeedEntry[] = [];
  @property({ type: Boolean }) live = true;
  @property({ type: Boolean }) polling = false;
  @property({ type: Number }) pollSeconds = 3;
  @property({ type: String }) error: string | null = null;
  @property({ attribute: false }) cursor: number | null = null;

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private renderEntry(e: FeedEntry, index: number) {
    const fresh = index === 0 ? "fresh" : "";
    if (e.docs.length === 0) return html`<span class="entry plain ${fresh}" title=${e.summary}><span class="time">${formatTime(e.ts)}</span><span>${e.summary}</span><span class="by">${byline(e)}</span></span>`;
    return html`${e.docs.map((d) => html`<span class="entry ${fresh}" title=${`${e.summary}\nseq ${e.seq} · ${e.key}`} @click=${() => this.emit("open-doc", { path: d.path })}>
      <span class="time">${formatTime(e.ts)}</span><span class="path">${d.path}</span><span class="by">${byline(e)}</span>
    </span>`)}`;
  }

  override render() {
    const pill = !this.live ? html`<span class="pill paused" @click=${() => this.emit("feed-live", { on: true })}>paused</span>`
      : html`<span class="pill live ${this.polling ? "polling" : ""}" @click=${() => this.emit("feed-live", { on: false })}><span class="dot"></span>live</span>`;
    return html`
      ${pill}
      <label>every <input type="number" min="1" max="3600" .value=${String(this.pollSeconds)} @change=${(e: Event) => this.emit("feed-interval", { seconds: Number((e.target as HTMLInputElement).value) })}> s</label>
      <div class="entries" data-entries>
        ${this.error ? html`<span class="err">${this.error}</span>` : nothing}
        ${this.entries.length
          ? repeat(this.entries, (e) => e.key, (e, i) => this.renderEntry(e, i))
          : html`<span class="empty">no changes since the page opened${this.cursor !== null ? ` (watching from seq ${this.cursor})` : ""} — changes_since, polled</span>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "feed-strip": FeedStrip }
}
