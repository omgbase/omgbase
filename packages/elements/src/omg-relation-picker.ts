// <omg-relation-picker>: the connector's one question — WHICH relation is
// `from → to`? — as a small popover listbox over the relation kinds the host
// found in the rendered graph (`relationKinds` in @omgbase/client: the
// frontmatter fields the edges on screen already use, the source's own list
// fields, the body link), plus an optional last row that names a new field.
// No radios, no modes, no replace: picking a row is the whole gesture; the host
// runs the additive attach command and closes the picker.
//
// The element is client- and engine-free: `kinds` is a structural list the host
// maps from its own model (`RelationKindItem`), and the pick leaves as ONE event.
//
// Properties: `open`, `kinds: RelationKindItem[]`, `from`, `to` (shown as
// "connect <from> → <to>"), `allowNew` (a last row "new field…" with an inline
// text input), `anchor?: { x, y }` (viewport px — the popover sits near it, else
// centred). Events: `relation-pick { item }` (for the new-field row an item
// `{ kind: "frontmatter", field: <typed>, label }`), `relation-cancel`. The
// element never closes itself: the host sets `open` false.
// Keys: ↑/↓/Home/End move (wrapping), Enter picks, Esc cancels, a letter jumps
// to the next row whose label starts with it; focus moves into the list when
// opened and back to where it was on close. ARIA: a dialog holding a listbox.

import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";

/** One row: a frontmatter field (with how many rendered edges use it) or the body link. Structural — the host maps its own kinds. */
export interface RelationKindItem {
  kind: "frontmatter" | "body-link";
  /** The field name (`frontmatter`). */
  field?: string;
  /** The row's text. */
  label: string;
  /** How many rendered edges carry this kind (shown dimmed), when known. */
  count?: number;
}

export interface RelationPickDetail { item: RelationKindItem }

/** The index of the "new field…" row: after every kind. */
const NEW_ROW = -2;

