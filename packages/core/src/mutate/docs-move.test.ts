import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { linksStale } from "../graph/link-health.js";
import { inboundLinksTo, retargetLinksInRaw } from "../graph/inbound-links.js";
import { docsMove } from "./doc-ops.test.helpers.js";
import { createEffects, deleteDocEffects, moveDocEffects, setMetaEffects } from "./sugar.js";
import { planEffects } from "./plan.js";
import { FsDocStore, type DocStore } from "./doc-store.js";
import { writerLockFree, writerLockHeld } from "../sync/writer-lock.js";

// docs_move and the edge index. Links follow the PATH: after a move, inbound
// links written against the old path dangle (links_stale must see them) unless
// the move rewrites them — which it does by default (spec/mutate 1.3;
// `retargetInbound: false` opts out) — and phantoms already written against the
// new path must resolve to the moved doc. The operations are the effect
// builders of `sugar.ts` (3.0); `docsMove` here is the test shim over them.

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
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path = ? AND deleted_at IS NULL").get(path) as { doc_id: string }).doc_id;
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
    expect(linksStale(store, repoId).stale.map((s) => s.target)).toEqual(["/new.md"]);

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

  it("retargetInbound: false leaves the inbound links as written, reports them, and links_stale sees them", () => {
    save("old.md", "# Old\n\n## Top\n\ntext\n");
    save("b.md", "# B\n\nSee [old](/old.md#Top) here.\n");
    save("c.md", "# C\n\n- item [[old.md]]\n");
    save("sub/d.md", "# D\n\nUp [old](../old.md).\n");
    expect(linksStale(store, repoId).stale).toEqual([]);
    const oldId = docId("old.md");
    const inboundBefore = openEdgesTo(oldId).length;
    expect(inboundBefore).toBeGreaterThanOrEqual(3);

    const res = docsMove(store, ctx(), "old.md", "moved/new.md", { retargetInbound: false });
    const byPath = new Map(res.dangling.map((d) => [d._path, d]));
    expect([...byPath.keys()].sort()).toEqual(["b.md", "c.md", "sub/d.md"]);
    expect(byPath.get("b.md")).toMatchObject({ _doc_id: docId("b.md"), target: "/old.md", _anchor: "Top" });
    expect(byPath.get("c.md")).toMatchObject({ _doc_id: docId("c.md"), target: "old.md", _anchor: null });
    expect(byPath.get("sub/d.md")).toMatchObject({ _doc_id: docId("sub/d.md"), target: "../old.md", _anchor: null });
    for (const d of res.dangling) expect(typeof d._block_id).toBe("string");
    expect(res.retargeted).toBeNull();

    // The edge index agrees: nothing open points at the doc; the old path's
    // phantom carries every former inbound row, and links_stale reports them.
    expect(openEdgesTo(oldId)).toHaveLength(0);
    expect(openEdgesTo("phantom:old.md")).toHaveLength(inboundBefore);
    const stale = linksStale(store, repoId).stale;
    // (c.md's wikilink sits in a list item, so the list AND the item each carry
    // an edge — one stale row per edge, both dangling.)
    expect(stale).toHaveLength(inboundBefore);
    expect(new Set(stale.map((s) => s._path))).toEqual(new Set(["/b.md", "/c.md", "/sub/d.md"]));
    expect(stale.every((s) => s.target === "/old.md")).toBe(true);
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

    const res = docsMove(store, ctx(), "old.md", "new.md", { retargetInbound: false });
    expect(res.dangling).toHaveLength(1);
    expect(res.dangling[0]).toMatchObject({ _doc_id: oldId, _path: "old.md", target: "/old.md", _anchor: "Other" });
    const kept = openEdgesTo(oldId);
    expect(kept).toHaveLength(1); // the #Top fragment link stays
    expect(kept[0]!.anchor).toBe("Top");
    expect(openEdgesTo("phantom:old.md")).toHaveLength(1);
  });

  it("by default the move rewrites the dangling links destination-aware and leaves zero dangling", () => {
    save("old.md", "# Old\n\n## Top\n\nSee [self](/old.md#Top).\n");
    save("b.md", "# B\n\nSee [old](/old.md#Top \"title\") and `[code](/old.md)` and [other](/old.md.bak).\n");
    save("c.md", "# C\n\n- item [[old.md]]\n- rel:: /old.md\n");
    save("sub/d.md", "# D\n\nUp [old](../old.md) and [dot](./x/../../old.md).\n");
    const oldId = docId("old.md");

    const res = docsMove(store, ctx(), "old.md", "moved/new.md");
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
    expect(linksStale(store, repoId).stale.map((s) => s.target)).toEqual(["/old.md.bak"]);
    // The rewritten links are now the moved doc's inbound set at its new path.
    const after = inboundLinksTo(store, repoId, oldId, "moved/new.md");
    expect(new Set(after.map((l) => l._path))).toEqual(new Set(["b.md", "c.md", "moved/new.md", "sub/d.md"]));
    expect(after.every((l) => l._block_id !== null)).toBe(true);
    // Only the deepest block per link was updated (not the list AND its item).
    const types = res.retargeted!.blocks.map((b) => (store.db.prepare("SELECT type FROM blocks WHERE block_id = ?").get(b) as { type: string } | undefined)?.type);
    expect(types).not.toContain("list");
  });

  it("frontmatter relations are reported as dangling (block null) and not rewritten", () => {
    save("old.md", "# Old\n");
    save("fm.md", "---\ndepends_on: /old.md\n---\n\n# FM\n");
    const res = docsMove(store, ctx(), "old.md", "new.md");
    expect(res.dangling).toEqual([{ _doc_id: docId("fm.md"), _path: "fm.md", _block_id: null, target: "old.md", _anchor: null, _field: "depends_on" }]);
    // The rewrite ran and touched nothing: empty lists, not null (null = opted out or nothing linked in).
    expect(res.retargeted).toEqual({ blocks: [], docs: [] });
    expect(linksStale(store, repoId).stale.map((s) => s._path)).toEqual(["/fm.md"]);
  });
});

