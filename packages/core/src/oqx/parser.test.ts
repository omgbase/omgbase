import { describe, it, expect } from "vitest";
import { parseOqx } from "./parser.js";
import { lowerQuery } from "./lower.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type { WhereExpr } from "./ir.js";

// OQX structural parsing + lowering. The parser owns query structure (the `from`
// source chain, where/select, postfix consumer directives `<recv> <op> { … }`)
// AND the where-clause boolean tree (&&/||/!/grouping); scalar leaves are
// captured verbatim for the CEL layer.

describe("OQX parser — structure", () => {
  it("parses a bare `from`", () => {
    const q = parseOqx("from docs");
    expect(q.from).toEqual(["docs"]);
    expect(q.consumer).toBe("collect");
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

  it("parses a postfix consumer directive (exists)", () => {
    const q = parseOqx('from docs where nodes exists { where kind == "md:task" }');
    expect(q.where).toEqual({
      kind: "op",
      receiver: "nodes",
      op: "exists",
      sub: { from: [], where: { kind: "scalar", source: 'kind == "md:task"' }, select: [] },
    });
  });

  it("parses a count comparison in where position", () => {
    const q = parseOqx('from docs where nodes count { where kind == "md:task" } >= 2');
    expect(q.where).toEqual({
      kind: "op",
      receiver: "nodes",
      op: "count",
      sub: { from: [], where: { kind: "scalar", source: 'kind == "md:task"' }, select: [] },
      countCmp: { op: ">=", value: 2 },
    });
  });

  it("negates a consumer directive with a leading !", () => {
    const q = parseOqx('from docs where !nodes exists { where kind == "md:task" }');
    expect(q.where).toEqual({
      kind: "not",
      expr: {
        kind: "op", receiver: "nodes", op: "exists",
        sub: { from: [], where: { kind: "scalar", source: 'kind == "md:task"' }, select: [] },
      },
    });
  });

  it("mixes a scalar predicate and a consumer directive with ||", () => {
    const q = parseOqx('from docs where layer == "canon" || nodes exists { where kind == "md:task" }');
    if (q.where?.kind !== "or") throw new Error("expected or");
    expect(q.where.parts[0]!.kind).toBe("scalar");
    expect(q.where.parts[1]!.kind).toBe("op");
  });

  it("parses select with bare fields, named scalars, and a collect directive", () => {
    const q = parseOqx('from docs select path, sev: layer, tasks: nodes collect { where kind == "md:task" }');
    expect(q.select).toEqual([
      { kind: "field", name: "path", source: "path" },
      { kind: "field", name: "sev", source: "layer" },
      {
        kind: "collect",
        name: "tasks",
        op: {
          kind: "op", receiver: "nodes", op: "collect",
          sub: { from: [], where: { kind: "scalar", source: 'kind == "md:task"' }, select: [] },
        },
      },
    ]);
  });

  it("parses a nested select inside collect", () => {
    const q = parseOqx('from docs select tasks: nodes collect { where kind == "md:task" select label: name }');
    const item = q.select[0]!;
    expect(item.kind).toBe("collect");
    if (item.kind !== "collect") throw new Error("expected collect");
    expect(item.op.sub.select).toEqual([{ kind: "field", name: "label", source: "name" }]);
  });

  it("parses a keyword-less lift in a where-position collect (^name: expr)", () => {
    const q = parseOqx('from docs where nodes collect { ^open: value where kind == "md:task" && !attrs.checked }');
    expect(q.where).toEqual({
      kind: "op",
      receiver: "nodes",
      op: "collect",
      sub: {
        from: [],
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

  it("does not mistake a scalar method call for a consumer directive", () => {
    // `$path.startsWith(...)` starts with a $-field, not a receiver.
    const q = parseOqx('from docs where $path.startsWith("guides/")');
    expect(q.where).toEqual({ kind: "scalar", source: '$path.startsWith("guides/")' });
  });

  it("treats a receiver-rooted reach-through (no directive) as a scalar (doc.layer)", () => {
    const q = parseOqx('from blocks where doc.layer == "canon"');
    expect(q.where).toEqual({ kind: "scalar", source: 'doc.layer == "canon"' });
  });

  it("parses a body-level `from` source projection in a top-level consumer block", () => {
    const q = parseOqx('repo.docs collect { from nodes where kind == "md:task" }');
    expect(q.from).toEqual(["repo.docs", "nodes"]);
    expect(q.consumer).toBe("collect");
    expect(q.where).toEqual({ kind: "scalar", source: 'kind == "md:task"' });
  });
});

describe("OQX parser — errors", () => {
  it("requires a leading from (or a consumer directive)", () => {
    expect(() => parseOqx('where type == "x"')).toThrow(FilterInvalid);
  });

  it("rejects a duplicate where", () => {
    expect(() => parseOqx("from docs where a == 1 where b == 2")).toThrow(/duplicate/);
  });

  it("rejects an unclosed consumer block", () => {
    expect(() => parseOqx('from docs where nodes exists { where kind == "x"')).toThrow(FilterInvalid);
  });

  it("rejects an unbalanced grouping paren", () => {
    expect(() => parseOqx("from docs where (a == 1 || b == 2")).toThrow(/grouped where/);
  });

  it("rejects an unterminated string", () => {
    expect(() => parseOqx('from docs where layer == "canon')).toThrow(FilterInvalid);
  });

  it("rejects a non-integer count comparison", () => {
    expect(() => parseOqx('from docs where nodes count { where kind == "x" } >= 2.5')).toThrow(/integer/);
  });

  it("rejects legacy dotted-consumer syntax with a migration hint", () => {
    expect(() => parseOqx('from docs where nodes.collect(where kind == "x")')).toThrow(
      /postfix directives, not methods.*nodes collect/s,
    );
  });
});

describe("OQX lowering", () => {
  const only = (q: { where: WhereExpr | null }): WhereExpr => {
    if (!q.where) throw new Error("expected a where");
    return q.where;
  };

  it("maps top-level sources to CEL targets", () => {
    expect(lowerQuery(parseOqx("from docs")).target).toBe("docs");
    expect(lowerQuery(parseOqx("from blocks")).target).toBe("blocks");
    expect(lowerQuery(parseOqx("from nodes")).target).toBe("nodes");
  });

  it("rejects an unknown top-level source", () => {
    expect(() => lowerQuery(parseOqx("from widgets"))).toThrow(/must select a root collection/);
  });

  it("resolves a receiver against the enclosing target", () => {
    const term = only(lowerQuery(parseOqx('from docs where nodes exists { where kind == "md:task" }')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("doc.nodes");
    expect(term.relation.childTarget).toBe("nodes");
    expect(term.subquery.where).toEqual({ kind: "scalar", source: 'kind == "md:task"', target: "nodes" });
  });

  it("resolves doc.blocks from the docs target", () => {
    const term = only(lowerQuery(parseOqx('from docs where blocks exists { where type == "task" }')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("doc.blocks");
    expect(term.relation.childTarget).toBe("blocks");
  });

  it("carries a count comparison onto the lowered op", () => {
    const term = only(lowerQuery(parseOqx('from docs where nodes count { where kind == "md:task" } >= 2')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.op).toBe("count");
    expect(term.countCmp).toEqual({ op: ">=", value: 2 });
  });

  it("rejects a comparison on a non-count op", () => {
    expect(() => lowerQuery(parseOqx('from docs where nodes exists { where kind == "x" } >= 2'))).toThrow(
      /only count.* is comparable/,
    );
  });

  it("resolves section.blocks from the nodes target", () => {
    const term = only(lowerQuery(parseOqx('from nodes where section.blocks exists { where type == "list_item" }')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("section.blocks");
    expect(term.relation.childTarget).toBe("blocks");
  });

  it("resolves block.section from the blocks target (both `section` and `block.section`)", () => {
    for (const src of [
      'from blocks where section exists { where kind == "md:section" }',
      'from blocks where block.section exists { where kind == "md:section" }',
    ]) {
      const term = only(lowerQuery(parseOqx(src)));
      if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
      expect(term.relation.name).toBe("block.section");
      expect(term.relation.childTarget).toBe("nodes");
    }
  });

  it("lowers same-target nesting (section.subsections: nodes→nodes)", () => {
    const term = only(lowerQuery(parseOqx('from nodes where section.subsections exists { where name.contains("x") }')));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("section.subsections");
    expect(term.relation.childTarget).toBe("nodes");
  });

  it("lowers nested collect (collect inside collect)", () => {
    const q = lowerQuery(parseOqx(
      'from docs select secs: nodes collect { where kind == "md:section" select heading: name, items: section.blocks collect { where type == "list_item" } }',
    ));
    const item = q.select[0]!;
    if (item.kind !== "collect") throw new Error("expected collect");
    const inner = item.op.subquery.select[1]!;
    expect(inner.kind).toBe("collect");
    if (inner.kind !== "collect") throw new Error("expected nested collect");
    expect(inner.op.relation.name).toBe("section.blocks");
  });

  it("fails loudly on block.nodes rather than compiling a relation that cannot match", () => {
    expect(() => lowerQuery(parseOqx('from blocks where nodes exists { where kind == "md:link" }'))).toThrow(
      /unavailable.*block_id is always NULL/s,
    );
  });

  it("tags scalar leaves with the enclosing target", () => {
    const q = lowerQuery(parseOqx('from blocks where type == "task"'));
    expect(q.where).toEqual({ kind: "scalar", source: 'type == "task"', target: "blocks" });
  });

  it("rejects a relation not reachable from the target", () => {
    expect(() => lowerQuery(parseOqx('from nodes where blocks exists { where type == "x" }'))).toThrow(
      /no structural relation/,
    );
  });

  it("rejects collect in where position", () => {
    expect(() => lowerQuery(parseOqx('from docs where nodes collect { where kind == "x" }'))).toThrow(
      /collect.* is a projection/,
    );
  });

  it("rejects single-valued relations as consumer directives, pointing at reach-through", () => {
    expect(() => lowerQuery(parseOqx('from nodes where doc exists { where layer == "canon" }'))).toThrow(
      /single-valued/,
    );
  });

  it("lowers a lift-bearing where-collect (predicate + one-scope binding)", () => {
    const term = only(lowerQuery(parseOqx(
      'from docs where nodes collect { ^open: value where kind == "md:task" && !attrs.checked }',
    )));
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.op).toBe("collect");
    expect(term.subquery.select).toEqual([{ kind: "field", name: "open", source: "value", lift: true }]);
  });

  it("rejects a ^lift outside a top-level where-position collect", () => {
    expect(() => lowerQuery(parseOqx("from docs select ^x: layer"))).toThrow(/lift is only valid/);
  });

  it("rejects a non-lift item mixed into a where-position collect body", () => {
    expect(() => lowerQuery(parseOqx('from docs where nodes collect { ^a: value, plain: name where kind == "md:task" }'))).toThrow(
      /projects only via \^lifts/,
    );
  });

  it("rejects a deep re-lift (lift nested more than one scope in)", () => {
    expect(() => lowerQuery(parseOqx(
      'from docs select outer: nodes collect { where kind == "md:section" select inner: section.blocks collect { ^t: text where type == "list_item" } }',
    ))).toThrow(/lift is only valid/);
  });
});

describe("OQX parser — implicit leading clauses (omit where/select)", () => {
  it("a leading predicate-shaped expression is an implicit `where`", () => {
    const implicit = parseOqx('from nodes where blocks exists { type == "task" }');
    const explicit = parseOqx('from nodes where blocks exists { where type == "task" }');
    expect(implicit).toEqual(explicit);
  });

  it("a leading boolean/logical expression is an implicit `where`", () => {
    const implicit = parseOqx('from docs where nodes exists { kind == "md:task" && !attrs.checked }');
    const explicit = parseOqx('from docs where nodes exists { where kind == "md:task" && !attrs.checked }');
    expect(implicit).toEqual(explicit);
  });

  it("a grouped boolean expression is an implicit `where`", () => {
    const q = parseOqx("from docs where nodes exists { (a == 1 || b == 2) && c == 3 }");
    const op = q.where;
    if (op?.kind !== "op") throw new Error("expected op");
    expect(op.sub.where?.kind).toBe("and");
  });

  it("`active == true` is a predicate (implicit where), not a projection", () => {
    const q = parseOqx("from docs where nodes exists { active == true }");
    const op = q.where;
    if (op?.kind !== "op") throw new Error("expected op");
    expect(op.sub.where).toEqual({ kind: "scalar", source: "active == true" });
    expect(op.sub.select).toEqual([]);
  });

  it("a bare reference is an implicit `select` projection, NOT a predicate", () => {
    const q = parseOqx("from docs select tasks: nodes collect { attrs.text }");
    const item = q.select[0]!;
    if (item.kind !== "collect") throw new Error("expected collect");
    expect(item.op.sub.where).toBeNull();
    expect(item.op.sub.select).toEqual([{ kind: "field", name: "text", source: "attrs.text" }]);
  });

  it("a bare boolean-valued property still projects (does not silently filter)", () => {
    const q = parseOqx("from docs select xs: nodes collect { active }");
    const item = q.select[0]!;
    if (item.kind !== "collect") throw new Error("expected collect");
    expect(item.op.sub.where).toBeNull();
    expect(item.op.sub.select).toEqual([{ kind: "field", name: "active", source: "active" }]);
  });

  it("a comma-separated reference list is an implicit `select`", () => {
    const q = parseOqx("from docs select xs: nodes collect { name, value }");
    const item = q.select[0]!;
    if (item.kind !== "collect") throw new Error("expected collect");
    expect(item.op.sub.select).toEqual([
      { kind: "field", name: "name", source: "name" },
      { kind: "field", name: "value", source: "value" },
    ]);
  });

  it("implicit where works at the top level too", () => {
    const implicit = parseOqx('from docs layer == "canon"');
    const explicit = parseOqx('from docs where layer == "canon"');
    expect(implicit).toEqual(explicit);
  });

  it("implicit where composes with an explicit select", () => {
    const implicit = parseOqx('from docs kind == "x" select p: $path');
    const explicit = parseOqx('from docs where kind == "x" select p: $path');
    expect(implicit).toEqual(explicit);
  });

  it("a leading projection then an explicit `where` equals the fully-explicit form", () => {
    // `{ value where P }` — the readable both-clauses idiom: implicit select
    // (stops at the `where` keyword), then explicit filter.
    const projFirst = parseOqx('from docs select xs: nodes collect { value where kind == "md:task" }');
    const explicit = parseOqx('from docs select xs: nodes collect { where kind == "md:task" select value }');
    expect(projFirst).toEqual(explicit);
  });
});

describe("OQX parser + lowering — root relations and first/single", () => {
  it("parses a repo.<target> root receiver", () => {
    const q = parseOqx('from docs select refs: repo.docs collect { where slug == ^ref }');
    const item = q.select[0]!;
    if (item.kind !== "collect") throw new Error("expected a collect select item");
    expect(item.op.receiver).toBe("repo.docs");
    expect(item.op.op).toBe("collect");
  });

  it("parses first/single select projections", () => {
    for (const op of ["first", "single"]) {
      const q = parseOqx(`from docs select x: repo.docs ${op} { where slug == ^ref }`);
      const item = q.select[0]!;
      if (item.kind !== "collect") throw new Error("expected a collect select item");
      expect(item.op.op).toBe(op);
    }
  });

  it("lowers a root relation reachable from any target (repo.nodes from docs)", () => {
    const q = lowerQuery(parseOqx('from docs select ns: repo.nodes collect { where kind == "md:task" }'));
    const item = q.select[0]!;
    if (item.kind !== "collect") throw new Error("expected a collect select item");
    expect(item.op.relation.name).toBe("repo.nodes");
    expect(item.op.relation.root).toBe(true);
    expect(item.op.relation.childTarget).toBe("nodes");
  });

  it("rejects first/single in where position, pointing at exists/count", () => {
    expect(() => lowerQuery(parseOqx('from docs where repo.docs first { where slug == "x" }'))).toThrow(
      /select-position lookup/,
    );
  });

  it("rejects exists/count as a select projection", () => {
    expect(() => parseOqx('from docs select x: repo.docs exists { where slug == "x" }')).toThrow(
      /must use collect/,
    );
  });
});

describe("OQX parser + lowering — top-level consumers", () => {
  it("a bare query lowers to the default collect consumer", () => {
    expect(lowerQuery(parseOqx("from docs")).consumer).toBe("collect");
  });

  it("parses each top-level consumer directive over a root receiver", () => {
    for (const op of ["collect", "count", "exists", "first", "single"]) {
      const sq = parseOqx(`repo.docs ${op} { where layer == "canon" }`);
      expect(sq.consumer).toBe(op);
      expect(sq.from).toEqual(["repo.docs"]);
      expect(lowerQuery(sq).consumer).toBe(op);
    }
  });

  it("the consumer block keeps its full where/select structure", () => {
    const q = lowerQuery(parseOqx('repo.docs first { where layer == "canon" select p: $path }'));
    expect(q.consumer).toBe("first");
    expect(q.where).not.toBeNull();
    expect(q.select[0]!.name).toBe("p");
  });

  it("rejects an unknown consumer directive", () => {
    expect(() => parseOqx("repo.docs frobnicate { }")).toThrow(/unknown consumer/);
  });

  it("reserves `all` but reports it unimplemented", () => {
    expect(() => parseOqx("repo.docs all { }")).toThrow(/not implemented yet/);
  });

  it("requires a closing brace", () => {
    expect(() => parseOqx('repo.docs count { where layer == "canon"')).toThrow(/expected '\}'/);
  });

  it("rejects trailing input after the query", () => {
    expect(() => parseOqx("repo.docs count { } select p: $path")).toThrow(/after the query/);
  });

  it("lowers relative source projection (repo.docs collect { from nodes }) to nodes", () => {
    const q = lowerQuery(parseOqx('repo.docs collect { from nodes where kind == "md:task" }'));
    expect(q.consumer).toBe("collect");
    expect(q.baseTarget).toBe("docs");
    expect(q.target).toBe("nodes");
    expect(q.sourceRelations.map((r) => r.name)).toEqual(["doc.nodes"]);
  });

  it("lowers scalar-relation source projection (repo.nodes collect { from doc }) to docs", () => {
    const q = lowerQuery(parseOqx("repo.nodes collect { from doc select path }"));
    expect(q.baseTarget).toBe("nodes");
    expect(q.target).toBe("docs");
    expect(q.sourceRelations.map((r) => r.name)).toEqual(["node.doc"]);
  });

  it("rejects a chained source projection with no matching single relation (from nodes.block)", () => {
    expect(() => lowerQuery(parseOqx("repo.docs collect { from nodes.block }"))).toThrow(/no navigable relation/);
  });
});

describe("OQX parser + lowering — order by", () => {
  it("parses a single term, default ascending", () => {
    const q = parseOqx("from docs order by updated_at");
    expect(q.orderBy).toEqual([{ source: "updated_at", desc: false }]);
  });

  it("parses asc/desc directions and multiple terms", () => {
    const q = parseOqx("from docs order by rank desc, $path asc, title");
    expect(q.orderBy).toEqual([
      { source: "rank", desc: true },
      { source: "$path", desc: false },
      { source: "title", desc: false },
    ]);
  });

  it("orders by a function expression (semantic/bm25 ranking)", () => {
    const q = parseOqx('from blocks order by semantic("aurora") desc');
    expect(q.orderBy).toEqual([{ source: 'semantic("aurora")', desc: true }]);
  });

  it("`order` is still a usable field name when not followed by `by`", () => {
    const q = parseOqx("from docs where order == 3");
    expect(q.where).toEqual({ kind: "scalar", source: "order == 3" });
    expect(q.orderBy).toBeUndefined();
  });

  it("a select value does not swallow a trailing order by", () => {
    const q = parseOqx("from docs select p: $path order by $path desc");
    expect(q.select).toEqual([{ kind: "field", name: "p", source: "$path" }]);
    expect(q.orderBy).toEqual([{ source: "$path", desc: true }]);
  });

  it("lowers order by onto the Query, and it survives a consumer directive", () => {
    const q = lowerQuery(parseOqx("repo.docs first { order by updated_at desc }"));
    expect(q.consumer).toBe("first");
    expect(q.orderBy).toEqual([{ source: "updated_at", desc: true }]);
  });

  it("rejects a duplicate order by clause", () => {
    expect(() => parseOqx("from docs order by a order by b")).toThrow(/duplicate `order by`/);
  });
});

describe("OQX parser — follow (recursive clause)", () => {
  it("parses a bare follow with a receiver", () => {
    const q = parseOqx("from blocks follow block.children");
    expect(q.follow).toEqual({ distinct: false, receiver: "block.children", where: null, frontier: null, depth: null, by: null, via: null });
  });

  it("parses distinct + successor where + frontier + depth + by (in a block), capturing predicates verbatim", () => {
    const q = parseOqx('from nodes follow distinct section.subsections { where level > 1 frontier attrs.kind == "x" depth 3 by name }');
    expect(q.follow).toEqual({
      distinct: true,
      receiver: "section.subsections",
      where: "level > 1",
      frontier: 'attrs.kind == "x"',
      depth: 3,
      by: "name",
      via: null,
    });
  });

  it("does NOT let a successor where swallow the trailing frontier/depth", () => {
    const q = parseOqx('from blocks follow block.children { where type != "paragraph" depth 2 }');
    expect(q.follow!.where).toBe('type != "paragraph"');
    expect(q.follow!.depth).toBe(2);
    expect(q.follow!.frontier).toBeNull();
  });

  it("captures a boolean successor predicate whole (follow-local where is CEL, not an OQX boolean tree)", () => {
    const q = parseOqx('from blocks follow block.children { where type == "list_item" && !attrs.done }');
    expect(q.follow!.where).toBe('type == "list_item" && !attrs.done');
  });

  it("parses a `via` edge-predicate sub-clause distinct from the successor where", () => {
    const q = parseOqx('from docs follow doc.out { where layer == "canon" via predicate == "depends_on" }');
    expect(q.follow!.where).toBe('layer == "canon"');
    expect(q.follow!.via).toBe('predicate == "depends_on"');
    // `via` does not swallow a trailing depth
    const q2 = parseOqx('from docs follow doc.out { via provenance == "frontmatter" depth 2 }');
    expect(q2.follow!.via).toBe('provenance == "frontmatter"');
    expect(q2.follow!.depth).toBe(2);
  });

  it("keeps a top-level where/select as the seed, with follow terminal after them", () => {
    const q = parseOqx('from blocks where type == "list" select t: text follow block.children');
    expect(q.where).toEqual({ kind: "scalar", source: 'type == "list"' });
    expect(q.select).toEqual([{ kind: "field", name: "t", source: "text" }]);
    expect(q.follow!.receiver).toBe("block.children");
  });

  it("a top-level where does not swallow the follow clause", () => {
    const q = parseOqx('from blocks where type == "list_item" follow block.children');
    expect(q.where).toEqual({ kind: "scalar", source: 'type == "list_item"' });
    expect(q.follow!.receiver).toBe("block.children");
  });

  it("follow/frontier/depth stay usable as ordinary field names outside clause position", () => {
    const q = parseOqx('from docs where follow == 1 && depth == 2 && frontier == 3');
    expect(q.follow).toBeUndefined();
    expect(q.where).toEqual({
      kind: "and",
      parts: [
        { kind: "scalar", source: "follow == 1" },
        { kind: "scalar", source: "depth == 2" },
        { kind: "scalar", source: "frontier == 3" },
      ],
    });
  });

  it("works inside a top-level consumer directive", () => {
    const q = parseOqx("repo.blocks count { follow block.children { depth 4 } }");
    expect(q.consumer).toBe("count");
    expect(q.follow).toEqual({ distinct: false, receiver: "block.children", where: null, frontier: null, depth: 4, by: null, via: null });
  });

  it("rejects a duplicate follow sub-clause", () => {
    expect(() => parseOqx("from blocks follow block.children { where a where b }")).toThrow(/duplicate `where`/);
  });

  it("rejects a non-integer / out-of-range depth", () => {
    expect(() => parseOqx("from blocks follow block.children { depth 0 }")).toThrow(/between 1 and 8/);
    expect(() => parseOqx("from blocks follow block.children { depth 9 }")).toThrow(/between 1 and 8/);
  });

  it("lowers follow onto the Query: resolves the relation and defaults the depth cap", () => {
    const q = lowerQuery(parseOqx("from blocks follow block.children"));
    expect(q.follow!.relation.name).toBe("block.children");
    expect(q.follow!.maxDepth).toBe(8);
    expect(q.follow!.distinct).toBe(false);
  });

  it("rejects a non-type-preserving follow relation at lowering", () => {
    expect(() => lowerQuery(parseOqx("from blocks follow section"))).toThrow(/preserve the row type/);
  });

  it("rejects a root relation as a follow target at lowering", () => {
    expect(() => lowerQuery(parseOqx("from docs follow repo.docs"))).toThrow(/root|per-row/);
  });

  it("resolves the graph edge relations doc.out / doc.in (docs→docs, type-preserving)", () => {
    expect(lowerQuery(parseOqx("from docs follow doc.out")).follow!.relation.name).toBe("doc.out");
    expect(lowerQuery(parseOqx("from docs follow doc.in")).follow!.relation.name).toBe("doc.in");
  });
});
