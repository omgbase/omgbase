// A store-backed DataContext (oqx-js tier 2): binds `@omgbase/oqx`'s query
// semantics to omgbase's SQLite store, so the InMemoryEngine reproduces the whole
// OQX surface (targets, intrinsics, reach-through, structural relations, the edge
// graph, follow, correlation, lifts) without a bespoke compiler. Rows are the
// store's raw column objects, tagged with their target; `get` routes field /
// intrinsic / relation resolution per target, lazily querying the store for
// relations. Domain functions (text/semantic/under_*/…) are row-scoped, so they
// arrive via `callMethod` on the row as receiver — run.ts's AST rewrite turns
// them into `$it.fn(…)` — rather than as free functions (which see no row).
//
// This is the correctness tier: N+1 queries, materialized collections — fine for
// the corpus and the differential baseline. The tier-3 SQLite planner (planner.ts)
// pushes the hot predicates down; both must agree (conformance suite).

import type { DataContext, CallResult, RowIndex } from "@omgbase/oqx";
import { semantics } from "@omgbase/oqx";
import { storeIndexFor } from "./store-index.js";
import { ROOTS, ROOT_NAMES, bareTargetMessage, type Root } from "./root-row.js";
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
import { dateFunction, dateMethod } from "./dates.js";

export type Target = "docs" | "blocks" | "nodes" | "links";
/** Every row kind the context tags (spec/surface §1.1): the four targets and
 * `revisions` (4.7) — the history target, whose rows are the `revisions` ×
 * `commits` join. `Target` stays the four kinds the unknown-names pass judges
 * (names.ts keys its tables by it); everything that tags, scans or renders a
 * row is keyed by `Kind`. */
export type Kind = Root;

const TARGET = Symbol("oqx.target");
type Row = Record<string, unknown> & { [TARGET]?: Kind };
const ROOT_ROW = Symbol("oqx.rootRow");
const PROP_SOURCE = Symbol("oqx.propSource");

interface RootRow { [ROOT_ROW]: true }
interface PropSourceRef { [PROP_SOURCE]: true; docId: string; source: string | null }

function tag(row: Record<string, unknown> | undefined, t: Kind): Row | undefined {
  if (!row) return undefined;
  (row as Row)[TARGET] = t;
  return row as Row;
}
function tagAll(rows: Record<string, unknown>[], t: Kind): Row[] {
  for (const r of rows) (r as Row)[TARGET] = t;
  return rows as Row[];
}

// THE NAME RULE (spec/surface §1.2, 3.0). `$` belongs to OQX: `$it`, `$key`,
// `$depth`, `$stop`, `$leaf`, `$frontier`, `$ordinal` are values the LANGUAGE
// injects into a scope; omgbase adds no `$` names. Every engine attribute is a
// bare snake_case name that WINS on collision — the convention the relations
// (`children`, `blocks`, `out_links`, `doc`, `frontmatter`, …) always followed:
// a bare name that is an engine attribute reads the engine's value, never the
// author's. The attributes: every row's `id`/`path`; docs' and blocks' `raw`/
// `hash`/`updated_at`/`created_at` (4.10: the commit `ts` of the thing's first
// revision / earliest `block_changes` row — "first observed by omgbase", not a
// filesystem time); docs' `title` (the computed title) and `tags` (authored
// tags ∪ body hashtags) and `format`; a foreign key named for what it is
// (`doc_id`, `block_id`, `via_id`, `dst_id`, `dst_path`, `uri`), a column its
// column (`type`, `text`, `depth`, `ordinal`, `kind`, `predicate`, `field`).
// User data is bare too, read by any non-colliding key; where it collides it is
// reached through a source handle — `data` (the merged authored view:
// frontmatter + inline by the property rule, exactly the read a bare
// non-colliding key performs), `frontmatter`, `inline` — so `data.path` is the
// author's `path:` key, `data.tags` the authored list alone, `data.title` the
// authored title. There is no loud-error set: a bare `id`/`path`/`updated_at`/
// `hash`/`raw` is simply the engine's attribute (before this batch of 3.0 the
// attributes were `$`-prefixed and the bare spelling was an error, §9). A bare
// target name — `docs`, `links`, … — is a loud error of its own (root-row.ts).
// `revisions` on a document is a RELATION (its revision list, §1.2, 4.7) in
// `rel.docs` below, and names.ts's `RELATIONS.docs` knows it as one.
const DOC_ATTRIBUTES = new Set(["id", "path", "raw", "hash", "updated_at", "created_at", "title", "tags", "format"]);
const BLOCK_ATTRIBUTES = new Set(["id", "path", "raw", "hash", "updated_at", "created_at", "doc_id", "type", "text", "attrs", "depth", "ordinal"]);
const NODE_ATTRIBUTES = new Set(["id", "path", "doc_id", "block_id", "kind", "name", "value", "attrs"]);
const EDGE_ATTRIBUTES = new Set(["id", "path", "doc_id", "block_id", "via_id", "dst_id", "dst_path", "uri", "field", "dst_kind", "predicate", "provenance", "anchor"]);
// The history target (spec/surface §1.2, 4.7): a revision row's own columns
// under the names `docs_history` already uses (`rev`, `seq`, `commit`, `origin`,
// `actor`, `hash`), the commit's `ts` and `reason`, `is_current`, and (4.9)
// `archived` — the revision's bodies live in an archive segment (spec/store §7
// "Retention"; `docs_read { at }` reads through it when attached).
const REVISION_ATTRIBUTES = new Set(["id", "path", "rev", "seq", "doc_id", "commit", "ts", "origin", "actor", "reason", "hash", "is_current", "archived"]);
/** The engine attributes per kind (spec/surface §1.2 table). Exported so the
 * translator's tests pin the two against each other. */
