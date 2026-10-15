// Unknown names (spec/surface §1.5, 4.6). A query that projects, filters or
// orders by a name no row of the scope's kind can carry — `select path, target
// from links` (links have `dst_path`), `where preview != ""` on blocks — used
// to run silently: an absent column in every row, a predicate true or false of
// every row. This pass judges every name the query reads (`@omgbase/oqx`'s
// `references`, AST.md §5b) against the VOCABULARY of the row kind it is read
// from, statically — before any row is read, so the verdict never depends on
// the query's own filter — and either records a hint or refuses the query.
//
// The three tiers of a name at a scope whose kind is known:
//   1. an engine attribute, handle or relation of the kind — known;
//   2. an authored property at least one live object of the kind in this
//      repository carries (docs: a frontmatter or inline key — `stage` on three
//      processes is enough; blocks and nodes: a key of a live row's `attrs`,
//      the bare-name read of those kinds) — known, however partial;
//   3. a name no object of the kind carries — the complaint.
// Severity: `links` has a closed row shape (no authored data reaches a link
// row), so a tier-3 name there is `filter_invalid`; docs, blocks and nodes are
// open — on a read the result carries one hint per offending name and the rows
// still come back; a write selector (the AST entry, `unknownNames: "refuse"`)
// is refused, since a name no row carries would select every row. A repository
// with no live object of the kind has no vocabulary: the check is skipped for
// that kind. The vocabulary is read once per (repository, kind) and cached on
// the repository's head commit (`MAX(commits.seq)`), the one thing every
// property or attrs change moves.

import type { Expr, Follow, Query, ReferenceStep } from "@omgbase/oqx";
import { references } from "@omgbase/oqx";
import { ATTRIBUTES, SOURCE_HANDLES, type Kind } from "./context.js";
import { ROOTS } from "./root-row.js";
import { FROM, guards } from "./sql/scan.js";
import type { Store } from "../core/store/store.js";
import { FilterInvalid } from "../search/cel/parser.js";

/** What to do with a tier-3 name on an open kind: record it in `hints` (every read) or refuse the query (a write selector). */
export type UnknownNames = "hint" | "refuse";

/** The relations of each kind and the kind of the rows they yield (spec/surface §1.2). */
export const RELATIONS: Readonly<Record<Kind, Readonly<Record<string, Kind>>>> = {
  docs: { blocks: "blocks", nodes: "nodes", out_links: "links", in_links: "links", revisions: "revisions" },
  blocks: { children: "blocks", nodes: "nodes", out_links: "links", section: "nodes" },
  nodes: { blocks: "blocks", subsections: "nodes", children: "nodes" },
  links: {},
  revisions: {},
};

/** The self and reach-through handles of each kind and the kind of the row they reach (§1.2). */
export const HANDLES: Readonly<Record<Kind, Readonly<Record<string, Kind>>>> = {
  docs: { doc: "docs" },
  blocks: { block: "blocks", doc: "docs" },
  nodes: { section: "nodes", doc: "docs", block: "blocks" },
  links: { doc: "docs", dst: "docs" },
  revisions: { doc: "docs" },
};

/** The kinds whose row shape is closed: no authored data reaches a row by bare name. */
const CLOSED: ReadonlySet<Kind> = new Set<Kind>(["links", "revisions"]);

const NOUN: Readonly<Record<Kind, string>> = { docs: "document", blocks: "block", nodes: "node", links: "link", revisions: "revision" };

// ---- vocabulary ------------------------------------------------------------

interface Vocabulary {
  /** whether the repository has a live object of the kind at all */
  present: boolean;
  /** the authored keys (flattened, dotted) and every dotted prefix of them */
  keys: ReadonlySet<string>;
  /** the authored keys alone, in `key` order — the nearest-match candidates */
  list: readonly string[];
}

interface RepoCache {
  head: number;
  vocab: Partial<Record<Kind, Vocabulary>>;
}

const CACHE = new WeakMap<Store, Map<string, RepoCache>>();

function headSeq(store: Store, repoId: string): number {
  const row = store.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM commits WHERE repo_id = ?").get(repoId) as { seq: number } | undefined;
  return row?.seq ?? 0;
}

function repoCache(store: Store, repoId: string): RepoCache {
  let repos = CACHE.get(store);
  if (!repos) CACHE.set(store, (repos = new Map()));
  const head = headSeq(store, repoId);
  let c = repos.get(repoId);
  if (!c || c.head !== head) repos.set(repoId, (c = { head, vocab: {} }));
  return c;
}

