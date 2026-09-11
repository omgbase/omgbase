import type { Node, FieldRef, Literal, Comparison, RelOp, OuterRef } from "./ast.js";
import { FilterInvalid } from "./parser.js";
import { sanitizeFtsQuery } from "../fts-query.js";

// Compile a CEL AST to a SQL WHERE fragment + bound params for a target
// (10 §8). Absence semantics (10 §3.3) are encoded directly in SQL: a missing
// key never matches a comparison; !absent-bool is true.

export type Target = "docs" | "blocks" | "nodes";

// ---- alias context (OQX alias-parameterization seam) ------------------------
// A scope's row is referenced by a SQL alias. The base `query` surface always
// uses the canonical per-target aliases (docs=d, blocks=b, nodes=n) and a single
// live scope. OQX nests scopes and, for same-target nesting (nodes→nodes, …),
// must give the inner scope a DISTINCT alias (n1, b1, …) so its correlation and
// field references do not shadow the outer row. `ctx.self` is the alias of the
// target's own table; `ctx.doc` is the alias of the correlated `docs` row that
// property routing and `$path`/`doc.*` reach-through resolve against (== self on
// the docs target). For OQX's slice-2 relations every nested scope shares the
// outer document, so `doc` stays `d`; a future cross-document relation would
// allocate a distinct doc alias here too.
export interface AliasCtx {
  self: string;
  doc: string;
  /** Resolver for `^name` one-scope-outward references (OQX correlation). OQX
   * supplies it per nested scope; the base `query` surface leaves it undefined,
   * so a `^name` reaching an absent resolver is a loud error. */
  outer?: OuterResolver;
  /** Resolver for `semantic("phrase")` — maps the phrase to a pre-computed query
   * vector (BLOB) + its model. OQX's async runner embeds the literals and
   * supplies this; when absent (or the phrase is unresolved) `semantic(...)` is a
   * loud `semantic_unavailable`. The language stays provider-free: the function
   * takes a string, the runtime supplies the embedding. */
  semantic?: SemanticResolver;
}

// A binding visible to a nested scope via `^name`. A parent SELECT value binds a
// `scalar` (its value expression compiled against the parent row); a lift or a
// parent `collect` binds a `collection` (a json-array subquery). Each is a thunk
// so it is only compiled when actually referenced.
export interface OuterBinding {
  scalar?: () => { expr: string; params: unknown[] };
  collection?: () => { expr: string; params: unknown[] };
}
export type OuterResolver = (name: string) => OuterBinding | undefined;

// A resolved query embedding for a `semantic("phrase")` call: the query vector
// as a bound BLOB plus the model whose stored embeddings it must be compared to.
export interface SemanticVec { vec: Buffer; model: string }
export type SemanticResolver = (phrase: string) => SemanticVec | undefined;

function resolveOuter(ctx: AliasCtx, name: string): OuterBinding {
  const b = ctx.outer?.(name);
  if (!b) {
    throw new FilterInvalid(
      `no binding ^${name} one scope outward — a ^ reference reads a name bound in the immediately enclosing query scope`,
      "OQX ^",
    );
  }
  return b;
}

export function defaultCtx(target: Target): AliasCtx {
  if (target === "docs") return { self: "d", doc: "d" };
  if (target === "blocks") return { self: "b", doc: "d" };
  return { self: "n", doc: "d" };
}

// Build a JSON1 path literal from parsed identifier segments. Segments come
// from the lexer's identifier rule ([A-Za-z_][A-Za-z0-9_]*), so they are safe
// to inline — no user free-text reaches this. Inlining (rather than binding)
// keeps field expressions parameter-free, so repeating an expression in SQL
// never desynchronizes the bound-param list.
function jsonPath(segs: string[]): string {
  for (const s of segs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
      throw new FilterInvalid(`invalid field segment '${s}'`, "10 §2");
    }
  }
  return `'$.${segs.join(".")}'`;
}

// ---- properties routing (12-properties-table) -------------------------------
// Documents-target fields (and doc.<k> reach-through from blocks/nodes) resolve
// against the indexed `properties` table instead of json_extract over a JSON
// blob. A field access is one of: a scalar-value expression (comparisons), or
// an existence/count predicate (membership, size, has, bool-context). All
// correlate on `<doc>.doc_id` (the correlated docs row, present on every target).

const PROP_SOURCES = new Set(["frontmatter", "inline", "computed"]);

// Computed properties surfaced as document intrinsics (12 §4). Engine-derived,
// stored as source='computed' rows keyed by their $ name. Filterable like any
// property (scalar ==, list(), membership) but never shadow authored keys.
const COMPUTED_INTRINSICS = new Set(["$title", "$tags"]);

