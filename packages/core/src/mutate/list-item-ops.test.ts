import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { apply, type Op } from "./apply.js";
import { listsInsertItem } from "./macros.js";

// Direct per-item kernel ops (04 §1): update / insert / remove / move of a
// list_item must render faithfully — previously all five silently corrupted
// (update nested/lost the marker; insert nested; remove/move didn't render).

let dir: string; let store: Store; let repoId: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "li-")); store = new Store({ path: ":memory:" }); repoId = ensureRepo(store, "t", dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function seed(path: string, content: string): string {
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path = ?").get(path) as { doc_id: string }).doc_id;
}
function item(docId: string, text: string): string {
  return (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND type IN ('list_item','task') AND text = ?").get(docId, text) as { block_id: string }).block_id;
}
function listId(docId: string): string {
  return (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND type = 'list'").get(docId) as { block_id: string }).block_id;
}
function hashOf(bId: string): string {
  return (store.db.prepare("SELECT lower(hex(raw_hash)) h FROM blocks WHERE block_id = ?").get(bId) as { h: string }).h;
}
function after(ops: Op[]): string {
  return Object.values(apply(store, { repoId, rootPath: dir, dryRun: true, ops, origin: { actor: "t" } }).diffs!)[0]!.after;
}
function commit(ops: Op[]): void {
  apply(store, { repoId, rootPath: dir, ops, origin: { actor: "t" } });
}

describe("list-item kernel ops render faithfully", () => {
  it("update: edit one item, marker preserved, others intact", () => {
    const doc = seed("a.md", "# T\n\n- one\n- two\n- three\n");
    const two = item(doc, "two");
    expect(after([{ op: "update", block: two, markdown: "- two edited", expect: { content_hash: hashOf(two) } }]))
      .toBe("# T\n\n- one\n- two edited\n- three\n");
  });

  it("update: plain text (no marker) keeps the item a bullet", () => {
    const doc = seed("a.md", "# T\n\n- one\n- two\n- three\n");
    const two = item(doc, "two");
    expect(after([{ op: "update", block: two, markdown: "two edited", expect: { content_hash: hashOf(two) } }]))
      .toBe("# T\n\n- one\n- two edited\n- three\n");
  });

  it("insert: a new item is a sibling, not nested", () => {
    const doc = seed("a.md", "# T\n\n- one\n- two\n");
    const list = listId(doc);
    const two = item(doc, "two");
    expect(after([{ op: "insert", to: { parent: list, at: { after: two } }, markdown: "- three" }]))
      .toBe("# T\n\n- one\n- two\n- three\n");
  });

  it("lists_insert_item macro inserts a real sibling item", () => {
    const doc = seed("a.md", "# T\n\n- one\n- two\n");
    commit(listsInsertItem(listId(doc), "end", "three"));
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("# T\n\n- one\n- two\n- three\n");
  });

  it("remove: dropping an item re-renders the list (previously a no-op)", () => {
    const doc = seed("a.md", "# T\n\n- one\n- two\n- three\n");
    const two = item(doc, "two");
    expect(after([{ op: "remove", blocks: [two] }])).toBe("# T\n\n- one\n- three\n");
  });

  it("remove: emptying a list removes the list block", () => {
    const doc = seed("a.md", "# T\n\n- only\n");
    const only = item(doc, "only");
    expect(after([{ op: "remove", blocks: [only] }])).toBe("# T\n\n");
  });

  it("move: reordering items within a list re-renders", () => {
    const doc = seed("a.md", "# T\n\n- one\n- two\n- three\n");
    const one = item(doc, "one");
    const three = item(doc, "three");
    expect(after([{ op: "move", blocks: [three], to: { parent: listId(doc), at: { before: one } } }]))
      .toBe("# T\n\n- three\n- one\n- two\n");
  });

  it("ordered list renumbers on reorder", () => {
    const doc = seed("a.md", "# T\n\n1. alpha\n2. bravo\n3. gamma\n");
    const gamma = item(doc, "gamma");
    const alpha = item(doc, "alpha");
    expect(after([{ op: "move", blocks: [gamma], to: { parent: listId(doc), at: { before: alpha } } }]))
      .toBe("# T\n\n1. gamma\n2. alpha\n3. bravo\n");
  });

  it("checkbox toggle still renders (attrs path via renderList)", () => {
    const doc = seed("a.md", "# T\n\n- [ ] todo\n- [ ] later\n");
    const todo = item(doc, "todo");
    expect(after([{ op: "update", block: todo, attrs: { checked: true }, expect: { content_hash: hashOf(todo) } }]))
      .toBe("# T\n\n- [x] todo\n- [ ] later\n");
  });
});
