// <command-palette>: the keyboard-first palette as an overlay — a text input,
// a results listbox and a key-hint footer over its own backdrop (no Shoelace
// dialog). The element owns nothing but the cursor, the 120 ms debounce and
// focus; the page owns the text's meaning (lib/palette.ts), runs the query and
// feeds `items` back. Two modes: `navigate` (Enter opens a document, runs an
// action or creates) and `pick` (Enter emits the chosen item for the page to
// use as a destination — the graph's find-or-create, without losing its
// source node or viewport). The global shortcut (⌘K) is the page's.
//
// Properties: `open`, `text`, `items`, `loading`, `error`, `placeholder`,
// `mode`, `heading` (shown above the input in pick mode: "connect /a.md to…").
// Events: `palette-search { text }` (debounced; immediate on open and on a
// cleared input), `palette-open-doc { path }`, `palette-action { id }`,
// `palette-create { path }`, `palette-pick { item }`, `palette-close`. The
// element never closes itself: the page sets `open` false after handling a
// selection or the close.
// Keys: ↑/↓/Home/End/PageUp/PageDown move (wrapping), Enter selects, Esc
// closes, Tab on a document completes the input with its path.

import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { isStepKey, stepIndex, type PaletteItem } from "../lib/palette.ts";

export interface PaletteSearchDetail { text: string }
export interface PaletteOpenDocDetail { path: string }
export interface PaletteActionDetail { id: string }
export interface PaletteCreateDetail { path: string }
export interface PalettePickDetail { item: PaletteItem }

export type PaletteMode = "navigate" | "pick";

export const SEARCH_DEBOUNCE_MS = 120;

