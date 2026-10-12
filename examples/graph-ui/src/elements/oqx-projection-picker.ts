// <oqx-projection-picker>: the projected fields (what the query's `select`
// puts on every row — lib/projection.ts reads them off the AST, or off the
// rows for an empty projection) with the two roles a field can play on a node
// card — `show` (a `key: value` line) and `label` (the card's title line;
// exactly one field, or the document path, which is always offered as the
// fallback row) — and the user's overrides. Emits the resolved choice.
//
//   properties: fields (ProjectedField[]), defaults (ProjectionChoice),
//               overrides (ProjectionOverrides)
//   events:     projection-change  detail: { label: string | null, shown: string[], overrides }
//               field-hover        detail: { field: ProjectedField | null }
//   methods:    reset()
//
// The label field is always shown (its checkbox is on and disabled): it IS the
// title line. Switching the label to another field keeps the old one shown as
// a line, so nothing vanishes from the card by surprise.

import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ProjectedField, ProjectionChoice } from "../lib/projection.ts";
import { NO_PROJECTION_OVERRIDES, resolveProjection, sameProjection, withLabel, withShown, type ProjectionOverrides } from "../lib/view.ts";

export interface ProjectionChangeDetail extends ProjectionChoice { overrides: ProjectionOverrides }
export interface FieldHoverDetail { field: ProjectedField | null }

const KIND_TITLE: Record<ProjectedField["kind"], string> = {
  intrinsic: "an engine attribute of the document (path, title, id, updated_at, …)",
  field: "a scalar: a frontmatter field, a navigation or an aliased expression",
  nested: "a nested block (collect / first / single) — rendered as a count",
  values: "`values` mode: the row is this single value",
};

@customElement("oqx-projection-picker")
export class OqxProjectionPicker extends LitElement {
  static override styles = css`
    :host { display: block; font: 13px/1.4 system-ui, sans-serif; color: #222; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e8eaef; white-space: nowrap; }
    th { font-weight: 600; color: #5a6270; font-size: 12px; }
    td.center, th.center { text-align: center; width: 56px; }
    tr.field:hover { background: #f4f6fa; }
    tr.label { background: #f7f9fc; }
    .name { font-family: ui-monospace, monospace; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 11px; background: #eef1f6; color: #4a5160; margin-left: 6px; cursor: help; }
    .badge.intrinsic { background: #e8f5e9; color: #1b5e20; }
    .badge.nested { background: #ede7f6; color: #4a148c; }
    .badge.values { background: #fff8e1; color: #8d6e00; }
    .badge.row { background: #e3f2fd; color: #0d47a1; }
    .badge.fallback { background: transparent; color: #7a8290; border: 1px dashed #c5cbd6; }
    .foot { display: flex; align-items: center; gap: 12px; padding: 6px 8px; color: #5a6270; }
    .foot button { font: inherit; }
    .empty { padding: 8px; color: #7a8290; }
    /* an overridden row: a cue that cannot move anything — the name's dotted underline and its title */
    .name.overridden { text-decoration: underline dotted #ad1457; text-underline-offset: 3px; cursor: help; }
    .muted { color: #7a8290; }
  `;

  @property({ attribute: false }) fields: ProjectedField[] = [];
  @property({ attribute: false }) defaults: ProjectionChoice = { label: null, shown: [] };
  @property({ attribute: false }) overrides: ProjectionOverrides = NO_PROJECTION_OVERRIDES;

  private last: ProjectionChoice | null = null;

  /** The resolved choice (defaults + overrides, vanished fields dropped). */
  get projection(): ProjectionChoice {
    return resolveProjection(this.fields, this.defaults, this.overrides);
  }

  reset(): void {
    this.overrides = NO_PROJECTION_OVERRIDES;
  }

  protected override updated(): void {
    const projection = this.projection;
    if (this.last && sameProjection(this.last, projection)) return;
    this.last = projection;
    this.dispatchEvent(new CustomEvent<ProjectionChangeDetail>("projection-change", {
      detail: { ...projection, overrides: this.overrides }, bubbles: true, composed: true,
    }));
  }

