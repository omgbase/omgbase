import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "./checkpoint.js";
import { hasConflictMarkers, detectRename } from "./git-heuristics.js";
import { sha256 } from "../core/hash.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-git-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("hasConflictMarkers", () => {
  it("detects a real conflict but not prose with a single ===== line", () => {
    expect(hasConflictMarkers("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> br\nb\n")).toBe(true);
    expect(hasConflictMarkers("# Title\n\n=======\n\nnot a conflict\n")).toBe(false);
  });
});

describe("detectRename", () => {
  it("matches a moved file by whole-file hash", () => {
    const h = sha256("# Doc\n\nbody\n").toString("hex");
    expect(detectRename(h, [{ docId: "d_1", fileHashHex: h }])).toBe("d_1");
    expect(detectRename("other", [{ docId: "d_1", fileHashHex: h }])).toBeNull();
  });
});

describe("checkpoint git integration", () => {
  it("flags a document conflicted when it has conflict markers; clears on resolve", () => {
    writeFileSync(join(dir, "a.md"), "# A\n\nclean body\n");
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);

    writeFileSync(join(dir, "a.md"), "# A\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n");
    const res = processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect(res.conflicted).toEqual(["a.md"]);
    expect((store.db.prepare("SELECT conflicted c FROM documents WHERE path='a.md'").get() as { c: number }).c).toBe(1);

    // Resolve the conflict → flag clears.
    writeFileSync(join(dir, "a.md"), "# A\n\nresolved body\n");
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect((store.db.prepare("SELECT conflicted c FROM documents WHERE path='a.md'").get() as { c: number }).c).toBe(0);
  });

  it("branch-switch storm: many files in one checkpoint, no identity carnage", () => {
    // Seed 20 docs.
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `d${i}.md`), `# Doc ${i}\n\nstable body paragraph number ${i} that will survive the switch\n`);
    const changes = Array.from({ length: 20 }, (_, i) => ({ path: `d${i}.md` }));
    processCheckpoint(store, repoId, dir, changes);

    // Capture block ids.
    const idsBefore = new Map<string, string>();
    for (let i = 0; i < 20; i++) {
      const docId = (store.db.prepare("SELECT doc_id FROM documents WHERE path=?").get(`d${i}.md`) as { doc_id: string }).doc_id;
      const b = store.db.prepare("SELECT block_id FROM blocks WHERE doc_id=? AND type='paragraph'").get(docId) as { block_id: string };
      idsBefore.set(`d${i}.md`, b.block_id);
    }

    // Simulate a branch switch: identical content re-touched in ONE checkpoint.
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `d${i}.md`), `# Doc ${i}\n\nstable body paragraph number ${i} that will survive the switch\n`);
    const res = processCheckpoint(store, repoId, dir, changes);

    // All echo-suppressed (bytes unchanged) → one checkpoint, no re-mint.
    expect(res.suppressed.length).toBe(20);
    expect(res.ingested).toHaveLength(0);
    // Block ids unchanged.
    for (let i = 0; i < 20; i++) {
      const docId = (store.db.prepare("SELECT doc_id FROM documents WHERE path=?").get(`d${i}.md`) as { doc_id: string }).doc_id;
      const b = store.db.prepare("SELECT block_id FROM blocks WHERE doc_id=? AND type='paragraph'").get(docId) as { block_id: string };
      expect(b.block_id).toBe(idsBefore.get(`d${i}.md`));
    }
  });
});
