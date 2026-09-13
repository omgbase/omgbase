// OQX AST → IR lowering (slice 2 + lifts). Resolves receiver tokens to
// structural relations against the enclosing scope's target, lowers the
// where-clause boolean tree, classifies a bare where-position collection op as
// `exists` (narrow truthiness), threads `count(...) <op> <int>` comparisons, and
// handles one-scope lifts (`^name:`). Same-target scope nesting is supported
// (compile.ts allocates a distinct alias per scope); single-valued and
// data-unavailable relations still fail loudly rather than silently
// mis-answering.
//
// Lift rules (see the OQX design note): a `^name: expr` item is valid ONLY in
// the body of a `collect` that sits directly in the TOP-LEVEL `where` — that
// collect both filters (non-empty) and binds each `^name` one scope out (into
// the top-level select). Such a where-collect body must contain only lifts.
// Deeper re-lifts and select-position lifts fail loudly (deferred).

import { FilterInvalid } from "../search/cel/parser.js";
import { RELATIONS } from "./relations.js";
import type {
  SurfaceQuery, SurfaceWhere, SurfaceOp, SurfaceSubquery, SurfaceSelectItem, SurfaceFollow,
} from "./ast.js";
import type {
  Query, NestedQuery, CollectionOp, WhereExpr, SelectItem, CelTarget, FollowSpec, Relation,
} from "./ir.js";

// Hard cap on follow recursion depth.
const HARD_DEPTH_CAP = 8;

// Recursion intrinsics ($depth/$stop/$leaf/$frontier) are RESULT metadata,
// defined only post-walk. They may appear in select / order by, but not in a
// membership `where`, a follow successor `where`, or a `frontier` (all evaluated
// pre/mid-walk). Detected on the verbatim scalar source.
const RECUR_INTRINSIC = /\$(?:stop|leaf|frontier|depth|ordinal)\b/;

const TARGET_NOUN: Record<CelTarget, string> = {
  docs: "doc",
  blocks: "block",
  nodes: "node",
};

// The bare root collections a top-level `from` (or a top-level consumer receiver)
// may select — the implicit repository root's `docs`/`blocks`/`nodes` properties,
// spellable either bare or via the explicit `repo.<target>` root relation.
const TOP_BASE: Record<string, CelTarget> = {
  docs: "docs", blocks: "blocks", nodes: "nodes",
  "repo.docs": "docs", "repo.blocks": "blocks", "repo.nodes": "nodes",
};

// Resolve the top-level source chain (`from docs` / `repo.nodes from doc` / …):
// the first entry selects a root collection; each further entry re-projects it
// through a structural relation (a typed flatMap over host-model navigation).
function resolveSourceChain(from: string[]): { baseTarget: CelTarget; sourceRelations: Relation[]; target: CelTarget } {
  const first = from[0]!;
  const baseTarget = TOP_BASE[first];
  if (!baseTarget) {
    throw new FilterInvalid(
      `top-level \`from ${first}\` must select a root collection: docs, blocks, or nodes (spellable as repo.<target>)`,
      "OQX from",
    );
  }
  let target = baseTarget;
  const sourceRelations: Relation[] = [];
  for (const nav of from.slice(1)) {
    const rel = resolveFromRelation(nav, target);
    sourceRelations.push(rel);
    target = rel.childTarget;
  }
  return { baseTarget, sourceRelations, target };
}

// Resolve a body-level `from E` source projection to a structural relation,
// advancing the row type. Unlike a collection-op receiver, a `from` MAY be
// single-valued (a scalar/optional relation contributes zero-or-one row); it may
// NOT be a repository-wide root scan (that is not a per-row projection).
function resolveFromRelation(nav: string, fromTarget: CelTarget): Relation {
  const noun = TARGET_NOUN[fromTarget];
  const key = nav.includes(".") ? nav : `${noun}.${nav}`;
  const rel = RELATIONS[key];
  if (!rel) {
    throw new FilterInvalid(
      `no navigable relation '${nav}' from ${fromTarget} (have: ${relationsFrom(fromTarget).join(", ")})`,
      "OQX from",
    );
  }
  if (rel.root) {
    throw new FilterInvalid(`'${key}' is a repository-wide root relation; \`from\` re-projects per row, not a global scan`, "OQX from");
  }
  if (rel.from !== fromTarget) {
    throw new FilterInvalid(`relation '${key}' is not reachable from ${fromTarget}`, "OQX from");
  }
  if (rel.unavailable) {
    throw new FilterInvalid(`relation '${key}' is unavailable: ${rel.unavailable}`, "OQX from");
  }
  return rel;
}

