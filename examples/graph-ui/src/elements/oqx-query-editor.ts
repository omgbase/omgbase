// <oqx-query-editor>: a CodeMirror 6 editor with OQX highlighting from
// @omgbase/oqx-syntax. Parses on every edit (debounced) with the public `parse`,
// shows the error inline at the reported offset, and emits `query-change`.
//
//   properties: value (string, the source), highlights (Span[], code-point
//               ranges to underline — the picker's hovered candidate),
//               serverSurface (the connected server's surface version,
//               "major.minor" | "1.x" | null — drives the path-form hints),
//               debounce (ms)
//   events:     query-change  detail: { source, query: Query | null, error: OqxErrorInfo | null }

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { oqxStreamParser } from "@omgbase/oqx-syntax/codemirror";
import { parse, type Query, type Span } from "@omgbase/oqx";
import { codePointToUtf16, describeOqxError, type OqxErrorInfo } from "../lib/errors.ts";
import { messageRuns, queryHints, type Hint } from "../lib/hints.ts";

export interface QueryChangeDetail {
  source: string;
  query: Query | null;
  error: OqxErrorInfo | null;
}

const oqxLanguage = StreamLanguage.define(oqxStreamParser(tags));

// One decoration set for both the parse error and the hovered candidate's
// spans, replaced wholesale by an effect (simpler than two fields).
const setMarks = StateEffect.define<DecorationSet>();
const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) next = e.value;
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const errorMark = Decoration.mark({ class: "oqx-error" });
const candidateMark = Decoration.mark({ class: "oqx-candidate" });
const hintMark = Decoration.mark({ class: "oqx-hint" });

@customElement("oqx-query-editor")
export class OqxQueryEditor extends LitElement {
  static override styles = css`
    :host { display: block; border: 1px solid var(--line, #d0d4dc); border-radius: 6px; background: var(--editor-bg, #fff); overflow: hidden; }
    .editor { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .cm-editor { outline: none; }
    .cm-editor .cm-content { padding: 8px 0; }
    .cm-editor .cm-scroller { font-family: inherit; }
    .oqx-error { text-decoration: underline wavy #c62828; text-decoration-skip-ink: none; background: rgba(198, 40, 40, 0.08); }
    .oqx-candidate { background: rgba(255, 193, 7, 0.35); border-radius: 2px; }
    .oqx-hint { text-decoration: underline dotted #b26a00; text-decoration-skip-ink: none; }
    .status { display: flex; gap: 8px; align-items: baseline; min-height: 20px; padding: 4px 10px; border-top: 1px solid var(--line, #e3e6ec); font: 12px/1.4 system-ui, sans-serif; color: #5a6270; background: #f7f8fa; }
    .status.error { color: #c62828; background: #fff5f5; }
    .status .where { font-family: ui-monospace, monospace; opacity: 0.8; }
    .hints { display: flex; flex-direction: column; gap: 2px; padding: 4px 10px 6px; border-top: 1px solid var(--line, #e3e6ec); font: 12px/1.4 system-ui, sans-serif; color: #6d4c00; background: #fff8e1; }
    .hints code { font-family: ui-monospace, monospace; }
  `;

  @property() value = "";
  @property({ attribute: false }) highlights: Span[] = [];
  @property({ type: Number }) debounce = 150;
  /** The connected server's surface version (lib/paths.ts); null while unknown. */
  @property({ attribute: false }) serverSurface: string | null = null;

  @state() private error: OqxErrorInfo | null = null;
  @state() private hints: Hint[] = [];