describe("document operations — `plan` over the builders' effects validates, previews, commits nothing (spec/cli §3.6, 4.0)", () => {
  const commits = (): number => (store.db.prepare("SELECT count(*) n FROM commits").get() as { n: number }).n;
  const docOf = (path: string) => ({ _id: docId(path), _path: path });
  const plan = (effects: unknown) => planEffects(store, { repoId, rootPath: dir, effects });

  it("a create plans the would-be file under a symbolic id ($new.0) and mints nothing; the file is not written", () => {
    save("a.md", "# A\n");
    const n = commits();
    const p = plan(createEffects("/new/b.md", "# B\n\nbody", { title: "B" }).effects);
    expect(p.new_ids[0]).toEqual({ symbol: "$new.0", kind: "document" });
    expect(p.preview!.revisions[0]).toMatchObject({ _id: "$new.0", _path: "new/b.md" });
    expect(p.preview!.diffs).toEqual({ "new/b.md": { before: "", after: "---\ntitle: B\n---\n\n# B\n\nbody\n" } });
    expect(existsSync(join(dir, "new/b.md"))).toBe(false);
    expect(store.db.prepare("SELECT 1 FROM docs WHERE path = 'new/b.md'").get()).toBeUndefined();
    expect(commits()).toBe(n);
    // Validation still runs.
    expect(() => plan(createEffects("a.md", "x").effects)).toThrow(/path_taken|already exists/);
  });

  it("a move with retarget_inbound: false plans the rename as two file diffs and leaves the tree alone", () => {
    save("a.md", "# A\n\nSee [old](/old.md).\n");
    save("old.md", "# Old\n");
    const n = commits();
    const p = plan(moveDocEffects(docOf("old.md"), "moved/new.md", false).effects);
    expect(p.preview!.diffs).toEqual({ "old.md": { before: "# Old\n", after: "" }, "moved/new.md": { before: "", after: "# Old\n" } });
    expect(p.opset.moves).toEqual([{ _id: docId("old.md"), from: "old.md", to: "moved/new.md" }]);
    expect(existsSync(join(dir, "old.md"))).toBe(true);
    expect(existsSync(join(dir, "moved/new.md"))).toBe(false);
    expect(docId("old.md")).toBeDefined();
    expect(commits()).toBe(n);
    expect(() => plan(moveDocEffects(docOf("old.md"), "a.md").effects)).toThrow(/path_taken|already exists/);
    expect(() => plan([{ op: "move", target: { kind: "document", _path: "nope.md" }, to: "x.md" }])).toThrow(/doc_missing|no document|not found/);
  });

  it("a move's plan previews the rewritten sources too (the default retarget)", () => {
    save("a.md", "# A\n\nSee [old](/old.md).\n");
    save("old.md", "# Old\n");
    const p = plan(moveDocEffects(docOf("old.md"), "moved/new.md").effects);
    expect(p.opset.ops).toHaveLength(1);
    expect(p.preview!.diffs["a.md"]).toEqual({ before: "# A\n\nSee [old](/old.md).\n", after: "# A\n\nSee [old](/moved/new.md).\n" });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nSee [old](/old.md).\n");
  });

  it("a delete plans the file's removal and keeps the document live", () => {
    save("a.md", "# A\n");
    const n = commits();
    const p = plan(deleteDocEffects(docOf("a.md")).effects);
    expect(p.opset.tombstones).toEqual([{ _id: docId("a.md"), _path: "a.md" }]);
    expect(p.preview!.diffs).toEqual({ "a.md": { before: "# A\n", after: "" } });
    expect(existsSync(join(dir, "a.md"))).toBe(true);
    expect(commits()).toBe(n);
  });

  it("a frontmatter patch plans the patched file without writing it", () => {
    save("a.md", "---\nlayer: draft\nera: 1677\n---\n\n# A\n");
    const n = commits();
    const p = plan(setMetaEffects(docOf("a.md"), { era: 1702 }, ["layer"]).effects);
    expect(p.preview!.diffs).toEqual({ "a.md": { before: "---\nlayer: draft\nera: 1677\n---\n\n# A\n", after: "---\nera: 1702\n---\n\n# A\n" } });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("---\nlayer: draft\nera: 1677\n---\n\n# A\n");
    expect(commits()).toBe(n);
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

describe("docsMove under the workspace writer lock (spec/sync §7: one acquire across rename + retarget)", () => {
  it("holds the lock continuously from the rename through the inbound retarget's commit", () => {
    save("old.md", "# Old\n\n## Top\n\ntext\n");
    save("b.md", "# B\n\nSee [old](/old.md#Top) here.\n");
    save("c.md", "# C\n\n- item [[old.md]]\n");
    const omgbaseDir = join(dir, ".omgbase");
    const lockFile = join(omgbaseDir, "writer.lock");

    // Observe the lock from inside the operation through the DocStore seam: the
    // rename is the move's own write, the writes are the retarget changeset's
    // commit phase (apply → FsDocStore.write per rewritten source).
    const seen: { op: string; path: string; held: boolean; ino: number | null }[] = [];
    const probe = (op: string, path: string): void => {
      seen.push({ op, path, held: writerLockHeld(omgbaseDir), ino: existsSync(lockFile) ? statSync(lockFile).ino : null });
    };
    const fs = new FsDocStore(dir);
    const docStore: DocStore = {
      exists: (p) => fs.exists(p),
      read: (p) => fs.read(p),
      write: (p, bytes) => { probe("write", p); fs.write(p, bytes); },
      rename: (from, to) => { probe("rename", from); fs.rename(from, to); },
      remove: (p) => fs.remove(p),
      recordStat: (s, r, p, bytes) => fs.recordStat(s, r, p, bytes),
      clearStat: (s, r, p) => fs.clearStat(s, r, p),
    };

    expect(writerLockHeld(omgbaseDir)).toBe(false);
    const res = docsMove(store, { repoId, rootPath: dir, omgbaseDir, docStore }, "old.md", "moved/new.md");
    expect(res.retargeted?.docs.length).toBe(2);
    expect(res.dangling).toEqual([]);

    expect(seen.map((s) => s.op)).toEqual(["rename", "write", "write"]);
    expect(seen.map((s) => s.path).sort()).toEqual(["b.md", "c.md", "old.md"]);
    for (const s of seen) expect(s, `${s.op} ${s.path} ran outside the lock`).toMatchObject({ held: true });
    // One acquire: the very same lock file (inode) existed through every step —
    // it was never released and re-created between the rename and the retarget.
    const inodes = new Set(seen.map((s) => s.ino));
    expect(inodes.size).toBe(1);
    expect([...inodes][0]).not.toBeNull();
    // Released once the whole operation returned.
    expect(writerLockHeld(omgbaseDir)).toBe(false);
    expect(writerLockFree(omgbaseDir)).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
    // And the rewrite landed.
    expect(readFileSync(join(dir, "b.md"), "utf8")).toContain("(/moved/new.md#Top)");
    expect(readFileSync(join(dir, "c.md"), "utf8")).toContain("[[moved/new.md]]");
  });

  it("releases the lock when the retarget half fails after the rename committed", () => {
    save("old.md", "# Old\n");
    save("b.md", "# B\n\nSee [old](/old.md).\n");
    const omgbaseDir = join(dir, ".omgbase");
    const fs = new FsDocStore(dir);
    const docStore: DocStore = {
      exists: (p) => fs.exists(p),
      read: (p) => fs.read(p),
      write: () => { throw new Error("disk full"); }, // the retarget's commit phase fails
      rename: (from, to) => fs.rename(from, to),
      remove: (p) => fs.remove(p),
      recordStat: (s, r, p, bytes) => fs.recordStat(s, r, p, bytes),
      clearStat: (s, r, p) => fs.clearStat(s, r, p),
    };
    expect(() => docsMove(store, { repoId, rootPath: dir, omgbaseDir, docStore }, "old.md", "new.md")).toThrow("disk full");
    expect(writerLockHeld(omgbaseDir)).toBe(false);
    expect(writerLockFree(omgbaseDir)).toBe(true);
  });
});
