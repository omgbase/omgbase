// omgbase's OQX entry point, served by `@omgbase/oqx`: parse the source, run it
// through the in-memory engine over a store-backed DataContext (context.ts), and
// shape the engine's result into omgbase's OqxResult (lean {id, path, …} hits,
// keyset pagination, count/exists scalars). Same signature + shape as the former
// in-tree compiler, so every caller and the corpus are unchanged.

import { parse, PlannedEngine, InMemoryEngine, OqxError, resolveAliases, transform, visit, build, semantics } from "@omgbase/oqx";
import type { Engine } from "@omgbase/oqx";
import type { Query, Expr, SelectItem } from "@omgbase/oqx";
import { makeStoreContext, rowRef, type StoreContextOptions } from "./context.js";
import { SQLiteQueryPlanner, rootTarget } from "./planner.js";
import type { Store } from "../core/store/store.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type { SemanticVec } from "../search/cel/compile.js";
import { float32ToBlob } from "../core/vec.js";
import { encodeCursor as encodeKeyset, decodePathCursor } from "../core/cursor.js";
import { referencePath } from "../core/paths.js";

export type OqxConsumer = "collect" | "count" | "exists" | "none" | "first" | "single";

export type EmbedQuery = (text: string) => Promise<{ model: string; vec: Float32Array }>;

export interface OqxHit {
  id: string;
  path: string;
  [k: string]: unknown;
}

export interface OqxResult {
  hits: OqxHit[];
  truncated: boolean;
  cursor: string | null;
  consumer: OqxConsumer;
  count?: number;
  exists?: boolean;
  /** The `none` consumer's result: true iff the query yields no rows. */
  none?: boolean;
  /** Present for a top-level `values` projection (`select <expr> values`): the
   * bare projected values in page order, in place of `hits` (which is then
   * empty). Paged/deduped exactly like hits — `truncated`/`cursor` apply. For
   * first/single it holds zero or one value. */
  values?: unknown[];
}

export interface OqxOptions {
  limit?: number;
  cursor?: string | null;
  semanticVectors?: Map<string, SemanticVec>;
  /** Force the pure in-memory engine (skip tier-3 pushdown). Internal — used by
   * the differential conformance suite to prove planned == in-memory. */
  plan?: boolean;
}

// Row-scoped domain functions: authored as free calls (`text("x")`) that
// implicitly reference the current row. `@omgbase/oqx` free functions receive no
// row, so we rewrite them to `$self.fn(…)` (a method whose receiver is the row)
// — one `transform` over the AST (spec/oqx/AST.md §5), every block included.
// `refs(x)` is NOT here: it reads no row (its argument is the value), so it stays
// a free function served by the context's `callFunction`. The planner treats
// every call alike (translate declines it; `exprMayRaise` flags it), `has_edge`
// and `refs` included.
const ROW_FNS = new Set([
  "text", "semantic", "under", "under_heading", "within", "under_kind",
  "yaml_path", "json_pointer", "has_edge", "has_anchor", "child_count", "parent_type",
]);

// Paths on the surface are the reference form (spec/surface §1 "Paths", 2.0):
// `$path` and `$dst_path` read `/a/b.md`. A string literal a query compares
// with one of them — `$path == "a.md"`, `"a.md" != $dst_path`,
// `$path.startsWith("lab/")` — is rooted first, so both spellings match; a
// property or binding compared with a path is never touched (it is the
// author's value). The planner sees the rewritten tree too, so the pushed SQL
// and the in-memory engine agree by construction.
const PATH_INTRINSICS = new Set(["$path", "$dst_path"]);
function isPathRead(e: Expr): boolean {
  return (e.kind === "ident" || e.kind === "outer" || e.kind === "member") && PATH_INTRINSICS.has(e.name);
}
function rootLiteral(e: Expr): Expr {
  return e.kind === "lit" && typeof e.value === "string" ? { ...e, value: referencePath(e.value) } : e;
}
export function rootPathLiterals(e: Expr): Expr {
  if (e.kind === "binary" && (e.op === "==" || e.op === "!=")) {
    if (isPathRead(e.left)) return { ...e, right: rootLiteral(e.right) };
    if (isPathRead(e.right)) return { ...e, left: rootLiteral(e.left) };
  }
  if (e.kind === "call" && e.recv !== null && e.name === "startsWith" && e.args.length === 1 && isPathRead(e.recv)) {
    return { ...e, args: [rootLiteral(e.args[0]!)] };
  }
  return e;
}

