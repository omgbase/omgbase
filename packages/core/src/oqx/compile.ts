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
  Query, CollectionOp, WhereExpr, SelectItem, CelTarget, NestedQuery, CountRelOp, FollowSpec,
} from "./ir.js";

export interface CompiledSql { sql: string; params: unknown[] }

const ALIAS_BASE: Record<CelTarget, string> = { docs: "d", blocks: "b", nodes: "n" };
const TABLE: Record<CelTarget, string> = { docs: "docs", blocks: "blocks", nodes: "nodes" };
const ID_COLUMN: Record<CelTarget, string> = { docs: "doc_id", blocks: "block_id", nodes: "node_id" };
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

/** repo + not-deleted guards for a target's row at an explicit (row, doc) alias
 * pair (nodes have no deleted_commit; they are pruned by their owning doc's
 * tombstone via the doc join). Alias-parameterized so it composes with the
 * follow CTE's fresh scopes (s/sd, c/cd, x/xd) as well as the canonical row. */
function guardsFor(target: CelTarget, rowAlias: string, docAlias: string, repoId: string): CompiledSql {
  if (target === "docs") {
    return { sql: `${rowAlias}.repo_id = ? AND ${rowAlias}.deleted_commit IS NULL`, params: [repoId] };
  }
  if (target === "blocks") {
    return { sql: `${rowAlias}.repo_id = ? AND ${rowAlias}.deleted_commit IS NULL AND ${docAlias}.deleted_commit IS NULL`, params: [repoId] };
  }
  return { sql: `${rowAlias}.repo_id = ? AND ${docAlias}.deleted_commit IS NULL`, params: [repoId] };
}

/** repo + not-deleted guards for the outermost target's canonical row/doc. */
function guards(target: CelTarget, repoId: string): CompiledSql {
  return guardsFor(target, ALIAS_BASE[target], "d", repoId);
}

/** Row-source FROM + guards for a top-level query whose source is re-projected
 * by one or more `from E` relations (a typed flatMap over host-model
 * navigation). The FINAL row uses the canonical alias (d/b/n) + doc `d` so
 * run.ts/CEL resolve unchanged; each preceding relation in the chain contributes
 * a JOIN correlated within the shared document. All source relations are
 * same-document today (a cross-document `from` chain is a loud error). */
function chainedFrom(q: Query, repoId: string): { from: string; guards: CompiledSql } {
  const finalTarget = q.target;
  const finalAlias = ALIAS_BASE[finalTarget];
  const inUse = new Set<string>(["d", finalAlias]);
  const joins: string[] = [];
  const guardSqls: string[] = [];
  const guardParams: unknown[] = [];
  const fg = guards(finalTarget, repoId);
  guardSqls.push(fg.sql);
  guardParams.push(...fg.params);

  // The row type after applying sourceRelations[0..i-1]: targets[i] is the
  // parent of sourceRelations[i], targets[i+1] its child (== q.target at the end).
  const targets: CelTarget[] = [q.baseTarget];
  for (const r of q.sourceRelations) targets.push(r.childTarget);

  // Walk the chain backward: sourceRelations[i] connects parent(targets[i]) →
  // child(targets[i+1]); the last relation's child is the final canonical row.
  let childAlias = finalAlias;
  for (let i = q.sourceRelations.length - 1; i >= 0; i--) {
    const rel = q.sourceRelations[i]!;
    if (!rel.sameDoc) {
      throw new FilterInvalid(
        `source projection '${rel.name}' crosses documents; a cross-document \`from\` chain is not supported yet`,
        "OQX from",
      );
    }
    const parentTarget = targets[i]!;
    const parentAlias = allocAlias(parentTarget, inUse);
    inUse.add(parentAlias);
    if (parentTarget === "docs") {
      joins.push(`JOIN docs ${parentAlias} ON ${rel.correlate(parentAlias, childAlias)}`);
      guardSqls.push(`${parentAlias}.repo_id = ? AND ${parentAlias}.deleted_commit IS NULL`);
      guardParams.push(repoId);
    } else {
      // A non-docs parent shares the final row's document `d` (same-document).
      joins.push(`JOIN ${TABLE[parentTarget]} ${parentAlias} ON ${rel.correlate(parentAlias, childAlias)}`);
      const g = guardsFor(parentTarget, parentAlias, "d", repoId);
      guardSqls.push(g.sql);
      guardParams.push(...g.params);
    }
    childAlias = parentAlias;
  }
  return {
    from: joins.length ? `${fromClause(finalTarget)} ${joins.join(" ")}` : fromClause(finalTarget),
    guards: { sql: guardSqls.join(" AND "), params: guardParams },
  };
}

