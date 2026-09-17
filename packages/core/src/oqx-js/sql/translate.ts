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
// ways and asserts equality. Two consequences drive the design:
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

// ---- intrinsics -------------------------------------------------------------

// A `$`-namespaced intrinsic → a param-free SQL scalar, per target. Anything not
// mapped (e.g. docs `$body`, reconstructed; `$title`/`$tags`, computed) returns
// null → residual. `$updated_at`/`$dst_path`/`$dst_uri` are correlated subqueries.
function intrinsicSql(name: string, ctx: TranslateCtx): string | null {
  const { self, doc, target } = ctx;
  if (target === "docs") switch (name) {
    case "$id": return `${self}.doc_id`;
    case "$path": return `${doc}.path`;
    case "$repo": return `${self}.repo_id`;
    case "$content_hash": return `lower(hex(${self}.file_hash))`;
    case "$updated_at": return `(SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = ${self}.current_rev)`;
  }
  else if (target === "blocks") switch (name) {
    case "$id": return `${self}.block_id`;
    case "$doc": return `${self}.doc_id`;
    case "$path": return `${doc}.path`;
    case "$ordinal": return `${self}.ordinal`;
    case "$depth": return `${self}.depth`;
    case "$body": return `${self}.text`;
    case "$content_hash": return `lower(hex(${self}.raw_hash))`;
  }
  else if (target === "nodes") switch (name) {
    case "$id": case "$node_id": return `${self}.node_id`;
    case "$doc_id": return `${self}.doc_id`;
    case "$block_id": return `${self}.block_id`;
    case "$path": return `${doc}.path`;
  }
  else if (target === "edges") switch (name) {
    case "$id": return `${self}.edge_id`;
    case "$src": return `${self}.src_doc`;
    case "$dst": return `${self}.dst_node`;
    case "$src_block": return `${self}.src_block`;
    case "$via": return `${self}.via_node`;
    case "$from_commit": return `${self}.from_commit`;
    case "$path": return `${doc}.path`;
    case "$dst_path": return `(SELECT dd.path FROM docs dd WHERE dd.doc_id = ${self}.dst_node)`;
    case "$dst_uri": return `(SELECT xn.uri FROM external_nodes xn WHERE xn.node_id = ${self}.dst_node)`;
  }
  return null;
}

// docs intrinsics whose BARE (non-$) form is a loud error in-memory (10 §2) — not
// pushable, so the residual raises it.
const RESERVED_DOC_BASENAMES = new Set(["id", "path", "repo", "updated_at", "content_hash", "body"]);
const SEG = /^[A-Za-z_][A-Za-z0-9_]*$/; // injection-safe inlined identifier

// A single-valued document property (the CEL scalar-in-scope rule): the scalar
// value only when the key has exactly one row in scope and it is card='scalar',
// else NULL — matching the store context's `docProp` for a scalar read.
function propScalar(docAlias: string, key: string): string | null {
  if (!SEG.test(key)) return null;
  return `(SELECT COALESCE(p.val_text, p.val_num, p.val_bool) FROM properties p
           WHERE p.doc_id = ${docAlias}.doc_id AND p.key = '${key}' AND p.card = 'scalar' AND p.deleted_commit IS NULL
             AND (SELECT COUNT(*) FROM properties p2 WHERE p2.doc_id = ${docAlias}.doc_id AND p2.key = '${key}' AND p2.deleted_commit IS NULL) = 1
           LIMIT 1)`;
}

// json_extract path from validated segments, or null if any segment is unsafe.
function jsonExtract(col: string, segs: string[]): string | null {
  if (segs.some((s) => !SEG.test(s))) return null;
  return `json_extract(${col}, '$.${segs.join(".")}')`;
}

// better-sqlite3 binds only number/string/bigint/buffer/null — coerce booleans
// to 1/0 (matching how json_extract surfaces JSON booleans, so `attrs.b == true`
// compares against `1`). Non-bindable values are left as-is (they only reach a
// bound `?` for lit/binding operands, which are scalars in practice).
function bindable(v: unknown): unknown {
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
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
 * function argument) to a SQL scalar. Returns null if not faithfully translatable. */
export function translateValue(e: Expr, ctx: TranslateCtx): Frag | null {
  const { self, doc, target } = ctx;
  switch (e.kind) {
    case "lit":
      return { sql: "?", params: [bindable(e.value)] };
    case "binding":
      return { sql: "?", params: [bindable(ctx.params[e.index])] };
    case "ident": {
      if (e.name.startsWith("$")) {
        const sql = intrinsicSql(e.name, ctx);
        return sql ? { sql, params: [] } : null;
      }
      // Bare field per target.
      if (target === "docs") {
        if (e.name === "format") return { sql: `${self}.format`, params: [] }; // a column, not a property
        if (RESERVED_DOC_BASENAMES.has(e.name)) return null; // residual raises the guard
        const sql = propScalar(doc, e.name);
        return sql ? { sql, params: [] } : null;
      }
      if (target === "blocks") {
        if (e.name === "type" || e.name === "text") return { sql: `${self}.${e.name}`, params: [] };
        return null;
      }
      if (target === "nodes") {
        if (e.name === "kind" || e.name === "name" || e.name === "value") return { sql: `${self}.${e.name}`, params: [] };
        return null;
      }
      if (target === "edges") {
        if (["predicate", "provenance", "dst_kind", "anchor", "src_field"].includes(e.name)) return { sql: `${self}.${e.name}`, params: [] };
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
        const sql = jsonExtract(`${self}.attrs`, rest);
        return sql ? { sql, params: [] } : null;
      }
      // doc.<x> reach-through — the owning doc (alias `doc`, which is `d`). On the
      // docs target `doc` is the row itself; either way it resolves against `doc`.
      if (head === "doc") {
        if (rest.length !== 1) return null;
        const k = rest[0]!;
        if (k === "$path") return { sql: `${doc}.path`, params: [] };
        if (k === "format") return { sql: `${doc}.format`, params: [] };
        if (k.startsWith("$")) return null;
        if (RESERVED_DOC_BASENAMES.has(k)) return null;
        const sql = propScalar(doc, k);
        return sql ? { sql, params: [] } : null;
      }
      // block.type / block.text reach-through from a node.
      if (head === "block" && target === "nodes" && rest.length === 1 && (rest[0] === "type" || rest[0] === "text")) {
        return { sql: `(SELECT bb.${rest[0]} FROM blocks bb WHERE bb.block_id = ${self}.block_id)`, params: [] };
      }
      return null;
    }
    case "call": {
      // `.lower()` / `.upper()` are the value-position string methods.
      if (e.recv !== null && e.args.length === 0 && (e.name === "lower" || e.name === "upper")) {
        const recv = translateValue(e.recv, ctx);
        if (!recv) return null;
        return { sql: `${e.name}(${recv.sql})`, params: recv.params };
      }
      return null;
    }
    default:
      return null;
  }
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
  const l = translateValue(e.left, ctx);
  const r = translateValue(e.right, ctx);
  if (!l || !r) return null;
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
