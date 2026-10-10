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

import type { DataContext, CallResult, RowIndex } from "@omgbase/oqx";
import { semantics } from "@omgbase/oqx";
import { storeIndexFor } from "./store-index.js";
import { COLS, FROM, ORDER, guards } from "./sql/scan.js";
import type { Store } from "../core/store/store.js";
import { detectRange } from "../core/store/properties.js";
import { docsRead } from "../core/read/document.js";
import { referencePath, storagePath } from "../core/paths.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { sanitizeFtsQuery } from "../search/fts-query.js";
import { cosineBytes } from "../core/vec.js";
import { ctxHashHex } from "../search/embeddings.js";
import { makeBlockContextResolver, type BlockContextResolver } from "../search/tasks.js";
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
// (The root-scan receiver is the `$repo` intrinsic — `$repo.docs`/`$repo.nodes`/… —
// so a bare `repo` is just an ordinary frontmatter key.)
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

  // ---- root collections (the shared scan shape of sql/scan.ts: live rows of
  // this repo, ordered for a stable (path, id) default) -----------------------
  const scan = (t: Target): Row[] => {
    const g = guards(t, repoId);
    return tagAll(all(`SELECT ${COLS[t]} FROM ${FROM[t]} WHERE ${g.sql} ORDER BY ${ORDER[t]}`, ...g.params), t);
  };

  // A root scan is handed out LAZILY: an array (a `Proxy` over one — `Array.isArray`,
  // iteration, indexing, `length`, rendering all see a plain array of tagged
  // rows) that runs its SELECT on first use. The engine's optimizer asks
  // `indexFor` about a nested block's receiver BEFORE reading it, so a
  // correlated probe on `$repo.docs` / `$repo.edges` / … is answered from the
  // store's indexes (store-index.ts) and the scan never runs; anything else
  // (a top-level `from docs`, a `count { }`, a non-indexable path) reads it
  // whole exactly as before. One handle per target per context: a context lives
  // for one run, during which the store does not change, so `$repo.docs` read
  // from every outer row is one SELECT, not one per row — and the engine, which
  // keys collections by identity, sees the same collection each time.
  // `rootScans` recognizes the handles for `indexFor`. Because the handle IS an
  // array, this context needs no `DataContext.materialize` (the Rust port's
  // marker value does); `spec/surface` `lazy-root-*` pins what the language
  // sees either way.
  const rootScans = new WeakMap<object, { target: Target; rows(): Row[] }>();
  const handles = new Map<Target, Row[]>();
  const lazyRoot = (t: Target): Row[] => {
    let h = handles.get(t);
    if (!h) handles.set(t, (h = makeLazyRoot(t)));
    return h;
  };
  const makeLazyRoot = (t: Target): Row[] => {
    const backing: Row[] = [];
    let filled = false;
    const fill = (): Row[] => {
      if (!filled) { filled = true; for (const r of scan(t)) backing.push(r); }
      return backing;
    };
    const proxy = new Proxy(backing, {
      get(target, prop, receiver) { fill(); return Reflect.get(target, prop, receiver); },
      has(target, prop) { fill(); return Reflect.has(target, prop); },
      ownKeys(target) { fill(); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, prop) { fill(); return Reflect.getOwnPropertyDescriptor(target, prop); },
      set(target, prop, value, receiver) { fill(); return Reflect.set(target, prop, value, receiver); },
      defineProperty(target, prop, desc) { fill(); return Reflect.defineProperty(target, prop, desc); },
      deleteProperty(target, prop) { fill(); return Reflect.deleteProperty(target, prop); },
    });
    rootScans.set(proxy, { target: t, rows: fill });
    return proxy;
  };

  const rootFns: Record<string, () => Row[]> = {
    docs: () => lazyRoot("docs"), blocks: () => lazyRoot("blocks"), nodes: () => lazyRoot("nodes"), edges: () => lazyRoot("edges"),
  };
  // The repository handle behind the `$repo` intrinsic: `$repo.<target>` is the
  // explicit root scan (rootFns), `$repo.$id` the repository id.
  const repoRoot: RepoRoot = { [REPO_ROOT]: true };

  // ---- attrs / property decoding --------------------------------------------
  const parseJson = (v: unknown): unknown => {
    if (typeof v !== "string") return v ?? undefined;
    try { return JSON.parse(v); } catch { return v; }
  };
  // A property decodes to a plain scalar. A range-valued string (a frontmatter
  // `1..5` / `2026-01-01..2026-01-31`) stays a STRING here — range behavior is
  // opt-in via the `range(prop)` function (see callFunction), so a value that
  // merely looks rangey is never silently reinterpreted, and projection/equality
  // see the authored text. The store still caches the parsed bounds in val_json
  // (see properties.ts detectRange) as an index substrate; it does not change
  // this decode.
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
  // All of a doc's properties from one source (`frontmatter` / `inline`) as OQX
  // entries, for `entries(frontmatter)`: one entry per TOP-LEVEL key, valued by
  // the same scalar-vs-list rule as a bare read (`docProp`), with flattened dotted
  // keys (`logging.level`) folded back into one nested entry. Keys come in the
  // properties table's deterministic order — by key — because authored key
  // position is not indexed (`ord` is the position WITHIN a list-valued key).
  const docPropEntries = (docId: string, source: string): unknown[] => {
    const keys = all(
      `SELECT DISTINCT key FROM properties WHERE doc_id = ? AND source = ? AND deleted_commit IS NULL ORDER BY key`,
      docId, source,
    ).map((r) => String(r.key));
    const tops: string[] = [];
    const seen = new Set<string>();
    for (const k of keys) {
      const top = k.split(".")[0]!;
      if (!seen.has(top)) { seen.add(top); tops.push(top); }
    }
    return tops.map((t) => semantics.makeEntry(t, docProp(docId, t, source)));
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

  // ---- a document's live blocks in DOCUMENT order (spec/surface §1.2) --------
  // Pre-order over the containment forest (children by parent_block, siblings by
  // (ordinal, block_id)); each row is paired with its top-level ancestor's
  // ordinal, which is what section ranges are expressed in.
  const docBlocksPreorder = (docId: unknown, path: unknown): { row: Row; top: number }[] => {
    const rows = all(`SELECT b.*, ? AS __path FROM blocks b WHERE b.doc_id = ? AND b.deleted_commit IS NULL ORDER BY b.ordinal, b.block_id`, path, docId) as Row[];
    const ids = new Set(rows.map((r) => r.block_id));
    const byParent = new Map<string | null, Row[]>();
    for (const r of rows) {
      const parent = r.parent_block != null && ids.has(r.parent_block as string) ? (r.parent_block as string) : null;
      let list = byParent.get(parent);
      if (!list) byParent.set(parent, (list = []));
      list.push(r);
    }
    const out: { row: Row; top: number }[] = [];
    const walk = (parent: string | null, top: number | null): void => {
      for (const r of byParent.get(parent) ?? []) {
        const t = top ?? (r.ordinal as number);
        out.push({ row: r, top: t });
        walk(r.block_id as string, t);
      }
    };
    walk(null, null);
    return out;
  };

  // A document's nodes in DOCUMENT order: by the owning block's pre-order rank
  // (block-less nodes first), then span_start, then node_id. Node ids are content
  // hashes over random doc ids, so an id order would differ per ingest.
  const docNodesInOrder = (docId: unknown, path: unknown): Row[] => {
    const rank = new Map<string, number>();
    docBlocksPreorder(docId, path).forEach((x, i) => rank.set(x.row.block_id as string, i));
    const rows = all(`SELECT n.*, ? AS __path FROM nodes n WHERE n.doc_id = ?`, path, docId) as Row[];
    const pos = (n: Row): number => (n.block_id == null ? -1 : rank.get(n.block_id as string) ?? Number.MAX_SAFE_INTEGER);
    const span = (n: Row): number => (typeof n.span_start === "number" ? n.span_start : -1);
    rows.sort((a, b) => pos(a) - pos(b) || span(a) - span(b) || (a.node_id as string < (b.node_id as string) ? -1 : a.node_id === b.node_id ? 0 : 1));
    return tagAll(rows, "nodes");
  };

  // ---- relations (return row arrays) ----------------------------------------
  const rel: Record<Target, Record<string, (row: Row) => Row[] | Row | undefined>> = {
    docs: {
      nodes: (r) => docNodesInOrder(r.doc_id, r.path),
      blocks: (r) => tagAll(docBlocksPreorder(r.doc_id, r.path).map((x) => x.row), "blocks"),
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
      nodes: (r) => tagAll(all(`SELECT n.*, ? AS __path FROM nodes n WHERE n.block_id = ? ORDER BY n.span_start, n.node_id`, r.__path, r.block_id), "nodes"),
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
        // blocks whose top-level ancestor's ordinal falls in the section range, in document order.
        const kept = docBlocksPreorder(r.doc_id, r.__path).filter((x) => x.top >= (f as number) && x.top <= (l as number)).map((x) => x.row);
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
  // `$path` / `$dst_path` are the REFERENCE form (`/a/b.md`, spec/surface §1
  // "Paths", 2.0): the rows carry the storage form (`path`, the `__path` join
  // column) and the intrinsic roots it on read, so nothing below the binding
  // changes. run.ts roots the string literals a query compares them with.
  const intrinsic = (row: Row, t: Target, name: string): unknown => {
    // `$self` = the current row: run.ts rewrites row-scoped domain functions
    // (text/semantic/under_*/…) to `$self.fn(…)` so they arrive via callMethod
    // with the row as receiver (a free function sees no row).
    if (name === "$self") return row;
    if (t === "docs") switch (name) {
      case "$id": return row.doc_id;
      case "$path": return referencePath(String(row.path));
      case "$content_hash": return row.file_hash == null ? null : hex(row.file_hash);
      case "$updated_at": return scalar(`SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = ?`, row.current_rev) ?? null;
      case "$body": return docsRead(store, String(row.doc_id))?.content ?? null;
      case "$title": return docProp(String(row.doc_id), "$title", "computed") ?? null;
      case "$tags": return docProp(String(row.doc_id), "$tags", "computed") ?? null;
    }
    if (t === "blocks") switch (name) {
      case "$id": return row.block_id;
      case "$doc": return row.doc_id;
      case "$path": return referencePath(String(row.__path));
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
      case "$path": return referencePath(String(row.__path));
    }
    if (t === "edges") switch (name) {
      case "$id": return row.edge_id;
      case "$src": return row.src_doc;
      case "$dst": return row.dst_node;
      case "$src_block": return row.src_block;
      case "$via": return row.via_node;
      case "$from_commit": return row.from_commit;
      case "$path": return referencePath(String(row.__path));
      case "$dst_path": {
        const p = scalar(`SELECT path FROM docs WHERE doc_id = ?`, row.dst_node);
        return p == null ? null : referencePath(String(p));
      }
      case "$dst_uri": return scalar(`SELECT uri FROM external_nodes WHERE node_id = ?`, row.dst_node) ?? null;
    }
    return undefined;
  };

  // ---- get ------------------------------------------------------------------
  const getFrom = (row: unknown, key: string): unknown => {
    if (row == null) return undefined;
    // `$repo` is an intrinsic of EVERY scope — the root and any row, store-backed
    // or plain. Bare names resolve against the current row only (oqx ≥ 0.7: no
    // scope climbing), so a correlated subquery at any depth reaches the
    // repository root through this local intrinsic, never by falling through
    // to an enclosing scope.
    if (key === "$repo") return repoRoot;
    if ((row as RepoRoot)[REPO_ROOT]) {
      if (key === "$id") return repoId;
      return rootFns[key] ? rootFns[key]!() : undefined;
    }
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
      // A bare non-structural identifier flattens into attrs: `checked` reads
      // `attrs.checked`. Structural fields above win on collision; an absent key
      // is undefined (silently false in a predicate), matching a doc's missing
      // frontmatter key. The `attrs.<k>` form still works unchanged.
      return jattr(r, key);
    }
    if (t === "nodes") {
      if (key === "kind") return r.kind;
      if (key === "name") return r.name;
      if (key === "value") return r.value;
      if (key === "attrs") return parseJson(r.attrs);
      // Bare non-structural identifier flattens into attrs (see blocks above):
      // `checked` reads `attrs.checked` on an `md:task`, `level` on an `md:section`.
      return jattr(r, key);
    }
    // edges
    if (key === "predicate" || key === "provenance" || key === "dst_kind" || key === "anchor" || key === "src_field") return r[key];
    return undefined;
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

  // A block's vector is the cache row for its CURRENT (raw_hash, ctx_hash)
  // (spec/surface §1.3, spec/search §3 — since search 1.1; before, the first row
  // for the raw_hash whatever its context). The context resolver is built once
  // per query (one scan of titles and sections), then a per-block chain walk.
  let blockContexts: BlockContextResolver | undefined;
  const blockVector = (r: Row, model: string): Record<string, unknown> | undefined => {
    blockContexts ??= makeBlockContextResolver(store, { repoId });
    const path = typeof r.__path === "string" ? r.__path : String(scalar(`SELECT path FROM docs WHERE doc_id = ?`, r.doc_id) ?? "");
    const ctx = blockContexts.ctx({ doc_id: String(r.doc_id), path, ordinal: Number(r.ordinal), type: String(r.type) });
    return one(`SELECT vec FROM embeddings WHERE content_hash = ? AND ctx_hash = ? AND model = ?`, r.raw_hash, Buffer.from(ctxHashHex(ctx), "hex"), model);
  };
  const semanticScore = (t: Target | undefined, r: Row, phrase: string): number | null => {
    if (t === "nodes" || t === "edges") throw new FilterInvalid("semantic(...) is available on the docs and blocks targets", "OQX semantic");
    const resolved = sv?.get(phrase);
    if (!resolved) throw new FilterInvalid(`semantic(${JSON.stringify(phrase)}) needs an embedding provider; none is configured for this query`, "OQX semantic");
    const row = t === "docs"
      ? one(`SELECT vec FROM doc_embeddings WHERE doc_id = ? AND model = ?`, r.doc_id, resolved.model)
      : blockVector(r, resolved.model);
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
  // `within(t)`: a doc id, else a path in either form (`/texts/*`, `texts/*`,
  // `texts/x.md`) matched against the storage path.
  const within = (r: Row, target: string): boolean => {
    if (target.startsWith("d_")) return r.doc_id === target;
    const path = storagePath(target);
    if (path.includes("*")) {
      const like = path.replace(/[%_]/g, "\\$&").replace(/\*/g, "%");
      return !!one(`SELECT 1 WHERE ? LIKE ? ESCAPE '\\'`, r.__path, like);
    }
    return r.__path === path;
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

  // ---- refs(x): document references held in a property (spec/surface §1.3, 1.5)
  // `x` is a string, a list, or absent; every string element that names a live
  // document of this repo — a doc id (`d_…`), a repo-root-absolute path
  // (`/a/b.md`) or a bare repo-relative path (`a/b.md`) — resolves to that
  // document's row; anything else (a dangling reference, a non-string element)
  // is dropped. Order preserved, duplicates kept. Each element is one indexed
  // lookup under the root scan's guards and columns (`sql/scan.ts`), so the rows
  // are indistinguishable from scanned ones and the docs root is never read.
  const refDoc = (ref: string): Row | undefined => {
    const g = guards("docs", repoId);
    const path = storagePath(ref);
    const byPath = one(`SELECT ${COLS.docs} FROM ${FROM.docs} WHERE ${g.sql} AND d.path = ?`, ...g.params, path);
    if (byPath) return tag(byPath, "docs");
    if (!ref.startsWith("d_")) return undefined;
    return tag(one(`SELECT ${COLS.docs} FROM ${FROM.docs} WHERE ${g.sql} AND d.doc_id = ?`, ...g.params, ref), "docs");
  };
  const refs = (x: unknown): Row[] => {
    const items = x == null ? [] : Array.isArray(x) ? x : [x];
    const out: Row[] = [];
    for (const item of items) {
      if (typeof item !== "string") continue;
      const row = refDoc(item);
      if (row) out.push(row);
    }
    return out;
  };

  // Store indexes by (target, path) — one object, one set of prepared statements,
  // for the whole run (`null`: the path is not indexable).
  const indexes = new Map<string, RowIndex | null>();
  const identity = (row: unknown): unknown => {
    const t = (row as Row)?.[TARGET];
    if (t === "docs") return (row as Row).doc_id;
    if (t === "blocks") return (row as Row).block_id;
    if (t === "nodes") return (row as Row).node_id;
    if (t === "edges") return (row as Row).edge_id;
    return row;
  };

  return {
    root(name: string): unknown {
      if (opts.rowsRoot && name === opts.rowsRoot.name) return opts.rowsRoot.rows;
      if (name === "$repo") return repoRoot;
      return rootFns[name] ? rootFns[name]!() : undefined;
    },
    // The root scope's row (oqx 0.18): the repository root, so `^$it` from a
    // top-level row is `$repo` and `^$it.docs` the docs scan.
    rootObject(): unknown {
      return repoRoot;
    },
    get: getFrom,
    toRows(value: unknown): Iterable<unknown> {
      if (value == null) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === "object" && (value as Row)[TARGET]) return [value];
      if (typeof value === "object" && Symbol.iterator in (value as object)) return value as Iterable<unknown>;
      return [value];
    },
    identity,
    // A store-backed equality index for a ROOT SCAN handle on a column or
    // property SQLite indexes (store-index.ts); `undefined` for any other
    // collection (a relation's rows, a lifted array) or path, so the engine
    // builds its own over the materialized rows.
    indexFor(collection: unknown, path: readonly string[]): RowIndex | undefined {
      if (collection === null || typeof collection !== "object") return undefined;
      const root = rootScans.get(collection);
      if (!root) return undefined;
      const key = `${root.target}\u0000${JSON.stringify(path)}`;
      let index = indexes.get(key);
      if (index === undefined) {
        index = storeIndexFor(root.target, path, { db, repoId, tag: (rows, t) => tagAll(rows, t), get: getFrom, rows: root.rows, identity }) ?? null;
        indexes.set(key, index);
      }
      return index ?? undefined;
    },
    // Free functions: oqx-js builtins (list/size/has) plus `range(s)`, which
    // coerces a string value to a range so `<point> in range(prop)` tests
    // coverage. range() is the explicit opt-in over the store's plain string;
    // it delegates here (rather than only to the oqx-js builtin) so a future
    // pushdown can serve the property's autopromoted/cached bounds — see
    // detectRange + val_json in store/properties.ts.
    callFunction(name: string, args: unknown[]): CallResult {
      // `entries(frontmatter)` / `entries(inline)`: the source handle is lazy (a
      // PropSourceRef, not a plain object), so materialize its property bag as
      // entries here; any other argument falls through to the oqx builtin.
      if (name === "entries" && (args[0] as PropSourceRef | undefined)?.[PROP_SOURCE]) {
        const p = args[0] as PropSourceRef;
        return { handled: true, value: docPropEntries(p.docId, p.source) };
      }
      if (name === "refs") return { handled: true, value: refs(args[0]) };
      if (name === "range") {
        const s = args[0];
        if (semantics.isRange(s)) return { handled: true, value: s };
        const rv = typeof s === "string" ? detectRange(s) : null;
        return { handled: true, value: rv ? semantics.makeRange(rv.lo, rv.hi, rv.exclusiveEnd) : null };
      }
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

/**
 * A store row surfacing as a VALUE in a result (spec/surface §1.4, rows as
 * values, 1.2) is rendered as `{ id, path }` — its id column and its document's
 * path in the reference form (`/a.md`, §1 "Paths"), the same two keys every hit
 * carries — never the store row itself.
 * Returns undefined for anything that is not a tagged row (run.ts leaves those
 * alone).
 */
export function rowRef(value: unknown): { id: string; path: string } | undefined {
  const t = (value as Row | null | undefined)?.[TARGET];
  if (!t) return undefined;
  const r = value as Row;
  const id = t === "docs" ? r.doc_id : t === "blocks" ? r.block_id : t === "nodes" ? r.node_id : r.edge_id;
  const path = t === "docs" ? r.path : r.__path;
  return { id: String(id), path: path == null ? "" : referencePath(String(path)) };
}

export { TARGET };
