// <focus-bar>: the one question, always visible and low-distraction — the
// focused intent's title, the time since `since` (live), its tags — and the
// one-line input: type and press Enter to declare a new intent AND focus it
// (`#tags` in the text become tags); Shift+Enter does the same as an
// `interrupt` (the displaced intent goes on the return stack); Ctrl/Cmd+R
// opens the chooser over recent intents (Enter resumes, Tab loads the text for
// editing, Esc closes); `back` appears while the stack is non-empty and names
// the return target; `stop` clears the focus. The bar never writes: it emits
// `attn-declare { text, interrupt }`, `attn-resume { path, interrupt }`,
// `attn-back`, `attn-stop`; the page does the `apply`.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { rankIntents, type ChooserRow, type Intent } from "../lib/intents.ts";
import { formatDuration, nowIso, secondsBetween } from "../lib/model.ts";
import { returnTarget, type FocusState } from "../lib/pointer.ts";

export interface DeclareDetail { text: string; interrupt: boolean }
export interface ResumeDetail { path: string; interrupt: boolean }
export interface BarMessage { kind: "error" | "info"; text: string; fix?: string | null }

/** Ctrl+R (or Cmd+R on a Mac) opens the chooser. */
export function isChooserShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return (e.key === "r" || e.key === "R") && (e.metaKey || e.ctrlKey);
}

@customElement("focus-bar")
export class FocusBar extends LitElement {
  static override styles = css`
    :host { display: block; font: 15px/1.45 system-ui, sans-serif; color: #1e2430; }
    .now { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; padding: 14px 18px 6px; }
    .now .q { color: #8a94a6; font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.06em; }
    .now .title { font-size: 22px; font-weight: 600; }
    .now .title.none { color: #8a94a6; font-weight: 400; font-style: italic; }
    .now .elapsed { font-variant-numeric: tabular-nums; color: #1565c0; font-size: 16px; }
    .now .tag { color: #5a6270; font-size: 13px; }
    .now .spacer { flex: 1; }
    button { font: inherit; font-size: 12.5px; padding: 3px 10px; border: 1px solid #c9cdd6; border-radius: 6px; background: #fff; cursor: pointer; }
    button:hover { background: #f4f6fa; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.back { border-color: #90caf9; color: #0d47a1; }
    .input { position: relative; padding: 0 18px 10px; }
    input { width: 100%; box-sizing: border-box; font: 16px/1.4 system-ui, sans-serif; padding: 8px 12px; border: 1px solid #c9cdd6; border-radius: 8px; background: #fff; }
    input:focus { outline: 2px solid #90caf9; border-color: #90caf9; }
    .hint { padding: 0 18px 8px; color: #8a94a6; font-size: 12px; }
    .hint kbd { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; border: 1px solid #d5d9e0; border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; background: #fff; }
    .msg { margin: 0 18px 8px; padding: 6px 10px; border-radius: 6px; font-size: 12.5px; background: #eef4ff; color: #1e3a5f; border: 1px solid #c5d8f7; }
    .msg.error { background: #fff5f5; color: #c62828; border-color: #ef9a9a; }
    .msg pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #1e2430; background: #fff; border: 1px solid #e8eaef; border-radius: 4px; padding: 4px 8px; }
    .chooser { position: absolute; left: 18px; right: 18px; top: 100%; margin-top: -8px; background: #fff; border: 1px solid #c9cdd6; border-radius: 8px; box-shadow: 0 6px 24px rgba(30, 36, 48, 0.12); z-index: 5; overflow: hidden; }
    .chooser .row { display: flex; gap: 10px; align-items: baseline; padding: 6px 12px; cursor: pointer; font-size: 14px; }
    .chooser .row.sel { background: #eef4ff; }
    .chooser .row .when { color: #8a94a6; font-size: 12px; margin-left: auto; font-variant-numeric: tabular-nums; }
    .chooser .row .tags { color: #5a6270; font-size: 12px; }
    .chooser .empty { padding: 8px 12px; color: #8a94a6; font-size: 13px; }
    .chooser .foot { padding: 4px 12px 6px; color: #8a94a6; font-size: 11.5px; border-top: 1px solid #eef0f4; }
  `;

  @property({ attribute: false }) pointer: FocusState = { exists: false, docId: null, rev: null, focused: null, since: null, returnStack: [] };
  /** The focused intent's row (null when nothing is in focus, or it is not among the intents). */
  @property({ attribute: false }) intent: Intent | null = null;
  @property({ attribute: false }) intents: Intent[] = [];
  /** Intent path → when it last took focus (the stream), for the chooser's order. */
  @property({ attribute: false }) recent: Map<string, string> = new Map();
  @property({ attribute: false }) titles: Map<string, string> = new Map();
  @property({ type: Boolean }) busy = false;
  @property({ attribute: false }) message: BarMessage | null = null;

