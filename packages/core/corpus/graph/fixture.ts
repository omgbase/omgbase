// Fixture bridge for spec/graph (README §7). Pure pieces, no vitest:
//
//   runCase()               §7: run an observation script (the spec/store §9.4 shape) through the
//                           production observe path, project the graph tables, run the §7 checks
//   projectGraph()          the §7 projection: `nodes`, `external_nodes`, `edges`, `doc_edges`
//   checkGraph()            the §7 runner checks: node_id derivation, commit references, open
//                           dst_node validity, doc_edges = a rollup recomputed from the open edges
//   deriveNodeId()          README §2.3 `n_` + first 12 hex of sha256(doc|block|kind|ordinal)
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//
// Nothing here decides anything about the graph; it drives the same code paths
// production uses (`observeBatch`, `sweepResurrectionPool`) with the fixture
// minter installed and re-expresses the resulting rows so the two
// implementations can be compared. The rollup check recomputes `doc_edges`
// from the `edges` table on its own — it does not call the reference's
// `rebuildDocEdges`.
import { createHash } from "node:crypto";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { sequentialMinter, withIdMinter } from "../../src/core/ids.js";
import { sweepResurrectionPool } from "../../src/core/store/gc.js";
import { observeBatch } from "../../src/sync/observe.js";
import { toReconcileConfig, deepEqualTol, type FixtureConfig } from "../reconcile/fixture.js";
import { FIXTURE_REPO_SLUG, validateSteps, type Step } from "../store/fixture.js";

export { deepEqualTol, FIXTURE_REPO_SLUG };
export type { Step };

// ---- fixture shapes ------------------------------------------------------------

/** README §2.3 as the fixture carries it: `attrs` decoded (compared as JSON). */
export interface NodeRow {
  node_id: string;
  doc_id: string;
  block_id: string | null;
  kind: string;
  name: string | null;
  value: string | null;
  span_start: number | null;
  span_end: number | null;
  attrs: Record<string, unknown>;
}

export interface ExternalNodeRow {
  node_id: string;
  uri: string;
  title: string | null;
}

/** Every `edges` column but `repo_id`. */
export interface EdgeRow {
  edge_id: string;
  src_doc: string;
  src_block: string | null;
  src_field: string | null;
  predicate: string;
  dst_kind: string;
  dst_node: string;
  anchor: string | null;
  provenance: string;
  via_node: string | null;
  from_commit: string;
  to_commit: string | null;
}

/** README §3.4 as the fixture carries it: `samples` decoded. */
export interface DocEdgeRow {
  src_doc: string;
  predicate: string;
  dst_node: string;
  dst_kind: string;
  count: number;
  samples: string[];
}

export interface Projection {
  nodes: NodeRow[];
  external_nodes: ExternalNodeRow[];
  edges: EdgeRow[];
  doc_edges: DocEdgeRow[];
}

/** The projected tables, in the order the fixture emits them (README §7). */
export const PROJECTED_TABLES = ["nodes", "external_nodes", "edges", "doc_edges"] as const;

export const NODE_FIELDS = ["node_id", "doc_id", "block_id", "kind", "name", "value", "span_start", "span_end", "attrs"] as const;
export const EXTERNAL_NODE_FIELDS = ["node_id", "uri", "title"] as const;
export const EDGE_FIELDS = [
  "edge_id", "src_doc", "src_block", "src_field", "predicate", "dst_kind", "dst_node", "anchor", "provenance", "via_node", "from_commit", "to_commit",
] as const;
export const DOC_EDGE_FIELDS = ["src_doc", "predicate", "dst_node", "dst_kind", "count", "samples"] as const;

export interface FixtureCase {
  name: string;
  notes?: string;
  /** optional spec/reconcile §6 overrides, as spec/store §9.4 */
  config?: FixtureConfig;
  steps: Step[];
  expect: Projection;
}

export interface FixtureFile {
  suite: string;
  cases: FixtureCase[];
}

export const CASE_KEYS = ["name", "notes", "config", "steps", "expect"] as const;

