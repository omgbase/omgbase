// The connector and the edge deletion, mapped onto `@omgbase/client`'s relation
// commands. Both gestures are `<omg-graph>`'s (`graph-connect`,
// `graph-connect-empty`, `graph-edge-delete`); what is this demo's own is HOW
// its drawn edges read as relations:
//
//   - a frontmatter candidate's edge is authored in that field of its source
//     (`provenance: frontmatter`, `field: <candidate name>`);
//   - a links / backlinks candidate's edge is a body link (`provenance: body`),
//     stored in the link row's source block (`GraphEdge.blockId`) — a backlinks
//     edge is the stored link FLIPPED, so the document holding it is `dst`;
//   - a pair's, a sequence's or a projected relationship's edge is DERIVED —
//     nothing authors it as such, so it offers no kind and cannot be severed.
//
// `connectorKinds` builds the picker's rows with the shared `relationKinds`:
// the frontmatter fields the drawn edges already use (by frequency, counted),
// then this query's other frontmatter relationships, then the source's own
// path-valued fields (one `docs_read`), then the body link. `detachFor` turns a
// drawn edge into the one `detachRelationCommand` input — or a refusal that says why.

import { fieldCounts, listPathFields, relationKinds, type EdgeProvenance, type RelationKind } from "@omgbase/client";
import type { RelationKindItem } from "@omgbase/elements";
import type { Candidate } from "./candidates.ts";
import type { GraphEdge } from "./edges.ts";

type CandidateLike = Pick<Candidate, "name" | "kind" | "pair" | "projected">;

/** Is this candidate an authored frontmatter field (not a pair, not projected by the query)? */
export function isFrontmatterField(c: CandidateLike): boolean {
  return c.kind === "frontmatter" && !c.pair && !c.projected;
}

/** A drawn edge as `relationKinds` reads it; null for a derived edge. */
export function edgeProvenance(edge: Pick<GraphEdge, "rel">, candidates: readonly CandidateLike[]): EdgeProvenance | null {
  const c = candidates.find((x) => x.name === edge.rel);
  if (!c || c.pair || c.projected || c.kind === "sequence") return null;
  if (c.kind === "frontmatter") return { provenance: "frontmatter", field: c.name };
  return { provenance: "body", field: null };
}

export function provenanceOf(edges: readonly Pick<GraphEdge, "rel">[], candidates: readonly CandidateLike[]): EdgeProvenance[] {
  return edges.map((e) => edgeProvenance(e, candidates)).filter((p): p is EdgeProvenance => p !== null);
}

/** The picker's rows for a connector from a document whose frontmatter is `frontmatter`. */
export function connectorKinds(edges: readonly Pick<GraphEdge, "rel">[], candidates: readonly CandidateLike[], frontmatter: Record<string, unknown> | null | undefined): RelationKindItem[] {
  const prov = provenanceOf(edges, candidates);
  const counts = fieldCounts(prov);
  const extra = [...candidates.filter(isFrontmatterField).map((c) => c.name), ...listPathFields(frontmatter)];
  return relationKinds(prov, extra).map((k): RelationKindItem =>
    k.kind === "frontmatter"
      ? { kind: "frontmatter", field: k.field, label: `add to \`${k.field}\``, ...(counts.has(k.field) ? { count: counts.get(k.field)! } : {}) }
      : { kind: "body-link", label: "a link in the body" });
}

/** The relationship a kind's new edge is drawn as: the field itself when the
 * query has it as a frontmatter candidate, the links candidate for a body link;
 * null when the query names no such relationship (the write lands, nothing is drawn). */
export function relationshipFor(how: RelationKind, candidates: readonly CandidateLike[]): string | null {
  if (how.kind === "frontmatter") return candidates.find((c) => isFrontmatterField(c) && c.name === how.field)?.name ?? null;
  return candidates.find((c) => c.kind === "links")?.name ?? null;
}

export interface Detach {
  /** The document holding the relation. */
  from: string;
  to: string;
  how: RelationKind;
  /** The body link's source block (null for a frontmatter field). */
  blockId: string | null;
}

/** The detach a drawn edge means, or why it cannot be severed from the graph. */
export function detachFor(edge: GraphEdge, candidates: readonly CandidateLike[]): Detach | { refused: string } {
  const c = candidates.find((x) => x.name === edge.rel);
  const arrow = `${edge.src} -[${edge.rel}]-> ${edge.dst}`;
  if (!c) return { refused: `${arrow}: \`${edge.rel}\` is not a relationship of this query` };
  if (c.projected) return { refused: `${arrow}: \`${edge.rel}\` is projected by the query — nothing is stored to remove` };
  if (c.pair) return { refused: `${arrow}: a \`${c.name}\` edge is one of two fields — remove it from \`${c.pair.forward}\` or \`${c.pair.backward}\` directly (draw that field and delete its edge)` };
  if (c.kind === "sequence") return { refused: `${arrow}: derived from order by \`${c.name}\`; nothing is stored` };
  if (c.kind === "frontmatter") return { from: edge.src, to: edge.dst, how: { kind: "frontmatter", field: c.name }, blockId: null };
  const blockId = edge.blockId ?? null;
  if (!blockId) return { refused: `${arrow}: the body link's block is unknown; it is not deletable from the graph — edit the document` };
  // A backlinks edge is the stored link flipped: the document that holds the link is the edge's `dst`.
  return c.kind === "backlinks"
    ? { from: edge.dst, to: edge.src, how: { kind: "body-link" }, blockId }
    : { from: edge.src, to: edge.dst, how: { kind: "body-link" }, blockId };
}
