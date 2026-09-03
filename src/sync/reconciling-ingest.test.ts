import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "./checkpoint.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-recon-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function blockIds(): { text: string; id: string }[] {
  const doc = store.db.prepare("SELECT doc_id FROM documents WHERE path='doc.md'").get() as { doc_id: string };
  return store.db.prepare("SELECT text, block_id AS id FROM blocks WHERE doc_id = ? ORDER BY ordinal").all(doc.doc_id) as { text: string; id: string }[];
}

describe("reconciliation wired into checkpoint ingest (Stage 2.7)", () => {
  it("threads identity: unchanged blocks keep their ids across an edit", () => {
    writeFileSync(join(dir, "doc.md"), "# Title\n\nFirst paragraph stays the same here.\n\nSecond paragraph will be edited soon.\n");
    processCheckpoint(store, repoId, dir, [{ path: "doc.md" }]);
    const before = blockIds();
    const titleId = before.find((b) => b.text === "Title")!.id;
    const firstId = before.find((b) => b.text.startsWith("First"))!.id;
    const secondId = before.find((b) => b.text.startsWith("Second"))!.id;

    // Edit only the second paragraph.
    writeFileSync(join(dir, "doc.md"), "# Title\n\nFirst paragraph stays the same here.\n\nSecond paragraph will be edited right now.\n");
    processCheckpoint(store, repoId, dir, [{ path: "doc.md" }]);
    const after = blockIds();

    // Title + first paragraph keep their ids (exact-hash carry).
    expect(after.find((b) => b.text === "Title")!.id).toBe(titleId);
    expect(after.find((b) => b.text.startsWith("First"))!.id).toBe(firstId);
    // The edited paragraph carries the same id (context/scored), not re-minted.
    expect(after.find((b) => b.text.startsWith("Second"))!.id).toBe(secondId);
  });

  it("persists dispositions with kind + matcher_v for the edited block", () => {
    writeFileSync(join(dir, "doc.md"), "# H\n\nalpha beta gamma delta epsilon zeta eta theta original\n");
    processCheckpoint(store, repoId, dir, [{ path: "doc.md" }]);
    writeFileSync(join(dir, "doc.md"), "# H\n\nalpha beta gamma delta epsilon zeta eta theta modified\n");
    const res = processCheckpoint(store, repoId, dir, [{ path: "doc.md" }]);

    const dispos = store.db.prepare(
      "SELECT kind, matcher_v FROM dispositions WHERE commit_id IN (SELECT commit_id FROM commits ORDER BY seq DESC LIMIT 1)",
    ).all() as { kind: string; matcher_v: string | null }[];
    // At least one edited/edited_moved disposition carrying a matcher version.
    expect(dispos.some((d) => (d.kind === "edited" || d.kind === "edited_moved") && d.matcher_v)).toBe(true);
    expect(res.ingested).toEqual(["doc.md"]);
  });

  it("a deleted block lands in the resurrection pool", () => {
    writeFileSync(join(dir, "doc.md"), "# H\n\nkeep this paragraph around please\n\ndelete this whole paragraph entirely now\n");
    processCheckpoint(store, repoId, dir, [{ path: "doc.md" }]);
    writeFileSync(join(dir, "doc.md"), "# H\n\nkeep this paragraph around please\n");
    processCheckpoint(store, repoId, dir, [{ path: "doc.md" }]);

    const pool = store.db.prepare("SELECT count(*) c FROM resurrection_pool").get() as { c: number };
    expect(pool.c).toBeGreaterThanOrEqual(1);
  });
});