// ---- helpers ------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Bytewise (UTF-8) string order. */
export function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** README §2.3: `"n_" + first 12 hex of sha256(doc_id + "|" + block_id + "|" + kind + "|" + ordinal)`. */
export function deriveNodeId(docId: string, blockId: string, kind: string, ordinal: number): string {
  return "n_" + createHash("sha256").update(`${docId}|${blockId}|${kind}|${ordinal}`, "utf8").digest("hex").slice(0, 12);
}

// ---- projection (README §7) -----------------------------------------------------------

type Db = Store["db"];

interface StoredNode {
  node_id: string;
  doc_id: string;
  block_id: string | null;
  kind: string;
  name: string | null;
  value: string | null;
  span_start: number | null;
  span_end: number | null;
  attrs: string;
}

interface StoredDocEdge {
  src_doc: string;
  predicate: string;
  dst_node: string;
  dst_kind: string;
  count: number;
  samples: string;
}

/** The §7 projection of one repo's graph tables (`repo_id` omitted). */
export function projectGraph(db: Db, repoId: string): Projection {
  // `docs` order = path order, as spec/store §9.4 projects it; nodes follow it.
  const docIds = (db.prepare("SELECT doc_id FROM docs WHERE repo_id = ? ORDER BY path").all(repoId) as { doc_id: string }[]).map((d) => d.doc_id);
  const docRank = new Map(docIds.map((id, i) => [id, i] as const));
  const rankOf = (docId: string): number => docRank.get(docId) ?? Number.MAX_SAFE_INTEGER;

  const nodes = (db
    .prepare("SELECT node_id, doc_id, block_id, kind, name, value, span_start, span_end, attrs FROM nodes WHERE repo_id = ?")
    .all(repoId) as StoredNode[])
    .map((n): NodeRow => ({ ...n, attrs: JSON.parse(n.attrs) as Record<string, unknown> }))
    .sort((a, b) => rankOf(a.doc_id) - rankOf(b.doc_id) || cmpBytes(a.node_id, b.node_id));

  const external_nodes = (db
    .prepare("SELECT node_id, uri, title FROM external_nodes WHERE repo_id = ?")
    .all(repoId) as ExternalNodeRow[])
    .sort((a, b) => cmpBytes(a.uri, b.uri));

  const commitSeq = new Map(
    (db.prepare("SELECT commit_id, seq FROM commits WHERE repo_id = ?").all(repoId) as { commit_id: string; seq: number }[]).map((c) => [c.commit_id, c.seq] as const),
  );
  const seqOf = (commitId: string): number => commitSeq.get(commitId) ?? Number.MAX_SAFE_INTEGER;
  const edges = (db
    .prepare(`SELECT ${EDGE_FIELDS.join(", ")} FROM edges WHERE repo_id = ?`)
    .all(repoId) as EdgeRow[])
    .sort((a, b) => seqOf(a.from_commit) - seqOf(b.from_commit) || cmpBytes(a.edge_id, b.edge_id));

  // doc_edges has no repo_id; join through the source document.
  const doc_edges = (db
    .prepare(
      `SELECT de.src_doc, de.predicate, de.dst_node, de.dst_kind, de.count, de.samples
       FROM doc_edges de JOIN docs d ON d.doc_id = de.src_doc WHERE d.repo_id = ?`,
    )
    .all(repoId) as StoredDocEdge[])
    .map((r): DocEdgeRow => ({ ...r, samples: JSON.parse(r.samples) as string[] }))
    .sort(byDocEdgeKey);

  return { nodes, external_nodes, edges, doc_edges };
}

function byDocEdgeKey(a: DocEdgeRow, b: DocEdgeRow): number {
  return cmpBytes(a.src_doc, b.src_doc) || cmpBytes(a.predicate, b.predicate) || cmpBytes(a.dst_node, b.dst_node);
}

// ---- runner checks (README §7) --------------------------------------------------------