  @state() private text = "";
  @state() private chooserOpen = false;
  @state() private selected = 0;
  @state() private tick = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.timer = setInterval(() => { this.tick++; }, 1000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
  }

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private rows(): ChooserRow[] {
    return rankIntents(this.intents, this.recent, this.text);
  }

  private declare(interrupt: boolean): void {
    const text = this.text.trim();
    if (!text || this.busy) return;
    this.emit<DeclareDetail>("attn-declare", { text, interrupt });
    this.text = "";
    this.chooserOpen = false;
  }

  private resume(row: ChooserRow, interrupt: boolean): void {
    if (this.busy) return;
    this.emit<ResumeDetail>("attn-resume", { path: row.intent.path, interrupt });
    this.text = "";
    this.chooserOpen = false;
  }

  private onKeydown(e: KeyboardEvent): void {
    if (isChooserShortcut(e)) { e.preventDefault(); this.chooserOpen = !this.chooserOpen; this.selected = 0; return; }
    if (e.key === "Escape") { this.chooserOpen = false; return; }
    const rows = this.chooserOpen ? this.rows() : [];
    if (this.chooserOpen && rows.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); this.selected = (this.selected + 1) % rows.length; return; }
      if (e.key === "ArrowUp") { e.preventDefault(); this.selected = (this.selected + rows.length - 1) % rows.length; return; }
      if (e.key === "Tab") {
        e.preventDefault();
        const r = rows[Math.min(this.selected, rows.length - 1)]!;
        this.text = `${r.intent.title}${r.intent.tags.map((t) => ` #${t}`).join("")}`;
        this.chooserOpen = false;
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); this.resume(rows[Math.min(this.selected, rows.length - 1)]!, e.shiftKey); return; }
    }
    if (e.key === "Enter") { e.preventDefault(); this.declare(e.shiftKey); }
  }

  private renderChooser() {
    if (!this.chooserOpen) return nothing;
    const rows = this.rows();
    return html`<div class="chooser" data-chooser>
      ${rows.length === 0 ? html`<div class="empty">no active intent matches — Enter declares "${this.text.trim()}"</div>` : rows.map((r, i) => html`
        <div class="row ${i === this.selected ? "sel" : ""}" @mousedown=${(e: Event) => { e.preventDefault(); this.resume(r, false); }} @mouseenter=${() => { this.selected = i; }}>
          <span>${r.intent.title}</span>
          <span class="tags">${r.intent.tags.map((t) => `#${t}`).join(" ")}</span>
          <span class="when">${r.lastFocused ? `last ${r.lastFocused.slice(5, 16).replace("T", " ")}Z` : "never focused"}</span>
        </div>`)}
      <div class="foot">↑↓ choose · Enter resume · Shift+Enter interrupt · Tab load the text · Esc</div>
    </div>`;
  }

  override render() {
    const p = this.pointer;
    void this.tick;
    const elapsed = p.focused && p.since ? formatDuration(secondsBetween(p.since, nowIso())) : null;
    const back = returnTarget(p);
    const title = this.intent?.title ?? (p.focused ? p.focused : null);
    const m = this.message;
    return html`
      <div class="now">
        <span class="q">what has your attention</span>
        <span class="title ${title ? "" : "none"}">${title ?? "nothing in focus"}</span>
        ${elapsed ? html`<span class="elapsed" title=${`since ${p.since}`}>${elapsed}</span>` : nothing}
        ${(this.intent?.tags ?? []).map((t) => html`<span class="tag">#${t}</span>`)}
        <span class="spacer"></span>
        ${back ? html`<button type="button" class="back" ?disabled=${this.busy} title=${back} @click=${() => this.emit("attn-back", {})}>back → ${this.titles.get(back) ?? back}</button>` : nothing}
        ${p.focused ? html`<button type="button" ?disabled=${this.busy} @click=${() => this.emit("attn-stop", {})}>stop</button>` : nothing}
      </div>
      <div class="input">
        <input type="text" spellcheck="false" placeholder=${p.focused ? "switch to… (Enter declares and focuses; Shift+Enter interrupts; ⌃/⌘R recent)" : "what has your attention? (Enter declares and focuses; ⌃/⌘R recent)"}
          .value=${this.text} ?disabled=${this.busy}
          @input=${(e: Event) => { this.text = (e.target as HTMLInputElement).value; this.selected = 0; }}
          @keydown=${this.onKeydown}
          @blur=${() => { setTimeout(() => { this.chooserOpen = false; }, 120); }}>
        ${this.renderChooser()}
      </div>
      <div class="hint"><kbd>Enter</kbd> declare + focus (<code>#tags</code> become tags) · <kbd>Shift</kbd>+<kbd>Enter</kbd> interrupt · <kbd>⌃/⌘</kbd>+<kbd>R</kbd> recent intents</div>
      ${m ? html`<div class="msg ${m.kind}" data-message>${m.text}${m.fix ? html`<div>the engine's corrected call (<code>data.fix</code>) — shown, not taken: another device switched first</div><pre>${m.fix}</pre>` : nothing}</div>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "focus-bar": FocusBar }
}
