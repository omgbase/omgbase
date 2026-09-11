import { describe, it, expect } from "vitest";
import { parseOqx } from "./parser.js";
import { lowerQuery } from "./lower.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type { WhereExpr } from "./ir.js";

// OQX structural parsing + lowering (slice 2). The parser owns query structure
// AND the where-clause boolean tree (&&/||/!/grouping); scalar leaves are
// captured verbatim for the CEL layer.

describe("OQX parser — structure", () => {
  it("parses a bare `from`", () => {
    const q = parseOqx("from docs");
    expect(q.from).toBe("docs");
    expect(q.where).toBeNull();
    expect(q.select).toEqual([]);
  });

  it("captures a scalar where predicate verbatim", () => {
    const q = parseOqx('from blocks where type == "heading"');
    expect(q.where).toEqual({ kind: "scalar", source: 'type == "heading"' });
  });

  it("splits a conjunction into a boolean AND tree, keeping each scalar verbatim", () => {
    const q = parseOqx('from blocks where type == "task" && !attrs.checked');
    expect(q.where).toEqual({
      kind: "and",
      parts: [
        { kind: "scalar", source: 'type == "task"' },
        { kind: "not", expr: { kind: "scalar", source: "attrs.checked" } },
      ],
    });
  });

  it("keeps parenthesized calls and commas inside a scalar run", () => {
    const q = parseOqx('from docs where "pricing" in list(tags)');
    expect(q.where).toEqual({ kind: "scalar", source: '"pricing" in list(tags)' });
  });

  it("owns top-level || as a disjunction (not handed whole to CEL)", () => {
    const q = parseOqx('from docs where layer == "canon" || layer == "working"');
    expect(q.where).toEqual({
      kind: "or",
      parts: [
        { kind: "scalar", source: 'layer == "canon"' },
        { kind: "scalar", source: 'layer == "working"' },
      ],
    });
  });

  it("binds && tighter than || (mirrors CEL precedence)", () => {
    const q = parseOqx("from docs where a == 1 && b == 2 || c == 3");
    expect(q.where).toEqual({
      kind: "or",
      parts: [
        { kind: "and", parts: [
          { kind: "scalar", source: "a == 1" },
          { kind: "scalar", source: "b == 2" },
        ] },
        { kind: "scalar", source: "c == 3" },
      ],
    });
  });

  it("owns grouping parens at the where level", () => {
    const q = parseOqx("from docs where (a == 1 || b == 2) && c == 3");
    expect(q.where).toEqual({
      kind: "and",
      parts: [
        { kind: "or", parts: [
          { kind: "scalar", source: "a == 1" },
          { kind: "scalar", source: "b == 2" },
        ] },
        { kind: "scalar", source: "c == 3" },
      ],
    });
  });

  it("parses a receiver-constrained collection op", () => {
    const q = parseOqx('from docs where nodes.exists(where kind == "md:task")');
    expect(q.where).toEqual({
      kind: "op",
      receiver: "nodes",
      op: "exists",
      sub: { where: { kind: "scalar", source: 'kind == "md:task"' }, select: [] },
    });
  });

  it("parses a count comparison in where position", () => {
    const q = parseOqx('from docs where nodes.count(where kind == "md:task") >= 2');
    expect(q.where).toEqual({
      kind: "op",
      receiver: "nodes",
      op: "count",
      sub: { where: { kind: "scalar", source: 'kind == "md:task"' }, select: [] },
      countCmp: { op: ">=", value: 2 },
    });
  });

  it("negates a collection op with a leading !", () => {
    const q = parseOqx('from docs where !nodes.exists(where kind == "md:task")');
    expect(q.where).toEqual({
      kind: "not",
      expr: {
        kind: "op", receiver: "nodes", op: "exists",
        sub: { where: { kind: "scalar", source: 'kind == "md:task"' }, select: [] },
      },
    });
  });

  it("mixes a scalar predicate and a collection op with ||", () => {
    const q = parseOqx('from docs where layer == "canon" || nodes.exists(where kind == "md:task")');
    if (q.where?.kind !== "or") throw new Error("expected or");
    expect(q.where.parts[0]!.kind).toBe("scalar");
    expect(q.where.parts[1]!.kind).toBe("op");
  });

  it("parses select with bare fields, named scalars, and a collect", () => {
    const q = parseOqx('from docs select path, sev: layer, tasks: nodes.collect(where kind == "md:task")');
    expect(q.select).toEqual([
      { kind: "field", name: "path", source: "path" },
      { kind: "field", name: "sev", source: "layer" },
      {
        kind: "collect",
        name: "tasks",
        op: {
          kind: "op", receiver: "nodes", op: "collect",
          sub: { where: { kind: "scalar", source: 'kind == "md:task"' }, select: [] },
        },
      },
    ]);
  });

  it("parses a nested select inside collect", () => {
    const q = parseOqx('from docs select tasks: nodes.collect(where kind == "md:task" select label: name)');
    const item = q.select[0]!;
    expect(item.kind).toBe("collect");
    if (item.kind !== "collect") throw new Error("expected collect");
    expect(item.op.sub.select).toEqual([{ kind: "field", name: "label", source: "name" }]);
  });

  it("parses a keyword-less lift in a where-position collect (^name: expr)", () => {
    const q = parseOqx('from docs where nodes.collect(^open: value where kind == "md:task" && !attrs.checked)');
    expect(q.where).toEqual({
      kind: "op",
      receiver: "nodes",
      op: "collect",
      sub: {
        where: {
          kind: "and",
          parts: [
            { kind: "scalar", source: 'kind == "md:task"' },
            { kind: "not", expr: { kind: "scalar", source: "attrs.checked" } },
          ],
        },
        select: [{ kind: "field", name: "open", source: "value", lift: true }],
      },
    });
  });

  it("does not mistake a scalar method call for a collection op", () => {
    // `$path.startsWith(...)` starts with a $-field, not a receiver root.
    const q = parseOqx('from docs where $path.startsWith("guides/")');
    expect(q.where).toEqual({ kind: "scalar", source: '$path.startsWith("guides/")' });
  });

  it("treats a receiver-rooted non-op call as a scalar (doc.layer reach-through)", () => {
    const q = parseOqx('from blocks where doc.layer == "canon"');
    expect(q.where).toEqual({ kind: "scalar", source: 'doc.layer == "canon"' });
  });
});