export const ATTRIBUTES: Readonly<Record<Kind, ReadonlySet<string>>> = {
  docs: DOC_ATTRIBUTES, blocks: BLOCK_ATTRIBUTES, nodes: NODE_ATTRIBUTES, links: EDGE_ATTRIBUTES, revisions: REVISION_ATTRIBUTES,
};

// The revisions scan (spec/surface §1.1, 4.7): every revision of every document
// of the repository — tombstoned documents included, history is history — with
// its commit, in the keyset order `(path as of the revision, rev_id)`. The
// `revisions` table carries no `repo_id`, so the repository guard joins `docs`.
// `is_current` is `docs_history`'s `isCurrent`: the revision is the document's
// `current_rev`.
const REVISION_COLS = "r.rev_id, r.doc_id, r.seq, r.rendered_hash, r.path, r.commit_id, c.ts, c.origin, c.actor, c.reason, (d.current_rev = r.rev_id) AS is_current, (r.archive IS NOT NULL) AS archived";
const REVISION_FROM = "revisions r JOIN docs d ON d.doc_id = r.doc_id JOIN commits c ON c.commit_id = r.commit_id";
/** The source handles of a document (§1.2): `data` is the merged authored view
 * (frontmatter + inline), the other two one source each. */
export const SOURCE_HANDLES: ReadonlySet<string> = new Set(["data", "frontmatter", "inline"]);

/** The value of a statically SINGLE relation that has no row — `dst` on an
 * external or dangling link, `block` on a node without one (oqx 0.20, SEMANTICS
 * §3): an object the engine treats as one row with no rows, so `dst { title }`
 * is absent rather than `[]`, while as a VALUE it is absent (`materialize`),
 * so `dst == null`, `has(dst)` and `dst.title` read as before. */