function rewriteQuery(q: Query): Query {
  return transform(q, (e) => (e.kind === "call" && e.recv === null && ROW_FNS.has(e.name) ? { ...e, recv: build.ident("$self") } : rootPathLiterals(e)));
}

// A top-level `limit`/`offset` on the collect path is applied by the runner (see
// oqxRunInner), so it must be a plain number literal here — there is no row to
// evaluate anything else against at the root, and omgbase queries carry no
// bindings.
function constBound(e: Expr | null, word: string): number | null {
  if (!e) return null;
  if (e.kind === "lit" && typeof e.value === "number" && Number.isInteger(e.value) && e.value >= 0) return e.value;
  throw new FilterInvalid(`top-level ${word} must be a non-negative integer literal`, "OQX");
}

// Distinct phrases referenced by `semantic("…")` (free calls in the raw parse),
// found by one `visit` over the whole tree.
export function collectSemanticPhrases(source: string): string[] {
  let q: Query;
  try { q = parse(source); } catch { return []; }
  const phrases = new Set<string>();
  visit(q, {
    enter(node) {
      if (node.kind === "call" && node.recv === null && node.name === "semantic") {
        const arg = node.args[0];
        if (arg?.kind === "lit" && typeof arg.value === "string") phrases.add(arg.value);
      }
    },
  });
  return [...phrases];
}

const ID_ITEM: SelectItem = build.field("__oqx_id", build.ident("$id"));
const PATH_ITEM: SelectItem = build.field("__oqx_path", build.ident("$path"));
// A hit is a store row (spec/surface §1.4, 1.5). The engine's top-level rows
// are store rows by construction when the source is a bare root scan and
// nothing re-projects them; a `follow` destination (`follow before` over a
// frontmatter list of paths), a `from E` re-projection or any other source can
// reach a scalar, which the injected `$id`/`$path` reads would render as the
// junk hit `{ id: "undefined", path: "" }`. For those queries the row itself is
// projected too (`$it`), and `toHit` fails the query when it is not a row. Only
// then: a row clone per hit is free here but not in the Rust port, and a root
// scan cannot need it. A `values` projection returns no hits, so it is exempt
// (`from docs from tags select $it values` is a flat list of tags).
const SELF_KEY = "__oqx_self";
const SELF_ITEM: SelectItem = build.field(SELF_KEY, build.ident("$it"));
function mayReachNonRows(q: Query): boolean {
  return q.follow !== null || q.from.length > 0 || rootTarget(q.source) === null;
}
function describeValue(v: unknown): string {
  if (v === null || v === undefined) return "an absent value";
  if (typeof v === "string") return `a string (${JSON.stringify(v)})`;
  if (typeof v === "number") return `a number (${String(v)})`;
  if (typeof v === "boolean") return `a boolean (${String(v)})`;
  if (Array.isArray(v)) return "an array";
  if (semantics.isRange(v)) return "a range";
  return "an object";
}
function notAStoreRow(v: unknown): FilterInvalid {
  return new FilterInvalid(
    `a hit must be a document, block, node or edge row — the query reached ${describeValue(v)}; to follow document references held in a property use refs(<field>)`,
    "OQX",
  );
}
// The reserved key a top-level `values` projection's single item is renamed to,
// so it rides through id/path injection, keyset paging, and distinct as an
// ordinary record field and is peeled off at the end.
const VALUE_KEY = "__oqx_value";

