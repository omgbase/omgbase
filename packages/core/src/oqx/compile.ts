// OQX IR → SQL. Compiles a Query to one SELECT: outer row source per target,
// repo/deleted guards, the where-clause boolean tree, correlated EXISTS/COUNT
// subqueries for where-position collection ops (incl. `count(...) <op> N`),
// json_group_array correlated subqueries for collect projections (nestable), and
// zero-or-one / one-to-one lookups (`first`/`single`). Scalar predicates/values
// are compiled by the CEL layer via scalar.ts.
//
// Alias contract: each scope's row has a SQL alias. The OUTERMOST scope uses the
// canonical per-target alias (docs=d, blocks=b, nodes=n). Every NESTED scope is
// allocated an alias not in use by any ancestor scope (n1, b1, …) so same-target
// nesting and self-relations (section.subsections, block.section) do not shadow
// the enclosing row. A structural (sameDoc) relation keeps the correlated
// document alias `d`; a ROOT relation (repo.docs/nodes/blocks) is an independent
// repository scan, so it allocates its own document alias (d1, …) and joins docs
// inside the subquery — correlation to the outer row is then expressed only
// through `^name` outer references.
//
// Correlation (`^name`): a nested scope may read a binding from the immediately
// enclosing scope. Each scope publishes bindings (its SELECT values, its SELECT
// collects, and its where-position lifts); those are threaded down as the child
// scope's AliasCtx.outer resolver so the CEL layer can compile a `^name` operand
// against the parent row. This is the join escape hatch (see the OQX
// correlated-subqueries design note).

import { FilterInvalid } from "../search/cel/parser.js";
import { defaultCtx, type AliasCtx, type OuterBinding, type OuterResolver, type SemanticResolver } from "../search/cel/compile.js";
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

/** Deterministic order for a zero-or-one / one-to-one lookup (first/single):
 * results must not depend on storage order (determinism is load-bearing). */