@customElement("omg-relation-picker")
export class OmgRelationPicker extends LitElement {
  static override styles = css`
    :host { display: contents; font: 13px/1.5 var(--omg-palette-font, system-ui, sans-serif); color: #1e2430; }
    .backdrop { position: fixed; inset: 0; background: transparent; z-index: 1000; }
    .panel {
      position: fixed; z-index: 1001; width: min(360px, 92vw); box-sizing: border-box;
      background: #fff; border: 1px solid #c9cdd6; border-radius: 8px; box-shadow: 0 12px 36px rgba(20, 24, 32, 0.22);
      display: flex; flex-direction: column; overflow: hidden; outline: none;
      animation: rise 100ms ease-out;
    }
    .panel.centred { top: 50%; left: 50%; transform: translate(-50%, -50%); }
    @keyframes rise { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
    .heading { padding: 8px 12px 4px; font-size: 12px; color: #5a6270; display: flex; flex-direction: column; gap: 1px; }
    .heading .what { text-transform: uppercase; letter-spacing: 0.05em; }
    .heading code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #1e2430; }
    .list { list-style: none; margin: 0; padding: 4px 0; max-height: min(48vh, 360px); overflow: auto; outline: none; }
    .option { display: flex; align-items: center; gap: 10px; padding: 5px 12px; cursor: pointer; }
    .option[aria-selected="true"] { background: #e8f0fe; }
    .option .glyph { width: 1.2em; text-align: center; color: #5a6270; flex: none; font-size: 12px; }
    .option .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .option .label code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .option .count { font-size: 11.5px; color: #8a94a6; flex: none; }
    .option.new .label { color: #1565c0; }
    .option input { font: inherit; font-size: 12.5px; padding: 1px 6px; border: 1px solid #c9cdd6; border-radius: 4px; width: 11em; }
    .foot { display: flex; gap: 12px; padding: 5px 12px; border-top: 1px solid #eef0f4; font-size: 11px; color: #8a94a6; }
    .foot kbd { font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #5a6270; }
  `;

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ attribute: false }) kinds: RelationKindItem[] = [];
  @property({ type: String }) from = "";
  @property({ type: String }) to = "";
  @property({ type: Boolean }) allowNew = false;
  /** Viewport px; the popover's top-left sits just below and to the right, kept on screen. */
  @property({ attribute: false }) anchor: { x: number; y: number } | null = null;

  /** The active row: an index into `kinds`, or `NEW_ROW` for the new-field row. */
  @state() private active = 0;
  @state() private newField = "";
  @query(".list") private listEl!: HTMLElement | null;
  @query("input") private inputEl!: HTMLInputElement | null;

  private previouslyFocused: Element | null = null;

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("open") && this.open) { this.active = this.kinds.length > 0 ? 0 : this.allowNew ? NEW_ROW : -1; this.newField = ""; }
    if (changed.has("kinds") && this.active >= this.kinds.length) this.active = this.kinds.length > 0 ? this.kinds.length - 1 : this.allowNew ? NEW_ROW : -1;
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has("open")) {
      if (this.open) {
        this.previouslyFocused = document.activeElement;
        this.listEl?.focus();
      } else if (changed.get("open") === true) {
        const prev = this.previouslyFocused;
        this.previouslyFocused = null;
        if (prev instanceof HTMLElement && prev.isConnected) prev.focus();
      }
    }
    if (changed.has("active")) {
      if (this.active === NEW_ROW) this.inputEl?.focus();
      else {
        if (document.activeElement !== this && this.inputEl && this.renderRoot.contains(document.activeElement as Node | null)) this.listEl?.focus();
        this.renderRoot.querySelector(`#${this.optionId(this.active)}`)?.scrollIntoView({ block: "nearest" });
      }
    }
  }

  private optionId(i: number): string {
    return i === NEW_ROW ? "relation-option-new" : `relation-option-${i}`;
  }

  /** The row order: the kinds, then the new-field row. */
  private rows(): number[] {
    const out = this.kinds.map((_, i) => i);
    if (this.allowNew) out.push(NEW_ROW);
    return out;
  }

  private step(key: string): void {
    const rows = this.rows();
    if (rows.length === 0) return;
    const at = rows.indexOf(this.active);
    const last = rows.length - 1;
    switch (key) {
      case "ArrowDown": this.active = rows[at < 0 || at >= last ? 0 : at + 1]!; return;
      case "ArrowUp": this.active = rows[at <= 0 ? last : at - 1]!; return;
      case "Home": this.active = rows[0]!; return;
      case "End": this.active = rows[last]!; return;
    }
  }

  /** A letter jumps to the next row (after the active one, wrapping) whose label starts with it. */
  private jump(letter: string): void {
    const rows = this.rows();
    const at = rows.indexOf(this.active);
    const l = letter.toLowerCase();
    for (let k = 1; k <= rows.length; k++) {
      const i = rows[(at + k) % rows.length]!;
      const label = i === NEW_ROW ? "new field" : (this.kinds[i]?.field ?? this.kinds[i]?.label ?? "");
      if (label.toLowerCase().startsWith(l)) { this.active = i; return; }
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    const inInput = e.target === this.inputEl;
    switch (e.key) {
      case "ArrowDown": case "ArrowUp": case "Home": case "End":
        if (inInput && (e.key === "Home" || e.key === "End")) return;
        e.preventDefault();
        this.step(e.key);
        return;
      case "Enter":
        e.preventDefault();
        this.pick(this.active);
        return;
      case "Escape":
        e.preventDefault();
        this.cancel();
        return;
      case "Tab":
        return;
      default:
        if (!inInput && e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); this.jump(e.key); }
    }
  }

  private cancel(): void {
    this.emit("relation-cancel", {});
  }

  private pick(i: number): void {
    if (i === NEW_ROW) {
      const field = this.newField.trim();
      if (field === "") { this.inputEl?.focus(); return; }
      this.emit<RelationPickDetail>("relation-pick", { item: { kind: "frontmatter", field, label: `add to \`${field}\`` } });
      return;
    }
    const item = this.kinds[i];
    if (item) this.emit<RelationPickDetail>("relation-pick", { item });
  }

  private panelStyle(): string {
    const a = this.anchor;
    if (!a) return "";
    const w = 360, h = Math.min(420, 56 + 32 * (this.kinds.length + (this.allowNew ? 1 : 0)) + 28);
    const vw = typeof window === "undefined" ? 1200 : window.innerWidth, vh = typeof window === "undefined" ? 800 : window.innerHeight;
    const left = Math.max(8, Math.min(a.x + 8, vw - w - 8));
    const top = Math.max(8, Math.min(a.y + 8, vh - h - 8));
    return `left: ${left}px; top: ${top}px;`;
  }

  override render() {
    if (!this.open) return nothing;
    const activeId = this.active === NEW_ROW || (this.active >= 0 && this.active < this.kinds.length) ? this.optionId(this.active) : nothing;
    const onEnter = (i: number) => () => { if (this.active !== i) this.active = i; };
    const onClick = (i: number) => (e: Event) => { e.preventDefault(); this.pick(i); };
    return html`
      <div class="backdrop" @click=${this.cancel}></div>
      <div class="panel ${this.anchor ? "" : "centred"}" role="dialog" aria-modal="true" aria-label="which relation" style=${this.panelStyle()} @keydown=${this.onKeydown}>
        <div class="heading">
          <span class="what">connect</span>
          <span><code>${this.from}</code> → <code>${this.to}</code></span>
        </div>
        <ul class="list" role="listbox" aria-label="relation kinds" tabindex="0" aria-activedescendant=${activeId}>
          ${this.kinds.length === 0 && !this.allowNew ? html`<li class="option" aria-disabled="true">no relation kinds</li>` : nothing}
          ${this.kinds.map((item, i) => html`<li class="option ${item.kind}" role="option" id=${this.optionId(i)} aria-selected=${i === this.active ? "true" : "false"} @mousemove=${onEnter(i)} @click=${onClick(i)}>
            <span class="glyph" aria-hidden="true">${item.kind === "body-link" ? "¶" : "⋮"}</span>
            <span class="label">${item.kind === "frontmatter" && item.field ? html`<code>${item.field}</code>` : item.label}</span>
            ${item.count !== undefined ? html`<span class="count" title="${item.count} edge${item.count === 1 ? "" : "s"} in the rendered graph">×${item.count}</span>` : nothing}
          </li>`)}
          ${this.allowNew ? html`<li class="option new" role="option" id=${this.optionId(NEW_ROW)} aria-selected=${this.active === NEW_ROW ? "true" : "false"} @mousemove=${onEnter(NEW_ROW)} @click=${(e: Event) => { if ((e.target as HTMLElement).tagName !== "INPUT") { this.active = NEW_ROW; this.inputEl?.focus(); } }}>
            <span class="glyph" aria-hidden="true">＋</span>
            <span class="label">new field…</span>
            <input type="text" placeholder="field name" spellcheck="false" autocomplete="off" aria-label="new field name" .value=${this.newField}
              @focus=${() => { this.active = NEW_ROW; }} @input=${(e: Event) => { this.newField = (e.target as HTMLInputElement).value; }} @click=${(e: Event) => e.stopPropagation()}>
          </li>` : nothing}
        </ul>
        <div class="foot"><span><kbd>↑↓</kbd> choose</span><span><kbd>↵</kbd> connect</span><span><kbd>esc</kbd> cancel</span></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "omg-relation-picker": OmgRelationPicker }
}
