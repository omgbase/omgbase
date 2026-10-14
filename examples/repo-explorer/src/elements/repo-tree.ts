// <repo-tree>: the repository as collapsible folders, one `docs_tree { path,
// depth: 1 }` per opened folder (lib/tree.ts). Properties: `levels` (prefix →
// its load state), `open` (the prefixes expanded), `selected` (the open
// document's path). Events: `tree-toggle { prefix, open }` (the page loads a
// level on first open), `tree-open { path }` (a document clicked).

import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { dirBadge, entryLabel, type LevelState, type TreeEntry } from "../lib/tree.ts";

export interface TreeToggleDetail { prefix: string; open: boolean }
export interface TreeOpenDetail { path: string }

@customElement("repo-tree")
export class RepoTree extends LitElement {
  static override styles = css`
    :host { display: block; font: 13px/1.5 system-ui, sans-serif; color: #1e2430; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { margin: 0; }
    .row { display: flex; align-items: center; gap: 6px; padding: 2px 6px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
    .row:hover { background: #f1f3f7; }
    .row.selected { background: #e3edfb; color: #0d47a1; }
    .row .twisty { width: 12px; color: #8a94a6; font-size: 10px; flex: none; }
    .row .name { overflow: hidden; text-overflow: ellipsis; }
    .row.dir .name { font-weight: 600; }
    .row .badge { margin-left: auto; font-size: 11px; color: #8a94a6; padding-left: 8px; }
    .children { padding-left: 14px; }
    .note { padding: 2px 6px 2px 32px; font-size: 12px; color: #8a94a6; }
    .note.err { color: #b3261e; }
  `;

  @property({ attribute: false }) levels: ReadonlyMap<string, LevelState> = new Map();
  @property({ attribute: false }) open: ReadonlySet<string> = new Set(["/"]);
  @property({ type: String }) selected: string | null = null;

  private toggle(prefix: string): void {
    this.dispatchEvent(new CustomEvent<TreeToggleDetail>("tree-toggle", { detail: { prefix, open: !this.open.has(prefix) }, bubbles: true, composed: true }));
  }

  private openDoc(path: string): void {
    this.dispatchEvent(new CustomEvent<TreeOpenDetail>("tree-open", { detail: { path }, bubbles: true, composed: true }));
  }

  private renderEntry(e: TreeEntry): TemplateResult {
    if (e.kind === "dir") {
      const isOpen = this.open.has(e.path);
      return html`<li>
        <div class="row dir" data-prefix=${e.path} @click=${() => this.toggle(e.path)} title=${e.path}>
          <span class="twisty">${isOpen ? "▾" : "▸"}</span>
          <span class="name">${entryLabel(e)}/</span>
          <span class="badge">${dirBadge(e)}</span>
        </div>
        ${isOpen ? this.renderLevel(e.path) : nothing}
      </li>`;
    }
    return html`<li>
      <div class="row doc ${this.selected === e.path ? "selected" : ""}" data-path=${e.path} @click=${() => this.openDoc(e.path)} title=${e.path}>
        <span class="twisty"></span>
        <span class="name">${entryLabel(e)}</span>
        <span class="badge" title="blocks">${e.blocks}</span>
      </div>
    </li>`;
  }

  private renderLevel(prefix: string): TemplateResult {
    const state = this.levels.get(prefix);
    if (!state || state.status === "loading") return html`<div class="note">loading…</div>`;
    if (state.status === "error") return html`<div class="note err">${state.message}</div>`;
    const { level } = state;
    if (level.entries.length === 0) return html`<div class="note">empty</div>`;
    return html`<ul class="children">
      ${level.entries.map((e) => this.renderEntry(e))}
      ${level.truncated ? html`<li class="note">… more entries not shown (${level.total.docs} documents under ${prefix})</li>` : nothing}
    </ul>`;
  }

  override render() {
    const root = this.levels.get("/");
    const total = root?.status === "ready" ? root.level.total : null;
    return html`
      <div class="row dir" @click=${() => this.toggle("/")} title="the repository root">
        <span class="twisty">${this.open.has("/") ? "▾" : "▸"}</span>
        <span class="name">/</span>
        ${total ? html`<span class="badge">${total.docs} doc${total.docs === 1 ? "" : "s"} · ${total.blocks} blocks</span>` : nothing}
      </div>
      ${this.open.has("/") ? this.renderLevel("/") : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "repo-tree": RepoTree }
}
