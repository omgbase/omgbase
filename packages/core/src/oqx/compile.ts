// OQX IR → SQL. Compiles a Query to one SELECT: outer row source per target,
// repo/deleted guards, correlated EXISTS/COUNT subqueries for where-position
// collection ops, and json_group_array correlated subqueries for collect
// projections. Scalar predicates/values are compiled by the CEL layer via
// scalar.ts. Alias contract: documents=d, blocks=b, nodes=n (see scalar.ts seam).

import { FilterInvalid } from "../search/cel/parser.js";
import { compilePredicate, compileValue } from "./scalar.js";
import type {
  Query, CollectionOp, WhereTerm, SelectItem, CelTarget,
} from "./ir.js";

export interface CompiledSql { sql: string; params: unknown[] }

const ALIAS: Record<CelTarget, string> = { docs: "d", blocks: "b", nodes: "n" };
const TABLE: Record<CelTarget, string> = { docs: "docs", blocks: "blocks", nodes: "nodes" };

/** Row-source FROM clause for a target. `docs d` is joined on every target: the
 * CEL layer's property routing and $path all correlate on `d.doc_id` (mirrors
 * query.ts). */
function fromClause(target: CelTarget): string {
  if (target === "docs") return "docs d";
  if (target === "blocks") return "blocks b JOIN docs d ON d.doc_id = b.doc_id";
  return "nodes n JOIN docs d ON d.doc_id = n.doc_id";
}

/** repo + not-deleted guards for a target's row (nodes have no deleted_commit;
 * they are pruned by their owning doc's tombstone via the d join). */
function guards(target: CelTarget, repoId: string): CompiledSql {
  const a = ALIAS[target];
  if (target === "docs") {
    return { sql: `d.repo_id = ? AND d.deleted_commit IS NULL`, params: [repoId] };
  }
  if (target === "blocks") {
    return { sql: `b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL`, params: [repoId] };
  }
  return { sql: `${a}.repo_id = ? AND d.deleted_commit IS NULL`, params: [repoId] };
}

// Compile a where term list (conjunction). Each term already carries its own
// scope: scalar predicates were tagged with their target during lowering, and a
// collection op carries its relation.
function compileWhere(terms: WhereTerm[]): CompiledSql {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const t of terms) {
    if (t.kind === "scalar") {
      const c = compilePredicate(t);
      parts.push(c.sql);
      params.push(...c.params);
    } else {
      const c = compileOpPredicate(t);
      parts.push(c.sql);
      params.push(...c.params);
    }
  }
  if (parts.length === 0) return { sql: "1", params: [] };
  return { sql: parts.join(" AND "), params };
}

// A collection op used as a predicate (where position): EXISTS for exists/count.
// A bare op lowered to `exists` also lands here.
function compileOpPredicate(op: CollectionOp): CompiledSql {
  const inner = compileCorrelatedBody(op);
  // exists and count-as-truthy both compile to EXISTS; count-comparisons are a
  // later slice (see plan). A bare op in where-position was lowered to exists.
  return { sql: `EXISTS (SELECT 1 FROM ${inner.from} WHERE ${inner.where})`, params: inner.params };
}

// Shared correlated-body builder: FROM (+ optional documents join) and a WHERE
// combining the correlation join, guards, and the nested predicate.
function compileCorrelatedBody(op: CollectionOp): { from: string; where: string; params: unknown[] } {
  const rel = op.relation;
  const child = rel.childTarget;
  const childAlias = ALIAS[child];
  const nested = compileWhere(op.subquery.where);
  const params: unknown[] = [];

  // The nested scalar may reference `d.` (doc.* reach-through, $path). We must
  // NOT join docs here: the CEL compiler hardcodes the alias `d`, so an
  // inner `JOIN docs d` would SHADOW the outer `d` and turn the correlation
  // `n.doc_id = d.doc_id` into a tautology (silently matching every row). Every
  // slice-1 relation is sameDoc, so the OUTER query's `d` binding is already the
  // correct document for the child row and resolves correctly by SQL scoping.
  if (/\bd\./.test(nested.sql) && !rel.sameDoc) {
    throw new FilterInvalid(
      `relation '${rel.name}' crosses documents; doc.*/$path reach-through inside it needs alias-scoped compilation (not supported in slice 1)`,
      "OQX §2",
    );
  }
  const from = `${TABLE[child]} ${childAlias}`;

  const guard = child === "docs"
    ? `${childAlias}.deleted_commit IS NULL`
    : child === "blocks"
      ? `${childAlias}.deleted_commit IS NULL`
      : "1"; // nodes: no own tombstone; pruned via owning doc if joined

  const where = `${rel.innerCol} = ${rel.outerCol} AND ${guard} AND (${nested.sql})`;
  params.push(...nested.params);
  return { from, where, params };
}

// A collect projection: json_group_array of json_object over the correlated set.
function compileCollect(name: string, op: CollectionOp): CompiledSql {
  if (op.op !== "collect") throw new FilterInvalid("select projection must be collect(...)", "OQX §2");
  const rel = op.relation;
  const child = rel.childTarget;
  const inner = compileCorrelatedBody(op);
  const obj = collectObject(op.subquery.select, child);
  return {
    sql: `(SELECT json_group_array(${obj.expr}) FROM ${inner.from} WHERE ${inner.where}) AS "${name}"`,
    params: [...obj.params, ...inner.params],
  };
}

// Build the json_object(...) for a collect's projected rows. Empty select
// defaults to the child's natural id + label columns.
function collectObject(items: SelectItem[], target: CelTarget): { expr: string; params: unknown[] } {
  const pairs: string[] = [];
  const params: unknown[] = [];
  const effective = items.length > 0 ? items : defaultCollectSelect(target);
  for (const it of effective) {
    if (it.kind === "collect") throw new FilterInvalid("nested collect not supported in slice 1", "OQX §2");
    const v = compileValue(it.source, target);
    pairs.push(`'${it.name}', ${v.expr}`);
    params.push(...v.params);
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
 * can assemble hit shapes. */
export interface CompiledQuery {
  from: string;
  where: string;
  whereParams: unknown[];
  /** extra projection columns beyond id/path, in order, with their names. */
  projections: { name: string; sql: string; params: unknown[] }[];
  target: CelTarget;
}

export function compileQuery(q: Query, repoId: string): CompiledQuery {
  const g = guards(q.target, repoId);
  const w = compileWhere(q.where);
  const whereSql = w.sql === "1" ? g.sql : `${g.sql} AND ${w.sql}`;
  const projections = q.select.map((s) => compileProjection(s, q.target));
  return {
    from: fromClause(q.target),
    where: whereSql,
    whereParams: [...g.params, ...w.params],
    projections,
    target: q.target,
  };
}

function compileProjection(s: SelectItem, target: CelTarget): { name: string; sql: string; params: unknown[] } {
  if (s.kind === "collect") {
    const c = compileCollect(s.name, s.op);
    // c.sql already ends in AS "name"; split the expr for uniform handling.
    return { name: s.name, sql: c.sql, params: c.params };
  }
  const v = compileValue(s.source, target);
  return { name: s.name, sql: `${v.expr} AS "${s.name}"`, params: v.params };
}
