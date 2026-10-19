// omgbase's OQX entry point, served by `@omgbase/oqx`: parse the source, run it
// through the in-memory engine over a store-backed DataContext (context.ts), and
// shape the engine's result into omgbase's OqxResult (lean {id, path, …} hits
// — the envelope keys ARE the attributes, spec/surface §1.4 3.0 — keyset
// pagination, count/exists scalars). Same signature + shape as the former
// in-tree compiler, so every caller and the corpus are unchanged.

import { parse, PlannedEngine, InMemoryEngine, OqxError, resolveAliases, transform, visit, build, semantics } from "@omgbase/oqx";
import type { Engine } from "@omgbase/oqx";
import type { Query, Expr, SelectItem } from "@omgbase/oqx";
import { makeStoreContext, rowRef, type StoreContextOptions } from "./context.js";
import { SQLiteQueryPlanner } from "./planner.js";
import { REPO_REMOVED_MESSAGE, ROOTS, bareTargetMessage, pastRootMessage, unknownTargetMessage } from "./root-row.js";
import { checkNames, type UnknownNames } from "./names.js";
import { DATE_FUNCTIONS, DATE_METHODS, dateFunction, dateMethod } from "./dates.js";
import type { Store } from "../core/store/store.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type { SemanticVec } from "../search/cel/compile.js";
import { float32ToBlob } from "../core/vec.js";
import { encodeCursor as encodeKeyset, decodePathCursor } from "../core/cursor.js";
import { referencePath } from "../core/paths.js";
import { canonicalJson } from "../mutate/canonical.js";

export type OqxConsumer = "collect" | "count" | "exists" | "none" | "first" | "single";

export type EmbedQuery = (text: string) => Promise<{ model: string; vec: Float32Array }>;

/** A query hit (spec/surface §1.4, 3.0): the row's identity under the SAME
 * bare names the expression language reads — `id`, `path` — plus whatever
 * `select` projected. A key copied from a hit is valid in the next `where` with
 * no translation (`where id == "<hit.id>"`); a `select id, path` is simply the
 * envelope, and any other projection whose output key would be `id` or `path`
 * must be aliased (`envelopeCollision`). */
export interface OqxHit {
  id: string;
  path: string;
  [k: string]: unknown;
}

export interface OqxResult {
  /** `{ id, path, ...projection }` per hit — or, under `OqxOptions.bare`, the
   * projection alone (`id`/`path` present only when the query projected them;
   * typed as `OqxHit` for the one hit shape every consumer handles, a bare
   * caller knows it asked). */
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
  /** Unknown names (spec/surface §1.5, 4.6): one line per name the query reads
   * that is neither a field of its row kind nor a property any object of that
   * kind in the repository carries — the rows are still returned. First-
   * reference order, deduplicated; absent when there is none (never `[]`).
   * Last member of the result, after everything above. */
  hints?: string[];
}

export interface OqxOptions {
  limit?: number;
  cursor?: string | null;
  /** Return each hit as its PROJECTION only — no automatic `id`/`path`
   * members (spec/surface §1.4, 4.2): `select title, era from docs` yields
   * `{ title, era }` rows. Needs a `select` (without a projection a hit is
   * only its envelope) and is refused with `values` (already the bare-values
   * form); both are `filter_invalid` before the engine runs. A projected
   * `id`/`path` is the intrinsic as everywhere (`select id` → `{ id }`), and
   * with no envelope there is nothing to collide with (`select path: layer`
   * is fine). Paging, `distinct`, `truncated` and `cursor` are unchanged —
   * the runner keeps identity internally and strips the envelope last. The
   * scalar consumers (`count`/`exists`/`none`) have no hits and ignore it. */
  bare?: boolean;
  semanticVectors?: Map<string, SemanticVec>;
  /** Force the pure in-memory engine (skip tier-3 pushdown). Internal — used by
   * the differential conformance suite to prove planned == in-memory. */
  plan?: boolean;
  /** What a tier-3 name on an open kind does (spec/surface §1.5, 4.6; a tier-3
   * name on `links` is `filter_invalid` either way): `"hint"` records it in
   * `hints` and runs the query — the default of the source entry (`oqxRun`,
   * every read); `"refuse"` throws `filter_invalid` before any row is read —
   * the default of the AST entry (`oqxRunQuery`), whose caller is the write
   * selector compiler, where a name no row carries would select every row. */
  unknownNames?: UnknownNames;
  /** The `query` call as the caller received it (spec/surface 4.11): the
   * arguments a corrected call is spelled from when a parse error can be fixed
   * (`data.fix`, the bracket-list rule below). Absent, the message still gains
   * its hint and no `fix` is composed. */
  request?: Record<string, unknown>;
}

