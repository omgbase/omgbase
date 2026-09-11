// OQX IR → SQL. Compiles a Query to one SELECT: outer row source per target,
// repo/deleted guards, the where-clause boolean tree, correlated EXISTS/COUNT
// subqueries for where-position collection ops (incl. `count(...) <op> N`), and
// json_group_array correlated subqueries for collect projections (nestable).
// Scalar predicates/values are compiled by the CEL layer via scalar.ts.
//
// Alias contract: each scope's row has a SQL alias. The OUTERMOST scope uses the
// canonical per-target alias (docs=d, blocks=b, nodes=n). Every NESTED scope is
// allocated an alias not in use by any ancestor scope (n1, b1, …) so same-target
// nesting and self-relations (section.subsections, block.section) do not shadow
// the enclosing row. The correlated document alias stays `d` (every slice-2
// relation is sameDoc); a future cross-document relation would allocate its own.

import { FilterInvalid } from "../search/cel/parser.js";
import { defaultCtx, type AliasCtx } from "../search/cel/compile.js";
import { compilePredicate, compileValue } from "./scalar.js";
import type {
  Query, CollectionOp, WhereExpr, SelectItem, CelTarget, NestedQuery, CountRelOp,
} from "./ir.js";

export interface CompiledSql { sql: string; params: unknown[] }

const ALIAS_BASE: Record<CelTarget, string> = { docs: "d", blocks: "b", nodes: "n" };
const TABLE: Record<CelTarget, string> = { docs: "docs", blocks: "blocks", nodes: "nodes" };
const SQL_OP: Record<CountRelOp, string> = {
  "==": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=",
};

/** Allocate a SQL alias for a child scope's target that no ancestor scope uses. */
function allocAlias(target: CelTarget, inUse: Set<string>): string {
  const base = ALIAS_BASE[target];
  if (!inUse.has(base)) return base;
  for (let i = 1; ; i++) {
    const a = base + i;
    if (!inUse.has(a)) return a;
  }
}

/** Row-source FROM clause for the outermost target. `docs d` is joined on every
 * target: the CEL layer's property routing and $path all correlate on
 * `d.doc_id` (mirrors query.ts). */
function fromClause(target: CelTarget): string {
  if (target === "docs") return "docs d";
  if (target === "blocks") return "blocks b JOIN docs d ON d.doc_id = b.doc_id";
  return "nodes n JOIN docs d ON d.doc_id = n.doc_id";
}

/** repo + not-deleted guards for the outermost target's row (nodes have no
 * deleted_commit; they are pruned by their owning doc's tombstone via the d
 * join). */
function guards(target: CelTarget, repoId: string): CompiledSql {
  if (target === "docs") {
    return { sql: `d.repo_id = ? AND d.deleted_commit IS NULL`, params: [repoId] };
  }
  if (target === "blocks") {
    return { sql: `b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL`, params: [repoId] };
  }
  return { sql: `n.repo_id = ? AND d.deleted_commit IS NULL`, params: [repoId] };
}

// Compile a where boolean tree over the current scope (ctx). Leaves are scalar
// predicates (handed to CEL with this scope's aliases) or collection ops.
function compileWhere(expr: WhereExpr, ctx: AliasCtx, inUse: Set<string>): CompiledSql {
  switch (expr.kind) {
    case "and": {
      const parts = expr.parts.map((p) => compileWhere(p, ctx, inUse));
      return { sql: `(${parts.map((p) => p.sql).join(" AND ")})`, params: parts.flatMap((p) => p.params) };
    }
    case "or": {
      const parts = expr.parts.map((p) => compileWhere(p, ctx, inUse));
      return { sql: `(${parts.map((p) => p.sql).join(" OR ")})`, params: parts.flatMap((p) => p.params) };
    }
    case "not": {
      const inner = compileWhere(expr.expr, ctx, inUse);
      return { sql: `(NOT (${inner.sql}))`, params: inner.params };
    }
    case "scalar":
      return compilePredicate(expr, ctx);
    case "collectionOp":
      return compileOpPredicate(expr, ctx, inUse);
  }
}

