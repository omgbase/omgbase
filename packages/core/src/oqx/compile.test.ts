import { describe, it, expect } from "vitest";
import { parseOqx } from "./parser.js";
import { lowerQuery } from "./lower.js";
import { compileQuery } from "./compile.js";
import { parseFilter } from "../search/cel/parser.js";
import { compile as celCompile } from "../search/cel/compile.js";

// SQL-shape assertions (no DB). The important invariants: nested ops become
// CORRELATED subqueries (never global scans), scalar predicates are the CEL
// compiler's own output verbatim, and OQX never introduces an alias the CEL
// compiler reserves for its internal subqueries.

function compileSrc(src: string, repoId = "rp_1") {
  return compileQuery(lowerQuery(parseOqx(src)), repoId);
}

describe("OQX compile — row sources and guards", () => {
  it("docs target selects from docs with repo + tombstone guards", () => {
    const c = compileSrc("from docs");
    expect(c.from).toBe("docs d");
    expect(c.where).toContain("d.repo_id = ?");
    expect(c.where).toContain("d.deleted_commit IS NULL");
    expect(c.whereParams).toEqual(["rp_1"]);
  });

  it("blocks target joins docs (for $path / doc.* reach-through)", () => {
    const c = compileSrc("from blocks");
    expect(c.from).toBe("blocks b JOIN docs d ON d.doc_id = b.doc_id");
    expect(c.where).toContain("b.deleted_commit IS NULL");
  });

  it("nodes target joins docs", () => {
    const c = compileSrc("from nodes");
    expect(c.from).toBe("nodes n JOIN docs d ON d.doc_id = n.doc_id");
  });
});

describe("OQX compile — scalar reuse of the CEL layer", () => {
  it("emits the CEL compiler's fragment verbatim", () => {
    const c = compileSrc('from blocks where type == "task"');
    const cel = celCompile(parseFilter('type == "task"'), "blocks");
    expect(c.where).toContain(cel.sql);
    expect(c.whereParams).toEqual(["rp_1", ...cel.params]);
  });

  it("conjoins multiple scalar terms", () => {
    const c = compileSrc('from blocks where type == "task" && !attrs.checked');
    const a = celCompile(parseFilter('type == "task"'), "blocks");
    const b = celCompile(parseFilter("!attrs.checked"), "blocks");
    expect(c.where).toContain(a.sql);
    expect(c.where).toContain(b.sql);
  });
});

describe("OQX compile — correlated collection ops", () => {
  it("doc.nodes.exists correlates on doc_id (not a global scan)", () => {
    const c = compileSrc('from docs where nodes.exists(where kind == "md:task")');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM nodes n WHERE n\.doc_id = d\.doc_id/);
    // the nested predicate is the CEL nodes-target fragment
    const cel = celCompile(parseFilter('kind == "md:task"'), "nodes");
    expect(c.where).toContain(cel.sql);
  });

  it("doc.blocks.exists correlates on doc_id and guards tombstones", () => {
    const c = compileSrc('from docs where blocks.exists(where type == "task")');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM blocks b WHERE b\.doc_id = d\.doc_id/);
    expect(c.where).toContain("b.deleted_commit IS NULL");
  });

  it("count in where position compiles to EXISTS (non-empty)", () => {
    const c = compileSrc('from docs where nodes.count(where kind == "md:task")');
    expect(c.where).toContain("EXISTS (SELECT 1 FROM nodes n");
  });

  it("never joins documents inside a subquery — an inner `d` would shadow the outer", () => {
    // The CEL compiler hardcodes alias `d`, so an inner `JOIN documents d` would
    // make the correlation `n.doc_id = d.doc_id` self-referential (always true)
    // and silently match every row. Slice-1 relations are sameDoc, so the outer
    // `d` is already correct for the child row.
    const c = compileSrc('from docs where nodes.exists(where doc.layer == "canon")');
    const exists = c.where.slice(c.where.indexOf("EXISTS"));
    expect(exists).not.toContain("JOIN documents");
    expect(exists).toContain("n.doc_id = d.doc_id");
  });

  it("does not add a documents join when the nested scalar does not need it", () => {
    const c = compileSrc('from docs where nodes.exists(where kind == "md:task")');
    const exists = c.where.slice(c.where.indexOf("EXISTS"));
    expect(exists).not.toContain("JOIN documents");
  });
});

