import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { historyNode, diffBlocks, changesSince } from "./history.js";
import { graphTraverse } from "./traverse.js";

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
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}
function docId(path: string): string {
  return (store.db.prepare("SELECT doc_id FROM documents WHERE path=?").get(path) as { doc_id: string }).doc_id;
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
    const rev1 = (store.db.prepare("SELECT current_rev FROM documents WHERE path='a.md'").get() as { current_rev: string }).current_rev;
    save("a.md", "# H\n\nkeep me around please\n\nbrand new paragraph here\n");
    const rev2 = (store.db.prepare("SELECT current_rev FROM documents WHERE path='a.md'").get() as { current_rev: string }).current_rev;

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

describe("exit gate: block-grain backlinks + temporal edge query", () => {
  it("backlinks: which docs reference a target (in-direction traversal)", () => {
    save("target.md", "# Target\n");
    save("src.md", "# Src\n\nrefers to [target](/target.md)\n");
    const back = graphTraverse(store, { from: [docId("target.md")], via: ["references"], direction: "in", depth: 1 });
    expect(back.nodes).toContain(docId("src.md"));
  });
});
