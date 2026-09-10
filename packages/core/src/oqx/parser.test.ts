import { describe, it, expect } from "vitest";
import { parseOqx } from "./parser.js";
import { lowerQuery } from "./lower.js";
import { FilterInvalid } from "../search/cel/parser.js";

// OQX structural parsing + lowering (slice 1). The parser owns query structure
// only; scalar interiors are captured verbatim for the CEL layer.

describe("OQX parser — structure", () => {
  it("parses a bare `from`", () => {
    const q = parseOqx("from docs");
    expect(q.from).toBe("docs");
    expect(q.where).toEqual([]);
    expect(q.select).toEqual([]);
  });

  it("captures a scalar where predicate verbatim", () => {
    const q = parseOqx('from blocks where type == "heading"');
    expect(q.where).toEqual([{ kind: "scalar", source: 'type == "heading"' }]);
  });

  it("splits a conjunction into terms, keeping each scalar verbatim", () => {
    const q = parseOqx('from blocks where type == "task" && !attrs.checked');
    expect(q.where).toEqual([
      { kind: "scalar", source: 'type == "task"' },
      { kind: "scalar", source: "!attrs.checked" },
    ]);
  });

  it("keeps parenthesized calls and commas inside a scalar run", () => {
    const q = parseOqx('from docs where "pricing" in list(tags)');
    expect(q.where).toEqual([{ kind: "scalar", source: '"pricing" in list(tags)' }]);
  });

  it("keeps a || disjunction inside one scalar term (CEL handles it)", () => {
    const q = parseOqx('from docs where layer == "canon" || layer == "working"');
    expect(q.where).toEqual([
      { kind: "scalar", source: 'layer == "canon" || layer == "working"' },
    ]);
  });

  it("parses a receiver-constrained collection op", () => {
    const q = parseOqx('from docs where nodes.exists(where kind == "md:task")');
    expect(q.where).toEqual([
      {
        kind: "op",
        receiver: "nodes",
        op: "exists",
        sub: { where: [{ kind: "scalar", source: 'kind == "md:task"' }], select: [] },
      },
    ]);
  });

  it("mixes a scalar term and a collection op in one where", () => {
    const q = parseOqx('from docs where layer == "canon" && nodes.exists(where kind == "md:task")');
    expect(q.where.length).toBe(2);
    expect(q.where[0]!.kind).toBe("scalar");
    expect(q.where[1]!.kind).toBe("op");
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
          sub: { where: [{ kind: "scalar", source: 'kind == "md:task"' }], select: [] },
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

  it("does not mistake a scalar method call for a collection op", () => {
    // `$path.startsWith(...)` starts with a $-field, not a receiver root.
    const q = parseOqx('from docs where $path.startsWith("guides/")');
    expect(q.where).toEqual([{ kind: "scalar", source: '$path.startsWith("guides/")' }]);
  });

  it("treats a receiver-rooted non-op call as a scalar (doc.layer reach-through)", () => {
    const q = parseOqx('from blocks where doc.layer == "canon"');
    expect(q.where).toEqual([{ kind: "scalar", source: 'doc.layer == "canon"' }]);
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

  it("rejects an unterminated string", () => {
    expect(() => parseOqx('from docs where layer == "canon')).toThrow(FilterInvalid);
  });
});

describe("OQX lowering", () => {
  it("maps surface targets to CEL targets", () => {
    expect(lowerQuery(parseOqx("from docs")).target).toBe("docs");
    expect(lowerQuery(parseOqx("from blocks")).target).toBe("blocks");
    expect(lowerQuery(parseOqx("from nodes")).target).toBe("nodes");
  });

  it("resolves a receiver against the enclosing target", () => {
    const q = lowerQuery(parseOqx('from docs where nodes.exists(where kind == "md:task")'));
    const term = q.where[0]!;
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("doc.nodes");
    expect(term.relation.childTarget).toBe("nodes");
    expect(term.subquery.where[0]).toEqual({ kind: "scalar", source: 'kind == "md:task"', target: "nodes" });
  });

  it("resolves doc.blocks from the docs target", () => {
    const q = lowerQuery(parseOqx('from docs where blocks.exists(where type == "task")'));
    const term = q.where[0]!;
    if (term.kind !== "collectionOp") throw new Error("expected collectionOp");
    expect(term.relation.name).toBe("doc.blocks");
    expect(term.relation.childTarget).toBe("blocks");
  });

  it("fails loudly on block.nodes rather than compiling a relation that cannot match", () => {
    // No format adapter populates nodes.block_id, so this would silently return
    // nothing. A named error beats an empty result.
    expect(() => lowerQuery(parseOqx('from blocks where nodes.exists(where kind == "md:link")'))).toThrow(
      /unavailable.*block_id is always NULL/s,
    );
  });

  it("tags scalar terms with the enclosing target", () => {
    const q = lowerQuery(parseOqx('from blocks where type == "task"'));
    expect(q.where[0]).toEqual({ kind: "scalar", source: 'type == "task"', target: "blocks" });
  });

  it("rejects a relation not reachable from the target", () => {
    // `nodes` has no `blocks` relation (node.blocks does not exist).
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

  it("rejects nested collect inside a collection op", () => {
    expect(() =>
      lowerQuery(parseOqx('from docs select t: blocks.collect(where type == "task" select n: nodes.collect(where kind == "x"))')),
    ).toThrow(/not supported in slice 1/);
  });
});
