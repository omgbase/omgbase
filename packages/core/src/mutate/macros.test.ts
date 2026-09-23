import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { apply } from "./apply.js";
import { tasksComplete, sectionsAppend, docsAppend, sectionsRename, linksRetarget, linksRepair } from "./macros.js";

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

describe("linksRepair rewrites LINK DESTINATIONS, coalesced to top-most blocks", () => {
  const typeOf = (blockId: string): string =>
    (store.db.prepare("SELECT type FROM blocks WHERE block_id = ?").get(blockId) as { type: string }).type;
  const liveBytes = (docId: string, type: string): string[] =>
    (store.db.prepare(
      "SELECT b.bytes FROM blocks bl JOIN blobs b ON b.hash = bl.raw_hash WHERE bl.doc_id = ? AND bl.type = ? AND bl.deleted_commit IS NULL",
    ).all(docId, type) as { bytes: Buffer }[]).map((r) => r.bytes.toString("utf8"));

  it("a link inside a list: one op on the list (the item hit collapses), apply succeeds, list + item bytes both update", () => {
    const docId = seed("list.md", "# L\n\n- item [b](/b.md) here\n- other\n\nAfter [b](/b.md).\n");
    // Before the fix this produced an op for the list AND its item; updating the
    // list re-minted the item, so the item op failed block_missing and sank the
    // whole changeset.
    const { ops, hits, pairs } = linksRepair(store, repoId, [{ from: "/b.md", to: "/c.md" }]);
    expect(ops.map((o) => typeOf((o as { block: string }).block)).sort()).toEqual(["list", "paragraph"]);
    expect(hits).toHaveLength(2);
    expect(pairs).toEqual([{ from: "/b.md", to: "/c.md", hits: 2 }]);
    const res = apply(store, { repoId, rootPath: dir, ops, origin: { actor: "agent:test" } });
    expect(res.committed).toBe(true);
    const text = readFileSync(join(dir, "list.md"), "utf8");
    expect(text).toBe("# L\n\n- item [b](/c.md) here\n- other\n\nAfter [b](/c.md).\n");
    expect(liveBytes(docId, "list")[0]).toContain("[b](/c.md)");
    expect(liveBytes(docId, "list_item").some((raw) => raw.includes("[b](/c.md)"))).toBe(true);
  });

  it("rewrites only whole destinations: prose, inline code, code fences, and longer paths stay put", () => {
    seed("scope.md", [
      "# S",
      "Prose mentions /b.md and `[x](/b.md)` inline code.",
      "```\n[fence](/b.md)\n```",
      "Real [link](/b.md) and longer [deep](/everland/b.md) and [pre](/b.md.bak).",
      "Wiki [[/b.md]] and alias [[/b.md|B]] and frag [frag](/b.md#Top) and ref [r](/b.md^abc).",
    ].join("\n\n") + "\n");
    const { ops, hits, pairs } = linksRepair(store, repoId, [{ from: "/b.md", to: "/c.md" }]);
    expect(ops).toHaveLength(2);
    const all = hits.map((h) => h.newRaw).join("\n");
    expect(all).toContain("[link](/c.md)");
    expect(all).toContain("[[/c.md]]");
    expect(all).toContain("[[/c.md|B]]");
    expect(all).toContain("[frag](/c.md#Top)");
    expect(all).toContain("[r](/c.md^abc)");
    expect(all).toContain("[deep](/everland/b.md)");
    expect(all).toContain("[pre](/b.md.bak)");
    expect(pairs).toEqual([{ from: "/b.md", to: "/c.md", hits: 5 }]);
    apply(store, { repoId, rootPath: dir, ops, origin: { actor: "agent:test" } });
    const text = readFileSync(join(dir, "scope.md"), "utf8");
    expect(text).toContain("Prose mentions /b.md and `[x](/b.md)` inline code.");
    expect(text).toContain("```\n[fence](/b.md)\n```");
    expect(text).not.toContain("//");
  });

  it("accepts `from` with or without the leading slash (links_stale's `target` form works)", () => {
    seed("t.md", "# T\n\nSee [b](/b.md) and [rel](b.md).\n");
    const { hits, pairs } = linksRepair(store, repoId, [{ from: "b.md", to: "/c.md" }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.newRaw).toContain("[b](/c.md) and [rel](/c.md)");
    expect(pairs[0]!.hits).toBe(2);
  });

  it("scopes source docs with pathGlob and reports each hit's path", () => {
    seed("j-one.md", "# J\n\n[b](/b.md)\n");
    seed("g-one.md", "# G\n\n[b](/b.md)\n");
    const { hits, pairs } = linksRepair(store, repoId, [{ from: "/b.md", to: "/c.md" }], { pathGlob: "j-*" });
    expect(hits.map((h) => h.path)).toEqual(["j-one.md"]);
    expect(pairs[0]!.hits).toBe(1);
    expect(linksRepair(store, repoId, [{ from: "/b.md", to: "/c.md" }]).hits.map((h) => h.path).sort()).toEqual(["g-one.md", "j-one.md"]);
  });

  it("each destination takes the first matching pair — no chaining; unmatched pairs report 0", () => {
    seed("chain.md", "# C\n\n[a](/a.md) [b](/b.md)\n");
    const { hits, pairs } = linksRepair(store, repoId, [
      { from: "/a.md", to: "/b.md" },
      { from: "/b.md", to: "/c.md" },
      { from: "/nope.md", to: "/x.md" },
    ]);
    expect(hits[0]!.newRaw).toContain("[a](/b.md) [b](/c.md)");
    expect(pairs.map((p) => p.hits)).toEqual([1, 1, 0]);
  });
});
