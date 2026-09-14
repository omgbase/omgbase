import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { apply } from "./apply.js";
import { tasksComplete, sectionsAppend, docsAppend, sectionsRename, linksRetarget } from "./macros.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-macro-"));
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
function block(docId: string, prefix: string): string {
  const rows = store.db.prepare("SELECT block_id, text FROM blocks WHERE doc_id = ?").all(docId) as { block_id: string; text: string }[];
  return rows.find((r) => r.text.startsWith(prefix))!.block_id;
}

describe("macros expand to kernel ops (visible)", () => {
  it("tasks_complete expands to update(checked:true) and checks the box", () => {
    const docId = seed("t.md", "# Tasks\n\n- [ ] first task\n- [ ] second task\n");
    const t1 = block(docId, "first");
    const ops = tasksComplete(store, [t1]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "update", block: t1, attrs: { checked: true } });
    const res = apply(store, { repoId, rootPath: dir, ops, origin: { actor: "agent:test" } });
    expect(res.committed).toBe(true);
    expect(readFileSync(join(dir, "t.md"), "utf8")).toContain("- [x] first task");
  });

  it("sections_append inserts at the end of a section", () => {
    const docId = seed("s.md", "# Intro\n\nintro body\n\n## Launch\n\nlaunch note\n\n## Other\n\nother note\n");
    void docId;
    const launchId = block(docId, "Launch");
    const ops = sectionsAppend(launchId, "appended launch item");
    const res = apply(store, { repoId, rootPath: dir, ops, origin: { actor: "agent:test" } });
    expect(res.committed).toBe(true);
    const text = readFileSync(join(dir, "s.md"), "utf8");
    // appended within the Launch section (before ## Other)
    expect(text.indexOf("appended launch item")).toBeGreaterThan(text.indexOf("launch note"));
    expect(text.indexOf("appended launch item")).toBeLessThan(text.indexOf("## Other"));
  });

  it("sections_append that starts with a heading keeps a blank line before it", () => {
    // Section's last paragraph ends the file with a single "\n" — the pre-fix
    // behavior glued "…prev block.\n## Analysis" together with no blank line.
    const docId = seed("g.md", "# Intro\n\ntrailing paragraph.\n");
    const introId = block(docId, "Intro");
    const ops = sectionsAppend(introId, "## Analysis\n\nhow they differ\n");
    apply(store, { repoId, rootPath: dir, ops, origin: { actor: "agent:test" } });
    const text = readFileSync(join(dir, "g.md"), "utf8");
    expect(text).toContain("trailing paragraph.\n\n## Analysis");
    expect(text).not.toContain("trailing paragraph.\n## Analysis");
  });

  it("docs_append expands to one top-level insert-at-end op and appends to the doc", () => {
    const docId = seed("d.md", "# Journal\n\nfirst entry\n");
    const ops = docsAppend(docId, "second entry\n");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "insert", doc: docId, to: { parent: { doc: true }, at: "end" }, markdown: "second entry\n" });
    const res = apply(store, { repoId, rootPath: dir, ops, origin: { actor: "agent:test" } });
    expect(res.committed).toBe(true);
    const text = readFileSync(join(dir, "d.md"), "utf8");
    // appended AFTER the existing body (end of document), not inside a section
    expect(text.indexOf("second entry")).toBeGreaterThan(text.indexOf("first entry"));
    expect(text.trimEnd().endsWith("second entry")).toBe(true);
  });

  it("docs_append preserves existing block ids and only mints the appended block", () => {
    const docId = seed("j.md", "# Journal\n\nexisting paragraph\n");
    const before = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL ORDER BY ordinal").all(docId) as { block_id: string }[]).map((r) => r.block_id);
    const res = apply(store, { repoId, rootPath: dir, ops: docsAppend(docId, "appended paragraph\n"), origin: { actor: "agent:test" } });
    expect(res.committed).toBe(true);
    const after = (store.db.prepare("SELECT block_id FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL ORDER BY ordinal").all(docId) as { block_id: string }[]).map((r) => r.block_id);
    // every prior id is still live (none re-minted) and exactly one new block added
    for (const id of before) expect(after).toContain(id);
    expect(after.length).toBe(before.length + 1);
    // the op reports exactly the newly minted block id (not any existing one)
    expect(res.results[0]!.ids).toHaveLength(1);
    expect(before).not.toContain(res.results[0]!.ids[0]);
    expect(after).toContain(res.results[0]!.ids[0]);
  });

  it("sections_rename rewrites the heading, preserving level", () => {
    const docId = seed("r.md", "## Old Title\n\nbody\n");
    const h = block(docId, "Old Title");
    const ops = sectionsRename(store, h, "New Title");
    apply(store, { repoId, rootPath: dir, ops, origin: { actor: "agent:test" } });
    expect(readFileSync(join(dir, "r.md"), "utf8")).toContain("## New Title");
  });

  it("links_retarget rewrites a destination across blocks (dry-run hits)", () => {
    const docId = seed("l.md", "# Doc\n\nSee [old](/old/path.md) here.\n\nAlso [old again](/old/path.md).\n");
    void docId;
    const { ops, hits } = linksRetarget(store, repoId, "/old/path.md", "/new/path.md");
    expect(hits.length).toBe(2);
    expect(hits[0]!.newRaw).toContain("/new/path.md");
    // apply the expansion for real
    const res = apply(store, { repoId, rootPath: dir, ops, origin: { actor: "agent:test" } });
    expect(res.committed).toBe(true);
    const text = readFileSync(join(dir, "l.md"), "utf8");
    expect(text).not.toContain("/old/path.md");
    expect(text.match(/\/new\/path\.md/g)).toHaveLength(2);
  });
});
