// A store-backed DataContext (oqx-js tier 2): binds `@omgbase/oqx`'s query
// semantics to omgbase's SQLite store, so the InMemoryEngine reproduces the whole
// OQX surface (targets, intrinsics, reach-through, structural relations, the edge
// graph, follow, correlation, lifts) without a bespoke compiler. Rows are the
// store's raw column objects, tagged with their target; `get` routes field /
// intrinsic / relation resolution per target, lazily querying the store for
// relations. Domain functions (text/semantic/under_*/…) are row-scoped, so they
// arrive via `callMethod` on a synthetic `$self` receiver (see run.ts's AST
// rewrite) rather than as free functions (which see no row).
//
// This is the correctness tier: N+1 queries, materialized collections — fine for
// the corpus and the differential baseline. The tier-3 SQLite planner (planner.ts)
// pushes the hot predicates down; both must agree (conformance suite).

import type { DataContext, CallResult } from "@omgbase/oqx";
import { semantics } from "@omgbase/oqx";
import type { Store } from "../core/store/store.js";
import { docsRead } from "../core/read/document.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { sanitizeFtsQuery } from "../search/fts-query.js";
import { cosineBytes } from "../core/vec.js";
import type { SemanticVec } from "../search/cel/compile.js";

export type Target = "docs" | "blocks" | "nodes" | "edges";

const TARGET = Symbol("oqx.target");
type Row = Record<string, unknown> & { [TARGET]?: Target };
const REPO_ROOT = Symbol("oqx.repoRoot");
const PROP_SOURCE = Symbol("oqx.propSource");

interface RepoRoot { [REPO_ROOT]: true }
interface PropSourceRef { [PROP_SOURCE]: true; docId: string; source: string }

function tag(row: Record<string, unknown> | undefined, t: Target): Row | undefined {
  if (!row) return undefined;
  (row as Row)[TARGET] = t;
  return row as Row;
}
function tagAll(rows: Record<string, unknown>[], t: Target): Row[] {
  for (const r of rows) (r as Row)[TARGET] = t;
  return rows as Row[];
}

// docs intrinsics whose BARE (non-$) form is almost always a typo (10 §2); a bare
// read of one is a loud error, matching the CEL guard.
// (`repo` is intentionally excluded: `repo.docs`/`repo.nodes`/… is the root-scan
// receiver, so a bare `repo` must climb to the repo root, not fault as a field.)
const RESERVED_DOC_BASENAMES = new Set(["id", "path", "updated_at", "content_hash", "body"]);

export interface StoreContextOptions {
  /** Pre-computed query vectors for `semantic("phrase")`, keyed by phrase (the
   * async runner fills this; the sync path leaves it empty and a semantic() with
   * no entry is a loud error). */
  semanticVectors?: Map<string, SemanticVec>;
  /** Rows a tier-3 plan produced, bound to the residual query's synthetic
   * `ROWS_ROOT` source (planner.ts). The rows are already target-tagged store
   * rows, so `get`/relations/domain-fns resolve against them unchanged. */
  rowsRoot?: { name: string; rows: unknown[] };
}

