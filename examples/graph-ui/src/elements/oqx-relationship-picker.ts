// <oqx-relationship-picker>: the candidates (relationships the query talks
// about) with their two roles — `edge` (drawn) and `layout` (the axis) — and
// the user's overrides. Emits the resolved view record.
//
//   properties: candidates (Candidate[]), overrides (Overrides)
//   events:     view-change      detail: { view: View, overrides: Overrides }
//               candidate-hover  detail: { candidate: Candidate | null }
//   methods:    reset()
//
// The candidates come from lib/candidates.ts today; when omgbase's
// `query_analyze` tool ships, the page feeds its candidates in here unchanged.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Candidate, Direction } from "../lib/candidates.ts";
import { NO_OVERRIDES, resolveView, sameView, withAxis, withDirection, withEdge, type Overrides, type View } from "../lib/view.ts";

export interface ViewChangeDetail { view: View; overrides: Overrides }

export const RELATION_COLORS = ["#1565c0", "#c62828", "#2e7d32", "#6a1b9a", "#ef6c00", "#00838f", "#ad1457", "#4e342e"];

/** A stable colour per candidate (by its position in the candidate list). */
export function relationColor(candidates: readonly Candidate[], name: string): string {
  const i = candidates.findIndex((c) => c.name === name);
  return RELATION_COLORS[(i < 0 ? 0 : i) % RELATION_COLORS.length]!;
}

@customElement("oqx-relationship-picker")
export class OqxRelationshipPicker extends LitElement {
  static override styles = css`
    :host { display: block; font: 13px/1.4 system-ui, sans-serif; color: #222; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e8eaef; white-space: nowrap; }
    th { font-weight: 600; color: #5a6270; font-size: 12px; }
    td.center, th.center { text-align: center; }
    tr.cand:hover { background: #f4f6fa; }
    .name { font-family: ui-monospace, monospace; }
    .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 11px; background: #eef1f6; color: #4a5160; margin-right: 4px; }
    .badge.follow { background: #e3f2fd; color: #0d47a1; }
    .badge.inferred { background: #fff8e1; color: #8d6e00; }
    .badge.orderby { background: #ede7f6; color: #4a148c; }
    .foot { display: flex; align-items: center; gap: 12px; padding: 6px 8px; color: #5a6270; }
    .foot select, .foot button { font: inherit; }
    .empty { padding: 8px; color: #7a8290; }
    .over { color: #ad1457; font-size: 11px; margin-left: 4px; }
  `;

  @property({ attribute: false }) candidates: Candidate[] = [];
  @property({ attribute: false }) overrides: Overrides = NO_OVERRIDES;

  private lastView: View | null = null;

  /** The resolved view (defaults + overrides). */
  get view(): View {
    return resolveView(this.candidates, this.overrides);
  }

  reset(): void {
    this.overrides = NO_OVERRIDES;
  }

  protected override updated(): void {
    const view = this.view;
    if (this.lastView && sameView(this.lastView, view)) return;
    this.lastView = view;
    this.dispatchEvent(new CustomEvent<ViewChangeDetail>("view-change", {
      detail: { view, overrides: this.overrides }, bubbles: true, composed: true,
    }));
  }

  private hover(candidate: Candidate | null): void {
    this.dispatchEvent(new CustomEvent("candidate-hover", { detail: { candidate }, bubbles: true, composed: true }));
  }

  protected override render() {
    const view = this.view;
    if (this.candidates.length === 0) {
      return html`<div class="empty">No relationships yet — add a <code>follow</code>, an <code>order by</code>, or project a field whose values are document paths.</div>`;
    }
    const axisName = view.layout.axis;
    const overridden = this.overrides.axis !== "auto" || this.overrides.direction !== "auto" || Object.keys(this.overrides.edges).length > 0;
    return html`
      <table @mouseleave=${() => this.hover(null)}>
        <thead>
          <tr><th>relationship</th><th>from</th><th class="center">edge</th><th class="center">layout</th></tr>
        </thead>
        <tbody>
          ${this.candidates.map((c) => {
            const drawn = view.edges.includes(c.name);
            const edgeOverridden = c.name in this.overrides.edges && this.overrides.edges[c.name] !== c.defaults.edge;
            return html`
              <tr class="cand" @mouseenter=${() => this.hover(c)}>
                <td><span class="swatch" style="background:${relationColor(this.candidates, c.name)}"></span><span class="name">${c.name}</span>
                  <span class="badge">${c.kind}</span></td>
                <td>${c.sources.map((s) => html`<span class="badge ${s.replace(" ", "")}">${s}</span>`)}</td>
                <td class="center">
                  <input type="checkbox" .checked=${drawn} title="draw ${c.name} as edges"
                    @change=${(e: Event) => { this.overrides = withEdge(this.overrides, c.name, (e.target as HTMLInputElement).checked); }}>
                  ${edgeOverridden ? html`<span class="over">*</span>` : nothing}
                </td>
                <td class="center">
                  <input type="radio" name="axis" .checked=${axisName === c.name} title="lay the graph out along ${c.name}"
                    @change=${() => { this.overrides = withAxis(this.overrides, c.name); }}>
                </td>
              </tr>`;
          })}
          <tr>
            <td colspan="3" style="color:#7a8290">none — force layout</td>
            <td class="center"><input type="radio" name="axis" .checked=${axisName === null}
              @change=${() => { this.overrides = withAxis(this.overrides, null); }}></td>
          </tr>
        </tbody>
      </table>
      <div class="foot">
        <label>direction
          <select ?disabled=${axisName === null} .value=${view.layout.direction}
            @change=${(e: Event) => { this.overrides = withDirection(this.overrides, (e.target as HTMLSelectElement).value as Direction); }}>
            <option value="forward">forward (src → dst)</option>
            <option value="backward">backward (dst → src)</option>
          </select>
        </label>
        ${overridden
          ? html`<button @click=${() => this.reset()}>reset to inferred</button>`
          : html`<span>inferred</span>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "oqx-relationship-picker": OqxRelationshipPicker }
}
