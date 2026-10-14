import { describe, expect, it } from "vitest";
import { dirBadge, entryLabel, entryOf, fetchLevel, levelOf, prefixesToOpen, treeArgs } from "../src/lib/tree.ts";
import { ScriptedCaller } from "./scripted.ts";

// The docs_tree page as spec/surface §2 spells it (the examples.json fixture).
const ROOT = {
  prefix: "/", depth: 1, total: { docs: 20, blocks: 327 },
  entries: [
    { id: "d_0", path: "/index.md", kind: "doc", docs: 1, blocks: 31, updated_at: "2026-09-27T00:00:00.000Z" },
    { path: "/lab/", kind: "dir", docs: 2, blocks: 51, updated_at: "2026-09-27T00:00:00.000Z" },
    { path: "/processes/", kind: "dir", docs: 4, blocks: 71, updated_at: "2026-09-27T00:00:00.000Z" },
  ],
  truncated: false, cursor: null,
};

describe("docs_tree → the level", () => {
  it("reads dir and doc entries, roots paths, keeps total/truncated/cursor", () => {
    const level = levelOf(ROOT);
    expect(level.prefix).toBe("/");
    expect(level.total).toEqual({ docs: 20, blocks: 327 });
    expect(level.entries).toEqual([
      { kind: "doc", id: "d_0", path: "/index.md", blocks: 31, updatedAt: "2026-09-27T00:00:00.000Z" },
      { kind: "dir", path: "/lab/", docs: 2, blocks: 51, updatedAt: "2026-09-27T00:00:00.000Z" },
      { kind: "dir", path: "/processes/", docs: 4, blocks: 71, updatedAt: "2026-09-27T00:00:00.000Z" },
    ]);
    expect(entryOf({ path: "lab", kind: "dir", docs: 1, blocks: 1 })).toMatchObject({ kind: "dir", path: "/lab/" });
    expect(entryOf({ kind: "doc" })).toBeNull();
    expect(entryOf({ path: "/x", kind: "other" })).toBeNull();
  });
  it("labels entries by their last segment and badges a directory", () => {
    expect(entryLabel({ path: "/processes/" })).toBe("processes");
    expect(entryLabel({ path: "/processes/calcination.md" })).toBe("calcination.md");
    expect(dirBadge({ kind: "dir", path: "/lab/", docs: 1, blocks: 3, updatedAt: null })).toBe("1 doc");
    expect(dirBadge({ kind: "dir", path: "/lab/", docs: 4, blocks: 3, updatedAt: null })).toBe("4 docs");
  });
  it("spells the call: no path for the root, depth 1, the cursor when paging, repo only when chosen", () => {
    expect(treeArgs("/", null)).toEqual({ depth: 1 });
    expect(treeArgs("/processes/", "alchemy", "c1")).toEqual({ path: "/processes/", depth: 1, cursor: "c1", repo: "alchemy" });
  });
  it("prefixesToOpen: every folder above a document, root first", () => {
    expect(prefixesToOpen("/processes/calcination.md")).toEqual(["/", "/processes/"]);
  });
});

describe("fetchLevel over a scripted minimal server", () => {
  it("follows the cursor while truncated and concatenates the pages", async () => {
    const pages = [
      { ...ROOT, entries: ROOT.entries.slice(0, 2), truncated: true, cursor: "WyIvbGFiLyJd" },
      { ...ROOT, entries: ROOT.entries.slice(2), truncated: false, cursor: null },
    ];
    const s = new ScriptedCaller({ docs_tree: (_a, n) => pages[n] });
    const level = await fetchLevel(s, "/", null);
    expect(level.entries.map((e) => e.path)).toEqual(["/index.md", "/lab/", "/processes/"]);
    expect(level.truncated).toBe(false);
    expect(s.calls).toEqual([
      { name: "docs_tree", args: { depth: 1 } },
      { name: "docs_tree", args: { depth: 1, cursor: "WyIvbGFiLyJd" } },
    ]);
  });
});
