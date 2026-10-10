// The view record: which relationships draw edges, which one lays the graph
// out, and which projected fields the node cards show. Defaults come from the
// candidates (candidates.ts) and the projection (projection.ts); the user's
// overrides are kept separately so a re-run of the query that changes the
// candidate or field set keeps the choices that still apply and drops the ones
// that no longer do. A saved view is `{ query, edges, layout, projection }`.

import type { Candidate, Direction } from "./candidates.ts";
import type { ProjectedField, ProjectionChoice } from "./projection.ts";

export interface View {
  /** Candidate names drawn as edges, in candidate order. */
  edges: string[];
  layout: {
    /** The candidate laying the graph out, or null for a force layout. */
    axis: string | null;
    direction: Direction;
  };
  /** What the node cards show: the label field (null = the document path) and the shown fields, in projection order. */
  projection: ProjectionChoice;
}

export interface Overrides {
  /** Per-name edge toggles; absent = the candidate's default. */
  edges: Record<string, boolean>;
  /** `"auto"` = the inferred axis; a name or null (= force) pins it. */
  axis: string | null | "auto";
  /** `"auto"` = the axis candidate's inferred direction. */
  direction: Direction | "auto";
}

export const NO_OVERRIDES: Overrides = { edges: {}, axis: "auto", direction: "auto" };

/** The projection's overrides, kept apart from the inferred defaults the same way. */
export interface ProjectionOverrides {
  /** `"auto"` = the inferred label; a field name pins it; null = the document path. */
  label: string | null | "auto";
  /** Per-field show toggles; absent = the default. */
  shown: Record<string, boolean>;
}

export const NO_PROJECTION_OVERRIDES: ProjectionOverrides = { label: "auto", shown: {} };
/** A projection with no fields: the path labels the card and nothing else is shown. */
export const NO_PROJECTION: ProjectionChoice = { label: null, shown: [] };

export function defaultView(candidates: readonly Candidate[], projection: ProjectionChoice = NO_PROJECTION): View {
  return resolveView(candidates, NO_OVERRIDES, projection);
}

/** Overrides naming a candidate that no longer exists are ignored (not an error). */
export function resolveView(candidates: readonly Candidate[], overrides: Overrides, projection: ProjectionChoice = NO_PROJECTION): View {
  const edges = candidates.filter((c) => overrides.edges[c.name] ?? c.defaults.edge).map((c) => c.name);
  let axisCandidate: Candidate | undefined;
  if (overrides.axis === "auto") axisCandidate = candidates.find((c) => c.defaults.layout);
  else if (overrides.axis !== null) axisCandidate = candidates.find((c) => c.name === overrides.axis);
  // A pinned axis that vanished falls back to the inferred one rather than to force.
  if (overrides.axis !== null && overrides.axis !== "auto" && !axisCandidate) {
    axisCandidate = candidates.find((c) => c.defaults.layout);
  }
  const direction: Direction =
    overrides.direction === "auto" ? (axisCandidate?.defaults.direction ?? "forward") : overrides.direction;
  return { edges, layout: { axis: axisCandidate?.name ?? null, direction }, projection };
}

/** The projection choice from the fields, their defaults and the overrides.
 * Overrides naming a field that is no longer projected are dropped; a pinned
 * label that vanished falls back to the inferred one. The label field is
 * always among the shown fields (it is the title line), in projection order. */
export function resolveProjection(fields: readonly ProjectedField[], defaults: ProjectionChoice, overrides: ProjectionOverrides): ProjectionChoice {
  const has = (name: string | null): name is string => name !== null && fields.some((f) => f.name === name);
  let label: string | null;
  if (overrides.label === "auto") label = has(defaults.label) ? defaults.label : null;
  else if (overrides.label === null) label = null;
  else label = has(overrides.label) ? overrides.label : (has(defaults.label) ? defaults.label : null);
  const shown = fields
    .filter((f) => f.name === label || (overrides.shown[f.name] ?? defaults.shown.includes(f.name)))
    .map((f) => f.name);
  return { label, shown };
}

export function withShown(o: ProjectionOverrides, name: string, on: boolean): ProjectionOverrides {
  return { ...o, shown: { ...o.shown, [name]: on } };
}

export function withLabel(o: ProjectionOverrides, label: string | null | "auto"): ProjectionOverrides {
  return { ...o, label };
}

export function sameProjection(a: ProjectionChoice, b: ProjectionChoice): boolean {
  return a.label === b.label && a.shown.length === b.shown.length && a.shown.every((s, i) => s === b.shown[i]);
}

export function withEdge(o: Overrides, name: string, on: boolean): Overrides {
  return { ...o, edges: { ...o.edges, [name]: on } };
}

export function withAxis(o: Overrides, axis: string | null | "auto"): Overrides {
  // Changing the axis resets a pinned direction: the new axis's own default applies.
  return { ...o, axis, direction: "auto" };
}

export function withDirection(o: Overrides, direction: Direction | "auto"): Overrides {
  return { ...o, direction };
}

export function sameView(a: View, b: View): boolean {
  return a.edges.length === b.edges.length && a.edges.every((e, i) => e === b.edges[i])
    && a.layout.axis === b.layout.axis && a.layout.direction === b.layout.direction
    && sameProjection(a.projection, b.projection);
}
