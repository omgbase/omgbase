// OQX AST → IR lowering (slice 1). Resolves receiver tokens to structural
// relations against the enclosing scope's target, classifies a bare
// where-position collection op as `exists` (narrow truthiness), and enforces
// the single-scope-per-target constraint that makes CEL-compiler alias reuse
// safe (see scalar.ts and the plan's Risk section).

import { FilterInvalid } from "../search/cel/parser.js";
import { RELATIONS } from "./relations.js";
import type {
  SurfaceQuery, SurfaceTarget, SurfaceTerm, SurfaceOp, SurfaceSubquery, SurfaceSelectItem,
} from "./ast.js";
import type {
  Query, NestedQuery, CollectionOp, WhereTerm, SelectItem, CelTarget,
} from "./ir.js";

const SURFACE_TO_CEL: Record<SurfaceTarget, CelTarget> = {
  docs: "docs",
  blocks: "blocks",
  nodes: "nodes",
};

// A receiver token (e.g. "nodes") is resolved to a relation by pairing the
// enclosing target with the token. The relation key is "<fromNoun>.<token>",
// where fromNoun is the singular noun for the enclosing target.
const TARGET_NOUN: Record<CelTarget, string> = {
  docs: "doc",
  blocks: "block",
  nodes: "node",
};

export function lowerQuery(sq: SurfaceQuery): Query {
  const target = SURFACE_TO_CEL[sq.from];
  // The top-level target owns one scope; track live targets so nesting cannot
  // reuse an alias the CEL compiler would bind to the wrong scope.
  const live = new Set<CelTarget>([target]);
  return {
    kind: "query",
    target,
    where: sq.where.map((t) => lowerTerm(t, target, live)),
    select: sq.select.map((s) => lowerSelect(s, target, live)),
  };
}

function lowerTerm(t: SurfaceTerm, target: CelTarget, live: Set<CelTarget>): WhereTerm {
  if (t.kind === "scalar") return { kind: "scalar", source: t.source, target };
  // A collection op in where-position: bare/`exists`/`count` all constrain the
  // outer row. `collect` is not a predicate — reject it in where.
  if (t.op === "collect") {
    throw new FilterInvalid("collect(...) is a projection; use it in select, or use exists/count in where", "OQX §2");
  }
  return lowerOp(t, target, live);
}

function lowerOp(o: SurfaceOp, target: CelTarget, live: Set<CelTarget>): CollectionOp {
  const noun = TARGET_NOUN[target];
  // Accept both "nodes" (relation token) and an explicit "doc.nodes" style
  // receiver written from a matching scope. Slice 1: single-token receivers.
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
  // Single-valued relations (node.doc, node.block) are redundant with the CEL
  // layer's existing doc.*/block.* reach-through and would collide on the shared
  // `d` alias. Point users at reach-through rather than a collection op.
  if (rel.singleValued) {
    throw new FilterInvalid(
      `relation '${key}' is single-valued; use ${rel.name.split(".")[1]}.<field> reach-through directly (e.g. doc.layer == "canon")`,
      "OQX §2",
    );
  }
  // Fail loudly rather than compile a relation that can never match.
  if (rel.unavailable) {
    throw new FilterInvalid(`relation '${key}' is unavailable: ${rel.unavailable}`, "OQX §2");
  }
  // Single-scope-per-target guard: the nested scope's child target must not
  // collide with a target already live around this compile() call. (Slice 1's
  // relations are one hop, so this only trips on same-target nesting.)
  if (live.has(rel.childTarget)) {
    throw new FilterInvalid(
      `nested same-target scope (${rel.childTarget}) not supported in slice 1`,
      "OQX §2",
    );
  }
  const nestedLive = new Set(live);
  nestedLive.add(rel.childTarget);
  const sub = lowerSubquery(o.sub, rel.childTarget, nestedLive);
  return { kind: "collectionOp", op: o.op, relation: rel, subquery: sub };
}

function lowerSubquery(s: SurfaceSubquery, target: CelTarget, live: Set<CelTarget>): NestedQuery {
  return {
    target,
    where: s.where.map((t) => lowerTerm(t, target, live)),
    select: s.select.map((sel) => {
      if (sel.kind === "collect") {
        throw new FilterInvalid("nested collect(...) inside a collection op is not supported in slice 1", "OQX §2");
      }
      return lowerSelect(sel, target, live);
    }),
  };
}

function lowerSelect(s: SurfaceSelectItem, target: CelTarget, live: Set<CelTarget>): SelectItem {
  if (s.kind === "collect") {
    return { kind: "collect", name: s.name, op: lowerOp(s.op, target, live) };
  }
  return { kind: "field", name: s.name, source: s.source };
}

function relationsFrom(target: CelTarget): string[] {
  return Object.values(RELATIONS).filter((r) => r.from === target).map((r) => r.name);
}
