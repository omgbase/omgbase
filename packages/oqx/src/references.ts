// The `references` static pass (spec/oqx/AST.md §5b, language 0.23): every
// NAME a query reads from a row — a bare identifier, a dotted navigation headed
// by one, an outer reference — with the clause it stands in and the SCOPE whose
// rows it is read from, described as the chain of expressions that produce
// those rows (the source, each `from` re-projection, each block receiver, each
// `follow` walk). The pass knows no data: a host that knows what rows an
// expression yields maps each scope to a row type and judges the name against
// it (omgbase: "is `target` a field of links?"). Built on `visit`, so a future
// node kind is walked here the day it is added to `CHILDREN`.
//
// What is a reference and what is not (the rules, pinned by
// `cases/references.json`):
//   • a bare `ident` is a reference to the current row's property, with the
//     name as written; a `member` chain headed by an `ident` or `outer` is ONE
//     reference whose name is the full dotted path (`doc.layer`, `meta.owner`);
//     a chain headed by anything else (a call, a block, a literal, a tuple) is
//     not — its head is walked and the trailing `.name`s are ignored, since the
//     head's value is not a row of any scope;
//   • an `outer` (`^name`, `N^name`) is a reference read in the scope `levels`
//     out; `$it` as a head is the row itself (`$it.title` ≡ `title`,
//     `^$it.title` ≡ `^title`) and `$it` alone is no reference;
//   • `$`-names (`$key`, `$depth`, `$stop`, …) are the language's values, never
//     references; a `binding` is a host value; a function or method NAME is
//     not a reference, its receiver and arguments are walked
//     (`target.contains("x")` references `target`); a name a nested block
//     LIFTS onto a scope (`^open: value`, SEMANTICS §19) is a binding of that
//     scope, so reading it there (`select open`, `^open` from deeper) is not a
//     reference either — and neither is a name a `flatten` bound (0.25,
//     SEMANTICS §25) in the clauses after it: a later `flatten`, `group by`,
//     `having`, the select, `order by`, or `^name` from a block under them; in
//     its own expression and before the clause (`where`, `frontier`, `follow`)
//     the name is still the row's property;
//   • a `select` alias is not a reference where the language resolves it
//     (SEMANTICS §14): in the same body's `where`, and in the items to its
//     right — a bare identifier naming such an alias, or a chain headed by it,
//     is skipped; an alias's own name inside its own item is the row field and
//     IS a reference; `order by`, `frontier`, `limit`/`offset`, `from` and
//     `follow` are not rewritten against aliases, so a name there is a
//     reference whatever the `select` says;
//   • a name read at the ROOT scope — the head of the top-level `source`
//     (`from people`: clause `source`), an outer reference with as many carets
//     as there are enclosing scopes (`^docs` from a top-level row) — is
//     reported with depth 0 and no steps: it names one of the host's roots,
//     and the host decides what to make of it;
//   • a `follow` destination that is a plain expression is a reference read
//     on the frontier row (clause `follow.destination`), like a `from`.
//
// The scope: `{ depth, steps }`. `depth` is the scope depth the name is
// evaluated at (`visit`'s depth; for an outer reference, that depth minus its
// levels). `steps` are the expressions that produce the scope's rows, root
// first, each with the depth of the rows it produces: the query's `source`
// (depth 1), each `from` re-projection in turn (the same depth — a `from`
// replaces the rows), a block's receiver (one deeper than where it is read),
// then the block's own `from`s; a `follow` node is a step too — the walk's
// frontier rows, at the body's depth, which the destinations are read on
// (a destination block's receiver is then one deeper). A name read inside the
// k-th `from` sees only the steps before it. For an outer reference the steps
// are cut after the last step at its scope's depth. The empty list is the root
// scope.

import type { AstNode, Expr, Flatten, Follow, GroupBy, Query, SelectItem, Span, Subquery } from "./ast.ts";
import type { Clause } from "./walk.ts";
import { visit } from "./walk.ts";

/** One step of a scope's row chain: an expression (a source, a `from`, a block
 * receiver, a plain destination), a `follow` node (the walk's frontier rows), or
 * — since 0.24 — a `groupBy` node (the body's groups: the rows at the same depth
 * replaced by one key record per group), with the scope depth of the rows it
 * produces. */
export interface ReferenceStep {
  readonly expr: Expr | Follow | GroupBy;
  readonly depth: number;
}

export interface ReferenceScope {
  /** The scope depth the name is read at (SEMANTICS §2; 0 = the root scope). */
  readonly depth: number;
  /** The row chain producing the scope's rows, root first. */
  readonly steps: readonly ReferenceStep[];
}

export interface Reference {
  /** The name as written — the full dotted path for a navigation (`doc.layer`), without a `$it.` head. */
  readonly name: string;
  readonly clause: Clause;
  readonly scope: ReferenceScope;
  /** The span of the whole reference (the chain, for a navigation). */
  readonly span: Span;
}

