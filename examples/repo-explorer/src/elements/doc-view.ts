// <doc-view>: one document — its properties as a table (frontmatter, inline
// fields, the computed `_title`), the body rendered as Markdown with every block
// an anchor (lib/markdown.ts) or the raw source, and — when the page allows
// writes — a frontmatter editor whose change is previewed with `plan` and
// committed with `execute` (the page does the calls; this element shows the
// plan's summary and diff and asks for the confirmation).
//
// Task checkboxes (lib/tasks.ts): a rendered task item carries an
// `<input type="checkbox" class="task-check" data-block="b_…">`, enabled only
// when its block pairing verified and the server lists `apply`; a `change` on
// one emits `task-toggle { blockId, checked, contentHash }` with the block's
// hash from the read (the CAS), and the page applies it. While the toggle is in
// flight (`taskPending`) the box keeps the state the user gave it, disabled;
// when the page clears `taskPending` without a new rendering (the write failed)
// the box falls back to the rendering's state. Undo / redo of the last toggles
// are buttons by the title and ⌘Z / ⇧⌘Z (Ctrl on other platforms) while this
// element has focus and the key did not land in a text field.
//
// Properties: `doc` (lib/document.ts DocRead), `rendered` (the body's HTML and
// anchor verdicts), `view` ("rendered" | "raw"), `canWrite`, `pending` (the
// plan awaiting confirmation, with its diff), `writeMessage`, `highlight` (a
// block id to scroll to), `taskPending` (the toggle in flight), `undoLabel` /
// `redoLabel` (what the compensation would do; null = nothing to undo/redo).
// Events: `open-doc { path }` (a link to another document), `open-wiki { name }`,
// `view-change { view }`, `write-plan { key, value, unset }`, `write-execute`,
// `write-cancel`, `task-toggle { blockId, checked, contentHash }`, `task-undo`,
// `task-redo`.

import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { propertyRows, type DocRead } from "../lib/document.ts";
import { anchorsSummary, type Rendered } from "../lib/markdown.ts";
import { diffLineKind, unifiedDiff } from "../lib/diff.ts";
import type { Plan } from "../lib/writes.ts";

export type DocViewMode = "rendered" | "raw";
export interface OpenDocDetail { path: string }
export interface OpenWikiDetail { name: string }
export interface ViewChangeDetail { view: DocViewMode }
export interface WritePlanDetail { key: string; value: string; unset: boolean }
export interface TaskToggleDetail { blockId: string; checked: boolean; contentHash: string }
export interface TaskPending { blockId: string; checked: boolean }

