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

describe("OQX compile — boolean where tree", () => {
  it("compiles || to a SQL OR over CEL leaves", () => {
    const c = compileSrc('from docs where layer == "canon" || layer == "working"');
    const l = celCompile(parseFilter('layer == "canon"'), "docs");
    const r = celCompile(parseFilter('layer == "working"'), "docs");
    expect(c.where).toContain(`(${l.sql} OR ${r.sql})`);
  });

  it("compiles a leading ! over a collection op to NOT (EXISTS …)", () => {
    const c = compileSrc('from docs where !nodes.exists(where kind == "md:task")');
    expect(c.where).toMatch(/\(NOT \(EXISTS \(SELECT 1 FROM nodes n/);
  });

  it("mixes scalar and op leaves under one boolean tree, params in order", () => {
    const c = compileSrc('from docs where layer == "canon" && nodes.exists(where kind == "md:task")');
    expect(c.where).toContain(" AND ");
    // repo guard param, then the layer literal, then the nested kind literal.
    expect(c.whereParams).toEqual(["rp_1", "canon", "md:task"]);
  });
});

describe("OQX compile — count comparisons", () => {
  it("compiles count(...) >= N to a scalar COUNT comparison with the literal bound", () => {
    const c = compileSrc('from docs where nodes.count(where kind == "md:task") >= 2');
    expect(c.where).toMatch(/\(SELECT COUNT\(\*\) FROM nodes n WHERE n\.doc_id = d\.doc_id.*\) >= \?/s);
    expect(c.whereParams).toEqual(["rp_1", "md:task", 2]);
  });
});

describe("OQX compile — section relations", () => {
  it("section.blocks correlates by ordinal-range containment over the section node's attrs", () => {
    const c = compileSrc('from nodes where section.blocks.exists(where type == "list_item")');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM blocks b WHERE b\.doc_id = n\.doc_id/);
    expect(c.where).toContain("json_extract(n.attrs, '$.first_ordinal')");
    expect(c.where).toContain("json_extract(n.attrs, '$.last_ordinal')");
  });

  it("block.section reaches nodes and tests the block's top ordinal against the section range", () => {
    const c = compileSrc('from blocks where section.exists(where kind == "md:section")');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM nodes n WHERE n\.doc_id = b\.doc_id/);
    expect(c.where).toContain("n.kind = 'md:section'");
  });
});

describe("OQX compile — lifts", () => {
  it("compiles a where-collect lift to an EXISTS filter plus a resolved json array column", () => {
    const c = compileSrc(
      'from docs where nodes.collect(^open: value where kind == "md:task" && !attrs.checked) select open',
    );
    // where: the collect acts as a non-empty predicate (EXISTS) on the doc.
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM nodes n WHERE n\.doc_id = d\.doc_id/);
    // select: the `open` reference resolves to a json_group_array of value.
    const p = c.projections.find((x) => x.name === "open")!;
    expect(p.isJson).toBe(true);
    expect(p.sql).toMatch(/json_group_array\(n\.value\) FROM nodes n WHERE n\.doc_id = d\.doc_id/);
  });

  it("resolves a lift reference under a renamed select column", () => {
    const c = compileSrc(
      'from docs where nodes.collect(^open: value where kind == "md:task") select todos: open',
    );
    const p = c.projections.find((x) => x.name === "todos")!;
    expect(p.isJson).toBe(true);
    expect(p.sql).toContain("json_group_array(n.value)");
  });

  it("a non-lift projection stays a plain scalar column (isJson false)", () => {
    const c = compileSrc("from docs select lay: layer");
    expect(c.projections[0]!.isJson).toBe(false);
  });
});

