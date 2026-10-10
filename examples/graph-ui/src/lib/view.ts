// The view record: which relationships draw edges and which one lays the graph
// out. Defaults come from the candidates (candidates.ts); the user's overrides
// are kept separately so a re-run of the query that changes the candidate set
// keeps the choices that still apply and drops the ones that no longer do.

import type { Candidate, Direction } from "./candidates.ts";

export interface View {
  /** Candidate names drawn as edges, in candidate order. */
  edges: string[];
  layout: {
    /** The candidate laying the graph out, or null for a force layout. */
    axis: string | null;
    direction: Direction;
  };
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

export function defaultView(candidates: readonly Candidate[]): View {
  return resolveView(candidates, NO_OVERRIDES);
}

/** Overrides naming a candidate that no longer exists are ignored (not an error). */
export function resolveView(candidates: readonly Candidate[], overrides: Overrides): View {
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
  return { edges, layout: { axis: axisCandidate?.name ?? null, direction } };
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
    && a.layout.axis === b.layout.axis && a.layout.direction === b.layout.direction;
}
