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
//     `substr`/`instr`, NEVER `LIKE`. `path.lower().startsWith("lab/")` becomes
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
//     or WHOLE source handle is never read as a property (decline (b),
//     `NON_PROPERTY_NAMES`; a key read THROUGH a handle — `_data.k`,
//     `_frontmatter.k` — is a property read, `handleRead`). A bool or num literal against a JSON or property
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
import { TARGETS } from "../root-row.js";

/** SQL row domain, matching the store's tables. */
export type Target = "docs" | "blocks" | "nodes" | "links";

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
 *   int   an integer-typed column (blocks `ordinal`, `depth`)
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
  /** A property read: `docId` is the SQL expression naming the document whose
   * rows are read (`d.doc_id` for the row's own document, `e.dst_node` for a
   * link's destination). */
  prop?: { docId: string; key: string; source?: string };
  value?: unknown;
  /** The storage-form path column behind a `path` / `doc.path` read
   * (`d.path`): the operand's SQL is the rooted `'/' || <col>`, and an
   * equality against a rooted text constant is re-shaped onto the bare,
   * indexed column (`pathEquality`). */
  pathCol?: string;
}

// ---- names that are never property reads ------------------------------------

/**
 * Per target, the engine names (and `_doc.<k>` keys, via the docs set) that
 * `context.ts` resolves to something other than a scalar field or property: the
 * reach-through handles, the relations, the property source handles and
 * (blocks/nodes) the whole `_attrs` object. A comparison naming one of these is
 * declined (spec/surface §1 decline (b)) — read as a property it would be
 * `NULL`, where in memory the value is a row, an array or an object.
 * `translate.test.ts` asserts this set against the store context.
 */
export const NON_PROPERTY_NAMES: Readonly<Record<Target, ReadonlySet<string>>> = {
  docs: new Set(["_nodes", "_blocks", "_out_links", "_in_links", "_revisions", "_data", "_frontmatter", "_inline"]),
  blocks: new Set(["_doc", "_children", "_nodes", "_out_links", "_section", "_attrs"]),
  nodes: new Set(["_doc", "_block", "_blocks", "_subsections", "_children", "_attrs"]),
  links: new Set(["_doc", "_dst", "_block"]),
};

// ---- engine attributes ------------------------------------------------------

// The engine attributes (spec/surface §1.2, 5.0: `_`-prefixed, snake_case —
// `_id`, `_path`, `_raw`, `_hash`, `_updated_at`, `_created_at` on docs and
// blocks, `_title`/`_tags` on docs, `_id`/`_path` on nodes and edges) → a
// param-free SQL scalar, per target, with its kind. The structural columns and
// foreign keys are translated in `translateOperand`. Anything not mapped
// (`_raw`, reconstructed or a blob; `_title`, computed; `_tags`, the union of
// the authored list and the computed hashtags) returns null → residual, and the
// caller must NOT fall through to a property read (an engine name is never the
// author's). `_updated_at` and `_created_at` (4.10) are correlated subqueries
// over the document's revisions (`head` / `seq = 1`); a block's are
// residual, as before. `_path` (and the edge field `_dst_path`) is the REFERENCE
// form on the surface (spec/surface §1 "Paths", 2.0) — `'/' || <storage
// column>` in SQL — so every comparison, `startsWith`, `contains`, `lower()`…
// sees exactly the string the in-memory attribute yields; `pathColumn` keeps
// the bare indexed column at hand for the equality fast path.
/** The rooted path read over a storage path column. */
export function pathColumn(col: string): Operand {
  return { sql: `('/' || ${col})`, params: [], kind: "text", pathCol: col };
}
/** The identity/bytes/time attributes per kind — the names `attributeSql` owns
 * (the structural columns are handled per target in `translateOperand`). */
