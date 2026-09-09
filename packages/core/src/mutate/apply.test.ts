import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { apply } from "./apply.js";
import { MutationError } from "./tree.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-apply-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(path: string, content: string): string {
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path = ?").get(path) as { doc_id: string }).doc_id;
}
function blockByText(docId: string, prefix: string): string {
  const rows = store.db.prepare("SELECT block_id, text FROM blocks WHERE doc_id = ?").all(docId) as { block_id: string; text: string }[];
  return rows.find((r) => r.text.startsWith(prefix))!.block_id;
}
function hashOf(bId: string): string {
  return (store.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ?").get(bId) as { h: string }).h;
}

describe("apply — changesets", () => {
  it("dry_run returns diffs and commits nothing", () => {
    const docId = seed("a.md", "# Title\n\nBody paragraph here.\n");
    const bId = blockByText(docId, "Body");
    const res = apply(store, {
      repoId, rootPath: dir, dryRun: true,
      ops: [{ op: "update", block: bId, markdown: "Rewritten body.", expect: { content_hash: hashOf(bId) } }],
      origin: { actor: "agent:test" },
    });
    expect(res.committed).toBe(false);
    expect(res.diffs!["a.md"]!.after).toContain("Rewritten body.");
    expect(readFileSync(join(dir, "a.md"), "utf8")).toContain("Body paragraph here.");
  });

  it("applies an update and writes the file", () => {
    const docId = seed("a.md", "# Title\n\nBody paragraph here.\n");
    const bId = blockByText(docId, "Body");
    const res = apply(store, {
      repoId, rootPath: dir,
      ops: [{ op: "update", block: bId, markdown: "Rewritten body.", expect: { content_hash: hashOf(bId) } }],
      origin: { actor: "agent:test" },
    });
    expect(res.committed).toBe(true);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toContain("Rewritten body.");
  });

  it("resolves $n.ids[i] placeholders across ops in one changeset", () => {
    const docId = seed("a.md", "# Title\n\nTail.\n");
    const headingId = blockByText(docId, "Title");
    // insert a block, then move that just-inserted block to end via placeholder.
    const res = apply(store, {
      repoId, rootPath: dir,
      ops: [
        { op: "insert", to: { parent: { doc: true }, at: { after: headingId } }, markdown: "First inserted." },
        { op: "move", blocks: ["$0.ids[0]"], to: { parent: { doc: true }, at: "end" } },
      ],
      origin: { actor: "agent:test" },
    });
    expect(res.committed).toBe(true);
    const text = readFileSync(join(dir, "a.md"), "utf8");
    // inserted block should be after Tail now (moved to end)
    expect(text.indexOf("First inserted.")).toBeGreaterThan(text.indexOf("Tail."));
  });

  it("stale content_hash aborts the whole changeset (atomic, nothing written)", () => {
    const docId = seed("a.md", "# Title\n\nBody.\n");
    const bId = blockByText(docId, "Body");
    expect(() =>
      apply(store, {
        repoId, rootPath: dir,
        ops: [{ op: "update", block: bId, markdown: "x", expect: { content_hash: "deadbeef" } }],
        origin: { actor: "agent:test" },
      }),
    ).toThrow(MutationError);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toContain("Body.");
  });

  it("cross-document move relocates content between files atomically", () => {
    const aId = seed("a.md", "# A\n\nmovable paragraph content here\n");
    seed("b.md", "# B\n\nb original\n");
    const moveId = blockByText(aId, "movable");
    const bDoc = (store.db.prepare("SELECT doc_id FROM docs WHERE path='b.md'").get() as { doc_id: string }).doc_id;
    const bHeading = blockByText(bDoc, "B");
    const res = apply(store, {
      repoId, rootPath: dir,
      ops: [{ op: "move", blocks: [moveId], to: { parent: { doc: true }, at: { after: bHeading } } }],
      origin: { actor: "agent:test", reason: "relocate" },
    });
    expect(res.committed).toBe(true);
    expect(readFileSync(join(dir, "a.md"), "utf8")).not.toContain("movable paragraph");
    expect(readFileSync(join(dir, "b.md"), "utf8")).toContain("movable paragraph");
  });
});
