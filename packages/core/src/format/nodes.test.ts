import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ingestFile } from "../core/ingest.js";
import { oqxRun } from "../oqx/run.js";
import "../format/index.js";

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setup(): { store: Store; repoId: string } {
  store = new Store({ path: ":memory:" });
  store.db.prepare("INSERT INTO repos (repo_id, slug, root_path) VALUES ('rp_1','test','/tmp')").run();
  return { store, repoId: "rp_1" };
}

describe("node projection — markdown", () => {
  it("projects md:link nodes from markdown links", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Hello\n\nSee [docs](/docs/guide.md) and [api](/api.md).\n");

    const rows = store.db.prepare("SELECT kind, name, value FROM nodes WHERE doc_id IN (SELECT doc_id FROM docs WHERE path = 'test.md')").all() as { kind: string; name: string | null; value: string | null }[];
    const links = rows.filter((r) => r.kind === "md:link");
    expect(links.length).toBe(2);
    expect(links.map((l) => l.value)).toContain("/docs/guide.md");
    expect(links.map((l) => l.value)).toContain("/api.md");
  });

  it("anchors nodes to their real block id and records exact spans", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Hello\n\nSee [a](/x.md) then [b](/y.md) here.\n");

    const rows = store.db.prepare(
      `SELECT n.kind, n.value, n.block_id, n.span_start, n.span_end,
              substr(bl_blob.bytes, n.span_start + 1, n.span_end - n.span_start) AS sliced
       FROM nodes n
       JOIN blocks bl ON bl.block_id = n.block_id
       JOIN blobs bl_blob ON bl_blob.hash = bl.raw_hash
       WHERE n.kind = 'md:link' ORDER BY n.span_start`,
    ).all() as { kind: string; value: string; block_id: string; span_start: number; span_end: number; sliced: Buffer }[];

    expect(rows.length).toBe(2);
    // Both links anchor to a real b_ block id (regression: block_id was NULL).
    expect(rows.every((r) => r.block_id?.startsWith("b_"))).toBe(true);
    // Both links are in the SAME paragraph block.
    expect(rows[0]!.block_id).toBe(rows[1]!.block_id);
    // Spans slice the block's raw bytes to exactly the link markup — this is
    // what disambiguates the two links for surgical node-prop edits. (blobs.bytes
    // is a BLOB column, so substr returns a Buffer.)
    expect(rows[0]!.sliced.toString("utf8")).toBe("[a](/x.md)");
    expect(rows[1]!.sliced.toString("utf8")).toBe("[b](/y.md)");
  });

  it("projects md:wikilink nodes", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Hello\n\nSee [[other note]] and [[second note]].\n");

    const rows = store.db.prepare("SELECT kind, value FROM nodes WHERE doc_id IN (SELECT doc_id FROM docs WHERE path = 'test.md')").all() as { kind: string; value: string | null }[];
    const wikilinks = rows.filter((r) => r.kind === "md:wikilink");
    expect(wikilinks.length).toBe(2);
  });

  it("projects md:task nodes with checked state", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "- [x] done\n- [ ] todo\n- regular item\n");

    const rows = store.db.prepare("SELECT kind, value, attrs FROM nodes WHERE doc_id IN (SELECT doc_id FROM docs WHERE path = 'test.md')").all() as { kind: string; value: string | null; attrs: string }[];
    const tasks = rows.filter((r) => r.kind === "md:task");
    expect(tasks.length).toBe(2);
    const checked = tasks.filter((t) => JSON.parse(t.attrs).checked === true);
    expect(checked.length).toBe(1);
  });

  it("projects md:inline_field nodes", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Note\n\nstatus:: active\npriority:: high\n");

    const rows = store.db.prepare("SELECT kind, name, value FROM nodes WHERE doc_id IN (SELECT doc_id FROM docs WHERE path = 'test.md')").all() as { kind: string; name: string | null; value: string | null }[];
    const fields = rows.filter((r) => r.kind === "md:inline_field");
    expect(fields.length).toBe(2);
    expect(fields.map((f) => f.name)).toContain("status");
    expect(fields.map((f) => f.name)).toContain("priority");
  });
});

