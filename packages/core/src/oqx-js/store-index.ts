// Store-backed equality indexes for the OQX engine (`DataContext.indexFor`):
// when a nested block's receiver is a ROOT SCAN (`^docs`, `^links`,
// a bare `docs` at the root scope) and its correlated or constant equality is on
// a column or property SQLite can look up — `where _path == ^^_path`,
// `where customer == ^_path`, `where _dst_id == ^_id`, `where _type == "order"` —
// the probe runs ONE prepared statement against the store's indexes instead of
// materializing every row of the target and hashing it. The rows come back
// exactly as the root scan constructs them (same columns, same `__path`, same
// target tag, same `(path, id)` order) under the same live-row and repo guards
// (`sql/scan.ts`), so every intrinsic and relation keeps working downstream and
// the result cannot differ from the scan — only the work does.
//
// Typed equality (OQX SEMANTICS §5) is preserved by probing per VALUE KIND:
//
//   • a text column (`_id`, `_path`, `_type`, `_kind`, `_name`, `_doc_id`,
//     `_dst_id`, …) matches a string probe by `= ?` (TEXT = TEXT, exact); a
//     number, boolean, object or any other non-string probe matches NO row (the
//     column holds strings or NULL and `5 == "5"` is false); an absent probe
//     (`null`, `undefined`: `_name == null`) is answered by the in-memory
//     fallback below;
//   • a document property (`customer`, `title`) matches a string probe only on
//     a `type = 'string'` row (`val_text = ?`), a number probe only on a
//     `type = 'number'` row (`val_num = ?`), a boolean only on a `type = 'bool'`
//     row (`val_bool = ?`), each under the scalar-in-scope rule the in-memory
//     `docProp` applies (exactly one live row for the key on the document and it
//     is `card = 'scalar'`; a list-valued, repeated or nested key is an array or
//     object in memory and equals no scalar). An object/array probe equals
//     nothing (decoded values are fresh objects; §5 compares them by
//     reference), `NaN` equals nothing; an absent probe (`key == null`: a `null`
//     scalar OR a document lacking the key) is an anti-join SQLite has no index
//     for, so it is answered by the fallback.
//
// The fallback — a probe value no statement covers — reads the collection once
// (the same lazy root scan the engine would have walked) and filters it with
// the context's own `get`, under `semantics.equals`: the engine's own hash
// index could do no better, and the answer is by construction the scan's.
//
// `lookup(value)` (positions into the collection) is implemented for the seam's
// contract but the engine never calls it for these indexes: it probes
// `lookupRows` first and so never reads the root whole.

import type { RowIndex } from "@omgbase/oqx";
import { semantics } from "@omgbase/oqx";
import type Database from "better-sqlite3";
import type { Target } from "./sql/translate.js";
import { COLS, FROM, FROM_BY_DOC, ORDER, guards, guardsByDoc } from "./sql/scan.js";
import { storagePath } from "../core/paths.js";

/** What the context lends an index: the store, the repo, how it tags rows, how
 * it reads a field off a row, and the materialized rows of the root scan the
 * index stands in for (read lazily, only by the fallback). */
export interface StoreIndexDeps {
  db: Database.Database;
  repoId: string;
  tag(rows: Record<string, unknown>[], target: Target): unknown[];
  get(row: unknown, key: string): unknown;
  rows(): unknown[];
  identity(row: unknown): unknown;
}

// ---- which paths SQLite answers ------------------------------------------------

/** The indexed TEXT column (or an equivalent indexed test) a one-segment local
 * path reads, per target — the paths a probe pushes to SQLite. `?` is the
 * probe value. Each is served by a primary key, a `UNIQUE`, or an index of
 * `spec/store/schema.sql`: docs `doc_id` (PK) and `(repo_id, path)`; blocks
 * `block_id` (PK), `idx_blocks_doc (doc_id, …)`, `idx_blocks_type (repo_id,
 * type)`; nodes `node_id` (PK), `idx_nodes_doc`, `idx_nodes_kind`,
 * `idx_nodes_name`; edges `edge_id` (PK), `idx_edges_src (src_doc, …)`,
 * `idx_edges_dst (dst_node, …)`; `path` on a joined target reaches the docs
 * `(repo_id, path)` key and then the target's `doc_id`/`src_doc` index. */