// Base names of the document intrinsics ($id, $path, ...) MINUS their `$`. On
// the docs open namespace (and doc.<k> reach-through), a BARE first segment
// equal to one of these is almost always a typo for the intrinsic: it would
// otherwise resolve to an absent frontmatter key and silently match nothing
// (a misleading empty). We reject it with a hint instead. `title`/`tags` are
// deliberately EXCLUDED: their $-forms are `computed` intrinsics that do not
// shadow authored frontmatter, so bare `title`/`tags` remain legitimate key
// access (see COMPUTED_INTRINSICS and QUERY_SYNTAX). A source-scoped form
// (frontmatter.path / inline.path) is an explicit request for that property
// and is likewise not caught — only the bare first-segment case is the trap.
const RESERVED_INTRINSIC_BASENAMES = new Set([
  "id", "path", "repo", "updated_at", "content_hash", "body",
]);

// Guard the docs open namespace against reserved-intrinsic collisions. `segs`
// are the property key segments (after any doc./source scope has been peeled).
// Throws when the FIRST segment shadows an intrinsic base name.
function guardReservedCollision(segs: string[]): void {
  if (RESERVED_INTRINSIC_BASENAMES.has(segs[0]!)) {
    const name = segs[0]!;
    throw new FilterInvalid(
      `bare '${name}' reads a frontmatter key; did you mean the intrinsic $${name}? (use frontmatter.${name} to force the property)`,
      "10 §2",
    );
  }
}

// Validate + join identifier segments into a dotted property key. Segments come
// from the lexer's identifier rule, so inlining is injection-safe (mirrors
// jsonPath); keeping keys param-free preserves the "fields carry no params"
// invariant the comparison/membership param ordering relies on.
function propKey(segs: string[]): string {
  for (const s of segs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
      throw new FilterInvalid(`invalid field segment '${s}'`, "10 §2");
    }
  }
  return segs.join(".");
}

interface PropRef { key: string; source?: string }

// Is this field a properties-routed document property? Returns {key, source?}
// or null (intrinsic, `format`, or a non-doc field). A leading
// frontmatter./inline./computed. segment (with something after it) is a
// source scope, not a key segment.
function propRef(field: FieldRef, target: Target): PropRef | null {
  let segs = field.segments;
  if (target === "docs") {
    // Computed intrinsic ($title, $tags): route to source='computed' rows.
    if (field.intrinsic) {
      if (segs.length === 1 && COMPUTED_INTRINSICS.has(segs[0]!)) return { key: segs[0]!, source: "computed" };
      return null;
    }
    if (segs[0] === "format") return null;
  } else {
    if (field.intrinsic) return null;
    // blocks / nodes: only doc.<k> reach-through routes to properties.
    if (segs[0] !== "doc") return null;
    segs = segs.slice(1);
    // doc.$title reach-through to a computed intrinsic.
    if (segs.length === 1 && COMPUTED_INTRINSICS.has(segs[0]!)) return { key: segs[0]!, source: "computed" };
    if (segs.length === 0 || segs[0]!.startsWith("$") || segs[0] === "format") return null;
  }
  if (segs.length >= 2 && PROP_SOURCES.has(segs[0]!)) {
    const source = segs[0]!;
    return { key: propKey(segs.slice(1)), source };
  }
  // Bare (non-`$`, non-source-scoped) key: reject a first segment that shadows
  // a reserved intrinsic base name (path/id/repo/...) so a typo for `$path`
  // fails loud instead of silently resolving to an absent frontmatter key.
  guardReservedCollision(segs);
  return { key: propKey(segs) };
}

function srcClause(source: string | undefined, alias = "p"): string {
  return source ? ` AND ${alias}.source = '${source}'` : "";
}

// Scalar value of a property for comparisons: the scalar-authored value, but
// ONLY when the key is single-valued in the queried scope. A key resolves to a
// scalar iff it has exactly one row in scope AND that row is card='scalar'.
// This makes:
//   - a lone inline `element:: fire` (card='scalar', 1 row) comparable;
//   - a YAML list `tags: [a]` (1 row, card='list') NOT scalar-equal;
//   - a frontmatter+inline collision on a bare key (≥2 rows in the union scope)
//     fall back to list semantics — `job == "farmer"` is false, you must use
//     `"farmer" in list(job)`.
// The inner COUNT spans ALL cards in scope so multiplicity — not just authored
// shape — governs scalar eligibility. NULL (⇒ false) when the gate fails.
function propScalarExpr(ref: PropRef, ctx: AliasCtx): string {
  return `(SELECT COALESCE(p.val_text, p.val_num, p.val_bool) FROM properties p
           WHERE p.doc_id = ${ctx.doc}.doc_id AND p.key = '${ref.key}' AND p.card = 'scalar'${srcClause(ref.source)}
             AND p.deleted_commit IS NULL
             AND (SELECT COUNT(*) FROM properties p2
                  WHERE p2.doc_id = ${ctx.doc}.doc_id AND p2.key = '${ref.key}'${srcClause(ref.source, "p2")}
                    AND p2.deleted_commit IS NULL) = 1
           LIMIT 1)`;
}

// EXISTS over ALL rows for the key (any card) whose value equals ? — the
// membership primitive. Spans scalar and list rows, so `"canon" in list(layer)`
// matches a scalar frontmatter value and `"a" in list(tags)` matches a list.
function propMemberExists(ref: PropRef, ctx: AliasCtx): string {
  return `EXISTS (SELECT 1 FROM properties p WHERE p.doc_id = ${ctx.doc}.doc_id AND p.key = '${ref.key}'${srcClause(ref.source)}
            AND p.deleted_commit IS NULL AND COALESCE(p.val_text, p.val_num, p.val_bool) = ?)`;
}