export function makeStoreContext(store: Store, repoId: string, opts: StoreContextOptions = {}): DataContext {
  const db = store.db;
  const sv = opts.semanticVectors;

  const all = (sql: string, ...params: unknown[]): Record<string, unknown>[] =>
    db.prepare(sql).all(...params) as Record<string, unknown>[];
  const one = (sql: string, ...params: unknown[]): Record<string, unknown> | undefined =>
    db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  const scalar = (sql: string, ...params: unknown[]): unknown => {
    const r = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return Object.values(r)[0];
  };

  // ---- root collections (ordered for a stable (path, id) default) -----------
  const docsRoot = (): Row[] =>
    tagAll(all(`SELECT * FROM docs WHERE repo_id = ? AND deleted_commit IS NULL ORDER BY path, doc_id`, repoId), "docs");
  const blocksRoot = (): Row[] =>
    tagAll(all(
      `SELECT b.*, d.path AS __path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id
       WHERE b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL
       ORDER BY d.path, b.block_id`, repoId), "blocks");
  const nodesRoot = (): Row[] =>
    tagAll(all(
      `SELECT n.*, d.path AS __path FROM nodes n JOIN docs d ON d.doc_id = n.doc_id
       WHERE n.repo_id = ? AND d.deleted_commit IS NULL ORDER BY d.path, n.node_id`, repoId), "nodes");
  const edgesRoot = (): Row[] =>
    tagAll(all(
      `SELECT e.*, d.path AS __path FROM edges e JOIN docs d ON d.doc_id = e.src_doc
       WHERE e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL
       ORDER BY d.path, e.edge_id`, repoId), "edges");

  const rootFns: Record<string, () => Row[]> = { docs: docsRoot, blocks: blocksRoot, nodes: nodesRoot, edges: edgesRoot };

  // ---- attrs / property decoding --------------------------------------------
  const parseJson = (v: unknown): unknown => {
    if (typeof v !== "string") return v ?? undefined;
    try { return JSON.parse(v); } catch { return v; }
  };
  const decodeProp = (r: Record<string, unknown>): unknown => {
    switch (r.type) {
      case "number": return r.val_num;
      case "bool": return r.val_bool ? true : false;
      case "null": return null;
      case "json": return parseJson(r.val_json);
      default: return r.val_text;
    }
  };
  // A docs property key resolves to a scalar iff it has exactly one row in scope
  // AND that row is card='scalar'; otherwise to the array of values (list-authored,
  // repeated, or frontmatter+inline collision) — reproducing the CEL scalar-vs-list
  // rule so `==` sees a scalar only when authored scalar, and `list()` sees all.
  const docProp = (docId: string, key: string, source?: string): unknown => {
    const rows = source
      ? all(`SELECT * FROM properties WHERE doc_id = ? AND key = ? AND source = ? AND deleted_commit IS NULL ORDER BY ord`, docId, key, source)
      : all(`SELECT * FROM properties WHERE doc_id = ? AND key = ? AND deleted_commit IS NULL ORDER BY ord`, docId, key);
    if (rows.length === 0) {
      // No exact key: omgbase flattens nested YAML/JSON maps to dotted keys
      // (`logging.level`), so a bare `logging` should reconstruct the nested
      // object for `.level` member navigation.
      return docPropObject(docId, key, source);
    }
    if (rows.length === 1 && rows[0]!.card === "scalar") return decodeProp(rows[0]!);
    return rows.map(decodeProp);
  };
  // Reconstruct a nested object from flattened dotted keys under `prefix.`
  // (undefined when there are none). Leaves are decoded property values.
  const docPropObject = (docId: string, prefix: string, source?: string): unknown => {
    const rows = source
      ? all(`SELECT * FROM properties WHERE doc_id = ? AND key LIKE ? AND source = ? AND deleted_commit IS NULL ORDER BY ord`, docId, `${prefix}.%`, source)
      : all(`SELECT * FROM properties WHERE doc_id = ? AND key LIKE ? AND deleted_commit IS NULL ORDER BY ord`, docId, `${prefix}.%`);
    if (rows.length === 0) return undefined;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      const rest = String(r.key).slice(prefix.length + 1).split(".");
      let cur = out;
      for (let i = 0; i < rest.length - 1; i++) {
        const seg = rest[i]!;
        if (typeof cur[seg] !== "object" || cur[seg] == null) cur[seg] = {};
        cur = cur[seg] as Record<string, unknown>;
      }
      cur[rest[rest.length - 1]!] = decodeProp(r);
    }
    return out;
  };
  const docPropExists = (docId: string, key: string, source?: string): boolean =>
    !!one(source
      ? `SELECT 1 FROM properties WHERE doc_id = ? AND key = ? AND source = ? AND deleted_commit IS NULL LIMIT 1`
      : `SELECT 1 FROM properties WHERE doc_id = ? AND key = ? AND deleted_commit IS NULL LIMIT 1`,
      ...(source ? [docId, key, source] : [docId, key]));

  // ---- top-ordinal of a block's top-level ancestor (for section ranges) -----
  const topOrdinal = (block: Row): number => {
    if (block.parent_block == null) return block.ordinal as number;
    // ancestor_path is '/b_x/b_y/…'; first segment is the top-level ancestor.
    const ap = String(block.ancestor_path);
    const first = ap.split("/").filter(Boolean)[0];
    if (!first) return block.ordinal as number;
    const r = one(`SELECT ordinal FROM blocks WHERE doc_id = ? AND block_id = ?`, block.doc_id, first);
    return (r?.ordinal as number) ?? (block.ordinal as number);
  };

  // ---- relations (return row arrays) ----------------------------------------
  const rel: Record<Target, Record<string, (row: Row) => Row[] | Row | undefined>> = {
    docs: {
      nodes: (r) => tagAll(all(`SELECT n.*, ? AS __path FROM nodes n WHERE n.doc_id = ?`, r.path, r.doc_id), "nodes"),
      blocks: (r) => tagAll(all(`SELECT b.*, ? AS __path FROM blocks b WHERE b.doc_id = ? AND b.deleted_commit IS NULL ORDER BY b.ordinal, b.block_id`, r.path, r.doc_id), "blocks"),
      out: (r) => tagAll(all(
        `SELECT DISTINCT d2.* FROM docs d2 JOIN edges e ON e.dst_node = d2.doc_id
         WHERE e.src_doc = ? AND e.to_commit IS NULL AND d2.repo_id = ? AND d2.deleted_commit IS NULL ORDER BY d2.path, d2.doc_id`, r.doc_id, repoId), "docs"),
      in: (r) => tagAll(all(
        `SELECT DISTINCT d2.* FROM docs d2 JOIN edges e ON e.src_doc = d2.doc_id
         WHERE e.dst_node = ? AND e.to_commit IS NULL AND d2.repo_id = ? AND d2.deleted_commit IS NULL ORDER BY d2.path, d2.doc_id`, r.doc_id, repoId), "docs"),
      out_edges: (r) => tagAll(all(`SELECT e.*, ? AS __path FROM edges e WHERE e.src_doc = ? AND e.to_commit IS NULL ORDER BY e.predicate, e.edge_id`, r.path, r.doc_id), "edges"),
      in_edges: (r) => tagAll(all(
        `SELECT e.*, d.path AS __path FROM edges e JOIN docs d ON d.doc_id = e.src_doc
         WHERE e.dst_node = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL ORDER BY e.predicate, e.edge_id`, r.doc_id), "edges"),
    },
    blocks: {
      children: (r) => tagAll(all(`SELECT b.*, ? AS __path FROM blocks b WHERE b.parent_block = ? AND b.deleted_commit IS NULL ORDER BY b.ordinal, b.block_id`, r.__path, r.block_id), "blocks"),
      nodes: (r) => tagAll(all(`SELECT n.*, ? AS __path FROM nodes n WHERE n.block_id = ?`, r.__path, r.block_id), "nodes"),
      out_edges: (r) => tagAll(all(`SELECT e.*, ? AS __path FROM edges e WHERE e.src_block = ? AND e.to_commit IS NULL ORDER BY e.predicate, e.edge_id`, r.__path, r.block_id), "edges"),
      // enclosing section node(s): md:section whose range contains this block's top ordinal.
      section: (r) => {
        const top = topOrdinal(r);
        return tagAll(all(
          `SELECT n.*, ? AS __path FROM nodes n WHERE n.doc_id = ? AND n.kind = 'md:section'
             AND json_extract(n.attrs,'$.first_ordinal') <= ? AND json_extract(n.attrs,'$.last_ordinal') >= ?
           ORDER BY json_extract(n.attrs,'$.first_ordinal'), n.node_id`, r.__path, r.doc_id, top, top), "nodes");
      },
    },
    nodes: {
      // section.* — the node interpreted as a section (range attrs).
      blocks: (r) => {
        const f = jattr(r, "first_ordinal"), l = jattr(r, "last_ordinal");
        if (f == null || l == null) return [];
        // blocks whose top-level ordinal falls in the section range.
        const rows = all(`SELECT b.*, ? AS __path FROM blocks b WHERE b.doc_id = ? AND b.deleted_commit IS NULL ORDER BY b.ordinal, b.block_id`, r.__path, r.doc_id);
        const kept = (rows as Row[]).filter((b) => { const t = topOrdinal(b); return t >= (f as number) && t <= (l as number); });
        return tagAll(kept, "blocks");
      },
      subsections: (r) => {
        const f = jattr(r, "first_ordinal"), l = jattr(r, "last_ordinal"), lvl = jattr(r, "level");
        if (f == null) return [];
        return tagAll(all(
          `SELECT n.*, ? AS __path FROM nodes n WHERE n.doc_id = ? AND n.kind = 'md:section'
             AND json_extract(n.attrs,'$.first_ordinal') >= ? AND json_extract(n.attrs,'$.last_ordinal') <= ?
             AND json_extract(n.attrs,'$.level') > ? ORDER BY json_extract(n.attrs,'$.first_ordinal'), n.node_id`,
          r.__path, r.doc_id, f, l, lvl), "nodes");
      },
      children: (r) => {
        const f = jattr(r, "first_ordinal"), l = jattr(r, "last_ordinal"), lvl = jattr(r, "level");
        if (f == null) return [];
        // immediate child sections: contained, deeper, with no intervening section.
        return tagAll(all(
          `SELECT i.*, ? AS __path FROM nodes i WHERE i.doc_id = ? AND i.kind = 'md:section'
             AND json_extract(i.attrs,'$.level') > ?
             AND json_extract(i.attrs,'$.first_ordinal') >= ? AND json_extract(i.attrs,'$.last_ordinal') <= ?
             AND NOT EXISTS (SELECT 1 FROM nodes m WHERE m.doc_id = i.doc_id AND m.kind = 'md:section'
               AND json_extract(m.attrs,'$.level') > ? AND json_extract(m.attrs,'$.level') < json_extract(i.attrs,'$.level')
               AND json_extract(m.attrs,'$.first_ordinal') <= json_extract(i.attrs,'$.first_ordinal')
               AND json_extract(m.attrs,'$.last_ordinal') >= json_extract(i.attrs,'$.last_ordinal'))
           ORDER BY json_extract(i.attrs,'$.first_ordinal'), i.node_id`,
          r.__path, r.doc_id, lvl, f, l, lvl), "nodes");
      },
    },
    edges: {},
  };

  const jattr = (row: Row, k: string): unknown => {
    const a = row.attrs;
    const o = typeof a === "string" ? parseJson(a) : a;
    return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  };

  // owning-entity reach-through (single row).
  const owningDoc = (row: Row): Row | undefined =>
    tag(one(`SELECT * FROM docs WHERE doc_id = ?`, row.doc_id ?? row.src_doc), "docs");
  const owningBlock = (row: Row): Row | undefined => row.block_id
    ? tag(one(`SELECT b.*, d.path AS __path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?`, row.block_id), "blocks")
    : undefined;

  // ---- intrinsics ($-fields) ------------------------------------------------
  const intrinsic = (row: Row, t: Target, name: string): unknown => {
    // `$self` = the current row: run.ts rewrites row-scoped domain functions
    // (text/semantic/under_*/…) to `$self.fn(…)` so they arrive via callMethod
    // with the row as receiver (a free function sees no row).
    if (name === "$self") return row;
    if (t === "docs") switch (name) {
      case "$id": return row.doc_id;
      case "$path": return row.path;
      case "$repo": return row.repo_id;
      case "$content_hash": return row.file_hash == null ? null : hex(row.file_hash);
      case "$updated_at": return scalar(`SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = ?`, row.current_rev) ?? null;
      case "$body": return docsRead(store, String(row.doc_id))?.content ?? null;
      case "$title": return docProp(String(row.doc_id), "$title", "computed") ?? null;
      case "$tags": return docProp(String(row.doc_id), "$tags", "computed") ?? null;
    }
    if (t === "blocks") switch (name) {
      case "$id": return row.block_id;
      case "$doc": return row.doc_id;
      case "$path": return row.__path;
      case "$ordinal": return row.ordinal;
      case "$depth": return row.depth;
      case "$body": return row.text;
      case "$content_hash": return row.raw_hash == null ? null : hex(row.raw_hash);
      case "$updated_at": return scalar(`SELECT MAX(c.ts) FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?`, row.block_id) ?? null;
    }
    if (t === "nodes") switch (name) {
      case "$id": case "$node_id": return row.node_id;
      case "$doc_id": return row.doc_id;
      case "$block_id": return row.block_id;
      case "$path": return row.__path;
    }
    if (t === "edges") switch (name) {
      case "$id": return row.edge_id;
      case "$src": return row.src_doc;
      case "$dst": return row.dst_node;
      case "$src_block": return row.src_block;
      case "$via": return row.via_node;
      case "$from_commit": return row.from_commit;
      case "$path": return row.__path;
      case "$dst_path": return scalar(`SELECT path FROM docs WHERE doc_id = ?`, row.dst_node) ?? null;
      case "$dst_uri": return scalar(`SELECT uri FROM external_nodes WHERE node_id = ?`, row.dst_node) ?? null;
    }
    return undefined;
  };

  // ---- get ------------------------------------------------------------------
  const getFrom = (row: unknown, key: string): unknown => {
    if (row == null) return undefined;
    if ((row as RepoRoot)[REPO_ROOT]) return rootFns[key] ? rootFns[key]!() : undefined;
    if ((row as PropSourceRef)[PROP_SOURCE]) {
      const p = row as PropSourceRef;
      return docProp(p.docId, key, p.source);
    }
    const t = (row as Row)[TARGET];
    if (!t) {
      // a plain value (parsed attrs/json object, or a lifted array element): plain access.
      return (row as Record<string, unknown>)[key];
    }
    const r = row as Row;

    if (key.startsWith("$")) return intrinsic(r, t, key);

    // self-alias namespaces: `doc.x` (docs), `block.x` (blocks), `section.x` (nodes).
    if (t === "docs" && key === "doc") return r;
    if (t === "blocks" && key === "block") return r;
    if (t === "nodes" && key === "section") return r;

    // reach-through to owning entities.
    if (t !== "docs" && key === "doc") return owningDoc(r);
    if (t === "nodes" && key === "block") return owningBlock(r);

    // relations.
    const rels = rel[t];
    if (rels[key]) return rels[key]!(r);

    // per-target scalar fields.
    if (t === "docs") {
      if (key === "format") return r.format;
      if (key === "frontmatter" || key === "inline") return { [PROP_SOURCE]: true, docId: String(r.doc_id), source: key } as PropSourceRef;
      if (RESERVED_DOC_BASENAMES.has(key)) {
        throw new FilterInvalid(`bare '${key}' reads a frontmatter key; did you mean the intrinsic $${key}? (use frontmatter.${key} to force the property)`, "10 §2");
      }
      return docProp(String(r.doc_id), key);
    }
    if (t === "blocks") {
      if (key === "type") return r.type;
      if (key === "text") return r.text;
      if (key === "attrs") return parseJson(r.attrs);
      return undefined;
    }
    if (t === "nodes") {
      if (key === "kind") return r.kind;
      if (key === "name") return r.name;
      if (key === "value") return r.value;
      if (key === "attrs") return parseJson(r.attrs);
      return undefined;
    }
    // edges
    if (key === "predicate" || key === "provenance" || key === "dst_kind" || key === "anchor" || key === "src_field") return r[key];
    return undefined;
  };

  const provides = (row: Row, t: Target, key: string): boolean => {
    if (key.startsWith("$")) return intrinsic(row, t, key) !== undefined;
    if (t === "docs") {
      if (key === "doc" || key === "format" || key === "frontmatter" || key === "inline" || rel.docs[key]) return true;
      if (RESERVED_DOC_BASENAMES.has(key)) return true; // present-as-guard (get throws)
      // exact key, or a flattened nested prefix (`logging` for `logging.level`).
      return docPropExists(String(row.doc_id), key)
        || !!one(`SELECT 1 FROM properties WHERE doc_id = ? AND key LIKE ? AND deleted_commit IS NULL LIMIT 1`, row.doc_id, `${key}.%`);
    }
    if (t === "blocks") return key === "block" || key === "doc" || key === "type" || key === "text" || key === "attrs" || !!rel.blocks[key];
    if (t === "nodes") return key === "section" || key === "doc" || key === "block" || key === "kind" || key === "name" || key === "value" || key === "attrs" || !!rel.nodes[key];
    if (t === "edges") return key === "doc" || ["predicate", "provenance", "dst_kind", "anchor", "src_field"].includes(key);
    return false;
  };

  // ---- domain functions (row-scoped, via callMethod on $self) ---------------
  const method = (name: string, recv: unknown, args: unknown[]): CallResult => {
    const r = recv as Row;
    const t = r?.[TARGET];
    switch (name) {
      case "text": return { handled: true, value: textMatch(t, r, String(args[0] ?? "")) };
      case "semantic": return { handled: true, value: semanticScore(t, r, String(args[0] ?? "")) };
      case "has_anchor": {
        requireTarget(t, "blocks", "has_anchor");
        return { handled: true, value: !!one(`SELECT 1 FROM edges WHERE src_block = ? AND anchor IS NOT NULL LIMIT 1`, r.block_id) };
      }
      case "child_count": {
        requireTarget(t, "blocks", "child_count");
        return { handled: true, value: (scalar(`SELECT COUNT(*) FROM blocks WHERE parent_block = ? AND deleted_commit IS NULL`, r.block_id) as number) };
      }
      case "parent_type": {
        requireTarget(t, "blocks", "parent_type");
        return { handled: true, value: scalar(`SELECT type FROM blocks WHERE block_id = ?`, r.parent_block) ?? null };
      }
      case "has_edge": {
        const pred = String(args[0]);
        const srcCol = t === "blocks" ? "src_block = ?" : "src_doc = ?";
        const srcVal = t === "blocks" ? r.block_id : r.doc_id;
        if (args.length >= 2) return { handled: true, value: !!one(`SELECT 1 FROM edges WHERE ${srcCol} AND predicate = ? AND to_commit IS NULL AND dst_node = ? LIMIT 1`, srcVal, pred, args[1]) };
        return { handled: true, value: !!one(`SELECT 1 FROM edges WHERE ${srcCol} AND predicate = ? AND to_commit IS NULL LIMIT 1`, srcVal, pred) };
      }
      case "under": { requireTarget(t, "blocks", "under"); return { handled: true, value: underSubtree(r, String(args[0])) }; }
      case "under_heading": { requireTarget(t, "blocks", "under_heading"); return { handled: true, value: underHeading(r, String(args[0])) }; }
      case "within": { requireTarget(t, "blocks", "within"); return { handled: true, value: within(r, String(args[0])) }; }
      case "under_kind": { requireTarget(t, "blocks", "under_kind"); return { handled: true, value: underKind(r, String(args[0]), args[1] as string | undefined) }; }
      case "yaml_path": { requireTarget(t, "blocks", "yaml_path"); return { handled: true, value: keyPath(r, String(args[0]), "yaml") }; }
      case "json_pointer": { requireTarget(t, "blocks", "json_pointer"); return { handled: true, value: keyPath(r, String(args[0]), "json") }; }
      default: return { handled: false };
    }
  };

  const textMatch = (t: Target | undefined, r: Row, terms: string): boolean => {
    if (t === "edges") throw new FilterInvalid("text(...) is not available on the edges target", "10 §5");
    const match = sanitizeFtsQuery(terms);
    if (match === "") return false;
    if (t === "docs") return !!one(`SELECT 1 FROM blocks_fts JOIN blocks b ON b.rowid = blocks_fts.rowid WHERE b.doc_id = ? AND blocks_fts MATCH ? LIMIT 1`, r.doc_id, match);
    if (t === "nodes") return !!one(`SELECT 1 FROM nodes_fts WHERE rowid = (SELECT rowid FROM nodes WHERE node_id = ?) AND nodes_fts MATCH ? `, r.node_id, match);
    // blocks
    return !!one(`SELECT 1 FROM blocks_fts WHERE rowid = (SELECT rowid FROM blocks WHERE block_id = ?) AND blocks_fts MATCH ?`, r.block_id, match);
  };

  const semanticScore = (t: Target | undefined, r: Row, phrase: string): number | null => {
    if (t === "nodes" || t === "edges") throw new FilterInvalid("semantic(...) is available on the docs and blocks targets", "OQX semantic");
    const resolved = sv?.get(phrase);
    if (!resolved) throw new FilterInvalid(`semantic(${JSON.stringify(phrase)}) needs an embedding provider; none is configured for this query`, "OQX semantic");
    const row = t === "docs"
      ? one(`SELECT vec FROM doc_embeddings WHERE doc_id = ? AND model = ?`, r.doc_id, resolved.model)
      : one(`SELECT vec FROM embeddings WHERE content_hash = ? AND model = ? LIMIT 1`, r.raw_hash, resolved.model);
    if (!row) return null;
    return cosineBytes(row.vec as Buffer, resolved.vec);
  };

  const underSubtree = (r: Row, target: string): boolean => {
    const ap = String(r.ancestor_path ?? "");
    return ap.includes(`/${target}/`) || r.block_id === target;
  };
  const underHeading = (r: Row, text: string): boolean => {
    const top = topOrdinal(r);
    return !!one(
      `SELECT 1 FROM sections s JOIN blocks hb ON hb.block_id = s.heading_block
       WHERE s.doc_id = ? AND lower(hb.text) LIKE '%' || lower(?) || '%' AND s.first_ordinal <= ? AND s.last_ordinal >= ? LIMIT 1`,
      r.doc_id, text, top, top);
  };
  const within = (r: Row, target: string): boolean => {
    if (target.startsWith("d_")) return r.doc_id === target;
    if (target.includes("*")) {
      const like = target.replace(/[%_]/g, "\\$&").replace(/\*/g, "%");
      return !!one(`SELECT 1 WHERE ? LIKE ? ESCAPE '\\'`, r.__path, like);
    }
    return r.__path === target;
  };
  const underKind = (r: Row, kind: string, name?: string): boolean => {
    const ap = String(r.ancestor_path ?? "").split("/").filter(Boolean);
    if (ap.length === 0) return false;
    const placeholders = ap.map(() => "?").join(",");
    if (name != null) {
      return !!one(
        `SELECT 1 FROM blocks WHERE block_id IN (${placeholders}) AND type = ? AND (lower(text) LIKE '%' || lower(?) || '%' OR json_extract(attrs,'$.key') = ?) LIMIT 1`,
        ...ap, kind, name, name);
    }
    return !!one(`SELECT 1 FROM blocks WHERE block_id IN (${placeholders}) AND type = ? LIMIT 1`, ...ap, kind);
  };
  const keyPath = (r: Row, path: string, kind: "yaml" | "json"): boolean => {
    const key = kind === "json" ? path.replace(/^#?\/?/, "").split("/").join(".") : path;
    const leaf = key.split(".").pop()!;
    if (String(r.type ?? "").startsWith(`${kind}:`) === false) return false;
    return jattr(r, "key") === leaf || jattr(r, "key") === key;
  };

  return {
    root(name: string): unknown {
      if (opts.rowsRoot && name === opts.rowsRoot.name) return opts.rowsRoot.rows;
      if (name === "repo") return { [REPO_ROOT]: true } as RepoRoot;
      return rootFns[name] ? rootFns[name]!() : undefined;
    },
    get: getFrom,
    has(row: unknown, key: string): boolean {
      if (row == null) return false;
      if ((row as RepoRoot)[REPO_ROOT]) return !!rootFns[key];
      if ((row as PropSourceRef)[PROP_SOURCE]) return true;
      const t = (row as Row)[TARGET];
      if (!t) return typeof row === "object" && key in (row as object);
      return provides(row as Row, t, key);
    },
    toRows(value: unknown): Iterable<unknown> {
      if (value == null) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === "object" && (value as Row)[TARGET]) return [value];
      if (typeof value === "object" && Symbol.iterator in (value as object)) return value as Iterable<unknown>;
      return [value];
    },
    identity(row: unknown): unknown {
      const t = (row as Row)?.[TARGET];
      if (t === "docs") return (row as Row).doc_id;
      if (t === "blocks") return (row as Row).block_id;
      if (t === "nodes") return (row as Row).node_id;
      if (t === "edges") return (row as Row).edge_id;
      return row;
    },
    // Free functions: only oqx-js builtins (list/size/has) are free — the
    // row-scoped domain functions are rewritten to `$self.fn(…)` methods upstream.
    callFunction(name: string, args: unknown[]): CallResult {
      const fn = semantics.BUILTIN_FUNCTIONS[name];
      return fn ? { handled: true, value: fn(args) } : { handled: false };
    },
    // Domain methods first; fall back to oqx-js builtin methods
    // (contains/startsWith/endsWith/matches/size/lower/upper).
    callMethod(name: string, recv: unknown, args: unknown[]): CallResult {
      const r = method(name, recv, args);
      if (r.handled) return r;
      const fn = semantics.BUILTIN_METHODS[name];
      return fn ? { handled: true, value: fn(recv, args) } : { handled: false };
    },
  };
}

function requireTarget(t: Target | undefined, want: Target, fn: string): void {
  if (t !== want) throw new FilterInvalid(`${fn}() is only available on the ${want} target`, "10 §5");
}
function hex(b: unknown): string {
  return Buffer.isBuffer(b) ? b.toString("hex") : String(b);
}

/** Tag SQL rows with their target so the store context resolves them (used by the
 * tier-3 planner to hand produced rows back for residual evaluation). */
export function tagRows(rows: Record<string, unknown>[], target: Target): unknown[] {
  return tagAll(rows, target);
}

export { TARGET };