const COLUMN_PROBES: Record<Target, Record<string, string>> = {
  docs: { _id: "d.doc_id = ?", _path: "d.path = ?" },
  blocks: { _id: "b.block_id = ?", _doc_id: "b.doc_id = ?", _type: "b.type = ?", _path: "d.path = ?" },
  nodes: { _id: "n.node_id = ?", _doc_id: "n.doc_id = ?", _kind: "n.kind = ?", _name: "n.name = ?", _path: "d.path = ?" },
  links: {
    _id: "e.edge_id = ?", _doc_id: "e.src_doc = ?", _dst_id: "e.dst_node = ?", _path: "d.path = ?",
    // `_dst_path` is the destination document's path (deleted or not — the
    // field reads `docs` by id without a liveness guard). A destination is
    // resolved within the edge's repo (spec/graph §3), where `(repo_id, path)`
    // is UNIQUE, so the probe is that one document; `?r` is the repo id.
    _dst_path: "e.dst_node IN (SELECT doc_id FROM docs WHERE repo_id = ?r AND path = ?)",
  },
};

type Probe =
  | { kind: "column"; sql: string }
  | { kind: "property"; key: string; source: string | null };

/** How a one-segment path on `target` is probed, or null when SQLite has no
 * index for it (the engine then builds its own over the materialized scan). */
function probeFor(target: Target, path: readonly string[]): Probe | null {
  if (path.length !== 1) return null;
  const key = path[0]!;
  const column = COLUMN_PROBES[target][key];
  if (column) return { kind: "column", sql: column };
  if (target !== "docs") return null;
  // A docs property: any BARE name (spec/surface §1.2, 5.0: the author's data —
  // `title`, `tags`, `layer`, …; an OQX `$` name is never a row read). Of the
  // engine names only `_title` probes (the computed `$title` row, a scalar
  // property): `_raw`, `_hash`, `_updated_at`, `_created_at`, `_tags` (authored
  // ∪ hashtags), `_format` (an unindexed column), the handles and relations have
  // no index and are never property probes.
  if (key === "_title") return { kind: "property", key: "$title", source: "computed" };
  if (key.startsWith("$") || key.startsWith("_")) return null;
  return { kind: "property", key, source: null };
}

// ---- the index ---------------------------------------------------------------------

class StoreIndex implements RowIndex {
  private statements = new Map<string, Database.Statement>();
  private positions: Map<unknown, number> | null = null;

  constructor(
    private readonly target: Target,
    private readonly path: string,
    private readonly probe: Probe,
    private readonly deps: StoreIndexDeps,
  ) {}

  lookupRows(value: unknown): Iterable<unknown> {
    const v = value === undefined ? null : value;
    if (v === null) return this.fallback(null);
    if (this.probe.kind === "column") {
      if (typeof v !== "string") return [];
      // `_path` / `_dst_path` are the reference form in memory (`/a.md`,
      // spec/surface §1 "Paths"); the column holds the storage form. A rooted
      // probe is de-rooted; a bare one can equal no rooted path — no row.
      if (this.path === "_path" || this.path === "_dst_path") return v.startsWith("/") ? this.column(storagePath(v)) : [];
      return this.column(v);
    }
    switch (typeof v) {
      case "string": return this.property("p.type = 'string' AND p.val_text = ?", v);
      case "number": return Number.isNaN(v) ? [] : this.property("p.type = 'number' AND p.val_num = ?", v);
      case "boolean": return this.property("p.type = 'bool' AND p.val_bool = ?", v ? 1 : 0);
      default: return []; // object, array, range, bigint, symbol: equals no decoded scalar
    }
  }