// Row-scoped domain functions: authored as free calls (`text("x")`) that
// implicitly reference the current row. `@omgbase/oqx` free functions receive no
// row, so we rewrite them to `$it.fn(…)` (a method whose receiver is the row —
// `$it` is the language's own name for the scope's row, spec/oqx SEMANTICS §2)
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
// `path` and the edge field `dst_path` read `/a/b.md`. A string literal a query
// compares with one of them — `path == "a.md"`, `"a.md" != dst_path`,
// `path.startsWith("lab/")`, `doc.path == "a.md"` — is rooted first, so both
// spellings match; a property or binding compared with a path is never touched
// (it is the author's value), and neither is an authored `path:` key read
// through a source handle (`data.path`, `frontmatter.path`, `inline.path`): a
// member read is a path read only through a ROW handle (`doc`, `block`, `dst`,
// `$it`).
// The planner sees the rewritten tree too, so the pushed SQL and the in-memory
// engine agree by construction.
const PATH_ATTRIBUTES = new Set(["path", "dst_path"]);
const ROW_HANDLES = new Set(["doc", "block", "dst", "$it"]);
function isPathRead(e: Expr): boolean {
  if (e.kind === "ident" || e.kind === "outer") return PATH_ATTRIBUTES.has(e.name);
  if (e.kind === "member" && PATH_ATTRIBUTES.has(e.name)) {
    return (e.recv.kind === "ident" || e.recv.kind === "outer") && ROW_HANDLES.has(e.recv.name);
  }
  return false;
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

// The root row (root-row.ts, spec/surface §1.1, 2.0): `$repo` anywhere, and a
// bare `docs`/`links` at scope depth ≥ 1 (a property read of a row that has
// none), are refused before evaluation — one `visit` over the parsed tree, so
// the error does not depend on which rows the data happens to hold and the
// planned and in-memory paths agree trivially. `blocks`/`nodes` are relations of
// some rows and are judged by the context at read time (same message). A
// `^<target>` with more carets than enclosing scopes (`^docs count { }` at the
// top level) would read absent and count 0: refused too, naming the bare
// spelling.
export function checkRootSpellings(q: Query): void {
  // A top-level `from <name>` that is no collection (`from edges`, the links
  // target's name before 3.0) would scan an absent root and come back empty:
  // refused, naming the five collections (root-row.ts).
  if (q.source.kind === "ident" && !ROOTS.has(q.source.name)) throw new FilterInvalid(unknownTargetMessage(q.source.name), "OQX");
  visit(q, {
    enter(node, ctx) {
      if (node.kind !== "ident" && node.kind !== "outer") return;
      if (node.name === "$repo") throw new FilterInvalid(REPO_REMOVED_MESSAGE, "OQX");
      if (node.kind === "ident" && ctx.depth >= 1 && (node.name === "docs" || node.name === "links")) {
        throw new FilterInvalid(bareTargetMessage(node.name, ctx.depth), "OQX");
      }
      if (node.kind === "outer" && ROOTS.has(node.name) && node.levels > ctx.depth) {
        throw new FilterInvalid(pastRootMessage(node.name, node.levels), "OQX");
      }
    },
  });
}

// Dates over literals fold to literals (spec/surface §1.3 "Dates and
// durations", 4.8): `date("today")`, `dur("30 days")`, and a date method whose
// receiver and arguments are literals (`date("today").minus(dur("30 days"))`,
// folded inside-out since `transform` maps children first) become the string /
// number / null they evaluate to — by the SAME functions the context runs, so
// nothing changes in meaning — before the planner sees the tree. So `where
// updated_at < date("today")` is a text-vs-text comparison the translator
// pushes down (a call is otherwise an unconditional decline), and a named point
// is resolved ONCE per query. A call with the wrong arity is left in place: it
// raises when evaluated, and an empty source never evaluates it (spec/oqx §11).
const isLit = (e: Expr): e is Extract<Expr, { kind: "lit" }> => e.kind === "lit";
export function foldDates(e: Expr): Expr {
  if (e.kind !== "call" || !e.args.every(isLit)) return e;
  const args = e.args.map((a) => a.value);
  if (e.recv === null) {
    if (!Object.hasOwn(DATE_FUNCTIONS, e.name) || DATE_FUNCTIONS[e.name] !== args.length) return e;
    return build.lit(dateFunction(e.name, args).value as string | number | null);
  }
  if (!isLit(e.recv) || !Object.hasOwn(DATE_METHODS, e.name) || DATE_METHODS[e.name] !== args.length) return e;
  return build.lit(dateMethod(e.name, e.recv.value, args).value as string | number | null);
}

function rewriteQuery(q: Query): Query {
  return transform(q, (e) => (e.kind === "call" && e.recv === null && ROW_FNS.has(e.name) ? { ...e, recv: build.ident("$it") } : foldDates(rootPathLiterals(e))));
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

const ID_ITEM: SelectItem = build.field("__oqx_id", build.ident("id"));
const PATH_ITEM: SelectItem = build.field("__oqx_path", build.ident("path"));
// The runner's own projection names (`__oqx_id`, `__oqx_path`, `__oqx_self`,
// `__oqx_value`) and the selector compiler's slots (`__omg_sel_<t>_<slot>`,
// mutate/select.ts) share two reserved prefixes. A user alias under either would
// shadow an injected item (`select __oqx_id: 1` overwrote the hit's `id` through
// 4.0) or collide with a slot, so it is refused before anything runs — over the
// query's own top-level items, the only ones the runner injects beside.
const RESERVED_ALIAS_PREFIXES = ["__oqx_", "__omg_"] as const;
export function reservedAlias(items: readonly SelectItem[]): FilterInvalid | null {
  for (const item of items) {
    const prefix = RESERVED_ALIAS_PREFIXES.find((p) => item.name.startsWith(p));
    if (prefix !== undefined) return new FilterInvalid(`projection \`${item.name}\` uses the reserved prefix \`${prefix}\` — choose another alias`, "OQX");
  }
  return null;
}
// Result projections may not overwrite the envelope (spec/surface §1.4, 3.0):
// a projection whose output key is `id` or `path` is allowed only when it IS
// the envelope's own selection — the bare attribute of the same name, which
// collapses onto the envelope key (`select id, path` is simply the envelope) —
// and is otherwise a loud error asking for an alias: `select data.path` must be
// `select p: data.path`, `select path: doc.layer` likewise. Checked over the
// resolved items (an alias is just a name here), before the engine runs, so the
// error never depends on the rows. A `values` projection returns no hits, so
// the envelope — and the rule — do not apply.
const ENVELOPE_KEYS = new Set(["id", "path"]);
function envelopeCollision(items: readonly SelectItem[]): FilterInvalid | null {
  for (const item of items) {
    if (!ENVELOPE_KEYS.has(item.name)) continue;
    if (item.kind === "field" && item.expr.kind === "ident" && item.expr.name === item.name) continue;
    const hint = item.name === "path" ? "p: data.path" : "i: data.id";
    return new FilterInvalid(`projection \`${item.name}\` collides with the hit envelope — alias it (\`${hint}\`)`, "OQX");
  }
  return null;
}
// A hit is a store row (spec/surface §1.4, 1.5). The engine's top-level rows
// are store rows by construction when the source is a bare root scan (one of
// the five collections, `revisions` included — the planner's `rootTarget` is
// narrower: the four it can plan) and nothing re-projects them; a `follow` destination (`follow before` over a
// frontmatter list of paths), a `from E` re-projection or any other source can
// reach a scalar, which the injected `id`/`path` reads would render as the
// junk hit `{ id: "undefined", path: "" }`. For those queries the row itself is
// projected too (`$it`), and `toHit` fails the query when it is not a row. Only
// then: a row clone per hit is free here but not in the Rust port, and a root
// scan cannot need it. A `values` projection returns no hits, so it is exempt
// (`from docs from tags select $it values` is a flat list of tags).
const SELF_KEY = "__oqx_self";
const SELF_ITEM: SelectItem = build.field(SELF_KEY, build.ident("$it"));
function mayReachNonRows(q: Query): boolean {
  return q.follow !== null || q.from.length > 0 || !(q.source.kind === "ident" && ROOTS.has(q.source.name));
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
    `a hit must be a document, block, node, link or revision row — the query reached ${describeValue(v)}; to follow document references held in a property use refs(<field>)`,
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
// spec/oqx §12), a `values` projection of `$it`, a field bound to a
// row — and a store row is not a wire shape (column names, `attrs` as a JSON
// string, the `__path` join column, Buffers). Walk the projected value and
// render every tagged row as `{ id, path }` — the hit envelope's own keys
// (3.0), one notation for "a document reference" everywhere a row shape
// appears in a result; everything else passes through untouched (plain records
// and arrays are descended, scalars kept). Hits are records the engine built
// from the injected id/path items, never rows.
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

// A shaped row: the identity the runner injected, kept apart from the user
// projection until the very end, so distinct, the keyset page and the cursor
// run on identity whether or not the hits carry it (`bare`, 4.2).
interface Shaped {
  id: string;
  path: string;
  proj: Record<string, unknown>;
}

function shapeRow(row: unknown): Shaped {
  const o = row as Record<string, unknown>;
  const { __oqx_id, __oqx_path, __oqx_self, ...rest } = o;
  if (SELF_KEY in o && !rowRef(__oqx_self)) throw notAStoreRow(__oqx_self);
  return { id: String(__oqx_id), path: String(__oqx_path ?? ""), proj: renderValue(rest) as Record<string, unknown> };
}

// The envelope keys lead; a user projection of `id`/`path` collapses onto
// them in place (the same value, read by the same attribute).
function toHit(s: Shaped): OqxHit {
  return { id: s.id, path: s.path, ...s.proj };
}

// `bare` (4.2): the projection alone. A projected `id`/`path` is an ordinary
// column here — the intrinsic the attribute reads, under the key the query
// gave it — and nothing is injected beside it.
function toBareHit(s: Shaped): OqxHit {
  return s.proj as OqxHit;
}

// Top-level `select distinct`: dedup hits by their USER projection — every
// field except the envelope's `id`/`path`, which a projection of the attribute
// collapses onto (so `select distinct id` dedups on nothing but the empty
// projection, as it always has); under `bare` there is no envelope, so a
// projected `id`/`path` IS part of the projection and counts. Keeps the first
// (so the retained hit carries a real identity). Order-preserving.
function dedupByProjection(rows: Shaped[], bare: boolean): Shaped[] {
  const seen = new Set<string>();
  const out: Shaped[] = [];
  for (const s of rows) {
    const keys = Object.keys(s.proj).filter((k) => bare || !ENVELOPE_KEYS.has(k)).sort();
    const key = JSON.stringify(keys.map((k) => [k, s.proj[k]]));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// `bare` is examined where hits are built (spec/surface §1.4, 4.2): without a
// projection a hit is only its envelope, and `values` is already the
// bare-values form — both refused before the engine runs, over the resolved
// query, so the error never depends on the rows.
export const BARE_NEEDS_SELECT_MESSAGE = "`bare` needs a `select` — without a projection a hit is only its envelope";
export const BARE_WITH_VALUES_MESSAGE = "`bare` is redundant with `values` — `values` is already the bare-values form; drop one";
function bareMisuse(parsed: Query): FilterInvalid | null {
  if (parsed.values) return new FilterInvalid(BARE_WITH_VALUES_MESSAGE, "OQX");
  if (parsed.select.length === 0) return new FilterInvalid(BARE_NEEDS_SELECT_MESSAGE, "OQX");
  return null;
}

export function oqxRun(store: Store, repoId: string, source: string, opts: OqxOptions = {}): OqxResult {
  try {
    return oqxRunInner(store, repoId, source, opts);
  } catch (e) {
    // Normalize the library's errors to omgbase's contract (filter_invalid).
    if (e instanceof OqxError) throw parseInvalid(source, e, opts.request);
    throw e;
  }
}

// ---- the bracket-list fix (spec/surface §4 "Error data", 4.11) ----------------------
//
// OQX has no list literal; a tuple `("a", "b")` is the collection (`spec/oqx`
// SEMANTICS §3b), so `id in ["a", "b"]` — the SQL habit — is the parse error
// `unexpected '[' — expected a value (at offset N)`. When the source at N opens a
// bracketed comma list of LITERALS closed by `]` (two or more members, each a
// string, number, `true`, `false` or `null`; nothing nested), the message gains
// `; a list is written as a tuple: (…)` and, when the request is known, the
// error carries `fix`: the same request with that `[…]` rewritten to `(…)`.
// Anything else at N (an identifier member, a nested bracket, one member, an
// unclosed list) is the parser's error as it stands.

const BRACKET_ERROR = /^unexpected '\[' — expected a value \(at offset (\d+)\)$/;
export const TUPLE_HINT = "; a list is written as a tuple: (…)";

/** The source with the bracket list at the error's offset rewritten to a tuple, or null when the rule does not apply. */
export function bracketListAsTuple(source: string, message: string): string | null {
  const m = BRACKET_ERROR.exec(message);
  if (!m) return null;
  const cps = Array.from(source);
  const open = Number(m[1]);
  if (cps[open] !== "[") return null;
  let i = open + 1;
  let members = 0;
  for (;;) {
    i = skipSpaces(cps, i);
    const end = literalEnd(cps, i);
    if (end === null) return null;
    members++;
    i = skipSpaces(cps, end);
    if (cps[i] === ",") {
      i++;
      continue;
    }
    if (cps[i] === "]") break;
    return null;
  }
  if (members < 2) return null;
  cps[open] = "(";
  cps[i] = ")";
  return cps.join("");
}

function skipSpaces(cps: readonly string[], i: number): number {
  while (i < cps.length && /\s/.test(cps[i]!)) i++;
  return i;
}

/** The index just past one OQX literal starting at `i` (a string in either quote with `\<c>` escapes, an unsigned number, `true`/`false`/`null`), or null. */
function literalEnd(cps: readonly string[], i: number): number | null {
  const c = cps[i];
  if (c === undefined) return null;
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < cps.length) {
      if (cps[j] === "\\") j += 2;
      else if (cps[j] === c) return j + 1;
      else j++;
    }
    return null;
  }
  if (/[0-9]/.test(c)) {
    const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(cps.slice(i).join(""));
    return m ? i + Array.from(m[0]).length : null;
  }
  for (const word of ["true", "false", "null"]) {
    if (cps.slice(i, i + word.length).join("") === word && !/[A-Za-z0-9_$]/.test(cps[i + word.length] ?? "")) return i + word.length;
  }
  return null;
}

/** The surface's `filter_invalid` for a parse error: the library's message, plus the tuple hint and `fix` when the bracket rule applies. */
function parseInvalid(source: string, e: OqxError, request: Record<string, unknown> | undefined): FilterInvalid {
  const rewritten = bracketListAsTuple(source, e.message);
  if (rewritten === null) return new FilterInvalid(e.message, "OQX");
  const fix = request !== undefined ? canonicalJson({ ...request, query: rewritten }) : undefined;
  return new FilterInvalid(e.message + TUPLE_HINT, "OQX", fix);
}

function oqxRunInner(store: Store, repoId: string, source: string, opts: OqxOptions): OqxResult {
  const raw = parse(source);
  const reserved = reservedAlias(raw.select);
  if (reserved) throw reserved;
  // The source entry is every read: a tier-3 name on an open kind is a hint.
  return oqxRunQuery(store, repoId, raw, { unknownNames: "hint", ...opts });
}

/**
 * The AST entry (4.1): run an already parsed query — the source path above
 * after `parse`, and the selector compiler (`mutate/select.ts`), which appends
 * its slot items to the RAW tree so a user alias a template reads is inlined
 * by the alias resolution here. Errors are the library's own (`OqxError`);
 * `oqxRun` normalizes them, a caller of this entry does the same. Unknown
 * names (4.6) default to `"refuse"` here: this entry's caller is the write
 * selector, where a name no row carries would select every row; the source
 * entry passes `"hint"`.
 */
export function oqxRunQuery(store: Store, repoId: string, raw: Query, opts: OqxOptions = {}): OqxResult {
  checkRootSpellings(raw);
  // Unknown names (spec/surface §1.5): judged over the RAW tree — before alias
  // resolution and the runner's own items — so an alias is never mistaken for
  // a row property and the verdict never depends on the rows. The selector
  // compiler's slot items (`__omg_sel_*`, the templates' expressions) are not
  // the selector: an expression reading an absent property there is
  // spec/mutate's `target_missing` / absent value, not an unknown name.
  const own = { ...raw, select: raw.select.filter((it) => !RESERVED_ALIAS_PREFIXES.some((p) => it.name.startsWith(p))) };
  const hints = checkNames(store, repoId, own, opts.unknownNames ?? "refuse");
  const result = runResolved(store, repoId, raw, opts);
  // `hints` is the last member, present only when there is something to say.
  return hints.length === 0 ? result : { ...result, hints };
}

function runResolved(store: Store, repoId: string, raw: Query, opts: OqxOptions): OqxResult {
  // The query's `select` aliases are resolved HERE, once, before the runner
  // renames/injects items (an engine evaluates the query it is given).
  const parsed = rewriteQuery(resolveAliases(raw));
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

  // A grouped query (oqx 0.24, SEMANTICS §24) yields GROUPS, not store rows:
  // the envelope does not apply — there is no `id`/`path` to inject and no
  // keyset to page by — so a hit is the group's projection as the query wrote
  // it (`{ layer, n }`), exactly what `bare` yields for a row query; `bare` is
  // accepted and changes nothing. Rows that surface as values (`rows collect {
  // }` with an empty projection, `collect(doc)`) render as `{ id, path }` refs
  // like every row-as-value. Paging is by position: the query's own
  // `limit`/`offset` define the set, the tool's `limit` takes the first page,
  // `truncated` says whether more groups follow, the cursor is always null (as
  // under a custom `order by`). `distinct` cannot occur (a parse error).
  if (parsed.groupBy) return runGrouped(engine, parsed, consumer, opts);

  // A flattened query (oqx 0.25, SEMANTICS §25) yields the parent rows, one per
  // element: a hit is still a store row, so the envelope is injected as usual
  // and repeats per element (Dataview's `TABLE … FLATTEN`). What changes is
  // uniqueness — `(path, id)` no longer names one hit — so the keyset cursor
  // cannot land inside a document's elements: a flattened query pages
  // positionally with a null cursor, as a grouped query and a custom `order by`
  // do (a keyset extended with the flatten ordinal is a later round). A bound
  // name of `id` or `path` would shadow the envelope's own reads (the name
  // shadows a same-named row property on the flattened row): refused, like a
  // projection that collides with the envelope.
  const flattened = parsed.flatten.length > 0;
  for (const f of parsed.flatten) {
    if (ENVELOPE_KEYS.has(f.name)) throw new FilterInvalid(`flatten \`as ${f.name}\` collides with the hit envelope — a flattened row is still the row, whose \`${f.name}\` the envelope reads; bind another name`, "OQX");
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
  // `bare` (4.2): the hits are the projection alone — refused without one and
  // with `values`; with no envelope there is no collision to refuse either, a
  // projected `id`/`path` is simply a column.
  const bare = opts.bare === true;
  if (bare) {
    const misuse = bareMisuse(parsed);
    if (misuse) throw misuse;
  } else if (!topValues) {
    const collision = envelopeCollision(userSelect);
    if (collision) throw collision;
  }
  const render = bare ? toBareHit : toHit;
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
    if (topValues) return { hits: [], truncated: false, cursor: null, consumer, values: row == null ? [] : [shapeRow(row).proj[VALUE_KEY]] };
    return { hits: row == null ? [] : [render(shapeRow(row))], truncated: false, cursor: null, consumer };
  }

  // collect: keyset pagination on (path, id) when the order is the default.
  let rows = (res.consumer === "collect" ? res.rows : []).map(shapeRow);
  if (topDistinct) rows = dedupByProjection(rows, bare);
  // The query's own bound defines the result SET; the `limit`/`cursor` options
  // then page within it.
  const offset = constBound(topOffset, "offset") ?? 0;
  const limit = constBound(topLimit, "limit");
  if (offset || limit != null) rows = rows.slice(offset, limit == null ? undefined : offset + limit);
  const custom = (!!parsed.orderBy && parsed.orderBy.length > 0) || flattened;
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
  // The envelope is stripped LAST (`bare`): the page and the cursor above ran
  // on identity, so a bare result pages exactly like the enveloped one.
  if (topValues) return { hits: [], truncated, cursor, consumer: "collect", values: page.map((s) => s.proj[VALUE_KEY]) };
  return { hits: page.map(render), truncated, cursor, consumer: "collect" };
}

// The collect/first/single path of a grouped query (see `runResolved`).
function runGrouped(engine: Engine, parsed: Query, consumer: OqxConsumer, opts: OqxOptions): OqxResult {
  const topValues = parsed.values;
  // A `values` projection rides as a record under VALUE_KEY and is peeled off
  // the page, as on the row path.
  const select = topValues ? [{ ...parsed.select[0]!, name: VALUE_KEY }] : parsed.select;
  const { limit: topLimit, offset: topOffset } = parsed;
  const base = consumer === "collect" ? { ...parsed, limit: null, offset: null } : parsed;
  const res = engine.run({ ...base, values: false, select }, []);
  const project = (row: unknown): Record<string, unknown> => renderValue(row) as Record<string, unknown>;
  if (consumer === "first" || consumer === "single") {
    const row = res.consumer === "first" || res.consumer === "single" ? res.row : null;
    if (topValues) return { hits: [], truncated: false, cursor: null, consumer, values: row == null ? [] : [project(row)[VALUE_KEY]] };
    return { hits: row == null ? [] : [project(row) as OqxHit], truncated: false, cursor: null, consumer };
  }
  let groups = (res.consumer === "collect" ? res.rows : []).map(project);
  const offset = constBound(topOffset, "offset") ?? 0;
  const limit = constBound(topLimit, "limit");
  if (offset || limit != null) groups = groups.slice(offset, limit == null ? undefined : offset + limit);
  const cap = opts.limit ?? 50;
  const truncated = groups.length > cap;
  const page = groups.slice(0, cap);
  if (topValues) return { hits: [], truncated, cursor: null, consumer: "collect", values: page.map((g) => g[VALUE_KEY]) };
  return { hits: page as OqxHit[], truncated, cursor: null, consumer: "collect" };
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

// The collect page's keyset is (path, id) — the hit's `path`, so the reference
// form (`/a.md`), and its `id`: the kernel's shared cursor encoding
// (core/cursor.ts) with a two-part tuple of VALUES (no key names ride in it, so
// a 2.x cursor stays valid on 3.0). A malformed cursor is CursorInvalid, which the MCP layer maps
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
