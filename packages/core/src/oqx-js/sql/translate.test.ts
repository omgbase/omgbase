import { describe, it, expect } from "vitest";
import { parse } from "@omgbase/oqx";
import type { Expr, Query } from "@omgbase/oqx";
import { translatePredicate, translateValue, translateOperand, comparable, declinedPair, NON_PROPERTY_NAMES, type TranslateCtx, type OperandKind } from "./translate.js";
import { Store } from "../../core/store/store.js";
import { ensureRepo } from "../../core/attach.js";
import { makeStoreContext, tagRows } from "../context.js";

const DOCS: TranslateCtx = { target: "docs", self: "d", doc: "d", params: [] };

// Parse `from docs where <src>` and return the single scalar predicate Expr.
function pred(src: string): Expr {
  const q: Query = parse(`from docs where ${src}`);
  if (!q.where || q.where.kind !== "scalar") throw new Error(`expected a single scalar predicate, got ${q.where?.kind}`);
  return q.where.expr;
}

describe("translate — equality is absence-normalized (IS / IS NOT)", () => {
  it("== → null-safe IS (both-absent equal, strict typed)", () => {
    expect(translatePredicate(pred('$path == "index.md"'), DOCS)).toEqual({
      sql: "(d.path IS ?)",
      params: ["index.md"],
    });
  });

  it("!= → null-safe IS NOT (so absent != v is true, matching oqx-js)", () => {
    expect(translatePredicate(pred('$path != "x"'), DOCS)).toEqual({
      sql: "(d.path IS NOT ?)",
      params: ["x"],
    });
  });

  it("intrinsic column mapping ($id → doc_id)", () => {
    expect(translatePredicate(pred('$id == "d_1"'), DOCS)).toEqual({
      sql: "(d.doc_id IS ?)",
      params: ["d_1"],
    });
  });
});

describe("translate — relational ops (plain SQL; NULL excluded in positive AND context)", () => {
  it("< → plain comparison", () => {
    expect(translatePredicate(pred('$path < "m"'), DOCS)).toEqual({
      sql: "(d.path < ?)",
      params: ["m"],
    });
  });
});

