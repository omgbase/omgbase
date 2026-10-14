// <intent-feed>: the feed is a list of intent documents. Three sections —
// CUED (active intents a cue lifted, each with its one-line "why now", deduped
// by intent), RECENT (the other active intents, most recently edited first),
// and RELEASED behind a toggle (with reactivate). The focused intent is in the
// bar, never here. Every row offers focus / cue… / edit / release; each
// intent's cues are listed under it (id · on · query or at) with remove. The
// cue editor adds one entry to an intent's `cues` list — id, on, query or at —
// and the page previews the WHOLE list as `set frontmatter.cues` with `plan`
// (summary + the file after) and commits with `execute`. The intent editor is
// a textarea over the document's raw bytes (`set content`). Events:
// `intent-focus { path }`, `intent-status { path, status }`, `cue-plan { path,
// cues }`, `cue-execute`, `cue-cancel`, `cue-remove { path, id }`,
// `cue-snooze { path }`, `intent-edit-open { path }`, `intent-edit-save { path,
// content }`, `intent-edit-cancel`.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Cue, CueError } from "../lib/cues.ts";
import type { Feed, Intent } from "../lib/intents.ts";
import { CUE_ONS, cueId, type CueOn, type IntentStatus } from "../lib/model.ts";
import type { Plan } from "../lib/writes.ts";

export interface IntentStatusDetail { path: string; status: IntentStatus }
export interface IntentPathDetail { path: string }
export interface CuePlanDetail { path: string; cues: Pick<Cue, "id" | "on" | "query" | "at">[] }
export interface CueRemoveDetail { path: string; id: string }
export interface IntentEditSaveDetail { path: string; content: string }
export interface PanelMessage { kind: "error" | "info"; text: string; fix?: string | null }
export interface CueProblem { cue: Cue; error: CueError }
/** The intent being edited: its raw bytes as read (`docs_read`). */
export interface EditingIntent { path: string; raw: string }

const ON_LABEL: Record<CueOn, string> = {
  focus: "the focused intent is in a query's result",
  time: "a time arrives",
  "query-enter": "a row enters a query's result",
  "query-exit": "a row leaves a query's result",
};

/** The meta line's parts, joined by " · " only between parts that exist (a tag-less intent never starts with the separator). */
export function metaLine(i: Intent): string {
  const parts: string[] = [];
  if (i.tags.length) parts.push(i.tags.map((t) => `#${t}`).join(" "));
  if (i.project) parts.push(i.project);
  if (i.updatedAt) parts.push(`edited ${i.updatedAt.slice(0, 16).replace("T", " ")}Z`);
  if (i.status === "released") parts.push("released");
  return parts.join(" · ");
}

