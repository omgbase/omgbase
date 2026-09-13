import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../store/store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { resolveRef } from "./refs.js";
import "../../format/index.js"; // registers the markdown adapter (node projection)

// resolveRef accepts block ids, doc ids, doc paths — and projected node ids
// (`n_…`), which dereference to the block they were projected from. That last
// case is what lets an OQX `from nodes` hit be a first-class argument to
// cat/show/done/links (11 shell).

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

const SAMPLE = "# Water bath\n\nIntro.\n\n- [ ] boil the flask\n";

function setup(): { repoId: string; docId: string } {
  store = new Store({ path: ":memory:" });
  const repoId = ensureRepo(store, "t", "/tmp");
  const res = ingestFile(store, repoId, "a.md", SAMPLE);
  return { repoId, docId: res.docId };
}

function nodeId(kind: string): string {
  const row = store!.db
    .prepare("SELECT node_id FROM nodes WHERE kind = ? LIMIT 1")
    .get(kind) as { node_id: string } | undefined;
  if (!row) throw new Error(`no ${kind} node projected`);
  return row.node_id;
}

describe("resolveRef — node ids", () => {
  it("dereferences a task node to its block", () => {
    const { repoId } = setup();
    const n = nodeId("md:task");
    const resolved = resolveRef(store!, repoId, n);
    expect(resolved?.kind).toBe("block");
    // The resolved block is the one the node carries in nodes.block_id.
    const expected = (
      store!.db.prepare("SELECT block_id FROM nodes WHERE node_id = ?").get(n) as { block_id: string }
    ).block_id;
    expect(resolved?.blockId).toBe(expected);
    // …and it is a live block of the right type.
    const blk = store!.db
      .prepare("SELECT type FROM blocks WHERE block_id = ? AND deleted_commit IS NULL")
      .get(resolved!.blockId!) as { type: string } | undefined;
    expect(blk?.type).toBe("task");
  });

  it("dereferences a section node to its heading block", () => {
    const { repoId } = setup();
    const n = nodeId("md:section");
    const resolved = resolveRef(store!, repoId, n);
    expect(resolved?.kind).toBe("block");
    const blk = store!.db
      .prepare("SELECT type FROM blocks WHERE block_id = ?")
      .get(resolved!.blockId!) as { type: string } | undefined;
    expect(blk?.type).toBe("heading");
  });

  it("returns null for an unknown node id", () => {
    const { repoId } = setup();
    expect(resolveRef(store!, repoId, "n_000000000000")).toBeNull();
  });

  it("still resolves block ids, doc ids, and paths", () => {
    const { repoId, docId } = setup();
    expect(resolveRef(store!, repoId, docId)?.kind).toBe("document");
    expect(resolveRef(store!, repoId, "a.md")?.docId).toBe(docId);
    const anyBlock = (store!.db.prepare("SELECT block_id FROM blocks LIMIT 1").get() as { block_id: string }).block_id;
    expect(resolveRef(store!, repoId, anyBlock)?.kind).toBe("block");
  });
});
