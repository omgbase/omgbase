import { describe, it, expect } from "vitest";
import { parse } from "@omgbase/oqx";
import type { Expr, Query } from "@omgbase/oqx";
import { translatePredicate, translateValue, translateOperand, comparable, declinedPair, NON_PROPERTY_NAMES, type TranslateCtx, type OperandKind } from "./translate.js";
import { Store } from "../../core/store/store.js";
import { ensureRepo } from "../../core/attach.js";
import { makeStoreContext, tagRows } from "../context.js";

const DOCS: TranslateCtx = { target: "docs", self: "d", doc: "d", params: [] };

// Parse `from <target> where <src>` and return the single scalar predicate Expr.
function predOn(target: string, src: string): Expr {
  const q: Query = parse(`from ${target} where ${src}`);
  if (!q.where || q.where.kind !== "scalar") throw new Error(`expected a single scalar predicate, got ${q.where?.kind}`);
  return q.where.expr;
}

// Parse `from docs where <src>` and return the single scalar predicate Expr.
function pred(src: string): Expr {
  const q: Query = parse(`from docs where ${src}`);
  if (!q.where || q.where.kind !== "scalar") throw new Error(`expected a single scalar predicate, got ${q.where?.kind}`);
  return q.where.expr;
}

describe("translate — equality is absence-normalized (IS / IS NOT)", () => {
  // spec/surface §1 "Paths" (2.0): `path` is the reference form, `'/' || d.path`
  // in SQL; a ROOTED text constant under `==`/`!=` takes the indexed fast path on
  // the bare column with its storage form bound, a bare one (never equal to a
  // rooted path) stays on the general form and matches nothing.
  it("a rooted path literal under == / != is the indexed fast path on the storage column", () => {
    expect(translatePredicate(pred('_path == "/index.md"'), DOCS)).toEqual({ sql: "(d.path IS ?)", params: ["index.md"] });
    expect(translatePredicate(pred('"/x.md" != _path'), DOCS)).toEqual({ sql: "(d.path IS NOT ?)", params: ["x.md"] });
    expect(translatePredicate(pred('$it._path == "/a.md"'), DOCS)).toBeNull(); // the self is `$it` since 5.0 — an OQX name, never a column; the attribute is the bare `_path` above
    // not under a relational op, not for a bare literal, not for `dst_path` (a subquery)
    expect(translatePredicate(pred('_path < "/m"'), DOCS)).toEqual({ sql: "(('/' || d.path) < ?)", params: ["/m"] });
    expect(translatePredicate(pred('_path == "index.md"'), DOCS)).toEqual({ sql: "(('/' || d.path) IS ?)", params: ["index.md"] });
    const edges: TranslateCtx = { target: "links", self: "e", doc: "d", params: [] };
    expect(translatePredicate(predOn('links', '_dst_path == "/a.md"'), edges)).toEqual({
      sql: "((SELECT '/' || dd.path FROM docs dd WHERE dd.doc_id = e.dst_node) IS ?)",
      params: ["/a.md"],
    });
  });

  it("== → null-safe IS (both-absent equal, strict typed)", () => {
    expect(translatePredicate(pred('_path == "index.md"'), DOCS)).toEqual({
      sql: "(('/' || d.path) IS ?)",
      params: ["index.md"],
    });
  });

  it("!= → null-safe IS NOT (so absent != v is true, matching oqx-js)", () => {
    expect(translatePredicate(pred('_path != "x"'), DOCS)).toEqual({
      sql: "(('/' || d.path) IS NOT ?)",
      params: ["x"],
    });
  });

  it("intrinsic column mapping (_id → doc_id)", () => {
    expect(translatePredicate(pred('_id == "d_1"'), DOCS)).toEqual({
      sql: "(d.doc_id IS ?)",
      params: ["d_1"],
    });
  });
});

describe("translate — relational ops (plain SQL; NULL excluded in positive AND context)", () => {
  it("< → plain comparison", () => {
    expect(translatePredicate(pred('_path < "m"'), DOCS)).toEqual({
      sql: "(('/' || d.path) < ?)",
      params: ["m"],
    });
  });
});

describe("translate — string ops are case-sensitive (substr/instr, never LIKE)", () => {
  it("startsWith → first length(arg) chars equal arg", () => {
    expect(translatePredicate(pred('_path.startsWith("lab/")'), DOCS)).toEqual({
      sql: "(substr(('/' || d.path), 1, length(?)) = ?)",
      params: ["lab/", "lab/"],
    });
  });

  it("the marquee case: path.lower().startsWith('lab/') pushes down with explicit lower()", () => {
    expect(translatePredicate(pred('_path.lower().startsWith("lab/")'), DOCS)).toEqual({
      sql: "(substr(lower(('/' || d.path)), 1, length(?)) = ?)",
      params: ["lab/", "lab/"],
    });
  });

  it("contains → instr > 0", () => {
    expect(translatePredicate(pred('_path.contains("notes")'), DOCS)).toEqual({
      sql: "(instr(('/' || d.path), ?) > 0)",
      params: ["notes"],
    });
  });

  it("endsWith → last length(arg) chars equal arg", () => {
    expect(translatePredicate(pred('_path.endsWith(".md")'), DOCS)).toEqual({
      sql: "(substr(('/' || d.path), -length(?)) = ?)",
      params: [".md", ".md"],
    });
  });

  it("upper() wraps the receiver in value position", () => {
    const e = pred('_path.upper()'); // a bare method-call predicate leaf
    expect(translateValue(e, DOCS)).toEqual({ sql: "upper(('/' || d.path))", params: [] });
  });
});

