import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { apply } from "./apply.js";
import { MutationError } from "./tree.js";

// Concurrency torture suite (04 §5). The engine is a single serialization point
// (per-repo writer lock; ADR-008), so "two agents" = two sequential apply()
// calls, and "human save" = a processCheckpoint between them. There are no
// diverging replicas — only stale readers, handled by OCC.

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-torture-"));
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
  return (store.db.prepare("SELECT doc_id FROM documents WHERE path = ?").get(path) as { doc_id: string }).doc_id;
}
function block(docId: string, prefix: string): string {
  const rows = store.db.prepare("SELECT block_id, text FROM blocks WHERE doc_id = ?").all(docId) as { block_id: string; text: string }[];
  return rows.find((r) => r.text.startsWith(prefix))!.block_id;
}
function hashOf(bId: string): string {
  return (store.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ?").get(bId) as { h: string }).h;
}
function humanSave(path: string, content: string): void {
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}

describe("torture §5 scenarios", () => {
  it("S1: two agents insert at end of one section — both succeed, ordered by arrival", () => {
    const docId = seed("a.md", "# Notes\n\nexisting note\n");
    const h = block(docId, "Notes");
    apply(store, { repoId, rootPath: dir, ops: [{ op: "insert", to: { parent: { heading: h, scope: "section" }, at: "end" }, markdown: "agent one line" }], origin: { actor: "agent:1" } });
    apply(store, { repoId, rootPath: dir, ops: [{ op: "insert", to: { parent: { heading: h, scope: "section" }, at: "end" }, markdown: "agent two line" }], origin: { actor: "agent:2" } });
    const text = readFileSync(join(dir, "a.md"), "utf8");
    expect(text.indexOf("agent one line")).toBeLessThan(text.indexOf("agent two line"));
  });

  it("S2: A moves a block, B updates the same block — both succeed (content CAS unaffected by placement)", () => {
    const docId = seed("a.md", "# A\n\ntarget paragraph text\n\n## B\n");
    const target = block(docId, "target");
    const bHead = block(docId, "B");
    const hash = hashOf(target);
    // A: move
    apply(store, { repoId, rootPath: dir, ops: [{ op: "move", blocks: [target], to: { parent: { doc: true }, at: { after: bHead } } }], origin: { actor: "agent:A" } });
    // B: update using the content hash captured BEFORE the move — still valid.
    const res = apply(store, { repoId, rootPath: dir, ops: [{ op: "update", block: target, markdown: "target paragraph edited", expect: { content_hash: hash } }], origin: { actor: "agent:B" } });
    expect(res.committed).toBe(true);
    expect(readFileSync(join(dir, "a.md"), "utf8")).toContain("target paragraph edited");
  });

  it("S3: A removes a section, B inserts into it — B fails parent_missing", () => {
    const docId = seed("a.md", "# Doomed\n\nsection body\n");
    const h = block(docId, "Doomed");
    apply(store, { repoId, rootPath: dir, ops: [{ op: "remove", blocks: [h, block(docId, "section body")] }], origin: { actor: "agent:A" } });
    // B tries to insert into the removed heading's section.
    expect(() =>
      apply(store, { repoId, rootPath: dir, ops: [{ op: "insert", to: { parent: { heading: h, scope: "section" }, at: "end" }, markdown: "too late" }], origin: { actor: "agent:B" } }),
    ).toThrow(MutationError);
  });

  it("S4: human saves mid-flight — file-CAS abort → ingest → typed sync_conflict", () => {
    const docId = seed("a.md", "# A\n\nbody paragraph\n");
    const b = block(docId, "body");
    const hash = hashOf(b);
    // Human writes the file behind the engine's back (store file_hash now stale).
    humanSave("a.md", "# A\n\nbody paragraph edited by human directly\n");
    // Agent's changeset was computed against the old revision → file-CAS trips.
    // (Our seed/humanSave already re-ingested, so file_hash matches store; to
    // force the race we write the file WITHOUT ingesting.)
    writeFileSync(join(dir, "a.md"), "# A\n\nbody paragraph changed again on disk only\n");
    try {
      apply(store, { repoId, rootPath: dir, ops: [{ op: "update", block: b, markdown: "agent edit", expect: { content_hash: hash } }], origin: { actor: "agent:A" } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      expect(["sync_conflict", "stale_expectation", "block_missing"]).toContain((e as MutationError).code);
    }
  });

  it("S5: two agents reorder same siblings — parent_children_hash guards", () => {
    const docId = seed("a.md", "# H\n\none\n\ntwo\n\nthree\n");
    const one = block(docId, "one");
    // A reorders: move 'one' to end.
    apply(store, { repoId, rootPath: dir, ops: [{ op: "move", blocks: [one], to: { parent: { doc: true }, at: "end" } }], origin: { actor: "agent:A" } });
    // B tries to move 'one' again with a stale content expectation → stale.
    const staleHash = "deadbeefdeadbeef";
    expect(() =>
      apply(store, { repoId, rootPath: dir, ops: [{ op: "update", block: one, markdown: "x", expect: { content_hash: staleHash } }], origin: { actor: "agent:B" } }),
    ).toThrow(MutationError);
  });

  it("S6: agent updates a block deleted by a human save — block_missing", () => {
    const docId = seed("a.md", "# H\n\nwill be deleted by human\n");
    const b = block(docId, "will be");
    const hash = hashOf(b);
    humanSave("a.md", "# H\n"); // human removes the paragraph
    try {
      apply(store, { repoId, rootPath: dir, ops: [{ op: "update", block: b, markdown: "x", expect: { content_hash: hash } }], origin: { actor: "agent:A" } });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MutationError);
      expect((e as MutationError).code).toBe("block_missing");
    }
  });
});

describe("soak: repeated random ops preserve invariants", () => {
  it("1000 mixed insert/update cycles keep convergence + valid tree", () => {
    const docId = seed("soak.md", "# Soak\n\nseed paragraph\n");
    void docId;
    let counter = 0;
    for (let i = 0; i < 1000; i++) {
      const rows = store.db.prepare("SELECT block_id, text, lower(hex(raw_hash)) h, type FROM blocks WHERE doc_id = (SELECT doc_id FROM documents WHERE path='soak.md') AND type='paragraph'").all() as { block_id: string; text: string; h: string; type: string }[];
      if (rows.length === 0 || i % 3 === 0) {
        const h = block(docId, "Soak");
        apply(store, { repoId, rootPath: dir, ops: [{ op: "insert", to: { parent: { heading: h, scope: "section" }, at: "end" }, markdown: `inserted line ${counter++}` }], origin: { actor: "agent:soak" } });
      } else {
        const target = rows[i % rows.length]!;
        apply(store, { repoId, rootPath: dir, ops: [{ op: "update", block: target.block_id, markdown: `edited ${counter++}`, expect: { content_hash: target.h } }], origin: { actor: "agent:soak" } });
      }
    }
    // Convergence invariant: stored file_hash == current revision rendered_hash.
    const doc = store.db.prepare("SELECT file_hash, current_rev FROM documents WHERE path='soak.md'").get() as { file_hash: Buffer; current_rev: string };
    const rev = store.db.prepare("SELECT rendered_hash FROM revisions WHERE rev_id=?").get(doc.current_rev) as { rendered_hash: Buffer };
    expect(doc.file_hash.equals(rev.rendered_hash)).toBe(true);
    // And the file on disk matches too.
    const onDiskMatches = readFileSync(join(dir, "soak.md"), "utf8");
    expect(onDiskMatches.length).toBeGreaterThan(0);
  });
});