/** The authored vocabulary of a kind: docs — every live frontmatter or inline
 * key (the merged read a bare name performs); blocks and nodes — every key a
 * live row's `attrs` holds (the bare-name read of those kinds). Computed keys
 * (`$title`, `$tags`) are the intrinsics `title`/`tags`, not authored keys. */
function authoredKeys(store: Store, repoId: string, target: Kind): string[] {
  let sql: string;
  switch (target) {
    case "docs":
      sql = "SELECT DISTINCT key FROM properties WHERE repo_id = ? AND deleted_commit IS NULL AND source IN ('frontmatter', 'inline') ORDER BY key";
      return (store.db.prepare(sql).all(repoId) as { key: string }[]).map((r) => r.key);
    case "blocks":
    case "nodes": {
      const g = guards(target, repoId);
      const alias = target === "blocks" ? "b" : "n";
      sql = `SELECT DISTINCT j.key AS key FROM ${FROM[target]}, json_each(${alias}.attrs) j WHERE ${g.sql} ORDER BY key`;
      return (store.db.prepare(sql).all(...g.params) as { key: string }[]).map((r) => r.key);
    }
    case "links":
    case "revisions": return [];
  }
}

function present(store: Store, repoId: string, target: Kind): boolean {
  // A closed kind has no authored vocabulary to be absent; the question never reaches it.
  if (target === "revisions") return true;
  const g = guards(target, repoId);
  return store.db.prepare(`SELECT 1 FROM ${FROM[target]} WHERE ${g.sql} LIMIT 1`).get(...g.params) !== undefined;
}

/** The vocabulary of a kind in a repository (cached on the head commit; the SQL runs only when a name is not intrinsic). */
export function vocabulary(store: Store, repoId: string, target: Kind): { present: boolean; keys: readonly string[] } {
  const v = vocabularyOf(store, repoId, target);
  return { present: v.present, keys: v.list };
}

function vocabularyOf(store: Store, repoId: string, target: Kind): Vocabulary {
  const c = repoCache(store, repoId);
  let v = c.vocab[target];
  if (v) return v;
  const list = authoredKeys(store, repoId, target);
  const keys = new Set<string>();
  for (const k of list) {
    const segs = k.split(".");
    for (let i = 1; i <= segs.length; i++) keys.add(segs.slice(0, i).join("."));
  }
  v = { present: list.length > 0 || present(store, repoId, target), keys, list };
  c.vocab[target] = v;
  return v;
}

// ---- the kind of a scope ---------------------------------------------------

/** `"root"` is the root scope; `{ group: k }` a GROUP scope (oqx 0.24): the
 * groups of rows of kind `k`, whose only row-yielding name is `rows`. */
type RowKind = Kind | "root" | { group: Kind | null };

/** The kind of the rows an expression yields when read on rows of `on` (`"root"`: the root scope), or null when unknown. */
function kindOfExpr(e: Expr, on: RowKind | null, readDepth: number, byDepth: ReadonlyMap<number, RowKind | null>): Kind | null {
  switch (e.kind) {
    case "ident": return kindOfPath(on, [e.name]);
    case "outer": {
      const k = readDepth - e.levels;
      return kindOfPath(k <= 0 ? "root" : byDepth.get(k) ?? null, [e.name]);
    }
    case "member": {
      const path = dotted(e);
      if (path === null) return null;
      const head = path.head;
      const base: RowKind | null = head.kind === "ident" ? on : (readDepth - head.levels <= 0 ? "root" : byDepth.get(readDepth - head.levels) ?? null);
      return kindOfPath(base, [head.name, ...path.rest]);
    }
    // `refs(x)` resolves document references to live document rows (§1.3).
    case "call": return e.recv === null && e.name === "refs" ? "docs" : null;
    // A value-position block with no projection passes its receiver's rows through (then its own `from`).
    case "op": {
      if (e.sub.select.some((it) => it.name !== "$key") || e.sub.values) return null;
      let k: Kind | null = kindOfExpr(e.receiver, on, readDepth, byDepth);
      for (const f of e.sub.from) k = k === null ? null : kindOfExpr(f, k, readDepth + 1, byDepth);
      return k;
    }
    default: return null; // a literal, a binding, a tuple (mixed), a template, an operator
  }
}

/** A dotted navigation headed by a name. */
function dotted(e: Expr): { head: Expr & { kind: "ident" | "outer" }; rest: string[] } | null {
  if (e.kind === "ident" || e.kind === "outer") return { head: e, rest: [] };
  if (e.kind !== "member") return null;
  const inner = dotted(e.recv);
  return inner === null ? null : { head: inner.head, rest: [...inner.rest, e.name] };
}