/**
 * README §7 "Runner checks" on a store after the last step:
 *
 *  - every `node_id` equals its §2.3 derivation — the projection is sorted by
 *    id, so per document and `(kind, block_id)` group of size n the ids must be
 *    exactly `{ derive(doc, block, kind, i) | 0 ≤ i < n }`;
 *  - every `edges.from_commit` / `to_commit` names an existing commit;
 *  - an open edge's `dst_node` is a live doc id, an `external_nodes` id, or
 *    `phantom:<path>` with no live doc at that path (`dst_kind` agrees);
 *  - `doc_edges` equals the §3.4 rollup recomputed here from the open edges
 *    (group by `(src_doc, predicate, dst_node, dst_kind)`, `count` = group size,
 *    `samples` = up to three non-null `src_block`s in edge `rowid` order),
 *    compared as a set.
 *
 * Returns the problems found (empty = fine).
 */
export function checkGraph(db: Db, repoId: string, projected: Projection): string[] {
  const problems: string[] = [];

  // ---- node ids -----------------------------------------------------------------
  const groups = new Map<string, NodeRow[]>();
  for (const n of projected.nodes) {
    const key = `${n.doc_id}|${n.block_id ?? ""}|${n.kind}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(n);
  }
  for (const [key, list] of groups) {
    const [docId, blockId, kind] = key.split("|") as [string, string, string];
    const have = list.map((n) => n.node_id).sort(cmpBytes);
    const want = list.map((_, i) => deriveNodeId(docId, blockId, kind, i)).sort(cmpBytes);
    if (have.join(",") !== want.join(",")) problems.push(`nodes ${docId}/${blockId}/${kind}: ids ${have.join(",")} != derived ${want.join(",")}`);
  }
  const seenNode = new Set<string>();
  for (const n of projected.nodes) {
    if (seenNode.has(n.node_id)) problems.push(`nodes: duplicate node_id ${n.node_id}`);
    seenNode.add(n.node_id);
    if ((n.span_start === null) !== (n.span_end === null)) problems.push(`node ${n.node_id}: half a span`);
    if (n.span_start !== null && n.span_end !== null && n.span_start > n.span_end) problems.push(`node ${n.node_id}: span_start > span_end`);
  }

  // ---- edges -------------------------------------------------------------------
  const commits = new Set((db.prepare("SELECT commit_id FROM commits WHERE repo_id = ?").all(repoId) as { commit_id: string }[]).map((c) => c.commit_id));
  const liveDocs = db.prepare("SELECT doc_id, path FROM docs WHERE repo_id = ? AND deleted_commit IS NULL").all(repoId) as { doc_id: string; path: string }[];
  const liveDocIds = new Set(liveDocs.map((d) => d.doc_id));
  const livePaths = new Set(liveDocs.map((d) => d.path));
  const externalIds = new Set(projected.external_nodes.map((x) => x.node_id));
  for (const e of projected.edges) {
    const at = `edge ${e.edge_id}`;
    if (!commits.has(e.from_commit)) problems.push(`${at}: from_commit ${e.from_commit} is not a commit`);
    if (e.to_commit !== null && !commits.has(e.to_commit)) problems.push(`${at}: to_commit ${e.to_commit} is not a commit`);
    if (e.to_commit !== null) continue;
    if (e.dst_kind === "external") {
      if (!externalIds.has(e.dst_node)) problems.push(`${at}: external dst_node ${e.dst_node} is not an external_nodes row`);
    } else if (e.dst_node.startsWith("phantom:")) {
      const path = e.dst_node.slice("phantom:".length);
      if (livePaths.has(path)) problems.push(`${at}: ${e.dst_node} but a live doc has path ${path}`);
    } else if (!liveDocIds.has(e.dst_node)) {
      // §3.6 / §8: an edge at a tombstoned document keeps its doc_id. Allow a
      // known (tombstoned) doc id; anything else is a dangling reference.
      const known = db.prepare("SELECT 1 FROM docs WHERE repo_id = ? AND doc_id = ?").get(repoId, e.dst_node);
      if (!known) problems.push(`${at}: dst_node ${e.dst_node} is neither a doc, an external node nor a phantom`);
    }
  }

  // ---- rollup ---------------------------------------------------------------------
  const openInRowid = db
    .prepare("SELECT src_doc, src_block, predicate, dst_node, dst_kind FROM edges WHERE repo_id = ? AND to_commit IS NULL ORDER BY rowid")
    .all(repoId) as { src_doc: string; src_block: string | null; predicate: string; dst_node: string; dst_kind: string }[];
  const rollup = new Map<string, DocEdgeRow>();
  for (const e of openInRowid) {
    const key = `${e.src_doc}|${e.predicate}|${e.dst_node}|${e.dst_kind}`;
    let row = rollup.get(key);
    if (!row) rollup.set(key, (row = { src_doc: e.src_doc, predicate: e.predicate, dst_node: e.dst_node, dst_kind: e.dst_kind, count: 0, samples: [] }));
    row.count += 1;
    if (e.src_block !== null && row.samples.length < 3) row.samples.push(e.src_block);
  }
  const want = [...rollup.values()].sort(byDocEdgeKey);
  const have = [...projected.doc_edges].sort(byDocEdgeKey);
  const diff = deepEqualTol(have, want, 0);
  if (diff !== null) problems.push(`doc_edges differ from a rollup recomputed over the open edges (${diff})`);

  return problems;
}

// ---- evaluation ----------------------------------------------------------------------

export type FixtureCaseInput = Omit<FixtureCase, "expect">;

export interface Evaluation {
  expect: Projection;
  /** §7 runner-check problems (empty = fine). */
  problems: string[];
}

/**
 * Run a case: fresh `:memory:` store under the fixture minter (repo `rp_0`,
 * slug `fixture`), every step through the production paths (`observeBatch`
 * for `observe`, `sweepResurrectionPool` for `sweep`), then the §7 projection
 * and checks after the last step.
 */
export function runCase(c: FixtureCaseInput): Evaluation {
  const config = toReconcileConfig(c.config);
  return withIdMinter(sequentialMinter(), () => {
    const store = new Store({ path: ":memory:" });
    try {
      const repoId = ensureRepo(store, FIXTURE_REPO_SLUG, null);
      for (const step of c.steps) {
        if ("observe" in step) {
          const items = step.observe.items.map((it) => ({ path: it.path, content: it.source }));
          observeBatch(store, repoId, items, step.observe.ts, { config });
        } else {
          sweepResurrectionPool(store, step.sweep.ts);
        }
      }
      const projected = projectGraph(store.db, repoId);
      return { expect: projected, problems: checkGraph(store.db, repoId, projected) };
    } finally {
      store.close();
    }
  });
}

// ---- validation ------------------------------------------------------------------------

export interface ValidateOptions {
  /** false while regenerating: cases may not have an `expect` yet */
  requireExpect?: boolean;
}

function checkFields(at: string, r: unknown, fields: readonly string[], problems: string[]): r is Record<string, unknown> {
  if (!isRecord(r)) {
    problems.push(`${at}: not an object`);
    return false;
  }
  const keys = Object.keys(r).sort();
  const want = [...fields].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    problems.push(`${at}: a row has exactly the fields ${fields.join(", ")} (got ${keys.join(", ")})`);
    return false;
  }
  return true;
}

const optStr = (v: unknown): boolean => v === null || typeof v === "string";
const optInt = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);

function validateExpect(at: string, e: unknown, problems: string[]): void {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return;
  }
  const keys = Object.keys(e).sort();
  const want = [...PROJECTED_TABLES].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    problems.push(`${at}: must have exactly the keys ${PROJECTED_TABLES.join(", ")} (got ${keys.join(", ")})`);
    return;
  }
  for (const k of PROJECTED_TABLES) if (!Array.isArray(e[k])) problems.push(`${at}.${k}: must be an array`);
  if (Array.isArray(e.nodes)) {
    e.nodes.forEach((r, i) => {
      const here = `${at}.nodes[${i}]`;
      if (!checkFields(here, r, NODE_FIELDS, problems)) return;
      if (typeof r.node_id !== "string" || !/^n_[0-9a-f]{12}$/.test(r.node_id)) problems.push(`${here}: node_id must be n_ + 12 hex`);
      if (typeof r.doc_id !== "string" || typeof r.kind !== "string") problems.push(`${here}: doc_id and kind must be strings`);
      if (!optStr(r.block_id) || !optStr(r.name) || !optStr(r.value)) problems.push(`${here}: block_id, name, value must be strings or null`);
      if (!optInt(r.span_start) || !optInt(r.span_end)) problems.push(`${here}: span_start/span_end must be non-negative integers or null`);
      if (!isRecord(r.attrs)) problems.push(`${here}: attrs must be an object`);
    });
  }
  if (Array.isArray(e.external_nodes)) {
    e.external_nodes.forEach((r, i) => {
      const here = `${at}.external_nodes[${i}]`;
      if (!checkFields(here, r, EXTERNAL_NODE_FIELDS, problems)) return;
      if (typeof r.node_id !== "string" || typeof r.uri !== "string" || !optStr(r.title)) problems.push(`${here}: node_id and uri are strings, title a string or null`);
    });
  }
  if (Array.isArray(e.edges)) {
    e.edges.forEach((r, i) => {
      const here = `${at}.edges[${i}]`;
      if (!checkFields(here, r, EDGE_FIELDS, problems)) return;
      for (const k of ["edge_id", "src_doc", "predicate", "dst_kind", "dst_node", "provenance", "from_commit"]) {
        if (typeof r[k] !== "string") problems.push(`${here}: ${k} must be a string`);
      }
      for (const k of ["src_block", "src_field", "anchor", "via_node", "to_commit"]) {
        if (!optStr(r[k])) problems.push(`${here}: ${k} must be a string or null`);
      }
    });
  }
  if (Array.isArray(e.doc_edges)) {
    e.doc_edges.forEach((r, i) => {
      const here = `${at}.doc_edges[${i}]`;
      if (!checkFields(here, r, DOC_EDGE_FIELDS, problems)) return;
      for (const k of ["src_doc", "predicate", "dst_node", "dst_kind"]) if (typeof r[k] !== "string") problems.push(`${here}: ${k} must be a string`);
      if (typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 1) problems.push(`${here}: count must be a positive integer`);
      if (!Array.isArray(r.samples) || r.samples.length > 3 || !r.samples.every((s) => typeof s === "string")) problems.push(`${here}: samples must be up to three block ids`);
    });
  }
}

/**
 * Validate a parsed `cases/<suite>.json`; returns the problems found (empty = valid).
 * `file` is the file name (with `.json`); the suite must equal its stem.
 */
export function validateFixtureFile(file: string, doc: unknown, opts: ValidateOptions = {}): string[] {
  const requireExpect = opts.requireExpect ?? true;
  const problems: string[] = [];
  if (!isRecord(doc)) return [`${file}: not an object`];
  const stem = file.replace(/\.json$/, "");
  if (doc.suite !== stem) problems.push(`${file}: \`suite\` must equal the file stem '${stem}' (got ${JSON.stringify(doc.suite)})`);
  const extra = Object.keys(doc).filter((k) => !["suite", "cases"].includes(k));
  if (extra.length > 0) problems.push(`${file}: unknown top-level keys ${extra.join(", ")}`);
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) return [...problems, `${file}: \`cases\` must be a non-empty array`];

  const seen = new Set<string>();
  doc.cases.forEach((c: unknown, i: number) => {
    const at = `${file}#${i}`;
    if (!isRecord(c)) {
      problems.push(`${at}: not an object`);
      return;
    }
    const unknown = Object.keys(c).filter((k) => !(CASE_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) problems.push(`${at}: unknown case keys ${unknown.join(", ")}`);
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name '${c.name}'`);
    else seen.add(c.name);
    if (c.notes !== undefined && typeof c.notes !== "string") problems.push(`${at}: \`notes\` must be a string`);
    if (c.config !== undefined && !isRecord(c.config)) problems.push(`${at}: \`config\` must be an object`);
    validateSteps(at, c.steps, problems);
    if (c.expect === undefined) {
      if (requireExpect) problems.push(`${at}: missing \`expect\` (run GRAPH_SPEC_UPDATE=1)`);
      return;
    }
    validateExpect(`${at}.expect`, c.expect, problems);
  });
  return problems;
}
