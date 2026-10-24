// Select-alias resolution (SEMANTICS §14). A body's `select` names are names of
// that body's rows for every clause that reads the rows and for the nested
// blocks under it (since 0.27; through 0.26 only `where`, `having` and the items
// to an item's right saw them): the parser keeps the surface form (so the tree
// can be printed back and reflected on) and only VALIDATES the references, and
// this module performs the substitution — a pure rewrite the entry points
// (`run`, `execute`, `oqx`, `runQuery`) apply once before evaluation, so the
// engine and any pushdown planner see ordinary clauses over row fields. Rules:
//   • an alias shadows a same-named row field in `where`, `having`, `frontier`,
//     `follow` destinations (a receiver, or the head of a navigation), `flatten`,
//     `group by` keys, `order by`, and in the items after it; `$it.name` reads
//     the row's property regardless;
//   • a nested block reads an enclosing body's alias through an outer reference
//     (`^name` one scope out, `^^name` two, `N^name` by depth): the alias's
//     expression is inlined SHIFTED by that many scopes, so what it read on the
//     enclosing row it still reads there (`^k` with `k: kind` is `^kind`; with
//     `k: kids { where ok }` it is `^kids { where ok }`);
//   • an alias's own name inside its own expression is the row field
//     (`name: name.upper()` is not recursive), but a chain of aliases that
//     comes back to one being resolved (`a: b, b: a`) is a cycle → error;
//   • a `select` item — its expression and its nested blocks — may name only the
//     items to its LEFT; a reference to an item to its right (bare, or `^name`
//     from a block) is an error (a cycle when that item refers back);
//   • an alias whose value is a `collect`/`first`/`single`/`count { … }` block
//     inlines as a value-position directive wherever it is read (`kids.size()`,
//     `follow kids`, `^kids exists { }`); alone as a `where` leaf it means
//     "non-empty";
//   • in a grouped body a `group by` key that is a bare alias name takes the
//     alias's expression as its key (named by the alias), and that alias's item
//     then reads the key — so `select kk: kind, n: count() … group by kk` groups
//     by `kind` and projects it as `kk`;
//   • `from` (it produces the rows the select reads), `limit`/`offset` (bounds of
//     the scope, not of a row) and the source are never rewritten.
//
// Resolution is NOT idempotent (`name: name.upper() … where name` resolves to
// `name.upper()`, whose `name` would be substituted again), so it must run
// exactly once: the entry points do it, `Engine.run` evaluates the query as
// given. Untouched nodes are returned by reference, so a cached query keeps the
// identity of every block the rewrite did not reach.

import type { Expr, Flatten, Follow, FollowDestination, GroupBy, OpNode, Query, SelectItem, Subquery, Where } from "./ast.ts";
import { OqxError } from "./errors.ts";
import { transform } from "./walk.ts";

/** How a resolution failure is reported: the parser raises its positioned parse
 * error, the standalone entry point a plain one. */
export type Fail = (message: string) => never;

const failPlain: Fail = (message) => {
  throw new OqxError(message, "parse");
};

/** An item to the right of the one being resolved: naming it is an error. */
const FORWARD = Symbol("forward");
type AliasValue = Expr | typeof FORWARD;
/** One body's aliases, by name: the resolved expression (a `collect` item's op). */
export type AliasEnv = ReadonlyMap<string, AliasValue>;
/** The enclosing bodies' aliases, innermost first (`^name` reads `env[0]`). */
export type AliasScopes = readonly AliasEnv[];

/** Resolve every clause of a query (its own and every nested block's) against
 * the `select` of the same body and of the bodies around it. Pure: returns a
 * new tree sharing every node the rewrite did not touch. Throws an `OqxError`
 * (stage `parse`) for an alias cycle, a forward reference, or an outer
 * reference to an alias not yet defined — the same conditions the parser
 * rejects, so a parsed query never throws here. */
export function resolveAliases<T extends Query | Subquery>(node: T): T {
  return resolveBody(node, failPlain, []);
}