/** Follow a dotted path from a row kind through handles and relations (`doc.blocks` on a link → blocks). */
function kindOfPath(on: RowKind | null, path: readonly string[]): Kind | null {
  let cur: RowKind | null = on;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    if (cur === null) return null;
    if (cur === "root") {
      if (seg === "$it") continue;
      if (!ROOTS.has(seg)) return null;
      cur = seg as Kind;
      continue;
    }
    // At a group scope `rows` yields the grouped rows (their kind); a key is a
    // value the language built, not a row of any kind.
    if (typeof cur === "object") {
      if (seg !== "rows" || i !== 0) return null;
      cur = cur.group;
      continue;
    }
    if (seg === "$it" && i === 0) continue;
    const next: Kind | undefined = HANDLES[cur][seg] ?? RELATIONS[cur][seg];
    if (next === undefined) return null;
    cur = next;
  }
  return cur === "root" || typeof cur === "object" ? null : cur;
}

/** The kind of the frontier rows of a walk: the seeds' kind when every destination yields rows of that same kind, else unknown. */
function kindOfFrontier(seed: Kind | null, f: Follow, readDepth: number, byDepth: ReadonlyMap<number, RowKind | null>): Kind | null {
  if (seed === null) return null;
  // A destination block is a value-position `op`: its receiver on the frontier row, then its own `from`.
  for (const d of f.destinations) if (kindOfExpr(d, seed, readDepth, byDepth) !== seed) return null;
  return seed;
}

/** The kind of the rows a scope holds, from its row chain (AST.md §5b); null when the chain reaches a value no kind describes. */
export function kindOfScope(steps: readonly ReferenceStep[]): Kind | null {
  if (steps.length === 0) return null; // the root scope: root names are judged elsewhere
  const byDepth = new Map<number, RowKind | null>([[0, "root"]]);
  let cur: RowKind | null = "root";
  let readDepth = 0;
  for (const step of steps) {
    const e = step.expr;
    if (e.kind === "follow") cur = kindOfFrontier(cur === "root" || typeof cur === "object" ? null : cur, e, readDepth, byDepth);
    // A `group by` step (oqx 0.24): the rows at this depth become groups of them.
    else if (e.kind === "groupBy") cur = { group: cur === "root" || typeof cur === "object" ? null : cur };
    else cur = kindOfExpr(e, cur, readDepth, byDepth);
    byDepth.set(step.depth, cur);
    readDepth = step.depth;
  }
  return cur === "root" || typeof cur === "object" ? null : cur;
}

// ---- judging a name --------------------------------------------------------

interface Verdict {
  target: Kind;
  /** the dotted name judged (the path after any handle or relation) */
  name: string;
  closed: boolean;
  /** the source handle the name was read through (`data`, `frontmatter`, `inline`), when it was */
  handle?: string;
}

/** Judge a dotted name read on rows of `target`; null = known. */
function judge(store: Store, repoId: string, target: Kind, path: readonly string[]): Verdict | null {
  const [head, ...rest] = path as [string, ...string[]];
  // An engine attribute wins on collision; what follows it (`attrs.checked`, `tags.size`) is the value's own navigation.
  if (ATTRIBUTES[target].has(head)) return null;
  // The source handles reach the authored data under them.
  if (target === "docs" && SOURCE_HANDLES.has(head)) return rest.length === 0 ? null : judgeAuthored(store, repoId, "docs", rest, head);
  const via = HANDLES[target][head] ?? RELATIONS[target][head];
  if (via !== undefined) return rest.length === 0 ? null : judge(store, repoId, via, rest);
  // A bare target name on a row is the context's own loud error (root-row.ts); not doubled here.
  if (ROOTS.has(head)) return null;
  return judgeAuthored(store, repoId, target, path);
}

function judgeAuthored(store: Store, repoId: string, target: Kind, path: readonly string[], handle?: string): Verdict | null {
  const name = path.join(".");
  if (CLOSED.has(target)) return { target, name, closed: true };
  const v = vocabularyOf(store, repoId, target);
  if (!v.present) return null; // no object of the kind: no vocabulary to judge by
  if (v.keys.has(name)) return null;
  return { target, name, closed: false, ...(handle !== undefined ? { handle } : {}) };
}

// ---- messages --------------------------------------------------------------

/** The names a kind knows, for the nearest match: attributes, handles, relations, the authored keys. */
function candidates(store: Store, repoId: string, target: Kind): string[] {
  const out = [...ATTRIBUTES[target], ...Object.keys(HANDLES[target]), ...(target === "docs" ? [...SOURCE_HANDLES] : []), ...Object.keys(RELATIONS[target])];
  if (!CLOSED.has(target)) out.push(...vocabularyOf(store, repoId, target).list);
  return out;
}

