// Semantics-faithful OQX-expression → SQLite translator (ADR-013 pushdown seam).
//
// This is the piece that lets the SQLite adapter push scalar work DOWN into the
// store instead of materializing rows and finishing them in the in-memory
// engine. It walks an `@omgbase/oqx` scalar `Expr` and returns a SQL fragment +
// bound params, or `null` when it cannot translate a construction faithfully —
// in which case the planner leaves that conjunct residual (correct, just slower).
//
// The cardinal rule is FIDELITY, not cleverness: the SQL a fragment emits MUST
// evaluate to the same result as `@omgbase/oqx`'s in-memory `semantics.ts` for
// every input, because the differential conformance suite runs each query BOTH
// ways and asserts equality. Three consequences drive the design:
//
//   • oqx-js string ops are CASE-SENSITIVE, but SQLite `LIKE` is case-insensitive
//     for ASCII. So `startsWith`/`contains`/`endsWith` translate to
//     `substr`/`instr`, NEVER `LIKE`. `$path.lower().startsWith("lab/")` becomes
//     `substr(lower(d.path), 1, length(?)) = ?` — the lowercasing is explicit and
//     the match is byte-exact, matching the in-memory path.
//   • oqx-js `==`/`!=` are absence-NORMALIZED (two absent values are equal;
//     `absent != v` is true). SQLite `=`/`<>` are not null-safe. So `==` → `IS`
//     and `!=` → `IS NOT` (SQLite's null-safe operators), which reproduce
//     `equals(a,b)` including the both-absent and negation cases, while still
//     honoring SQLite's typed comparison (`5 IS '5'` is false, matching strict
//     `5 === "5"`).
//   • SQLite has no boolean and no array/object scalars: JSON `true` reads as
//     `1`, `val_bool` is 1/0, and a list-valued or nested property has no
//     `card='scalar'` row (reads NULL). So a comparison is only pushed when the
//     KINDS of its two operands are provably compared the same way — see
//     `comparable` (the spec/surface §1 decline (a)) — and a name that is a relation, reach-through
//     or source handle is never read as a property (decline (b),
//     `NON_PROPERTY_NAMES`).
//
// Only forms that are faithful in a POSITIVE, AND-composed context are
// translated (that is the only context `partitionPushable` pushes into). `||`,
// `!`, `in`, `matches` (needs a regexp UDF), and bare content-property routing
// are deliberately declined here and left residual for now.

import type { Expr } from "@omgbase/oqx";

/** SQL row domain, matching the store's tables. */
export type Target = "docs" | "blocks" | "nodes" | "edges";

/** The SQL aliases the compiler assigned to the current scope's row (`self`) and
 * its owning document (`doc`). On the `docs` target the row IS the document, so
 * both are the same alias. */
export interface Aliases {
  self: string;
  doc: string;
}

export interface TranslateCtx extends Aliases {
  target: Target;
  /** Query bindings, used to resolve `${…}` interpolations (`{kind:"binding"}`)
   * to their values (mirrors `@omgbase/oqx`'s `constValue`). */
  params: readonly unknown[];
}

/** A SQL fragment plus its positional bind params, in statement order. */
export interface Frag {
  sql: string;
  params: unknown[];
}

/**
 * What a translated operand denotes, for the comparison matrix (spec/surface §1
 * decline (a)):
 *
 *   text  a string literal/binding, a text column or intrinsic, `.lower()`/`.upper()`
 *   int   an integer-typed intrinsic column (blocks `$ordinal`, `$depth`)
 *   num   a number literal/binding
 *   bool  a boolean literal/binding
 *   null  a null (or undefined) literal/binding
 *   json  a JSON read: an `attrs` path or a bare attribute name on blocks/nodes (json_extract)
 *   prop  a document property read: a bare key on docs or `doc.<k>` (the scalar-in-scope subquery)
 */
export type OperandKind = "text" | "int" | "num" | "bool" | "null" | "json" | "prop";

/** A value-position fragment with the kind of value it denotes. */
export interface Operand extends Frag {
  kind: OperandKind;
}