// A subquery body is lowered in one of two modes: "normal" (a regular body:
// select-position collect, or an exists/count where-body — no lifts), or
// "whereLift" (the body of a top-level where-position collect — every select
// item must be a lift). Both propagate "normal" to any deeper nested op.
type BodyMode = "normal" | "whereLift";

export function lowerQuery(sq: SurfaceQuery): Query {
  const { baseTarget, sourceRelations, target } = resolveSourceChain(sq.from);
  if (sourceRelations.length > 0 && sq.follow) {
    throw new FilterInvalid("a re-projected source (`from E`) combined with `follow` is not supported yet", "OQX from");
  }
  // In a follow query the top-level `where` has two phases: SEED conjuncts
  // (evaluated in the CTE base, before recursion metadata exists — no recursion
  // intrinsics) and RESULT conjuncts that reference recursion intrinsics
  // ($depth/$stop/$leaf/$frontier), which filter the walk's result post-walk.
  // Partition them; a plain (non-follow) query keeps its whole where as seed.
  let seedWhere = sq.where;
  let postWhere: SurfaceWhere | null = null;
  if (sq.follow && sq.where) {
    const split = partitionFollowWhere(sq.where);
    seedWhere = split.seed;
    postWhere = split.post;
  }
  return {
    kind: "query",
    target,
    baseTarget,
    sourceRelations,
    where: seedWhere ? lowerWhere(seedWhere, target, true) : null,
    select: sq.select.map((s) => lowerSelect(s, target, "normal")),
    consumer: sq.consumer ?? "collect",
    // order expressions are scalar values compiled against the query target;
    // captured verbatim, so lowering just carries them through.
    ...(sq.orderBy && sq.orderBy.length > 0 ? { orderBy: sq.orderBy } : {}),
    ...(sq.follow ? { follow: lowerFollow(sq.follow, target) } : {}),
    ...(postWhere ? { postWhere: lowerWhere(postWhere, target, true) } : {}),
  };
}

// Split a follow query's top-level `where` into SEED conjuncts (no recursion
// intrinsic) and RESULT/post-walk conjuncts (referencing $depth/$stop/…). Only
// top-level AND conjuncts are partitionable; a recursion intrinsic inside a
// collection op is a loud error (undefined in a nested scope).
function partitionFollowWhere(w: SurfaceWhere): { seed: SurfaceWhere | null; post: SurfaceWhere | null } {
  const parts = w.kind === "and" ? w.parts : [w];
  const seed: SurfaceWhere[] = [];
  const post: SurfaceWhere[] = [];
  for (const p of parts) {
    if (whereHasRecur(p)) {
      assertRecurNotInOp(p);
      post.push(p);
    } else {
      seed.push(p);
    }
  }
  const rebuild = (ps: SurfaceWhere[]): SurfaceWhere | null =>
    ps.length === 0 ? null : ps.length === 1 ? ps[0]! : { kind: "and", parts: ps };
  return { seed: rebuild(seed), post: rebuild(post) };
}

// Does any scalar leaf in this where subtree reference a recursion intrinsic?
function whereHasRecur(w: SurfaceWhere): boolean {
  switch (w.kind) {
    case "and": case "or": return w.parts.some(whereHasRecur);
    case "not": return whereHasRecur(w.expr);
    case "scalar": return RECUR_INTRINSIC.test(w.source);
    case "op": return subqueryHasRecur(w.sub);
  }
}
function subqueryHasRecur(sub: SurfaceSubquery): boolean {
  if (sub.where && whereHasRecur(sub.where)) return true;
  return sub.select.some((it) => (it.kind === "collect" ? subqueryHasRecur(it.op.sub) : RECUR_INTRINSIC.test(it.source)));
}

// A post-walk conjunct may combine recursion intrinsics with row predicates via
// &&/||/!, but a recursion intrinsic inside a collection op is meaningless (the
// op is a nested pre-walk scope) — reject it loudly.
function assertRecurNotInOp(w: SurfaceWhere): void {
  switch (w.kind) {
    case "and": case "or": w.parts.forEach(assertRecurNotInOp); return;
    case "not": assertRecurNotInOp(w.expr); return;
    case "scalar": return;
    case "op":
      if (subqueryHasRecur(w.sub)) {
        throw new FilterInvalid(
          "a recursion intrinsic ($depth/$stop/$leaf/$frontier) cannot appear inside a collection op — it is result metadata of the walk",
          "OQX follow",
        );
      }
      return;
  }
}