@customElement("command-palette")
export class CommandPalette extends LitElement {
  static override styles = css`
    :host { display: contents; font: 13px/1.5 system-ui, sans-serif; color: #1e2430; }
    .backdrop { position: fixed; inset: 0; background: rgba(20, 24, 32, 0.35); z-index: 1000; }
    .panel {
      position: fixed; top: 12vh; left: 50%; transform: translateX(-50%); width: min(640px, 92vw); z-index: 1001;
      background: #fff; border: 1px solid #c9cdd6; border-radius: 10px; box-shadow: 0 18px 48px rgba(20, 24, 32, 0.25);
      display: flex; flex-direction: column; overflow: hidden;
      animation: rise 120ms ease-out;
    }
    @keyframes rise { from { opacity: 0; transform: translateX(-50%) translateY(-6px); } to { opacity: 1; transform: translateX(-50%); } }
    @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
    .heading { padding: 8px 14px 0; font-size: 12px; color: #5a6270; text-transform: uppercase; letter-spacing: 0.05em; }
    .heading code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: none; letter-spacing: 0; }
    input {
      font: 16px/1.4 system-ui, sans-serif; padding: 12px 14px; border: 0; outline: none; width: 100%; box-sizing: border-box; background: transparent; color: inherit;
    }
    .bar { height: 2px; background: #e8eaef; position: relative; overflow: hidden; }
    .bar.loading::after { content: ""; position: absolute; inset: 0; width: 40%; background: #1565c0; animation: slide 900ms linear infinite; }
    @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
    @media (prefers-reduced-motion: reduce) { .bar.loading::after { animation: none; width: 100%; opacity: 0.6; } }
    .error { padding: 6px 14px; color: #c62828; background: #fff5f5; border-bottom: 1px solid #ef9a9a; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
    .list { list-style: none; margin: 0; padding: 4px 0; max-height: min(52vh, 420px); overflow: auto; }
    .option { display: flex; align-items: baseline; gap: 10px; padding: 6px 14px; cursor: pointer; }
    .option[aria-selected="true"] { background: #e8f0fe; }
    .option .glyph { width: 1.2em; text-align: center; color: #5a6270; flex: none; }
    .option .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .option .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .option .path, .option .hint { font-size: 11.5px; color: #8a94a6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .option .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .option .shortcut { font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #5a6270; border: 1px solid #e0e3e9; border-radius: 4px; padding: 0 6px; flex: none; }
    .option.create .title { color: #1565c0; }
    .option.create .title code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .empty { padding: 10px 14px; color: #8a94a6; font-size: 12.5px; }
    .foot { display: flex; gap: 14px; padding: 6px 14px; border-top: 1px solid #eef0f4; font-size: 11.5px; color: #8a94a6; }
    .foot kbd { font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #5a6270; }
  `;

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) text = "";
  @property({ attribute: false }) items: PaletteItem[] = [];
  @property({ type: Boolean }) loading = false;
  @property({ type: String }) error: string | null = null;
  @property({ type: String }) placeholder = "find a document — > for actions, + to create";
  @property({ type: String }) mode: PaletteMode = "navigate";
  /** Shown above the input (pick mode: what the pick is for). `title` is the native tooltip attribute, hence the name. */
  @property({ type: String }) heading: string | null = null;

  @state() private active = 0;
  @query("input") private inputEl!: HTMLInputElement | null;

  private debounce: ReturnType<typeof setTimeout> | null = null;
  private previouslyFocused: Element | null = null;

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.cancelDebounce();
  }

  /** The cursor is settled before the render: top on open, in range for a new list. */
  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("open") && this.open) this.active = 0;
    if (changed.has("items")) this.active = this.items.length === 0 ? -1 : Math.min(Math.max(this.active, 0), this.items.length - 1);
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has("open")) {
      if (this.open) {
        this.previouslyFocused = document.activeElement;
        this.inputEl?.focus();
        this.inputEl?.select();
        this.cancelDebounce();
        this.emit<PaletteSearchDetail>("palette-search", { text: this.text });
      } else if (changed.get("open") === true) {
        this.cancelDebounce();
        const prev = this.previouslyFocused;
        this.previouslyFocused = null;
        if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
      }
    }
    if (changed.has("active") || changed.has("items")) {
      this.renderRoot.querySelector(`#${this.optionId(this.active)}`)?.scrollIntoView({ block: "nearest" });
    }
  }

  private optionId(i: number): string {
    return `palette-option-${i}`;
  }

  private cancelDebounce(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
  }

  /** Emit `palette-search` for the current text: at once for an empty input (the listing is cheap and the reset should feel instant), else after the debounce. */
  private scheduleSearch(): void {
    this.cancelDebounce();
    if (this.text.trim().length === 0) {
      this.emit<PaletteSearchDetail>("palette-search", { text: this.text });
      return;
    }
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.emit<PaletteSearchDetail>("palette-search", { text: this.text });
    }, SEARCH_DEBOUNCE_MS);
  }

  private onInput(e: Event): void {
    this.text = (e.target as HTMLInputElement).value;
    this.active = 0;
    this.scheduleSearch();
  }

  private onKeydown(e: KeyboardEvent): void {
    if (isStepKey(e.key)) {
      e.preventDefault();
      this.active = stepIndex(this.active, this.items.length, e.key);
      return;
    }
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        this.select(this.items[this.active]);
        return;
      case "Escape":
        e.preventDefault();
        this.close();
        return;
      case "Tab": {
        const item = this.items[this.active];
        if (!e.shiftKey && item?.kind === "doc") {
          e.preventDefault();
          this.text = item.path;
          this.scheduleSearch();
        }
        return;
      }
      default:
        return;
    }
  }

  private close(): void {
    this.cancelDebounce();
    this.emit("palette-close", {});
  }

  private select(item: PaletteItem | undefined): void {
    if (!item) return;
    this.cancelDebounce();
    if (this.mode === "pick") {
      this.emit<PalettePickDetail>("palette-pick", { item });
      return;
    }
    switch (item.kind) {
      case "doc": this.emit<PaletteOpenDocDetail>("palette-open-doc", { path: item.path }); return;
      case "action": this.emit<PaletteActionDetail>("palette-action", { id: item.id }); return;
      case "create": this.emit<PaletteCreateDetail>("palette-create", { path: item.path }); return;
    }
  }

  private renderItem(item: PaletteItem, i: number) {
    const selected = i === this.active;
    const common = { role: "option", id: this.optionId(i) };
    const onEnter = () => { if (this.active !== i) this.active = i; };
    const onClick = (e: Event) => { e.preventDefault(); this.select(item); };
    switch (item.kind) {
      case "doc":
        return html`<li class="option doc" role=${common.role} id=${common.id} aria-selected=${selected ? "true" : "false"} @mousemove=${onEnter} @click=${onClick}>
          <span class="glyph" aria-hidden="true">▤</span>
          <span class="main"><span class="title">${item.title}</span><span class="path">${item.path}</span></span>
        </li>`;
      case "action":
        return html`<li class="option action" role=${common.role} id=${common.id} aria-selected=${selected ? "true" : "false"} @mousemove=${onEnter} @click=${onClick}>
          <span class="glyph" aria-hidden="true">›</span>
          <span class="main"><span class="title">${item.label}</span>${item.hint ? html`<span class="hint">${item.hint}</span>` : nothing}</span>
          ${item.shortcut ? html`<span class="shortcut">${item.shortcut}</span>` : nothing}
        </li>`;
      case "create":
        return html`<li class="option create" role=${common.role} id=${common.id} aria-selected=${selected ? "true" : "false"} @mousemove=${onEnter} @click=${onClick}>
          <span class="glyph" aria-hidden="true">＋</span>
          <span class="main"><span class="title">create <code>${item.path}</code></span><span class="hint">a new document with a title heading</span></span>
        </li>`;
    }
  }

  override render() {
    if (!this.open) return nothing;
    const pick = this.mode === "pick";
    const activeId = this.active >= 0 && this.active < this.items.length ? this.optionId(this.active) : nothing;
    return html`
      <div class="backdrop" @click=${this.close}></div>
      <div class="panel" role="dialog" aria-modal="true" aria-label=${this.heading ?? (pick ? "pick a document" : "command palette")}>
        ${this.heading ? html`<div class="heading">${this.heading}</div>` : nothing}
        <input type="text" role="combobox" autocomplete="off" spellcheck="false"
          aria-expanded=${this.items.length > 0 ? "true" : "false"} aria-controls="palette-list" aria-activedescendant=${activeId} aria-autocomplete="list"
          .value=${this.text} placeholder=${this.placeholder}
          @input=${this.onInput} @keydown=${this.onKeydown}>
        <div class="bar ${this.loading ? "loading" : ""}" aria-hidden="true"></div>
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
        <ul class="list" id="palette-list" role="listbox" aria-label=${pick ? "destinations" : "results"}>
          ${this.items.length === 0 && !this.loading ? html`<li class="empty" aria-disabled="true">${this.text.trim().startsWith(">") ? "no actions match" : "no documents match"}</li>` : nothing}
          ${this.items.map((item, i) => this.renderItem(item, i))}
        </ul>
        <div class="foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> ${pick ? "pick" : "open"}</span>
          <span><kbd>⇥</kbd> complete path</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "command-palette": CommandPalette }
}