// ---- names that are never property reads ------------------------------------

/**
 * Per target, the bare identifiers (and `doc.<k>` keys, via the docs set) that
 * `context.ts` resolves to something other than a scalar field or property: the
 * self alias, the reach-through handles, the relations, the property source
 * handles and (blocks/nodes) the whole `attrs` object. A comparison naming one of
 * these is declined (spec/surface §1 decline (b)) — read as a property it would
 * be `NULL`, where in memory the value is a row, an array or an object.
 * `translate.test.ts` asserts this set against the store context.
 */
export const NON_PROPERTY_NAMES: Readonly<Record<Target, ReadonlySet<string>>> = {
  docs: new Set(["doc", "nodes", "blocks", "out", "in", "out_edges", "in_edges", "frontmatter", "inline"]),
  blocks: new Set(["block", "doc", "children", "nodes", "out_edges", "section", "attrs"]),
  nodes: new Set(["section", "doc", "block", "blocks", "subsections", "children", "attrs"]),
  edges: new Set(["doc"]),
};

// ---- intrinsics -------------------------------------------------------------

// A `$`-namespaced intrinsic → a param-free SQL scalar, per target, with its kind.
// Anything not mapped (e.g. docs `$body`, reconstructed; `$title`/`$tags`,
// computed) returns null → residual. `$updated_at`/`$dst_path`/`$dst_uri` are
// correlated subqueries.
function intrinsicSql(name: string, ctx: TranslateCtx): Operand | null {
  const { self, doc, target } = ctx;
  const text = (sql: string): Operand => ({ sql, params: [], kind: "text" });
  const int = (sql: string): Operand => ({ sql, params: [], kind: "int" });
  if (target === "docs") switch (name) {
    case "$id": return text(`${self}.doc_id`);
    case "$path": return text(`${doc}.path`);
    case "$content_hash": return text(`lower(hex(${self}.file_hash))`);
    case "$updated_at": return text(`(SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = ${self}.current_rev)`);
  }
  else if (target === "blocks") switch (name) {
    case "$id": return text(`${self}.block_id`);
    case "$doc": return text(`${self}.doc_id`);
    case "$path": return text(`${doc}.path`);
    case "$ordinal": return int(`${self}.ordinal`);
    case "$depth": return int(`${self}.depth`);
    case "$body": return text(`${self}.text`);
    case "$content_hash": return text(`lower(hex(${self}.raw_hash))`);
  }
  else if (target === "nodes") switch (name) {
    case "$id": case "$node_id": return text(`${self}.node_id`);
    case "$doc_id": return text(`${self}.doc_id`);
    case "$block_id": return text(`${self}.block_id`);
    case "$path": return text(`${doc}.path`);
  }
  else if (target === "edges") switch (name) {
    case "$id": return text(`${self}.edge_id`);
    case "$src": return text(`${self}.src_doc`);
    case "$dst": return text(`${self}.dst_node`);
    case "$src_block": return text(`${self}.src_block`);
    case "$via": return text(`${self}.via_node`);
    case "$from_commit": return text(`${self}.from_commit`);
    case "$path": return text(`${doc}.path`);
    case "$dst_path": return text(`(SELECT dd.path FROM docs dd WHERE dd.doc_id = ${self}.dst_node)`);
    case "$dst_uri": return text(`(SELECT xn.uri FROM external_nodes xn WHERE xn.node_id = ${self}.dst_node)`);
  }
  return null;
}

/** docs intrinsics whose BARE (non-$) form is a loud error in-memory (10 §2) — not
 * pushable, so the residual raises it (and the planner keeps the whole query
 * unplanned when one is residual: spec/surface §1 decline (c)). */
export const RESERVED_DOC_BASENAMES: ReadonlySet<string> = new Set(["id", "path", "updated_at", "content_hash", "body"]);
const SEG = /^[A-Za-z_][A-Za-z0-9_]*$/; // injection-safe inlined identifier