// Resolve a follow receiver to a type-preserving structural relation and lower
// its successor/frontier predicates. The receiver resolves exactly like a
// collection-op receiver (`${noun}.${receiver}`); the extra rules are that the
// relation must be per-row (not a root scan) and TYPE-PRESERVING (its childTarget
// equals the query row type) — recursion is closed over T.
function lowerFollow(sf: SurfaceFollow, target: CelTarget): FollowSpec {
  const noun = TARGET_NOUN[target];
  const key = sf.receiver.includes(".") ? sf.receiver : `${noun}.${sf.receiver}`;
  const rel = RELATIONS[key];
  if (!rel) {
    throw new FilterInvalid(
      `no structural relation '${sf.receiver}' to follow from ${target} (have: ${relationsFrom(target).join(", ")})`,
      "OQX follow",
    );
  }
  if (rel.root) {
    throw new FilterInvalid(
      `'${key}' is a repository-wide root relation; follow needs a per-row successor relation, not an unbounded scan`,
      "OQX follow",
    );
  }
  if (rel.from !== target) {
    throw new FilterInvalid(`relation '${key}' is not reachable from ${target}`, "OQX follow");
  }
  if (rel.unavailable) {
    throw new FilterInvalid(`relation '${key}' is unavailable: ${rel.unavailable}`, "OQX follow");
  }
  if (rel.childTarget !== target) {
    throw new FilterInvalid(
      `follow must preserve the row type: '${key}' yields ${rel.childTarget}, but the query is over ${target}`,
      "OQX follow",
    );
  }
  if (sf.where) assertNoRecurIntrinsics(sf.where, "a follow successor `where`");
  if (sf.frontier) assertNoRecurIntrinsics(sf.frontier, "a follow `frontier`");
  if (sf.by) assertNoRecurIntrinsics(sf.by, "a follow `by` identity");
  return {
    relation: rel,
    distinct: sf.distinct,
    successorWhere: sf.where ? { kind: "scalar", source: sf.where, target } : null,
    frontier: sf.frontier ? { kind: "scalar", source: sf.frontier, target } : null,
    maxDepth: sf.depth ?? HARD_DEPTH_CAP,
    by: sf.by ? { kind: "scalar", source: sf.by, target } : null,
  };
}

function assertNoRecurIntrinsics(source: string, position: string): void {
  const m = RECUR_INTRINSIC.exec(source);
  if (m) {
    throw new FilterInvalid(
      `recursion intrinsic ${m[0]} is result metadata (usable in select / order by); it is not valid in ${position}`,
      "OQX follow",
    );
  }
}

// topWhere: is this expression in the TOP-LEVEL where scope (depth 0)? Boolean
// combinators keep the same scope; an op's subquery does not.
function lowerWhere(w: SurfaceWhere, target: CelTarget, topWhere: boolean): WhereExpr {
  switch (w.kind) {
    case "and": return { kind: "and", parts: w.parts.map((p) => lowerWhere(p, target, topWhere)) };
    case "or": return { kind: "or", parts: w.parts.map((p) => lowerWhere(p, target, topWhere)) };
    case "not": return { kind: "not", expr: lowerWhere(w.expr, target, topWhere) };
    case "scalar": return { kind: "scalar", source: w.source, target };
    case "op": {
      if (w.sub.follow) {
        throw new FilterInvalid("`follow` is only valid on a select-position collect(...), not a where-position op", "OQX follow");
      }
      if (w.op === "collect") {
        const hasLift = w.sub.select.some((s) => s.kind === "field" && s.lift);
        if (!hasLift) {
          throw new FilterInvalid("collect(...) is a projection; use it in select, or use exists/count in where", "OQX §2");
        }
        if (!topWhere) {
          throw new FilterInvalid(
            "a lift-bearing collect in where is only supported at the top level (a lift moves exactly one scope; re-lift at the intermediate scope is not supported yet)",
            "OQX lifts",
          );
        }
        if (w.countCmp) throw new FilterInvalid("collect(...) cannot carry a count comparison", "OQX §2");
        return lowerOp(w, target, "whereLift");
      }
      if (w.op === "first" || w.op === "single") {
        throw new FilterInvalid(
          `${w.op}(...) is a select-position lookup; in where use ${w.receiver}.exists(...) (existence) or ${w.receiver}.count(...) <op> N`,
          "OQX §2",
        );
      }
      if (w.countCmp && w.op !== "count") {
        throw new FilterInvalid(`only count(...) is comparable; '${w.op}(...) <op> N' is not valid`, "OQX §2");
      }
      const op = lowerOp(w, target, "normal");
      if (w.countCmp) op.countCmp = w.countCmp;
      return op;
    }
  }
}