// COUNT of all rows for the key (size(list(k))): 0 when absent, 1 for a scalar,
// N for a list — matching json_array_length / scalar=1 / null=0 today.
function propCountExpr(ref: PropRef, ctx: AliasCtx): string {
  return `(SELECT COUNT(*) FROM properties p WHERE p.doc_id = ${ctx.doc}.doc_id AND p.key = '${ref.key}'${srcClause(ref.source)}
           AND p.deleted_commit IS NULL)`;
}

// Existence of the key in any card (has(k)).
function propHasExists(ref: PropRef, ctx: AliasCtx): string {
  return `EXISTS (SELECT 1 FROM properties p WHERE p.doc_id = ${ctx.doc}.doc_id AND p.key = '${ref.key}'${srcClause(ref.source)}
            AND p.deleted_commit IS NULL)`;
}

// Truthy in boolean position: present list row, or present scalar with a
// truthy value (not 0/''/false). Absent ⇒ false; `!k` negates.
function propTruthyExists(ref: PropRef, ctx: AliasCtx): string {
  return `EXISTS (SELECT 1 FROM properties p WHERE p.doc_id = ${ctx.doc}.doc_id AND p.key = '${ref.key}'${srcClause(ref.source)}
            AND p.deleted_commit IS NULL
            AND (p.card = 'list' OR COALESCE(p.val_text, p.val_num, p.val_bool) NOT IN (0, '', 'false')))`;
}

// Column/JSON accessor for a field on a given target. Returns a SQL scalar
// expression that is NULL when the field is absent. Never carries params.
function fieldSql(field: FieldRef, target: Target, ctx: AliasCtx): { expr: string } {
  const segs = field.segments;
  const head = segs[0]!;
  const self = ctx.self;
  const doc = ctx.doc;

  if (field.intrinsic) {
    if (target === "docs") {
      switch (head) {
        case "$id": return { expr: `${self}.doc_id` };
        case "$path": return { expr: `${self}.path` };
        case "$repo": return { expr: `${self}.repo_id` };
        case "$updated_at": return { expr: `(SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = ${self}.current_rev)` };
        case "$content_hash": return { expr: `hex(${self}.file_hash)` };
        default: {
          // Computed property intrinsic ($title, $tags) → properties row scalar.
          const ref = propRef(field, target);
          if (ref) return { expr: propScalarExpr(ref, ctx) };
          throw new FilterInvalid(`unknown intrinsic ${head} on docs`, "10 §2");
        }
      }
    } else if (target === "nodes") {
      switch (head) {
        case "$id": return { expr: `${self}.node_id` };
        case "$node_id": return { expr: `${self}.node_id` };
        case "$doc_id": return { expr: `${self}.doc_id` };
        case "$block_id": return { expr: `${self}.block_id` };
        case "$path": return { expr: `${doc}.path` };
        default: throw new FilterInvalid(`unknown intrinsic ${head} on nodes`, "10 §2");
      }
    } else {
      switch (head) {
        case "$id": return { expr: `${self}.block_id` };
        case "$doc": return { expr: `${self}.doc_id` };
        case "$path": return { expr: `${doc}.path` };
        case "$ordinal": return { expr: `${self}.ordinal` };
        case "$depth": return { expr: `${self}.depth` };
        case "$updated_at": return { expr: `(SELECT MAX(c.ts) FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ${self}.block_id)` };
        default: throw new FilterInvalid(`unknown intrinsic ${head} on blocks`, "10 §2");
      }
    }
  }

  if (target === "docs") {
    if (head === "format") return { expr: `${self}.format` };
    const ref = propRef(field, target);
    if (ref) return { expr: propScalarExpr(ref, ctx) };
    return { expr: `json_extract(${self}.metadata, ${jsonPath(segs)})` };
  }

  if (target === "nodes") {
    if (head === "kind") return { expr: `${self}.kind` };
    if (head === "name") return { expr: `${self}.name` };
    if (head === "value") return { expr: `${self}.value` };
    if (head === "attrs") {
      return { expr: `json_extract(${self}.attrs, ${jsonPath(segs.slice(1))})` };
    }
    if (head === "doc") {
      const rest = segs.slice(1);
      if (rest[0]?.startsWith("$")) {
        return fieldSql({ kind: "field", segments: rest, intrinsic: true }, "docs", { self: doc, doc });
      }
      if (rest[0] === "format") return { expr: `${doc}.format` };
      const ref = propRef(field, target);
      if (ref) return { expr: propScalarExpr(ref, ctx) };
      return { expr: `json_extract(${doc}.metadata, ${jsonPath(rest)})` };
    }
    if (head === "block") {
      const rest = segs.slice(1);
      if (rest[0] === "type") return { expr: `(SELECT bb.type FROM blocks bb WHERE bb.block_id = ${self}.block_id)` };
      if (rest[0] === "text") return { expr: `(SELECT bb.text FROM blocks bb WHERE bb.block_id = ${self}.block_id)` };
      throw new FilterInvalid(`unknown block field '${rest.join(".")}' on nodes`, "10 §2");
    }
    throw new FilterInvalid(`unknown field '${segs.join(".")}' on nodes`, "10 §2");
  }

  // blocks target
  if (head === "type") return { expr: `${self}.type` };
  if (head === "text") return { expr: `${self}.text` };
  if (head === "attrs") {
    return { expr: `json_extract(${self}.attrs, ${jsonPath(segs.slice(1))})` };
  }
  if (head === "doc") {
    const rest = segs.slice(1);
    if (rest[0]?.startsWith("$")) {
      return fieldSql({ kind: "field", segments: rest, intrinsic: true }, "docs", { self: doc, doc });
    }
    if (rest[0] === "format") return { expr: `${doc}.format` };
    const ref = propRef(field, target);
    if (ref) return { expr: propScalarExpr(ref, ctx) };
    return { expr: `json_extract(${doc}.metadata, ${jsonPath(rest)})` };
  }
  throw new FilterInvalid(`unknown field '${segs.join(".")}' on blocks`, "10 §2");
}

