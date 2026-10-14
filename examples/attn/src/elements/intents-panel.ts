// <intents-panel>: the intents (focused first — by the virtual #focus column,
// never a tag), each with release / reactivate and its cues; and the cue
// editor for the focused (or chosen) intent: a "when …" picker — a focus
// predicate in OQX, a time, or a query whose membership set is watched —
// previewed with `plan` (the summary and the file to be created) and committed
// with `execute`. Events: `intent-focus { path }`, `intent-status { path,
// status }`, `cue-plan { cue }`, `cue-execute`, `cue-cancel`, `cue-dismiss { path }`.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Cue } from "../lib/cues.ts";
import type { Intent } from "../lib/intents.ts";
import { cuePath, type CueTrigger, type IntentStatus } from "../lib/model.ts";
import type { NewCue, Plan } from "../lib/writes.ts";

export interface IntentStatusDetail { path: string; status: IntentStatus }
export interface IntentFocusDetail { path: string }
export interface CuePlanDetail { cue: NewCue }
export interface CuePathDetail { path: string }
export interface PanelMessage { kind: "error" | "info"; text: string; fix?: string | null }

@customElement("intents-panel")
export class IntentsPanel extends LitElement {
  static override styles = css`
    :host { display: block; font: 13.5px/1.45 system-ui, sans-serif; color: #1e2430; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #5a6270; margin: 0 0 8px; font-weight: 600; display: flex; gap: 10px; align-items: baseline; }
    h2 label { font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: auto; font-size: 12px; }
    .intent { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 6px 10px; border: 1px solid #e3e6ec; border-radius: 8px; margin-bottom: 6px; background: #fff; }
    .intent.focused { border-color: #1565c0; box-shadow: inset 3px 0 0 #1565c0; }
    .intent.released { opacity: 0.7; background: #fafbfc; }
    .intent .title { font-weight: 600; cursor: pointer; }
    .intent .title:hover { color: #1565c0; }
    .intent .meta { color: #5a6270; font-size: 12px; grid-column: 1; }
    .intent .meta .focus { color: #1565c0; font-weight: 600; }
    .intent .actions { grid-row: 1 / span 2; display: flex; gap: 4px; align-items: flex-start; }
    .intent .cues { grid-column: 1 / span 2; font-size: 12px; color: #5a6270; }
    .intent .cues .c { display: flex; gap: 6px; align-items: baseline; }
    .intent .cues .c.dismissed { text-decoration: line-through; opacity: 0.6; }
    .intent .cues code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
    button { font: inherit; font-size: 12px; padding: 2px 9px; border: 1px solid #c9cdd6; border-radius: 6px; background: #fff; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.primary { background: #1565c0; color: #fff; border-color: #1565c0; }
    button.tiny { font-size: 11px; padding: 0 6px; }
    .editor { margin-top: 12px; padding: 10px 12px; border: 1px dashed #c9cdd6; border-radius: 8px; background: #fafbfc; }
    .editor h3 { font-size: 12.5px; margin: 0 0 6px; font-weight: 600; }
    .editor .row { display: flex; gap: 8px; margin-bottom: 6px; align-items: center; flex-wrap: wrap; }
    .editor label { font-size: 12px; color: #5a6270; }
    .editor input, .editor select, .editor textarea { font: inherit; font-size: 13px; padding: 4px 8px; border: 1px solid #c9cdd6; border-radius: 6px; background: #fff; }
    .editor input.wide, .editor textarea { width: 100%; box-sizing: border-box; }
    .editor textarea.oqx, .editor input.oqx { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .editor .help { font-size: 11.5px; color: #8a94a6; }
    .plan { margin-top: 8px; padding: 8px 10px; border-radius: 6px; background: #fff; border: 1px solid #c5d8f7; font-size: 12.5px; }
    .plan .summary div { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
    .plan pre { margin: 6px 0; white-space: pre-wrap; font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f6f8fa; padding: 6px 8px; border-radius: 4px; max-height: 14em; overflow: auto; }
    .msg { margin-top: 6px; padding: 6px 10px; border-radius: 6px; font-size: 12.5px; background: #eef4ff; color: #1e3a5f; border: 1px solid #c5d8f7; }
    .msg.error { background: #fff5f5; color: #c62828; border-color: #ef9a9a; }
    .msg pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: #1e2430; }
    .empty { color: #8a94a6; font-size: 13px; }
  `;