function lowerOp(o: SurfaceOp, target: CelTarget, bodyMode: BodyMode): CollectionOp {
  const noun = TARGET_NOUN[target];
  const key = o.receiver.includes(".") ? o.receiver : `${noun}.${o.receiver}`;
  const rel = RELATIONS[key];
  if (!rel) {
    throw new FilterInvalid(
      `no structural relation '${o.receiver}' from ${target} (have: ${relationsFrom(target).join(", ")})`,
      "OQX §2",
    );
  }
  // Root relations (repo.<target>) are reachable from any scope; structural
  // relations are anchored to the target they hang off.
  if (!rel.root && rel.from !== target) {
    throw new FilterInvalid(`relation '${key}' is not reachable from ${target}`, "OQX §2");
  }
  if (rel.singleValued) {
    throw new FilterInvalid(
      `relation '${key}' is single-valued; use ${rel.name.split(".")[1]}.<field> reach-through directly (e.g. doc.layer == "canon")`,
      "OQX §2",
    );
  }
  if (rel.unavailable) {
    throw new FilterInvalid(`relation '${key}' is unavailable: ${rel.unavailable}`, "OQX §2");
  }
  return { kind: "collectionOp", op: o.op, relation: rel, subquery: lowerSubquery(o.sub, rel.childTarget, bodyMode) };
}

function lowerSubquery(s: SurfaceSubquery, receiverTarget: CelTarget, bodyMode: BodyMode): NestedQuery {
  // A body-level `from E` re-projection inside a NESTED consumer (a collect/
  // exists/… within a where/select) is not supported yet — top-level relative
  // `from` (the common case) is. The receiver relation already establishes the
  // block's row type; re-projecting it further nests a correlated JOIN chain
  // that the correlated-body compiler does not build yet.
  if (s.from.length > 0) {
    throw new FilterInvalid(
      "a `from` source projection inside a nested consumer block is not supported yet; re-project at the top level (e.g. `repo.docs collect { from nodes … }`)",
      "OQX from",
    );
  }
  const target = receiverTarget;
  const nq: NestedQuery = {
    target,
    // Ops inside a subquery are never in the top-level where scope.
    where: s.where ? lowerWhere(s.where, target, false) : null,
    select: s.select.map((sel) => lowerSelect(sel, target, bodyMode)),
  };
  if (s.follow) {
    // The nested collect's `where` is the SEED (correlated to the current row);
    // recursion intrinsics are post-walk result metadata, invalid there.
    if (s.where && whereHasRecur(s.where)) {
      throw new FilterInvalid(
        "a recursion intrinsic ($depth/$stop/…) is result metadata — usable in a nested follow-collect's `select`, not its `where` (the seed)",
        "OQX follow",
      );
    }
    nq.follow = lowerFollow(s.follow, target);
  }
  return nq;
}

function lowerSelect(s: SurfaceSelectItem, target: CelTarget, bodyMode: BodyMode): SelectItem {
  if (s.kind === "collect") {
    if (bodyMode === "whereLift") {
      throw new FilterInvalid("a where-position collect projects only via ^lift scalar values, not a nested collect", "OQX lifts");
    }
    if (s.op.sub.follow && s.op.op !== "collect") {
      throw new FilterInvalid(`\`follow\` is only valid on collect(...), not ${s.op.op}(...)`, "OQX follow");
    }
    // A select-position collect's own body is a normal projection scope (no lifts).
    return { kind: "collect", name: s.name, op: lowerOp(s.op, target, "normal") };
  }
  if (bodyMode === "whereLift") {
    if (!s.lift) {
      throw new FilterInvalid(`a where-position collect projects only via ^lifts — mark '${s.name}' as ^${s.name}`, "OQX lifts");
    }
    return { kind: "field", name: s.name, source: s.source, lift: true };
  }
  // normal scope: a ^lift here has no enclosing collect to bind out of.
  if (s.lift) {
    throw new FilterInvalid(`^${s.name} lift is only valid inside a top-level where-position collect`, "OQX lifts");
  }
  return { kind: "field", name: s.name, source: s.source };
}

function relationsFrom(target: CelTarget): string[] {
  return Object.values(RELATIONS).filter((r) => r.root || r.from === target).map((r) => r.name);
}