describe("OQX compile — collect projection", () => {
  it("builds a json_group_array correlated subquery aliased to the name", () => {
    const c = compileSrc('from docs select tasks: nodes.collect(where kind == "md:task")');
    expect(c.projections.length).toBe(1);
    const p = c.projections[0]!;
    expect(p.name).toBe("tasks");
    expect(p.sql).toContain("json_group_array(json_object(");
    expect(p.sql).toMatch(/FROM nodes n WHERE n\.doc_id = d\.doc_id/);
    expect(p.sql).toMatch(/AS "tasks"$/);
  });

  it("honors an explicit nested select for the json_object keys", () => {
    const c = compileSrc('from docs select tasks: nodes.collect(where kind == "md:task" select label: name)');
    expect(c.projections[0]!.sql).toContain("'label'");
  });

  it("compiles a named scalar projection to a value expression", () => {
    const c = compileSrc("from docs select lay: layer");
    expect(c.projections[0]!.sql).toMatch(/AS "lay"$/);
    // doc properties route through the indexed properties table (12-properties-table)
    expect(c.projections[0]!.sql).toContain("FROM properties p");
    expect(c.projections[0]!.sql).toContain("p.doc_id = d.doc_id");
  });
});

describe("OQX compile — alias hygiene", () => {
  // The CEL compiler hardcodes the outer aliases d/b/n AND reserves its own
  // inner-subquery aliases (bb, cb, ab, pb, e2, s, hb, tb, kp0…, plus `p` for the
  // properties table). OQX must bind ONLY d/b/n, or a CEL fragment nested inside
  // an OQX subquery resolves against the wrong scope. These tests inspect the row
  // sources OQX itself emits — not CEL-produced fragments, which legitimately
  // bind their own aliases like `properties p`.

  /** Row sources OQX emits: its outer FROM plus each correlated body's FROM. */
  function oqxBindings(src: string): string[] {
    const c = compileSrc(src);
    const own = [c.from];
    const sql = `${c.where} ${c.projections.map((p) => p.sql).join(" ")}`;
    // OQX's correlated bodies: `EXISTS (SELECT 1 FROM <src> WHERE` and
    // `(SELECT json_group_array(…) FROM <src> WHERE`.
    for (const m of sql.matchAll(/(?:SELECT 1|json_group_array\(.*?\)) FROM ([a-z_]+) ([a-z]\w*)/g)) {
      own.push(`${m[1]} ${m[2]}`);
    }
    return own;
  }

  const cases = [
    "from docs",
    "from blocks",
    "from nodes",
    'from docs where nodes.exists(where kind == "md:task")',
    'from docs where blocks.exists(where type == "task")',
    'from docs where nodes.exists(where doc.layer == "canon")',
    'from docs select tasks: nodes.collect(where kind == "md:task")',
  ];

  for (const src of cases) {
    it(`binds only canonical aliases: ${src}`, () => {
      const bindings = oqxBindings(src);
      expect(bindings.length).toBeGreaterThan(0);
      for (const binding of bindings) {
        for (const m of binding.matchAll(/(?:^|JOIN )([a-z_]+) ([a-z]\w*)/g)) {
          expect(["d", "b", "n"]).toContain(m[2]);
        }
      }
    });
  }

  it("emits the expected canonical row sources for a nested op", () => {
    const bindings = oqxBindings('from docs where nodes.exists(where kind == "md:task")');
    expect(bindings).toContain("docs d");
    expect(bindings).toContain("nodes n");
  });
});