describe("OQX parser — errors", () => {
  it("requires a leading from", () => {
    expect(() => parseOqx('where type == "x"')).toThrow(FilterInvalid);
  });

  it("rejects an unknown target", () => {
    expect(() => parseOqx("from widgets")).toThrow(/unknown target/);
  });

  it("rejects a duplicate where", () => {
    expect(() => parseOqx("from docs where a == 1 where b == 2")).toThrow(/duplicate/);
  });

  it("rejects an unclosed collection op", () => {
    expect(() => parseOqx('from docs where nodes.exists(where kind == "x"')).toThrow(FilterInvalid);
  });

  it("rejects an unbalanced grouping paren", () => {
    expect(() => parseOqx("from docs where (a == 1 || b == 2")).toThrow(/grouped where/);
  });

  it("rejects an unterminated string", () => {
    expect(() => parseOqx('from docs where layer == "canon')).toThrow(FilterInvalid);
  });

  it("rejects a non-integer count comparison", () => {
    expect(() => parseOqx('from docs where nodes.count(where kind == "x") >= 2.5')).toThrow(/integer/);
  });
});

describe("OQX lowering", () => {
  const only = (q: { where: WhereExpr | null }): WhereExpr => {
    if (!q.where) throw new Error("expected a where");
    return q.where;
  };

  it("maps surface targets to CEL targets", () => {
    expect(lowerQuery(parseOqx("from docs")).target).toBe("docs");
    expect(lowerQuery(parseOqx("from blocks")).target).toBe("blocks");
    expect(lowerQuery(parseOqx("from nodes")).target).toBe("nodes");
  });

  it("resolves a receiver against the enclosing target", () => {
    const term = only(lowerQuery(parseOqx('from docs where nodes.exists(where kind == "md:task")')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("doc.nodes");
    expect(term.relation.childTarget).toBe("nodes");
    expect(term.subquery.where).toEqual({ kind: "scalar", source: 'kind == "md:task"', target: "nodes" });
  });

  it("resolves doc.blocks from the docs target", () => {
    const term = only(lowerQuery(parseOqx('from docs where blocks.exists(where type == "task")')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("doc.blocks");
    expect(term.relation.childTarget).toBe("blocks");
  });

  it("carries a count comparison onto the lowered op", () => {
    const term = only(lowerQuery(parseOqx('from docs where nodes.count(where kind == "md:task") >= 2')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.op).toBe("count");
    expect(term.countCmp).toEqual({ op: ">=", value: 2 });
  });

  it("rejects a comparison on a non-count op", () => {
    expect(() => lowerQuery(parseOqx('from docs where nodes.exists(where kind == "x") >= 2'))).toThrow(
      /only count\(\.\.\.\) is comparable/,
    );
  });

  it("resolves section.blocks from the nodes target", () => {
    const term = only(lowerQuery(parseOqx('from nodes where section.blocks.exists(where type == "list_item")')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("section.blocks");
    expect(term.relation.childTarget).toBe("blocks");
  });

  it("resolves block.section from the blocks target (both `section` and `block.section`)", () => {
    for (const src of [
      'from blocks where section.exists(where kind == "md:section")',
      'from blocks where block.section.exists(where kind == "md:section")',
    ]) {
      const term = only(lowerQuery(parseOqx(src)));
      if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
      expect(term.relation.name).toBe("block.section");
      expect(term.relation.childTarget).toBe("nodes");
    }
  });

  it("lowers same-target nesting (section.subsections: nodes→nodes)", () => {
    const term = only(lowerQuery(parseOqx('from nodes where section.subsections.exists(where name.contains("x"))')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("section.subsections");
    expect(term.relation.childTarget).toBe("nodes");
  });

  it("lowers nested collect (collect inside collect)", () => {
    const q = lowerQuery(parseOqx(
      'from docs select secs: nodes.collect(where kind == "md:section" select heading: name, items: section.blocks.collect(where type == "list_item"))',
    ));
    const item = q.select[0]!;
    if (item.kind !== "collect") throw new Error("expected collect");
    const inner = item.op.subquery.select[1]!;
    expect(inner.kind).toBe("collect");
    if (inner.kind !== "collect") throw new Error("expected nested collect");
    expect(inner.op.relation.name).toBe("section.blocks");
  });

  it("fails loudly on block.nodes rather than compiling a relation that cannot match", () => {
    expect(() => lowerQuery(parseOqx('from blocks where nodes.exists(where kind == "md:link")'))).toThrow(
      /unavailable.*block_id is always NULL/s,
    );
  });

  it("tags scalar leaves with the enclosing target", () => {
    const q = lowerQuery(parseOqx('from blocks where type == "task"'));
    expect(q.where).toEqual({ kind: "scalar", source: 'type == "task"', target: "blocks" });
  });

  it("rejects a relation not reachable from the target", () => {
    expect(() => lowerQuery(parseOqx('from nodes where blocks.exists(where type == "x")'))).toThrow(
      /no structural relation/,
    );
  });

  it("rejects collect in where position", () => {
    expect(() => lowerQuery(parseOqx('from docs where nodes.collect(where kind == "x")'))).toThrow(
      /collect\(\.\.\.\) is a projection/,
    );
  });

  it("rejects single-valued relations as collection ops, pointing at reach-through", () => {
    expect(() => lowerQuery(parseOqx('from nodes where doc.exists(where layer == "canon")'))).toThrow(
      /single-valued/,
    );
  });

  it("lowers a lift-bearing where-collect (predicate + one-scope binding)", () => {
    const term = only(lowerQuery(parseOqx(
      'from docs where nodes.collect(^open: value where kind == "md:task" && !attrs.checked)',
    )));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.op).toBe("collect");
    expect(term.subquery.select).toEqual([{ kind: "field", name: "open", source: "value", lift: true }]);
  });

  it("rejects a ^lift outside a top-level where-position collect", () => {
    expect(() => lowerQuery(parseOqx("from docs select ^x: layer"))).toThrow(/lift is only valid/);
  });

  it("rejects a non-lift item mixed into a where-position collect body", () => {
    expect(() => lowerQuery(parseOqx('from docs where nodes.collect(^a: value, plain: name where kind == "md:task")'))).toThrow(
      /projects only via \^lifts/,
    );
  });

  it("rejects a deep re-lift (lift nested more than one scope in)", () => {
    // A lift inside a collect that is itself inside another collect's body.
    expect(() => lowerQuery(parseOqx(
      'from docs select outer: nodes.collect(where kind == "md:section" select inner: section.blocks.collect(^t: text where type == "list_item"))',
    ))).toThrow(/lift is only valid/);
  });
});

describe("OQX parser + lowering — root relations and first/single", () => {
  it("parses a repo.<target> root receiver", () => {
    const q = parseOqx('from docs select refs: repo.docs.collect(where slug == ^ref)');
    const item = q.select[0]!;
    if (item.kind !== "collect") throw new Error("expected a collect select item");
    expect(item.op.receiver).toBe("repo.docs");
    expect(item.op.op).toBe("collect");
  });

  it("parses first/single select projections", () => {
    for (const op of ["first", "single"]) {
      const q = parseOqx(`from docs select x: repo.docs.${op}(where slug == ^ref)`);
      const item = q.select[0]!;
      if (item.kind !== "collect") throw new Error("expected a collect select item");
      expect(item.op.op).toBe(op);
    }
  });

  it("lowers a root relation reachable from any target (repo.nodes from docs)", () => {
    const q = lowerQuery(parseOqx('from docs select ns: repo.nodes.collect(where kind == "md:task")'));
    const item = q.select[0]!;
    if (item.kind !== "collect") throw new Error("expected a collect select item");
    expect(item.op.relation.name).toBe("repo.nodes");
    expect(item.op.relation.root).toBe(true);
    expect(item.op.relation.childTarget).toBe("nodes");
  });

  it("rejects first/single in where position, pointing at exists/count", () => {
    expect(() => lowerQuery(parseOqx('from docs where repo.docs.first(where slug == "x")'))).toThrow(
      /select-position lookup/,
    );
  });

  it("rejects exists/count as a select projection", () => {
    expect(() => parseOqx('from docs select x: repo.docs.exists(where slug == "x")')).toThrow(
      /must use collect\(\.\.\.\)\/first/,
    );
  });
});

describe("OQX parser + lowering — top-level consumers (repo.<op>)", () => {
  it("a bare query lowers to the default collect consumer", () => {
    expect(lowerQuery(parseOqx("from docs")).consumer).toBe("collect");
  });

  it("parses each top-level consumer wrapper", () => {
    for (const op of ["collect", "count", "exists", "first", "single"]) {
      const sq = parseOqx(`repo.${op}(from docs where layer == "canon")`);
      expect(sq.consumer).toBe(op);
      expect(sq.from).toBe("docs");
      expect(lowerQuery(sq).consumer).toBe(op);
    }
  });

  it("the wrapped query keeps its full where/select structure", () => {
    const q = lowerQuery(parseOqx('repo.first(from docs where layer == "canon" select p: $path)'));
    expect(q.consumer).toBe("first");
    expect(q.where).not.toBeNull();
    expect(q.select[0]!.name).toBe("p");
  });

  it("rejects an unknown consumer name", () => {
    expect(() => parseOqx("repo.frobnicate(from docs)")).toThrow(/unknown top-level consumer/);
  });

  it("reserves `all` but reports it unimplemented", () => {
    expect(() => parseOqx("repo.all(from docs)")).toThrow(/not implemented yet/);
  });

  it("requires a closing paren", () => {
    expect(() => parseOqx("repo.count(from docs")).toThrow(/expected '\)'/);
  });

  it("rejects trailing input after a wrapped query", () => {
    expect(() => parseOqx("repo.count(from docs) select p: $path")).toThrow(/after the query/);
  });

  it("requires `.<op>(` after a leading repo", () => {
    expect(() => parseOqx("repo from docs")).toThrow(/after a top-level `repo`/);
  });
});