export const ROW_ATTRIBUTES: Readonly<Record<Target, ReadonlySet<string>>> = {
  docs: new Set(["_id", "_path", "_raw", "_hash", "_updated_at", "_created_at", "_title", "_tags"]),
  blocks: new Set(["_id", "_path", "_raw", "_hash", "_updated_at", "_created_at"]),
  nodes: new Set(["_id", "_path"]),
  links: new Set(["_id", "_path"]),
};
function attributeSql(name: string, ctx: TranslateCtx): Operand | null {
  const { self, doc, target } = ctx;
  const text = (sql: string): Operand => ({ sql, params: [], kind: "text" });
  if (target === "docs") switch (name) {
    case "_id": return text(`${self}.doc_id`);
    case "_path": return pathColumn(`${doc}.path`);
    case "_hash": return text(`lower(hex(${self}.file_hash))`);
    // Plain column reads since store 17.0 (M2, D6; spec/surface §1.2) — through
    // 16.x two correlated subqueries over `revisions × commits`.
    case "_updated_at": return text(`${self}.updated_at`);
    case "_created_at": return text(`${self}.created_at`);
  }
  else if (target === "blocks") switch (name) {
    case "_id": return text(`${self}.block_id`);
    case "_path": return pathColumn(`${doc}.path`);
    case "_hash": return text(`lower(hex(${self}.raw_hash))`);
    // 17.0: pushable at last — the block's own columns (through 16.x the names
    // were declared in ROW_ATTRIBUTES with no SQL case, so they stayed residual).
    case "_updated_at": return text(`${self}.updated_at`);
    case "_created_at": return text(`${self}.created_at`);
  }
  else if (target === "nodes") switch (name) {
    case "_id": return text(`${self}.node_id`);
    case "_path": return pathColumn(`${doc}.path`);
  }
  else if (target === "links") switch (name) {
    case "_id": return text(`${self}.edge_id`);
    case "_path": return pathColumn(`${doc}.path`);
  }
  return null;
}

/** The links target's plain fields → the store's columns (spec/surface §1.2:
 * a foreign key is named for what it is, `_`-prefixed since 5.0). `_dst_path`
 * and `_uri` are correlated subqueries; `_dst_path` is the reference form. */
function edgeField(name: string, self: string): Operand | null {
  const text = (sql: string): Operand => ({ sql, params: [], kind: "text" });
  switch (name) {
    case "_doc_id": return text(`${self}.src_doc`);
    case "_block_id": return text(`${self}.src_block`);
    case "_via_id": return text(`${self}.via_node`);
    case "_dst_id": return text(`${self}.dst_node`);
    case "_dst_path": return text(`(SELECT '/' || dd.path FROM docs dd WHERE dd.doc_id = ${self}.dst_node)`);
    case "_uri": return text(`(SELECT xn.uri FROM external_nodes xn WHERE xn.node_id = ${self}.dst_node)`);
    case "_field": return text(`${self}.src_field`);
    case "_predicate": case "_provenance": case "_dst_kind": case "_anchor": return text(`${self}.${name.slice(1)}`);
    default: return null;
  }
}

const SEG = /^[A-Za-z_][A-Za-z0-9_]*$/; // injection-safe inlined identifier

// The single-scalar-row scope of a document property (the CEL scalar-in-scope
// rule): the row for `key` on the document only when the key has exactly one
// row in scope and it is card='scalar' — a list-valued or nested key has none.
// `select` is the projected expression over the alias `p`. `source` narrows
// the scope to one authored source — the read `_frontmatter.<k>` / `_inline.<k>`
// performs (spec/surface §1.2; the in-memory `docProp(docId, key, source)`):
// both the row and the count are of that source's rows only. The merged
// `_data.<k>` read is the bare read, so it passes no source. `docId` is the SQL
// expression naming the document: the scan's `d.doc_id`, or a link's
// `e.dst_node` for a `_dst.<k>` read (the destination's rows by its id — a
// non-document or phantom destination has none, so the read is NULL exactly
// where `_dst` is absent in memory).
function propSubquery(docId: string, key: string, select: string, source?: string): string {
  const src = source ? ` AND p.source = '${source}'` : "";
  const src2 = source ? ` AND p2.source = '${source}'` : "";
  return `(SELECT ${select} FROM properties p
           WHERE p.doc_id = ${docId} AND p.key = '${key}' AND p.card = 'scalar' AND p.deleted_commit IS NULL${src}
             AND (SELECT COUNT(*) FROM properties p2 WHERE p2.doc_id = ${docId} AND p2.key = '${key}' AND p2.deleted_commit IS NULL${src2}) = 1
           LIMIT 1)`;
}

// A single-valued document property: the scalar value of its one row in scope,
// else NULL — matching the store context's `docProp` for a scalar read.
// `docAlias` is the document's table alias; `propScalarOf` takes the id
// expression itself.
function propScalar(docAlias: string, key: string, source?: string): Operand | null {
  return propScalarOf(`${docAlias}.doc_id`, key, source);
}
function propScalarOf(docId: string, key: string, source?: string): Operand | null {
  if (!SEG.test(key)) return null;
  return {
    sql: propSubquery(docId, key, "COALESCE(p.val_text, p.val_num, p.val_bool)", source),
    params: [],
    kind: "prop",
    prop: source ? { docId, key, source } : { docId, key },
  };
}