function resolveBody<T extends Query | Subquery>(node: T, fail: Fail, env: AliasScopes): T {
  // `where` is validated and substituted against the raw select first: its
  // cycle report follows the where's own path (`c → a → b → c`), as pinned.
  const where0 = node.where === null ? null : resolveWhere(node.select, node.where, fail);
  const select0 = resolveSelect(node.select, fail, env);
  // This body's aliases (the resolved values), for its other clauses and for
  // the blocks under it.
  const own = aliasEnv(select0);
  const inner: AliasScopes = [own, ...env];
  const where = where0 === null ? null : resolveNestedWhere(where0, fail, env, inner);
  // A grouped body (0.27): a key that is a bare alias name takes the alias's
  // expression, and the alias's item then reads the key — so do the post-group
  // clauses (`having`, `order by`), where that name is the key, not the alias.
  let select = select0;
  let groupBy = node.groupBy;
  let havingSelect: readonly SelectItem[] = node.select;
  let ownPost = own;
  if (node.groupBy !== null) {
    const keyed = resolveGroupKeys(node.groupBy, own, fail, env, inner);
    groupBy = keyed.groupBy;
    if (keyed.aliased.size > 0) {
      select = readKeys(select, keyed.aliased);
      havingSelect = readKeys(node.select, keyed.aliased);
      ownPost = withoutKeys(own, keyed.aliased);
    }
  }
  const having0 = node.having === null ? null : resolveWhere(havingSelect, node.having, fail);
  const having = having0 === null ? null : resolveNestedWhere(having0, fail, env, inner);
  const follow = node.follow === null ? null : resolveFollow(node.follow, own, fail, env, inner);
  const flatten = mapSame(node.flatten, (f: Flatten) => {
    const expr = resolveRowExpr(f.expr, own, fail, env, inner);
    return expr === f.expr ? f : { ...f, expr };
  });
  // `from` produces the rows the select reads: not rewritten against it (its
  // nested blocks resolve against their own select, outer references included).
  const from = mapSame(node.from, (e) => resolveNested(e, fail, env, inner));
  const orderBy = node.orderBy === null ? null : mapSame(node.orderBy, (o) => {
    const expr = resolveRowExpr(o.expr, ownPost, fail, env, inner);
    return expr === o.expr ? o : { ...o, expr };
  });
  // Bounds are the scope's, not a row's: never rewritten against the select.
  const limit = node.limit === null ? null : resolveNested(node.limit, fail, env, inner);
  const offset = node.offset === null ? null : resolveNested(node.offset, fail, env, inner);
  const frontier = node.frontier === null ? null : resolveRowExpr(node.frontier, own, fail, env, inner);
  // The source is read at the enclosing scope: a block over it reads that scope's `^`.
  const source = node.kind === "query" ? resolveNested(node.source, fail, env.slice(1), env) : null;
  const same = where === node.where && select === node.select && follow === node.follow && from === node.from
    && orderBy === node.orderBy && limit === node.limit && offset === node.offset && frontier === node.frontier
    && groupBy === node.groupBy && having === node.having && flatten === node.flatten
    && (node.kind !== "query" || source === node.source);
  if (same) return node;
  const out = { ...node, where, select, follow, frontier, flatten, groupBy, having, from, orderBy, limit, offset };
  if (node.kind === "query") (out as Query).source = source!;
  return out;
}

/** The items whose names are aliased `group by` keys, rewritten to read the key
 * (`kk: kind` → `kk: kk`); the rest by reference. Exported for the parser: the
 * raw select so rewritten is what `having` resolves against. */
export function readKeys(items: readonly SelectItem[], aliased: ReadonlySet<string>): SelectItem[] {
  return mapSame(items as SelectItem[], (it) => (it.kind === "field" && it.lift === 0 && aliased.has(it.name) && !(it.expr.kind === "ident" && it.expr.name === it.name)
    ? { ...it, expr: { kind: "ident", span: it.expr.span, name: it.name } }
    : it));
}

function withoutKeys(own: AliasEnv, aliased: ReadonlySet<string>): AliasEnv {
  const out = new Map(own);
  for (const k of aliased) out.delete(k);
  return out;
}

/** The names a body's (resolved) select defines, with their values. A `$`-name
 * is the language's and never an alias here (`$key: id` keys rows, SEMANTICS §16). */
function aliasEnv(select: readonly SelectItem[]): AliasEnv {
  const env = new Map<string, AliasValue>();
  for (const it of select) {
    const n = aliasName(it);
    if (n === null || n.startsWith("$")) continue;
    env.set(n, it.kind === "collect" ? it.op : it.expr);
  }
  return env;
}

