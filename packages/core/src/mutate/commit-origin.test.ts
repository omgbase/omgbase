import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { apply } from "./apply.js";
import { docsCreate, docsSetMeta } from "./docs.js";

// History honesty (invariant #7): observed transitions are labeled `observed`;
// only intent writes carry `api` + an actor. Every intent path — the kernel's
// `apply` and the doc-level create/set_meta — must record origin "api" with the
// caller's actor and reason, never the bulk-ingest `import` label (which is what
// made `omg log --origin api` come back empty).

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-origin-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function lastCommit(): { origin: string; actor: string | null; reason: string | null } {
  return store.db.prepare("SELECT origin, actor, reason FROM commits ORDER BY seq DESC LIMIT 1").get() as {
    origin: string;
    actor: string | null;
    reason: string | null;
  };
}

describe("commit provenance of intent writes", () => {
  it("apply records origin api with the caller's actor and reason", () => {
    writeFileSync(join(dir, "a.md"), "# Title\n\nBody.\n");
    processCheckpoint(store, repoId, dir, [{ path: "a.md" }]);
    expect(lastCommit().origin).toBe("observed");
    const docId = (store.db.prepare("SELECT doc_id FROM docs WHERE path = ?").get("a.md") as { doc_id: string }).doc_id;

    const res = apply(store, {
      repoId,
      rootPath: dir,
      ops: [{ op: "insert", doc: docId, to: { parent: { doc: true }, at: "end" }, markdown: "Tail." }],
      origin: { actor: "human:brendan", reason: "append tail" },
    });
    expect(res.committed).toBe(true);
    expect(lastCommit()).toEqual({ origin: "api", actor: "human:brendan", reason: "append tail" });
  });

  it("docsCreate and docsSetMeta record origin api with the context actor", () => {
    const ctx = { repoId, rootPath: dir, actor: "agent:mcp" };
    docsCreate(store, ctx, "notes/x.md", "# X\n\nBody.\n", { layer: "draft" });
    expect(lastCommit()).toEqual({ origin: "api", actor: "agent:mcp", reason: "create notes/x.md" });

    docsSetMeta(store, ctx, "notes/x.md", { set: { layer: "working" } });
    expect(lastCommit()).toEqual({ origin: "api", actor: "agent:mcp", reason: "set_meta notes/x.md" });
  });
});
