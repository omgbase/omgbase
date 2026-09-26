import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { observeBatch } from "../../sync/observe.js";
import { rebuildIndex } from "./rebuild.js";
import { LIVE_LEAF_SQL } from "./fts.js";
import { textSearch } from "../../search/text.js";

// spec/search §1.1 (1.2): the FTS index holds exactly the live LEAF rows of
// `blocks`, through ingest, tombstones, cross-document eviction and a rebuild.
// The external-content table answers count(*) from the content table, so the
// indexed rowids are read off the `blocks_fts_docsize` shadow table.

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
});
afterEach(() => store.close());

function indexedRowids(): number[] {
  return (store.db.prepare("SELECT id FROM blocks_fts_docsize ORDER BY id").all() as { id: number }[]).map((r) => r.id);
}
function liveLeafRowids(): number[] {
  return (store.db.prepare(`SELECT b.rowid AS id FROM blocks b WHERE ${LIVE_LEAF_SQL} ORDER BY b.rowid`).all() as { id: number }[]).map((r) => r.id);
}
function expectIndexIsLeaves(): void {
  expect(indexedRowids()).toEqual(liveLeafRowids());
}
function blockIds(path: string): { block_id: string; type: string; text: string; parent_block: string | null }[] {
  return store.db
    .prepare(
      `SELECT b.block_id, b.type, b.text, b.parent_block FROM blocks b JOIN docs d ON d.doc_id = b.doc_id
       WHERE d.path = ? AND b.deleted_commit IS NULL ORDER BY b.rowid`,
    )
    .all(path) as { block_id: string; type: string; text: string; parent_block: string | null }[];
}

const FILLER = "lorem ipsum dolor sit.\n\nsit amet consectetur adipiscing.\n\nadipiscing elit sed do.\n\ndo eiusmod tempor incididunt.\n";

describe("blocks_fts — leaf-only index (spec/search §1.1)", () => {
  it("containers have no row: a word two lists deep is one hit, the innermost item", () => {
    ingestFile(store, repoId, "a.md", `# Reef\n\n- corals build reefs\n  - polyps secrete calcium\n    - zooxanthellae photosynthesize here\n- fish shelter\n\n${FILLER}`);
    expectIndexIsLeaves();
    const { hits } = textSearch(store, repoId, "zooxanthellae");
    expect(hits.map((h) => h.type)).toEqual(["list_item"]);
    // Every container (list, item-with-children) is live but unindexed.
    const containers = store.db.prepare(`SELECT count(*) AS n FROM blocks b WHERE b.deleted_commit IS NULL AND NOT (${LIVE_LEAF_SQL})`).get() as { n: number };
    expect(containers.n).toBe(5); // list, item "corals…", sublist, item "polyps…", sub-sublist
  });

  it("re-ingest, tombstone and rebuild keep the index equal to the live leaves", () => {
    ingestFile(store, repoId, "a.md", `# A\n\n- one item alone\n\n${FILLER}`);
    expectIndexIsLeaves();
    // The single-item list becomes a two-item list with a nested sublist.
    ingestFile(store, repoId, "a.md", `# A\n\n- one item alone\n  - nested under one\n- two\n\n${FILLER}`);
    expectIndexIsLeaves();
    expect(textSearch(store, repoId, "alone").hits.map((h) => h.type)).toEqual(["paragraph"]);
    // Rebuild is 'delete-all' + leaves: same rows.
    const before = indexedRowids();
    store.db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')"); // the wholesale FTS5 command indexes containers…
    expect(indexedRowids().length).toBeGreaterThan(before.length);
    rebuildIndex(store, "fts"); // …and ours puts the leaf set back
    expect(indexedRowids()).toEqual(before);
    expectIndexIsLeaves();
  });

  it("cross-document move of a whole list (source commits later): items lose their rows, the list never had one", () => {
    const list = "- kelp grows fast in cold water\n  - giant kelp forms canopies\n- otters eat urchins\n";
    observeBatch(store, repoId, [
      { path: "a.md", content: `# A\n\n${list}\n${FILLER}` },
      { path: "b.md", content: `# B\n\nquiet paragraph about quails.\n` },
    ], "2026-09-26T10:00:00.000Z");
    expectIndexIsLeaves();
    const listIds = blockIds("a.md").filter((b) => b.type !== "heading" && b.type !== "paragraph" || b.parent_block !== null).map((b) => b.block_id);
    expect(listIds.length).toBe(6); // list, item, paragraph, sublist, subitem, item

    // b.md (destination) is observed BEFORE a.md (source) in the batch, so the
    // carried ids are live foreign rows at eviction time.
    observeBatch(store, repoId, [
      { path: "b.md", content: `# B\n\nquiet paragraph about quails.\n\n${list}` },
      { path: "a.md", content: `# A\n\n${FILLER}` },
    ], "2026-09-26T10:01:00.000Z");
    expectIndexIsLeaves();
    const moved = blockIds("b.md").filter((b) => b.type !== "heading" || b.parent_block !== null).filter((b) => b.text !== "quiet paragraph about quails.");
    // The ids carried across (the move was recognized), so eviction ran.
    expect(moved.map((b) => b.block_id).sort()).toEqual([...listIds].sort());
    expect(textSearch(store, repoId, "kelp").hits.map((h) => `${h.path}#${h.type}`).sort()).toEqual(["b.md#list_item", "b.md#paragraph"]);
    expect(textSearch(store, repoId, "urchins").hits.map((h) => h.path)).toEqual(["b.md"]);
  });

  it("evicting a list's only live child re-indexes the parent so the source's delete pass stays symmetric", () => {
    observeBatch(store, repoId, [
      { path: "a.md", content: `# A\n\n- the solitary item about lighthouses and their keepers\n\n${FILLER}` },
      { path: "b.md", content: `# B\n\nquiet paragraph about quails.\n` },
    ], "2026-09-26T10:00:00.000Z");
    expectIndexIsLeaves();
    // The item moves to b.md while a.md keeps a list (with a new item);
    // destination first so the source's row is evicted while the source list is
    // still live in the table.
    observeBatch(store, repoId, [
      { path: "b.md", content: `# B\n\nquiet paragraph about quails.\n\n- the solitary item about lighthouses and their keepers\n` },
      { path: "a.md", content: `# A\n\n- a fresh replacement item about harbors\n\n${FILLER}` },
    ], "2026-09-26T10:01:00.000Z");
    expectIndexIsLeaves();
    expect(textSearch(store, repoId, "lighthouses").hits.map((h) => [h.path, h.type])).toEqual([["b.md", "list_item"]]);
    expect(textSearch(store, repoId, "harbors").hits.map((h) => [h.path, h.type])).toEqual([["a.md", "list_item"]]);
  });
});
