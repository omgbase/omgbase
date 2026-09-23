import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { rebuildDocEdges } from "../core/store/edges.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-edges-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(path: string, content: string): void {
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}
function openEdges(): { predicate: string; dst_node: string }[] {
  return store.db.prepare("SELECT predicate, dst_node FROM edges WHERE to_commit IS NULL ORDER BY predicate, dst_node").all() as { predicate: string; dst_node: string }[];
}

describe("edge interval maintenance (05 §2)", () => {
  it("opens edges on ingest with resolved targets + phantom docs", () => {
    save("a.md", "# A\n\nSee [foo](/foo.md) and [[Bar Note]].\n\nrelated:: [[Baz]]\n");
    const edges = openEdges();
    // references → /foo.md (phantom), references → Bar Note (phantom), related → Baz
    expect(edges.find((e) => e.predicate === "references" && e.dst_node === "phantom:foo.md")).toBeTruthy();
    expect(edges.some((e) => e.predicate === "related")).toBe(true);
  });

  it("closes an edge row when its link is removed (interval closed)", () => {
    save("a.md", "# A\n\nlink to [foo](/foo.md) here\n");
    expect(openEdges().some((e) => e.dst_node === "phantom:foo.md")).toBe(true);

    save("a.md", "# A\n\nno more links here at all\n");
    expect(openEdges().some((e) => e.dst_node === "phantom:foo.md")).toBe(false);

    // The historical row still exists but is closed (to_commit set).
    const closed = store.db.prepare("SELECT count(*) c FROM edges WHERE dst_node='phantom:foo.md' AND to_commit IS NOT NULL").get() as { c: number };
    expect(closed.c).toBe(1);
  });

  it("phantom resolves to the real doc id once the target is created", () => {
    save("a.md", "# A\n\nlink to [foo](/foo.md)\n");
    expect(openEdges().some((e) => e.dst_node === "phantom:foo.md")).toBe(true);
    // Create foo.md, then re-save a.md so extraction resolves to the real id.
    save("foo.md", "# Foo\n");
    save("a.md", "# A\n\nlink to [foo](/foo.md) still\n");
    const fooId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='foo.md'").get() as { doc_id: string }).doc_id;
    expect(openEdges().some((e) => e.dst_node === fooId)).toBe(true);
    expect(openEdges().some((e) => e.dst_node === "phantom:foo.md")).toBe(false);
  });

  it("doc_edges rollup equals a fresh rebuild", () => {
    // /x.md linked from two DIFFERENT blocks → rollup count 2 (same-block
    // duplicates dedupe at extraction, so use separate paragraphs).
    save("a.md", "# A\n\nfirst para links [x](/x.md) here\n\nsecond para links [x again](/x.md)\n\nthird [y](/y.md)\n");
    const docId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='a.md'").get() as { doc_id: string }).doc_id;
    const before = store.db.prepare("SELECT predicate, dst_node, count, samples FROM doc_edges WHERE src_doc=? ORDER BY dst_node").all(docId);
    const xRow = (before as { dst_node: string; count: number }[]).find((r) => r.dst_node === "phantom:x.md");
    expect(xRow!.count).toBe(2);

    store.write((db) => rebuildDocEdges(db, docId));
    const after = store.db.prepare("SELECT predicate, dst_node, count, samples FROM doc_edges WHERE src_doc=? ORDER BY dst_node").all(docId);
    expect(after).toEqual(before);
  });
});

describe("maintainEdges keeps one open row per key", () => {
  it("two spellings of one target in one block open ONE row, and removing the link closes it", () => {
    mkdirSync(join(dir, "sub"), { recursive: true });
    save("old.md", "# Old\n");
    save("sub/d.md", "# D\n\nUp [a](../old.md) and [b](./x/../../old.md).\n");
    const oldId = (store.db.prepare("SELECT doc_id FROM docs WHERE path='old.md'").get() as { doc_id: string }).doc_id;
    const open = (): number => (store.db.prepare("SELECT count(*) c FROM edges WHERE dst_node = ? AND to_commit IS NULL").get(oldId) as { c: number }).c;
    expect(open()).toBe(1);

    // Re-saving unchanged keeps the single row; dropping the links closes it.
    save("sub/d.md", "# D\n\nUp [a](../old.md) and [b](./x/../../old.md) still.\n");
    expect(open()).toBe(1);
    save("sub/d.md", "# D\n\nno links\n");
    expect(open()).toBe(0);
  });

  it("closes pre-existing duplicate open rows on the next ingest", () => {
    save("a.md", "# A\n\nlink [x](/x.md)\n");
    const row = store.db.prepare("SELECT * FROM edges WHERE to_commit IS NULL").get() as Record<string, unknown>;
    // Simulate the duplicate an earlier maintainEdges could leave behind.
    store.write((db) => {
      db.prepare(
        `INSERT INTO edges (edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, from_commit, to_commit)
         VALUES ('e_dup', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(row.repo_id, row.src_doc, row.src_block, row.src_field, row.predicate, row.dst_kind, row.dst_node, row.anchor, row.provenance, row.from_commit);
    });
    expect(openEdges()).toHaveLength(2);
    save("a.md", "# A\n\nlink [x](/x.md) again\n");
    expect(openEdges()).toHaveLength(1);
  });
});

describe("code-aware extraction through ingest (extraction_version x2)", () => {
  it("links inside a fence or inline code never become edges; the prose link does", () => {
    save(
      "code.md",
      [
        "# Code",
        "",
        "Write `[[Fake Note]]` to link, or `[t](/fake.md)`.",
        "",
        "```md",
        "[placeholder](/in-fence.md) and [[In Fence]]",
        "```",
        "",
        "Prose [[Real Note]] and [real](/real.md) plus `[[Also Fake]]`.",
        "",
      ].join("\n"),
    );
    const targets = openEdges().map((e) => e.dst_node);
    expect(targets).toContain("phantom:Real Note");
    expect(targets).toContain("phantom:real.md");
    expect(targets.some((t) => /fake|Fake|fence|Fence/.test(t))).toBe(false);
    expect(openEdges()).toHaveLength(2);
  });
});
