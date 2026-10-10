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
//     `NON_PROPERTY_NAMES`). A bool or num literal against a JSON or property
//     read is a TYPED push (the 1.2 patch): the stored type is tested in SQL
//     before the value (`json_type(x) = 'true'`, `p.type = 'number' AND
//     p.val_num >= ?`) and the whole test is wrapped `(…) IS 1` / `IS NOT 1`,
//     so an absent or differently typed value compares as in memory —
//     unequal, never ordered. See `typedComparison`.
//
// Only forms that are faithful in a POSITIVE, AND-composed context are
// translated (that is the only context `partitionPushable` pushes into). `||`,
// `!`, `in`, `matches` (needs a regexp UDF), and bare content-property routing
// are deliberately declined here and left residual for now.

import type { Expr } from "@omgbase/oqx";
import { storagePath } from "../../core/paths.js";

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

/** A value-position fragment with the kind of value it denotes, plus what the
 * typed comparison (`typedComparison`) needs to re-shape it: the JSON column +
 * path behind a `json` read, the document alias + key behind a `prop` read, and
 * the constant behind a literal/binding (`value`; `bool`/`num`/`null`/text
 * constants only — a column operand has none). */
export interface Operand extends Frag {
  kind: OperandKind;
  json?: { col: string; path: string };
  prop?: { docAlias: string; key: string };
  value?: unknown;
  /** The storage-form path column behind a `$path` / `doc.$path` read
   * (`d.path`): the operand's SQL is the rooted `'/' || <col>`, and an
   * equality against a rooted text constant is re-shaped onto the bare,
   * indexed column (`pathEquality`). */
  pathCol?: string;
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
// correlated subqueries. `$path` and `$dst_path` are the REFERENCE form on the
// surface (spec/surface §1 "Paths", 2.0) — `'/' || <storage column>` in SQL —
// so every comparison, `startsWith`, `contains`, `lower()`… sees exactly the
// string the in-memory intrinsic yields; `pathColumn` keeps the bare indexed
// column at hand for the equality fast path.
/** The rooted path read over a storage path column. */
export function pathColumn(col: string): Operand {
  return { sql: `('/' || ${col})`, params: [], kind: "text", pathCol: col };
}
function intrinsicSql(name: string, ctx: TranslateCtx): Operand | null {
  const { self, doc, target } = ctx;
  const text = (sql: string): Operand => ({ sql, params: [], kind: "text" });
  const int = (sql: string): Operand => ({ sql, params: [], kind: "int" });
  if (target === "docs") switch (name) {
    case "$id": return text(`${self}.doc_id`);
    case "$path": return pathColumn(`${doc}.path`);
    case "$content_hash": return text(`lower(hex(${self}.file_hash))`);
    case "$updated_at": return text(`(SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = ${self}.current_rev)`);
  }
  else if (target === "blocks") switch (name) {
    case "$id": return text(`${self}.block_id`);
    case "$doc": return text(`${self}.doc_id`);
    case "$path": return pathColumn(`${doc}.path`);
    case "$ordinal": return int(`${self}.ordinal`);
    case "$depth": return int(`${self}.depth`);
    case "$body": return text(`${self}.text`);
    case "$content_hash": return text(`lower(hex(${self}.raw_hash))`);
  }
  else if (target === "nodes") switch (name) {
    case "$id": case "$node_id": return text(`${self}.node_id`);
    case "$doc_id": return text(`${self}.doc_id`);
    case "$block_id": return text(`${self}.block_id`);
    case "$path": return pathColumn(`${doc}.path`);
  }
  else if (target === "edges") switch (name) {
    case "$id": return text(`${self}.edge_id`);
    case "$src": return text(`${self}.src_doc`);
    case "$dst": return text(`${self}.dst_node`);
    case "$src_block": return text(`${self}.src_block`);
    case "$via": return text(`${self}.via_node`);
    case "$from_commit": return text(`${self}.from_commit`);
    case "$path": return pathColumn(`${doc}.path`);
    case "$dst_path": return text(`(SELECT '/' || dd.path FROM docs dd WHERE dd.doc_id = ${self}.dst_node)`);
    case "$dst_uri": return text(`(SELECT xn.uri FROM external_nodes xn WHERE xn.node_id = ${self}.dst_node)`);
  }
  return null;
}

/** docs intrinsics whose BARE (non-$) form is a loud error in-memory (10 §2) — not
 * pushable, so the residual raises it (and the planner keeps the whole query
 * unplanned when one is residual: spec/surface §1 decline (c)). */
export const RESERVED_DOC_BASENAMES: ReadonlySet<string> = new Set(["id", "path", "updated_at", "content_hash", "body"]);
const SEG = /^[A-Za-z_][A-Za-z0-9_]*$/; // injection-safe inlined identifier

// The single-scalar-row scope of a document property (the CEL scalar-in-scope
// rule): the row for `key` on the document only when the key has exactly one
// row in scope and it is card='scalar' — a list-valued or nested key has none.
// `select` is the projected expression over the alias `p`.
function propSubquery(docAlias: string, key: string, select: string): string {
  return `(SELECT ${select} FROM properties p
           WHERE p.doc_id = ${docAlias}.doc_id AND p.key = '${key}' AND p.card = 'scalar' AND p.deleted_commit IS NULL
             AND (SELECT COUNT(*) FROM properties p2 WHERE p2.doc_id = ${docAlias}.doc_id AND p2.key = '${key}' AND p2.deleted_commit IS NULL) = 1
           LIMIT 1)`;
}

// A single-valued document property: the scalar value of its one row in scope,
// else NULL — matching the store context's `docProp` for a scalar read.
function propScalar(docAlias: string, key: string): Operand | null {
  if (!SEG.test(key)) return null;
  return {
    sql: propSubquery(docAlias, key, "COALESCE(p.val_text, p.val_num, p.val_bool)"),
    params: [],
    kind: "prop",
    prop: { docAlias, key },
  };
}

// json_extract path from validated segments, or null if any segment is unsafe.
function jsonExtract(col: string, segs: string[]): Operand | null {
  if (segs.some((s) => !SEG.test(s))) return null;
  const path = `'$.${segs.join(".")}'`;
  return { sql: `json_extract(${col}, ${path})`, params: [], kind: "json", json: { col, path } };
}

// A literal or binding value as a bound `?` with its kind. better-sqlite3 binds
// only number/string/bigint/buffer/null — booleans are coerced to 1/0 (how
// json_extract and `val_bool` surface booleans); anything else (an array
// binding, say) is not a scalar and declines.
function constOperand(v: unknown): Operand | null {
  switch (typeof v) {
    case "string": return { sql: "?", params: [v], kind: "text", value: v };
    case "number": return { sql: "?", params: [v], kind: "num", value: v };
    case "boolean": return { sql: "?", params: [v ? 1 : 0], kind: "bool", value: v };
    case "undefined": return { sql: "?", params: [null], kind: "null", value: null };
    default: return v === null ? { sql: "?", params: [null], kind: "null", value: null } : null;
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
        if (k === "$path") return pathColumn(`${doc}.path`);
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
 *   Equality (`==`, `!=`) pushes PLAINLY (`IS` / `IS NOT`) iff
 *     • one operand is text — SQLite's typed `IS` and strict `===` agree that a
 *       string equals nothing but an equal string (`5 IS '5'` is false);
 *     • or one operand is null and the other is NOT a property read — the same
 *       absence both ways, except that a list-valued or nested property has no
 *       scalar row (SQL NULL) where in memory the value is an array or object;
 *     • or both operands are numeric (int or num) — an exact integer comparison.
 *   Relational (`<`, `<=`, `>`, `>=`) pushes plainly iff both operands are text
 *     or both are numeric.
 *   TYPED pushes (the 1.2 patch, `typedComparison`): a bool literal/binding
 *     against a json or prop read (`==`, `!=` only) and a num literal/binding
 *     against a json or prop read (every op) push with the stored type tested
 *     first — `json_type(x) = 'true'`, `json_type(x) IN ('integer','real') AND
 *     json_extract(x) <op> ?`, `p.type = 'bool' AND p.val_bool = ?`, `p.type =
 *     'number' AND p.val_num <op> ?` — wrapped `(…) IS 1` (or `IS NOT 1` for
 *     `!=`), so an absent or differently typed value is unequal and never
 *     ordered, exactly as in memory.
 *   Every other pair declines: SQLite sees JSON `true` and `1`, `val_bool` and
 *     `val_num` alike (`$ordinal == checked`, `true == 1`), orders every
 *     integer before every text (`$ordinal < "3"`, `level < "x"`, `$path > 5`),
 *     and two JSON or property reads carry no type at plan time
 *     (`attrs.a == attrs.b`, `era == stages`).
 *
 * The resulting grid (P = pushed plainly, T = typed push, D = declined;
 * symmetric) for `==` / `!=`:
 *
 *            text  int   num   bool  null  json  prop
 *   text      P     P     P     P     P     P     P
 *   int       P     P     P     D     P     D     D
 *   num       P     P     P     D     P     T     T
 *   bool      P     D     D     D     P     T     T
 *   null      P     P     P     P     P     P     D
 *   json      P     D     T     T     P     D     D
 *   prop      P     D     T     T     D     D     D
 *
 * and for `<` `<=` `>` `>=` text×text, int×int, int×num, num×num push plainly
 * and num×json, num×prop push typed.
 */
export function comparable(op: string, a: OperandKind, b: OperandKind): boolean {
  return plainComparable(op, a, b) || typedPair(op, a, b) !== null;
}

// The plain cells of the grid (P): the two operands compare the same way as-is.
function plainComparable(op: string, a: OperandKind, b: OperandKind): boolean {
  const numeric = (k: OperandKind): boolean => k === "int" || k === "num";
  const bothNumeric = numeric(a) && numeric(b);
  if (op === "==" || op === "!=") {
    if (a === "text" || b === "text") return true;
    if ((a === "null" && b !== "prop") || (b === "null" && a !== "prop")) return true;
    return bothNumeric;
  }
  return (a === "text" && b === "text") || bothNumeric;
}

// The typed cells of the grid (T): which side is the constant (`"left"` /
// `"right"`), or null when the pair is not a typed push. A bool constant pushes
// typed only under `==` / `!=` (booleans never order); a num constant under any op.
function typedPair(op: string, a: OperandKind, b: OperandKind): "left" | "right" | null {
  const read = (k: OperandKind): boolean => k === "json" || k === "prop";
  const constant = (k: OperandKind): boolean => k === "num" || (k === "bool" && (op === "==" || op === "!="));
  if (constant(a) && read(b)) return "left";
  if (constant(b) && read(a)) return "right";
  return null;
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
  const fast = pathEquality(e.op, l, r);
  if (fast) return fast;
  if (plainComparable(e.op, l.kind, r.kind)) {
    // `==`/`!=` → null-safe IS / IS NOT (absence-normalized equality, faithful in
    // any context). Relational ops → plain SQL: a NULL operand yields NULL, which
    // is excluded in the positive AND context these fragments are pushed into,
    // matching `relate`'s absent-operand ⇒ false rule.
    return { sql: `(${l.sql} ${op} ${r.sql})`, params: [...l.params, ...r.params] };
  }
  const side = typedPair(e.op, l.kind, r.kind);
  if (side === null) return null; // decline (a): the positive comparison rule
  // Normalize to <read> <op> <constant>, flipping a relational op when the
  // constant is on the left (`800 < era` ⇔ `era > 800`).
  return side === "right" ? typedComparison(e.op, l, r) : typedComparison(FLIP[e.op] ?? e.op, r, l);
}

const FLIP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

/**
 * The path equality fast path: `$path == "/a.md"` (or `!=`, either side) against
 * a rooted text constant is `d.path IS ?` with the constant's storage form, so
 * the `(repo_id, path)` index serves it; `'/' || d.path IS ?` — what the general
 * form would emit — is the same predicate without the index. Only a constant
 * that IS rooted qualifies (run.ts roots every literal compared with a path
 * read, so that is every literal); a bare binding stays on the general form,
 * where `'/' || d.path` can never equal it — exactly the in-memory answer.
 */
function pathEquality(op: string, l: Operand, r: Operand): Frag | null {
  if (op !== "==" && op !== "!=") return null;
  const [col, konst] = l.pathCol ? [l, r] : r.pathCol ? [r, l] : [null, null];
  if (!col || !konst || konst.kind !== "text" || typeof konst.value !== "string" || !konst.value.startsWith("/")) return null;
  return { sql: `(${col.pathCol} ${IS_OP[op]} ?)`, params: [storagePath(konst.value)] };
}

/**
 * The typed push (spec/surface §1, 1.2 patch): `read <op> constant` where the
 * read is a JSON or property read and the constant a bool or num literal/binding.
 * The stored type is tested before the value, and the whole test is wrapped
 * `(…) IS 1` for `==` and the relational ops, `(…) IS NOT 1` for `!=` — so a
 * NULL (absent path, no scalar row) or a `0` (other type, unequal value) reads
 * as "not equal" / "not ordered", which is the in-memory answer: `checked == 1`
 * finds nothing, `checked != 1` everything, `level >= 2` only numeric levels.
 *
 *   json × bool   (json_type(col, path) = 'true'|'false') IS [NOT] 1        no bind: the type string IS the value
 *   json × num    (json_type(col, path) IN ('integer','real') AND json_extract(col, path) <op> ?) IS [NOT] 1
 *   prop × bool   (SELECT p.type = 'bool' AND p.val_bool = ? FROM properties p WHERE <scope> LIMIT 1) IS [NOT] 1   ? = 1|0
 *   prop × num    (SELECT p.type = 'number' AND p.val_num <op> ? FROM properties p WHERE <scope> LIMIT 1) IS [NOT] 1
 *
 * where <op> is `=` for both `==` and `!=` (the `!=` case negates the equality
 * by its `IS NOT 1` wrap) and the relational operator itself otherwise.
 *
 * `<scope>` is `propSubquery`'s single-scalar-row condition, so a list-valued or
 * nested key yields NULL → unequal/unordered, as in memory.
 */
function typedComparison(op: string, read: Operand, constant: Operand): Frag | null {
  // `!=` is `!equals`: the EQUALITY test, wrapped IS NOT 1 (never `<>` inside —
  // `(type AND val <> ?) IS NOT 1` would drop every row of the right type with a
  // different value, the differential caught it).
  const wrap = op === "!=" ? "IS NOT 1" : "IS 1";
  const cmp = op === "==" || op === "!=" ? "=" : op;
  if (read.json) {
    const { col, path } = read.json;
    if (constant.kind === "bool") {
      return { sql: `((json_type(${col}, ${path}) = '${constant.value ? "true" : "false"}') ${wrap})`, params: [] };
    }
    return {
      sql: `((json_type(${col}, ${path}) IN ('integer', 'real') AND json_extract(${col}, ${path}) ${cmp} ?) ${wrap})`,
      params: [...constant.params],
    };
  }
  if (read.prop) {
    const { docAlias, key } = read.prop;
    const test = constant.kind === "bool" ? `p.type = 'bool' AND p.val_bool = ?` : `p.type = 'number' AND p.val_num ${cmp} ?`;
    return { sql: `(${propSubquery(docAlias, key, test)} ${wrap})`, params: [...constant.params] };
  }
  return null;
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
