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

  // `block.children` — the immediate child blocks of a block (blocks→blocks via
  // the `parent_block` FK the ingest tree-flattener populates). A clean
  // single-hop, type-preserving self-relation: the ready `follow` target for
  // recursing a block subtree (nested list items, quotes, sub-sections' content
  // blocks). Indexed by idx_blocks_doc(doc_id, parent_block, …).
  "block.children": {
    name: "block.children", from: "blocks", childTarget: "blocks",
    correlate: (o, i) => `${i}.parent_block = ${o}.block_id`,
    singleValued: false, sameDoc: true,
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
  // `section.children` — the IMMEDIATE child sections of this section (one
  // outline level down), as opposed to `section.subsections` which is the whole
  // transitive sub-tree. A section `i` is an immediate child of `o` iff it is
  // contained in `o`'s range, deeper than `o`, and no intervening section `m`
  // (deeper than `o`, shallower than `i`) also contains it — i.e. `o` is `i`'s
  // nearest enclosing section. This is the clean single-hop relation that gives
  // `follow section.children` a true outline depth ladder ($depth == outline
  // depth), where `follow section.subsections` would flatten every descendant to
  // depth 2. nodes→nodes.
  "section.children": {
    name: "section.children", from: "nodes", childTarget: "nodes",
    correlate: (o, i) =>
      `${i}.doc_id = ${o}.doc_id AND ${i}.kind = 'md:section' AND ${level(i)} > ${level(o)} ` +
      `AND ${first(i)} >= ${first(o)} AND ${last(i)} <= ${last(o)} ` +
      `AND NOT EXISTS (SELECT 1 FROM nodes m WHERE m.doc_id = ${o}.doc_id AND m.kind = 'md:section' ` +
      `AND ${level("m")} > ${level(o)} AND ${level("m")} < ${level(i)} ` +
      `AND ${first("m")} <= ${first(i)} AND ${last(i)} <= ${last("m")})`,
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

  // ---- graph edge relations (doc→doc via the authored edge graph) -----------
  // `doc.out` — documents this one links TO (an open authored edge from o to i);
  // `doc.in` — documents that link to this one (backlinks). Both are doc→doc and
  // type-preserving, so they are followable: `from docs where … follow doc.out`
  // walks the citation graph (which may CYCLE — the walk admits a revisit as a
  // `$stop == "cycle"` occurrence and does not re-expand it). Cross-document
  // (sameDoc: false): each reached doc is guarded on its own tombstone. The join
  // to `docs i` restricts successors to real documents (edges to phantom/external
  // nodes match no docs row, so they are naturally skipped). Any authored
  // predicate counts (predicate filtering is not exposed yet).
  "doc.out": {
    name: "doc.out", from: "docs", childTarget: "docs",
    correlate: (o, i) =>
      `EXISTS (SELECT 1 FROM edges e WHERE e.src_doc = ${o}.doc_id AND e.dst_node = ${i}.doc_id AND e.to_commit IS NULL)`,
    singleValued: false, sameDoc: false,
  },
  "doc.in": {
    name: "doc.in", from: "docs", childTarget: "docs",
    correlate: (o, i) =>
      `EXISTS (SELECT 1 FROM edges e WHERE e.src_doc = ${i}.doc_id AND e.dst_node = ${o}.doc_id AND e.to_commit IS NULL)`,
    singleValued: false, sameDoc: false,
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