// A single-valued document property (the CEL scalar-in-scope rule): the scalar
// value only when the key has exactly one row in scope and it is card='scalar',
// else NULL — matching the store context's `docProp` for a scalar read.
function propScalar(docAlias: string, key: string): Operand | null {
  if (!SEG.test(key)) return null;
  return {
    sql: `(SELECT COALESCE(p.val_text, p.val_num, p.val_bool) FROM properties p
           WHERE p.doc_id = ${docAlias}.doc_id AND p.key = '${key}' AND p.card = 'scalar' AND p.deleted_commit IS NULL
             AND (SELECT COUNT(*) FROM properties p2 WHERE p2.doc_id = ${docAlias}.doc_id AND p2.key = '${key}' AND p2.deleted_commit IS NULL) = 1
           LIMIT 1)`,
    params: [],
    kind: "prop",
  };
}

// json_extract path from validated segments, or null if any segment is unsafe.
function jsonExtract(col: string, segs: string[]): Operand | null {
  if (segs.some((s) => !SEG.test(s))) return null;
  return { sql: `json_extract(${col}, '$.${segs.join(".")}')`, params: [], kind: "json" };
}

// A literal or binding value as a bound `?` with its kind. better-sqlite3 binds
// only number/string/bigint/buffer/null — booleans are coerced to 1/0 (how
// json_extract surfaces JSON booleans); anything else (an array binding, say) is
// not a scalar and declines.
function constOperand(v: unknown): Operand | null {
  switch (typeof v) {
    case "string": return { sql: "?", params: [v], kind: "text" };
    case "number": return { sql: "?", params: [v], kind: "num" };
    case "boolean": return { sql: "?", params: [v ? 1 : 0], kind: "bool" };
    case "undefined": return { sql: "?", params: [null], kind: "null" };
    default: return v === null ? { sql: "?", params: [null], kind: "null" } : null;
  }
}

// The dotted `attrs.a.b` / `doc.x` receiver chain as segments, or null if it is
// not a plain identifier navigation.
function memberSegments(e: Expr): string[] | null {
  if (e.kind === "ident") return [e.name];
  if (e.kind === "member") {
    const base = memberSegments(e.recv);
    return base ? [...base, e.name] : null;
  }
  return null;
}

// ---- value position ---------------------------------------------------------

/** Translate an expression used as a VALUE (comparison operand, method receiver,
 * function argument) to a SQL scalar with its operand kind. Returns null if not
 * faithfully translatable. */
export function translateOperand(e: Expr, ctx: TranslateCtx): Operand | null {
  const { self, doc, target } = ctx;
  const text = (sql: string): Operand => ({ sql, params: [], kind: "text" });
  switch (e.kind) {
    case "lit":
      return constOperand(e.value);
    case "binding":
      return constOperand(ctx.params[e.index]);
    case "ident": {
      if (e.name.startsWith("$")) return intrinsicSql(e.name, ctx);
      // A relation, reach-through, source handle or the whole attrs object is not a
      // scalar read (decline (b)).
      if (NON_PROPERTY_NAMES[target].has(e.name)) return null;
      // Bare field per target.
      if (target === "docs") {
        if (e.name === "format") return text(`${self}.format`); // a column, not a property
        if (RESERVED_DOC_BASENAMES.has(e.name)) return null; // residual raises the guard
        return propScalar(doc, e.name);
      }
      if (target === "blocks") {
        if (e.name === "type" || e.name === "text") return text(`${self}.${e.name}`);
        // Bare non-structural identifier flattens into attrs — same pushdown as
        // the `attrs.<k>` member form (json_extract), so `checked` == `attrs.checked`.
        return jsonExtract(`${self}.attrs`, [e.name]);
      }
      if (target === "nodes") {
        if (e.name === "kind" || e.name === "name" || e.name === "value") return text(`${self}.${e.name}`);
        // Bare non-structural identifier flattens into attrs (see blocks above).
        return jsonExtract(`${self}.attrs`, [e.name]);
      }
      if (target === "edges") {
        if (["predicate", "provenance", "dst_kind", "anchor", "src_field"].includes(e.name)) return text(`${self}.${e.name}`);
        return null;
      }
      return null;
    }
    case "member": {
      const segs = memberSegments(e);
      if (!segs || segs.length < 2) return null;
      const [head, ...rest] = segs as [string, ...string[]];
      // attrs.<path> → json_extract on the row's attrs (blocks/nodes).
      if (head === "attrs" && (target === "blocks" || target === "nodes")) {
        return jsonExtract(`${self}.attrs`, rest);
      }
      // doc.<x> reach-through — the owning doc (alias `doc`, which is `d`). On the
      // docs target `doc` is the row itself; either way it resolves against `doc`.
      if (head === "doc") {
        if (rest.length !== 1) return null;
        const k = rest[0]!;
        if (k === "$path") return text(`${doc}.path`);
        if (k === "format") return text(`${doc}.format`);
        if (k.startsWith("$")) return null;
        if (RESERVED_DOC_BASENAMES.has(k)) return null;
        if (NON_PROPERTY_NAMES.docs.has(k)) return null; // `doc.nodes`, `doc.frontmatter`, … (decline (b))
        return propScalar(doc, k);
      }
      // block.type / block.text reach-through from a node.
      if (head === "block" && target === "nodes" && rest.length === 1 && (rest[0] === "type" || rest[0] === "text")) {
        return text(`(SELECT bb.${rest[0]} FROM blocks bb WHERE bb.block_id = ${self}.block_id)`);
      }
      return null;
    }
    case "call": {
      // `.lower()` / `.upper()` are the value-position string methods; their
      // output is text whatever the receiver.
      if (e.recv !== null && e.args.length === 0 && (e.name === "lower" || e.name === "upper")) {
        const recv = translateOperand(e.recv, ctx);
        if (!recv) return null;
        return { sql: `${e.name}(${recv.sql})`, params: recv.params, kind: "text" };
      }
      return null;
    }
    default:
      return null;
  }
}