describe("node projection — yaml", () => {
  it("projects yaml:env_var nodes from ${VAR} patterns", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "config.yaml", "database:\n  host: ${DB_HOST}\n  password: ${DB_PASSWORD}\n");

    const rows = store.db.prepare("SELECT kind, name FROM nodes WHERE doc_id IN (SELECT doc_id FROM docs WHERE path = 'config.yaml')").all() as { kind: string; name: string | null }[];
    const envVars = rows.filter((r) => r.kind === "yaml:env_var");
    expect(envVars.length).toBeGreaterThanOrEqual(2);
    expect(envVars.map((e) => e.name)).toContain("DB_HOST");
    expect(envVars.map((e) => e.name)).toContain("DB_PASSWORD");
  });
});

describe("node queries — from: nodes", () => {
  it("queries nodes by kind", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Hello\n\nSee [docs](/guide.md).\n\n- [x] done\n- [ ] todo\n");

    const links = oqxRun(store, repoId, 'from nodes where kind == "md:link"');
    expect(links.hits.length).toBe(1);

    const tasks = oqxRun(store, repoId, 'from nodes where kind == "md:task"');
    expect(tasks.hits.length).toBe(2);
  });

  it("queries nodes by name", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Note\n\nstatus:: active\npriority:: high\n");

    const status = oqxRun(store, repoId, 'from nodes where name == "status"');
    expect(status.hits.length).toBe(1);
  });

  it("queries nodes by value", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Note\n\nstatus:: active\npriority:: high\n");

    const active = oqxRun(store, repoId, 'from nodes where value == "active"');
    expect(active.hits.length).toBe(1);
  });

  it("queries nodes with kind.startsWith across formats", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Hello\n\nSee [docs](/guide.md).\n");
    ingestFile(store, repoId, "config.yaml", "database:\n  host: ${DB_HOST}\n");

    const mdNodes = oqxRun(store, repoId, 'from nodes where kind.startsWith("md:")');
    expect(mdNodes.hits.length).toBeGreaterThan(0);

    const yamlNodes = oqxRun(store, repoId, 'from nodes where kind.startsWith("yaml:")');
    expect(yamlNodes.hits.length).toBeGreaterThan(0);
  });

  it("queries nodes with doc.format reach-through", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Hello\n\nSee [docs](/guide.md).\n");
    ingestFile(store, repoId, "config.yaml", "database:\n  host: ${DB_HOST}\n");

    const yamlOnly = oqxRun(store, repoId, 'from nodes where doc.format == "yaml" select kind: kind');
    expect(yamlOnly.hits.length).toBeGreaterThan(0);
    expect(yamlOnly.hits.every((h) => (h as Record<string, unknown>).kind?.toString().startsWith("yaml:"))).toBe(true);
  });

  it("queries nodes with text search on name/value", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Note\n\nstatus:: active\npriority:: high\n");

    const results = oqxRun(store, repoId, 'from nodes where text("active")');
    expect(results.hits.length).toBeGreaterThan(0);
  });

  it("queries nodes with attrs filter", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "- [x] done\n- [ ] todo\n");

    const checked = oqxRun(store, repoId, 'from nodes where kind == "md:task" && attrs.checked == true');
    expect(checked.hits.length).toBe(1);
  });

  it("returns kind, name, value in hits", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "test.md", "# Note\n\nstatus:: active\n");

    const results = oqxRun(store, repoId, 'from nodes where kind == "md:inline_field" select kind: kind, name: name, value: value');
    expect(results.hits.length).toBe(1);
    const hit = results.hits[0]!;
    expect(hit.kind).toBe("md:inline_field");
    expect(hit.name).toBe("status");
    expect(hit.value).toBe("active");
  });
});