// A key read through a source handle (spec/surface §1.2): `_data.<k>` is the
// merged authored read — exactly the bare property `<k>`; `_frontmatter.<k>` /
// `_inline.<k>` the same read scoped to one source. Pushed since 3.0 (batch 3;
// before, every handle member was residual). A whole-handle reference
// (`_frontmatter == null`) and `entries(<handle>)` still decline.
const SOURCE_HANDLES: Readonly<Record<string, string | undefined>> = { _data: undefined, _frontmatter: "frontmatter", _inline: "inline" };
function handleRead(docAlias: string, handle: string, key: string): Operand | null {
  return handleReadOf(`${docAlias}.doc_id`, handle, key);
}
function handleReadOf(docId: string, handle: string, key: string): Operand | null {
  if (!(handle in SOURCE_HANDLES)) return null;
  return propScalarOf(docId, key, SOURCE_HANDLES[handle]);
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

// The dotted `_attrs.a.b` / `_doc.x` receiver chain as segments, or null if it
// is not a plain identifier navigation.
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
      // An OQX `$` name (`$it`, `$key`, the follow intrinsics) is the language's,
      // never a column; omgbase adds no `$` names (spec/surface §1.2).
      if (e.name.startsWith("$")) return null;
      // An engine name (§1.2, 5.0: `_`-prefixed) is translated or declined
      // (`_raw`, `_title`, `_tags`; a relation, a reach-through, a source handle,
      // the whole `_attrs` object — decline (b)); never read as a property or
      // an attr. A `_x` that is no engine name of the kind is refused before
      // planning (names.ts), so it declines here. A bare target name is a loud
      // error (root-row.ts), never a property.
      if (e.name.startsWith("_")) {
        if (ROW_ATTRIBUTES[target].has(e.name)) return attributeSql(e.name, ctx);
        if (NON_PROPERTY_NAMES[target].has(e.name)) return null;
        if (target === "docs") return e.name === "_format" ? text(`${self}.format`) : null; // a column
        if (target === "blocks") {
          if (e.name === "_doc_id" || e.name === "_type" || e.name === "_text") return text(`${self}.${e.name.slice(1)}`);
          if (e.name === "_ordinal" || e.name === "_depth") return { sql: `${self}.${e.name.slice(1)}`, params: [], kind: "int" };
          return null;
        }
        if (target === "nodes") return ["_doc_id", "_block_id", "_kind", "_name", "_value"].includes(e.name) ? text(`${self}.${e.name.slice(1)}`) : null;
        if (target === "links") return edgeField(e.name, self);
        return null;
      }
      if (TARGETS.has(e.name)) return null;
      // A bare name is the author's (§1.2): a document property, or on blocks
      // and nodes an `attrs` key — the same pushdown as the `_attrs.<k>` member
      // form (json_extract), so `checked` == `_attrs.checked`. A link row
      // carries no authored data (names.ts refuses the read).
      if (target === "docs") return propScalar(doc, e.name);
      if (target === "blocks" || target === "nodes") return jsonExtract(`${self}.attrs`, [e.name]);
      return null;
    }
    case "member": {
      const segs = memberSegments(e);
      if (!segs || segs.length < 2) return null;
      const [head, ...rest] = segs as [string, ...string[]];
      // _attrs.<path> → json_extract on the row's attrs (blocks/nodes).
      if (head === "_attrs" && (target === "blocks" || target === "nodes")) {
        return jsonExtract(`${self}.attrs`, rest);
      }
      // <handle>.<k> on docs — `_data.layer`, `_frontmatter.layer`,
      // `_inline.element` — and `_doc.<handle>.<k>` through the owning document
      // on the other targets: a property read, scoped to the handle's source.
      if (target === "docs" && head in SOURCE_HANDLES && rest.length === 1) return handleRead(doc, head, rest[0]!);
      if (head === "_doc" && target !== "docs" && rest.length === 2 && rest[0]! in SOURCE_HANDLES) return handleRead(doc, rest[0]!, rest[1]!);
      // _doc.<x> reach-through — the owning doc (alias `doc`, which is `d`) on
      // blocks, nodes and links (a document has no `_doc` since 5.0: `$it` is
      // the self). FOREIGN-KEY ELIMINATION (spec/surface §1, 3.0): `_doc._id` is
      // the row's own FK column (`b.doc_id`, `n.doc_id`, `e.src_doc`) and
      // `_doc._path` / `_doc._hash` / `_doc._updated_at` the scan's
      // already-joined document columns — no extra join, the same SQL as the
      // bare `_doc_id`.
      if (head === "_doc" && target !== "docs") {
        if (rest.length !== 1) return null;
        const k = rest[0]!;
        if (k === "_id") return text(target === "links" ? `${self}.src_doc` : `${self}.doc_id`);
        if (k === "_path") return pathColumn(`${doc}.path`);
        if (k === "_hash") return text(`lower(hex(${doc}.file_hash))`);
        if (k === "_updated_at") return text(`${doc}.updated_at`);
        if (k === "_created_at") return text(`${doc}.created_at`);
        if (k === "_format") return text(`${doc}.format`);
        if (k.startsWith("$") || k.startsWith("_")) return null; // `_doc._raw`, `_doc._title`, `_doc._nodes`, an unknown engine name: not pushable (decline (b))
        if (TARGETS.has(k)) return null; // a bare target name: the loud error, never a property
        return propScalar(doc, k);
      }
      // _dst.<x> reach-through from a link (spec/surface §1.2, 3.0 follow-up):
      // the destination DOCUMENT, keyed by the row's own `dst_node` — the lookup
      // `_dst_path` already runs. A property read scopes `properties` by
      // `e.dst_node` directly; the document's own columns are a primary-key
      // probe `(SELECT … FROM docs dd WHERE dd.doc_id = e.dst_node)` — NULL
      // wherever `_dst` is absent in memory (a block or external destination, a
      // phantom). `_dst._raw` / `_dst._title` / `_dst._tags` and the relations
      // stay residual, as `_doc.*`'s do.
      if (head === "_dst" && target === "links") {
        const dstId = `${self}.dst_node`;
        if (rest.length === 2 && rest[0]! in SOURCE_HANDLES) return handleReadOf(dstId, rest[0]!, rest[1]!);
        if (rest.length !== 1) return null;
        const k = rest[0]!;
        const probe = (col: string): Operand => text(`(SELECT ${col} FROM docs dd WHERE dd.doc_id = ${dstId})`);
        if (k === "_id") return probe("dd.doc_id");
        if (k === "_path") return probe("'/' || dd.path");
        if (k === "_hash") return probe("lower(hex(dd.file_hash))");
        if (k === "_updated_at") return probe("dd.updated_at");
        if (k === "_created_at") return probe("dd.created_at");
        if (k === "_format") return probe("dd.format");
        if (k.startsWith("$") || k.startsWith("_") || TARGETS.has(k)) return null;
        return propScalarOf(dstId, k);
      }
      // _block.<x> reach-through from a node: the block's identity is the node's
      // FK (`_block._id` → `n.block_id`, `_block._path` → the joined `d.path`,
      // `_block._doc_id` → `n.doc_id` — FK elimination again); `_type`/`_text`
      // are a correlated read of the block row.
      if (head === "_block" && target === "nodes" && rest.length === 1) {
        const k = rest[0]!;
        if (k === "_id") return text(`${self}.block_id`);
        if (k === "_path") return pathColumn(`${doc}.path`);
        if (k === "_doc_id") return text(`${self}.doc_id`);
        if (k === "_type" || k === "_text") return text(`(SELECT bb.${k.slice(1)} FROM blocks bb WHERE bb.block_id = ${self}.block_id)`);
        return null;
      }
      // _block.<x> reach-through from a link (spec/surface §1.2, 4.11): the
      // SOURCE block, keyed by the row's own `src_block` — `_block._id` is that
      // FK column (NULL for a frontmatter link, exactly where `_block` is absent
      // in memory); everything else is a primary-key probe of the block row,
      // NULL for the same rows (`_block._path` reads the scan's joined source
      // document inside the probe, so it too is NULL when there is no block).
      // `_raw`, `_hash`, `_updated_at`, `_attrs` and the relations stay residual.
      if (head === "_block" && target === "links" && rest.length === 1) {
        const k = rest[0]!;
        const probe = (col: string): Operand => text(`(SELECT ${col} FROM blocks bb WHERE bb.block_id = ${self}.src_block)`);
        if (k === "_id") return text(`${self}.src_block`);
        if (k === "_path") return probe(`'/' || ${doc}.path`);
        if (k === "_doc_id") return probe("bb.doc_id");
        if (k === "_type" || k === "_text") return probe(`bb.${k.slice(1)}`);
        return null;
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
 *     integer before every text (`$ordinal < "3"`, `level < "x"`, `path > 5`),
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
 * The path equality fast path: `_path == "/a.md"` (or `!=`, either side) against
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
    const { docId, key, source } = read.prop;
    const test = constant.kind === "bool" ? `p.type = 'bool' AND p.val_bool = ?` : `p.type = 'number' AND p.val_num ${cmp} ?`;
    return { sql: `(${propSubquery(docId, key, test, source)} ${wrap})`, params: [...constant.params] };
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