// `group by` keys read the rows (0.24) — and a key that is a bare alias name is
// that alias (0.27): its expression becomes the key's, named by the alias.
function resolveGroupKeys(g: GroupBy, own: AliasEnv, fail: Fail, outer: AliasScopes, inner: AliasScopes): { groupBy: GroupBy; aliased: Set<string> } {
  const aliased = new Set<string>();
  const keys = mapSame(g.keys, (k) => {
    if (k.expr.kind === "ident" && k.name === k.expr.name) {
      const a = own.get(k.expr.name);
      if (a !== undefined && a !== FORWARD && !(a.kind === "ident" && a.name === k.name)) {
        aliased.add(k.name);
        return { ...k, expr: a };
      }
    }
    const expr = resolveRowExpr(k.expr, own, fail, outer, inner);
    return expr === k.expr ? k : { ...k, expr };
  });
  return { groupBy: keys === g.keys ? g : { ...g, keys }, aliased };
}

// `env` is what the op's body sees one scope out (`env[0]` = the body the op is
// written in); the receiver is read in that body, so its own outer references
// reach one scope further.
function resolveOp(op: OpNode, fail: Fail, env: AliasScopes): OpNode {
  const receiver = resolveNested(op.receiver, fail, env.slice(1), env);
  const sub = resolveBody(op.sub, fail, env);
  return sub === op.sub && receiver === op.receiver ? op : { ...op, receiver, sub };
}

// A destination is read on the frontier row: a bare alias (or a navigation
// headed by one) is that alias (0.27); a destination block's receiver likewise,
// and its body reads the enclosing aliases through `^`.
function resolveFollow(f: Follow, own: AliasEnv, fail: Fail, outer: AliasScopes, inner: AliasScopes): Follow {
  const destinations = mapSame(f.destinations, (d: FollowDestination): FollowDestination => {
    if (d.kind === "op") {
      const receiver = resolveRowExpr(d.receiver, own, fail, outer, inner);
      const sub = resolveBody(d.sub, fail, inner);
      return receiver === d.receiver && sub === d.sub ? d : { ...d, receiver, sub };
    }
    return resolveRowExpr(d, own, fail, outer, inner);
  });
  return destinations === f.destinations ? f : { ...f, destinations };
}

// Nested blocks inside a where tree are their own scopes: resolve each against
// its own select (a scalar leaf may hold a value-position directive); an outer
// reference in a leaf reads an enclosing body's alias.
function resolveNestedWhere(w: Where, fail: Fail, outer: AliasScopes, inner: AliasScopes): Where {
  switch (w.kind) {
    case "and": case "or": {
      const parts = mapSame(w.parts, (p) => resolveNestedWhere(p, fail, outer, inner));
      return parts === w.parts ? w : { ...w, parts };
    }
    case "not": {
      const expr = resolveNestedWhere(w.expr, fail, outer, inner);
      return expr === w.expr ? w : { ...w, expr };
    }
    case "scalar": {
      const expr = resolveNested(w.expr, fail, outer, inner);
      return expr === w.expr ? w : { ...w, expr };
    }
    case "op": return resolveOp(w, fail, inner);
  }
}

/** An expression read on this body's rows (`frontier`, `order by`, `flatten`, a
 * key, a destination): a bare identifier naming one of `own` is that alias; then
 * the nested blocks and outer references as `resolveNested`. */
function resolveRowExpr(e: Expr, own: AliasEnv, fail: Fail, outer: AliasScopes, inner: AliasScopes): Expr {
  if (own.size === 0) return resolveNested(e, fail, outer, inner);
  // One pass: an alias's value is already resolved, so it is inlined as is
  // (resolution is not idempotent) and the rest resolves as `resolveNested`.
  return mapExpr(e, (x) => {
    if (x.kind === "ident") {
      const a = own.get(x.name);
      if (a === undefined) return null;
      if (a === FORWARD) fail(`select alias '${x.name}' is used before it is defined — a select item may reference only the items to its left`);
      return a;
    }
    return nestedHit(x, fail, outer, inner);
  });
}

/** Resolve the nested blocks (value-position directives) inside an expression,
 * each against its own select (their `^` reads `blocks[0]`, the body the
 * expression belongs to), and replace an outer reference at the expression's own
 * level that names an enclosing body's alias (`outer[0]` is one scope out) by
 * that alias's expression, shifted out to where it is read (0.27). The
 * expression's own bare idents are left alone. */
function resolveNested(e: Expr, fail: Fail, outer: AliasScopes, blocks: AliasScopes): Expr {
  return mapExpr(e, (x) => nestedHit(x, fail, outer, blocks));
}