@customElement("intent-feed")
export class IntentFeed extends LitElement {
  static override styles = css`
    :host { display: block; font: 13.5px/1.45 system-ui, sans-serif; color: #1e2430; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #5a6270; margin: 14px 0 8px; font-weight: 600; display: flex; gap: 10px; align-items: baseline; }
    h2:first-child { margin-top: 0; }
    h2 label { font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: auto; font-size: 12px; }
    h2.cued { color: #8a5a00; }
    /* Two columns: the text column shrinks (titles ellipsize) and the actions
       column is as wide as its buttons and never wraps, so every row's buttons
       line up on the right regardless of title length. */
    .intent { display: grid; grid-template-columns: minmax(0, 1fr) max-content; gap: 2px 12px; padding: 6px 10px; border: 1px solid #e3e6ec; border-radius: 8px; margin-bottom: 6px; background: #fff; }
    .intent.cued { border-color: #ffe082; background: #fffdf5; animation: arrive 1.2s ease-out; }
    @keyframes arrive { from { box-shadow: 0 0 0 3px #ffe082; } to { box-shadow: 0 0 0 0 transparent; } }
    .intent.released { opacity: 0.7; background: #fafbfc; }
    .intent .title { font-weight: 600; cursor: pointer; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .intent .title:hover { color: #1565c0; }
    .intent .meta { color: #5a6270; font-size: 12px; grid-column: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .intent .why { grid-column: 1 / span 2; color: #6d4c00; font-size: 12px; }
    .intent .why code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
    .intent .actions { grid-row: 1 / span 2; grid-column: 2; display: flex; gap: 4px; align-items: flex-start; flex-wrap: nowrap; justify-content: flex-end; white-space: nowrap; }
    .intent .cues { grid-column: 1 / span 2; font-size: 12px; color: #5a6270; }
    .intent .cues .c { display: flex; gap: 6px; align-items: baseline; }
    .intent .cues code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; }
    button { font: inherit; font-size: 12px; padding: 2px 9px; border: 1px solid #c9cdd6; border-radius: 6px; background: #fff; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.primary { background: #1565c0; color: #fff; border-color: #1565c0; }
    button.tiny { font-size: 11px; padding: 0 6px; }
    .editor { margin: 6px 0 10px; padding: 10px 12px; border: 1px dashed #c9cdd6; border-radius: 8px; background: #fafbfc; }
    .editor h3 { font-size: 12.5px; margin: 0 0 6px; font-weight: 600; }
    .editor .row { display: flex; gap: 8px; margin-bottom: 6px; align-items: center; flex-wrap: wrap; }
    .editor label { font-size: 12px; color: #5a6270; }
    .editor input, .editor select, .editor textarea { font: inherit; font-size: 13px; padding: 4px 8px; border: 1px solid #c9cdd6; border-radius: 6px; background: #fff; }
    .editor input.wide, .editor textarea { width: 100%; box-sizing: border-box; }
    .editor textarea.mono, .editor input.mono { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .editor .help { font-size: 11.5px; color: #8a94a6; }
    .plan { margin-top: 8px; padding: 8px 10px; border-radius: 6px; background: #fff; border: 1px solid #c5d8f7; font-size: 12.5px; }
    .plan .summary div { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
    .plan pre { margin: 6px 0; white-space: pre-wrap; font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f6f8fa; padding: 6px 8px; border-radius: 4px; max-height: 18em; overflow: auto; }
    .msg { margin-top: 6px; padding: 6px 10px; border-radius: 6px; font-size: 12.5px; background: #eef4ff; color: #1e3a5f; border: 1px solid #c5d8f7; }
    .msg.error { background: #fff5f5; color: #c62828; border-color: #ef9a9a; }
    .msg pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #1e2430; }
    .empty { color: #8a94a6; font-size: 13px; }
    .problem { color: #c62828; font-size: 12px; margin-top: 6px; }
    .problem code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  `;

  @property({ attribute: false }) feed: Feed = { cued: [], recent: [], released: [] };
  @property({ attribute: false }) problems: CueProblem[] = [];
  @property({ type: Boolean }) busy = false;
  @property({ attribute: false }) pending: Plan | null = null;
  @property({ attribute: false }) editing: EditingIntent | null = null;
  @property({ attribute: false }) message: PanelMessage | null = null;

  @state() private showReleased = false;
  /** The intent whose cue editor is open (its path), or "". */
  @state() private cueFor = "";
  @state() private newId = "";
  @state() private newOn: CueOn = "focus";
  @state() private newQuery = "";
  @state() private newAt = "";
  @state() private editText = "";
  private editPath = "";

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private openCueEditor(path: string): void {
    this.cueFor = path;
    this.newId = ""; this.newQuery = ""; this.newAt = ""; this.newOn = "focus";
  }

  private planCue(intent: Intent): void {
    const taken = intent.cues.map((c) => c.id);
    const id = cueId(this.newId || `${this.newOn} ${intent.cues.length + 1}`, taken);
    const cue = { id, on: this.newOn, query: this.newOn === "time" ? null : this.newQuery.trim() || null, at: this.newOn === "time" ? this.newAt.trim() || null : null };
    if (this.newOn === "time" ? !cue.at : !cue.query) return;
    this.emit<CuePlanDetail>("cue-plan", { path: intent.path, cues: [...intent.cues, cue] });
  }