  private hover(field: ProjectedField | null): void {
    this.dispatchEvent(new CustomEvent<FieldHoverDetail>("field-hover", { detail: { field }, bubbles: true, composed: true }));
  }

  protected override render() {
    const p = this.projection;
    if (this.fields.length === 0) {
      return html`<div class="empty">No projected fields yet — list them in <code>select</code> (<code>select path, title, phase …</code>), or leave the projection empty to get every field of the returned rows once the query has run.</div>`;
    }
    const overridden = this.overrides.label !== "auto" || Object.keys(this.overrides.shown).length > 0;
    const fromRows = this.fields.every((f) => f.source === "row");
    return html`
      <table @mouseleave=${() => this.hover(null)}>
        <thead>
          <tr><th>field</th><th class="center">show</th><th class="center">label</th></tr>
        </thead>
        <tbody>
          ${this.fields.map((f) => {
            const isLabel = p.label === f.name;
            const shown = p.shown.includes(f.name);
            const defaultShown = this.defaults.shown.includes(f.name);
            const shownOverridden = !isLabel && f.name in this.overrides.shown && this.overrides.shown[f.name] !== defaultShown;
            const labelOverridden = this.overrides.label !== "auto" && isLabel !== (this.defaults.label === f.name);
            const overridden = shownOverridden || labelOverridden;
            const why = [
              shownOverridden ? `show: inferred default was ${defaultShown ? "on" : "off"}` : null,
              labelOverridden ? `label: inferred default was ${this.defaults.label ?? "the document path"}` : null,
            ].filter((x) => x !== null).join("; ");
            return html`
              <tr class="field ${isLabel ? "label" : ""}" data-field=${f.name} @mouseenter=${() => this.hover(f)}>
                <td><span class="name ${overridden ? "overridden" : ""}" title=${overridden ? `overridden — ${why}` : f.name}>${f.name}</span>
                  <span class="badge ${f.kind}" title=${KIND_TITLE[f.kind]}>${f.kind}</span>
                  ${f.source === "row" ? html`<span class="badge row" title="not in the query's select — read off the returned rows (empty projection)">from rows</span>` : nothing}</td>
                <td class="center">
                  <input type="checkbox" .checked=${shown} ?disabled=${isLabel}
                    title=${isLabel ? `${f.name} is the label — the card's title line` : `show ${f.name}: ${formatHint(f)} on every card`}
                    @change=${(e: Event) => { this.overrides = withShown(this.overrides, f.name, (e.target as HTMLInputElement).checked); }}>
                </td>
                <td class="center">
                  <input type="radio" name="label" .checked=${isLabel} title="use ${f.name} as the card's title line"
                    @change=${() => { this.overrides = withLabel(this.overrides, f.name); }}>
                </td>
              </tr>`;
          })}
          <tr class="field ${p.label === null ? "label" : ""}" data-field="">
            <td><span class="muted">document path</span><span class="badge fallback" title="the de-rooted path of the document; the label when no field is chosen or a document lacks the chosen one">fallback</span></td>
            <td class="center"><span class="muted" title="the path is the tooltip of every card">—</span></td>
            <td class="center">
              <input type="radio" name="label" .checked=${p.label === null} title="label the cards with the document path"
                @change=${() => { this.overrides = withLabel(this.overrides, null); }}>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="foot">
        <span>${p.shown.filter((s) => s !== p.label).length} line${p.shown.filter((s) => s !== p.label).length === 1 ? "" : "s"} under the label${fromRows ? " · fields read off the rows (empty projection)" : ""}</span>
        ${overridden
          ? html`<button @click=${() => this.reset()}>reset to inferred</button>`
          : html`<span>inferred</span>`}
      </div>
    `;
  }
}

function formatHint(f: ProjectedField): string {
  switch (f.kind) {
    case "nested": return "the number of items";
    case "values": return "the value";
    default: return "its value";
  }
}

declare global {
  interface HTMLElementTagNameMap { "oqx-projection-picker": OqxProjectionPicker }
}
