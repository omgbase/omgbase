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
  SurfaceQuery, SurfaceTarget, SurfaceWhere, SurfaceOp, SurfaceSubquery, SurfaceSelectItem,
} from "./ast.js";
import type {
  Query, NestedQuery, CollectionOp, WhereExpr, SelectItem, CelTarget,
} from "./ir.js";

const SURFACE_TO_CEL: Record<SurfaceTarget, CelTarget> = {
  docs: "docs",
  blocks: "blocks",
  nodes: "nodes",
};

const TARGET_NOUN: Record<CelTarget, string> = {
  docs: "doc",
  blocks: "block",
  nodes: "node",
};

// A subquery body is lowered in one of two modes: "normal" (a regular body:
// select-position collect, or an exists/count where-body — no lifts), or
// "whereLift" (the body of a top-level where-position collect — every select
// item must be a lift). Both propagate "normal" to any deeper nested op.
type BodyMode = "normal" | "whereLift";

export function lowerQuery(sq: SurfaceQuery): Query {
  return {
    kind: "query",
    target: SURFACE_TO_CEL[sq.from],
    where: sq.where ? lowerWhere(sq.where, SURFACE_TO_CEL[sq.from], true) : null,
    select: sq.select.map((s) => lowerSelect(s, SURFACE_TO_CEL[sq.from], "normal")),
  };
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
  if (rel.from !== target) {
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

function lowerSubquery(s: SurfaceSubquery, target: CelTarget, bodyMode: BodyMode): NestedQuery {
  return {
    target,
    // Ops inside a subquery are never in the top-level where scope.
    where: s.where ? lowerWhere(s.where, target, false) : null,
    select: s.select.map((sel) => lowerSelect(sel, target, bodyMode)),
  };
}

function lowerSelect(s: SurfaceSelectItem, target: CelTarget, bodyMode: BodyMode): SelectItem {
  if (s.kind === "collect") {
    if (bodyMode === "whereLift") {
      throw new FilterInvalid("a where-position collect projects only via ^lift scalar values, not a nested collect", "OQX lifts");
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
  return Object.values(RELATIONS).filter((r) => r.from === target).map((r) => r.name);
}
