// <oqx-framed-filter>: the recent query as ONE CodeMirror 6 editor with OQX
// highlighting from @omgbase/oqx-syntax, in which only the hole — the `where`
// predicate — can be edited. Idle with no filter it is the plain two-line query,
//
//   select path, title, updated_at from docs
//   order by updated_at desc limit 25
//
// — focusing it (a click anywhere) opens the `where ` line with the caret in
// the empty hole right after the keyword,
//
//   select path, title, updated_at from docs
//   where ⟨hole⟩
//   order by updated_at desc limit 25
//
// and the line stays while there is a filter, or while the field is focused
// with an empty hole (the caret needs somewhere to be); blurring with an empty
// hole — leaving after a clear — removes it again. The frame (lib/feed.ts
// `frameFor`) is read-only and dimmed, the hole has a faint background, and an
// empty hole shows an example as a placeholder. Token for token the text is
// `recentQuery(value)` in every state (the server gets the one-line form).
//
// Read-only is a transaction filter (lib/hole.ts): a transaction whose changes
// touch text outside the hole, or would insert a line break (the where line is
// the user's one line; Enter applies, Escape leaves), is dropped; the hole is a
// StateField range that grows and shrinks with the edits inside it. A selection
// that lands in the frame is moved to the nearest end of the hole, so typing
// always goes where it can. The frame's two modes are swapped by one
// whole-document transaction carrying the `reframe` effect (`reframeSpec`),
// from the focus/blur handlers and when a new value arrives from outside.
//
//   properties: value (the hole's text), invalid (boolean; the frame turns red),
//               placeholder (the example shown in an empty hole)
//   events:     filter-input   detail: { value }   on every edit of the hole
//               filter-change  detail: { value }   on Enter, blur and clear
//   (the CodeMirror + oqx-syntax setup follows graph-ui's oqx-query-editor)

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { oqxStreamParser } from "@omgbase/oqx-syntax/codemirror";
import { frameFor } from "../lib/feed.ts";
import { holeField, holeState, holeText, reframeSpec, type Hole } from "../lib/hole.ts";

export interface FilterDetail { value: string }

const oqxLanguage = StreamLanguage.define(oqxStreamParser(tags));

class PlaceholderWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  override eq(other: PlaceholderWidget): boolean { return other.text === this.text; }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "oqx-placeholder";
    span.textContent = this.text;
    return span;
  }
  override ignoreEvent(): boolean { return false; }
}

const frameMark = Decoration.mark({ class: "oqx-frame" });
const holeMark = Decoration.mark({ class: "oqx-hole" });

@customElement("oqx-framed-filter")
export class OqxFramedFilter extends LitElement {
  static override styles = css`
    :host { display: flex; align-items: stretch; border: 1px solid #c9cdd6; border-radius: 6px; background: #fff; overflow: hidden; cursor: text; }
    :host([invalid]) { border-color: #b3261e; }
    :host(:focus-within) { border-color: #1565c0; box-shadow: 0 0 0 2px rgba(21, 101, 192, 0.15); }
    .editor { flex: 1 1 auto; min-width: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .cm-editor { outline: none; }
    .cm-editor .cm-content { padding: 5px 0; }
    .cm-editor .cm-line { padding: 0 8px; }
    .cm-editor .cm-scroller { font-family: inherit; }
    .oqx-frame { opacity: 0.5; }
    .oqx-hole { background: rgba(21, 101, 192, 0.08); border-radius: 3px; padding: 1px 0; }
    .oqx-placeholder { color: #a9b0bd; font-style: italic; pointer-events: none; }
    .clear { flex: 0 0 auto; border: 0; border-left: 1px solid #e3e6ec; background: #fafbfc; color: #5a6270; font: 15px/1 system-ui, sans-serif; padding: 0 10px; cursor: pointer; }
    .clear:hover { background: #f0f2f6; color: #222; }
  `;

  /** The hole's text (the OQX predicate). */
  @property() value = "";
  @property({ type: Boolean, reflect: true }) invalid = false;
  @property() placeholder = "";

  /** Whether the hole is empty (drives the clear button; set from `value` before a render and from the editor's edits). */
  @state() private empty = true;

  private view: EditorView | null = null;
  private lastEmitted: string | null = null;

  /** The editor (for tests driving the page). */
  get editor(): EditorView | null { return this.view; }

  /** The hole's current range in the editor's document (UTF-16 offsets). */
  get hole(): Hole { const h = this.view?.state.field(holeField) ?? frameFor(this.value).hole; return { from: h.from, to: h.to }; }