/** FROM fragment for a target row at (rowAlias, docAlias). On docs the row IS
 * the doc, so no separate docs join (callers pass docAlias === rowAlias). */
function rowSource(target: CelTarget, rowAlias: string, docAlias: string): string {
  if (target === "docs") return `${TABLE.docs} ${rowAlias}`;
  return `${TABLE[target]} ${rowAlias} JOIN docs ${docAlias} ON ${docAlias}.doc_id = ${rowAlias}.doc_id`;
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

// A select-position `collect` with a nested `follow`: recurse within the
// subquery. The collect's receiver relation seeds the walk (correlated to the
// current/outer row + the collect `where`); the nested `follow` relation
// recurses; the collect's `select` projects each reached occurrence (with
// $depth/$stop/… available). A fresh row alias `y` is used in the final
// projection so nothing shadows the correlated outer row; the walk scaffolding
// aliases are reserved so nested ops in the collect body don't collide.
function compileFollowCollect(
  op: CollectionOp, follow: FollowSpec, outer: AliasCtx, inUse: Set<string>, repoId: string,
  enclosingBindings: OuterResolver | undefined,
): CompiledExpr {
  const childTarget = op.relation.childTarget;
  const isDocs = childTarget === "docs";
  const dOf = (r: string): string => (isDocs ? r : `${r}d`);
  const semCtx = outer.semantic ? { semantic: outer.semantic } : {};
  const id = ID_COLUMN[childTarget];
  const childInUse = new Set<string>([
    ...inUse, "s", "sd", "c", "cd", "pw", "pd", "w", "x", "xd", "c2", "cd2", "w2", "y", "yd", "walk", "walked",
  ]);

  // seed: the receiver relation correlated to the outer row + the collect `where`.
  const seedCtx: AliasCtx = {
    self: "s", doc: dOf("s"),
    ...(enclosingBindings ? { outer: enclosingBindings } : {}), ...semCtx,
  };
  const seedGuard = guardsFor(childTarget, "s", dOf("s"), repoId);
  const seedWhere = op.subquery.where
    ? compileWhere(op.subquery.where, seedCtx, childInUse, repoId, enclosingBindings)
    : { sql: "1", params: [] as unknown[] };
  const cte = buildWalkCte(childTarget, follow, repoId, semCtx, rowSource(childTarget, "s", dOf("s")), {
    sql: `${op.relation.correlate(outer.self, "s")} AND ${seedGuard.sql} AND (${seedWhere.sql})`,
    params: [...seedGuard.params, ...seedWhere.params],
  });

  // final projection over the walk (fresh alias `y`), ordered by walk path.
  const yCtx: AliasCtx = {
    self: "y", doc: dOf("y"), recur: recurCtx(),
    ...(enclosingBindings ? { outer: enclosingBindings } : {}), ...semCtx,
  };
  const yGuard = guardsFor(childTarget, "y", dOf("y"), repoId);
  const yBindings = buildBindings(op.subquery, childTarget, yCtx, childInUse, repoId);
  const obj = collectObject(op.subquery.select, childTarget, yCtx, childInUse, repoId, yBindings);
  // json(_o) restores the object subtype lost through the AS column, so
  // json_group_array embeds objects (not quoted strings); ORDER BY walk path.
  const expr =
    `(${cte.sql} SELECT json_group_array(json(_o)) FROM (` +
    `SELECT ${obj.expr} AS _o FROM ${rowSource(childTarget, "y", dOf("y"))} JOIN walked ON walked.wid = y.${id} ` +
    `WHERE ${yGuard.sql} ORDER BY walked.wpath))`;
  return { expr, params: [...cte.params, ...obj.params, ...yGuard.params], isJson: true };
}

// A select-position collection op compiled to a scalar subquery expression
// (without the `AS "name"`, so it can nest inside an enclosing json_object).
// `collect` → json array; `first` → the ordered first record or NULL; `single`
// → a capped-at-2 json array the runner unwraps + cardinality-checks.
function compileSelectOp(
  op: CollectionOp, outer: AliasCtx, inUse: Set<string>, repoId: string, enclosingBindings: OuterResolver | undefined,
): CompiledExpr {
  // A nested `follow` collect recurses within the subquery via its own bounded
  // WITH RECURSIVE, seeded from the receiver relation correlated to the outer row.
  if (op.subquery.follow) return compileFollowCollect(op, op.subquery.follow, outer, inUse, repoId, enclosingBindings);
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
  /** extra projection columns beyond id/path, in order, with their names.
   * `docBody` marks a docs `$body` projection whose value is the reconstructed
   * file content, filled by run.ts (docsRead) rather than SQL. */
  projections: { name: string; sql: string; params: unknown[]; isJson: boolean; unwrapSingle?: boolean; docBody?: boolean }[];
  target: CelTarget;
  /** compiled `order by` terms ("expr DIR, …"), without the (path,id) tiebreak;
   * present only when the query has an order clause. */
  orderBy?: { sql: string; params: unknown[] };
  /** a `WITH RECURSIVE walk … , walked …` prefix for a `follow` query. When
   * present, `from` is the walk-joined row source, `where` is just the guards
   * (membership was gated inside the CTE), and run.ts prepends this SQL + its
   * params to every consumer statement and orders/paginates by `walked.wpath`. */
  cte?: { sql: string; params: unknown[] };
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

// The recursion-intrinsic column expressions exposed to the post-walk scope of a
// follow query (all param-free refs into the `walked` CTE). $frontier folds the
// depth/budget-cutoff causes into the same "there is unfollowed graph beyond me"
// signal; $cycle is a distinct sugar.
function recurCtx(): { depth: string; stop: string; leaf: string; frontier: string; ordinal: string } {
  return {
    depth: "walked.wdepth",
    stop: "walked.wstop",
    leaf: "(walked.wstop = 'leaf')",
    frontier: "(walked.wstop IN ('frontier','depth'))",
    ordinal: "walked.wordinal",
  };
}

// Compile a recursive (`follow`) query to a bounded WITH RECURSIVE. The walk is
// closed over the query row type T. The query `where` is the SEED predicate
// (level 1 only); the follow relation yields successors; the follow-local
// successor `where` shapes which successors keep participating at every hop
// (running out → `$stop == "leaf"`) and `frontier` cuts a relation that could
// otherwise continue. (Seed-vs-successor are two orthogonal knobs: the top
// `where` is NOT re-applied during recursion — that is exactly what the
// follow-local `where` expresses, without which single-root subtree walks would
// be impossible.) The non-recursive `walked` CTE materializes each occurrence's
// depth + categorical `$stop` as columns so the final SELECT can project/filter
// them param-free.
// Build the `WITH RECURSIVE walk … , walked …` prefix for a follow over
// `target`. The base is caller-supplied: `seedFrom` is its row source and
// `seedPred` its WHERE (guards + either the top-level seed `where`, or — for a
// nested follow-collect — the collect relation's correlation to the outer row +
// the collect `where`). The step (follow relation), stop precedence, cycle
// admission, leaf refinement, distinct and $ordinal are identical either way.
// The fixed scaffolding aliases (s/c/pw/x/walk/walked) do not collide with the
// canonical row aliases (d/b/n) or allocAlias output (n1,…), and SQLite scopes
// CTE names per (sub)query, so this composes inside a correlated subquery.
function buildWalkCte(
  target: CelTarget, follow: FollowSpec, repoId: string, semCtx: { semantic?: SemanticResolver },
  seedFrom: string, seedPred: { sql: string; params: unknown[] },
): { sql: string; params: unknown[] } {
  const id = ID_COLUMN[target];
  const tbl = TABLE[target];
  const rel = follow.relation;
  const maxDepth = follow.maxDepth;
  const isDocs = target === "docs";
  const dOf = (row: string): string => (isDocs ? row : `${row}d`);

  const stopExpr = (frontierSql: string | null, depthExpr: string, cycleExpr?: string): string => {
    const branches: string[] = [];
    if (cycleExpr) branches.push(`WHEN ${cycleExpr} THEN 'cycle'`);
    if (frontierSql) branches.push(`WHEN (${frontierSql}) THEN 'frontier'`);
    branches.push(`WHEN ${depthExpr} >= ${maxDepth} THEN 'depth'`);
    return `CASE ${branches.join(" ")} ELSE 'interior' END`;
  };
  // Node identity for cycle detection + `distinct` dedup: the entity id by
  // default, or a `by <expr>` field/intrinsic. Two rows with the same key are the
  // same node — a revisit of a key on the path is a cycle; `distinct` keeps one
  // per key. The row id (not the key) is always what rejoins the row. Keys must
  // be param-free (a field/intrinsic), so they inline safely into the path.
  const keyExpr = (alias: string): string => {
    if (!follow.by) return `${alias}.${id}`;
    const v = compileValue(follow.by.source, target, { self: alias, doc: dOf(alias), ...semCtx });
    if (v.params.length > 0) {
      throw new FilterInvalid("follow `by <expr>` must be a field/intrinsic identity (no bound parameters)", "OQX follow");
    }
    return v.expr;
  };
  const keyS = keyExpr("s");
  const keyC = keyExpr("c");

  // ---- base: caller-supplied seed rows, depth 1 -----------------------------
  const seedCtx: AliasCtx = { self: "s", doc: dOf("s"), ...semCtx };
  const frontierSeed = follow.frontier ? compilePredicate(follow.frontier, seedCtx) : null;
  const seedStop = stopExpr(frontierSeed ? frontierSeed.sql : null, "1");
  const baseSql =
    `SELECT s.${id}, 1, '/' || ${keyS} || '/', ${seedStop}, ${keyS} FROM ${seedFrom} WHERE ${seedPred.sql}`;
  const baseParams = [...(frontierSeed ? frontierSeed.params : []), ...seedPred.params];

  // ---- step: only 'interior' rows expand; cyclic children are ADMITTED -------
  const childCtx: AliasCtx = { self: "c", doc: dOf("c"), ...semCtx };
  const frontierChild = follow.frontier ? compilePredicate(follow.frontier, childCtx) : null;
  const succStep = follow.successorWhere ? compilePredicate(follow.successorWhere, childCtx) : null;
  const childGuard = guardsFor(target, "c", dOf("c"), repoId);
  const childStop = stopExpr(frontierChild ? frontierChild.sql : null, "w.depth + 1", `instr(w.path, '/' || ${keyC} || '/') > 0`);
  const childDocJoin = !isDocs ? ` JOIN docs ${dOf("c")} ON ${dOf("c")}.doc_id = c.doc_id` : "";
  const stepConds: string[] = [`w.stop = 'interior'`, childGuard.sql];
  const stepWhereParams: unknown[] = [...childGuard.params];
  if (succStep) { stepConds.push(`(${succStep.sql})`); stepWhereParams.push(...succStep.params); }
  const stepSql =
    `SELECT c.${id}, w.depth + 1, w.path || ${keyC} || '/', ${childStop}, ${keyC} ` +
    `FROM walk w JOIN ${tbl} pw ON pw.${id} = w.id ` +
    `JOIN ${tbl} c ON ${rel.correlate("pw", "c")}${childDocJoin} ` +
    `WHERE ${stepConds.join(" AND ")}`;
  const stepParams = [...(frontierChild ? frontierChild.params : []), ...stepWhereParams];

  // ---- walked: refine 'interior' rows to leaf/interior; pass terminal stops --
  const c2Ctx: AliasCtx = { self: "c2", doc: dOf("c2"), ...semCtx };
  const c2Guard = guardsFor(target, "c2", dOf("c2"), repoId);
  const succLeaf = follow.successorWhere ? compilePredicate(follow.successorWhere, c2Ctx) : null;
  const leafConds = [rel.correlate("x", "c2"), c2Guard.sql];
  const leafParams: unknown[] = [...c2Guard.params];
  if (succLeaf) { leafConds.push(`(${succLeaf.sql})`); leafParams.push(...succLeaf.params); }
  const leafExists = `NOT EXISTS (SELECT 1 FROM ${rowSource(target, "c2", dOf("c2"))} WHERE ${leafConds.join(" AND ")})`;
  const wstopCase = `CASE WHEN walk.stop <> 'interior' THEN walk.stop WHEN ${leafExists} THEN 'leaf' ELSE 'interior' END`;

  const xGuard = guardsFor(target, "x", dOf("x"), repoId);
  const walkedParams: unknown[] = [...leafParams, ...xGuard.params];
  // `distinct` keeps the minimal (depth, path) occurrence per IDENTITY (walk.key
  // — the entity id by default, or the `by` key). Default key == id, so this is
  // byte-identical to id-dedup when `by` is absent.
  const distinctClause = follow.distinct
    ? ` AND NOT EXISTS (SELECT 1 FROM walk w2 WHERE w2.key = walk.key AND (w2.depth < walk.depth OR (w2.depth = walk.depth AND w2.path < walk.path)))`
    : "";
  const walkedSql =
    `SELECT x.${id} AS wid, walk.depth AS wdepth, walk.path AS wpath, ${wstopCase} AS wstop, ` +
    `ROW_NUMBER() OVER (ORDER BY walk.depth, walk.path) AS wordinal ` +
    `FROM ${rowSource(target, "x", dOf("x"))} JOIN walk ON x.${id} = walk.id ` +
    `WHERE ${xGuard.sql}${distinctClause}`;

  return {
    sql: `WITH RECURSIVE walk(id, depth, path, stop, key) AS (\n${baseSql}\nUNION ALL\n${stepSql}\n), walked AS (\n${walkedSql}\n)`,
    params: [...baseParams, ...stepParams, ...walkedParams],
  };
}

function compileFollowQuery(q: Query, follow: FollowSpec, repoId: string, semantic?: SemanticResolver): CompiledQuery {
  const target = q.target;
  const id = ID_COLUMN[target];
  const isDocs = target === "docs";
  const semCtx = semantic ? { semantic } : {};
  const dOf = (row: string): string => (isDocs ? row : `${row}d`);
  const reserved = new Set<string>([
    "d", ALIAS_BASE[target], "walk", "walked",
    "s", "sd", "c", "cd", "pw", "pd", "w", "x", "xd", "c2", "cd2", "w2",
  ]);

  // Top-level seed: guards + the seed `where`, over all rows of the target.
  const seedCtx: AliasCtx = { self: "s", doc: dOf("s"), ...semCtx };
  const seedGuard = guardsFor(target, "s", dOf("s"), repoId);
  const seedBindings = buildBindings(q, target, seedCtx, reserved, repoId);
  const seedWhere = q.where
    ? compileWhere(q.where, seedCtx, reserved, repoId, seedBindings)
    : { sql: "1", params: [] as unknown[] };
  const cte = buildWalkCte(target, follow, repoId, semCtx, rowSource(target, "s", dOf("s")), {
    sql: `${seedGuard.sql} AND (${seedWhere.sql})`,
    params: [...seedGuard.params, ...seedWhere.params],
  });
  const cteSql = cte.sql;
  const cteParams = cte.params;

  // ---- final SELECT: canonical row joined to `walked`, recur intrinsics live -
  const finalCtx: AliasCtx = { ...defaultCtx(target), recur: recurCtx(), ...semCtx };
  const g = guards(target, repoId);
  const from = `${fromClause(target)} JOIN walked ON walked.wid = ${ALIAS_BASE[target]}.${id}`;
  const topBindings = buildBindings(q, target, finalCtx, reserved, repoId);
  const lifts = gatherLiftBindings(q.where);
  const projections = q.select.map((s) => compileProjection(s, target, finalCtx, reserved, repoId, topBindings, lifts));

  // Post-walk result filter: the `where` conjuncts that reference recursion
  // intrinsics ($depth/$stop/…), compiled against `walked` via finalCtx.recur.
  const post = q.postWhere ? compileWhere(q.postWhere, finalCtx, reserved, repoId, topBindings) : null;
  const whereSql = post ? `${g.sql} AND (${post.sql})` : g.sql;
  const whereParams = post ? [...g.params, ...post.params] : g.params;

  let orderBy: { sql: string; params: unknown[] } | undefined;
  if (q.orderBy && q.orderBy.length > 0) {
    const parts: string[] = [];
    const oparams: unknown[] = [];
    for (const o of q.orderBy) {
      const v = compileValue(o.source, target, finalCtx);
      parts.push(`${v.expr} ${o.desc ? "DESC" : "ASC"}`);
      oparams.push(...v.params);
    }
    orderBy = { sql: parts.join(", "), params: oparams };
  }

  return {
    from,
    where: whereSql,
    whereParams,
    projections,
    target,
    cte: { sql: cteSql, params: cteParams },
    ...(orderBy ? { orderBy } : {}),
  };
}

export function compileQuery(q: Query, repoId: string, semantic?: SemanticResolver): CompiledQuery {
  if (q.follow) return compileFollowQuery(q, q.follow, repoId, semantic);
  const ctx = defaultCtx(q.target);
  if (semantic) ctx.semantic = semantic; // query-global; flows to every child ctx
  const inUse = new Set([ctx.self, "d"]);
  // A re-projected source (`from docs from nodes` / `repo.nodes … { from doc }`)
  // builds a JOIN chain ending in the canonical row; a simple source is today's
  // single-table FROM.
  const chained = q.sourceRelations.length > 0 ? chainedFrom(q, repoId) : null;
  const g = chained ? chained.guards : guards(q.target, repoId);
  const fromSql = chained ? chained.from : fromClause(q.target);
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
    from: fromSql,
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
): { name: string; sql: string; params: unknown[]; isJson: boolean; unwrapSingle?: boolean; docBody?: boolean } {
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
  // docs `$body` is the reconstructed file — not a SQL column. Emit a NULL
  // placeholder and let run.ts fill it via docsRead (per hit). (On blocks,
  // `$body` is the block's text column, handled by the CEL layer below.)
  if (s.source === "$body" && target === "docs") {
    return { name: s.name, sql: `NULL AS "${s.name}"`, params: [], isJson: false, docBody: true };
  }
  const v = compileValue(s.source, target, ctx);
  return { name: s.name, sql: `${v.expr} AS "${s.name}"`, params: v.params, isJson: false };
}

// Re-exported so run.ts / tests can build the same nested type without importing IR.
export type { NestedQuery };