// A collection op used as a predicate (where position). `count(...) <op> N`
// compiles to a scalar COUNT compared to N; exists / bare count / bare op all
// compile to EXISTS (non-empty).
function compileOpPredicate(op: CollectionOp, outer: AliasCtx, inUse: Set<string>): CompiledSql {
  const body = compileCorrelatedBody(op, outer, inUse);
  if (op.op === "count" && op.countCmp) {
    return {
      sql: `(SELECT COUNT(*) FROM ${body.from} WHERE ${body.where}) ${SQL_OP[op.countCmp.op]} ?`,
      params: [...body.params, op.countCmp.value],
    };
  }
  return { sql: `EXISTS (SELECT 1 FROM ${body.from} WHERE ${body.where})`, params: body.params };
}

interface CorrelatedBody {
  from: string;
  where: string;
  params: unknown[];
  childTarget: CelTarget;
  childCtx: AliasCtx;
  childInUse: Set<string>;
}

// Shared correlated-body builder: allocate the child scope's alias, emit its
// FROM + a WHERE combining the correlation predicate, the child guard, and the
// nested where tree (compiled against the child scope's aliases).
function compileCorrelatedBody(op: CollectionOp, outer: AliasCtx, inUse: Set<string>): CorrelatedBody {
  const rel = op.relation;
  const child = rel.childTarget;
  const childAlias = allocAlias(child, inUse);
  const childCtx: AliasCtx = { self: childAlias, doc: "d" };
  const childInUse = new Set([...inUse, childAlias]);

  const nested = op.subquery.where
    ? compileWhere(op.subquery.where, childCtx, childInUse)
    : { sql: "1", params: [] as unknown[] };

  // A nested scalar may reach the owning document (`d.` — doc.*/$path). Every
  // slice-2 relation is sameDoc, so the OUTER query's `d` binding is the correct
  // document for the child row and resolves by ordinary SQL scoping — we must
  // NOT join docs inside the subquery (that would shadow `d`). A future
  // cross-document relation would allocate a distinct doc alias here instead.
  if (/\bd\./.test(nested.sql) && !rel.sameDoc) {
    throw new FilterInvalid(
      `relation '${rel.name}' crosses documents; doc.*/$path reach-through inside it needs a distinct doc alias (not supported yet)`,
      "OQX §2",
    );
  }

  const from = `${TABLE[child]} ${childAlias}`;
  const guard = child === "nodes" ? "1" : `${childAlias}.deleted_commit IS NULL`;
  const correlation = rel.correlate(outer.self, childAlias);
  const where = `${correlation} AND ${guard} AND (${nested.sql})`;
  return { from, where, params: nested.params, childTarget: child, childCtx, childInUse };
}

// A collect projection as a scalar subquery expression: json_group_array of
// json_object over the correlated child set. Returned without the `AS "name"`
// so it can nest inside an enclosing json_object (nested collect).
function compileCollectExpr(op: CollectionOp, outer: AliasCtx, inUse: Set<string>): { expr: string; params: unknown[] } {
  if (op.op !== "collect") throw new FilterInvalid("select projection must be collect(...)", "OQX §2");
  const body = compileCorrelatedBody(op, outer, inUse);
  const obj = collectObject(op.subquery.select, body.childTarget, body.childCtx, body.childInUse);
  return {
    expr: `(SELECT json_group_array(${obj.expr}) FROM ${body.from} WHERE ${body.where})`,
    // json_object params precede the correlated-body params in statement order.
    params: [...obj.params, ...body.params],
  };
}

// Build the json_object(...) for a collect's projected rows. A field item is a
// scalar value; a nested collect item is itself a json_group_array subquery.
// Empty select defaults to the child's natural id + label columns.
function collectObject(items: SelectItem[], target: CelTarget, ctx: AliasCtx, inUse: Set<string>): { expr: string; params: unknown[] } {
  const pairs: string[] = [];
  const params: unknown[] = [];
  const effective = items.length > 0 ? items : defaultCollectSelect(target);
  for (const it of effective) {
    if (it.kind === "collect") {
      const c = compileCollectExpr(it.op, ctx, inUse);
      pairs.push(`'${it.name}', ${c.expr}`);
      params.push(...c.params);
    } else {
      const v = compileValue(it.source, target, ctx);
      pairs.push(`'${it.name}', ${v.expr}`);
      params.push(...v.params);
    }
  }
  return { expr: `json_object(${pairs.join(", ")})`, params };
}