describe("translate — string ops are case-sensitive (substr/instr, never LIKE)", () => {
  it("startsWith → first length(arg) chars equal arg", () => {
    expect(translatePredicate(pred('$path.startsWith("lab/")'), DOCS)).toEqual({
      sql: "(substr(d.path, 1, length(?)) = ?)",
      params: ["lab/", "lab/"],
    });
  });

  it("the marquee case: $path.lower().startsWith('lab/') pushes down with explicit lower()", () => {
    expect(translatePredicate(pred('$path.lower().startsWith("lab/")'), DOCS)).toEqual({
      sql: "(substr(lower(d.path), 1, length(?)) = ?)",
      params: ["lab/", "lab/"],
    });
  });

  it("contains → instr > 0", () => {
    expect(translatePredicate(pred('$path.contains("notes")'), DOCS)).toEqual({
      sql: "(instr(d.path, ?) > 0)",
      params: ["notes"],
    });
  });

  it("endsWith → last length(arg) chars equal arg", () => {
    expect(translatePredicate(pred('$path.endsWith(".md")'), DOCS)).toEqual({
      sql: "(substr(d.path, -length(?)) = ?)",
      params: [".md", ".md"],
    });
  });

  it("upper() wraps the receiver in value position", () => {
    const e = pred('$path.upper()'); // a bare method-call predicate leaf
    expect(translateValue(e, DOCS)).toEqual({ sql: "upper(d.path)", params: [] });
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

  it("$updated_at pushes as its revisions subquery", () => {
    expect(translatePredicate(pred('$updated_at >= "2026-01-01"'), DOCS)).not.toBeNull();
  });
});

describe("translate — declines (left residual) return null", () => {
  it("a reserved bare basename ($path typo) is not pushed (residual raises the guard)", () => {
    expect(translatePredicate(pred('path == "x"'), DOCS)).toBeNull();
  });

  it("docs $body (reconstructed, not a column)", () => {
    expect(translatePredicate(pred('$body == "x"'), DOCS)).toBeNull();
  });

  it("matches() (needs a regexp UDF)", () => {
    expect(translatePredicate(pred('$path.matches("^lab/")'), DOCS)).toBeNull();
  });

  it("negation (!) as a nested expr is not AND-safe", () => {
    // (`!` at the top where level becomes a `Where.not` node handled by the
    // planner; here we exercise a `unary` Expr leaf directly.)
    const e: Expr = { kind: "unary", op: "!", expr: { kind: "ident", name: "$path" } };
    expect(translatePredicate(e, DOCS)).toBeNull();
  });

  it("disjunction (||) as a nested expr is declined", () => {
    const e: Expr = {
      kind: "logical",
      op: "||",
      left: { kind: "binary", op: "==", left: { kind: "ident", name: "$path" }, right: { kind: "lit", value: "a" } },
      right: { kind: "binary", op: "==", left: { kind: "ident", name: "$path" }, right: { kind: "lit", value: "b" } },
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
      op: "&&",
      left: { kind: "binary", op: "==", left: { kind: "ident", name: "$path" }, right: { kind: "lit", value: "a" } },
      right: { kind: "binary", op: "!=", left: { kind: "ident", name: "$id" }, right: { kind: "lit", value: "d_2" } },
    };
    expect(translatePredicate(e, DOCS)).toEqual({
      sql: "((d.path IS ?) AND (d.doc_id IS NOT ?))",
      params: ["a", "d_2"],
    });
  });

  it("&& declines wholesale if either side is not pushable", () => {
    const e: Expr = {
      kind: "logical",
      op: "&&",
      left: { kind: "binary", op: "==", left: { kind: "ident", name: "$path" }, right: { kind: "lit", value: "a" } },
      // $body is not a column (reconstructed) → not pushable, so the whole && declines.
      right: { kind: "binary", op: "==", left: { kind: "ident", name: "$body" }, right: { kind: "lit", value: "x" } },
    };
    expect(translatePredicate(e, DOCS)).toBeNull();
  });

  it("resolves a ${…} binding to its param value", () => {
    const e: Expr = { kind: "binary", op: "==", left: { kind: "ident", name: "$path" }, right: { kind: "binding", index: 0 } };
    expect(translatePredicate(e, { ...DOCS, params: ["from-binding.md"] })).toEqual({
      sql: "(d.path IS ?)",
      params: ["from-binding.md"],
    });
  });
});

// ---- spec/surface 1.1 patch: the declines that keep the planned path invisible ----


const BLOCKS: TranslateCtx = { target: "blocks", self: "b", doc: "d", params: [] };
const NODES: TranslateCtx = { target: "nodes", self: "n", doc: "d", params: [] };
const EDGES: TranslateCtx = { target: "edges", self: "e", doc: "d", params: [] };
const CTX: Record<string, TranslateCtx> = { docs: DOCS, blocks: BLOCKS, nodes: NODES, edges: EDGES };

// Parse `from <target> where <src>` and return the single scalar predicate Expr.
function predOn(target: string, src: string): Expr {
  const q: Query = parse(`from ${target} where ${src}`);
  if (!q.where || q.where.kind !== "scalar") throw new Error(`expected a single scalar predicate, got ${q.where?.kind}`);
  return q.where.expr;
}

describe("decline (a) — the operand-kind comparison matrix", () => {
  it("classifies operands", () => {
    const kind = (ctx: TranslateCtx, src: string): OperandKind | null => translateOperand((predOn(ctx.target, `${src} == null`) as Extract<Expr, { kind: "binary" }>).left, ctx)?.kind ?? null;
    expect(kind(DOCS, "$path")).toBe("text");
    expect(kind(DOCS, "format")).toBe("text");
    expect(kind(DOCS, "era")).toBe("prop");
    expect(kind(DOCS, "$path.lower()")).toBe("text");
    expect(kind(BLOCKS, "$ordinal")).toBe("int");
    expect(kind(BLOCKS, "$depth")).toBe("int");
    expect(kind(BLOCKS, "type")).toBe("text");
    expect(kind(BLOCKS, "checked")).toBe("json");
    expect(kind(BLOCKS, "attrs.checked")).toBe("json");
    expect(kind(BLOCKS, "doc.era")).toBe("prop");
    expect(kind(NODES, "level")).toBe("json");
    expect(kind(NODES, "block.type")).toBe("text");
    expect(kind(EDGES, "predicate")).toBe("text");
    const lit = (src: string): OperandKind | null => translateOperand((predOn("docs", `$path == ${src}`) as Extract<Expr, { kind: "binary" }>).right, DOCS)?.kind ?? null;
    expect(lit('"x"')).toBe("text");
    expect(lit("1")).toBe("num");
    expect(lit("true")).toBe("bool");
    expect(lit("null")).toBe("null");
  });

  it("the positive rule: equality pushes iff one side is text, or null vs non-prop, or both numeric; relational iff both text or both numeric", () => {
    const K: OperandKind[] = ["text", "int", "num", "bool", "null", "json", "prop"];
    const numeric = (k: OperandKind) => k === "int" || k === "num";
    for (const a of K) for (const b of K) {
      const eq = a === "text" || b === "text" || (a === "null" && b !== "prop") || (b === "null" && a !== "prop") || (numeric(a) && numeric(b));
      const rel = (a === "text" && b === "text") || (numeric(a) && numeric(b));
      for (const op of ["==", "!="]) {
        expect(comparable(op, a, b), `${a} ${op} ${b}`).toBe(eq);
        expect(declinedPair(a, b, op), `${a} ${op} ${b} (declinedPair)`).toBe(!eq);
      }
      for (const op of ["<", "<=", ">", ">="]) expect(comparable(op, a, b), `${a} ${op} ${b}`).toBe(rel);
      expect(comparable("==", a, b), `symmetry ${a}/${b}`).toBe(comparable("==", b, a));
      expect(comparable("<", a, b), `symmetry ${a}/${b}`).toBe(comparable("<", b, a));
    }
    // the grid's declined equality cells, spelled out
    const D = ["int|bool", "int|json", "int|prop", "num|bool", "num|json", "num|prop", "bool|bool", "bool|json", "bool|prop", "null|prop", "json|json", "json|prop", "prop|prop"];
    for (const cell of D) { const [a, b] = cell.split("|") as [OperandKind, OperandKind]; expect(comparable("==", a, b), cell).toBe(false); }
    expect(K.flatMap((a) => K.map((b) => comparable("==", a, b))).filter(Boolean).length).toBe(49 - 2 * 10 - 3); // 13 distinct declined cells, 10 off-diagonal
  });

  it("declines: an integer intrinsic against a JSON read, two JSON reads, two property reads, bool against bool/num", () => {
    expect(translatePredicate(predOn("blocks", "$ordinal == checked"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "attrs.level == attrs.checked"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("docs", "era == stages"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "doc.era == $ordinal"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("docs", "true == false"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("docs", "true == 1"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("nodes", "level == block.type"), NODES)).not.toBeNull(); // json × text: text wins
  });

  it("declines: a relational comparison between a text operand and a number or integer operand (the fifth shape)", () => {
    expect(translatePredicate(predOn("blocks", '$ordinal < "3"'), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", '"3" >= $depth'), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("docs", "$path > 5"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("docs", "5 <= $path"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "type < 1"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("docs", '$path.lower() > 5'), DOCS)).toBeNull();
    // equality across the same kinds stays pushable (IS is typed), and same-kind relational too
    expect(translatePredicate(predOn("blocks", '$ordinal == "3"'), BLOCKS)).toEqual({ sql: "(b.ordinal IS ?)", params: ["3"] });
    expect(translatePredicate(predOn("docs", "$path != 5"), DOCS)).toEqual({ sql: "(d.path IS NOT ?)", params: [5] });
    expect(translatePredicate(predOn("blocks", "$ordinal < 3"), BLOCKS)).toEqual({ sql: "(b.ordinal < ?)", params: [3] });
    expect(translatePredicate(predOn("docs", '$path > "m"'), DOCS)).toEqual({ sql: "(d.path > ?)", params: ["m"] });
    expect(translatePredicate(predOn("blocks", 'checked > "x"'), BLOCKS)).toBeNull(); // json × text relational: JSON integers order before text in SQLite
    expect(translatePredicate(predOn("blocks", 'level < "x"'), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "$ordinal <= 1.5"), BLOCKS)).toEqual({ sql: "(b.ordinal <= ?)", params: [1.5] }); // int × num relational pushes
  });

  it("declines: a number or boolean literal against a JSON read (either side)", () => {
    expect(translatePredicate(predOn("blocks", "checked == 1"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "1 == checked"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "checked == true"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "checked != false"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "attrs.level > 1"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("nodes", "level == 1"), NODES)).toBeNull();
    expect(translatePredicate(predOn("nodes", "attrs.checked == true"), NODES)).toBeNull();
  });

  it("declines: a number or boolean literal against a property read (bare key, doc.<k>)", () => {
    expect(translatePredicate(predOn("docs", "era == 800"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("docs", "era < 1000"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("docs", "verified == true"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("docs", "verified == 1"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "doc.era == 800"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "doc.verified == true"), BLOCKS)).toBeNull();
  });

  it("declines: a boolean literal against an integer intrinsic", () => {
    expect(translatePredicate(predOn("blocks", "$ordinal == true"), BLOCKS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "$depth != false"), BLOCKS)).toBeNull();
  });

  it("declines: null against a property read (a list-valued or nested key reads NULL in SQL)", () => {
    expect(translatePredicate(predOn("docs", "tags != null"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("docs", "tags == null"), DOCS)).toBeNull();
    expect(translatePredicate(predOn("blocks", "doc.tags != null"), BLOCKS)).toBeNull();
  });

  it("declines: a boolean or number binding behaves like the literal", () => {
    const e: Expr = { kind: "binary", op: "==", left: { kind: "ident", name: "checked" }, right: { kind: "binding", index: 0 } };
    expect(translatePredicate(e, { ...BLOCKS, params: [true] })).toBeNull();
    expect(translatePredicate(e, { ...BLOCKS, params: [1] })).toBeNull();
    expect(translatePredicate(e, { ...BLOCKS, params: ["x"] })).toEqual({ sql: "(json_extract(b.attrs, '$.checked') IS ?)", params: ["x"] });
    expect(translatePredicate(e, { ...BLOCKS, params: [null] })).toEqual({ sql: "(json_extract(b.attrs, '$.checked') IS ?)", params: [null] });
    expect(translatePredicate(e, { ...BLOCKS, params: [["not", "scalar"]] })).toBeNull();
  });

  it("pushes: a number against an integer intrinsic", () => {
    expect(translatePredicate(predOn("blocks", "$ordinal == 1"), BLOCKS)).toEqual({ sql: "(b.ordinal IS ?)", params: [1] });
    expect(translatePredicate(predOn("blocks", "$depth >= 2"), BLOCKS)).toEqual({ sql: "(b.depth >= ?)", params: [2] });
  });

  it("pushes: any comparison with a string literal, a text column or .lower()/.upper()", () => {
    expect(translatePredicate(predOn("blocks", 'checked == "x"'), BLOCKS)).toEqual({ sql: "(json_extract(b.attrs, '$.checked') IS ?)", params: ["x"] });
    expect(translatePredicate(predOn("docs", 'layer == "canon"'), DOCS)).not.toBeNull();
    expect(translatePredicate(predOn("docs", 'doc.layer != "canon"'), DOCS)).not.toBeNull();
    expect(translatePredicate(predOn("blocks", '$ordinal == "1"'), BLOCKS)).toEqual({ sql: "(b.ordinal IS ?)", params: ["1"] });
    expect(translatePredicate(predOn("docs", "$path == 1"), DOCS)).toEqual({ sql: "(d.path IS ?)", params: [1] });
    expect(translatePredicate(predOn("docs", "$path == true"), DOCS)).toEqual({ sql: "(d.path IS ?)", params: [1] });
    expect(translatePredicate(predOn("docs", 'type.lower() == "hub"'), DOCS)).not.toBeNull();
    expect(translatePredicate(predOn("blocks", 'type == "task"'), BLOCKS)).toEqual({ sql: "(b.type IS ?)", params: ["task"] });
  });

  it("pushes: null against a column, an intrinsic or a JSON read", () => {
    expect(translatePredicate(predOn("blocks", "checked == null"), BLOCKS)).toEqual({ sql: "(json_extract(b.attrs, '$.checked') IS ?)", params: [null] });
    expect(translatePredicate(predOn("blocks", "attrs.level != null"), BLOCKS)).toEqual({ sql: "(json_extract(b.attrs, '$.level') IS NOT ?)", params: [null] });
    expect(translatePredicate(predOn("docs", "$updated_at != null"), DOCS)).not.toBeNull();
    expect(translatePredicate(predOn("edges", "anchor == null"), EDGES)).toEqual({ sql: "(e.anchor IS ?)", params: [null] });
  });
});

describe("decline (b) — relation, reach-through and source-handle names are not property reads", () => {
  it("the name sets per target", () => {
    expect([...NON_PROPERTY_NAMES.docs].sort()).toEqual(["blocks", "doc", "frontmatter", "in", "inline", "nodes", "out", "out_edges", "in_edges"].sort());
    expect([...NON_PROPERTY_NAMES.blocks].sort()).toEqual(["attrs", "block", "children", "doc", "nodes", "out_edges", "section"].sort());
    expect([...NON_PROPERTY_NAMES.nodes].sort()).toEqual(["attrs", "block", "blocks", "children", "doc", "section", "subsections"].sort());
    expect([...NON_PROPERTY_NAMES.edges].sort()).toEqual(["doc"]);
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
        edges: { edge_id: "e_x", repo_id: repoId, __path: "a.md", src_doc: "d_x", dst_node: "d_y", predicate: "references", anchor: null },
      };
      for (const target of Object.keys(NON_PROPERTY_NAMES) as (keyof typeof NON_PROPERTY_NAMES)[]) {
        const [row] = tagRows([rows[target]!], target);
        for (const name of NON_PROPERTY_NAMES[target]) {
          const v = ctx.get(row, name);
          // a row, an array or a handle object — or, for the owning-entity reach-through
          // (`doc` off blocks/nodes/edges, `block` off nodes), undefined when the owner is not in the store
          const reach = name === "doc" || name === "block";
          expect((typeof v === "object" && v !== null) || (reach && v === undefined), `${target}.${name} resolved to ${JSON.stringify(v)}`).toBe(true);
        }
        // and a plain key is a scalar/absent read, so the set is not over-wide
        const plain = target === "docs" ? "era" : target === "edges" ? "anchor" : "checked";
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

  it("a docs relation or handle behind `doc.` declines on every target", () => {
    for (const target of ["docs", "blocks", "nodes", "edges"]) {
      expect(translatePredicate(predOn(target, "doc.nodes == null"), CTX[target]!), target).toBeNull();
      expect(translatePredicate(predOn(target, 'doc.frontmatter != "x"'), CTX[target]!), target).toBeNull();
    }
  });

  it("the same names remain ordinary attributes where the context reads them as such", () => {
    // `section`/`children` are not in the docs or edges sets: on docs they are property keys (pushable as text).
    expect(translatePredicate(predOn("docs", 'section == "x"'), DOCS)).not.toBeNull();
    expect(translatePredicate(predOn("nodes", 'out_edges == "x"'), NODES)).not.toBeNull(); // nodes have no out_edges relation → attrs.out_edges
  });
});