// The `mapExpr` step of `resolveNested`: a nested block, or an outer reference
// to an enclosing alias (its value is already resolved: inlined as is, shifted).
function nestedHit(x: Expr, fail: Fail, outer: AliasScopes, blocks: AliasScopes): Expr | null {
  if (x.kind === "op") return resolveOp(x, fail, blocks);
  if (x.kind === "outer") {
    const scope = outer[x.levels - 1];
    const a = scope?.get(x.name);
    if (a === undefined) return null;
    if (a === FORWARD) fail(`select alias '${x.name}' is used before it is defined — a select item (its nested blocks included) may reference only the items to its left`);
    return shiftOuter(a, x.levels);
  }
  return null;
}

/** `expr`, read `levels` scopes further in than where it was written: every
 * reference to the expression's own scope (a bare name — `$it` included — or an
 * outer reference reaching that scope or beyond) gains `levels` carets, while
 * the rows of the blocks inside the expression keep their own names. */
export function shiftOuter(expr: Expr, levels: number): Expr {
  // A synthetic query around the expression gives the walk the depths: a
  // query's select is read at depth 1 (the expression's own scope), a block
  // under it at depth 2, … (a subquery's select would sit at depth 0 — the op
  // around it supplies the step).
  const wrapper: Query = {
    kind: "query", span: [0, 0], source: { kind: "lit", span: [0, 0], value: null }, consumer: "collect", distinct: false,
    from: [], where: null, select: [{ kind: "field", span: [0, 0], name: "x", expr, lift: 0 }],
    orderBy: null, follow: null, frontier: null, flatten: [], groupBy: null, having: null, values: false, limit: null, offset: null,
  };
  const shifted = transform(wrapper, (e, ctx) => {
    if (e.kind === "ident") return ctx.depth === 1 ? { kind: "outer", span: e.span, levels, name: e.name } : e;
    // An outer reference whose target scope is the expression's scope (depth 1)
    // or outside it: `ctx.depth - e.levels <= 1`.
    if (e.kind === "outer" && ctx.depth - e.levels <= 1) return { ...e, levels: e.levels + levels };
    return e;
  });
  const item = shifted.select[0]!;
  return item.kind === "field" ? item.expr : item.op;
}

/** Rebuild `e` bottom-up, letting `f` replace a node (return `null` to keep it;
 * a replaced node's children are not visited — `f` owns them). Untouched nodes
 * are returned by reference. */
