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

describe("OQX compile — relative source projection (`from E`)", () => {
  it("repo.docs collect { from nodes } compiles to the nodes canonical source", () => {
    // docs → doc.nodes → nodes: the intermediate doc coincides with the node's
    // own document, so the final source is the canonical nodes row + a redundant
    // (1:1) docs self-join for the projected-through docs row's guard.
    const c = compileSrc('repo.docs collect { from nodes where kind == "md:task" }');
    expect(c.target).toBe("nodes");
    expect(c.from).toContain("nodes n JOIN docs d ON d.doc_id = n.doc_id");
    // the projected-through docs row is joined on the shared doc_id
    expect(c.from).toMatch(/JOIN docs d1 ON n\.doc_id = d1\.doc_id/);
    const cel = celCompile(parseFilter('kind == "md:task"'), "nodes");
    expect(c.where).toContain(cel.sql);
  });

  it("repo.nodes collect { from doc } compiles to a docs row joined through node.doc", () => {
    const c = compileSrc("repo.nodes collect { from doc select p: $path }");
    expect(c.target).toBe("docs");
    // final canonical docs row `d`, joined to the projected-through node n
    expect(c.from).toContain("docs d");
    expect(c.from).toMatch(/JOIN nodes n ON d\.doc_id = n\.doc_id/);
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

describe("OQX compile — correlated consumer directives", () => {
  it("doc.nodes exists correlates on doc_id (not a global scan)", () => {
    const c = compileSrc('from docs where nodes exists { where kind == "md:task" }');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM nodes n WHERE n\.doc_id = d\.doc_id/);
    const cel = celCompile(parseFilter('kind == "md:task"'), "nodes");
    expect(c.where).toContain(cel.sql);
  });

  it("doc.blocks exists correlates on doc_id and guards tombstones", () => {
    const c = compileSrc('from docs where blocks exists { where type == "task" }');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM blocks b WHERE b\.doc_id = d\.doc_id/);
    expect(c.where).toContain("b.deleted_commit IS NULL");
  });

  it("count in where position compiles to EXISTS (non-empty)", () => {
    const c = compileSrc('from docs where nodes count { where kind == "md:task" }');
    expect(c.where).toContain("EXISTS (SELECT 1 FROM nodes n");
  });

  it("never joins documents inside a subquery — an inner `d` would shadow the outer", () => {
    const c = compileSrc('from docs where nodes exists { where doc.layer == "canon" }');
    const exists = c.where.slice(c.where.indexOf("EXISTS"));
    expect(exists).not.toContain("JOIN documents");
    expect(exists).toContain("n.doc_id = d.doc_id");
  });

  it("does not add a documents join when the nested scalar does not need it", () => {
    const c = compileSrc('from docs where nodes exists { where kind == "md:task" }');
    const exists = c.where.slice(c.where.indexOf("EXISTS"));
    expect(exists).not.toContain("JOIN documents");
  });
});

describe("OQX compile — collect projection", () => {
  it("builds a json_group_array correlated subquery aliased to the name", () => {
    const c = compileSrc('from docs select tasks: nodes collect { where kind == "md:task" }');
    expect(c.projections.length).toBe(1);
    const p = c.projections[0]!;
    expect(p.name).toBe("tasks");
    expect(p.sql).toContain("json_group_array(json_object(");
    expect(p.sql).toMatch(/FROM nodes n WHERE n\.doc_id = d\.doc_id/);
    expect(p.sql).toMatch(/AS "tasks"$/);
  });

  it("honors an explicit nested select for the json_object keys", () => {
    const c = compileSrc('from docs select tasks: nodes collect { where kind == "md:task" select label: name }');
    expect(c.projections[0]!.sql).toContain("'label'");
  });

  it("compiles a named scalar projection to a value expression", () => {
    const c = compileSrc("from docs select lay: layer");
    expect(c.projections[0]!.sql).toMatch(/AS "lay"$/);
    expect(c.projections[0]!.sql).toContain("FROM properties p");
    expect(c.projections[0]!.sql).toContain("p.doc_id = d.doc_id");
  });
});

describe("OQX compile — alias hygiene", () => {
  // The CEL compiler hardcodes the outer aliases d/b/n AND reserves its own
  // inner-subquery aliases. OQX must bind ONLY d/b/n at the outer level, or a CEL
  // fragment nested inside an OQX subquery resolves against the wrong scope.

  /** Row sources OQX emits: its outer FROM plus each correlated body's FROM. */
  function oqxBindings(src: string): string[] {
    const c = compileSrc(src);
    const own = [c.from];
    const sql = `${c.where} ${c.projections.map((p) => p.sql).join(" ")}`;
    for (const m of sql.matchAll(/(?:SELECT 1|json_group_array\(.*?\)) FROM ([a-z_]+) ([a-z]\w*)/g)) {
      own.push(`${m[1]} ${m[2]}`);
    }
    return own;
  }

  const cases = [
    "from docs",
    "from blocks",
    "from nodes",
    'from docs where nodes exists { where kind == "md:task" }',
    'from docs where blocks exists { where type == "task" }',
    'from docs where nodes exists { where doc.layer == "canon" }',
    'from docs select tasks: nodes collect { where kind == "md:task" }',
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
    const bindings = oqxBindings('from docs where nodes exists { where kind == "md:task" }');
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

  it("compiles a leading ! over a consumer directive to NOT (EXISTS …)", () => {
    const c = compileSrc('from docs where !nodes exists { where kind == "md:task" }');
    expect(c.where).toMatch(/\(NOT \(EXISTS \(SELECT 1 FROM nodes n/);
  });

  it("mixes scalar and op leaves under one boolean tree, params in order", () => {
    const c = compileSrc('from docs where layer == "canon" && nodes exists { where kind == "md:task" }');
    expect(c.where).toContain(" AND ");
    expect(c.whereParams).toEqual(["rp_1", "canon", "md:task"]);
  });
});

describe("OQX compile — count comparisons", () => {
  it("compiles count { … } >= N to a scalar COUNT comparison with the literal bound", () => {
    const c = compileSrc('from docs where nodes count { where kind == "md:task" } >= 2');
    expect(c.where).toMatch(/\(SELECT COUNT\(\*\) FROM nodes n WHERE n\.doc_id = d\.doc_id.*\) >= \?/s);
    expect(c.whereParams).toEqual(["rp_1", "md:task", 2]);
  });
});

describe("OQX compile — section relations", () => {
  it("section.blocks correlates by ordinal-range containment over the section node's attrs", () => {
    const c = compileSrc('from nodes where section.blocks exists { where type == "list_item" }');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM blocks b WHERE b\.doc_id = n\.doc_id/);
    expect(c.where).toContain("json_extract(n.attrs, '$.first_ordinal')");
    expect(c.where).toContain("json_extract(n.attrs, '$.last_ordinal')");
  });

  it("block.section reaches nodes and tests the block's top ordinal against the section range", () => {
    const c = compileSrc('from blocks where section exists { where kind == "md:section" }');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM nodes n WHERE n\.doc_id = b\.doc_id/);
    expect(c.where).toContain("n.kind = 'md:section'");
  });
});

describe("OQX compile — lifts", () => {
  it("compiles a where-collect lift to an EXISTS filter plus a resolved json array column", () => {
    const c = compileSrc(
      'from docs where nodes collect { ^open: value where kind == "md:task" && !attrs.checked } select open',
    );
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM nodes n WHERE n\.doc_id = d\.doc_id/);
    const p = c.projections.find((x) => x.name === "open")!;
    expect(p.isJson).toBe(true);
    expect(p.sql).toMatch(/json_group_array\(n\.value\) FROM nodes n WHERE n\.doc_id = d\.doc_id/);
  });

  it("resolves a lift reference under a renamed select column", () => {
    const c = compileSrc(
      'from docs where nodes collect { ^open: value where kind == "md:task" } select todos: open',
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
    const c = compileSrc('from docs select ref, books: repo.docs collect { where slug == ^ref select p: $path }');
    const p = c.projections.find((x) => x.name === "books")!;
    expect(p.sql).toMatch(/FROM docs d1 WHERE 1 AND d1\.repo_id = \?/);
    expect(p.sql).toContain("d1.deleted_commit IS NULL");
    expect(p.isJson).toBe(true);
  });

  it("repo.nodes from docs joins a distinct docs alias for the child's own document", () => {
    const c = compileSrc('from docs select ns: repo.nodes collect { where kind == "md:task" }');
    const p = c.projections[0]!;
    expect(p.sql).toMatch(/FROM nodes n JOIN docs d1 ON d1\.doc_id = n\.doc_id WHERE 1 AND n\.repo_id = \?/);
  });

  it("a ^ref scalar correlation compiles child-expr <op> parent-expr (the parent's `d` row)", () => {
    const c = compileSrc('from docs select ref, books: repo.docs collect { where slug == ^ref select p: $path }');
    const p = c.projections.find((x) => x.name === "books")!;
    expect(p.sql).toContain("p.doc_id = d1.doc_id"); // child slug via properties on d1
    expect(p.sql).toContain("p.doc_id = d.doc_id"); // parent ref via properties on d
  });

  it("a repo.docs exists in where is a correlated semi-join guarded by repo_id", () => {
    const c = compileSrc('from docs select ref where repo.docs exists { where slug == ^ref }');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM docs d1 WHERE 1 AND d1\.repo_id = \?/);
  });

  it("first compiles to an ordered LIMIT 1 json_object; single to a capped, unwrapped array", () => {
    const first = compileSrc('from docs select owner, p: repo.docs first { where slug == ^owner select n: $path }');
    const fp = first.projections.find((x) => x.name === "p")!;
    expect(fp.sql).toMatch(/SELECT json_object\(.*\) FROM docs d1 WHERE .* ORDER BY d1\.path, d1\.doc_id LIMIT 1/s);
    expect(fp.isJson).toBe(true);
    expect(fp.unwrapSingle).toBeUndefined();

    const single = compileSrc('from docs select owner, p: repo.docs single { where slug == ^owner select n: $path }');
    const sp = single.projections.find((x) => x.name === "p")!;
    expect(sp.sql).toMatch(/json_group_array\(json\(_o\)\) FROM \(SELECT json_object\(.*\) AS _o FROM docs d1 WHERE .* LIMIT 2\)/s);
    expect(sp.unwrapSingle).toBe(true);
  });
});

describe("OQX compile — alias allocation under same-target nesting", () => {
  it("allocates a distinct inner alias for section.subsections (nodes→nodes)", () => {
    const c = compileSrc('from nodes where section.subsections exists { where name.contains("x") }');
    expect(c.where).toMatch(/EXISTS \(SELECT 1 FROM nodes n1 WHERE n1\.doc_id = n\.doc_id/);
    expect(c.where).toContain("n1.kind = 'md:section'");
  });

  it("nested collect allocates distinct aliases per scope (docs→nodes→blocks)", () => {
    const c = compileSrc(
      'from docs select secs: nodes collect { where kind == "md:section" select heading: name, items: section.blocks collect { where type == "list_item" } }',
    );
    const sql = c.projections[0]!.sql;
    expect(sql).toMatch(/FROM nodes n WHERE n\.doc_id = d\.doc_id/);
    expect(sql).toMatch(/json_group_array\(json_object\(.*json_group_array/s);
    expect(sql).toMatch(/FROM blocks b WHERE b\.doc_id = n\.doc_id/);
  });

  it("a same-target nested collect allocates n1 for the inner nodes scope", () => {
    const c = compileSrc(
      'from docs select secs: nodes collect { where kind == "md:section" select subs: section.subsections collect { where kind == "md:section" } }',
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
    expect(c.whereParams).toContain('"aurora"');
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
    expect(c.whereParams).toEqual(["rp_1"]);
  });

  it("inside a correlated exists, the child scope's alias carries the FTS prune", () => {
    const c = compileSrc('from docs where nodes exists { where text("aurora") }');
    expect(c.where).toContain("n.rowid IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?)");
  });
});

describe("OQX compile — semantic() scalar score", () => {
  const stub = () => ({ vec: Buffer.alloc(8), model: "m1" });

  it("blocks target: cosine over the block's own embedding, keyed by raw_hash", () => {
    const c = compileQuery(lowerQuery(parseOqx('from blocks where semantic("x") > 0.5')), "rp_1", stub);
    expect(c.where).toContain("cosine(e.vec, ?) FROM embeddings e WHERE e.content_hash = b.raw_hash AND e.model = ?");
    expect(c.whereParams).toContain("m1");
    expect(c.whereParams).toContain(0.5);
  });

  it("docs target: cosine over the whole-document vector (doc_embeddings)", () => {
    const c = compileQuery(lowerQuery(parseOqx('from docs select s: semantic("x")')), "rp_1", stub);
    const p = c.projections.find((x) => x.name === "s")!;
    expect(p.sql).toContain("cosine(de.vec, ?) FROM doc_embeddings de WHERE de.doc_id = d.doc_id AND de.model = ?");
  });

  it("without a resolver, semantic() is a loud unavailable error", () => {
    expect(() => compileQuery(lowerQuery(parseOqx('from docs where semantic("x") > 0.5')), "rp_1")).toThrow(
      /needs an embedding provider/,
    );
  });
});

describe("OQX compile — order by", () => {
  it("emits compiled order terms with direction (before run.ts adds the path/id tiebreak)", () => {
    const c = compileSrc("from docs order by title desc");
    expect(c.orderBy).toBeDefined();
    expect(c.orderBy!.sql).toMatch(/DESC$/);
  });

  it("no order clause ⇒ no orderBy fragment", () => {
    expect(compileSrc("from docs").orderBy).toBeUndefined();
  });
});

describe("OQX compile — follow (recursive CTE shape)", () => {
  it("emits a bounded WITH RECURSIVE walk + a walked CTE, joined by the final select", () => {
    const c = compileSrc("from blocks follow block.children");
    expect(c.cte).toBeTruthy();
    expect(c.cte!.sql).toMatch(/^WITH RECURSIVE walk\(id, depth, path, stop, key\) AS \(/);
    expect(c.cte!.sql).toContain("UNION ALL");
    expect(c.cte!.sql).toContain("walked AS (");
    expect(c.from).toContain("JOIN walked ON walked.wid = b.block_id");
  });

  it("the step joins the relation, only expands interior rows, and admits cycles", () => {
    const c = compileSrc("from blocks follow block.children");
    expect(c.cte!.sql).toContain("c.parent_block = pw.block_id");
    expect(c.cte!.sql).toContain("w.stop = 'interior'");
    expect(c.cte!.sql).toContain("w.depth + 1 >= 8");
    expect(c.cte!.sql).toContain("instr(w.path, '/' || c.block_id || '/') > 0 THEN 'cycle'");
  });

  it("depth <n> inlines the cap in the base + step $stop CASE", () => {
    const c = compileSrc("from blocks follow block.children { depth 3 }");
    expect(c.cte!.sql).toContain("1 >= 3 THEN 'depth'");
    expect(c.cte!.sql).toContain("w.depth + 1 >= 3 THEN 'depth'");
  });

  it("the per-row $stop CASE orders cycle → frontier → depth; walked refines leaf/interior", () => {
    const c = compileSrc('from blocks follow block.children { frontier type == "list" }');
    const step = c.cte!.sql.slice(c.cte!.sql.indexOf("UNION ALL"));
    const iC = step.indexOf("'cycle'");
    const iF = step.indexOf("'frontier'");
    const iD = step.indexOf("'depth'");
    expect(iC).toBeGreaterThanOrEqual(0);
    expect(iC).toBeLessThan(iF);
    expect(iF).toBeLessThan(iD);
    const walked = c.cte!.sql.slice(c.cte!.sql.indexOf("walked AS ("));
    expect(walked).toContain("THEN 'leaf'");
    expect(walked).toContain("ELSE 'interior'");
  });

  it("`follow distinct` adds the min-occurrence dedup guard; the default does not", () => {
    expect(compileSrc("from blocks follow distinct block.children").cte!.sql)
      .toMatch(/NOT EXISTS \(SELECT 1 FROM walk w2 WHERE w2\.key = walk\.key/);
    expect(compileSrc("from blocks follow block.children").cte!.sql).not.toContain("walk w2");
  });

  it("recursion intrinsics in select compile to param-free walked columns", () => {
    const c = compileSrc("from blocks select d: $depth, s: $stop follow block.children");
    const proj = c.projections.map((p) => p.sql).join(" | ");
    expect(proj).toContain("walked.wdepth");
    expect(proj).toContain("walked.wstop");
    expect(c.projections.flatMap((p) => p.params)).toEqual([]);
  });

  it("threads CTE params before the guard params (statement order)", () => {
    const c = compileSrc('from blocks where type == "list_item" follow block.children { frontier type == "list" }');
    expect(c.cte!.params).toContain("list_item");
    expect(c.cte!.params).toContain("list");
    expect(c.whereParams).toEqual(["rp_1"]);
  });

  it("a non-follow query is unchanged (no cte)", () => {
    expect(compileSrc('from blocks where type == "task"').cte).toBeUndefined();
  });
});