function literalParam(lit: Literal): unknown {
  return lit.value;
}

// A scalar-valued operand in a comparison: a field, or a value-returning call
// (size(list(f)), child_count(), parent_type()). Returns a NULL-when-absent
// SQL scalar expression + its params.
function scalarSql(node: Node, target: Target, ctx: AliasCtx): { expr: string; params: unknown[] } {
  if (node.kind === "field") return { expr: fieldSql(node, target, ctx).expr, params: [] };
  if (node.kind === "outerref") {
    const b = resolveOuter(ctx, node.name);
    if (!b.scalar) {
      throw new FilterInvalid(
        `^${node.name} is a collection binding; use it as \`<value> in ^${node.name}\`, not as a scalar`,
        "OQX ^",
      );
    }
    return b.scalar();
  }
  if (node.kind === "call") {
    switch (node.name) {
      case "semantic":
        return compileSemantic(argString(node.args, 0), target, ctx);
      case "size": {
        const inner = node.args[0];
        if (inner && inner.kind === "call" && inner.name === "list") {
          const lf = argField(inner.args, 0);
          const ref = propRef(lf, target);
          if (ref) return { expr: propCountExpr(ref, ctx), params: [] };
          const f = fieldSql(lf, target, ctx);
          return {
            expr: `(CASE WHEN ${f.expr} IS NULL THEN 0
                        WHEN json_valid(${f.expr}) AND json_type(${f.expr})='array'
                            THEN json_array_length(${f.expr})
                        ELSE 1 END)`,
            params: [],
          };
        }
        if (inner && inner.kind === "field") {
          return { expr: `length(${fieldSql(inner, target, ctx).expr})`, params: [] };
        }
        throw new FilterInvalid("size() takes a field or list(field)");
      }
      case "child_count":
        requireBlocks(target, "child_count");
        return { expr: `(SELECT COUNT(*) FROM blocks cb WHERE cb.parent_block = ${ctx.self}.block_id AND cb.deleted_commit IS NULL)`, params: [] };
      case "parent_type":
        requireBlocks(target, "parent_type");
        return { expr: `(SELECT pb.type FROM blocks pb WHERE pb.block_id = ${ctx.self}.parent_block)`, params: [] };
      default:
        throw new FilterInvalid(`function '${node.name}()' is not a comparable value`, "10 §5");
    }
  }
  throw new FilterInvalid("comparisons must be between a field/value and a literal", "10 §3.1");
}

function compileComparison(cmp: Comparison, target: Target, ctx: AliasCtx): Compiled {
  const rejectList = (n: Node): void => {
    if (n.kind === "call" && n.name === "list") {
      throw new FilterInvalid("list() is only valid inside `in`, size(), .all, .exists", "10 §4");
    }
  };

  // Literal-on-one-side: the canonical form, kept byte-identical (a bound `?`).
  if (cmp.right.kind === "literal" || cmp.left.kind === "literal") {
    let scalar: Node;
    let litNode: Literal;
    let op = cmp.op;
    if (cmp.right.kind === "literal") {
      scalar = cmp.left; litNode = cmp.right;
    } else {
      scalar = cmp.right; litNode = cmp.left as Literal; op = flip(op);
    }
    rejectList(scalar);
    const s = scalarSql(scalar, target, ctx);
    // NULL-safe: absent operands yield NULL; `NULL <op> x` is NULL (falsy),
    // exactly the absence=false rule — including `!=` (10 §3.3 note).
    return {
      sql: `(${s.expr} ${SQL_OP[op]} ?) IS 1`,
      params: [...s.params, coerce(litNode)],
    };
  }

  // Neither side is a literal. This is only reachable via a `^name` correlation
  // operand (`attrs.id == ^owner_id`) — the base `query` grammar still requires a
  // literal (field-vs-field stays an error, unchanged behaviour).
  if (cmp.left.kind !== "outerref" && cmp.right.kind !== "outerref") {
    throw new FilterInvalid("one side of a comparison must be a literal", "10 §3.1");
  }
  rejectList(cmp.left); rejectList(cmp.right);
  const l = scalarSql(cmp.left, target, ctx);
  const r = scalarSql(cmp.right, target, ctx);
  return {
    sql: `(${l.expr} ${SQL_OP[cmp.op]} ${r.expr}) IS 1`,
    params: [...l.params, ...r.params],
  };
}