// Rows as values (spec/surface §1.4, 1.2). The engine hands back store rows
// wherever the projection made a row a VALUE — a nested `collect { }` /
// `first { }` / `single { }` with an empty projection ("the row itself",
// spec/oqx §12), a `values` projection of `$it`/`$self`, a field bound to a
// row — and a store row is not a wire shape (column names, `attrs` as a JSON
// string, the `__path` join column, Buffers). Walk the projected value and
// render every tagged row as `{ id, path }`; everything else passes through
// untouched (plain records and arrays are descended, scalars kept). Hits are
// records the engine built from the injected id/path items, never rows.
function renderValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const ref = rowRef(v);
  if (ref) return ref;
  if (Array.isArray(v)) return v.map(renderValue);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v; // Buffer, Map, … — not a record
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = renderValue(x);
  return out;
}

function toHit(row: unknown): OqxHit {
  const o = row as Record<string, unknown>;
  const { __oqx_id, __oqx_path, __oqx_self, ...rest } = o;
  if (SELF_KEY in o && !rowRef(__oqx_self)) throw notAStoreRow(__oqx_self);
  return { id: String(__oqx_id), path: String(__oqx_path ?? ""), ...(renderValue(rest) as Record<string, unknown>) };
}

// Top-level `select distinct`: dedup hits by their USER projection (every field
// except the injected id/path), keeping the first (so the retained hit carries a
// real id/path). Order-preserving.
function dedupHitsByProjection(hits: OqxHit[]): OqxHit[] {
  const seen = new Set<string>();
  const out: OqxHit[] = [];
  for (const h of hits) {
    const { id: _id, path: _path, ...proj } = h;
    void _id; void _path;
    const key = JSON.stringify(Object.keys(proj).sort().map((k) => [k, proj[k]]));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function oqxRun(store: Store, repoId: string, source: string, opts: OqxOptions = {}): OqxResult {
  try {
    return oqxRunInner(store, repoId, source, opts);
  } catch (e) {
    // Normalize the library's errors to omgbase's contract (filter_invalid).
    if (e instanceof OqxError) throw new FilterInvalid(e.message, "OQX");
    throw e;
  }
}

function oqxRunInner(store: Store, repoId: string, source: string, opts: OqxOptions): OqxResult {
  // The query's `select` aliases are resolved HERE, once, before the runner
  // renames/injects items (an engine evaluates the query it is given).
  const parsed = rewriteQuery(resolveAliases(parse(source)));
  const consumer = parsed.consumer as OqxConsumer;
  const ctxOpts: StoreContextOptions = opts.semanticVectors ? { semanticVectors: opts.semanticVectors } : {};
  const ctx = makeStoreContext(store, repoId, ctxOpts);
  // Tier-3 pushdown reduces the scan in SQL; the in-memory fallback finishes the
  // residual (and runs anything not pushable), so results match a pure scan.
  const engine: Engine = opts.plan === false
    ? new InMemoryEngine(ctx)
    : new PlannedEngine(new SQLiteQueryPlanner(store, repoId, ctxOpts), ctx);

  if (consumer === "exists") {
    const res = engine.run(parsed, []);
    return { hits: [], truncated: false, cursor: null, consumer: "exists", exists: res.consumer === "exists" ? res.exists : false };
  }
  if (consumer === "count") {
    const res = engine.run(parsed, []);
    return { hits: [], truncated: false, cursor: null, consumer: "count", count: res.consumer === "count" ? res.count : 0 };
  }
  if (consumer === "none") {
    const res = engine.run(parsed, []);
    return { hits: [], truncated: false, cursor: null, consumer: "none", none: res.consumer === "none" ? res.none : true };
  }

  // collect / first / single: inject id + path so every hit carries them. A
  // top-level `select distinct` is applied HERE, not in the engine: the injected
  // id/path are unique per row and would defeat the engine's projection dedup, so
  // we run without engine-distinct and dedup hits by their USER projection below,
  // keeping the first row's id/path.
  const topDistinct = parsed.distinct;
  // A top-level `values` projection runs as a RECORD projection whose single
  // item is renamed to VALUE_KEY (the engine's own values mode is switched off),
  // so pagination and distinct work unchanged; the bare values are peeled off
  // the final page below and returned as `values` with `hits` empty.
  const topValues = parsed.values;
  const userSelect = topValues ? [{ ...parsed.select[0]!, name: VALUE_KEY }] : parsed.select;
  // On the collect path a top-level `limit`/`offset` is ALSO taken out of the
  // engine query and applied here, after the runner's own distinct — the engine
  // would otherwise bound the raw rows before dedup (`select distinct type
  // limit 3` must be three distinct types). first/single keep theirs: the
  // engine's offset-aware cap is exactly right for them.
  const { limit: topLimit, offset: topOffset } = parsed;
  const base = consumer === "collect" ? { ...parsed, limit: null, offset: null } : parsed;
  const guard = !topValues && mayReachNonRows(parsed) ? [SELF_ITEM] : [];
  const q: Query = { ...base, distinct: false, values: false, select: [ID_ITEM, PATH_ITEM, ...guard, ...userSelect] };
  const res = engine.run(q, []);

  if (consumer === "first" || consumer === "single") {
    const row = res.consumer === "first" || res.consumer === "single" ? res.row : null;
    if (topValues) return { hits: [], truncated: false, cursor: null, consumer, values: row == null ? [] : [toHit(row)[VALUE_KEY]] };
    return { hits: row == null ? [] : [toHit(row)], truncated: false, cursor: null, consumer };
  }

  // collect: keyset pagination on (path, id) when the order is the default.
  let rows = (res.consumer === "collect" ? res.rows : []).map(toHit);
  if (topDistinct) rows = dedupHitsByProjection(rows);
  // The query's own bound defines the result SET; the `limit`/`cursor` options
  // then page within it.
  const offset = constBound(topOffset, "offset") ?? 0;
  const limit = constBound(topLimit, "limit");
  if (offset || limit != null) rows = rows.slice(offset, limit == null ? undefined : offset + limit);
  const custom = !!parsed.orderBy && parsed.orderBy.length > 0;
  const cap = opts.limit ?? 50;
  let page = rows;
  if (!custom && opts.cursor) {
    const { path, id } = decodeCursor(opts.cursor);
    page = page.filter((h) => h.path > path || (h.path === path && h.id > id));
  }
  const truncated = page.length > cap;
  page = page.slice(0, cap);
  const last = page[page.length - 1];
  const cursor = truncated && last && !custom ? encodeCursor(last.path, last.id) : null;
  if (topValues) return { hits: [], truncated, cursor, consumer: "collect", values: page.map((h) => h[VALUE_KEY]) };
  return { hits: page, truncated, cursor, consumer: "collect" };
}

export async function oqxRunAsync(
  store: Store, repoId: string, source: string, opts: OqxOptions = {}, embedQuery?: EmbedQuery,
): Promise<OqxResult> {
  const phrases = collectSemanticPhrases(source);
  if (phrases.length === 0) return oqxRun(store, repoId, source, opts);
  if (!embedQuery) throw new FilterInvalid("semantic(...) needs an embedding provider; none is configured", "OQX semantic");
  const semanticVectors = new Map<string, SemanticVec>();
  for (const phrase of phrases) {
    const { model, vec } = await embedQuery(phrase);
    semanticVectors.set(phrase, { model, vec: float32ToBlob(vec) });
  }
  return oqxRun(store, repoId, source, { ...opts, semanticVectors });
}

// The collect page's keyset is (path, id) — the hit's path, so the reference
// form (`/a.md`): the kernel's shared cursor encoding (core/cursor.ts) with a
// two-part tuple. A malformed cursor is CursorInvalid, which the MCP layer maps
// to filter_invalid; so is a cursor whose path is not rooted — one issued by a
// 1.x surface, whose keyset would otherwise sort before every rooted hit and
// silently replay the first page (spec/surface §1.4, 2.0).
function encodeCursor(path: string, id: string): string {
  return encodeKeyset([path, id]);
}
function decodeCursor(cursor: string): { path: string; id: string } {
  const [path, id] = decodePathCursor(cursor, "query", 2);
  return { path: path!, id: id! };
}

/** Parse an OQX source into the `@omgbase/oqx` AST (re-exported for callers). */
export function parseOqx(source: string): Query {
  return parse(source);
}