/** A dotted name headed by an `ident` or `outer`: the head and the path after it. */
function dottedName(e: Expr): { head: Expr & { kind: "ident" | "outer" }; path: string[] } | null {
  if (e.kind === "ident" || e.kind === "outer") return { head: e, path: [] };
  if (e.kind === "member") {
    const inner = dottedName(e.recv);
    return inner === null ? null : { head: inner.head, path: [...inner.path, e.name] };
  }
  return null;
}

/** The alias an item defines (SEMANTICS §14): a named `collect`, or a named non-lift field. */
function aliasName(it: SelectItem): string | null {
  if (it.kind === "collect") return it.name === "" ? null : it.name;
  return it.lift === 0 && it.name !== "" ? it.name : null;
}

/** Every name a query (or block body) reads from a row, in canonical source order. */
export function references(root: Query | Subquery): Reference[] {
  const out: Reference[] = [];
  const lifts = new Map<Query | Subquery, ReadonlySet<string>>();
  visit(root, {
    enter(node, ctx) {
      const named = dottedName(node as Expr);
      if (named === null) return;
      const { head } = named;
      // The head of a navigation is handled here, once, with the chain's full name.
      let name = head.name;
      let path = named.path;
      if (name === "$it") {
        if (path.length === 0) return false; // the row itself
        name = path[0]!;
        path = path.slice(1);
      } else if (name.startsWith("$")) return false; // a language value
      if (ctx.clause === null) return false; // unreachable: the root node is never a name
      if (head.kind === "ident" && isResolvedAlias(name, ctx.path, ctx.clause)) return false;
      const levels = head.kind === "outer" ? head.levels : 0;
      const depth = ctx.depth - levels;
      if (isLiftBound(name, depth, ctx.path, lifts)) return false;
      // A name a `flatten` bound (0.25) is an alias of the expression already
      // reported in clause `flatten`, read in the clauses after it.
      if (isFlattenBound(name, depth, ctx.path, node)) return false;
      // At a group scope (0.24) a bare key name is the key — an alias of the
      // expression reported in clause `groupBy` — and `rows` is the language's
      // value; neither reads a row.
      if (isGroupValue(name, depth, ctx.path, node)) return false;
      const full = [name, ...path].join(".");
      const steps = scopeSteps(ctx.path, node);
      const scoped = levels === 0 ? steps : cutAt(steps, depth);
      out.push({ name: full, clause: ctx.clause, scope: { depth, steps: scoped }, span: node.span });
      return false;
    },
  });
  return out;
}

/** Whether a bare `name` in this position is a `select` alias the language
 * substitutes (so the name is the alias, not a row property): in the body's
 * `where` or `having`, any alias; in a `select` item, an alias defined to its LEFT. */
function isResolvedAlias(name: string, path: readonly AstNode[], clause: Clause): boolean {
  if (clause !== "where" && clause !== "select" && clause !== "having") return false;
  // The nearest body, and the item under it when we are inside its select.
  for (let i = path.length - 1; i >= 0; i--) {
    const a = path[i]!;
    if (a.kind !== "query" && a.kind !== "subquery") continue;
    const index = new Map<string, number>();
    a.select.forEach((it, j) => { const n = aliasName(it); if (n !== null) index.set(n, j); });
    const j = index.get(name);
    if (j === undefined) return false;
    if (clause === "where" || clause === "having") return true;
    const item = path[i + 1];
    const at = item === undefined ? -1 : a.select.indexOf(item as SelectItem);
    return at >= 0 && j < at;
  }
  return false;
}

/**
 * Whether `name`, read at scope `depth`, is bound there by a lift (`^name: expr`
 * in a nested block, SEMANTICS §19): the lifted value is appended to that
 * scope's row record, so the name is a binding, not a row property. The body
 * whose rows are at `depth` is the depth-th body on the path (every nested body
 * is one scope deeper than the one around it).
 */
function isLiftBound(name: string, depth: number, path: readonly AstNode[], cache: Map<Query | Subquery, ReadonlySet<string>>): boolean {
  if (depth < 1) return false;
  const bodies = path.filter((a): a is Query | Subquery => a.kind === "query" || a.kind === "subquery");
  const body = bodies[depth - 1];
  if (body === undefined) return false;
  let names = cache.get(body);
  if (names === undefined) {
    names = liftsLandingOn(body);
    cache.set(body, names);
  }
  return names.has(name);
}

/** The names the nested blocks of `body` lift onto it: a `field` item with `lift` L in a block L scopes below it. */
function liftsLandingOn(body: Query | Subquery): ReadonlySet<string> {
  const names = new Set<string>();
  const own = body.kind === "subquery" ? 1 : 0;
  visit(body, {
    enter(node, ctx) {
      if (node.kind !== "field" || node.lift === 0) return;
      const below = ctx.path.filter((a) => a.kind === "subquery").length - own;
      if (node.lift === below) names.add(node.name);
    },
  });
  return names;
}