describe("translate — bare document properties push via the properties table", () => {
  it("`layer == \"canon\"` → the scalar-in-scope property subquery", () => {
    const f = translatePredicate(pred('layer == "canon"'), DOCS)!;
    expect(f).not.toBeNull();
    expect(f.sql).toContain("FROM properties p");
    expect(f.sql).toContain("p.key = 'layer'");
    expect(f.sql.startsWith("(") && f.sql.includes(" IS ?)")).toBe(true); // == → IS
    expect(f.params).toEqual(["canon"]);
  });

  it("updated_at pushes as its revisions subquery", () => {
    expect(translatePredicate(pred('_updated_at >= "2026-01-01"'), DOCS)).not.toBeNull();
  });
});

describe("translate — declines (left residual) return null", () => {
  it("the engine attributes that are not columns decline and are NEVER read as a property of the same name (5.0: an underscore name is the engine's, never the authored key)", () => {
    expect(translatePredicate(pred('_title == "x"'), DOCS)).toBeNull();
    expect(translatePredicate(pred('_tags == "x"'), DOCS)).toBeNull();
    expect(translatePredicate(pred('_doc._title == "x"'), BLOCKS)).toBeNull();
    expect(translatePredicate(pred('_doc._raw == "x"'), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", '_raw == "x"'), BLOCKS)).toBeNull();
    // a source handle is a non-property name on docs (`data.k` is residual)
    expect(translatePredicate(pred('_data == null'), DOCS)).toBeNull();
  });

  it("docs raw (reconstructed, not a column)", () => {
    expect(translatePredicate(pred('_raw == "x"'), DOCS)).toBeNull();
  });

  it("matches() (needs a regexp UDF)", () => {
    expect(translatePredicate(pred('_path.matches("^lab/")'), DOCS)).toBeNull();
  });

  it("negation (!) as a nested expr is not AND-safe", () => {
    // (`!` at the top where level becomes a `Where.not` node handled by the
    // planner; here we exercise a `unary` Expr leaf directly.)
    const e: Expr = { kind: "unary", span: [0, 0], op: "!", expr: { kind: "ident", span: [0, 0], name: "_path" } };
    expect(translatePredicate(e, DOCS)).toBeNull();
  });

  it("disjunction (||) as a nested expr is declined", () => {
    const e: Expr = {
      kind: "logical",
      span: [0, 0],
      op: "||",
      left: { kind: "binary", span: [0, 0], op: "==", left: { kind: "ident", span: [0, 0], name: "_path" }, right: { kind: "lit", span: [0, 0], value: "a" } },
      right: { kind: "binary", span: [0, 0], op: "==", left: { kind: "ident", span: [0, 0], name: "_path" }, right: { kind: "lit", span: [0, 0], value: "b" } },
    };
    expect(translatePredicate(e, DOCS)).toBeNull();
  });

  it("an unmapped nodes intrinsic ($locator) is not pushed", () => {
    expect(translatePredicate(pred('$locator == "x"'), { ...DOCS, target: "nodes", self: "n" })).toBeNull();
  });
});

describe("translate — conjunction and bindings via constructed AST", () => {
  it("&& composes two pushable comparisons", () => {
    const e: Expr = {
      kind: "logical",
      span: [0, 0],
      op: "&&",
      left: { kind: "binary", span: [0, 0], op: "==", left: { kind: "ident", span: [0, 0], name: "_path" }, right: { kind: "lit", span: [0, 0], value: "a" } },
      right: { kind: "binary", span: [0, 0], op: "!=", left: { kind: "ident", span: [0, 0], name: "_id" }, right: { kind: "lit", span: [0, 0], value: "d_2" } },
    };
    expect(translatePredicate(e, DOCS)).toEqual({
      sql: "((('/' || d.path) IS ?) AND (d.doc_id IS NOT ?))",
      params: ["a", "d_2"],
    });
  });

  it("&& declines wholesale if either side is not pushable", () => {
    const e: Expr = {
      kind: "logical",
      span: [0, 0],
      op: "&&",
      left: { kind: "binary", span: [0, 0], op: "==", left: { kind: "ident", span: [0, 0], name: "_path" }, right: { kind: "lit", span: [0, 0], value: "a" } },
      // raw is not a column (reconstructed) → not pushable, so the whole && declines.
      right: { kind: "binary", span: [0, 0], op: "==", left: { kind: "ident", span: [0, 0], name: "_raw" }, right: { kind: "lit", span: [0, 0], value: "x" } },
    };
    expect(translatePredicate(e, DOCS)).toBeNull();
  });

  it("resolves a ${…} binding to its param value", () => {
    const e: Expr = { kind: "binary", span: [0, 0], op: "==", left: { kind: "ident", span: [0, 0], name: "_path" }, right: { kind: "binding", span: [0, 0], index: 0 } };
    expect(translatePredicate(e, { ...DOCS, params: ["from-binding.md"] })).toEqual({
      sql: "(('/' || d.path) IS ?)",
      params: ["from-binding.md"],
    });
  });
});

// ---- spec/surface 1.1 patch: the declines that keep the planned path invisible
// ---- (+ the 1.2 patch: the typed pushes that took four cells back) ----


const BLOCKS: TranslateCtx = { target: "blocks", self: "b", doc: "d", params: [] };
const NODES: TranslateCtx = { target: "nodes", self: "n", doc: "d", params: [] };
const EDGES: TranslateCtx = { target: "links", self: "e", doc: "d", params: [] };
const CTX: Record<string, TranslateCtx> = { docs: DOCS, blocks: BLOCKS, nodes: NODES, links: EDGES };

// Parse `from <target> where <src>` and return the single scalar predicate Expr.
describe("decline (a) — the operand-kind comparison matrix", () => {
  it("classifies operands", () => {
    const kind = (ctx: TranslateCtx, src: string): OperandKind | null => translateOperand((predOn(ctx.target, `${src} == null`) as Extract<Expr, { kind: "binary" }>).left, ctx)?.kind ?? null;
    expect(kind(DOCS, "_path")).toBe("text");
    expect(kind(DOCS, "_format")).toBe("text");
    expect(kind(DOCS, "era")).toBe("prop");
    expect(kind(DOCS, "_path.lower()")).toBe("text");
    expect(kind(BLOCKS, "_ordinal")).toBe("int");
    expect(kind(BLOCKS, "_depth")).toBe("int");
    expect(kind(BLOCKS, "_doc_id")).toBe("text");
    expect(kind(EDGES, "_dst_id")).toBe("text");
    expect(kind(EDGES, "_field")).toBe("text");
    expect(kind(BLOCKS, "_type")).toBe("text");
    expect(kind(BLOCKS, "checked")).toBe("json");
    expect(kind(BLOCKS, "_attrs.checked")).toBe("json");
    expect(kind(BLOCKS, "_doc.era")).toBe("prop");
    expect(kind(NODES, "level")).toBe("json");
    expect(kind(NODES, "_block._type")).toBe("text");
    expect(kind(EDGES, "_predicate")).toBe("text");
    const lit = (src: string): OperandKind | null => translateOperand((predOn("docs", `path == ${src}`) as Extract<Expr, { kind: "binary" }>).right, DOCS)?.kind ?? null;
    expect(lit('"x"')).toBe("text");
    expect(lit("1")).toBe("num");
    expect(lit("true")).toBe("bool");
    expect(lit("null")).toBe("null");
  });

  it("the positive rule: equality pushes iff one side is text, or null vs non-prop, or both numeric, or (typed) a bool/num constant vs a json/prop read; relational iff both text, both numeric, or (typed) num vs json/prop", () => {
    const K: OperandKind[] = ["text", "int", "num", "bool", "null", "json", "prop"];
    const numeric = (k: OperandKind) => k === "int" || k === "num";
    const read = (k: OperandKind) => k === "json" || k === "prop";
    for (const a of K) for (const b of K) {
      const typedEq = ((a === "bool" || a === "num") && read(b)) || ((b === "bool" || b === "num") && read(a));
      const typedRel = (a === "num" && read(b)) || (b === "num" && read(a));
      const eq = a === "text" || b === "text" || (a === "null" && b !== "prop") || (b === "null" && a !== "prop") || (numeric(a) && numeric(b)) || typedEq;
      const rel = (a === "text" && b === "text") || (numeric(a) && numeric(b)) || typedRel;
      for (const op of ["==", "!="]) {
        expect(comparable(op, a, b), `${a} ${op} ${b}`).toBe(eq);
        expect(declinedPair(a, b, op), `${a} ${op} ${b} (declinedPair)`).toBe(!eq);
      }
      for (const op of ["<", "<=", ">", ">="]) expect(comparable(op, a, b), `${a} ${op} ${b}`).toBe(rel);
      expect(comparable("==", a, b), `symmetry ${a}/${b}`).toBe(comparable("==", b, a));
      expect(comparable("<", a, b), `symmetry ${a}/${b}`).toBe(comparable("<", b, a));
    }
    // the grid's declined equality cells, spelled out (the 1.2 patch flipped num|json, num|prop, bool|json, bool|prop to typed pushes)
    const D = ["int|bool", "int|json", "int|prop", "num|bool", "bool|bool", "null|prop", "json|json", "json|prop", "prop|prop"];
    for (const cell of D) { const [a, b] = cell.split("|") as [OperandKind, OperandKind]; expect(comparable("==", a, b), cell).toBe(false); }
    expect(K.flatMap((a) => K.map((b) => comparable("==", a, b))).filter(Boolean).length).toBe(49 - 2 * 6 - 3); // 9 distinct declined cells, 6 off-diagonal
    // the typed cells, spelled out
    const T = ["num|json", "num|prop", "bool|json", "bool|prop"];
    for (const cell of T) {
      const [a, b] = cell.split("|") as [OperandKind, OperandKind];
      expect(comparable("==", a, b), cell).toBe(true);
      expect(comparable("<", a, b), `${cell} relational`).toBe(a === "num"); // booleans never order
    }
    // relational: the typed cells are the only ones beyond text×text and numeric×numeric
    expect(K.flatMap((a) => K.map((b) => comparable("<", a, b))).filter(Boolean).length).toBe(1 + 4 + 4);
  });

  it("declines: an integer intrinsic against a JSON read, two JSON reads, two property reads, bool against bool/num", () => {
    expect(translatePredicate(predOn("blocks", "_ordinal == checked"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "_attrs.level == _attrs.checked"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("docs", "era == stages"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "_doc.era == _ordinal"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("docs", "true == false"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("docs", "true == 1"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("nodes", "level == _block._type"), NODES)).not.toBeNull(); // json × text: text wins
  });

  it("declines: a relational comparison between a text operand and a number or integer operand (the fifth shape)", () => {
    expect(translatePredicate(predOn("blocks", '_ordinal < "3"'), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", '"3" >= _depth'), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("docs", "_path > 5"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("docs", "5 <= _path"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "_type < 1"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("docs", '_path.lower() > 5'), DOCS)).toBeNull();
    // equality across the same kinds stays pushable (IS is typed), and same-kind relational too
    expect(translatePredicate(predOn("blocks", '_ordinal == "3"'), BLOCKS)).toEqual({ sql: "(b.ordinal IS ?)", params: ["3"] });
    expect(translatePredicate(predOn("docs", "_path != 5"), DOCS)).toEqual({ sql: "(('/' || d.path) IS NOT ?)", params: [5] });
    expect(translatePredicate(predOn("blocks", "_ordinal < 3"), BLOCKS)).toEqual({ sql: "(b.ordinal < ?)", params: [3] });
    expect(translatePredicate(predOn("docs", '_path > "m"'), DOCS)).toEqual({ sql: "(('/' || d.path) > ?)", params: ["m"] });
    expect(translatePredicate(predOn("blocks", 'checked > "x"'), BLOCKS)).toBeNull(); // json × text relational: JSON integers order before text in SQLite
    expect(translatePredicate(predOn("blocks", 'level < "x"'), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "_ordinal <= 1.5"), BLOCKS)).toEqual({ sql: "(b.ordinal <= ?)", params: [1.5] }); // int × num relational pushes
  });

  // ---- spec/surface 1.2 patch: the typed pushes ----

  const JT = "json_type(b.attrs, '$.checked')";
  const JL = "json_type(b.attrs, '$.level')";
  const XL = "json_extract(b.attrs, '$.level')";

  it("typed push, json × bool: json_type against the type string, no bind; == → IS 1, != → IS NOT 1", () => {
    expect(translatePredicate(predOn("blocks", "checked == true"), BLOCKS)).toEqual({ sql: `((${JT} = 'true') IS 1)`, params: [] });
    expect(translatePredicate(predOn("blocks", "checked == false"), BLOCKS)).toEqual({ sql: `((${JT} = 'false') IS 1)`, params: [] });
    expect(translatePredicate(predOn("blocks", "checked != true"), BLOCKS)).toEqual({ sql: `((${JT} = 'true') IS NOT 1)`, params: [] });
    expect(translatePredicate(predOn("blocks", "false != checked"), BLOCKS)).toEqual({ sql: `((${JT} = 'false') IS NOT 1)`, params: [] });
    expect(translatePredicate(predOn("blocks", "_attrs.checked == true"), BLOCKS)).toEqual({ sql: `((${JT} = 'true') IS 1)`, params: [] });
    expect(translatePredicate(predOn("nodes", "_attrs.checked == true"), NODES)).toEqual({ sql: "((json_type(n.attrs, '$.checked') = 'true') IS 1)", params: [] });
    // booleans never order: relational json × bool stays declined
    expect(translatePredicate(predOn("blocks", "checked < true"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "true >= checked"), BLOCKS)).toBeNull();
  });

  it("typed push, json × num: json_type IN ('integer','real') AND json_extract <op> ?; == → `=` IS 1, != → `=` IS NOT 1, relational → IS 1", () => {
    const typed = (cmp: string, wrap: string, v: number) => ({ sql: `((${JL} IN ('integer', 'real') AND ${XL} ${cmp} ?) ${wrap})`, params: [v] });
    expect(translatePredicate(predOn("blocks", "level == 2"), BLOCKS)).toEqual(typed("=", "IS 1", 2));
    expect(translatePredicate(predOn("blocks", "level != 2"), BLOCKS)).toEqual(typed("=", "IS NOT 1", 2)); // != is the equality test, negated by the wrap
    expect(translatePredicate(predOn("blocks", "level >= 2"), BLOCKS)).toEqual(typed(">=", "IS 1", 2));
    expect(translatePredicate(predOn("blocks", "level > 1"), BLOCKS)).toEqual(typed(">", "IS 1", 1));
    expect(translatePredicate(predOn("blocks", "_attrs.level < 3"), BLOCKS)).toEqual(typed("<", "IS 1", 3));
    expect(translatePredicate(predOn("blocks", "level <= 1.5"), BLOCKS)).toEqual(typed("<=", "IS 1", 1.5));
    // the constant on the left flips the relational op (`2 < level` ⇔ `level > 2`); equality is symmetric
    expect(translatePredicate(predOn("blocks", "2 < level"), BLOCKS)).toEqual(typed(">", "IS 1", 2));
    expect(translatePredicate(predOn("blocks", "2 >= level"), BLOCKS)).toEqual(typed("<=", "IS 1", 2));
    expect(translatePredicate(predOn("blocks", "1 == checked"), BLOCKS)).toEqual({ sql: `((${JT} IN ('integer', 'real') AND json_extract(b.attrs, '$.checked') = ?) IS 1)`, params: [1] });
    expect(translatePredicate(predOn("nodes", "level == 1"), NODES)).toEqual({ sql: "((json_type(n.attrs, '$.level') IN ('integer', 'real') AND json_extract(n.attrs, '$.level') = ?) IS 1)", params: [1] });
  });

  // The single-scalar-row scope every property read keeps (`propScalar` and the typed forms alike).
  const scope = (key: string) => `FROM properties p
           WHERE p.doc_id = d.doc_id AND p.key = '${key}' AND p.card = 'scalar'
             AND (SELECT COUNT(*) FROM properties p2 WHERE p2.doc_id = d.doc_id AND p2.key = '${key}') = 1
           LIMIT 1)`;

  it("typed push, prop × bool: the scalar-row subquery projects `p.type = 'bool' AND p.val_bool = ?` (bound 1/0); == → IS 1, != → IS NOT 1", () => {
    expect(translatePredicate(predOn("docs", "verified == true"), DOCS)).toEqual({ sql: `((SELECT p.type = 'bool' AND p.val_bool = ? ${scope("verified")} IS 1)`, params: [1] });
    expect(translatePredicate(predOn("docs", "verified == false"), DOCS)).toEqual({ sql: `((SELECT p.type = 'bool' AND p.val_bool = ? ${scope("verified")} IS 1)`, params: [0] });
    expect(translatePredicate(predOn("docs", "verified != true"), DOCS)).toEqual({ sql: `((SELECT p.type = 'bool' AND p.val_bool = ? ${scope("verified")} IS NOT 1)`, params: [1] });
    expect(translatePredicate(predOn("docs", "true == verified"), DOCS)).toEqual({ sql: `((SELECT p.type = 'bool' AND p.val_bool = ? ${scope("verified")} IS 1)`, params: [1] });
    // `doc.<k>` from another target reads the owning doc (alias d)
    expect(translatePredicate(predOn("blocks", "_doc.verified == true"), BLOCKS)).toEqual({ sql: `((SELECT p.type = 'bool' AND p.val_bool = ? ${scope("verified")} IS 1)`, params: [1] });
    expect(translatePredicate(predOn("docs", "verified < true"), DOCS)).toBeNull(); // booleans never order
  });

  it("typed push, prop × num: the scalar-row subquery projects `p.type = 'number' AND p.val_num <op> ?`", () => {
    const typed = (cmp: string, wrap: string, v: number, key = "era") => ({ sql: `((SELECT p.type = 'number' AND p.val_num ${cmp} ? ${scope(key)} ${wrap})`, params: [v] });
    expect(translatePredicate(predOn("docs", "era == 800"), DOCS)).toEqual(typed("=", "IS 1", 800));
    expect(translatePredicate(predOn("docs", "era != 800"), DOCS)).toEqual(typed("=", "IS NOT 1", 800));
    expect(translatePredicate(predOn("docs", "era < 1000"), DOCS)).toEqual(typed("<", "IS 1", 1000));
    expect(translatePredicate(predOn("docs", "era >= 800"), DOCS)).toEqual(typed(">=", "IS 1", 800));
    expect(translatePredicate(predOn("docs", "1000 > era"), DOCS)).toEqual(typed("<", "IS 1", 1000)); // flipped
    expect(translatePredicate(predOn("docs", "verified == 1"), DOCS)).toEqual(typed("=", "IS 1", 1, "verified")); // finds nothing: type 'bool' ≠ 'number'
    expect(translatePredicate(predOn("blocks", "_doc.era == 800"), BLOCKS)).toEqual(typed("=", "IS 1", 800));
  });

  it("the typed forms compose under && like any other conjunct", () => {
    // (a top-level `&&` is a `Where.and` the planner splits; a nested one is a `logical` Expr — build that here)
    const e: Expr = { kind: "logical", span: [0, 0], op: "&&", left: predOn("blocks", '_type == "task"'), right: predOn("blocks", "checked == false") };
    const f = translatePredicate(e, BLOCKS)!;
    expect(f.sql).toBe(`((b.type IS ?) AND ((${JT} = 'false') IS 1))`);
    expect(f.params).toEqual(["task"]);
  });

  it("declines: a boolean literal against an integer intrinsic", () => {
    expect(translatePredicate(predOn("blocks", "_ordinal == true"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "_depth != false"), BLOCKS)).toBeNull();
  });

  it("declines: null against a property read (a list-valued or nested key reads NULL in SQL)", () => {
    expect(translatePredicate(predOn("docs", "_tags != null"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("docs", "_tags == null"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "_doc._tags != null"), BLOCKS)).toBeNull();
  });

  it("a boolean or number binding behaves like the literal (typed push); text/null bindings push plainly; a non-scalar binding declines", () => {
    const e: Expr = { kind: "binary", span: [0, 0], op: "==", left: { kind: "ident", span: [0, 0], name: "checked" }, right: { kind: "binding", span: [0, 0], index: 0 } };
    expect(translatePredicate(e, { ...BLOCKS, params: [true] })).toEqual({ sql: `((${JT} = 'true') IS 1)`, params: [] });
    expect(translatePredicate(e, { ...BLOCKS, params: [false] })).toEqual({ sql: `((${JT} = 'false') IS 1)`, params: [] });
    expect(translatePredicate(e, { ...BLOCKS, params: [1] })).toEqual({ sql: `((${JT} IN ('integer', 'real') AND json_extract(b.attrs, '$.checked') = ?) IS 1)`, params: [1] });
    expect(translatePredicate(e, { ...BLOCKS, params: ["x"] })).toEqual({ sql: "(json_extract(b.attrs, '$.checked') IS ?)", params: ["x"] });
    expect(translatePredicate(e, { ...BLOCKS, params: [null] })).toEqual({ sql: "(json_extract(b.attrs, '$.checked') IS ?)", params: [null] });
    expect(translatePredicate(e, { ...BLOCKS, params: [["not", "scalar"]] })).toBeNull();
    const p: Expr = { kind: "binary", span: [0, 0], op: ">=", left: { kind: "ident", span: [0, 0], name: "era" }, right: { kind: "binding", span: [0, 0], index: 0 } };
    expect(translatePredicate(p, { ...DOCS, params: [800] })).toEqual({ sql: `((SELECT p.type = 'number' AND p.val_num >= ? ${scope("era")} IS 1)`, params: [800] });
    const b: Expr = { kind: "binary", span: [0, 0], op: "!=", left: { kind: "ident", span: [0, 0], name: "verified" }, right: { kind: "binding", span: [0, 0], index: 0 } };
    expect(translatePredicate(b, { ...DOCS, params: [false] })).toEqual({ sql: `((SELECT p.type = 'bool' AND p.val_bool = ? ${scope("verified")} IS NOT 1)`, params: [0] });
  });

  it("pushes: a number against an integer intrinsic", () => {
    expect(translatePredicate(predOn("blocks", "_ordinal == 1"), BLOCKS)).toEqual({ sql: "(b.ordinal IS ?)", params: [1] });
    expect(translatePredicate(predOn("blocks", "_depth >= 2"), BLOCKS)).toEqual({ sql: "(b.depth >= ?)", params: [2] });
  });

  it("pushes: any comparison with a string literal, a text column or .lower()/.upper()", () => {
    expect(translatePredicate(predOn("blocks", 'checked == "x"'), BLOCKS)).toEqual({ sql: "(json_extract(b.attrs, '$.checked') IS ?)", params: ["x"] });
    expect(translatePredicate(predOn("docs", 'layer == "canon"'), DOCS)).not.toBeNull();
    expect(translatePredicate(predOn("blocks", '_doc.layer != "canon"'), BLOCKS)).not.toBeNull();
    expect(translatePredicate(predOn("blocks", '_ordinal == "1"'), BLOCKS)).toEqual({ sql: "(b.ordinal IS ?)", params: ["1"] });
    expect(translatePredicate(predOn("docs", "_path == 1"), DOCS)).toEqual({ sql: "(('/' || d.path) IS ?)", params: [1] });
    expect(translatePredicate(predOn("docs", "_path == true"), DOCS)).toEqual({ sql: "(('/' || d.path) IS ?)", params: [1] });
    expect(translatePredicate(predOn("docs", 'type.lower() == "hub"'), DOCS)).not.toBeNull();
    expect(translatePredicate(predOn("blocks", '_type == "task"'), BLOCKS)).toEqual({ sql: "(b.type IS ?)", params: ["task"] });
  });

  it("pushes: null against a column, an intrinsic or a JSON read", () => {
    expect(translatePredicate(predOn("blocks", "checked == null"), BLOCKS)).toEqual({ sql: "(json_extract(b.attrs, '$.checked') IS ?)", params: [null] });
    expect(translatePredicate(predOn("blocks", "_attrs.level != null"), BLOCKS)).toEqual({ sql: "(json_extract(b.attrs, '$.level') IS NOT ?)", params: [null] });
    expect(translatePredicate(predOn("docs", "_updated_at != null"), DOCS)).not.toBeNull();
    expect(translatePredicate(predOn("links", "_anchor == null"), EDGES)).toEqual({ sql: "(e.anchor IS ?)", params: [null] });
  });
});

describe("source handles (3.0) — a key read through a handle is pushed, the whole handle is not", () => {
  it("_data.<k> is exactly the bare property read", () => {
    const bare = translatePredicate(pred('layer == "canon"'), DOCS)!;
    const viaData = translatePredicate(pred('_data.layer == "canon"'), DOCS)!;
    expect(viaData).toEqual(bare);
    expect(bare.sql).not.toContain("p.source");
  });
  it("_frontmatter.<k> / _inline.<k> scope the row AND the count to the source", () => {
    const fm = translatePredicate(pred('_frontmatter.layer == "canon"'), DOCS)!;
    expect(fm.sql).toContain("AND p.source = 'frontmatter'");
    expect(fm.sql).toContain("AND p2.source = 'frontmatter'");
    const il = translatePredicate(pred('_inline.element == "fire"'), DOCS)!;
    expect(il.sql).toContain("AND p.source = 'inline'");
    expect(il.sql).toContain("AND p2.source = 'inline'");
    // the typed push keeps the scope
    const typed = translatePredicate(pred("_inline.level >= 2"), DOCS)!;
    expect(typed.sql).toContain("p.type = 'number' AND p.val_num >= ?");
    expect(typed.sql).toContain("AND p2.source = 'inline'");
  });
  it("_doc.<handle>.<k> reaches the owning document from blocks and nodes", () => {
    const b = translatePredicate(predOn("blocks", '_doc._inline.element == "fire"'), BLOCKS)!;
    expect(b.sql).toContain("p.doc_id = d.doc_id");
    expect(b.sql).toContain("AND p.source = 'inline'");
    expect(translatePredicate(predOn("blocks", '_doc._data.layer == "canon"'), BLOCKS)).toEqual(translatePredicate(predOn("blocks", '_doc.layer == "canon"'), BLOCKS));
  });
  it("a whole handle, an unknown handle member depth and entries() stay residual", () => {
    expect(translatePredicate(pred("_data == null"), DOCS)).toBeNull();
    expect(translatePredicate(pred("_frontmatter == null"), DOCS)).toBeNull();
    expect(translatePredicate(pred('_data.meta.owner == "x"'), DOCS)).toBeNull();
    expect(translatePredicate(pred('size(entries(_data)) > 1'), DOCS)).toBeNull();
  });
});

describe("decline (b) — relation, reach-through and source-handle names are not property reads", () => {
  it("the name sets per target", () => {
    expect([...NON_PROPERTY_NAMES.docs].sort()).toEqual(["_blocks", "_data", "_frontmatter", "_inline", "_nodes", "_out_links", "_in_links", "_revisions"].sort());
    expect([...NON_PROPERTY_NAMES.blocks].sort()).toEqual(["_attrs", "_children", "_doc", "_nodes", "_out_links", "_section"].sort());
    expect([...NON_PROPERTY_NAMES.nodes].sort()).toEqual(["_attrs", "_block", "_blocks", "_children", "_doc", "_subsections"].sort());
    expect([...NON_PROPERTY_NAMES.links].sort()).toEqual(["_block", "_doc", "_dst"]);
  });

  it("every name in the set resolves to a non-scalar in the store context (a row, an array, an object)", () => {
    const store = new Store({ path: ":memory:" });
    try {
      const repoId = ensureRepo(store, "names");
      const ctx = makeStoreContext(store, repoId);
      const rows: Record<string, Record<string, unknown>> = {
        docs: { doc_id: "d_x", repo_id: repoId, path: "a.md", format: "markdown" },
        blocks: { block_id: "b_x", doc_id: "d_x", repo_id: repoId, __path: "a.md", type: "paragraph", text: "t", attrs: "{}", ordinal: 0, depth: 0, parent_block: null },
        nodes: { node_id: "n_x", doc_id: "d_x", repo_id: repoId, __path: "a.md", block_id: "b_x", kind: "md:section", name: "s", value: null, attrs: "{}" },
        links: { edge_id: "e_x", repo_id: repoId, __path: "a.md", src_doc: "d_x", dst_node: "d_y", predicate: "references", anchor: null },
      };
      for (const target of Object.keys(NON_PROPERTY_NAMES) as (keyof typeof NON_PROPERTY_NAMES)[]) {
        const [row] = tagRows([rows[target]!], target);
        for (const name of NON_PROPERTY_NAMES[target]) {
          const v = ctx.get(row, name);
          // a row, an array or a handle object — or, for the owning-entity reach-through
          // (`_doc` off blocks/nodes/edges, `_block` off nodes, `_dst` off a link), undefined when
          // the owner is not in the store (or the link's destination is not a document)
          const reach = name === "_doc" || name === "_block" || name === "_dst";
          expect((typeof v === "object" && v !== null) || (reach && v === undefined), `${target}.${name} resolved to ${JSON.stringify(v)}`).toBe(true);
        }
        // and a plain key is a scalar/absent read, so the set is not over-wide
        const plain = target === "docs" ? "era" : target === "links" ? "anchor" : "checked";
        const pv = ctx.get(row, plain);
        expect(pv === undefined || pv === null || typeof pv !== "object", `${target}.${plain}`).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("a bare name from the set declines on its target", () => {
    for (const target of Object.keys(NON_PROPERTY_NAMES) as (keyof typeof NON_PROPERTY_NAMES)[]) {
      for (const name of NON_PROPERTY_NAMES[target]) {
        expect(translatePredicate(predOn(target, `${name} == null`), CTX[target]!), `${target}: ${name} == null`).toBeNull();
        expect(translatePredicate(predOn(target, `${name} != "x"`), CTX[target]!), `${target}: ${name} != "x"`).toBeNull();
      }
    }
  });

  it("a docs relation or handle behind `_doc.` declines on every joined target (a document has no `_doc`: the bare set above covers it)", () => {
    for (const target of ["blocks", "nodes", "links"]) {
      expect(translatePredicate(predOn(target, "_doc._nodes == null"), CTX[target]!), target).toBeNull();
      expect(translatePredicate(predOn(target, '_doc._frontmatter != "x"'), CTX[target]!), target).toBeNull();
    }
  });

  it("the same names remain ordinary attributes where the context reads them as such", () => {
    // `section`/`children` are not in the docs or edges sets: on docs they are property keys (pushable as text).
    expect(translatePredicate(predOn("docs", 'section == "x"'), DOCS)).not.toBeNull();
    expect(translatePredicate(predOn("nodes", 'out_links == "x"'), NODES)).not.toBeNull(); // nodes have no out_links relation → attrs.out_links
  });
});

describe("foreign-key elimination (spec/surface §1, 3.0) — a reach-through to the owner's identity is the FK column", () => {
  it("_doc._id is the row's own FK column on every joined target, the same SQL as the bare _doc_id", () => {
    expect(translatePredicate(predOn("blocks", '_doc._id == "d_1"'), BLOCKS)).toEqual({ sql: "(b.doc_id IS ?)", params: ["d_1"] });
    expect(translatePredicate(predOn("blocks", '_doc_id == "d_1"'), BLOCKS)).toEqual({ sql: "(b.doc_id IS ?)", params: ["d_1"] });
    expect(translatePredicate(predOn("nodes", '_doc._id == "d_1"'), NODES)).toEqual({ sql: "(n.doc_id IS ?)", params: ["d_1"] });
    expect(translatePredicate(predOn("links", '_doc._id == "d_1"'), EDGES)).toEqual({ sql: "(e.src_doc IS ?)", params: ["d_1"] });
    expect(translatePredicate(predOn("links", '_doc_id == "d_1"'), EDGES)).toEqual({ sql: "(e.src_doc IS ?)", params: ["d_1"] });
    expect(translatePredicate(pred('_doc_id == "d_1"'), DOCS)).toBeNull(); // a document has no `_doc`/`_doc_id` since 5.0 — `$it` is the self, `_id` the column
  });

  it("_doc._path / _doc._hash / _doc._updated_at read the scan's joined document columns (no subquery for the join)", () => {
    expect(translatePredicate(predOn("blocks", '_doc._path == "/a.md"'), BLOCKS)).toEqual({ sql: "(d.path IS ?)", params: ["a.md"] });
    expect(translatePredicate(predOn("links", '_doc._path == "/a.md"'), EDGES)).toEqual({ sql: "(d.path IS ?)", params: ["a.md"] });
    expect(translatePredicate(predOn("blocks", '_doc._hash == "ab"'), BLOCKS)).toEqual({ sql: "(lower(hex(d.file_hash)) IS ?)", params: ["ab"] });
    expect(translatePredicate(predOn("nodes", '_doc._updated_at >= "2026"'), NODES)?.sql).toContain("d.updated_at");
  });

  it("_block.<x> on a link (4.11) is the source block: _block._id the FK column, the rest a probe by src_block (NULL for a frontmatter link)", () => {
    expect(translatePredicate(predOn("links", '_block._id == "b_1"'), EDGES)).toEqual({ sql: "(e.src_block IS ?)", params: ["b_1"] });
    expect(translatePredicate(predOn("links", '_block._type == "paragraph"'), EDGES)?.sql).toBe("((SELECT bb.type FROM blocks bb WHERE bb.block_id = e.src_block) IS ?)");
    expect(translatePredicate(predOn("links", '_block._text == "x"'), EDGES)?.sql).toContain("SELECT bb.text FROM blocks bb WHERE bb.block_id = e.src_block");
    expect(translatePredicate(predOn("links", '_block._path == "/a.md"'), EDGES)?.sql).toBe("((SELECT '/' || d.path FROM blocks bb WHERE bb.block_id = e.src_block) IS ?)");
    expect(translatePredicate(predOn("links", '_block._doc_id == "d_1"'), EDGES)?.sql).toBe("((SELECT bb.doc_id FROM blocks bb WHERE bb.block_id = e.src_block) IS ?)");
    // the block's own attributes and relations stay residual
    expect(translatePredicate(predOn("links", '_block._hash == "x"'), EDGES)).toBeNull();
    expect(translatePredicate(predOn("links", '_block._children == "x"'), EDGES)).toBeNull();
  });

  it("_block._id / _block._path / _block._doc_id on a node are the node's own columns; _block._text still reaches the block", () => {
    expect(translatePredicate(predOn("nodes", '_block._id == "b_1"'), NODES)).toEqual({ sql: "(n.block_id IS ?)", params: ["b_1"] });
    expect(translatePredicate(predOn("nodes", '_block_id == "b_1"'), NODES)).toEqual({ sql: "(n.block_id IS ?)", params: ["b_1"] });
    expect(translatePredicate(predOn("nodes", '_block._path == "/a.md"'), NODES)).toEqual({ sql: "(d.path IS ?)", params: ["a.md"] });
    expect(translatePredicate(predOn("nodes", '_block._doc_id == "d_1"'), NODES)).toEqual({ sql: "(n.doc_id IS ?)", params: ["d_1"] });
    expect(translatePredicate(predOn("nodes", '_block._text == "x"'), NODES)?.sql).toContain("SELECT bb.text FROM blocks bb");
  });

  it("the links target's plain fields are the store's columns under the surface's names", () => {
    expect(translatePredicate(predOn("links", '_block_id == "b_1"'), EDGES)).toEqual({ sql: "(e.src_block IS ?)", params: ["b_1"] });
    expect(translatePredicate(predOn("links", '_via_id == null'), EDGES)).toEqual({ sql: "(e.via_node IS ?)", params: [null] });
    expect(translatePredicate(predOn("links", '_dst_id == "d_2"'), EDGES)).toEqual({ sql: "(e.dst_node IS ?)", params: ["d_2"] });
    expect(translatePredicate(predOn("links", '_field == "before"'), EDGES)).toEqual({ sql: "(e.src_field IS ?)", params: ["before"] });
    expect(translatePredicate(predOn("links", '_uri == "https://x"'), EDGES)?.sql).toContain("FROM external_nodes xn");
    // the dropped names are no longer intrinsics: an unknown `$x` declines, `from_commit` is gone
    expect(translatePredicate(predOn("links", '$src == "d_1"'), EDGES)).toBeNull();
    expect(translatePredicate(predOn("links", '$from_commit == "c_1"'), EDGES)).toBeNull();
    expect(translatePredicate(predOn("blocks", '$doc == "d_1"'), BLOCKS)).toBeNull();
  });

  it("_dst.<k> on a link reaches the destination DOCUMENT by the row's own dst_node (3.0 follow-up)", () => {
    // identity and the document's own columns: a primary-key probe, NULL where `dst` is absent in memory
    expect(translatePredicate(predOn("links", '_dst._id == "d_2"'), EDGES)).toEqual({ sql: "((SELECT dd.doc_id FROM docs dd WHERE dd.doc_id = e.dst_node) IS ?)", params: ["d_2"] });
    expect(translatePredicate(predOn("links", '_dst._path == "/a.md"'), EDGES)).toEqual({ sql: "((SELECT '/' || dd.path FROM docs dd WHERE dd.doc_id = e.dst_node) IS ?)", params: ["/a.md"] });
    expect(translatePredicate(predOn("links", '_dst._format == "yaml"'), EDGES)).toEqual({ sql: "((SELECT dd.format FROM docs dd WHERE dd.doc_id = e.dst_node) IS ?)", params: ["yaml"] });
    expect(translatePredicate(predOn("links", '_dst._hash == "ab"'), EDGES)?.sql).toContain("lower(hex(dd.file_hash))");
    expect(translatePredicate(predOn("links", '_dst._updated_at == "t"'), EDGES)?.sql).toContain("SELECT dd.updated_at FROM docs dd");
    // a property: the properties scope keyed by e.dst_node itself (a non-document destination has no rows)
    const prop = translatePredicate(predOn("links", '_dst.layer == "canon"'), EDGES);
    expect(prop?.sql).toContain("p.doc_id = e.dst_node AND p.key = 'layer'");
    expect(prop?.params).toEqual(["canon"]);
    // a typed push keeps the same scope
    expect(translatePredicate(predOn("links", "_dst.era > 1600"), EDGES)?.sql).toContain("p.doc_id = e.dst_node AND p.key = 'era'");
    // through a source handle
    expect(translatePredicate(predOn("links", '_dst._frontmatter.layer == "canon"'), EDGES)?.sql).toContain("p.source = 'frontmatter'");
    // the attributes the owner's reach-through declines decline here too, and so do the relations and the whole handle
    for (const k of ["_raw", "_title", "_tags", "_nodes", "_out_links", "_data", "docs", "$x"]) {
      expect(translatePredicate(predOn("links", `_dst.${k} == "x"`), EDGES), k).toBeNull();
    }
    expect(translatePredicate(predOn("links", "_dst == null"), EDGES)).toBeNull();
    // `_dst` is a link's name only
    expect(translatePredicate(predOn("docs", '_dst.layer == "canon"'), DOCS)).toBeNull();
  });
});
