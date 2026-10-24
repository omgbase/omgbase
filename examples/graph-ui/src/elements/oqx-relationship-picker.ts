// <oqx-relationship-picker>: the candidates (relationships the query talks
// about) with their two roles — `edge` (drawn) and `layout` (the axis) — and
// the user's overrides. Emits the resolved view record.
//
//   properties: candidates (Candidate[]), overrides (Overrides),
//               editable (Record<name, Editability> — which candidates can be
//               written and why not), armed (name | null — the one armed for editing),
//               edgeCounts (Record<name, number> — edges among the shown nodes per
//               relationship the graph fetched; drives the empty-axis note)
//   events:     view-change      detail: { view: View, overrides: Overrides }
//               candidate-hover  detail: { candidate: Candidate | null }
//               armed-change     detail: { candidate: Candidate | null }
//   methods:    reset(), arm(name | null), setAxis(name | null), setAlgorithm(algorithm | "auto")
//
// Arming a candidate also draws it (its edge override is switched on), so the
// edges being toggled are visible. An inverse pair (`before/after`, candidates.ts
// rule 5) is read-only: its members are the fields that get written; hovering it
// lights both members here and in the editor. The direction select governs how
// the axis's arrows are drawn AND which way the layout flows (one and the same).
//
// The candidates come from lib/candidates.ts today; when omgbase's
// `query_analyze` tool ships, the page feeds its candidates in here unchanged.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { Candidate, Direction } from "../lib/candidates.ts";
import { describeForm, type Editability } from "../lib/edit.ts";
import { LAYOUT_ALGORITHMS, NO_OVERRIDES, axisStatus, resolveAlgorithm, resolveView, sameView, withAlgorithm, withAxis, withDirection, withEdge, type EdgeCounts, type LayoutAlgorithm, type Overrides, type View } from "../lib/view.ts";

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
    :host { display: block; font: 13px/1.4 system-ui, sans-serif; color: #222; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; table-layout: auto; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e8eaef; white-space: nowrap; }
    /* the name cell may wrap (a pair's "= before ∪ after⁻¹" note), so the three control columns always fit the pane */
    td:first-child { white-space: normal; }
    td:nth-child(2) { white-space: normal; }
    td:first-child .name, .badge { white-space: nowrap; }
    .ro { white-space: normal; }
    th { font-weight: 600; color: #5a6270; font-size: 12px; }
    td.center, th.center { text-align: center; width: 56px; }
    tr.cand:hover { background: #f4f6fa; }
    .name { font-family: ui-monospace, monospace; }
    .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 11px; background: #eef1f6; color: #4a5160; margin-right: 4px; }
    .badge.follow { background: #e3f2fd; color: #0d47a1; }
    .badge.inferred { background: #fff8e1; color: #8d6e00; }
    .badge.orderby { background: #ede7f6; color: #4a148c; }
    .badge.builtin { background: #e8f5e9; color: #1b5e20; }
    .badge.nested { background: #e0f2f1; color: #004d40; }
    /* where a nested mention sits (candidates.ts rule 6): "inside reach" */
    .inside { color: #7a8290; font-size: 11px; margin-left: 2px; white-space: nowrap; cursor: help; }
    .inside code { font-family: ui-monospace, monospace; }
    .foot { display: flex; align-items: center; gap: 12px; padding: 6px 8px; color: #5a6270; }
    .foot select, .foot button { font: inherit; }
    .empty { padding: 8px; color: #7a8290; }
    /* an overridden edge toggle: a cue that cannot move anything — the name's dotted underline and its title */
    .name.overridden { text-decoration: underline dotted #ad1457; text-underline-offset: 3px; cursor: help; }
    .ro { color: #9aa1ad; font-size: 11px; cursor: help; }
    tr.armed { background: #fff8e1; }
    /* the armed badge sits under its radio so the edit column keeps its width */
    .form { display: block; color: #7a8290; font-size: 11px; margin: 2px 0 0; font-family: ui-monospace, monospace; cursor: help; white-space: nowrap; }
    .badge.pair { background: #fce4ec; color: #880e4f; }
    tr.member { background: #fdf3f7; }
    tr.pair td:first-child { padding-left: 8px; }
    .members { color: #7a8290; font-size: 11px; margin-left: 4px; white-space: nowrap; }
    .note { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 6px 8px 0; padding: 6px 10px; border-radius: 4px; background: #fff3e0; color: #7a4a00; border: 1px solid #ffcc80; font-size: 12px; }
    .note code { font-family: ui-monospace, monospace; }
    .note button { font: inherit; font-size: 12px; }
    .foot { flex-wrap: wrap; }
    .foot select { max-width: 100%; }
    .foot .count { color: #9aa1ad; font-size: 11px; white-space: nowrap; }
  `;

  @property({ attribute: false }) candidates: Candidate[] = [];
  @property({ attribute: false }) overrides: Overrides = NO_OVERRIDES;
  @property({ attribute: false }) editable: Record<string, Editability> = {};
  @property() armed: string | null = null;
  @property({ attribute: false }) edgeCounts: EdgeCounts = {};
  /** How many documents the graph shows (the empty-axis note needs two). */
  @property({ type: Number }) nodeCount = 0;

  /** The hovered pair's members are lit. */
  @state() private hoveredPair: Candidate | null = null;

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

  /** Lay the graph out along `name` (null = no axis, force) — the graph's
   * empty-axis banner asks for this through the page. */
  setAxis(name: string | null): void {
    this.overrides = withAxis(this.overrides, name);
  }

  /** Pin the layout algorithm (`"auto"` = layered along the axis, else force) — the
   * graph's loop note asks for this through the page. */
  setAlgorithm(algorithm: LayoutAlgorithm | "auto"): void {
    this.overrides = withAlgorithm(this.overrides, algorithm);
  }

  private hover(candidate: Candidate | null): void {
    this.hoveredPair = candidate?.pair ? candidate : null;
    this.dispatchEvent(new CustomEvent("candidate-hover", { detail: { candidate }, bubbles: true, composed: true }));
  }

  /** What arming means for this field: new references take the field's form. */
  private formTitle(name: string, ed: Extract<Editability, { writable: true }>): string {
    const form = ed.form.kind === "id"
      ? "document ids"
      : `${ed.form.rooted ? "/-rooted" : "bare"} paths ${ed.form.md ? "with" : "without"} .md`;
    const from = ed.formSource === "field" ? "matching the field's existing values" : ed.formSource === "rows" ? "the dominant form among the reference fields in the rows (this field has no values yet)" : "the default (this field has no values yet and the rows show no other form)";
    return `new references in \`${name}\` are written as ${form} (${ed.shape}) — ${from}; a field mixing forms is refused for editing`;
  }

  protected override render() {
    const view = this.view;
    if (this.candidates.length === 0) {
      return html`<div class="empty">No relationships yet — add a <code>follow</code>, an <code>order by</code>, or project a field whose values are document paths.</div>`;
    }
    const axisName = view.layout.axis;
    const overridden = this.overrides.axis !== "auto" || this.overrides.direction !== "auto" || this.overrides.algorithm !== "auto" || Object.keys(this.overrides.edges).length > 0;
    const inferredAlgorithm = resolveAlgorithm("auto", axisName !== null);
    const lit = new Set(this.hoveredPair?.pair ? [this.hoveredPair.pair.forward, this.hoveredPair.pair.backward] : []);
    const axis = axisStatus(axisName, this.candidates, this.edgeCounts, this.nodeCount);
    const axisCandidate = this.candidates.find((c) => c.name === axisName);
    const owner = axisCandidate?.pair ? "the earlier document" : "the owner (the document whose field names the other)";
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
            const count = this.edgeCounts[c.name];
            const member = c.kind === "frontmatter" && lit.has(c.name);
            return html`
              <tr class="cand ${armed ? "armed" : ""} ${c.pair ? "pair" : ""} ${member ? "member" : ""}" data-candidate=${c.name} @mouseenter=${() => this.hover(c)}>
                <td><span class="swatch" style="background:${relationColor(this.candidates, c.name)}"></span><span class="name ${edgeOverridden ? "overridden" : ""}" title=${edgeOverridden ? `overridden — inferred default was ${c.defaults.edge ? "drawn" : "not drawn"}` : c.pair ? `one sequence read from both ends: \`${c.pair.forward}\` edges as authored, \`${c.pair.backward}\` edges flipped, all pointing earlier → later (recognised by ${c.pair.by === "name" ? "name" : "reciprocal rows"})` : c.name}>${c.name}</span>
                  <span class="badge">${c.kind}</span>${c.pair ? html`<span class="members">= ${c.pair.forward} ∪ ${c.pair.backward}⁻¹</span>` : nothing}</td>
                <td>${c.sources.map((s) => html`<span class="badge ${s.replace(" ", "")}">${s}</span>`)}${c.nested
                  ? html`<span class="inside" data-nested title="mentioned inside a nested body — ${c.nested.label}; a relationship only a nested body names is listed, not drawn and never the axis">inside <code>${c.nested.label}</code></span>`
                  : nothing}</td>
                <td class="center">
                  <input type="checkbox" .checked=${drawn} title="draw ${c.name} as edges${count !== undefined ? ` (${count} among the shown documents)` : ""}"
                    @change=${(e: Event) => { this.overrides = withEdge(this.overrides, c.name, (e.target as HTMLInputElement).checked); }}>
                </td>
                <td class="center">
                  <input type="radio" name="axis" .checked=${axisName === c.name} title="lay the graph out along ${c.name}${count !== undefined ? ` (${count} edges here)` : ""}"
                    @change=${() => { this.overrides = withAxis(this.overrides, c.name); }}>
                </td>
                <td class="center">
                  ${ed?.writable
                    ? html`<input type="radio" name="armed" .checked=${armed}
                        title="arm ${c.name} for editing: select a node, then ⌘-click (Ctrl-click) another to toggle it; ${this.formTitle(c.name, ed)}"
                        @click=${() => this.arm(armed ? null : c.name)}>
                      ${armed ? html`<span class="form" data-form title=${this.formTitle(c.name, ed)}>writes ${describeForm(ed.form)}</span>` : nothing}`
                    : html`<span class="ro" title=${ed ? ed.reason : "read-only"}>read-only</span>`}
                </td>
              </tr>`;
          })}
          <tr class="no-axis">
            <td colspan="3" style="color:#7a8290" title="d3-force: every node repels every other, each drawn edge pulls its two ends together, cards keep apart by their size, and the cloud is kept in a box and fitted to the view; with nothing drawn the nodes only repel">no axis — force-directed (nodes repel, edges pull)</td>
            <td class="center"><input type="radio" name="axis" .checked=${axisName === null} title="no axis: force-directed layout"
              @change=${() => { this.overrides = withAxis(this.overrides, null); }}></td>
            <td></td>
          </tr>
        </tbody>
      </table>
      ${axis.empty ? html`<div class="note" data-axis-empty role="status">
        <span><code>${axisName}</code> has no edges here — nothing to order by.</span>
        ${axis.alternatives.map((a) => html`<button type="button" data-switch=${a.name} @click=${() => this.setAxis(a.name)}>lay out along <code>${a.name}</code> (${a.edges})</button>`)}
        <button type="button" data-switch="" @click=${() => this.setAxis(null)}>no axis (force)</button>
      </div>` : nothing}
      <div class="foot">
        <label title="how the nodes are placed. auto = layered along the axis, or force when there is none. Only layered needs the axis (and has a direction); stress, radial, tree and grid use every drawn relationship, with straight edges">layout
          <select data-algorithm @change=${(e: Event) => { this.setAlgorithm((e.target as HTMLSelectElement).value as LayoutAlgorithm | "auto"); }}>
            <option value="auto" ?selected=${this.overrides.algorithm === "auto"} title="the inferred layout">auto (${inferredAlgorithm})</option>
            ${LAYOUT_ALGORITHMS.map((a) => html`<option value=${a.value} ?selected=${this.overrides.algorithm === a.value} ?disabled=${a.value === "layered" && axisName === null} title=${a.hint}>${a.label}</option>`)}
          </select>
        </label>
        <label title="governs the axis's arrowheads and the layout flow alike: forward draws each edge from ${owner} to the document it names and lays the graph out that way (left → right); backward flips both. Layered layout only.">direction
          <select ?disabled=${view.layout.algorithm !== "layered"} .value=${view.layout.direction}
            @change=${(e: Event) => { this.overrides = withDirection(this.overrides, (e.target as HTMLSelectElement).value as Direction); }}>
            <option value="forward">forward (owner → referenced)</option>
            <option value="backward">backward (referenced → owner)</option>
          </select>
        </label>
        ${axisName !== null && this.edgeCounts[axisName] !== undefined ? html`<span class="count" data-axis-count>${this.edgeCounts[axisName]} axis edge${this.edgeCounts[axisName] === 1 ? "" : "s"}</span>` : nothing}
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