const SQL_OP: Record<RelOp, string> = {
  "==": "=", "!=": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=",
};

function flip(op: RelOp): RelOp {
  switch (op) {
    case "<": return ">";
    case "<=": return ">=";
    case ">": return "<";
    case ">=": return "<=";
    default: return op;
  }
}

function coerce(lit: Literal): unknown {
  if (lit.type === "bool") return lit.value ? 1 : 0;
  return literalParam(lit);
}

// A bare field in boolean position coerces to false when absent/false.
function compileBoolField(field: FieldRef, target: Target, ctx: AliasCtx): Compiled {
  const ref = propRef(field, target);
  if (ref) return { sql: propTruthyExists(ref, ctx), params: [] };
  const f = fieldSql(field, target, ctx);
  // truthy: not null, not 0, not '', not false
  return {
    sql: `(${f.expr} IS NOT NULL AND ${f.expr} NOT IN (0, '', 'false'))`,
    params: [],
  };
}

// A value-expression fragment for OQX projection (`select name: <expr>`). Parses
// a single scalar CEL expression (a field or value-returning call) and returns a
// NULL-when-absent SQL scalar + params. Comparisons/booleans are not values and
// are rejected. The alias context is supplied by OQX per scope (defaults to the
// canonical per-target aliases).
export function scalarValue(node: Node, target: Target, ctx: AliasCtx = defaultCtx(target)): { expr: string; params: unknown[] } {
  return scalarSql(node, target, ctx);
}

export function compile(node: Node, target: Target, ctx: AliasCtx = defaultCtx(target)): Compiled {
  switch (node.kind) {
    case "or": {
      const l = compile(node.left, target, ctx);
      const r = compile(node.right, target, ctx);
      return { sql: `(${l.sql} OR ${r.sql})`, params: [...l.params, ...r.params] };
    }
    case "and": {
      const l = compile(node.left, target, ctx);
      const r = compile(node.right, target, ctx);
      return { sql: `(${l.sql} AND ${r.sql})`, params: [...l.params, ...r.params] };
    }
    case "not": {
      const inner = compile(node.operand, target, ctx);
      return { sql: `(NOT (${inner.sql}))`, params: inner.params };
    }
    case "comparison":
      return compileComparison(node, target, ctx);
    case "membership":
      return compileMembership(node.value, node.field, target, ctx);
    case "outerMembership":
      return compileOuterMembership(node.value, node.collection, target, ctx);
    case "field":
      return compileBoolField(node, target, ctx);
    case "call":
      return compileCall(node.name, node.args, target, ctx);
    case "method":
      return compileMethod(node, target, ctx);
    default:
      throw new FilterInvalid(`unsupported expression '${node.kind}' in this position`);
  }
}

function compileMembership(value: Literal, field: FieldRef, target: Target, ctx: AliasCtx): Compiled {
  // Documents-target (and doc.<k>) properties: membership is an indexed EXISTS
  // over ALL rows for the key (any card) — scalar or list value equals v.
  const ref = propRef(field, target);
  if (ref) return { sql: propMemberExists(ref, ctx), params: [coerce(value)] };

  // "v" in list(field): field may be scalar or JSON array. Match either the
  // scalar equals v, or (when the value is a JSON array) the array contains v.
  // Absent ⇒ NULL ⇒ [] ⇒ false. json_each over a non-array/NULL yields no rows,
  // so a single EXISTS covers the array case; the scalar case is a direct `=`.
  const f = fieldSql(field, target, ctx);
  const isArray = `(json_valid(${f.expr}) AND json_type(${f.expr}) = 'array')`;
  const sql = `(
    (NOT ${isArray} AND ${f.expr} = ?)
    OR (${isArray} AND EXISTS (SELECT 1 FROM json_each(${f.expr}) je WHERE je.value = ?))
  )`;
  // param order matches expr occurrences: isArray(1), f=?, isArray(1), value, isArray in EXISTS(1), value
  return { sql, params: [coerce(value), coerce(value)] };
}

// `<value> in ^name`: does the one-scope-outward collection (a json array, e.g.
// a lift) contain the current scope's value? json_each yields no rows over a
// NULL/non-array, so absence ⇒ false. The collection expression is resolved from
// the enclosing scope (it references the parent row's aliases, valid here as a
// correlated subquery); its params precede the value's in statement order.
function compileOuterMembership(value: Node, ref: OuterRef, target: Target, ctx: AliasCtx): Compiled {
  const b = resolveOuter(ctx, ref.name);
  if (!b.collection) {
    throw new FilterInvalid(
      `^${ref.name} is a scalar binding; membership needs a collection (a lift or a parent collect)`,
      "OQX ^",
    );
  }
  const coll = b.collection();
  let vExpr: string;
  let vParams: unknown[];
  if (value.kind === "literal") {
    vExpr = "?"; vParams = [coerce(value)];
  } else {
    const v = scalarSql(value, target, ctx);
    vExpr = v.expr; vParams = v.params;
  }
  return {
    sql: `EXISTS (SELECT 1 FROM json_each(${coll.expr}) je WHERE je.value = ${vExpr})`,
    params: [...coll.params, ...vParams],
  };
}