  private renderCue(intent: Intent, c: Cue) {
    const how = c.on === "time" ? html`at <code>${c.at ?? "?"}</code>` : html`<code>${(c.query ?? "?").trim()}</code>`;
    return html`<div class="c" data-cue=${`${intent.path}#${c.id}`}>↳ <b>${c.id}</b> · ${c.on} · ${how}
      <button type="button" class="tiny" ?disabled=${this.busy} title="remove this cue from the intent's cues list (set frontmatter.cues)" @click=${() => this.emit<CueRemoveDetail>("cue-remove", { path: intent.path, id: c.id })}>remove</button></div>`;
  }

  private renderCueEditor(intent: Intent) {
    const m = this.message;
    return html`<div class="editor" data-cue-editor>
      <h3>new cue for ${intent.title}</h3>
      <div class="row">
        <label>id</label><input class="mono" placeholder="when-oqx-focused" .value=${this.newId} @input=${(e: Event) => { this.newId = (e.target as HTMLInputElement).value; }}>
        <label>on</label>
        <select .value=${this.newOn} @change=${(e: Event) => { this.newOn = (e.target as HTMLSelectElement).value as CueOn; }}>
          ${CUE_ONS.map((on) => html`<option value=${on} ?selected=${on === this.newOn}>${on} — ${ON_LABEL[on]}</option>`)}
        </select>
      </div>
      ${this.newOn === "time"
        ? html`<div class="row"><input class="wide mono" placeholder="ISO time, e.g. 2026-10-15T09:00:00Z" .value=${this.newAt} @input=${(e: Event) => { this.newAt = (e.target as HTMLInputElement).value; }}></div>
          <div class="help">fires when the client clock passes it (checked on open and every 30 s)</div>`
        : html`<div class="row"><textarea class="mono" rows="3" placeholder=${this.newOn === "focus" ? 'from docs\nwhere project == "/projects/magnum-opus.md"' : 'from docs\nwhere type == "/terms/types/intent.md" and status == "active"'} .value=${this.newQuery} @input=${(e: Event) => { this.newQuery = (e.target as HTMLTextAreaElement).value; }}></textarea></div>
          <div class="help">${this.newOn === "focus" ? "a whole OQX query over docs; the cue matches when the newly focused intent is among its hits" : "run after each changes_since poll; ids entering / leaving the result fire the cue (the checkpoint lives in this browser)"}</div>`}
      <div class="row">
        <button type="button" class="primary" ?disabled=${this.busy} @click=${() => this.planCue(intent)}>preview (plan)</button>
        <button type="button" ?disabled=${this.busy} @click=${() => { this.cueFor = ""; this.emit("cue-cancel", {}); }}>cancel</button>
      </div>
      ${this.pending ? html`<div class="plan" data-plan>
        <div class="summary">${this.pending.summary.map((s) => html`<div>${s}</div>`)}</div>
        ${Object.entries(this.pending.diffs).map(([path, d]) => html`<div><b>${path}</b></div><pre>${d.after}</pre>`)}
        <button type="button" class="primary" ?disabled=${this.busy} @click=${() => this.emit("cue-execute", {})}>commit (execute)</button>
      </div>` : nothing}
      ${m ? html`<div class="msg ${m.kind}">${m.text}${m.fix ? html`<pre>${m.fix}</pre>` : nothing}</div>` : nothing}
    </div>`;
  }

  private renderEditor(intent: Intent) {
    const e = this.editing!;
    if (this.editPath !== e.path) { this.editPath = e.path; this.editText = e.raw; }
    return html`<div class="editor" data-intent-editor>
      <h3>edit ${intent.title} <span class="help">(${e.path} — the whole document; saved as <code>set content</code>)</span></h3>
      <div class="row"><textarea class="mono" rows="12" .value=${this.editText} @input=${(ev: Event) => { this.editText = (ev.target as HTMLTextAreaElement).value; }}></textarea></div>
      <div class="row">
        <button type="button" class="primary" ?disabled=${this.busy || this.editText === e.raw} @click=${() => this.emit<IntentEditSaveDetail>("intent-edit-save", { path: e.path, content: this.editText })}>save</button>
        <button type="button" ?disabled=${this.busy} @click=${() => { this.editPath = ""; this.emit("intent-edit-cancel", {}); }}>cancel</button>
      </div>
      ${this.message ? html`<div class="msg ${this.message.kind}">${this.message.text}</div>` : nothing}
    </div>`;
  }

  private renderIntent(i: Intent, why: string[] | null) {
    const active = i.status === "active";
    return html`<div class="intent ${why ? "cued" : ""} ${i.status}" data-intent=${i.path}>
      <div class="title" title=${i.path} @click=${() => { if (active) this.emit<IntentPathDetail>("intent-focus", { path: i.path }); }}>${i.title}</div>
      <div class="actions">
        ${active ? html`
          <button type="button" class="primary" ?disabled=${this.busy} @click=${() => this.emit<IntentPathDetail>("intent-focus", { path: i.path })}>focus</button>
          ${why ? html`<button type="button" ?disabled=${this.busy} title="quiet until the next focus change (kept in this browser only)" @click=${() => this.emit<IntentPathDetail>("cue-snooze", { path: i.path })}>snooze</button>` : nothing}
          <button type="button" ?disabled=${this.busy} title="add a cue to this intent's cues list" @click=${() => this.openCueEditor(i.path)}>cue…</button>
          <button type="button" ?disabled=${this.busy} title="edit the document (set content)" @click=${() => this.emit<IntentPathDetail>("intent-edit-open", { path: i.path })}>edit</button>
          <button type="button" ?disabled=${this.busy} title="set status: released — let it go; its cues stop firing" @click=${() => this.emit<IntentStatusDetail>("intent-status", { path: i.path, status: "released" })}>release</button>`
        : html`<button type="button" ?disabled=${this.busy} @click=${() => this.emit<IntentStatusDetail>("intent-status", { path: i.path, status: "active" })}>reactivate</button>`}
      </div>
      <div class="meta">${metaLine(i)}</div>
      ${why ? html`<div class="why">${why.map((w) => html`<div>why now: <code>${w}</code></div>`)}</div>` : nothing}
      ${i.cues.length ? html`<div class="cues">${i.cues.map((c) => this.renderCue(i, c))}</div>` : nothing}
      ${this.cueFor === i.path ? this.renderCueEditor(i) : nothing}
      ${this.editing?.path === i.path ? this.renderEditor(i) : nothing}
    </div>`;
  }

  override render() {
    const f = this.feed;
    const none = f.cued.length === 0 && f.recent.length === 0;
    return html`
      ${f.cued.length ? html`<h2 class="cued">cued</h2>${f.cued.map((c) => this.renderIntent(c.intent, c.why))}` : nothing}
      <h2>recent
        <label><input type="checkbox" .checked=${this.showReleased} @change=${(e: Event) => { this.showReleased = (e.target as HTMLInputElement).checked; }}> released (${f.released.length})</label>
      </h2>
      ${none ? html`<div class="empty">no other intents — type one into the bar above (Enter adds it here; ⌘/⌃Enter focuses it too)</div>` : nothing}
      ${f.recent.map((i) => this.renderIntent(i, null))}
      ${this.showReleased ? html`<h2>released</h2>${f.released.length ? f.released.map((i) => this.renderIntent(i, null)) : html`<div class="empty">none</div>`}` : nothing}
      ${this.problems.map((p) => html`<div class="problem" data-problem>cue <b>${p.cue.id}</b> of ${p.cue.intent}: <code>${p.error.code}</code> — ${p.error.message}${p.error.hint ? ` (${p.error.hint})` : ""}</div>`)}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "intent-feed": IntentFeed }
}