function defaultCollectSelect(target: CelTarget): SelectItem[] {
  if (target === "nodes") return [
    { kind: "field", name: "id", source: "$node_id" },
    { kind: "field", name: "name", source: "name" },
  ];
  if (target === "blocks") return [
    { kind: "field", name: "id", source: "$id" },
    { kind: "field", name: "type", source: "type" },
  ];
  return [
    { kind: "field", name: "id", source: "$id" },
    { kind: "field", name: "path", source: "$path" },
  ];
}

/** Compile a full Query into one SELECT + params (without ORDER/LIMIT/cursor,
 * which run.ts appends). Returns the projection column list separately so run.ts
 * can assemble hit shapes. `isJson` marks columns whose value is JSON text (a
 * collect array or a lifted collection) that run.ts must parse. */
export interface CompiledQuery {
  from: string;
  where: string;
  whereParams: unknown[];
  /** extra projection columns beyond id/path, in order, with their names. */
  projections: { name: string; sql: string; params: unknown[]; isJson: boolean }[];
  target: CelTarget;
}

// A lifted binding: a `^name` inside a top-level where-position collect. The
// collect's `op` filters the outer row (EXISTS, compiled in the where tree);
// `valueSource` is projected per matching child row into a collection the outer
// select can reference by `name`.
interface LiftBinding { op: CollectionOp; valueSource: string; childTarget: CelTarget }

// Collect lift bindings from the top-level where tree. Lowering guarantees lifts
// only appear in top-level where-position collects, so we need not descend into
// op subqueries.
function gatherLiftBindings(w: WhereExpr | null): Map<string, LiftBinding> {
  const m = new Map<string, LiftBinding>();
  const visit = (e: WhereExpr): void => {
    switch (e.kind) {
      case "and": case "or": e.parts.forEach(visit); return;
      case "not": visit(e.expr); return;
      case "scalar": return;
      case "collectionOp": {
        if (e.op === "collect") {
          for (const it of e.subquery.select) {
            if (it.kind === "field" && it.lift) {
              if (m.has(it.name)) throw new FilterInvalid(`duplicate lift binding '${it.name}'`, "OQX lifts");
              m.set(it.name, { op: e, valueSource: it.source, childTarget: e.relation.childTarget });
            }
          }
        }
        return;
      }
    }
  };
  if (w) visit(w);
  return m;
}

export function compileQuery(q: Query, repoId: string): CompiledQuery {
  const ctx = defaultCtx(q.target);
  const inUse = new Set([ctx.self, "d"]);
  const g = guards(q.target, repoId);
  const w = q.where ? compileWhere(q.where, ctx, inUse) : { sql: "1", params: [] as unknown[] };
  const whereSql = w.sql === "1" ? g.sql : `${g.sql} AND ${w.sql}`;
  const lifts = gatherLiftBindings(q.where);
  const projections = q.select.map((s) => compileProjection(s, q.target, ctx, inUse, lifts));
  return {
    from: fromClause(q.target),
    where: whereSql,
    whereParams: [...g.params, ...w.params],
    projections,
    target: q.target,
  };
}

function compileProjection(
  s: SelectItem, target: CelTarget, ctx: AliasCtx, inUse: Set<string>, lifts: Map<string, LiftBinding>,
): { name: string; sql: string; params: unknown[]; isJson: boolean } {
  if (s.kind === "collect") {
    const c = compileCollectExpr(s.op, ctx, inUse);
    return { name: s.name, sql: `${c.expr} AS "${s.name}"`, params: c.params, isJson: true };
  }
  // A bare field whose name matches a lifted binding resolves to that lift's
  // collection (json_group_array of the lifted value over the collect's body),
  // shadowing any same-named property.
  const b = lifts.get(s.source);
  if (b) {
    const body = compileCorrelatedBody(b.op, ctx, inUse);
    const v = compileValue(b.valueSource, b.childTarget, body.childCtx);
    return {
      name: s.name,
      sql: `(SELECT json_group_array(${v.expr}) FROM ${body.from} WHERE ${body.where}) AS "${s.name}"`,
      params: [...v.params, ...body.params],
      isJson: true,
    };
  }
  const v = compileValue(s.source, target, ctx);
  return { name: s.name, sql: `${v.expr} AS "${s.name}"`, params: v.params, isJson: false };
}

// Re-exported so run.ts / tests can build the same nested type without importing IR.
export type { NestedQuery };
