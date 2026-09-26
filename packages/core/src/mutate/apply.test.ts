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
  // Deepest first: a container's text is its children's joined (spec/format
  // §4.1), so "one" would otherwise also match the list "one two".
  const rows = store.db.prepare("SELECT block_id, text FROM blocks WHERE doc_id = ? ORDER BY depth DESC, ordinal").all(docId) as { block_id: string; text: string }[];
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

  it("remove collapses a set naming a container and its own children to the top-most blocks", () => {
    const docId = seed("a.md", "# Title\n\nIntro.\n\n- one\n- two\n\nTail.\n");
    const list = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND type = 'list'").get(docId) as { block_id: string }).block_id;
    const one = blockByText(docId, "one");
    const two = blockByText(docId, "two");
    // The flat docs_read id order: container first, then its items — plus a duplicate.
    const res = apply(store, {
      repoId, rootPath: dir,
      ops: [{ op: "remove", blocks: [list, one, two, one] }],
      origin: { actor: "agent:test" },
    });
    expect(res.committed).toBe(true);
    const removed = (res.results[0] as unknown as { removed: string[] }).removed;
    expect(removed.sort()).toEqual([list, one, two].sort());
    const after = readFileSync(join(dir, "a.md"), "utf8");
    expect(after).not.toContain("- one");
    expect(after).toContain("Intro.");
    expect(after).toContain("Tail.");
  });

  it("remove still CAS-checks a descendant that its container will take", () => {
    const docId = seed("a.md", "# Title\n\n- one\n- two\n");
    const list = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND type = 'list'").get(docId) as { block_id: string }).block_id;
    const one = blockByText(docId, "one");
    expect(() =>
      apply(store, {
        repoId, rootPath: dir,
        ops: [{ op: "remove", blocks: [list, one], expect: { [one]: { content_hash: "deadbeef" } } }],
        origin: { actor: "agent:test" },
      }),
    ).toThrow(MutationError);
  });

  it("remove of a genuinely unknown id is block_missing with a hint", () => {
    const docId = seed("a.md", "# Title\n\nBody.\n");
    const body = blockByText(docId, "Body");
    try {
      apply(store, { repoId, rootPath: dir, ops: [{ op: "remove", blocks: [body, "b_0000000"] }], origin: { actor: "agent:test" } });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      const err = e as MutationError;
      expect(err.code).toBe("block_missing");
      expect((err.data as { hint?: string }).hint).toMatch(/subtree/);
    }
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

  it("update without expect.content_hash errors actionably (carries the current hash to retry)", () => {
    const docId = seed("a.md", "# Title\n\nBody.\n");
    const bId = blockByText(docId, "Body");
    let caught: MutationError | undefined;
    try {
      apply(store, {
        repoId, rootPath: dir,
        ops: [{ op: "update", block: bId, markdown: "Rewritten." }],
        origin: { actor: "agent:test" },
      });
    } catch (e) {
      caught = e as MutationError;
    }
    expect(caught).toBeInstanceOf(MutationError);
    expect(caught!.code).toBe("stale_expectation");
    // The error hands back the current hash, so the caller can retry WITHOUT a
    // separate hydration read — nothing was written.
    const data = caught!.data as { retriable?: boolean; current?: { content_hash?: string } };
    expect(data.retriable).toBe(true);
    expect(data.current!.content_hash).toBe(hashOf(bId));
    expect(readFileSync(join(dir, "a.md"), "utf8")).toContain("Body.");

    // Retrying with the returned hash succeeds.
    const res = apply(store, {
      repoId, rootPath: dir,
      ops: [{ op: "update", block: bId, markdown: "Rewritten.", expect: { content_hash: data.current!.content_hash! } }],
      origin: { actor: "agent:test" },
    });
    expect(res.committed).toBe(true);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toContain("Rewritten.");
  });

  it("insert op accepts a document path for `doc`, not just a d_ id", () => {
    const docId = seed("a.md", "# Title\n\nBody.\n");
    const res = apply(store, {
      repoId, rootPath: dir, dryRun: true,
      ops: [{ op: "insert", to: { parent: { doc: true }, at: "end" }, doc: "a.md", markdown: "Appended." }],
      origin: { actor: "agent:test" },
    });
    expect(res.committed).toBe(false);
    expect(res.revisions).toEqual([{ doc: docId, path: "a.md" }]);
    expect(res.diffs!["a.md"]!.after).toContain("Appended.");
  });

  it("insert op still accepts a minted d_ id for `doc`", () => {
    const docId = seed("a.md", "# Title\n\nBody.\n");
    const res = apply(store, {
      repoId, rootPath: dir, dryRun: true,
      ops: [{ op: "insert", to: { parent: { doc: true }, at: "end" }, doc: docId, markdown: "Appended." }],
      origin: { actor: "agent:test" },
    });
    expect(res.diffs!["a.md"]!.after).toContain("Appended.");
  });

  it("insert op with an unknown doc path throws doc_missing naming the path", () => {
    seed("a.md", "# Title\n\nBody.\n");
    expect(() =>
      apply(store, {
        repoId, rootPath: dir, dryRun: true,
        ops: [{ op: "insert", to: { parent: { doc: true }, at: "end" }, doc: "nope.md", markdown: "x" }],
        origin: { actor: "agent:test" },
      }),
    ).toThrow(/doc nope\.md not found/);
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

  it("edge extraction on the mutation path anchors body links to their block (src_block)", () => {
    const docId = seed("a.md", "# Title\n\nplain body\n");
    const bId = blockByText(docId, "plain");
    const res = apply(store, {
      repoId, rootPath: dir,
      ops: [{ op: "update", block: bId, markdown: "See [target](/t.md).", expect: { content_hash: hashOf(bId) } }],
      origin: { actor: "agent:test" },
    });
    expect(res.committed).toBe(true);
    const edge = store.db
      .prepare("SELECT src_block, predicate FROM edges WHERE src_doc = ? AND provenance = 'link' AND to_commit IS NULL")
      .get(docId) as { src_block: string | null; predicate: string } | undefined;
    expect(edge?.predicate).toBe("references");
    // The fix: src_block is the edited block's real id, not "" — so block.out_edges resolves.
    expect(edge?.src_block).toBe(bId);
  });
});

// spec/mutate §2.3: a cross-document move heals BOTH documents' top-level seams
// — the block that was last in its source (lone "\n") must not soft-join the
// destination's last paragraph, and the destination's former last block is
// re-tiled so the arrival renders as its own block with its id intact.
describe("apply — cross-document move seams", () => {
  it("heals the destination's former last block and keeps the moved id", () => {
    const aDoc = seed("a.md", "# A\n\nAlpha one.\n\nAlpha two.\n");
    seed("b.md", "# B\n\nBeta one.\n");
    const moved = blockByText(aDoc, "Alpha two");
    const bLast = (store.db.prepare("SELECT block_id FROM blocks WHERE text = 'Beta one.'").get() as { block_id: string }).block_id;
    apply(store, { repoId, rootPath: dir, ops: [{ op: "move", blocks: [moved], to: { parent: { doc: true }, at: { after: bLast } } }], origin: { actor: "agent:test" } });
    expect(readFileSync(join(dir, "b.md"), "utf8")).toBe("# B\n\nBeta one.\n\nAlpha two.\n");
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# A\n\nAlpha one.\n\n");
    const home = store.db.prepare("SELECT d.path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ? AND b.deleted_commit IS NULL").get(moved) as { path: string } | undefined;
    expect(home?.path).toBe("b.md");
    expect(store.db.prepare("SELECT count(*) n FROM resurrection_pool").get()).toEqual({ n: 0 });
  });
});