/** `translateOperand` without the kind — the plain fragment. */
export function translateValue(e: Expr, ctx: TranslateCtx): Frag | null {
  const o = translateOperand(e, ctx);
  return o ? { sql: o.sql, params: o.params } : null;
}

// ---- predicate position -----------------------------------------------------

const IS_OP: Record<string, string> = {
  "==": "IS",
  "!=": "IS NOT",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

/**
 * The comparison rule (spec/surface §1, decline (a)), stated positively: a
 * comparison is pushed only when its two operand kinds are provably compared
 * the same way by SQLite and by the in-memory `equals`/`compare`.
 *
 *   Equality (`==`, `!=`) pushes iff
 *     • one operand is text — SQLite's typed `IS` and strict `===` agree that a
 *       string equals nothing but an equal string (`5 IS '5'` is false);
 *     • or one operand is null and the other is NOT a property read — the same
 *       absence both ways, except that a list-valued or nested property has no
 *       scalar row (SQL NULL) where in memory the value is an array or object;
 *     • or both operands are numeric (int or num) — an exact integer comparison.
 *   Relational (`<`, `<=`, `>`, `>=`) pushes iff both operands are text or both
 *     are numeric.
 *   Every other pair declines: SQLite sees JSON `true` and `1`, `val_bool` and
 *     `val_num` alike (`checked == 1`, `$ordinal == checked`, `verified == 1`),
 *     orders every integer before every text (`$ordinal < "3"`, `level < "x"`,
 *     `$path > 5`), and two JSON or property reads carry no type at plan time
 *     (`attrs.a == attrs.b`, `era == stages`).
 *
 * The resulting grid (P = pushed, D = declined; symmetric) for `==` / `!=`:
 *
 *            text  int   num   bool  null  json  prop
 *   text      P     P     P     P     P     P     P
 *   int       P     P     P     D     P     D     D
 *   num       P     P     P     D     P     D     D
 *   bool      P     D     D     D     P     D     D
 *   null      P     P     P     P     P     P     D
 *   json      P     D     D     D     P     D     D
 *   prop      P     D     D     D     D     D     D
 *
 * and for `<` `<=` `>` `>=` only text×text, int×int, int×num, num×num push.
 */
export function comparable(op: string, a: OperandKind, b: OperandKind): boolean {
  const numeric = (k: OperandKind): boolean => k === "int" || k === "num";
  const bothNumeric = numeric(a) && numeric(b);
  if (op === "==" || op === "!=") {
    if (a === "text" || b === "text") return true;
    if ((a === "null" && b !== "prop") || (b === "null" && a !== "prop")) return true;
    return bothNumeric;
  }
  return (a === "text" && b === "text") || bothNumeric;
}

/** The complement of `comparable` — kept for readers of the earlier decline-list form. */
export function declinedPair(a: OperandKind, b: OperandKind, op: string = "=="): boolean {
  return !comparable(op, a, b);
}

/** Translate an expression used as a boolean PREDICATE to a SQL boolean, or null
 * if it cannot be pushed faithfully. Only positive, AND-safe forms are handled. */
export function translatePredicate(e: Expr, ctx: TranslateCtx): Frag | null {
  switch (e.kind) {
    case "logical":
      // Only `&&` composes faithfully in a positive context; `||` is declined
      // (its NULL/short-circuit interaction is not worth risking — leave residual).
      if (e.op !== "&&") return null;
      return join2(translatePredicate(e.left, ctx), translatePredicate(e.right, ctx), "AND");
    case "binary":
      return translateComparison(e, ctx);
    case "call":
      return translateStringPredicate(e, ctx);
    default:
      // `unary` (!), `in`, bare truthy idents, member reach-through: residual.
      return null;
  }
}

function translateComparison(e: Extract<Expr, { kind: "binary" }>, ctx: TranslateCtx): Frag | null {
  const op = IS_OP[e.op];
  if (!op) return null; // arithmetic operator in predicate position → residual
  const l = translateOperand(e.left, ctx);
  const r = translateOperand(e.right, ctx);
  if (!l || !r) return null;
  if (!comparable(e.op, l.kind, r.kind)) return null; // decline (a): the positive comparison rule
  // `==`/`!=` → null-safe IS / IS NOT (absence-normalized equality, faithful in
  // any context). Relational ops → plain SQL: a NULL operand yields NULL, which
  // is excluded in the positive AND context these fragments are pushed into,
  // matching `relate`'s absent-operand ⇒ false rule.
  return { sql: `(${l.sql} ${op} ${r.sql})`, params: [...l.params, ...r.params] };
}

// startsWith / contains / endsWith — CASE-SENSITIVE, via substr/instr (never
// LIKE). `matches` (regex) is declined until a `regexp` UDF is registered.
function translateStringPredicate(e: Extract<Expr, { kind: "call" }>, ctx: TranslateCtx): Frag | null {
  if (e.recv === null || e.args.length !== 1) return null;
  const recv = translateValue(e.recv, ctx);
  const arg = translateValue(e.args[0]!, ctx);
  if (!recv || !arg) return null;
  switch (e.name) {
    case "startsWith":
      // recv begins with arg ⇔ its first length(arg) chars equal arg.
      return {
        sql: `(substr(${recv.sql}, 1, length(${arg.sql})) = ${arg.sql})`,
        params: [...recv.params, ...arg.params, ...arg.params],
      };
    case "endsWith":
      // recv ends with arg ⇔ its last length(arg) chars equal arg. When arg is
      // longer than recv, substr clamps to the whole string (a shorter value),
      // so the equality is false — matching String.prototype.endsWith.
      return {
        sql: `(substr(${recv.sql}, -length(${arg.sql})) = ${arg.sql})`,
        params: [...recv.params, ...arg.params, ...arg.params],
      };
    case "contains":
      // substring test, case-sensitive.
      return {
        sql: `(instr(${recv.sql}, ${arg.sql}) > 0)`,
        params: [...recv.params, ...arg.params],
      };
    default:
      return null;
  }
}

// Combine two optional fragments with a boolean connective; null if either is
// untranslatable (the whole conjunct then stays residual).
function join2(a: Frag | null, b: Frag | null, connective: "AND" | "OR"): Frag | null {
  if (!a || !b) return null;
  return { sql: `(${a.sql} ${connective} ${b.sql})`, params: [...a.params, ...b.params] };
}