  lookup(value: unknown): readonly number[] {
    if (!this.positions) {
      this.positions = new Map();
      this.deps.rows().forEach((r, i) => this.positions!.set(this.deps.identity(r), i));
    }
    const out: number[] = [];
    for (const r of this.lookupRows(value)) {
      const pos = this.positions.get(this.deps.identity(r));
      if (pos !== undefined) out.push(pos);
    }
    return out.sort((a, b) => a - b);
  }

  // A `_path` probe on a joined target drives from the document (`FROM_BY_DOC`),
  // every other column probe from the target's own index. `?r` in a probe is
  // the repo id, bound ahead of the value.
  private column(value: string): unknown[] {
    const t = this.target;
    const probe = (this.probe as { sql: string }).sql;
    const byDoc = t !== "docs" && this.path === "_path";
    const g = byDoc ? guardsByDoc(t as Exclude<Target, "docs">, this.deps.repoId) : guards(t, this.deps.repoId);
    const from = byDoc ? FROM_BY_DOC[t as Exclude<Target, "docs">] : FROM[t];
    const params = probe.includes("?r") ? [this.deps.repoId, value] : [value];
    const sql = `SELECT ${COLS[t]} FROM ${from} WHERE ${g.sql} AND ${probe.replace("?r", "?")} ORDER BY ${ORDER[t]}`;
    return this.run(sql, [...g.params, ...params]);
  }

  // The scalar-in-scope rule as SQL: the document has exactly one live row for
  // the key (within the source, for a sourced read) and that row is a scalar of
  // the probe's type with the probe's value. The loop is driven from the
  // properties index (`CROSS JOIN`: `idx_props_key_text` / `idx_props_key_num`,
  // `(repo_id, key, val_*)`) and reaches the document by primary key; the count
  // runs per candidate only, and with it at one no document repeats.
  private property(typed: string, bound: unknown): Iterable<unknown> {
    const { key, source } = this.probe as { key: string; source: string | null };
    const src = source === null ? "" : " AND p.source = ?";
    const src2 = source === null ? "" : " AND p2.source = ?";
    const g = guards("docs", this.deps.repoId);
    const sql = `SELECT d.* FROM properties p CROSS JOIN docs d ON d.doc_id = p.doc_id
      WHERE p.repo_id = ? AND p.key = ? AND ${typed} AND p.card = 'scalar'${src}
        AND ${g.sql}
        AND (SELECT COUNT(*) FROM properties p2 WHERE p2.doc_id = d.doc_id AND p2.key = ?${src2}) = 1
      ORDER BY ${ORDER.docs}`;
    const params = [this.deps.repoId, key, bound, ...(source === null ? [] : [source]), ...g.params, key, ...(source === null ? [] : [source])];
    return this.run(sql, params);
  }

  private run(sql: string, params: unknown[]): unknown[] {
    let stmt = this.statements.get(sql);
    if (!stmt) this.statements.set(sql, (stmt = this.deps.db.prepare(sql)));
    return this.deps.tag(stmt.all(...params) as Record<string, unknown>[], this.target);
  }

  // The scan's own answer for a probe no statement covers.
  private fallback(value: unknown): unknown[] {
    return this.deps.rows().filter((r) => semantics.equals(this.deps.get(r, this.path), value));
  }
}

/** A store-backed `RowIndex` for the root scan of `target` on `path`, or
 * `undefined` when SQLite has no index for the path (per-target table above;
 * multi-segment paths; `_format`, edge `_predicate`/`_field`, `_tags`, …). */
export function storeIndexFor(target: Target, path: readonly string[], deps: StoreIndexDeps): RowIndex | undefined {
  const probe = probeFor(target, path);
  return probe ? new StoreIndex(target, path[0]!, probe, deps) : undefined;
}

/** The paths `storeIndexFor` answers from SQLite, per target (for tests and docs). */
export function indexablePaths(target: Target): readonly string[] {
  const cols = Object.keys(COLUMN_PROBES[target]);
  return target === "docs" ? [...cols, "_title", "<property key>"] : cols;
}