  /** Whether the `where` line is shown. */
  get where(): boolean { return this.view?.state.field(holeField).where ?? frameFor(this.value).where; }

  /** What the field shows: the whole framed query. */
  get text(): string { return this.view?.state.doc.toString() ?? frameFor(this.value).text; }

  private decorations(state: EditorState): DecorationSet {
    const hole = state.field(holeField);
    const ranges: Range<Decoration>[] = [];
    if (!hole.where) return Decoration.set([frameMark.range(0, state.doc.length)]);
    if (hole.from > 0) ranges.push(frameMark.range(0, hole.from));
    if (hole.to > hole.from) ranges.push(holeMark.range(hole.from, hole.to));
    else if (this.placeholder) ranges.push(Decoration.widget({ widget: new PlaceholderWidget(this.placeholder), side: 1 }).range(hole.from));
    if (hole.to < state.doc.length) ranges.push(frameMark.range(hole.to, state.doc.length));
    return Decoration.set(ranges, true);
  }

  /** Focus opens the `where` line (an empty idle frame has none); the caret lands in the hole. */
  private onFocus(view: EditorView): void {
    if (!view.state.field(holeField).where) view.dispatch(reframeSpec(view.state, "", true));
  }

  /** Blur applies; an empty hole closes the `where` line. */
  private onBlur(view: EditorView): void {
    if (view.state.field(holeField).where && holeText(view.state) === "") view.dispatch(reframeSpec(view.state, "", false));
    this.emit("filter-change");
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    // Before the render, not after it (setting @state in firstUpdated/updated schedules a second update; Lit warns).
    if (changed.has("value")) this.empty = this.value === "";
  }

  protected override firstUpdated(): void {
    const parent = this.renderRoot.querySelector(".editor") as HTMLElement;
    this.lastEmitted = this.value;
    this.view = new EditorView({
      // CodeMirror mounts its style sheets in the root it is told about; inside a shadow root that must be explicit.
      root: this.renderRoot as ShadowRoot,
      parent,
      state: holeState(this.value, { editing: false }, [
          history(),
          keymap.of([
            { key: "Enter", run: () => { this.emit("filter-change"); return true; } },
            { key: "Escape", run: (view) => { view.contentDOM.blur(); return true; } },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          oqxLanguage,
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          EditorView.decorations.compute([holeField], (state) => this.decorations(state)),
          EditorView.domEventHandlers({
            focus: (_e, view) => { this.onFocus(view); },
            blur: (_e, view) => { this.onBlur(view); },
          }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            this.empty = this.holeText() === "";
            // The hole emptied while nobody is typing in it (a value from outside): the where line goes too (not during this update).
            if (this.empty && !u.view.hasFocus && u.state.field(holeField).where) queueMicrotask(() => { const v = this.view; if (v && !v.hasFocus && v.state.field(holeField).where && holeText(v.state) === "") v.dispatch(reframeSpec(v.state, "", false)); });
            this.emit("filter-input");
          }),
      ]),
    });
  }

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (!this.view) return;
    // The page keeps the trimmed value; a trailing space mid-typing is not a reason to rewrite the field.
    else if (changed.has("value") && this.value !== this.holeText().trim()) this.setHole(this.value);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.view?.destroy();
    this.view = null;
  }

  private holeText(): string {
    return this.view ? holeText(this.view.state) : this.value;
  }

  /** Replace the whole document with the frame around `value` (bypasses the hole filter); the where line stays open while focused. */
  private setHole(value: string): void {
    if (!this.view) return;
    this.view.dispatch(reframeSpec(this.view.state, value, this.view.hasFocus));
  }

  private emit(name: "filter-input" | "filter-change"): void {
    const value = this.holeText();
    if (name === "filter-change" && this.lastEmitted === value) return;
    if (name === "filter-change") this.lastEmitted = value;
    this.dispatchEvent(new CustomEvent<FilterDetail>(name, { detail: { value }, bubbles: true, composed: true }));
  }

  /** Clear the hole and return to it (the where line stays open until the user leaves). */
  private clear(): void {
    if (!this.view) return;
    this.view.focus();
    this.view.dispatch(reframeSpec(this.view.state, "", true));
    this.empty = true;
    this.emit("filter-change");
  }

  protected override render() {
    return html`
      <div class="editor"></div>
      ${this.empty ? nothing : html`<button class="clear" type="button" title="clear the filter" aria-label="clear the filter" @click=${() => this.clear()}>×</button>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "oqx-framed-filter": OqxFramedFilter }
}