function argField(args: Node[], i: number): FieldRef {
  const a = args[i];
  if (!a || a.kind !== "field") throw new FilterInvalid("expected a field argument");
  return a;
}
function argString(args: Node[], i: number): string {
  const a = args[i];
  if (!a || a.kind !== "literal" || a.type !== "string") throw new FilterInvalid("expected a string argument");
  return a.value as string;
}

function compileCall(name: string, args: Node[], target: Target, ctx: AliasCtx): Compiled {
  switch (name) {
    case "has": {
      const hf = argField(args, 0);
      const ref = propRef(hf, target);
      if (ref) return { sql: propHasExists(ref, ctx), params: [] };
      const f = fieldSql(hf, target, ctx);
      return { sql: `(${f.expr} IS NOT NULL)`, params: [] };
    }
    case "size":
      throw new FilterInvalid("size(...) must be compared, e.g. size(list(tags)) > 2", "10 §4");
    case "semantic":
      // semantic(...) yields a cosine SCORE, not a boolean; it must be compared
      // (threshold prune) or projected — e.g. semantic("aurora") > 0.6.
      throw new FilterInvalid('semantic(...) returns a score; compare it, e.g. semantic("x") > 0.6', "OQX semantic");
    // structural functions (blocks target) — 10 §5
    case "under":
      requireBlocks(target, "under");
      return compileUnder(argString(args, 0), ctx);
    case "under_heading":
      requireBlocks(target, "under_heading");
      return compileUnderHeading(argString(args, 0), ctx);
    case "within":
      requireBlocks(target, "within");
      return compileWithin(argString(args, 0), ctx);
    case "text":
      return compileText(argString(args, 0), target, ctx);
    case "has_edge":
      return compileHasEdge(args, target, ctx);
    case "has_anchor":
      requireBlocks(target, "has_anchor");
      return { sql: `EXISTS (SELECT 1 FROM edges e2 WHERE e2.src_block = ${ctx.self}.block_id AND e2.anchor IS NOT NULL)`, params: [] };
    case "parent_type":
      requireBlocks(target, "parent_type");
      // parent_type() returns a value; only valid inside a comparison. Emitted
      // as a scalar subquery via a synthetic field is complex; support the
      // common form parent_type() == "x" by rewriting here is not possible
      // without the comparison context, so expose as a scalar the caller wraps.
      throw new FilterInvalid("parent_type() must be compared, e.g. parent_type() == \"blockquote\" (unsupported standalone)", "10 §5");
    case "child_count":
      requireBlocks(target, "child_count");
      throw new FilterInvalid("child_count() must be compared, e.g. child_count() > 0", "10 §5");
    case "under_kind":
      requireBlocks(target, "under_kind");
      return compileUnderKind(argString(args, 0), args.length >= 2 ? argString(args, 1) : undefined, ctx);
    case "yaml_path":
      requireBlocks(target, "yaml_path");
      return compileYamlPath(argString(args, 0), ctx);
    case "json_pointer":
      requireBlocks(target, "json_pointer");
      return compileJsonPointer(argString(args, 0), ctx);
    case "list":
      throw new FilterInvalid("list() is only valid inside `in`, size(), .all, .exists", "10 §4");
    default:
      throw new FilterInvalid(`unknown function '${name}'`, "10 §3.2");
  }
}

function requireBlocks(target: Target, fn: string): void {
  if (target !== "blocks") throw new FilterInvalid(`${fn}() is only available on the blocks target`, "10 §5");
}

function compileUnder(target: string, ctx: AliasCtx): Compiled {
  // subtree membership via ancestor_path prefix, or section range when the
  // target is a heading. v1: ancestor_path prefix on the target block id.
  return {
    sql: `(${ctx.self}.ancestor_path LIKE ? OR ${ctx.self}.block_id = ?)`,
    params: [`%/${target}/%`, target],
  };
}

function compileUnderHeading(text: string, ctx: AliasCtx): Compiled {
  // Some ancestor section's heading text contains `text` (case-insensitive).
  // Section ranges are in TOP-LEVEL ordinals, so we compare against the block's
  // top-level ancestor's ordinal (the block itself if it is already top-level).
  const top = topOrdinal(ctx.self);
  return {
    sql: `EXISTS (
      SELECT 1 FROM sections s
      JOIN blocks hb ON hb.block_id = s.heading_block
      WHERE s.doc_id = ${ctx.self}.doc_id
        AND lower(hb.text) LIKE '%' || lower(?) || '%'
        AND ${top} >= s.first_ordinal AND ${top} <= s.last_ordinal
    )`,
    params: [text],
  };
}

