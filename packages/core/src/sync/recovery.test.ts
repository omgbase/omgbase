import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "./checkpoint.js";
import { recoverRepo } from "./recovery.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-recover-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("crash recovery (04 §6)", () => {
  it("heals a file written but not committed (hash divergence) via ingest", () => {
    writeFileSync(join(dir, "a.md"), "# Title\n\nOriginal body.\n");
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);

    // Simulate a crash between file-write (step 5) and DB-commit (step 7):
    // the file advanced but the store did not.
    writeFileSync(join(dir, "a.md"), "# Title\n\nBody after an uncommitted write.\n");

    const result = recoverRepo(store, repoId, dir);
    expect(result.healed).toEqual(["a.md"]);

    // Store now converges with the on-disk bytes.
    const doc = store.db.prepare("SELECT file_hash, current_rev FROM docs WHERE path='a.md'").get() as { file_hash: Buffer; current_rev: string };
    const rev = store.db.prepare("SELECT rendered_hash FROM revisions WHERE rev_id=?").get(doc.current_rev) as { rendered_hash: Buffer };
    expect(doc.file_hash.equals(rev.rendered_hash)).toBe(true);
    const blocks = store.db.prepare("SELECT text FROM blocks WHERE doc_id=(SELECT doc_id FROM docs WHERE path='a.md')").all() as { text: string }[];
    expect(blocks.some((b) => b.text.includes("uncommitted"))).toBe(true);
  });

  it("does nothing when everything is already converged", () => {
    writeFileSync(join(dir, "a.md"), "# H\n\nbody\n");
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect(recoverRepo(store, repoId, dir).healed).toEqual([]);
  });

  it("reports a tracked doc whose file vanished", () => {
    writeFileSync(join(dir, "a.md"), "# H\n\nbody\n");
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    unlinkSync(join(dir, "a.md"));
    expect(recoverRepo(store, repoId, dir).missing).toEqual(["a.md"]);
  });
});