/**
 * Whether `name`, read at scope `depth`, is bound there by a `flatten` of the
 * body whose rows are at `depth` (SEMANTICS §25) — the position lies in a
 * clause evaluated after that flatten: a later `flatten`, `group by`, `having`,
 * the select, or `order by` (`where`, `frontier`, `follow` and the body's
 * sources run before any flatten, and a flatten's own expression before itself).
 */
function isFlattenBound(name: string, depth: number, path: readonly AstNode[], node: AstNode): boolean {
  const i = bodyIndexAt(path, depth);
  if (i === -1) return false;
  const body = path[i] as Query | Subquery;
  if (body.flatten.length === 0) return false;
  const child = path[i + 1] ?? node;
  let upto: number;
  if (body.select.includes(child as SelectItem) || child === body.groupBy || child === body.having || (body.orderBy?.includes(child as never) ?? false)) {
    upto = body.flatten.length;
  } else {
    const k = body.flatten.indexOf(child as Flatten);
    if (k === -1) return false;
    upto = k;
  }
  for (let j = 0; j < upto; j++) if (body.flatten[j]!.name === name) return true;
  return false;
}

/**
 * Whether `name`, read at scope `depth`, is a value of a GROUP scope there
 * (SEMANTICS §24): the body whose rows are at `depth` has a `group by`, the
 * position is one of its post-group clauses — a select item, `having`, `order
 * by` — not inside an aggregate's argument (which reads the group's rows), and
 * the name is a key or `rows`.
 */
function isGroupValue(name: string, depth: number, path: readonly AstNode[], node: AstNode): boolean {
  const i = bodyIndexAt(path, depth);
  if (i === -1) return false;
  const body = path[i] as Query | Subquery;
  if (!atGroupScope(body, path, i, node)) return false;
  return name === "rows" || body.groupBy!.keys.some((k) => k.name === name);
}

/** The index in `path` of the body whose rows are at scope `depth` (every nested body is one scope deeper), or -1. */
function bodyIndexAt(path: readonly AstNode[], depth: number): number {
  if (depth < 1) return -1;
  let seen = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    if (a.kind !== "query" && a.kind !== "subquery") continue;
    if (++seen === depth) return i;
  }
  return -1;
}

/** Whether a position under `body` (at `path[i]`) reads the body's GROUP scope:
 * the body is grouped, the position lies in a select item, `having` or `order
 * by`, and no aggregate stands between the body and the position (an
 * aggregate's argument reads the group's rows; a nested body is its own scope
 * and ends the search). */
function atGroupScope(body: Query | Subquery, path: readonly AstNode[], i: number, node: AstNode): boolean {
  if (body.groupBy === null) return false;
  const child = path[i + 1] ?? node;
  const post = body.select.includes(child as SelectItem) || child === body.having || (body.orderBy?.includes(child as never) ?? false);
  if (!post) return false;
  for (let j = i + 1; j < path.length; j++) {
    const a = path[j]!;
    if (a.kind === "query" || a.kind === "subquery") break;
    if (a.kind === "aggregate") return false;
  }
  return true;
}

/** The row chain of the scope a node is evaluated in, from its ancestors. */
function scopeSteps(path: readonly AstNode[], node: AstNode): ReferenceStep[] {
  const steps: ReferenceStep[] = [];
  let depth = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const next: AstNode = path[i + 1] ?? node;
    switch (a.kind) {
      case "query": {
        if (next === a.source || next === a.limit || next === a.offset) break; // read at the root scope
        depth = 1;
        steps.push({ expr: a.source, depth });
        pushFroms(steps, a.from, next, depth);
        // A grouped body's post-group clauses read its groups (0.24): the rows
        // at this depth replaced by one key record per group.
        if (atGroupScope(a, path, i, node)) steps.push({ expr: a.groupBy!, depth });
        break;
      }
      case "subquery": {
        // The receiver step was pushed by the enclosing `op`; this body's rows
        // are one deeper than where that receiver was read.
        pushFroms(steps, a.from, next, depth);
        if (atGroupScope(a, path, i, node)) steps.push({ expr: a.groupBy!, depth });
        break;
      }
      case "op": {
        if (next !== a.sub) break; // inside the receiver: read where the block is read
        depth += 1;
        steps.push({ expr: a.receiver, depth });
        break;
      }
      case "follow": {
        // The destinations are read on the walk's frontier rows, at the body's depth.
        steps.push({ expr: a, depth });
        break;
      }
      default: break;
    }
  }
  return steps;
}

/** The `from` re-projections that apply at `next`: all of them unless `next` is one of them, in which case those before it. */
function pushFroms(steps: ReferenceStep[], from: readonly Expr[], next: AstNode, depth: number): void {
  const at = from.indexOf(next as Expr);
  const upto = at === -1 ? from.length : at;
  for (let k = 0; k < upto; k++) steps.push({ expr: from[k]!, depth });
}

/** The steps up to and including the last one producing rows at `depth` (none for the root scope). */
function cutAt(steps: readonly ReferenceStep[], depth: number): ReferenceStep[] {
  let end = 0;
  steps.forEach((s, i) => { if (s.depth === depth) end = i + 1; });
  return steps.slice(0, end);
}