  private view: EditorView | null = null;
  /** The last successful parse, re-read when `serverSurface` changes. */
  private lastQuery: Query | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitted: string | null = null;

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    // The first parse happens here, before the first render, so the status line
    // renders right the first time — setting @state in firstUpdated() would
    // schedule a second update and Lit (dev mode) warns about it.
    if (changed.has("value") && !this.view) {
      const parsed = this.parseSource(this.value);
      this.error = parsed.error;
      this.lastQuery = parsed.query;
      this.hints = queryHints(parsed.query, this.serverSurface);
    } else if (changed.has("serverSurface") && this.view) {
      // The server changed under the same text: the path-form hints follow it.
      this.hints = queryHints(this.lastQuery, this.serverSurface);
    }
  }

  protected override firstUpdated(): void {
    const parent = this.renderRoot.querySelector(".editor") as HTMLElement;
    this.view = new EditorView({
      // CodeMirror mounts its style sheets in the root it is told about; inside
      // a shadow root that must be said explicitly or the styles land in the
      // document and never reach the editor.
      root: this.renderRoot as ShadowRoot,
      parent,
      state: EditorState.create({
        doc: this.value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          oqxLanguage,
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          marks,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) this.scheduleParse();
          }),
        ],
      }),
    });
    this.parseNow();
  }

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (!this.view) return;
    if (changed.has("value") && this.value !== this.view.state.doc.toString()) {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: this.value } });
    }
    if (changed.has("highlights") || changed.has("serverSurface")) this.applyMarks();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.view?.destroy();
    this.view = null;
  }

  /** The current source (the editor's document). */
  get source(): string {
    return this.view?.state.doc.toString() ?? this.value;
  }

  private scheduleParse(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.parseNow(), this.debounce);
  }

  private parseSource(source: string): { query: Query | null; error: OqxErrorInfo | null } {
    try {
      return { query: parse(source), error: null };
    } catch (e) {
      return { query: null, error: describeOqxError(e) };
    }
  }

  private parseNow(): void {
    this.timer = null;
    const source = this.source;
    const { query, error } = this.parseSource(source);
    if (this.error?.message !== error?.message || this.error?.offset !== error?.offset) this.error = error;
    this.lastQuery = query;
    const hints = queryHints(query, this.serverSurface);
    if (hints.map((h) => h.message).join("\n") !== this.hints.map((h) => h.message).join("\n")) this.hints = hints;
    this.applyMarks(hints);
    if (this.lastEmitted === source) return;
    this.lastEmitted = source;
    this.dispatchEvent(new CustomEvent<QueryChangeDetail>("query-change", {
      detail: { source, query, error }, bubbles: true, composed: true,
    }));
  }

  private applyMarks(hints: Hint[] = this.hints): void {
    if (!this.view) return;
    const source = this.view.state.doc.toString();
    const ranges: Range<Decoration>[] = [];
    for (const h of hints) {
      const from = codePointToUtf16(source, h.span[0]);
      const to = codePointToUtf16(source, h.span[1]);
      if (to > from) ranges.push(hintMark.range(from, to));
    }
    for (const [a, b] of this.highlights) {
      const from = codePointToUtf16(source, a);
      const to = codePointToUtf16(source, b);
      if (to > from) ranges.push(candidateMark.range(from, to));
    }
    const offset = this.error?.offset;
    if (offset !== null && offset !== undefined) {
      // Mark the token at the offset, or the last character at end of input.
      const at = codePointToUtf16(source, offset);
      const from = at >= source.length ? Math.max(0, source.length - 1) : at;
      const tokenLength = /^\S+/.exec(source.slice(from))?.[0].length ?? 1;
      const to = Math.min(source.length, from + Math.max(1, tokenLength));
      if (to > from) ranges.push(errorMark.range(from, to));
    }
    ranges.sort((x, y) => x.from - y.from || x.value.startSide - y.value.startSide);
    this.view.dispatch({ effects: setMarks.of(Decoration.set(ranges, true)) });
  }

  protected override render() {
    const e = this.error;
    return html`
      <div class="editor"></div>
      <div class="status ${e ? "error" : ""}">
        ${e
          ? html`<span>${e.stage ?? "error"}: ${e.message}</span>${e.offset !== null ? html`<span class="where">@${e.offset}</span>` : null}`
          : html`<span>OQX ok</span>`}
      </div>
      ${!e && this.hints.length > 0
        ? html`<div class="hints" role="note">${this.hints.map((h) => html`<div class="hint" data-field=${h.field}>hint: ${messageRuns(h.message).map((run, i) => (i % 2 ? html`<code>${run}</code>` : run))}</div>`)}</div>`
        : null}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "oqx-query-editor": OqxQueryEditor }
}
