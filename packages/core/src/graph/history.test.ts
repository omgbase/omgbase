import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { historyNode, diffBlocks, changesSince, docHistory } from "./history.js";
import { oqxRun } from "../oqx/run.js";
import { docsDelete } from "../mutate/docs.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-hist-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(path: string, content: string): void {
  const abs = join(dir, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}
function docId(path: string): string {
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path=?").get(path) as { doc_id: string }).doc_id;
}
function blockByText(path: string, prefix: string): string {
  const rows = store.db.prepare("SELECT block_id, text FROM blocks WHERE doc_id = ?").all(docId(path)) as { block_id: string; text: string }[];
  return rows.find((r) => r.text.startsWith(prefix))!.block_id;
}

describe("history_node", () => {
  it("records a block's biography across commits (inserted then edited)", () => {
    save("a.md", "# H\n\nthe original paragraph text stays long enough to carry\n");
    const bId = blockByText("a.md", "the original");
    save("a.md", "# H\n\nthe original paragraph text stays long enough to persist\n");
    const hist = historyNode(store, bId);
    expect(hist.length).toBeGreaterThanOrEqual(2);
    // Newest first: an edited/edited_moved after the original inserted.
    expect(hist[0]!.kind).toMatch(/edited/);
    expect(hist[hist.length - 1]!.kind).toBe("inserted");
  });
});

describe("diff (block grain)", () => {
  it("reports added/removed/changed blocks between revisions", () => {
    save("a.md", "# H\n\nkeep me around please\n\nremove me later\n");
    const rev1 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='a.md'").get() as { current_rev: string }).current_rev;
    save("a.md", "# H\n\nkeep me around please\n\nbrand new paragraph here\n");
    const rev2 = (store.db.prepare("SELECT current_rev FROM docs WHERE path='a.md'").get() as { current_rev: string }).current_rev;

    const diff = diffBlocks(store, docId("a.md"), rev1, rev2);
    expect(diff.some((d) => d.kind === "removed" && d.before?.includes("remove me"))).toBe(true);
    expect(diff.some((d) => d.kind === "added" && d.after?.includes("brand new"))).toBe(true);
  });
});

describe("changes_since (change feed)", () => {
  it("returns commit digests after a cursor with summaries", () => {
    save("a.md", "# A\n");
    save("b.md", "# B\n");
    const { digests, truncated } = changesSince(store, repoId, { cursor: 0 });
    expect(digests.length).toBe(2);
    expect(truncated).toBe(false);
    expect(digests[0]!.summary).toContain("observed");
    expect(digests[0]!.revisions[0]!.path).toBe("a.md");
  });

  it("advances the cursor for incremental polling", () => {
    save("a.md", "# A\n");
    const first = changesSince(store, repoId, { cursor: 0 });
    save("b.md", "# B\n");
    const second = changesSince(store, repoId, { cursor: first.cursor });
    expect(second.digests.map((d) => d.revisions[0]!.path)).toEqual(["b.md"]);
  });
});