// Ordinal of a block's top-level ancestor. ancestor_path is '/b_x/b_y/…'; the
// first segment (when present) is the top-level ancestor. If the block is
// itself top-level (parent_block IS NULL), its own ordinal is the top ordinal.
// Parameterized by the block alias so it composes with OQX's per-scope aliases
// and cross-target relation correlations (e.g. section.blocks).
export function topOrdinal(self: string): string {
  return `(
  CASE WHEN ${self}.parent_block IS NULL THEN ${self}.ordinal
  ELSE (SELECT tb.ordinal FROM blocks tb
        WHERE tb.doc_id = ${self}.doc_id AND tb.parent_block IS NULL
          AND tb.block_id = REPLACE(
            SUBSTR(${self}.ancestor_path, 2, INSTR(SUBSTR(${self}.ancestor_path, 2), '/') - 1), '/', ''))
  END)`;
}

function compileWithin(target: string, ctx: AliasCtx): Compiled {
  // doc id, exact path, or glob path
  if (target.startsWith("d_")) {
    return { sql: `(${ctx.self}.doc_id = ?)`, params: [target] };
  }
  if (target.includes("*")) {
    const like = target.replace(/[%_]/g, "\\$&").replace(/\*/g, "%");
    return { sql: `(${ctx.doc}.path LIKE ? ESCAPE '\\')`, params: [like] };
  }
  return { sql: `(${ctx.doc}.path = ?)`, params: [target] };
}

// text("terms") — a full-text PRUNING predicate (FTS5, the same index the
// `query` tool's `text:` uses). It is a boolean, not a ranker: it says "this
// row's text matches", composing with every other predicate (and, notably,
// inside correlated subqueries / collects). bm25 relevance ordering is a
// ranking concern handled separately (order by). The literal is sanitized at
// compile time (fts-query.js); a query that reduces to no searchable token
// matches nothing (mirrors the `query` tool's empty-text short-circuit). Blocks
// match their own row; docs match when any of their blocks does; nodes use the
// node FTS index. Aliased by the scope so it works under OQX's per-scope aliases.
function compileText(terms: string, target: Target, ctx: AliasCtx): Compiled {
  const match = sanitizeFtsQuery(terms);
  if (match === "") return { sql: "(1 = 0)", params: [] };
  if (target === "docs") {
    return {
      sql: `${ctx.self}.doc_id IN (SELECT b2.doc_id FROM blocks_fts JOIN blocks b2 ON b2.rowid = blocks_fts.rowid WHERE blocks_fts MATCH ?)`,
      params: [match],
    };
  }
  const ftsTable = target === "nodes" ? "nodes_fts" : "blocks_fts";
  return {
    sql: `${ctx.self}.rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ?)`,
    params: [match],
  };
}

// semantic("phrase") — a scalar SCORE: cosine similarity of the current row's
// embedding to the (pre-computed) query vector, via the `cosine` UDF. A SCORE,
// not a ranker — usable as a threshold prune (`semantic("x") > 0.6`) or a
// projection (`select s: semantic("x")`); ORDER BY does the actual ranking.
// docs score their whole-document vector (doc_embeddings), blocks their own
// block vector (embeddings, keyed by raw_hash); nodes have no embeddings. A row
// with no stored vector scores NULL (cosine of a missing BLOB) ⇒ absent, so a
// threshold comparison excludes it (absence = false). The query vector + model
// come from ctx.semantic (the runner embedded the literal); absent ⇒ loud.
function compileSemantic(phrase: string, target: Target, ctx: AliasCtx): { expr: string; params: unknown[] } {
  if (target === "nodes") {
    throw new FilterInvalid('semantic(...) is available on the docs and blocks targets (nodes have no embeddings)', "OQX semantic");
  }
  const resolved = ctx.semantic?.(phrase);
  if (!resolved) {
    throw new FilterInvalid(
      `semantic(${JSON.stringify(phrase)}) needs an embedding provider; none is configured for this query`,
      "OQX semantic",
    );
  }
  const expr = target === "docs"
    ? `(SELECT cosine(de.vec, ?) FROM doc_embeddings de WHERE de.doc_id = ${ctx.self}.doc_id AND de.model = ?)`
    : `(SELECT cosine(e.vec, ?) FROM embeddings e WHERE e.content_hash = ${ctx.self}.raw_hash AND e.model = ? LIMIT 1)`;
  return { expr, params: [resolved.vec, resolved.model] };
}

