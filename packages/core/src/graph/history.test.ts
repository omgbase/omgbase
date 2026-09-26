import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { historyNode, diffBlocks, diffUnified, unifiedDiff, myersScript, diffLines, changesSince, docHistory } from "./history.js";
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

// spec/surface §3 `diff_unified`. The expected strings below are copied
// verbatim into crates/omgbase-surface/src/history.rs's tests so the two
// engines pin each other byte for byte.
describe("unifiedDiff (spec/surface §3: Myers script + unified hunks)", () => {
  const eight = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8";
  const twelve = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12";

  it("splits on \\n exactly (no trimming); the empty text alone has no lines", () => {
    expect(diffLines("a\nb")).toEqual(["a", "b"]);
    expect(diffLines("a\nb\n")).toEqual(["a", "b", ""]);
    expect(diffLines(" a \n\n b ")).toEqual([" a ", "", " b "]);
    expect(diffLines("")).toEqual([]);
  });

  it("identical texts → \"\"", () => {
    expect(unifiedDiff("a\nb\nc", "a\nb\nc")).toBe("");
    expect(unifiedDiff("", "")).toBe("");
  });

  it("an insertion in the middle: only that line is +, the rest is context", () => {
    expect(unifiedDiff(eight, "l1\nl2\nl3\nl4\nNEW\nl5\nl6\nl7\nl8")).toBe("@@ -2,6 +2,7 @@\n l2\n l3\n l4\n+NEW\n l5\n l6\n l7");
  });

  it("a deletion", () => {
    expect(unifiedDiff(eight, "l1\nl2\nl3\nl4\nl6\nl7\nl8")).toBe("@@ -2,7 +2,6 @@\n l2\n l3\n l4\n-l5\n l6\n l7\n l8");
  });

  it("a replacement", () => {
    expect(unifiedDiff(eight, "l1\nl2\nl3\nl4\nX5\nl6\nl7\nl8")).toBe("@@ -2,7 +2,7 @@\n l2\n l3\n l4\n-l5\n+X5\n l6\n l7\n l8");
  });

  it("a change at the very top and at the very bottom (truncated context)", () => {
    expect(unifiedDiff("l1\nl2\nl3\nl4\nl5", "L1\nl2\nl3\nl4\nl5")).toBe("@@ -1,4 +1,4 @@\n-l1\n+L1\n l2\n l3\n l4");
    expect(unifiedDiff("l1\nl2\nl3\nl4\nl5", "l1\nl2\nl3\nl4\nL5")).toBe("@@ -2,4 +2,4 @@\n l2\n l3\n l4\n-l5\n+L5");
  });

  it("two far-apart changes are two hunks; two near ones share a hunk", () => {
    expect(unifiedDiff(twelve, "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nL12")).toBe(
      "@@ -1,4 +1,4 @@\n-l1\n+L1\n l2\n l3\n l4\n@@ -9,4 +9,4 @@\n l9\n l10\n l11\n-l12\n+L12",
    );
    expect(unifiedDiff(twelve, "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nL9\nl10\nl11\nl12")).toBe(
      "@@ -1,4 +1,4 @@\n-l1\n+L1\n l2\n l3\n l4\n@@ -6,7 +6,7 @@\n l6\n l7\n l8\n-l9\n+L9\n l10\n l11\n l12",
    );
  });

  it("hunk merge boundary: 6 unchanged lines between (contexts touch) merge, 7 split", () => {
    expect(unifiedDiff("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10", "L1\nl2\nl3\nl4\nl5\nl6\nl7\nL8\nl9\nl10")).toBe(
      "@@ -1,10 +1,10 @@\n-l1\n+L1\n l2\n l3\n l4\n l5\n l6\n l7\n-l8\n+L8\n l9\n l10",
    );
    expect(unifiedDiff("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11", "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nL9\nl10\nl11")).toBe(
      "@@ -1,4 +1,4 @@\n-l1\n+L1\n l2\n l3\n l4\n@@ -6,6 +6,6 @@\n l6\n l7\n l8\n-l9\n+L9\n l10\n l11",
    );
  });

  it("an empty old text / an empty new text (0-length ranges)", () => {
    expect(unifiedDiff("", "a\nb\nc")).toBe("@@ -0,0 +1,3 @@\n+a\n+b\n+c");
    expect(unifiedDiff("a\nb\nc", "")).toBe("@@ -1,3 +0,0 @@\n-a\n-b\n-c");
  });

  it("an insertion at the very top", () => {
    expect(unifiedDiff("a\nb", "z\na\nb")).toBe("@@ -1,2 +1,3 @@\n+z\n a\n b");
  });

  it("trailing newline and empty lines are lines like any other", () => {
    // A raw ending in "\n" contributes a trailing empty line; removing it is a `-` of "".
    expect(unifiedDiff("a\nb\n", "a\nb")).toBe("@@ -1,3 +1,2 @@\n a\n b\n-");
    // A kept empty line is " " (a single space); an inserted one is "+".
    expect(unifiedDiff("a\n\nb", "a\n\n\nb")).toBe("@@ -1,3 +1,4 @@\n a\n \n+\n b");
  });

  it("the textbook tie case (Myers 1986): a b c a b b a → c b a b a c", () => {
    const script = myersScript(diffLines("a\nb\nc\na\nb\nb\na"), diffLines("c\nb\na\nb\na\nc"))
      .map((o) => (o.kind === "keep" ? " " : o.kind === "delete" ? "-" : "+") + o.line)
      .join("|");
    expect(script).toBe("-a|-b| c|+b| a| b|-b| a|+c");
    expect(unifiedDiff("a\nb\nc\na\nb\nb\na", "c\nb\na\nb\na\nc")).toBe("@@ -1,7 +1,6 @@\n-a\n-b\n c\n+b\n a\n b\n-b\n a\n+c");
  });
});

describe("diffUnified (store-backed)", () => {
  function currentRev(path: string): string {
    return (store.db.prepare("SELECT current_rev FROM docs WHERE path=?").get(path) as { current_rev: string }).current_rev;
  }

  it("one inserted block is one + line; identical revisions are \"\"", () => {
    save("a.md", "# H\n\none\n\ntwo\n\nthree\n\nfour\n\nfive\n");
    const rev1 = currentRev("a.md");
    save("a.md", "# H\n\none\n\ntwo\n\ninserted\n\nthree\n\nfour\n\nfive\n");
    const rev2 = currentRev("a.md");
    expect(diffUnified(store, docId("a.md"), rev1, rev2)).toBe("@@ -1,6 +1,7 @@\n # H\n one\n two\n+inserted\n three\n four\n five");
    expect(diffUnified(store, docId("a.md"), rev1, rev1)).toBe("");
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