describe("docHistory (version-history listing)", () => {
  function contentHash(path: string, rev: string): string {
    return (store.db.prepare("SELECT rendered_hash FROM revisions WHERE rev_id = ? AND doc_id = ?").get(rev, docId(path)) as { rendered_hash: Buffer }).rendered_hash.toString("hex");
  }

  it("groups by document, orders versions by seq, and excludes non-matching paths", () => {
    save("journal/2026/a.md", "# A\n\nfirst version of a paragraph\n");
    save("journal/2026/a.md", "# A\n\nsecond version of a paragraph\n");
    save("journal/2026/b.md", "# B\n\nonly version of b\n");
    save("other/c.md", "# C\n");

    const { docs, truncated } = docHistory(store, repoId, { pathGlob: "journal/*" });
    expect(truncated).toBe(false);
    expect(docs.map((d) => d.path)).toEqual(["journal/2026/a.md", "journal/2026/b.md"]);

    const a = docs.find((d) => d.path === "journal/2026/a.md")!;
    expect(a.versions.length).toBe(2);
    // seq ascending (chronological).
    expect(a.versions[0]!.seq).toBeLessThan(a.versions[1]!.seq);
    // isCurrent only on the latest.
    expect(a.versions.filter((v) => v.isCurrent).map((v) => v.rev)).toEqual([a.currentRev]);
    expect(a.versions[a.versions.length - 1]!.isCurrent).toBe(true);
    // contentHash matches the stored rendered_hash.
    for (const v of a.versions) expect(v.contentHash).toBe(contentHash("journal/2026/a.md", v.rev));
    expect(a.deleted).toBe(false);
  });

  it("journal/** is equivalent to journal/* (* spans /)", () => {
    save("journal/2026/a.md", "# A\n");
    save("journal/2026/b.md", "# B\n");
    save("other/c.md", "# C\n");
    const star = docHistory(store, repoId, { pathGlob: "journal/*" }).docs.map((d) => d.path);
    const dstar = docHistory(store, repoId, { pathGlob: "journal/**" }).docs.map((d) => d.path);
    expect(star).toEqual(["journal/2026/a.md", "journal/2026/b.md"]);
    expect(dstar).toEqual(star);
  });

  it("single-doc form resolves by path and by id", () => {
    save("journal/a.md", "# A\n\nv1\n");
    save("journal/a.md", "# A\n\nv2 slightly longer content\n");
    const byPath = docHistory(store, repoId, { doc: "journal/a.md" });
    expect(byPath.docs).toHaveLength(1);
    expect(byPath.docs[0]!.versions.length).toBe(2);
    const byId = docHistory(store, repoId, { doc: docId("journal/a.md") });
    expect(byId.docs).toHaveLength(1);
    expect(byId.docs[0]!.docId).toBe(docId("journal/a.md"));
  });

  it("excludes deleted docs by default, includes them with includeDeleted (history intact)", () => {
    save("journal/a.md", "# A\n\nfirst\n");
    save("journal/a.md", "# A\n\nsecond version content\n");
    save("journal/b.md", "# B\n");
    const delId = docId("journal/a.md");
    docsDelete(store, { repoId, rootPath: dir }, "journal/a.md");

    const live = docHistory(store, repoId, { pathGlob: "journal/*" });
    expect(live.docs.map((d) => d.path)).toEqual(["journal/b.md"]);

    const all = docHistory(store, repoId, { pathGlob: "journal/*", includeDeleted: true });
    const deletedDoc = all.docs.find((d) => d.docId === delId)!;
    expect(deletedDoc.deleted).toBe(true);
    expect(deletedDoc.versions.length).toBe(2); // past versions preserved

    // includeDeleted also lets the single-doc form surface a tombstoned doc.
    expect(docHistory(store, repoId, { doc: "journal/a.md" }).docs).toHaveLength(0);
    expect(docHistory(store, repoId, { doc: "journal/a.md", includeDeleted: true }).docs).toHaveLength(1);
  });

  it("limit caps the number of documents and sets truncated", () => {
    save("journal/a.md", "# A\n");
    save("journal/b.md", "# B\n");
    save("journal/c.md", "# C\n");
    const { docs, truncated } = docHistory(store, repoId, { pathGlob: "journal/*", limit: 2 });
    expect(docs.map((d) => d.path)).toEqual(["journal/a.md", "journal/b.md"]);
    expect(truncated).toBe(true);
  });
});

describe("exit gate: backlinks via OQX follow doc.in", () => {
  it("backlinks: which docs reference a target (incoming edge walk)", () => {
    save("target.md", "# Target\n");
    save("src.md", "# Src\n\nrefers to [target](/target.md)\n");
    const hits = oqxRun(store, repoId, 'from docs where $path == "target.md" follow doc.in', { limit: 100 }).hits;
    expect(hits.map((h) => h.path)).toContain("src.md");
  });
});