function childOrder(target: CelTarget, ctx: AliasCtx): string {
  if (target === "docs") return `${ctx.self}.path, ${ctx.self}.doc_id`;
  if (target === "blocks") return `${ctx.self}.ordinal, ${ctx.self}.block_id`;
  return `${ctx.self}.node_id`;
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
// predicates (handed to CEL with this scope's aliases + outer resolver) or
// collection ops. `enclosingBindings` are the bindings that this scope's nested
// ops correlate against via `^name`.
function compileWhere(
  expr: WhereExpr, ctx: AliasCtx, inUse: Set<string>, repoId: string, enclosingBindings: OuterResolver | undefined,
): CompiledSql {
  switch (expr.kind) {
    case "and": {
      const parts = expr.parts.map((p) => compileWhere(p, ctx, inUse, repoId, enclosingBindings));
      return { sql: `(${parts.map((p) => p.sql).join(" AND ")})`, params: parts.flatMap((p) => p.params) };
    }
    case "or": {
      const parts = expr.parts.map((p) => compileWhere(p, ctx, inUse, repoId, enclosingBindings));
      return { sql: `(${parts.map((p) => p.sql).join(" OR ")})`, params: parts.flatMap((p) => p.params) };
    }
    case "not": {
      const inner = compileWhere(expr.expr, ctx, inUse, repoId, enclosingBindings);
      return { sql: `(NOT (${inner.sql}))`, params: inner.params };
    }
    case "scalar":
      return compilePredicate(expr, ctx);
    case "collectionOp":
      return compileOpPredicate(expr, ctx, inUse, repoId, enclosingBindings);
  }
}

// A collection op used as a predicate (where position). `count(...) <op> N`
// compiles to a scalar COUNT compared to N; exists / bare count / bare op all
// compile to EXISTS (non-empty).
function compileOpPredicate(
  op: CollectionOp, outer: AliasCtx, inUse: Set<string>, repoId: string, enclosingBindings: OuterResolver | undefined,
): CompiledSql {
  const body = compileCorrelatedBody(op, outer, inUse, repoId, enclosingBindings);
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
  /** the child scope's own published bindings (for ITS nested ops / `^name`). */
  childBindings: OuterResolver;
}

// Shared correlated-body builder: allocate the child scope's alias(es), emit its
// FROM + a WHERE combining the correlation predicate (or repo guard for a root
// scan), the child guard, and the nested where tree (compiled against the child
// scope's aliases, with the enclosing scope's bindings available via `^name`).
function compileCorrelatedBody(
  op: CollectionOp, outer: AliasCtx, inUse: Set<string>, repoId: string, enclosingBindings: OuterResolver | undefined,
): CorrelatedBody {
  const rel = op.relation;
  const child = rel.childTarget;
  const childAlias = allocAlias(child, inUse);
  let childInUse = new Set([...inUse, childAlias]);

  let docAlias: string;
  let from: string;
  let correlation: string;
  let guardSql: string;
  let guardParams: unknown[];

  if (rel.root) {
    // An independent repository scan. It needs its own document scope so that
    // $path / doc.* inside resolve against the CHILD row's document; a scan over
    // docs IS its own document. Repo + tombstone guards mirror the top-level
    // guards() (there is no correlation constraining the scan to the repo).
    if (child === "docs") {
      docAlias = childAlias;
      from = `${TABLE.docs} ${childAlias}`;
      guardSql = `${childAlias}.repo_id = ? AND ${childAlias}.deleted_commit IS NULL`;
    } else {
      docAlias = allocAlias("docs", childInUse);
      childInUse = new Set([...childInUse, docAlias]);
      from = `${TABLE[child]} ${childAlias} JOIN docs ${docAlias} ON ${docAlias}.doc_id = ${childAlias}.doc_id`;
      guardSql = child === "blocks"
        ? `${childAlias}.repo_id = ? AND ${childAlias}.deleted_commit IS NULL AND ${docAlias}.deleted_commit IS NULL`
        : `${childAlias}.repo_id = ? AND ${docAlias}.deleted_commit IS NULL`;
    }
    correlation = "1";
    guardParams = [repoId];
  } else {
    // A structural (sameDoc) relation: the outer query's `d` binding is already
    // the correct document for the child row (see the alias contract), so we do
    // NOT join docs inside the subquery — that would shadow the outer `d`.
    docAlias = outer.doc;
    from = `${TABLE[child]} ${childAlias}`;
    correlation = rel.correlate(outer.self, childAlias);
    guardParams = [];
    guardSql = child === "nodes" ? "1" : `${childAlias}.deleted_commit IS NULL`;
  }

  // The child's scalar leaves see the ENCLOSING scope's bindings via `^name`,
  // and the query-global semantic resolver (uniform across scopes) flows down.
  const childCtx: AliasCtx = enclosingBindings
    ? { self: childAlias, doc: docAlias, outer: enclosingBindings, ...(outer.semantic ? { semantic: outer.semantic } : {}) }
    : { self: childAlias, doc: docAlias, ...(outer.semantic ? { semantic: outer.semantic } : {}) };
  // The child's OWN bindings (for its nested ops one scope further in).
  const childBindings = buildBindings(op.subquery, child, childCtx, childInUse, repoId);

  const nested = op.subquery.where
    ? compileWhere(op.subquery.where, childCtx, childInUse, repoId, childBindings)
    : { sql: "1", params: [] as unknown[] };

  // sameDoc tripwire: a FUTURE non-root cross-document structural relation would
  // resolve doc.*/$path against the wrong document unless it allocates its own
  // doc alias (as root relations do). Root relations and sameDoc relations are
  // both fine; anything else touching outer `d.` is not supported yet.
  if (/\bd\./.test(nested.sql) && !rel.sameDoc && !rel.root) {
    throw new FilterInvalid(
      `relation '${rel.name}' crosses documents; doc.*/$path reach-through inside it needs a distinct doc alias (not supported yet)`,
      "OQX §2",
    );
  }

  const where = `${correlation} AND ${guardSql} AND (${nested.sql})`;
  return {
    from, where,
    params: [...guardParams, ...nested.params],
    childTarget: child, childCtx, childInUse, childBindings,
  };
}

// Build the resolver for the bindings a scope publishes to its nested scopes.
// A SELECT value binds a `scalar` (recomputed against this scope's row); a
// SELECT collect and a where-position lift bind a `collection` (a json array).
// Closures are lazy — a binding is only compiled when a nested `^name` actually
// references it — and reference this scope's own resolver so a lift/collect body
// can itself read sibling bindings (still one scope out from that body).
function buildBindings(
  sub: { select: SelectItem[]; where: WhereExpr | null }, target: CelTarget,
  ctx: AliasCtx, inUse: Set<string>, repoId: string,
): OuterResolver {
  const m = new Map<string, OuterBinding>();
  const selfResolver: OuterResolver = (name) => m.get(name);

  const lifts = gatherLiftBindings(sub.where);
  for (const [name, lb] of lifts) {
    m.set(name, {
      collection: () => {
        const body = compileCorrelatedBody(lb.op, ctx, inUse, repoId, selfResolver);
        const v = compileValue(lb.valueSource, lb.childTarget, body.childCtx);
        return {
          expr: `(SELECT json_group_array(${v.expr}) FROM ${body.from} WHERE ${body.where})`,
          params: [...v.params, ...body.params],
        };
      },
    });
  }

  for (const it of sub.select) {
    if (m.has(it.name)) continue;
    if (it.kind === "collect") {
      // Only `collect` yields a referenceable collection; first/single lookups
      // are single records, not correlation sources.
      if (it.op.op === "collect") {
        m.set(it.name, {
          collection: () => {
            const c = compileSelectOp(it.op, ctx, inUse, repoId, selfResolver);
            return { expr: c.expr, params: c.params };
          },
        });
      }
    } else if (lifts.has(it.source)) {
      // The field projects a lift; expose the same collection under its name.
      m.set(it.name, m.get(it.source)!);
    } else {
      m.set(it.name, { scalar: () => compileValue(it.source, target, ctx) });
    }
  }
  return selfResolver;
}

interface CompiledExpr { expr: string; params: unknown[]; isJson: boolean; unwrapSingle?: boolean }

// A select-position collection op compiled to a scalar subquery expression
// (without the `AS "name"`, so it can nest inside an enclosing json_object).
// `collect` → json array; `first` → the ordered first record or NULL; `single`
// → a capped-at-2 json array the runner unwraps + cardinality-checks.
function compileSelectOp(
  op: CollectionOp, outer: AliasCtx, inUse: Set<string>, repoId: string, enclosingBindings: OuterResolver | undefined,
): CompiledExpr {
  const body = compileCorrelatedBody(op, outer, inUse, repoId, enclosingBindings);
  const obj = collectObject(op.subquery.select, body.childTarget, body.childCtx, body.childInUse, repoId, body.childBindings);
  if (op.op === "collect") {
    return {
      expr: `(SELECT json_group_array(${obj.expr}) FROM ${body.from} WHERE ${body.where})`,
      params: [...obj.params, ...body.params],
      isJson: true,
    };
  }
  const order = childOrder(body.childTarget, body.childCtx);
  if (op.op === "first") {
    return {
      expr: `(SELECT ${obj.expr} FROM ${body.from} WHERE ${body.where} ORDER BY ${order} LIMIT 1)`,
      params: [...obj.params, ...body.params],
      isJson: true,
    };
  }
  // single: SQLite cannot RAISE from a scalar subquery, so cap the match at two
  // rows and let run.ts enforce ≤1 (a loud error beats silently picking one).
  // `json(_o)` restores the JSON subtype lost when the object passes through the
  // `AS` column, so json_group_array embeds objects (not quoted strings).
  return {
    expr: `(SELECT json_group_array(json(_o)) FROM (SELECT ${obj.expr} AS _o FROM ${body.from} WHERE ${body.where} ORDER BY ${order} LIMIT 2))`,
    params: [...obj.params, ...body.params],
    isJson: true,
    unwrapSingle: true,
  };
}

// Build the json_object(...) for a collect's projected rows. A field item is a
// scalar value; a nested collect item is itself a json_group_array subquery.
// Empty select defaults to the child's natural id + label columns.
function collectObject(
  items: SelectItem[], target: CelTarget, ctx: AliasCtx, inUse: Set<string>, repoId: string, enclosingBindings: OuterResolver | undefined,
): { expr: string; params: unknown[] } {
  const pairs: string[] = [];
  const params: unknown[] = [];
  const effective = items.length > 0 ? items : defaultCollectSelect(target);
  for (const it of effective) {
    if (it.kind === "collect") {
      if (it.op.op !== "collect") {
        throw new FilterInvalid(
          `${it.op.op}(...) is only supported at the top-level select yet, not nested inside a collect`,
          "OQX §2",
        );
      }
      const c = compileSelectOp(it.op, ctx, inUse, repoId, enclosingBindings);
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
 * collect array, a lifted collection, or a first/single record) that run.ts must
 * parse; `unwrapSingle` marks a `single` column the runner unwraps + checks. */
export interface CompiledQuery {
  from: string;
  where: string;
  whereParams: unknown[];
  /** extra projection columns beyond id/path, in order, with their names. */
  projections: { name: string; sql: string; params: unknown[]; isJson: boolean; unwrapSingle?: boolean }[];
  target: CelTarget;
  /** compiled `order by` terms ("expr DIR, …"), without the (path,id) tiebreak;
   * present only when the query has an order clause. */
  orderBy?: { sql: string; params: unknown[] };
}

// A lifted binding: a `^name` inside a top-level where-position collect. The
// collect's `op` filters the outer row (EXISTS, compiled in the where tree);
// `valueSource` is projected per matching child row into a collection the outer
// select can reference by `name`.
interface LiftBinding { op: CollectionOp; valueSource: string; childTarget: CelTarget }

// Collect lift bindings from a where tree. Lifts only appear in where-position
// collects, so we need not descend into op subqueries.
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

export function compileQuery(q: Query, repoId: string, semantic?: SemanticResolver): CompiledQuery {
  const ctx = defaultCtx(q.target);
  if (semantic) ctx.semantic = semantic; // query-global; flows to every child ctx
  const inUse = new Set([ctx.self, "d"]);
  const g = guards(q.target, repoId);
  // Bindings the top scope publishes to its nested scopes (its select values /
  // collects and its where lifts). The top scope itself has no enclosing scope,
  // so its own scalar leaves carry no outer resolver — a top-level `^name` is a
  // loud error.
  const topBindings = buildBindings(q, q.target, ctx, inUse, repoId);
  const w = q.where ? compileWhere(q.where, ctx, inUse, repoId, topBindings) : { sql: "1", params: [] as unknown[] };
  const whereSql = w.sql === "1" ? g.sql : `${g.sql} AND ${w.sql}`;
  const lifts = gatherLiftBindings(q.where);
  const projections = q.select.map((s) => compileProjection(s, q.target, ctx, inUse, repoId, topBindings, lifts));

  // Order expressions are scalar VALUEs over the query row (frontmatter fields,
  // $path, semantic("…"), …), compiled against the top ctx (so its semantic
  // resolver applies). The comma-joined "expr DIR" fragment; run.ts appends the
  // (path, id) total-order tiebreak and decides which consumers honor it.
  let orderBy: { sql: string; params: unknown[] } | undefined;
  if (q.orderBy && q.orderBy.length > 0) {
    const parts: string[] = [];
    const oparams: unknown[] = [];
    for (const o of q.orderBy) {
      const v = compileValue(o.source, q.target, ctx);
      parts.push(`${v.expr} ${o.desc ? "DESC" : "ASC"}`);
      oparams.push(...v.params);
    }
    orderBy = { sql: parts.join(", "), params: oparams };
  }

  return {
    from: fromClause(q.target),
    where: whereSql,
    whereParams: [...g.params, ...w.params],
    projections,
    target: q.target,
    ...(orderBy ? { orderBy } : {}),
  };
}

function compileProjection(
  s: SelectItem, target: CelTarget, ctx: AliasCtx, inUse: Set<string>, repoId: string,
  enclosingBindings: OuterResolver | undefined, lifts: Map<string, LiftBinding>,
): { name: string; sql: string; params: unknown[]; isJson: boolean; unwrapSingle?: boolean } {
  if (s.kind === "collect") {
    const c = compileSelectOp(s.op, ctx, inUse, repoId, enclosingBindings);
    return {
      name: s.name, sql: `${c.expr} AS "${s.name}"`, params: c.params, isJson: c.isJson,
      ...(c.unwrapSingle ? { unwrapSingle: true } : {}),
    };
  }
  // A bare field whose name matches a lifted binding resolves to that lift's
  // collection (json_group_array of the lifted value over the collect's body),
  // shadowing any same-named property.
  const b = lifts.get(s.source);
  if (b) {
    const body = compileCorrelatedBody(b.op, ctx, inUse, repoId, enclosingBindings);
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
