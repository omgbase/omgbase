// <oqx-relationship-picker>: the candidates (relationships the query talks
// about) with their two roles — `edge` (drawn) and `layout` (the axis) — and
// the user's overrides. Emits the resolved view record.
//
//   properties: candidates (Candidate[]), overrides (Overrides),
//               editable (Record<name, Editability> — which candidates can be
//               written and why not), armed (name | null — the one armed for editing)
//   events:     view-change      detail: { view: View, overrides: Overrides }
//               candidate-hover  detail: { candidate: Candidate | null }
//               armed-change     detail: { candidate: Candidate | null }
//   methods:    reset()
//
// Arming a candidate also draws it (its edge override is switched on), so the
// edges being toggled are visible.
//
// The candidates come from lib/candidates.ts today; when omgbase's
// `query_analyze` tool ships, the page feeds its candidates in here unchanged.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Candidate, Direction } from "../lib/candidates.ts";
import { describeForm, type Editability } from "../lib/edit.ts";
import { NO_OVERRIDES, resolveView, sameView, withAxis, withDirection, withEdge, type Overrides, type View } from "../lib/view.ts";

export interface ViewChangeDetail { view: View; overrides: Overrides }
export interface ArmedChangeDetail { candidate: Candidate | null }

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
    .ro { color: #9aa1ad; font-size: 11px; cursor: help; }
    tr.armed { background: #fff8e1; }
    .form { color: #7a8290; font-size: 11px; margin-left: 4px; font-family: ui-monospace, monospace; }
  `;

  @property({ attribute: false }) candidates: Candidate[] = [];
  @property({ attribute: false }) overrides: Overrides = NO_OVERRIDES;
  @property({ attribute: false }) editable: Record<string, Editability> = {};
  @property() armed: string | null = null;

  private lastView: View | null = null;
  private lastArmed: string | null = null;

  /** The resolved view (defaults + overrides). */
  get view(): View {
    return resolveView(this.candidates, this.overrides);
  }

  reset(): void {
    this.overrides = NO_OVERRIDES;
  }

  protected override willUpdate(): void {
    // An armed candidate that vanished (or became read-only) is disarmed.
    if (this.armed !== null && !(this.editable[this.armed]?.writable && this.candidates.some((c) => c.name === this.armed))) this.armed = null;
  }

  protected override updated(): void {
    if (this.armed !== this.lastArmed) {
      this.lastArmed = this.armed;
      const candidate = this.candidates.find((c) => c.name === this.armed) ?? null;
      this.dispatchEvent(new CustomEvent<ArmedChangeDetail>("armed-change", { detail: { candidate }, bubbles: true, composed: true }));
    }
    const view = this.view;
    if (this.lastView && sameView(this.lastView, view)) return;
    this.lastView = view;
    this.dispatchEvent(new CustomEvent<ViewChangeDetail>("view-change", {
      detail: { view, overrides: this.overrides }, bubbles: true, composed: true,
    }));
  }

  /** Arm `name` for editing (null disarms); an armed relationship is also drawn. */
  arm(name: string | null): void {
    this.armed = name;
    if (name !== null && !this.view.edges.includes(name)) this.overrides = withEdge(this.overrides, name, true);
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
          <tr><th>relationship</th><th>from</th><th class="center">edge</th><th class="center">layout</th><th class="center">edit</th></tr>
        </thead>
        <tbody>
          ${this.candidates.map((c) => {
            const drawn = view.edges.includes(c.name);
            const edgeOverridden = c.name in this.overrides.edges && this.overrides.edges[c.name] !== c.defaults.edge;
            const ed = this.editable[c.name];
            const armed = this.armed === c.name;
            return html`
              <tr class="cand ${armed ? "armed" : ""}" @mouseenter=${() => this.hover(c)}>
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
                <td class="center">
                  ${ed?.writable
                    ? html`<input type="radio" name="armed" .checked=${armed}
                        title="arm ${c.name} for editing: select a node, then ⌘-click (Ctrl-click) another to toggle it; values written as ${describeForm(ed.form)} (${ed.shape}${ed.formSource === "field" ? "" : `, form from ${ed.formSource}`})"
                        @click=${() => this.arm(armed ? null : c.name)}>
                      ${armed ? html`<span class="form">${describeForm(ed.form)}</span>` : nothing}`
                    : html`<span class="ro" title=${ed ? ed.reason : "read-only"}>read-only</span>`}
                </td>
              </tr>`;
          })}
          <tr>
            <td colspan="3" style="color:#7a8290">none — force layout</td>
            <td class="center"><input type="radio" name="axis" .checked=${axisName === null}
              @change=${() => { this.overrides = withAxis(this.overrides, null); }}></td>
            <td></td>
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