function mapExpr(e: Expr, f: (e: Expr) => Expr | null): Expr {
  const hit = f(e);
  if (hit !== null) return hit;
  const go = (x: Expr): Expr => mapExpr(x, f);
  switch (e.kind) {
    case "member": { const recv = go(e.recv); return recv === e.recv ? e : { ...e, recv }; }
    case "call": {
      const recv = e.recv ? go(e.recv) : null;
      const args = mapSame(e.args, go);
      return recv === e.recv && args === e.args ? e : { ...e, recv, args };
    }
    case "unary": case "required": { const expr = go(e.expr); return expr === e.expr ? e : { ...e, expr }; }
    case "binary": case "logical": case "in": {
      const left = go(e.left);
      const right = go(e.right);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "range": {
      const lo = e.lo ? go(e.lo) : null;
      const hi = e.hi ? go(e.hi) : null;
      return lo === e.lo && hi === e.hi ? e : { ...e, lo, hi };
    }
    case "tuple": {
      const items = mapSame(e.items, go);
      return items === e.items ? e : { ...e, items };
    }
    case "template": { // the text parts are strings; only the interpolations are expressions
      const parts = mapSame(e.parts, (p) => (typeof p === "string" ? p : go(p)));
      return parts === e.parts ? e : { ...e, parts };
    }
    case "aggregate": {
      const arg = e.arg ? go(e.arg) : null;
      return arg === e.arg ? e : { ...e, arg };
    }
    case "op": { // the receiver is read in this scope; the block is its own scope
      const receiver = go(e.receiver);
      return receiver === e.receiver ? e : { ...e, receiver };
    }
    default: return e; // lit, ident, binding, outer
  }
}

// An item other items may name: a `collect` item, or a named non-lift field.
function aliasName(it: SelectItem): string | null {
  if (it.kind === "collect") return it.name === "" ? null : it.name;
  return it.lift === 0 && it.name !== "" ? it.name : null;
}

// The alias names an item's own expression (the receiver, for a block) mentions
// as bare identifiers, excluding its own name (the row field).
function aliasRefs(it: SelectItem, index: ReadonlyMap<string, number>): string[] {
  const own = aliasName(it);
  const out: string[] = [];
  const visit = (e: Expr): void => {
    mapExpr(e, (x) => {
      if (x.kind === "ident" && x.name !== own && index.has(x.name) && !out.includes(x.name)) out.push(x.name);
      return null;
    });
  };
  visit(it.kind === "collect" ? it.op.receiver : it.expr);
  return out;
}

/** Resolve one body's `select` items left to right. An item's bare identifier
 * that names an item to its left is replaced by that item's resolved value — a
 * block alias inlines as a value-position directive — and the item's own name
 * is the row field; the item's nested blocks read the items to its left through
 * `^name` (0.27) and the bodies around through deeper carets (`env`). A
 * reference to an item to its right fails: as a cycle when that item refers
 * back, else as a forward reference. Exported for the parser's validation pass. */
export function resolveSelect(select: readonly SelectItem[], fail: Fail = failPlain, env: AliasScopes = []): SelectItem[] {
  const index = new Map<string, number>();
  select.forEach((it, i) => { const n = aliasName(it); if (n !== null) index.set(n, i); });
  const resolved = new Map<string, AliasValue>();
  // The items to the right are FORWARD until resolved, so a nested block naming
  // one through `^` is the forward-reference error, not a silent row read.
  for (const n of index.keys()) if (!n.startsWith("$")) resolved.set(n, FORWARD);
  let out: SelectItem[] | null = null;
  for (let i = 0; i < select.length; i++) {
    const it = select[i]!;
    const own = aliasName(it);
    // Inside this item's own blocks, its own name is the row field (no entry).
    const left = new Map(resolved);
    if (own !== null) left.delete(own);
    const blocks: AliasScopes = [left, ...env];
    // One pass over the item: an alias to the left inlines its (already
    // resolved) value as is; the rest resolves as `resolveNested`.
    const subst = (e: Expr): Expr => mapExpr(e, (x) => {
      if (x.kind !== "ident") return nestedHit(x, fail, env, blocks);
      if (x.name === own) return x;
      const r = resolved.get(x.name);
      if (r !== undefined && r !== FORWARD) return r;
      const j = index.get(x.name);
      if (j === undefined || j <= i) return null;
      const back = own === null ? null : cyclePath(select, index, j, own);
      if (back) fail(`select aliases form a cycle: ${[own, ...back].join(" → ")} — an alias cannot depend on itself`);
      fail(`select alias '${x.name}' is used before it is defined — a select item may reference only the items to its left`);
    });
    let r: SelectItem;
    if (it.kind === "collect") {
      const receiver = subst(it.op.receiver);
      const sub = resolveBody(it.op.sub, fail, blocks);
      const op = receiver === it.op.receiver && sub === it.op.sub ? it.op : { ...it.op, receiver, sub };
      r = op === it.op ? it : { ...it, op };
      if (own !== null && !own.startsWith("$")) resolved.set(own, op);
    } else {
      const expr = subst(it.expr);
      r = expr === it.expr ? it : expr.kind === "op"
        ? { kind: "collect", span: it.span, name: it.name, op: expr }
        : { ...it, expr };
      if (own !== null && !own.startsWith("$")) resolved.set(own, expr);
    }
    if (r !== it) { out ??= select.slice(); out[i] = r; }
  }
  return out ?? (select as SelectItem[]);
}

// The alias path from item `from` back to the alias `to`, if the raw reference
// graph has one (`[b, a]` for `a: b, b: a` from `b` back to `a`).
function cyclePath(select: readonly SelectItem[], index: ReadonlyMap<string, number>, from: number, to: string): string[] | null {
  const seen = new Set<number>();
  const go = (i: number, path: string[]): string[] | null => {
    if (seen.has(i)) return null;
    seen.add(i);
    const it = select[i]!;
    const name = aliasName(it)!;
    for (const ref of aliasRefs(it, index)) {
      if (ref === to) return [...path, name, to];
      const hit = go(index.get(ref)!, [...path, name]);
      if (hit) return hit;
    }
    return null;
  };
  return go(from, []);
}

/** Resolve one body's `where` against its `select` (this body only; nested
 * blocks are left as they are). A block alias alone as a leaf is the non-empty
 * test; inside an expression it inlines as a value-position directive (0.27).
 * Exported for the parser's validation pass. */
export function resolveWhere(select: readonly SelectItem[], where: Where, fail: Fail = failPlain): Where {
  if (select.length === 0) return where;
  const aliases = new Map<string, SelectItem>();
  for (const it of select) {
    const n = aliasName(it);
    if (n !== null) aliases.set(n, it);
  }
  if (aliases.size === 0) return where;
  const resolving: string[] = [];
  const subst = (e: Expr): Expr => mapExpr(e, (x) => {
    if (x.kind !== "ident") return null;
    const a = aliases.get(x.name);
    if (!a) return null;
    if (resolving[resolving.length - 1] === x.name) return x; // its own name inside its own expression: the row field
    if (resolving.includes(x.name)) {
      const cycle = [...resolving.slice(resolving.indexOf(x.name)), x.name].join(" → ");
      fail(`select aliases form a cycle: ${cycle} — an alias used in \`where\` cannot depend on itself`);
    }
    if (a.kind === "collect") {
      // The block's receiver may itself name aliases; its body is its own scope.
      resolving.push(x.name);
      const receiver = subst(a.op.receiver);
      resolving.pop();
      return receiver === a.op.receiver ? a.op : { ...a.op, receiver };
    }
    resolving.push(x.name);
    const out = subst(a.expr);
    resolving.pop();
    return out;
  });
  const walk = (w: Where): Where => {
    switch (w.kind) {
      case "and": case "or": { const parts = mapSame(w.parts, walk); return parts === w.parts ? w : { ...w, parts }; }
      case "not": { const expr = walk(w.expr); return expr === w.expr ? w : { ...w, expr }; }
      case "scalar": {
        if (w.expr.kind === "ident") {
          const a = aliases.get(w.expr.name);
          if (a?.kind === "collect") return a.op; // a collection in predicate position: non-empty
        }
        const expr = subst(w.expr);
        return expr === w.expr ? w : { ...w, expr };
      }
      case "op": { // the receiver is read in this scope; the block is its own scope
        const receiver = subst(w.receiver);
        return receiver === w.receiver ? w : { ...w, receiver };
      }
    }
  };
  return walk(where);
}

/** The row-reading clauses of one body resolved against its (resolved) select —
 * what the parser validates aggregates and group reads over (0.27). */
export function resolveRowClauses(
  select: readonly SelectItem[],
  clauses: { frontier: Expr | null; flatten: readonly Flatten[]; groupBy: GroupBy | null; orderBy: readonly import("./ast.ts").OrderSpec[] | null },
  fail: Fail = failPlain,
): { frontier: Expr | null; flatten: Flatten[]; groupBy: GroupBy | null; orderBy: import("./ast.ts").OrderSpec[] | null; select: SelectItem[]; aliasedKeys: ReadonlySet<string> } {
  const own = aliasEnv(select);
  const outer: AliasScopes = [];
  const inner: AliasScopes = [own];
  const frontier = clauses.frontier === null ? null : resolveRowExpr(clauses.frontier, own, fail, outer, inner);
  const flatten = mapSame(clauses.flatten as Flatten[], (f) => { const expr = resolveRowExpr(f.expr, own, fail, outer, inner); return expr === f.expr ? f : { ...f, expr }; });
  let groupBy = clauses.groupBy;
  let aliasedKeys: ReadonlySet<string> = new Set();
  let items = select as SelectItem[];
  let ownPost = own;
  if (clauses.groupBy !== null) {
    const keyed = resolveGroupKeys(clauses.groupBy, own, fail, outer, inner);
    groupBy = keyed.groupBy;
    aliasedKeys = keyed.aliased;
    if (keyed.aliased.size > 0) {
      items = readKeys(items, keyed.aliased);
      ownPost = withoutKeys(own, keyed.aliased);
    }
  }
  // `order by` of a grouped body reads the group: an aliased key's name is the key.
  const orderBy = clauses.orderBy === null ? null : mapSame(clauses.orderBy as import("./ast.ts").OrderSpec[], (o) => { const expr = resolveRowExpr(o.expr, ownPost, fail, outer, inner); return expr === o.expr ? o : { ...o, expr }; });
  return { frontier, flatten, groupBy, orderBy, select: items, aliasedKeys };
}

// `map` that returns the input array itself when no element changed.
function mapSame<T>(xs: readonly T[], f: (x: T) => T): T[] {
  let out: T[] | null = null;
  for (let i = 0; i < xs.length; i++) {
    const y = f(xs[i]!);
    if (y !== xs[i]) {
      out ??= xs.slice();
      out[i] = y;
    }
  }
  return out ?? (xs as T[]);
}
