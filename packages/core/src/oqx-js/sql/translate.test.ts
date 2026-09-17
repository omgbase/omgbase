import { describe, it, expect } from "vitest";
import { parse } from "@omgbase/oqx";
import type { Expr, Query } from "@omgbase/oqx";
import { translatePredicate, translateValue, type TranslateCtx } from "./translate.js";

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