/** Optimal string alignment distance (Damerau–Levenshtein with adjacent transpositions, each edit 1). */
export function editDistance(a: string, b: string): number {
  const s = Array.from(a), t = Array.from(b);
  const m = s.length, n = t.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[m]![n]!;
}

/**
 * The nearest match of `name` among `candidates` (§1.5): case-insensitive; a
 * candidate qualifies when its distance is ≤ 2, or when one of the two is a
 * substring of the other and the shorter has at least three characters; the
 * lowest distance wins, ties broken by the shorter candidate, then
 * alphabetically. Null when nothing qualifies.
 */
export function nearest(name: string, candidates: readonly string[]): string | null {
  const needle = name.toLowerCase();
  // A name under three characters is within distance 2 of nearly anything, so
  // only a substring match (which needs three characters anyway) could qualify.
  if (needle.length < 3) return null;
  let best: { c: string; d: number; sub: boolean } | null = null;
  for (const c of new Set(candidates)) {
    const hay = c.toLowerCase();
    if (hay === needle) continue;
    const d = editDistance(needle, hay);
    const shorter = needle.length <= hay.length ? needle : hay;
    const longer = shorter === needle ? hay : needle;
    const sub = shorter.length >= 3 && longer.includes(shorter);
    if (!(d <= 2 || sub)) continue;
    // One typo (distance 1) wins first; then a substring match outranks a
    // distance-2 match (`via` → `via_id`, not `id`; `dst_pth` → `dst_path`, not
    // `dst`); within a class the lowest distance, then the shorter candidate,
    // then alphabetical.
    const rank = (x: { d: number; sub: boolean }): number => (x.d === 1 ? 0 : x.sub ? 1 : 2);
    const better =
      best === null ||
      rank({ d, sub }) < rank(best) ||
      (rank({ d, sub }) === rank(best) && (d < best.d || (d === best.d && (c.length < best.c.length || (c.length === best.c.length && c < best.c)))));
    if (better) best = { c, d, sub };
  }
  return best === null ? null : best.c;
}

function suggestion(name: string, candidates: readonly string[]): string {
  const c = nearest(name, candidates);
  return c === null ? "" : `; did you mean \`${c}\`?`;
}

/** The error of a closed kind: `` `target` is not a field of links (fields: id, path, …); did you mean `…`? ``. */
export function fieldErrorMessage(store: Store, repoId: string, target: Kind, name: string): string {
  return `\`${name}\` is not a field of ${target} (fields: ${[...ATTRIBUTES[target]].join(", ")})${suggestion(name, candidates(store, repoId, target))}`;
}

/** The hint of an open kind: `` `preview` is not a field of blocks and no block in this repository carries a property by that name; did you mean `…`? ``.
 * Under a source handle the name is an authored lookup by construction, so the
 * hint says only that: `` no document in this repository carries a property `path` (`data.path`); did you mean `…`? ``,
 * the nearest match drawn from the authored keys alone. */
export function propertyHintMessage(store: Store, repoId: string, target: Kind, name: string, handle?: string): string {
  if (handle !== undefined) {
    return `no ${NOUN[target]} in this repository carries a property \`${name}\` (\`${handle}.${name}\`)${suggestion(name, vocabularyOf(store, repoId, target).list)}`;
  }
  return `\`${name}\` is not a field of ${target} and no ${NOUN[target]} in this repository carries a property by that name${suggestion(name, candidates(store, repoId, target))}`;
}

// ---- the pass --------------------------------------------------------------

/**
 * Judge every name the query reads. Returns the hints (one per offending name
 * of an open kind, first-reference order, deduplicated) under `"hint"`; throws
 * `FilterInvalid` for a tier-3 name on a closed kind in either mode, and for
 * one on an open kind under `"refuse"`.
 */
export function checkNames(store: Store, repoId: string, raw: Query, mode: UnknownNames): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const ref of references(raw)) {
    if (ref.scope.steps.length === 0) continue; // a root name
    const kind = kindOfScope(ref.scope.steps);
    if (kind === null) continue;
    const verdict = judge(store, repoId, kind, ref.name.split("."));
    if (verdict === null) continue;
    if (verdict.closed) throw new FilterInvalid(fieldErrorMessage(store, repoId, verdict.target, verdict.name), "OQX");
    const message = propertyHintMessage(store, repoId, verdict.target, verdict.name, verdict.handle);
    if (mode === "refuse") throw new FilterInvalid(message, "OQX");
    if (!seen.has(message)) {
      seen.add(message);
      hints.push(message);
    }
  }
  return hints;
}