function compileHasEdge(args: Node[], target: Target, ctx: AliasCtx): Compiled {
  const pred = argString(args, 0);
  const srcCol = target === "blocks" ? `e2.src_block = ${ctx.self}.block_id` : `e2.src_doc = ${ctx.doc}.doc_id`;
  if (args.length >= 2) {
    const dst = argString(args, 1);
    return {
      sql: `EXISTS (SELECT 1 FROM edges e2 WHERE ${srcCol} AND e2.predicate = ? AND e2.to_commit IS NULL AND e2.dst_node = ?)`,
      params: [pred, dst],
    };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM edges e2 WHERE ${srcCol} AND e2.predicate = ? AND e2.to_commit IS NULL)`,
    params: [pred],
  };
}

function compileMethod(node: { receiver: Node; name: string; args: Node[] }, target: Target, ctx: AliasCtx): Compiled {
  const { receiver, name, args } = node;
  if (receiver.kind !== "field") {
    throw new FilterInvalid(`method .${name}() must be called on a field`, "10 §3.2");
  }
  const f = fieldSql(receiver, target, ctx);
  switch (name) {
    case "contains":
      return { sql: `(${f.expr} LIKE '%' || ? || '%')`, params: [argString(args, 0)] };
    case "startsWith":
      return { sql: `(${f.expr} LIKE ? || '%')`, params: [argString(args, 0)] };
    case "endsWith":
      return { sql: `(${f.expr} LIKE '%' || ?)`, params: [argString(args, 0)] };
    case "matches":
      // RE2 not available in SQLite by default → mark for post-filter.
      throw new FilterInvalid("matches() requires post-filter (not yet wired); use contains/startsWith for indexed queries", "10 §8");
    default:
      throw new FilterInvalid(`unknown method .${name}()`, "10 §3.2");
  }
}

// under_kind(kind, name?) — blocks that are children/descendants of a block
// with the given type and optional key/text match. Uses ancestor_path to find
// the ancestor block, then checks its type and attrs.
function compileUnderKind(kind: string, name: string | undefined, ctx: AliasCtx): Compiled {
  const self = ctx.self;
  if (name) {
    return {
      sql: `EXISTS (
        SELECT 1 FROM blocks ab
        WHERE ab.doc_id = ${self}.doc_id
          AND ${self}.ancestor_path LIKE '%/' || ab.block_id || '/%'
          AND ab.type = ?
          AND (ab.text LIKE '%' || ? || '%' OR json_extract(ab.attrs, '$.key') = ?)
          AND ab.deleted_commit IS NULL
      )`,
      params: [kind, name, name],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM blocks ab
      WHERE ab.doc_id = ${self}.doc_id
        AND ${self}.ancestor_path LIKE '%/' || ab.block_id || '/%'
        AND ab.type = ?
        AND ab.deleted_commit IS NULL
    )`,
    params: [kind],
  };
}

// yaml_path("database.host") — blocks at a YAML key path. Builds nested
// EXISTS subqueries walking parent_block upward so each alias is in scope.
function compileYamlPath(path: string, ctx: AliasCtx): Compiled {
  const segments = path.split(".");
  if (segments.length === 0) throw new FilterInvalid("yaml_path() requires a non-empty key path");

  if (segments.length === 1) {
    return {
      sql: `(${ctx.self}.type LIKE 'yaml:%' AND json_extract(${ctx.self}.attrs, '$.key') = ? AND ${ctx.self}.deleted_commit IS NULL)`,
      params: [segments[0]!],
    };
  }

  return compileKeyPathChain(segments, "yaml", ctx);
}

// json_pointer("#/definitions/User") — blocks at a JSON Pointer path.
function compileJsonPointer(pointer: string, ctx: AliasCtx): Compiled {
  const normalized = pointer.replace(/^#?\/?/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) throw new FilterInvalid("json_pointer() requires a non-empty pointer");

  if (segments.length === 1) {
    return {
      sql: `(${ctx.self}.type LIKE 'json:%' AND json_extract(${ctx.self}.attrs, '$.key') = ? AND ${ctx.self}.deleted_commit IS NULL)`,
      params: [segments[0]!],
    };
  }

  return compileKeyPathChain(segments, "json", ctx);
}

// Build properly nested EXISTS for a multi-segment key path (yaml or json).
// segments = ["database", "host"]: the leaf block has key "host", its parent
// has key "database". Each ancestor check is a nested EXISTS so inner aliases
// can reference the enclosing scope.
function compileKeyPathChain(segments: string[], prefix: string, ctx: AliasCtx): Compiled {
  const self = ctx.self;
  const leaf = segments[segments.length - 1]!;
  const ancestors = segments.slice(0, -1);
  const params: unknown[] = [leaf];

  // Build from outermost ancestor (root) to the leaf's immediate parent.
  // The innermost (leaf) condition is on `self` itself; each ancestor wraps
  // its child in a nested EXISTS.
  let sql = `${self}.type LIKE '${prefix}:%' AND json_extract(${self}.attrs, '$.key') = ? AND ${self}.deleted_commit IS NULL`;
  let innerRef = self;

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const alias = `kp${i}`;
    sql = `EXISTS (
      SELECT 1 FROM blocks ${alias}
      WHERE ${alias}.block_id = ${innerRef}.parent_block
        AND ${alias}.type LIKE '${prefix}:%'
        AND json_extract(${alias}.attrs, '$.key') = ?
        AND ${alias}.deleted_commit IS NULL
    ) AND ${sql}`;
    params.unshift(ancestors[i]!);
    innerRef = alias;
  }

  return { sql: `(${sql})`, params };
}

export interface Compiled {
  sql: string; // boolean SQL expression over the target's row
  params: unknown[];
}