export const ABSENT_SINGLE: object = Object.freeze({});

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
  // this repo, ordered for a stable (path, id) default; the revisions scan is
  // its own statement above, in the same (path, id) keyset order) -------------
  const scan = (t: Kind): Row[] => {
    if (t === "revisions") return tagAll(all(`SELECT ${REVISION_COLS} FROM ${REVISION_FROM} WHERE d.repo_id = ? ORDER BY r.path, r.rev_id`, repoId), t);
    const g = guards(t, repoId);
    return tagAll(all(`SELECT ${COLS[t]} FROM ${FROM[t]} WHERE ${g.sql} ORDER BY ${ORDER[t]}`, ...g.params), t);
  };
  // A document's revisions (the `revisions` relation of a docs row, §1.2, 4.7):
  // oldest first, as `docs_history` lists them.
  const docRevisions = (docId: unknown): Row[] =>
    tagAll(all(`SELECT ${REVISION_COLS} FROM ${REVISION_FROM} WHERE r.doc_id = ? ORDER BY r.seq`, docId), "revisions");

  // A root scan is handed out LAZILY: an array (a `Proxy` over one — `Array.isArray`,
  // iteration, indexing, `length`, rendering all see a plain array of tagged
  // rows) that runs its SELECT on first use. The engine's optimizer asks
  // `indexFor` about a nested block's receiver BEFORE reading it, so a
  // correlated probe on `^docs` / `^links` / … is answered from the
  // store's indexes (store-index.ts) and the scan never runs; anything else
  // (a top-level `from docs`, a `count { }`, a non-indexable path) reads it
  // whole exactly as before. One handle per target per context: a context lives
  // for one run, during which the store does not change, so `^docs` read
  // from every outer row is one SELECT, not one per row — and the engine, which
  // keys collections by identity, sees the same collection each time.
  // `rootScans` recognizes the handles for `indexFor`. Because the handle IS an
  // array, this context needs no `DataContext.materialize` (the Rust port's
  // marker value does); `spec/surface` `lazy-root-*` pins what the language
  // sees either way.
  const rootScans = new WeakMap<object, { target: Kind; rows(): Row[] }>();
  const handles = new Map<Kind, Row[]>();
  const lazyRoot = (t: Kind): Row[] => {
    let h = handles.get(t);
    if (!h) handles.set(t, (h = makeLazyRoot(t)));
    return h;
  };
  const makeLazyRoot = (t: Kind): Row[] => {
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

  const rootFns: Record<string, () => Row[]> = Object.fromEntries(ROOT_NAMES.map((t) => [t, () => lazyRoot(t)]));
  // The root row (spec/surface §1.1, 2.0; spec/oqx 0.18 `rootObject`): the
  // repository, reached as `^$it` from a top-level row (`0^$it` from any depth).
  // Its own enumerable keys are the five collections in `ROOT_NAMES` order —
  // lazy getters, so `entries(^$it)` names them without running a scan and
  // `^$it.docs` is the same handle as `^docs` — and `get` answers `id` with the
  // repository id (an attribute, not an entry). Tagged so `get` recognizes it.
  const rootRow: RootRow = Object.defineProperties(
    { [ROOT_ROW]: true } as RootRow,
    Object.fromEntries(ROOT_NAMES.map((t) => [t, { enumerable: true, get: () => lazyRoot(t) }])),
  );

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
  // All of a doc's authored properties as OQX entries, for `entries(frontmatter)`
  // / `entries(inline)` / `entries(data)`: one entry per TOP-LEVEL key, valued by
  // the same scalar-vs-list rule as a bare read (`docProp`), with flattened dotted
  // keys (`logging.level`) folded back into one nested entry. `data` (source
  // null) is frontmatter ∪ inline — the keys deduped, each valued by the merged
  // read. Keys come in the properties table's deterministic order — by key —
  // because authored key position is not indexed (`ord` is the position WITHIN
  // a list-valued key).
  const docPropEntries = (docId: string, source: string | null): unknown[] => {
    const keys = (source
      ? all(`SELECT DISTINCT key FROM properties WHERE doc_id = ? AND source = ? AND deleted_commit IS NULL ORDER BY key`, docId, source)
      : all(`SELECT DISTINCT key FROM properties WHERE doc_id = ? AND source IN ('frontmatter', 'inline') AND deleted_commit IS NULL ORDER BY key`, docId)
    ).map((r) => String(r.key));
    const tops: string[] = [];
    const seen = new Set<string>();
    for (const k of keys) {
      const top = k.split(".")[0]!;
      if (!seen.has(top)) { seen.add(top); tops.push(top); }
    }
    return tops.map((t) => semantics.makeEntry(t, docProp(docId, t, source ?? undefined)));
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
  const rel: Record<Kind, Record<string, (row: Row) => Row[] | Row | undefined>> = {
    docs: {
      nodes: (r) => docNodesInOrder(r.doc_id, r.path),
      blocks: (r) => tagAll(docBlocksPreorder(r.doc_id, r.path).map((x) => x.row), "blocks"),
      // A document's revision list (spec/surface §1.2, 4.7), oldest first.
      revisions: (r) => docRevisions(r.doc_id),
      // The linked / linking DOCUMENTS are reached through the link rows (3.0
      // follow-up, §9: the `out` / `in` relations are gone): `out_links collect
      // distinct { from dst }` and `in_links collect distinct { from doc }`.
      out_links: (r) => tagAll(all(`SELECT e.*, ? AS __path FROM edges e WHERE e.src_doc = ? AND e.to_commit IS NULL ORDER BY e.predicate, e.edge_id`, r.path, r.doc_id), "links"),
      in_links: (r) => tagAll(all(
        `SELECT e.*, d.path AS __path FROM edges e JOIN docs d ON d.doc_id = e.src_doc
         WHERE e.dst_node = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL ORDER BY e.predicate, e.edge_id`, r.doc_id), "links"),
    },
    blocks: {
      children: (r) => tagAll(all(`SELECT b.*, ? AS __path FROM blocks b WHERE b.parent_block = ? AND b.deleted_commit IS NULL ORDER BY b.ordinal, b.block_id`, r.__path, r.block_id), "blocks"),
      nodes: (r) => tagAll(all(`SELECT n.*, ? AS __path FROM nodes n WHERE n.block_id = ? ORDER BY n.span_start, n.node_id`, r.__path, r.block_id), "nodes"),
      out_links: (r) => tagAll(all(`SELECT e.*, ? AS __path FROM edges e WHERE e.src_block = ? AND e.to_commit IS NULL ORDER BY e.predicate, e.edge_id`, r.__path, r.block_id), "links"),
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
    links: {},
    revisions: {},
  };

  const jattr = (row: Row, k: string): unknown => {
    const a = row.attrs;
    const o = typeof a === "string" ? parseJson(a) : a;
    return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  };

  // Owning-entity reach-through (single row) with FOREIGN-KEY ELIMINATION
  // (spec/surface §1, 3.0): the owner is handed out as a LAZY row whose identity
  // columns are already known from the child — a block's/node's `doc_id` and
  // `__path` name its document, an edge's `src_doc` and `__path` its source doc,
  // a node's `block_id` (+ `doc_id`, `__path`) its block — so `doc.id` and
  // `doc.path` (and `block.id`/`block.path`/`block.doc_id` on a node) read
  // those columns and run NO statement, exactly like the bare `doc_id`; the full
  // owner row is loaded on the first read of anything else (`doc.layer`,
  // `block.text`). The translator mirrors this in SQL (`doc.id` → the FK
  // column). A Proxy over the backing object so the engine sees a plain tagged
  // row either way (indexing, rendering, `rowRef`).
  const lazyOwner = (known: Record<string, unknown>, t: Kind, load: () => Record<string, unknown> | undefined): Row | undefined => {
    const backing: Row = tag({ ...known }, t)!;
    const knownKeys = new Set<string>(Object.keys(known));
    let filled = false;
    const fill = (): void => {
      if (filled) return;
      filled = true;
      const full = load();
      if (full) Object.assign(backing, full);
    };
    // Only an unknown STRING key is a column read worth the load: symbols (the
    // target tag, the context's own row markers, `Symbol.iterator` probes) are
    // never store columns.
    const loads = (prop: string | symbol): boolean => typeof prop === "string" && !knownKeys.has(prop);
    const proxy = new Proxy(backing, {
      get(target, prop, receiver) {
        if (loads(prop)) fill();
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) { if (loads(prop)) fill(); return Reflect.has(target, prop); },
      ownKeys(target) { fill(); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, prop) { if (loads(prop)) fill(); return Reflect.getOwnPropertyDescriptor(target, prop); },
    });
    return proxy;
  };
  const owningDoc = (row: Row): Row | undefined => {
    const id = row.doc_id ?? row.src_doc;
    if (id == null) return undefined;
    const path = row.__path;
    if (typeof path !== "string") return tag(one(`SELECT * FROM docs WHERE doc_id = ?`, id), "docs");
    return lazyOwner({ doc_id: id, path }, "docs", () => one(`SELECT * FROM docs WHERE doc_id = ?`, id));
  };
  // `dst` on a link row (spec/surface §1.2, 3.0 follow-up): the destination
  // DOCUMENT row when the link points at one (`dst_kind == "document"` and the
  // document exists — a phantom target has the kind and no row), read by
  // `dst_id` exactly as `dst_path` is; absent for a `block` or `external`
  // destination (never reached into). `doc` stays the source document.
  const destinationDoc = (row: Row): Row | undefined => {
    if (row.dst_kind !== "document") return undefined;
    return tag(one(`SELECT * FROM docs WHERE doc_id = ?`, row.dst_node), "docs");
  };
  // `doc` on a revision row (spec/surface §1.2, 4.7): the document's CURRENT
  // live row — the revision's `path` may be an earlier one — and absent (the
  // single-with-no-row marker, as `dst` on a dangling link) for a tombstoned
  // document: its revisions are rows, `doc == null` tells them apart.
  const revisionDoc = (row: Row): Row | undefined =>
    tag(one(`SELECT * FROM docs WHERE doc_id = ? AND deleted_commit IS NULL`, row.doc_id), "docs");
  const owningBlock = (row: Row): Row | undefined => {
    if (!row.block_id) return undefined;
    const load = (): Record<string, unknown> | undefined =>
      one(`SELECT b.*, d.path AS __path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?`, row.block_id);
    if (typeof row.__path !== "string") return tag(load(), "blocks");
    return lazyOwner({ block_id: row.block_id, doc_id: row.doc_id, __path: row.__path }, "blocks", load);
  };
  // `block` on a link row (spec/surface §1.2, 4.11): the SOURCE block the link
  // was written in — the blocks row `block_id` (the edge's `src_block`) names,
  // in the source document (`__path` is already the block's document path) —
  // mirroring `doc`; absent when the link has none (a frontmatter link).
  const linkBlock = (row: Row): Row | undefined => {
    if (!row.src_block) return undefined;
    const load = (): Record<string, unknown> | undefined =>
      one(`SELECT b.*, d.path AS __path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?`, row.src_block);
    if (typeof row.__path !== "string") return tag(load(), "blocks");
    return lazyOwner({ block_id: row.src_block, doc_id: row.src_doc, __path: row.__path }, "blocks", load);
  };

  // ---- engine attributes -----------------------------------------------------
  // Bare, snake_case, winning on collision (see the name rule above; spec/surface
  // §1.2, 3.0). `path` (and the edge field `dst_path`) is the REFERENCE form
  // (`/a/b.md`, §1 "Paths", 2.0): the rows carry the storage form (`path`, the
  // `__path` join column) and the read roots it, so nothing below the binding
  // changes. run.ts roots the string literals a query compares them with.
  // `undefined` means "not an attribute" — the caller falls through to the
  // handles, relations and the author's data.
  const attribute = (row: Row, t: Kind, name: string): unknown => {
    if (t === "docs") switch (name) {
      case "id": return row.doc_id;
      case "path": return referencePath(String(row.path));
      case "hash": return row.file_hash == null ? null : hex(row.file_hash);
      case "updated_at": return scalar(`SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = ?`, row.current_rev) ?? null;
      // `created_at` (4.10): the commit `ts` of the document's first revision
      // (`seq = 1`, the row `revisions first { ts values }` reads) — when
      // omgbase first observed the document, not a filesystem time. The
      // retention squash (spec/store §7.1, 15.0) keeps every revision and
      // commit row, so the value survives archiving.
      case "created_at": return scalar(`SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.doc_id = ? AND r.seq = 1`, row.doc_id) ?? null;
      // `raw`: the exact file bytes (spec/store §6.1, frontmatter included).
      case "raw": return docsRead(store, String(row.doc_id))?.raw ?? null;
      // `title`: the computed title (spec/properties §3.3 — the authored
      // title, else the first H1, else absent → null). `data.title` is the
      // authored one alone.
      case "title": return docProp(String(row.doc_id), "$title", "computed") ?? null;
      // `tags`: the union of the authored tags (frontmatter + inline, by the
      // property rule) and the body `#hashtags` (the computed `$tags` row,
      // spec/properties §3.3), deduped, authored first in authored order, then
      // the hashtags in document order; null when both are absent.
      // `data.tags` is the authored list alone.
      case "tags": return docTags(String(row.doc_id));
      case "format": return row.format;
    }
    if (t === "blocks") switch (name) {
      case "id": return row.block_id;
      case "path": return referencePath(String(row.__path));
      // `raw`: the block's raw source bytes — the blob its `raw_hash` names (a
      // container's raw holds its children verbatim); `text` is the normalized text.
      case "raw": return row.raw_hash == null ? null : (scalar(`SELECT bytes FROM blobs WHERE hash = ?`, row.raw_hash) as Buffer | undefined)?.toString("utf8") ?? null;
      case "hash": return row.raw_hash == null ? null : hex(row.raw_hash);
      case "updated_at": return scalar(`SELECT MAX(c.ts) FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?`, row.block_id) ?? null;
      // `created_at` (4.10): the EARLIEST commit `ts` among the block's
      // `block_changes` — the same join as `updated_at` under MIN: the commit
      // that first wrote the id (`inserted`, or the split/merge lineage row
      // that minted it). Store 14.2 keeps that row and the 15.0 squash keeps
      // each block's earliest row (spec/store §7.1), so it survives archiving;
      // a resurrected block keeps its original creation.
      case "created_at": return scalar(`SELECT MIN(c.ts) FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?`, row.block_id) ?? null;
      case "doc_id": return row.doc_id;
      case "type": return row.type;
      case "text": return row.text;
      case "attrs": return parseJson(row.attrs);
      case "ordinal": return row.ordinal;
      case "depth": return row.depth;
    }
    if (t === "nodes") switch (name) {
      case "id": return row.node_id;
      case "path": return referencePath(String(row.__path));
      case "doc_id": return row.doc_id;
      case "block_id": return row.block_id ?? null;
      case "kind": return row.kind;
      case "name": return row.name;
      case "value": return row.value;
      case "attrs": return parseJson(row.attrs);
    }
    if (t === "links") switch (name) {
      // the store's columns under the surface's names (spec/surface §1.2).
      case "id": return row.edge_id;
      case "path": return referencePath(String(row.__path));
      case "doc_id": return row.src_doc;
      case "block_id": return row.src_block ?? null;
      case "via_id": return row.via_node ?? null;
      case "dst_id": return row.dst_node;
      case "dst_path": {
        const p = scalar(`SELECT path FROM docs WHERE doc_id = ?`, row.dst_node);
        return p == null ? null : referencePath(String(p));
      }
      case "uri": return scalar(`SELECT uri FROM external_nodes WHERE node_id = ?`, row.dst_node) ?? null;
      case "field": return row.src_field ?? null;
      case "predicate": case "provenance": case "dst_kind": case "anchor": return row[name];
    }
    if (t === "revisions") switch (name) {
      // the `revisions` × `commits` columns under docs_history's names (spec/surface §1.2, 4.7).
      case "id": case "rev": return row.rev_id;
      case "path": return referencePath(String(row.path));
      case "seq": return row.seq;
      case "doc_id": return row.doc_id;
      case "commit": return row.commit_id;
      case "ts": return row.ts;
      case "origin": return row.origin;
      case "actor": return row.actor ?? null;
      case "reason": return row.reason ?? null;
      case "hash": return hex(row.rendered_hash);
      case "is_current": return row.is_current === 1 || row.is_current === true;
      case "archived": return row.archived === 1 || row.archived === true;
    }
    return undefined;
  };
  // `tags` on a document: authored ∪ hashtags, each list as the property rule
  // reads it (a scalar-authored `tags: x` is one element), deduped by value
  // (canonical JSON, so both engines agree on non-string elements).
  const docTags = (docId: string): unknown => {
    const asList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
    const authored = asList(docProp(docId, "tags"));
    const hashtags = asList(docProp(docId, "$tags", "computed"));
    if (authored.length === 0 && hashtags.length === 0) return null;
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const v of [...authored, ...hashtags]) {
      const k = JSON.stringify(v) ?? "undefined";
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out;
  };

  // ---- get ------------------------------------------------------------------
  const getFrom = (row: unknown, key: string): unknown => {
    if (row == null) return undefined;
    // The root row: `^$it.id` is the repository id, `^$it.<target>` the lazy
    // root scan (the same handle `^<target>` / `root(name)` hands out).
    if ((row as RootRow)[ROOT_ROW]) {
      if (key === "id") return repoId;
      return rootFns[key] ? rootFns[key]!() : undefined;
    }
    if ((row as PropSourceRef)[PROP_SOURCE]) {
      const p = row as PropSourceRef;
      return docProp(p.docId, key, p.source ?? undefined);
    }
    const t = (row as Row)[TARGET];
    if (!t) {
      // a plain value (parsed attrs/json object, or a lifted array element): plain access.
      return (row as Record<string, unknown>)[key];
    }
    const r = row as Row;

    // A `$` name is OQX's (`$it`, `$key`, … — resolved by the engine before
    // the row) or unknown — never an omgbase attribute. Row-scoped domain
    // functions (text/semantic/under_*/…) never arrive here: run.ts rewrites
    // them to `$it.fn(…)`, so they reach callMethod with the row as receiver.

    // engine attributes win on collision (the name rule above).
    if (ATTRIBUTES[t].has(key)) return attribute(r, t, key);

    // self-alias namespaces: `doc.x` (docs), `block.x` (blocks), `section.x` (nodes).
    if (t === "docs" && key === "doc") return r;
    if (t === "blocks" && key === "block") return r;
    if (t === "nodes" && key === "section") return r;

    // reach-through to owning entities, from a link row to its destination and
    // from a revision to its document's current row — statically single
    // relations: absent is the single-with-no-row marker.
    if (t === "revisions" && key === "doc") return revisionDoc(r) ?? ABSENT_SINGLE;
    if (t !== "docs" && key === "doc") return owningDoc(r) ?? ABSENT_SINGLE;
    if (t === "nodes" && key === "block") return owningBlock(r) ?? ABSENT_SINGLE;
    if (t === "links" && key === "dst") return destinationDoc(r) ?? ABSENT_SINGLE;
    if (t === "links" && key === "block") return linkBlock(r) ?? ABSENT_SINGLE;

    // relations.
    const rels = rel[t];
    if (rels[key]) return rels[key]!(r);
    // A bare target name that is not one of this row's relations reads a
    // property the row has none of (spec/surface §1.1, 2.0): loud, naming the
    // root-row spelling. `docs`/`links` never get here (run.ts refuses them
    // statically); `blocks` on a block or edge row, `nodes` on a node or edge
    // row and `revisions` on anything but a document do.
    if (ROOTS.has(key)) throw new FilterInvalid(bareTargetMessage(key, null), "OQX");

    // the author's data.
    if (t === "docs") {
      // The source handles: `data` is the merged authored view (frontmatter +
      // inline), the other two one source each; `data.<k>` reaches an authored
      // key whose bare name is an engine attribute (`data.path`, `data.tags`).
      if (SOURCE_HANDLES.has(key)) return { [PROP_SOURCE]: true, docId: String(r.doc_id), source: key === "data" ? null : key } as PropSourceRef;
      return docProp(String(r.doc_id), key);
    }
    // blocks / nodes: a bare non-structural identifier flattens into attrs:
    // `checked` reads `attrs.checked`. The attributes above win on collision; an
    // absent key is undefined (silently false in a predicate), matching a doc's
    // missing frontmatter key. The `attrs.<k>` form still works unchanged.
    if (t === "blocks" || t === "nodes") return jattr(r, key);
    return undefined;
  };


  // ---- domain functions (row-scoped, via callMethod on `$it`) ---------------
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

  const textMatch = (t: Kind | undefined, r: Row, terms: string): boolean => {
    if (t === "links" || t === "revisions") throw new FilterInvalid(`text(...) is not available on the ${t} target`, "10 §5");
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
  const semanticScore = (t: Kind | undefined, r: Row, phrase: string): number | null => {
    if (t === "nodes" || t === "links" || t === "revisions") throw new FilterInvalid("semantic(...) is available on the docs and blocks targets", "OQX semantic");
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
  // A row's identity — `$key` (spec/oqx §16, 0.20): its id column for every
  // kind; anything else (a property bag, a lifted value) is known structurally.
  const identity = (row: unknown): unknown => {
    const t = (row as Row)?.[TARGET];
    if (t === "docs") return (row as Row).doc_id;
    if (t === "blocks") return (row as Row).block_id;
    if (t === "nodes") return (row as Row).node_id;
    if (t === "links") return (row as Row).edge_id;
    if (t === "revisions") return (row as Row).rev_id;
    return row;
  };

  return {
    // The root scope's names (spec/oqx §2 step 5 at the root): the five lazy
    // scans and `id`, the repository id — so `^docs` / `0^docs` from any row is
    // the scan and `^id` / `0^id` the id.
    root(name: string): unknown {
      if (opts.rowsRoot && name === opts.rowsRoot.name) return opts.rowsRoot.rows;
      if (name === "id") return repoId;
      return rootFns[name] ? rootFns[name]!() : undefined;
    },
    // The root scope's row (oqx 0.18): the repository, so `^$it` from a
    // top-level row is the root row and `^$it.docs` the docs scan.
    rootObject(): unknown {
      return rootRow;
    },
    get: getFrom,
    // Row position (spec/oqx §3): a tagged row is ONE row (single — the engine's
    // default for a non-iterable object), a lazy scan (an iterable Proxy) a
    // collection, the absent-single marker one row with none.
    toRows(value: unknown): Iterable<unknown> {
      if (value == null || value === ABSENT_SINGLE) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === "object" && (value as Row)[TARGET]) return [value];
      if (typeof value === "object" && Symbol.iterator in (value as object)) return value as Iterable<unknown>;
      return [value];
    },
    // Value position: the absent-single marker is absent.
    materialize(value: unknown): unknown {
      return value === ABSENT_SINGLE ? undefined : value;
    },
    identityOf: identity,
    // A store-backed equality index for a ROOT SCAN handle on a column or
    // property SQLite indexes (store-index.ts); `undefined` for any other
    // collection (a relation's rows, a lifted array) or path, so the engine
    // builds its own over the materialized rows.
    indexFor(collection: unknown, path: readonly string[]): RowIndex | undefined {
      if (collection === null || typeof collection !== "object") return undefined;
      const root = rootScans.get(collection);
      // The revisions scan has no store index (4.7): the engine builds its own
      // over the materialized rows (one SELECT per context).
      if (!root || root.target === "revisions") return undefined;
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
      // `entries(data)` / `entries(frontmatter)` / `entries(inline)`: the source
      // handle is lazy (a PropSourceRef, not a plain object), so materialize its
      // property bag as entries here; any other argument falls through to the
      // oqx builtin.
      if (name === "entries" && (args[0] as PropSourceRef | undefined)?.[PROP_SOURCE]) {
        const p = args[0] as PropSourceRef;
        return { handled: true, value: docPropEntries(p.docId, p.source) };
      }
      if (name === "refs") return { handled: true, value: refs(args[0]) };
      // `date(x)` / `dur(x)` (spec/surface §1.3 "Dates and durations", 4.8):
      // pure over their argument except the named points, which read the host
      // clock (pinned by the spec clock seam). run.ts folds a literal argument
      // before planning, so the arm here serves the non-literal ones.
      const dated = dateFunction(name, args);
      if (dated.handled) return dated;
      if (name === "range") {
        const s = args[0];
        if (semantics.isRange(s)) return { handled: true, value: s };
        const rv = typeof s === "string" ? detectRange(s) : null;
        return { handled: true, value: rv ? semantics.makeRange(rv.lo, rv.hi, rv.exclusiveEnd) : null };
      }
      const fn = semantics.BUILTIN_FUNCTIONS[name];
      return fn ? { handled: true, value: fn(args) } : { handled: false };
    },
    // Domain methods first, then the date methods (`plus`/`minus`/`until`/the
    // fields/`format` on a date string, `dur_text`/`dur_iso` on a number —
    // §1.3 4.8; total: any other receiver is absent); fall back to oqx-js
    // builtin methods (contains/startsWith/endsWith/matches/size/lower/upper).
    callMethod(name: string, recv: unknown, args: unknown[]): CallResult {
      const r = method(name, recv, args);
      if (r.handled) return r;
      const dated = dateMethod(name, recv, args);
      if (dated.handled) return dated;
      const fn = semantics.BUILTIN_METHODS[name];
      return fn ? { handled: true, value: fn(recv, args) } : { handled: false };
    },
  };
}

function requireTarget(t: Kind | undefined, want: Target, fn: string): void {
  if (t !== want) throw new FilterInvalid(`${fn}() is only available on the ${want} target`, "10 §5");
}
function hex(b: unknown): string {
  return Buffer.isBuffer(b) ? b.toString("hex") : String(b);
}

/** Tag SQL rows with their target so the store context resolves them (used by the
 * tier-3 planner to hand produced rows back for residual evaluation). */
export function tagRows(rows: Record<string, unknown>[], target: Kind): unknown[] {
  return tagAll(rows, target);
}

/**
 * A store row surfacing as a VALUE in a result (spec/surface §1.4, rows as
 * values, 1.2) is rendered as `{ id, path }` (3.0) — its id column and its
 * document's path in the reference form (`/a.md`, §1 "Paths"), the same two keys
 * every hit carries, spelled as the attributes that read them — never the store
 * row itself.
 * Returns undefined for anything that is not a tagged row (run.ts leaves those
 * alone).
 */
export function rowRef(value: unknown): { id: string; path: string } | undefined {
  const t = (value as Row | null | undefined)?.[TARGET];
  if (!t) return undefined;
  const r = value as Row;
  const id = t === "docs" ? r.doc_id : t === "blocks" ? r.block_id : t === "nodes" ? r.node_id : t === "revisions" ? r.rev_id : r.edge_id;
  // a revision's path is `revisions.path` — the path it was committed under
  // (a move re-paths the current revision; §1.2, 4.7).
  const path = t === "docs" || t === "revisions" ? r.path : r.__path;
  return { id: String(id), path: path == null ? "" : referencePath(String(path)) };
}

export { TARGET };