/** Is the key's target a control that owns ⌘Z itself (text entry)? A checkbox or a button is not. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "reset"].includes(target.type);
  return false;
}

/** ⌘Z / Ctrl+Z → "undo", with Shift → "redo"; anything else null. */
export function undoKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): "undo" | "redo" | null {
  if (e.altKey || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return null;
  return e.shiftKey ? "redo" : "undo";
}

/** A property table with more rows than this starts collapsed. */
const PROPS_OPEN_MAX = 8;

@customElement("doc-view")
export class DocView extends LitElement {
  static override styles = css`
    :host { display: block; font: 14px/1.55 system-ui, sans-serif; color: #1e2430; }
    .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; margin-bottom: 8px; }
    .head h2 { margin: 0; font-size: 18px; }
    .head .path { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #5a6270; }
    .head .meta { font-size: 12px; color: #8a94a6; }
    .head .spacer { flex: 1; }
    :host(:focus) { outline: none; }
    :host(:focus-visible) .body { box-shadow: 0 0 0 2px #c5d8f5; border-radius: 4px; }
    .undo { display: inline-flex; gap: 4px; }
    .undo button { font: inherit; font-size: 12px; padding: 1px 8px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; cursor: pointer; color: #1e2430; }
    .undo button:disabled { color: #a0a8b6; cursor: default; }
    .toggle { display: inline-flex; border: 1px solid #c9cdd6; border-radius: 4px; overflow: hidden; font-size: 12px; }
    .toggle button { font: inherit; border: 0; background: #fff; padding: 2px 8px; cursor: pointer; color: #5a6270; }
    .toggle button.on { background: #e3edfb; color: #0d47a1; }
    details.props-wrap { margin: 0 0 12px; }
    details.props-wrap > summary { cursor: pointer; font-size: 12px; color: #5a6270; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; user-select: none; list-style: none; display: inline-flex; align-items: center; gap: 6px; }
    details.props-wrap > summary::-webkit-details-marker { display: none; }
    details.props-wrap > summary::before { content: "▸"; font-size: 11px; color: #8a94a6; }
    details.props-wrap[open] > summary::before { content: "▾"; }
    details.props-wrap > summary .count { font-weight: 400; text-transform: none; letter-spacing: 0; color: #8a94a6; }
    table.props { border-collapse: collapse; font-size: 12.5px; margin: 6px 0 0; }
    table.props th, table.props td { text-align: left; padding: 2px 10px 2px 0; vertical-align: top; border-bottom: 1px solid #eef0f4; }
    table.props th { color: #5a6270; font-weight: 500; white-space: nowrap; }
    table.props .src { color: #8a94a6; font-size: 11px; padding-right: 8px; }
    table.props td.val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-word; }
    table.props button { font-size: 11px; padding: 0 5px; margin-left: 4px; border: 1px solid #c9cdd6; border-radius: 3px; background: #fff; cursor: pointer; }
    .editor { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12.5px; margin: 8px 0 0; padding: 6px 8px; border: 1px dashed #c9cdd6; border-radius: 6px; background: #fafbfc; }
    .editor input { font: inherit; font-size: 12.5px; padding: 2px 6px; border: 1px solid #c9cdd6; border-radius: 4px; }
    .editor input.key { width: 10em; } .editor input.value { flex: 1; min-width: 12em; }
    .editor button, .pending button { font: inherit; font-size: 12.5px; padding: 2px 10px; border: 1px solid #c9cdd6; border-radius: 4px; background: #fff; cursor: pointer; }
    .editor button.primary, .pending button.primary { background: #1565c0; color: #fff; border-color: #1565c0; }
    .editor button.clear { padding: 2px 7px; color: #5a6270; }
    .editor .hint { color: #8a94a6; font-size: 11.5px; flex-basis: 100%; }
    .pending { margin: 0 0 12px; padding: 8px 10px; border: 1px solid #ffe082; background: #fff8e1; border-radius: 6px; font-size: 12.5px; color: #6d4c00; }
    .pending .summary { margin: 0 0 6px; }
    .pending .summary li { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .pending pre { margin: 6px 0; max-height: 30vh; overflow: auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: #fff; border: 1px solid #e8eaef; border-radius: 4px; padding: 6px 8px; }
    pre .add { background: #e6ffed; color: #1a4d1f; display: block; }
    pre .del { background: #ffeef0; color: #7a1c1c; display: block; }
    pre .hunk { color: #6f42c1; display: block; }
    pre .ctx { display: block; }
    .msg { margin: 0 0 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid #e3e6ec; background: #f7f8fa; font-size: 12.5px; }
    .msg.error { border-color: #ef9a9a; background: #fff5f5; color: #c62828; }
    .msg code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .anchors { font-size: 11.5px; color: #8a94a6; margin: 0 0 6px; }
    .anchors .warn { color: #b26a00; }
    pre.raw { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f7f8fa; border: 1px solid #e3e6ec; border-radius: 6px; padding: 10px 12px; }
    /* The rendered body. */
    .body { max-width: 76ch; }
    .body > :first-child { margin-top: 0; }
    .body h1, .body h2, .body h3, .body h4 { margin: 1em 0 0.4em; line-height: 1.25; }
    .body h1 { font-size: 1.6em; } .body h2 { font-size: 1.3em; } .body h3 { font-size: 1.12em; }
    .body p { margin: 0.5em 0; }
    .body ul, .body ol { margin: 0.5em 0; padding-left: 1.6em; }
    .body blockquote { margin: 0.6em 0; padding: 0.1em 0 0.1em 0.8em; border-left: 3px solid #d4d8e0; color: #4a5160; }
    .body pre { margin: 0.6em 0; padding: 6px 8px; border-radius: 4px; background: #f6f7f9; overflow-x: auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .body code { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f0f1f4; padding: 0 3px; border-radius: 3px; }
    .body pre code { background: none; padding: 0; }
    .body table { border-collapse: collapse; margin: 0.6em 0; font-size: 13px; }
    .body th, .body td { border: 1px solid #d4d8e0; padding: 2px 8px; text-align: left; }
    .body th { background: #f0f1f4; }
    .body a { color: #1565c0; }
    .body a.wikilink { color: #6a1b9a; text-decoration: none; border-bottom: 1px dashed #6a1b9a; }
    .body .image { color: #6a7382; font-style: italic; }
    /* Task items: the checkbox stands where the bullet was. */
    .body li.task { list-style: none; margin-left: -1.35em; }
    .body li.task > input.task-check { margin: 0 0.45em 0 0; vertical-align: -1px; cursor: pointer; }
    .body li.task > input.task-check:disabled { cursor: not-allowed; opacity: 0.55; }
    .body li.task.busy { opacity: 0.6; }
    /* Every anchored block shows its id on hover and is a scroll target. */
    .body [data-block] { position: relative; scroll-margin-top: 8px; }
    .body [data-block]:hover::after { content: attr(data-block); position: absolute; right: -2px; top: -1.2em; font: 10.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; background: #5a6270; padding: 0 5px; border-radius: 3px; pointer-events: none; }
    .body [data-verified="false"]:hover::after { background: #b26a00; content: attr(data-block) " (unverified)"; }
    .body [data-block]:hover { box-shadow: -3px 0 0 #c5cbd6; }
    .body [data-block].highlight { background: #fff8e1; box-shadow: -3px 0 0 #ffb300; }
  `;

  @property({ attribute: false }) doc: DocRead | null = null;
  @property({ attribute: false }) rendered: Rendered | null = null;
  @property({ type: String }) view: DocViewMode = "rendered";
  @property({ type: Boolean }) canWrite = false;
  @property({ attribute: false }) pending: Plan | null = null;
  @property({ attribute: false }) writeMessage: { kind: "error" | "info"; text: string; fix?: string | null } | null = null;
  @property({ type: Boolean }) writing = false;
  @property({ type: String }) highlight: string | null = null;
  /** The task toggle in flight (its box stays as the user left it, disabled). */
  @property({ attribute: false }) taskPending: TaskPending | null = null;
  @property({ type: String }) undoLabel: string | null = null;
  @property({ type: String }) redoLabel: string | null = null;

  @state() private editKey = "";
  @state() private editValue = "";
  /** Whether the properties table is expanded; null = not chosen yet (open when the table is short). */
  @state() private propsOpen: boolean | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Focusable, so ⌘Z reaches the document view (a click anywhere in it focuses it).
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    this.addEventListener("keydown", this.onKeydown);
  }

  override disconnectedCallback(): void {
    this.removeEventListener("keydown", this.onKeydown);
    super.disconnectedCallback();
  }

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  /** ⌘Z / ⇧⌘Z (Ctrl elsewhere) while focus is here and not in a text field: undo / redo the last task toggle. */
  private onKeydown = (e: KeyboardEvent): void => {
    const dir = undoKey(e);
    if (!dir || isTextEntry(e.composedPath()[0] ?? e.target)) return;
    if (dir === "undo" && !this.undoLabel) return;
    if (dir === "redo" && !this.redoLabel) return;
    e.preventDefault();
    this.emit(dir === "undo" ? "task-undo" : "task-redo", {});
  };

  /** A `change` inside the rendered body: a task checkbox → the toggle, with the block's hash from the read (the CAS). */
  private onBodyChange(e: Event): void {
    const input = e.composedPath().find((n) => n instanceof HTMLInputElement && n.classList.contains("task-check")) as HTMLInputElement | undefined;
    if (!input) return;
    const blockId = input.getAttribute("data-block");
    const contentHash = blockId ? this.doc?.blockIds?.hashes[blockId] : undefined;
    if (!blockId || contentHash === undefined || this.taskPending) {
      // No anchor or no hash on record (the box should have been disabled), or a toggle is already in flight: refuse, revert.
      input.checked = input.defaultChecked;
      return;
    }
    this.emit<TaskToggleDetail>("task-toggle", { blockId, checked: input.checked, contentHash });
  }

  /** Keep the pending box as the user left it, disabled; when the toggle ends
   * without a new rendering (the write failed) fall back to the rendering's
   * state — `defaultChecked` is the `checked` attribute the markdown gave. */
  private syncPending(): void {
    for (const el of this.renderRoot.querySelectorAll<HTMLInputElement>("input.task-check[data-pending]")) {
      el.removeAttribute("data-pending");
      el.disabled = el.hasAttribute("title");
      el.checked = el.defaultChecked;
      el.closest("li")?.classList.remove("busy");
    }
    const p = this.taskPending;
    if (!p) return;
    const el = this.renderRoot.querySelector<HTMLInputElement>(`input.task-check[data-block="${p.blockId}"]`);
    if (!el) return;
    el.setAttribute("data-pending", "");
    el.checked = p.checked;
    el.disabled = true;
    el.closest("li")?.classList.add("busy");
  }

  /** A click inside the rendered body: a `/`-rooted or relative link opens that document here; a wikilink asks the page to resolve it. */
  private onBodyClick(e: MouseEvent): void {
    const a = (e.composedPath().find((n) => n instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined);
    if (!a) return;
    const wiki = a.getAttribute("data-wiki");
    if (wiki) { e.preventDefault(); this.emit<OpenWikiDetail>("open-wiki", { name: wiki }); return; }
    const doc = a.getAttribute("data-doc");
    if (doc !== null && this.doc) {
      e.preventDefault();
      const base = this.doc.path;
      const path = doc.startsWith("/") ? doc : `${base.slice(0, base.lastIndexOf("/") + 1)}${doc}`;
      this.emit<OpenDocDetail>("open-doc", { path: path.replace(/\/\.\//g, "/") });
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("highlight") || changed.has("rendered")) {
      for (const el of this.renderRoot.querySelectorAll(".highlight")) el.classList.remove("highlight");
      if (this.highlight) {
        const el = this.renderRoot.querySelector(`[data-block="${this.highlight}"]`);
        if (el) { el.classList.add("highlight"); el.scrollIntoView({ block: "start" }); }
      }
    }
    if (changed.has("taskPending") || changed.has("rendered")) this.syncPending();
  }

  /** The editor's [×]: empty both fields (the pending plan, if any, is untouched). */
  private clearEdit(): void {
    this.editKey = "";
    this.editValue = "";
  }

  private startEdit(key: string, text: string): void {
    this.editKey = key;
    this.editValue = text;
  }

  private submitPlan(unset: boolean): void {
    const key = this.editKey.trim();
    if (!key) return;
    this.emit<WritePlanDetail>("write-plan", { key, value: this.editValue, unset });
  }

  private renderProps() {
    if (!this.doc) return nothing;
    const rows = propertyRows(this.doc.properties);
    if (rows.length === 0 && !this.canWrite) return html`<div class="anchors">no properties</div>`;
    // Collapsible: a long property bag (frontmatter + inline + computed) can push
    // the body below the fold. Open by default while it is short; the user's
    // choice sticks across documents once made. The frontmatter editor lives
    // inside — it is only wanted while looking at the properties.
    const open = this.propsOpen ?? rows.length <= PROPS_OPEN_MAX;
    return html`<details class="props-wrap" data-props-details ?open=${open} @toggle=${(e: Event) => { this.propsOpen = (e.target as HTMLDetailsElement).open; }}>
      <summary>properties <span class="count">(${rows.length})</span></summary>
      <table class="props" data-props>
        ${rows.map((r) => html`<tr>
          <td class="src">${r.source}</td>
          <th>${r.key}</th>
          <td class="val">${r.text}${this.canWrite && r.source === "frontmatter" ? html`<button type="button" title="edit this key" @click=${() => this.startEdit(r.key, r.text)}>edit</button>` : nothing}</td>
        </tr>`)}
      </table>
      ${this.renderEditor()}
    </details>`;
  }

  private renderEditor() {
    if (!this.canWrite || !this.doc) return nothing;
    return html`<form class="editor" data-editor @submit=${(e: Event) => { e.preventDefault(); this.submitPlan(false); }}>
      <span>frontmatter</span>
      <input class="key" placeholder="key" .value=${this.editKey} @input=${(e: Event) => { this.editKey = (e.target as HTMLInputElement).value; }}>
      <span>=</span>
      <input class="value" placeholder='value (true, 3, "text", [a, b] as JSON)' .value=${this.editValue} @input=${(e: Event) => { this.editValue = (e.target as HTMLInputElement).value; }}>
      <button type="submit" class="primary" ?disabled=${this.writing || !this.editKey.trim()}>plan set</button>
      <button type="button" ?disabled=${this.writing || !this.editKey.trim()} @click=${() => this.submitPlan(true)}>plan unset</button>
      <button type="button" class="clear" title="clear the key and value" aria-label="clear" ?disabled=${this.writing || (this.editKey === "" && this.editValue === "")} @click=${() => this.clearEdit()}>×</button>
      <span class="hint">a change is previewed with <code>plan</code> (its summary and diff below) and committed with <code>execute</code> only when you confirm</span>
    </form>`;
  }

  private renderPending() {
    const p = this.pending;
    if (!p) return nothing;
    const diffs = Object.entries(p.diffs);
    return html`<div class="pending" data-pending>
      <ul class="summary">${p.summary.map((s) => html`<li>${s}</li>`)}</ul>
      ${diffs.length === 0 ? html`<div>nothing would change</div>` : diffs.map(([path, d]) => html`
        <div><b>${path}</b></div>
        <pre>${unifiedDiff(d.before, d.after).split("\n").map((line) => html`<span class=${diffLineKind(line)}>${line}</span>`)}</pre>`)}
      <div>
        <button type="button" class="primary" ?disabled=${this.writing || diffs.length === 0} @click=${() => this.emit("write-execute", {})}>execute</button>
        <button type="button" ?disabled=${this.writing} @click=${() => this.emit("write-cancel", {})}>cancel</button>
        <span> plan ${p.planId.slice(0, 12)}…</span>
      </div>
    </div>`;
  }

  override render() {
    const doc = this.doc;
    if (!doc) return nothing;
    const title = typeof doc.properties.computed._title === "string" ? doc.properties.computed._title : null;
    const r = this.rendered;
    const summary = r ? anchorsSummary(r) : null;
    const m = this.writeMessage;
    return html`
      <div class="head">
        <h2>${title ?? doc.path.slice(doc.path.lastIndexOf("/") + 1)}</h2>
        <span class="path">${doc.path}</span>
        <span class="meta">${doc.id} · ${doc.rev}</span>
        <span class="spacer"></span>
        <span class="undo" role="group" aria-label="task toggles" data-undo>
          <button type="button" title=${this.undoLabel ?? "nothing to undo (undoes the last task toggle; ⌘Z / Ctrl+Z)"} ?disabled=${!this.undoLabel || this.taskPending !== null} @click=${() => this.emit("task-undo", {})}>undo</button>
          <button type="button" title=${this.redoLabel ?? "nothing to redo (⇧⌘Z / Ctrl+Shift+Z)"} ?disabled=${!this.redoLabel || this.taskPending !== null} @click=${() => this.emit("task-redo", {})}>redo</button>
        </span>
        <span class="toggle" role="group" aria-label="view">
          <button type="button" class=${this.view === "rendered" ? "on" : ""} @click=${() => this.emit<ViewChangeDetail>("view-change", { view: "rendered" })}>rendered</button>
          <button type="button" class=${this.view === "raw" ? "on" : ""} @click=${() => this.emit<ViewChangeDetail>("view-change", { view: "raw" })}>raw</button>
        </span>
      </div>
      ${this.renderProps()}
      ${this.renderPending()}
      ${m ? html`<div class="msg ${m.kind}" data-write-message>${m.text}${m.fix ? html` · fix: <code>${m.fix}</code>` : nothing}</div>` : nothing}
      ${this.view === "raw"
        ? html`<pre class="raw">${doc.raw}</pre>`
        : html`
          ${summary ? html`<div class="anchors">${summary}${r && (r.unmatched > 0 || r.unverified > 0) ? html` <span class="warn">— hover a block for its id; an unverified anchor's raw did not hash to the stored block hash</span>` : html` — hover a block for its id (<code>include_ids</code>: ids, hashes, parents)`}${r && r.tasks.total > 0 ? html` · ${r.tasks.total} task${r.tasks.total === 1 ? "" : "s"}${r.tasks.editable < r.tasks.total ? html` (<span class="warn">${r.tasks.total - r.tasks.editable} not editable — hover the box</span>)` : html` (toggle a box: one <code>apply</code>, CAS-pinned)`}` : nothing}</div>` : nothing}
          <div class="body" @click=${this.onBodyClick} @change=${this.onBodyChange}>${r ? unsafeHTML(r.html) : html`<em>rendering…</em>`}</div>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "doc-view": DocView }
}