  @property({ attribute: false }) intents: Intent[] = [];
  @property({ attribute: false }) cues: Cue[] = [];
  @property({ type: String }) focused: string | null = null;
  @property({ type: Boolean }) busy = false;
  @property({ attribute: false }) pending: Plan | null = null;
  @property({ attribute: false }) message: PanelMessage | null = null;

  @state() private showReleased = false;
  @state() private editing = false;
  @state() private forIntent = "";
  @state() private trigger: CueTrigger = "focus";
  @state() private cueTitle = "";
  @state() private when = "";
  @state() private at = "";
  @state() private query = "";
  @state() private text = "";

  private emit<T>(name: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(name, { detail, bubbles: true, composed: true }));
  }

  private openEditor(intent: string): void {
    this.editing = true;
    this.forIntent = intent;
  }

  private plan(): void {
    const intent = this.forIntent || this.focused;
    if (!intent || !this.cueTitle.trim()) return;
    const cue: NewCue = {
      path: cuePath(this.cueTitle, this.cues.map((c) => c.path)),
      title: this.cueTitle.trim(),
      intent,
      trigger: this.trigger,
      text: this.text,
      ...(this.trigger === "focus" ? { when: this.when.trim() } : {}),
      ...(this.trigger === "time" ? { at: this.at.trim() } : {}),
      ...(this.trigger === "query" ? { query: this.query.trim() } : {}),
    };
    this.emit<CuePlanDetail>("cue-plan", { cue });
  }

  private reset(): void {
    this.editing = false;
    this.cueTitle = ""; this.when = ""; this.at = ""; this.query = ""; this.text = "";
  }

  private renderCue(c: Cue) {
    const how = c.trigger === "focus" ? html`when <code>${c.when ?? "?"}</code>` : c.trigger === "time" ? html`at <code>${c.at ?? "?"}</code>` : html`query <code>${c.query ?? "?"}</code>`;
    return html`<div class="c ${c.status}" title=${c.text}>↳ ${c.title} · ${how}${c.status === "active" ? html` <button type="button" class="tiny" ?disabled=${this.busy} @click=${() => this.emit<CuePathDetail>("cue-dismiss", { path: c.path })}>dismiss</button>` : html` (dismissed)`}</div>`;
  }

  private renderEditor() {
    const targets = this.intents.filter((i) => i.status === "active");
    const current = this.forIntent || this.focused || targets[0]?.path || "";
    const m = this.message;
    return html`<div class="editor" data-cue-editor>
      <h3>new cue</h3>
      <div class="row"><label>for</label>
        <select .value=${current} @change=${(e: Event) => { this.forIntent = (e.target as HTMLSelectElement).value; }}>
          ${targets.map((i) => html`<option value=${i.path} ?selected=${i.path === current}>${i.title}</option>`)}
        </select>
        <label>when</label>
        <select .value=${this.trigger} @change=${(e: Event) => { this.trigger = (e.target as HTMLSelectElement).value as CueTrigger; }}>
          <option value="focus" ?selected=${this.trigger === "focus"}>the focused intent matches a predicate</option>
          <option value="time" ?selected=${this.trigger === "time"}>a time arrives</option>
          <option value="query" ?selected=${this.trigger === "query"}>a query gains a row</option>
        </select>
      </div>
      <div class="row"><input class="wide" placeholder="title (one line)" .value=${this.cueTitle} @input=${(e: Event) => { this.cueTitle = (e.target as HTMLInputElement).value; }}></div>
      ${this.trigger === "focus" ? html`<div class="row"><input class="wide oqx" placeholder='OQX over the focused intent, e.g. project == "magnum-opus" or "fire" in tags' .value=${this.when} @input=${(e: Event) => { this.when = (e.target as HTMLInputElement).value; }}></div>
        <div class="help">evaluated as <code>docs exists { where path == "&lt;focused&gt;" and (…) }</code> on every focus change; a predicate that does not parse is reported as the engine's <code>filter_invalid</code></div>` : nothing}
      ${this.trigger === "time" ? html`<div class="row"><input class="wide oqx" placeholder="ISO time, e.g. 2026-10-14T16:00:00Z" .value=${this.at} @input=${(e: Event) => { this.at = (e.target as HTMLInputElement).value; }}></div>
        <div class="help">fires when the client clock passes it (checked on open and every 30 s)</div>` : nothing}
      ${this.trigger === "query" ? html`<div class="row"><textarea class="oqx" rows="2" placeholder='select path from docs where type == "intent" and status == "active"' .value=${this.query} @input=${(e: Event) => { this.query = (e.target as HTMLTextAreaElement).value; }}></textarea></div>
        <div class="help">run after each changes_since poll; ids entering the result fire the cue (the checkpoint lives in this browser)</div>` : nothing}
      <div class="row"><textarea rows="2" placeholder="the cue's text — what to come back to mind" .value=${this.text} @input=${(e: Event) => { this.text = (e.target as HTMLTextAreaElement).value; }}></textarea></div>
      <div class="row">
        <button type="button" class="primary" ?disabled=${this.busy || !this.cueTitle.trim() || !current} @click=${this.plan}>preview (plan)</button>
        <button type="button" ?disabled=${this.busy} @click=${() => { this.reset(); this.emit("cue-cancel", {}); }}>cancel</button>
      </div>
      ${this.pending ? html`<div class="plan" data-plan>
        <div class="summary">${this.pending.summary.map((s) => html`<div>${s}</div>`)}</div>
        ${Object.entries(this.pending.diffs).map(([path, d]) => html`<div><b>${path}</b></div><pre>${d.after}</pre>`)}
        <button type="button" class="primary" ?disabled=${this.busy} @click=${() => this.emit("cue-execute", {})}>commit (execute)</button>
      </div>` : nothing}
      ${m ? html`<div class="msg ${m.kind}">${m.text}${m.fix ? html`<pre>${m.fix}</pre>` : nothing}</div>` : nothing}
    </div>`;
  }

  override render() {
    const shown = this.intents.filter((i) => this.showReleased || i.status === "active");
    const cuesOf = (path: string) => this.cues.filter((c) => c.intent === path);
    return html`
      <h2>intents
        <label><input type="checkbox" .checked=${this.showReleased} @change=${(e: Event) => { this.showReleased = (e.target as HTMLInputElement).checked; }}> show released</label>
      </h2>
      ${shown.length === 0 ? html`<div class="empty">no intents yet — type one into the bar above</div>` : nothing}
      ${shown.map((i) => html`<div class="intent ${i.focusSince ? "focused" : ""} ${i.status}" data-intent=${i.path}>
        <div class="title" title=${i.path} @click=${() => { if (i.status === "active" && !i.focusSince) this.emit<IntentFocusDetail>("intent-focus", { path: i.path }); }}>${i.title}</div>
        <div class="actions">
          ${i.status === "active" ? html`
            ${i.focusSince ? nothing : html`<button type="button" ?disabled=${this.busy} @click=${() => this.emit<IntentFocusDetail>("intent-focus", { path: i.path })}>focus</button>`}
            <button type="button" ?disabled=${this.busy} title="add a cue for this intent" @click=${() => this.openEditor(i.path)}>cue…</button>
            <button type="button" ?disabled=${this.busy} title="set status: released — let it go; its cues stop firing" @click=${() => this.emit<IntentStatusDetail>("intent-status", { path: i.path, status: "released" })}>release</button>`
          : html`<button type="button" ?disabled=${this.busy} @click=${() => this.emit<IntentStatusDetail>("intent-status", { path: i.path, status: "active" })}>reactivate</button>`}
        </div>
        <div class="meta">${i.focusSince ? html`<span class="focus">#focus</span> · ` : nothing}${i.tags.map((t) => `#${t}`).join(" ")}${i.project ? ` · ${i.project}` : ""}${i.status === "released" ? " · released" : ""}</div>
        ${cuesOf(i.path).length ? html`<div class="cues">${cuesOf(i.path).map((c) => this.renderCue(c))}</div>` : nothing}
      </div>`)}
      ${this.editing ? this.renderEditor() : html`<button type="button" ?disabled=${this.busy || !this.intents.some((i) => i.status === "active")} @click=${() => this.openEditor(this.focused ?? "")}>new cue${this.focused ? " for the focused intent" : ""}…</button>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "intents-panel": IntentsPanel }
}
