// Canonical structural relations (slice 2). Graph relations (out/in/traverse)
// are deferred. Each relation is one hop from a known target; `correlate(outer,
// inner)` builds the join predicate joining the nested (inner) scope to the
// current (outer) row, given the SQL aliases the compiler assigned to each. The
// slice-1 relations are single foreign-key equijoins; the section relations use
// ordinal-range containment over the derived `md:section` nodes' `first_ordinal`
// /`last_ordinal` attrs (the outline tree that already exists latently in the
// `sections` table — see the md-section-nodes design note).

import type { CelTarget, Relation } from "./ir.js";
import { topOrdinal } from "../search/cel/compile.js";

interface RelationDef extends Relation {
  /** the outer target this relation may be walked FROM. Ignored for root
   * relations, which are reachable from any scope. */
  from: CelTarget;
  /** true for single-valued relations (node.doc, node.block). */
  singleValued: boolean;
  /** when set, the relation is not usable yet — the reason is reported to the
   * caller as filter_invalid rather than silently returning no rows. */
  unavailable?: string;
}

// json_extract of a section node's range/level attr (populated by the md:section
// projection in core/ingest).
const first = (a: string): string => `json_extract(${a}.attrs, '$.first_ordinal')`;
const last = (a: string): string => `json_extract(${a}.attrs, '$.last_ordinal')`;
const level = (a: string): string => `json_extract(${a}.attrs, '$.level')`;

// Keyed by "<surfaceReceiver>.<relation>". The receiver token in source (doc /
// block / node / nodes / blocks / section) resolves to one of these by the
// enclosing scope's target — see lower.ts.
export const RELATIONS: Record<string, RelationDef> = {
  "doc.nodes": {
    name: "doc.nodes", from: "docs", childTarget: "nodes",
    correlate: (o, i) => `${i}.doc_id = ${o}.doc_id`,
    singleValued: false, sameDoc: true,
  },
  "doc.blocks": {
    name: "doc.blocks", from: "docs", childTarget: "blocks",
    correlate: (o, i) => `${i}.doc_id = ${o}.doc_id`,
    singleValued: false, sameDoc: true,
  },
  // block.nodes is modeled but NOT usable: no format adapter populates a real
  // `b_` block id on projected nodes (projectNodes receives RawBlocks, whose ids
  // are not minted yet), so `nodes.block_id` is universally NULL and this
  // relation would match nothing. Failing loudly beats a silent empty result.
  "block.nodes": {
    name: "block.nodes", from: "blocks", childTarget: "nodes",
    correlate: (o, i) => `${i}.block_id = ${o}.block_id`,
    singleValued: false, sameDoc: true,
    unavailable:
      "node→block anchoring is not populated yet (nodes.block_id is always NULL), so this relation cannot match. Query `from nodes` with doc.* reach-through instead.",
  },
  "node.doc": {
    name: "node.doc", from: "nodes", childTarget: "docs",
    correlate: (o, i) => `${i}.doc_id = ${o}.doc_id`,
    singleValued: true, sameDoc: true,
  },
  "node.block": {
    name: "node.block", from: "nodes", childTarget: "blocks",
    correlate: (o, i) => `${i}.block_id = ${o}.block_id`,
    singleValued: true, sameDoc: true,
  },

  // ---- section relations (md:section nodes; range/level containment) --------
  // `section.blocks` — the content blocks under a section node, transitively
  // including deeper headings (the range spans them). Reaches nodes→blocks.
  "section.blocks": {
    name: "section.blocks", from: "nodes", childTarget: "blocks",
    correlate: (o, i) =>
      `${i}.doc_id = ${o}.doc_id AND ${topOrdinal(i)} >= ${first(o)} AND ${topOrdinal(i)} <= ${last(o)}`,
    singleValued: false, sameDoc: true,
  },
  // `section.subsections` — section nodes strictly contained in this one (the
  // outline sub-tree). nodes→nodes: relies on alias-parameterization.
  "section.subsections": {
    name: "section.subsections", from: "nodes", childTarget: "nodes",
    correlate: (o, i) =>
      `${i}.doc_id = ${o}.doc_id AND ${i}.kind = 'md:section' AND ${first(i)} >= ${first(o)} AND ${last(i)} <= ${last(o)} AND ${level(i)} > ${level(o)}`,
    singleValued: false, sameDoc: true,
  },
  // `block.section` — the section node(s) whose range contains this block (all
  // enclosing sections, outermost to innermost). Reaches blocks→nodes.
  "block.section": {
    name: "block.section", from: "blocks", childTarget: "nodes",
    correlate: (o, i) =>
      `${i}.doc_id = ${o}.doc_id AND ${i}.kind = 'md:section' AND ${topOrdinal(o)} >= ${first(i)} AND ${topOrdinal(o)} <= ${last(i)}`,
    singleValued: false, sameDoc: true,
  },

  // ---- root/global relations (repo.<target>) --------------------------------
  // An explicit unbounded scan of the whole repository, reachable from any
  // scope. There is NO structural correlation to the outer row (correlate() is
  // the constant `1`); correlation is expressed by `^name` outer references in
  // the where. `sameDoc: false` — the child gets its own document scope (the
  // compiler joins a distinct `docs` alias), so `$path` / `doc.*` inside resolve
  // against the CHILD row's document, not the outer one. This is the join
  // escape hatch (semi/anti/lateral joins) the correlated-subqueries design
  // note calls for; keeping it explicit keeps accidental global scans visible.
  "repo.docs": {
    name: "repo.docs", from: "docs", childTarget: "docs",
    correlate: () => "1", singleValued: false, sameDoc: false, root: true,
  },
  "repo.blocks": {
    name: "repo.blocks", from: "blocks", childTarget: "blocks",
    correlate: () => "1", singleValued: false, sameDoc: false, root: true,
  },
  "repo.nodes": {
    name: "repo.nodes", from: "nodes", childTarget: "nodes",
    correlate: () => "1", singleValued: false, sameDoc: false, root: true,
  },
};

export type { RelationDef };
