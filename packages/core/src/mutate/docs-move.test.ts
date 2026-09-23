import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { linksStale } from "../graph/link-health.js";
import { inboundLinksTo, retargetLinksInRaw } from "../graph/inbound-links.js";
import { docsMove } from "./docs.js";

// docs_move and the edge index. Links follow the PATH: after a move, inbound
// links written against the old path dangle (links_stale must see them), and
// phantoms already written against the new path must resolve to the moved doc.

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-docsmove-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}
function docId(path: string): string {
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path = ? AND deleted_commit IS NULL").get(path) as { doc_id: string }).doc_id;
}
function openEdgesTo(dst: string): { src_doc: string; src_block: string | null; anchor: string | null }[] {
  return store.db.prepare("SELECT src_doc, src_block, anchor FROM edges WHERE dst_node = ? AND to_commit IS NULL ORDER BY src_doc").all(dst) as { src_doc: string; src_block: string | null; anchor: string | null }[];
}
const ctx = () => ({ repoId, rootPath: dir });

describe("docsMove — edge index follows the path", () => {
  it("phantom edges already pointing at the destination resolve to the moved doc", () => {
    save("a.md", "# A\n\nSee [new](/new.md) soon.\n");
    save("old.md", "# Old\n");
    expect(openEdgesTo("phantom:new.md")).toHaveLength(1);
    expect(linksStale(store, repoId).stale.map((s) => s.target)).toEqual(["new.md"]);

    const res = docsMove(store, ctx(), "old.md", "new.md");
    expect(res.path).toBe("new.md");
    expect(res.dangling).toEqual([]);
    expect(openEdgesTo("phantom:new.md")).toHaveLength(0);
    expect(openEdgesTo(res.docId).map((e) => e.src_doc)).toEqual([docId("a.md")]);
    expect(linksStale(store, repoId).stale).toEqual([]);
    // doc_edges rollup for the source follows.
    const roll = store.db.prepare("SELECT dst_node FROM doc_edges WHERE src_doc = ?").all(docId("a.md")) as { dst_node: string }[];
    expect(roll.map((r) => r.dst_node)).toEqual([res.docId]);
  });

  it("reports the inbound links that now dangle, and links_stale sees them", () => {
    save("old.md", "# Old\n\n## Top\n\ntext\n");
    save("b.md", "# B\n\nSee [old](/old.md#Top) here.\n");
    save("c.md", "# C\n\n- item [[old.md]]\n");
    save("sub/d.md", "# D\n\nUp [old](../old.md).\n");
    expect(linksStale(store, repoId).stale).toEqual([]);
    const oldId = docId("old.md");
    const inboundBefore = openEdgesTo(oldId).length;
    expect(inboundBefore).toBeGreaterThanOrEqual(3);

    const res = docsMove(store, ctx(), "old.md", "moved/new.md");
    const byPath = new Map(res.dangling.map((d) => [d.path, d]));
    expect([...byPath.keys()].sort()).toEqual(["b.md", "c.md", "sub/d.md"]);
    expect(byPath.get("b.md")).toMatchObject({ doc: docId("b.md"), target: "/old.md", anchor: "Top" });
    expect(byPath.get("c.md")).toMatchObject({ doc: docId("c.md"), target: "old.md", anchor: null });
    expect(byPath.get("sub/d.md")).toMatchObject({ doc: docId("sub/d.md"), target: "../old.md", anchor: null });
    for (const d of res.dangling) expect(typeof d.block).toBe("string");
    expect(res.retargeted).toBeNull();

    // The edge index agrees: nothing open points at the doc; the old path's
    // phantom carries every former inbound row, and links_stale reports them.
    expect(openEdgesTo(oldId)).toHaveLength(0);
    expect(openEdgesTo("phantom:old.md")).toHaveLength(inboundBefore);
    const stale = linksStale(store, repoId).stale;
    // (c.md's wikilink sits in a list item, so the list AND the item each carry
    // an edge — one stale row per edge, both dangling.)
    expect(stale).toHaveLength(inboundBefore);
    expect(new Set(stale.map((s) => s.srcPath))).toEqual(new Set(["b.md", "c.md", "sub/d.md"]));
    expect(stale.every((s) => s.target === "old.md")).toBe(true);
    // The moved doc itself is fine on disk and in the DB.
    expect(existsSync(join(dir, "moved/new.md"))).toBe(true);
    expect(existsSync(join(dir, "old.md"))).toBe(false);
  });

  it("a self-doc pure-fragment link is not path-dependent; a self-doc path link is", () => {
    // Distinct anchors: `#Top` and `/old.md#Top` would collapse into ONE edge
    // row (same src/predicate/dst/anchor key), and that row must dangle.
    save("old.md", "# Old\n\n## Top\n\n## Other\n\nSee [frag](#Top) and [self](/old.md#Other).\n");
    const oldId = docId("old.md");
    expect(openEdgesTo(oldId)).toHaveLength(2);

    const res = docsMove(store, ctx(), "old.md", "new.md");
    expect(res.dangling).toHaveLength(1);
    expect(res.dangling[0]).toMatchObject({ doc: oldId, path: "old.md", target: "/old.md", anchor: "Other" });
    const kept = openEdgesTo(oldId);
    expect(kept).toHaveLength(1); // the #Top fragment link stays
    expect(kept[0]!.anchor).toBe("Top");
    expect(openEdgesTo("phantom:old.md")).toHaveLength(1);
  });

  it("retargetInbound rewrites the dangling links destination-aware and leaves zero dangling", () => {
    save("old.md", "# Old\n\n## Top\n\nSee [self](/old.md#Top).\n");
    save("b.md", "# B\n\nSee [old](/old.md#Top \"title\") and `[code](/old.md)` and [other](/old.md.bak).\n");
    save("c.md", "# C\n\n- item [[old.md]]\n- rel:: /old.md\n");
    save("sub/d.md", "# D\n\nUp [old](../old.md) and [dot](./x/../../old.md).\n");
    const oldId = docId("old.md");

    const res = docsMove(store, ctx(), "old.md", "moved/new.md", { retargetInbound: true });
    expect(res.dangling).toEqual([]);
    expect(res.retargeted).not.toBeNull();
    expect(new Set(res.retargeted!.docs)).toEqual(new Set([oldId, docId("b.md"), docId("c.md"), docId("sub/d.md")]));

    // Files rewritten: anchors, titles, code spans, unrelated paths, and style preserved.
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nSee [old](/moved/new.md#Top \"title\") and `[code](/old.md)` and [other](/old.md.bak).\n");
    expect(readFileSync(join(dir, "c.md"), "utf8")).toBe("# C\n\n- item [[moved/new.md]]\n- rel:: /moved/new.md\n");
    expect(readFileSync(join(dir, "sub/d.md"), "utf8")).toBe("# D\n\nUp [old](../moved/new.md) and [dot](../moved/new.md).\n");
    // The moved doc's own path link is rewritten too (relative forms against its NEW dir).
    expect(readFileSync(join(dir, "moved/new.md"), "utf8")).toBe("# Old\n\n## Top\n\nSee [self](/moved/new.md#Top).\n");

    // Edge index: every rewritten link resolves to the moved doc; nothing dangles.
    const leftover = openEdgesTo("phantom:old.md").map((e) => ({
      path: (store.db.prepare("SELECT path FROM docs WHERE doc_id = ?").get(e.src_doc) as { path: string }).path,
      type: e.src_block ? (store.db.prepare("SELECT type FROM blocks WHERE block_id = ?").get(e.src_block) as { type: string } | undefined)?.type ?? "gone" : null,
    }));
    expect(leftover).toEqual([]);
    expect(new Set(openEdgesTo(oldId).map((e) => e.src_doc))).toEqual(new Set([oldId, docId("b.md"), docId("c.md"), docId("sub/d.md")]));
    expect(linksStale(store, repoId).stale.map((s) => s.target)).toEqual(["old.md.bak"]);
    // The rewritten links are now the moved doc's inbound set at its new path.
    const after = inboundLinksTo(store, repoId, oldId, "moved/new.md");
    expect(new Set(after.map((l) => l.path))).toEqual(new Set(["b.md", "c.md", "moved/new.md", "sub/d.md"]));
    expect(after.every((l) => l.block !== null)).toBe(true);
    // Only the deepest block per link was updated (not the list AND its item).
    const types = res.retargeted!.blocks.map((b) => (store.db.prepare("SELECT type FROM blocks WHERE block_id = ?").get(b) as { type: string } | undefined)?.type);
    expect(types).not.toContain("list");
  });

  it("frontmatter relations are reported as dangling (block null) and not rewritten", () => {
    save("old.md", "# Old\n");
    save("fm.md", "---\ndepends_on: /old.md\n---\n\n# FM\n");
    const res = docsMove(store, ctx(), "old.md", "new.md", { retargetInbound: true });
    expect(res.dangling).toEqual([{ doc: docId("fm.md"), path: "fm.md", block: null, target: "old.md", anchor: null, field: "depends_on" }]);
    expect(linksStale(store, repoId).stale.map((s) => s.srcPath)).toEqual(["fm.md"]);
  });
});

describe("retargetLinksInRaw — destination-aware, not substring", () => {
  it("rewrites only destinations that resolve to the old path, keeping style, anchors, titles, and code", () => {
    const raw = 'A [x](/old.md#H "t"), ![i](old.md), [[old.md^r]], `[c](/old.md)`, [y](/old.md.bak), [z](/other/old.md), key:: /old.md';
    expect(retargetLinksInRaw(raw, "", "", "old.md", "new/n.md")).toBe(
      'A [x](/new/n.md#H "t"), ![i](new/n.md), [[new/n.md^r]], `[c](/old.md)`, [y](/old.md.bak), [z](/other/old.md), key:: /new/n.md',
    );
  });
  it("recomputes relative forms against the writer's directory", () => {
    expect(retargetLinksInRaw("[a](../old.md) [b](./old.md)", "a/", "a/", "old.md", "b/c/new.md")).toBe("[a](../b/c/new.md) [b](./old.md)");
    expect(retargetLinksInRaw("[a](./old.md)", "a/", "a/", "a/old.md", "a/new.md")).toBe("[a](./new.md)");
  });
  it("returns null when nothing resolves to the old path", () => {
    expect(retargetLinksInRaw("plain text [x](/other.md)", "", "", "old.md", "new.md")).toBeNull();
  });
});
