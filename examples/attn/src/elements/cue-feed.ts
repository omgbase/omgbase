// <cue-feed>: the cues that fired — each with its text, the intent it belongs
// to, why it fired, and three actions: focus that intent (`cue-focus { path }`),
// snooze until the next focus boundary (`cue-snooze { path }`, app-local), or
// dismiss (`cue-dismiss { path }`, `set status: dismissed` on the cue document).
// A cue never steals focus; it is offered here. Predicates the engine refused
// (`filter_invalid`) are listed under the feed so a typo in a cue's `when` is
// seen, not swallowed.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { CueError, FiredCue } from "../lib/cues.ts";

export interface CueActionDetail { path: string }
export interface CueProblem { cuePath: string; title: string; error: CueError }

@customElement("cue-feed")
export class CueFeed extends LitElement {
  static override styles = css`
    :host { display: block; font: 13.5px/1.45 system-ui, sans-serif; color: #1e2430; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #5a6270; margin: 0 0 8px; font-weight: 600; }
    .cue { border: 1px solid #ffe082; background: #fffdf5; border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; animation: arrive 1.2s ease-out; }
    @keyframes arrive { from { box-shadow: 0 0 0 3px #ffe082; } to { box-shadow: 0 0 0 0 transparent; } }
    .cue .title { font-weight: 600; }
    .cue .text { margin: 4px 0; white-space: pre-wrap; }
    .cue .meta { color: #6d4c00; font-size: 12px; }
    .cue .meta code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
    .actions { display: flex; gap: 6px; margin-top: 6px; }
    button { font: inherit; font-size: 12px; padding: 2px 9px; border: 1px solid #c9cdd6; border-radius: 6px; background: #fff; cursor: pointer; }
    button.primary { background: #1565c0; color: #fff; border-color: #1565c0; }
    .empty { color: #8a94a6; font-size: 13px; }
    .problem { color: #c62828; font-size: 12px; margin-top: 6px; }
    .problem code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  `;

  @property({ attribute: false }) fired: FiredCue[] = [];
  /** Intent path → its title. */
  @property({ attribute: false }) titles: Map<string, string> = new Map();
  @property({ attribute: false }) problems: CueProblem[] = [];
  @property({ type: Boolean }) busy = false;

  private emit(name: string, path: string): void {
    this.dispatchEvent(new CustomEvent<CueActionDetail>(name, { detail: { path }, bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <h2>cues</h2>
      ${this.fired.length === 0 ? html`<div class="empty">nothing to resurface right now — cues fire on a focus change, at their time, or when a watched query gains a row</div>` : nothing}
      ${this.fired.map((f) => html`<div class="cue" data-cue=${f.cue.path}>
        <div class="title">${f.cue.title}</div>
        <div class="text">${f.cue.text}</div>
        <div class="meta">for <b>${this.titles.get(f.cue.intent) ?? f.cue.intent}</b> · ${f.reason}</div>
        <div class="actions">
          <button type="button" class="primary" ?disabled=${this.busy} @click=${() => this.emit("cue-focus", f.cue.intent)}>focus ${this.titles.get(f.cue.intent) ?? "it"}</button>
          <button type="button" ?disabled=${this.busy} title="quiet until the next focus change (kept in this browser only)" @click=${() => this.emit("cue-snooze", f.cue.path)}>snooze</button>
          <button type="button" ?disabled=${this.busy} title="set status: dismissed on the cue document" @click=${() => this.emit("cue-dismiss", f.cue.path)}>dismiss</button>
        </div>
      </div>`)}
      ${this.problems.map((p) => html`<div class="problem" data-problem>cue <b>${p.title}</b>: <code>${p.error.code}</code> — ${p.error.message}${p.error.hint ? ` (${p.error.hint})` : ""}</div>`)}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "cue-feed": CueFeed }
}