describe("OQX compile — root relations and ^ correlation", () => {
  it("repo.docs is an independent repository scan (its own doc alias, repo guard, no correlation)", () => {
    const c = compileSrc('from docs select ref, books: repo.docs.collect(where slug == ^ref select p: $path)');
    const p = c.projections.find((x) => x.name === "books")!;
    // a scan of the whole docs table under a fresh alias, guarded by repo_id.
    expect(p.sql).toMatch(/FROM docs d1 WHERE 1 AND d1\.repo_id = \?/);
    expect(p.sql).toContain("d1.deleted_commit IS NULL");
    expect(p.isJson).toBe(true);
  });

  it("repo.nodes from docs joins a distinct docs alias for the child's own document", () => {
    const c = compileSrc('from docs select ns: repo.nodes.collect(where kind == "md:task")');
    const p = c.projections[0]!;
    expect(p.sql).toMatch(/FROM nodes n JOIN docs d1 ON d1\.doc_id = n\.doc_id WHERE 1 AND n\.repo_id = \?/);
  });

  it("a ^ref scalar correlation compiles child-expr <op> parent-expr (the parent's `d` row)", () => {
    const c = compileSrc('from docs select ref, books: repo.docs.collect(where slug == ^ref select p: $path)');
    const p = c.projections.find((x) => x.name === "books")!;
    // child slug (d1) compared to the parent doc's `ref` property (d).
    expect(p.sql).toContain("p.doc_id = d1.doc_id"); // child slug via properties on d1
    expect(p.sql).toContain("p.doc_id = d.doc_id"); // parent ref via properties on d
  });

  it("a repo.docs.exists in where is a correlated semi-join guarded by repo_id", () => {
    const c = compileSrc('from docs select ref where repo.docs.exists(where slug == ^ref)');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM docs d1 WHERE 1 AND d1\.repo_id = \?/);
  });

  it("first compiles to an ordered LIMIT 1 json_object; single to a capped, unwrapped array", () => {
    const first = compileSrc('from docs select owner, p: repo.docs.first(where slug == ^owner select n: $path)');
    const fp = first.projections.find((x) => x.name === "p")!;
    expect(fp.sql).toMatch(/SELECT json_object\(.*\) FROM docs d1 WHERE .* ORDER BY d1\.path, d1\.doc_id LIMIT 1/s);
    expect(fp.isJson).toBe(true);
    expect(fp.unwrapSingle).toBeUndefined();

    const single = compileSrc('from docs select owner, p: repo.docs.single(where slug == ^owner select n: $path)');
    const sp = single.projections.find((x) => x.name === "p")!;
    expect(sp.sql).toMatch(/json_group_array\(json\(_o\)\) FROM \(SELECT json_object\(.*\) AS _o FROM docs d1 WHERE .* LIMIT 2\)/s);
    expect(sp.unwrapSingle).toBe(true);
  });
});

describe("OQX compile — alias allocation under same-target nesting", () => {
  it("allocates a distinct inner alias for section.subsections (nodes→nodes)", () => {
    const c = compileSrc('from nodes where section.subsections.exists(where name.contains("x"))');
    // outer node is `n`; the nested nodes scope must NOT reuse `n`.
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM nodes n1 WHERE n1\.doc_id = n\.doc_id/);
    expect(c.where).toContain("n1.kind = 'md:section'");
  });

  it("nested collect allocates distinct aliases per scope (docs→nodes→blocks)", () => {
    const c = compileSrc(
      'from docs select secs: nodes.collect(where kind == "md:section" select heading: name, items: section.blocks.collect(where type == "list_item"))',
    );
    const sql = c.projections[0]!.sql;
    // outer collect over nodes n; inner collect over blocks b, correlated to n.
    expect(sql).toMatch(/FROM nodes n WHERE n\.doc_id = d\.doc_id/);
    expect(sql).toMatch(/json_group_array\(json_object\(.*json_group_array/s);
    expect(sql).toMatch(/FROM blocks b WHERE b\.doc_id = n\.doc_id/);
  });

  it("a same-target nested collect allocates n1 for the inner nodes scope", () => {
    // docs → nodes(section) → subsections(nodes): the inner nodes scope needs n1.
    const c = compileSrc(
      'from docs select secs: nodes.collect(where kind == "md:section" select subs: section.subsections.collect(where kind == "md:section"))',
    );
    const sql = c.projections[0]!.sql;
    expect(sql).toMatch(/FROM nodes n WHERE n\.doc_id = d\.doc_id/);
    expect(sql).toMatch(/FROM nodes n1 WHERE n1\.doc_id = n\.doc_id/);
  });
});

describe("OQX compile — text() full-text predicate", () => {
  it("docs target: prunes to docs whose blocks match, aliased by the scope", () => {
    const c = compileSrc('from docs where text("aurora")');
    expect(c.where).toContain("d.doc_id IN (SELECT b2.doc_id FROM blocks_fts JOIN blocks b2 ON b2.rowid = blocks_fts.rowid WHERE blocks_fts MATCH ?)");
    expect(c.whereParams).toContain('"aurora"'); // fts-query.js quotes tokens for phrase-safety
  });

  it("blocks target: matches the block's own FTS rowid", () => {
    const c = compileSrc('from blocks where text("aurora")');
    expect(c.where).toContain("b.rowid IN (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?)");
  });

  it("nodes target: uses the node FTS index", () => {
    const c = compileSrc('from nodes where text("aurora")');
    expect(c.where).toContain("n.rowid IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)");
  });

  it("a no-token query compiles to a matches-nothing predicate (no param)", () => {
    const c = compileSrc('from docs where text("()")');
    expect(c.where).toContain("(1 = 0)");
    expect(c.whereParams).toEqual(["rp_1"]); // only the repo guard; no FTS param
  });

  it("inside a correlated exists, the child scope's alias carries the FTS prune", () => {
    const c = compileSrc('from docs where nodes.exists(where text("aurora"))');
    // the nested node scope (alias n) prunes via nodes_fts, correlated to the doc.
    expect(c.where).toContain("n.rowid IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)");
  });
});
