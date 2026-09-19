import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../store/store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { docsList, docsTree, normalizeTreePrefix } from "./reader.js";

// docs_list (the flat `ls`) and docs_tree (the path-separator-aware
// orientation read). Both page under the uniform list contract (mcp-api §1).

let store: Store;
let repoId: string;

const FILES: Record<string, string> = {
  "AGENTS.md": "# Guide\n\nRead me.\n",
  "projects/omg.md": "# omg\n\nhub\n\nmore\n",
  "projects/omg/complaints.md": "# Complaints\n\n- one\n- two\n",
  "projects/muviz.md": "# muviz\n",
  "terms/types/concept.md": "# Concept\n",
  "terms/fields/type.md": "# type\n",
  "terms/rules/a.md": "# a\n",
  "scratch/x.md": "x\n",
};

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
  for (const [path, content] of Object.entries(FILES)) ingestFile(store, repoId, path, content);
});
afterEach(() => store.close());

describe("docsList — paged flat listing", () => {
  it("lists every live doc ordered by path with an honest truncated=false", () => {
    const page = docsList(store, repoId);
    expect(page.items.map((r) => r.path)).toEqual(Object.keys(FILES).sort());
    expect(page.truncated).toBe(false);
    expect(page.cursor).toBeNull();
    const omg = page.items.find((r) => r.path === "projects/omg.md")!;
    expect(omg.blocks).toBe(3);
    expect(typeof omg.ts).toBe("string");
  });

  it("path_glob is a LIKE match where * crosses '/'", () => {
    const page = docsList(store, repoId, { pathGlob: "projects/*" });
    expect(page.items.map((r) => r.path)).toEqual(["projects/muviz.md", "projects/omg.md", "projects/omg/complaints.md"]);
  });

  it("limit + cursor page through without gaps or overlap", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = docsList(store, repoId, { limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((r) => r.path));
      if (page.truncated) expect(page.cursor).not.toBeNull();
      else expect(page.cursor).toBeNull();
      cursor = page.truncated ? page.cursor : null;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(Object.keys(FILES).sort());
  });

  it("an exactly-full last page is not flagged truncated", () => {
    const page = docsList(store, repoId, { limit: Object.keys(FILES).length });
    expect(page.truncated).toBe(false);
    expect(page.cursor).toBeNull();
  });

  it("budget_tokens cuts the page early, flags it, and still returns at least one row", () => {
    const page = docsList(store, repoId, { budgetTokens: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(page.cursor).not.toBeNull();
    const next = docsList(store, repoId, { cursor: page.cursor });
    expect(next.items[0]!.path).toBe(Object.keys(FILES).sort()[1]);
  });

  it("a malformed cursor is a loud filter_invalid, never a silent restart", () => {
    expect(() => docsList(store, repoId, { cursor: "not-a-cursor" })).toThrow(/invalid cursor/);
  });
});

describe("docsTree — directory-aware orientation", () => {
  it("normalizes the prefix", () => {
    expect(normalizeTreePrefix(undefined)).toBe("");
    expect(normalizeTreePrefix("")).toBe("");
    expect(normalizeTreePrefix("/")).toBe("");
    expect(normalizeTreePrefix("projects")).toBe("projects/");
    expect(normalizeTreePrefix("/projects/")).toBe("projects/");
  });

  it("depth 1 at the root collapses each top-level dir into one entry with totals", () => {
    const tree = docsTree(store, repoId);
    expect(tree.prefix).toBe("");
    expect(tree.depth).toBe(1);
    const rows = docsList(store, repoId).items;
    const blocksUnder = (prefix: string): number => rows.filter((r) => r.path.startsWith(prefix)).reduce((n, r) => n + r.blocks, 0);
    expect(tree.total).toEqual({ docs: 8, blocks: blocksUnder("") });
    expect(tree.truncated).toBe(false);
    expect(tree.entries.map((e) => [e.path, e.kind, e.docs])).toEqual([
      ["AGENTS.md", "doc", 1],
      ["projects/", "dir", 3],
      ["scratch/", "dir", 1],
      ["terms/", "dir", 3],
    ]);
    const projects = tree.entries.find((e) => e.path === "projects/")!;
    expect(projects.blocks).toBe(blocksUnder("projects/"));
    expect(projects.blocks).toBeGreaterThan(rows.find((r) => r.path === "projects/omg.md")!.blocks);
    expect(typeof projects.ts).toBe("string");
    // total blocks == sum over entries when nothing is paged out
    expect(tree.entries.reduce((n, e) => n + e.blocks, 0)).toBe(tree.total.blocks);
  });

  it("a prefix scopes the tree and depth expands it", () => {
    const one = docsTree(store, repoId, { path: "projects" });
    expect(one.prefix).toBe("projects/");
    expect(one.total.docs).toBe(3);
    expect(one.entries.map((e) => [e.path, e.kind])).toEqual([
      ["projects/muviz.md", "doc"],
      ["projects/omg.md", "doc"],
      ["projects/omg/", "dir"],
    ]);

    const two = docsTree(store, repoId, { path: "/terms/", depth: 2 });
    expect(two.entries.map((e) => [e.path, e.kind])).toEqual([
      ["terms/fields/type.md", "doc"],
      ["terms/rules/a.md", "doc"],
      ["terms/types/concept.md", "doc"],
    ]);
  });

  it("an unknown prefix is an empty tree, not an error", () => {
    const tree = docsTree(store, repoId, { path: "nope" });
    expect(tree.entries).toEqual([]);
    expect(tree.total).toEqual({ docs: 0, blocks: 0 });
    expect(tree.truncated).toBe(false);
  });

  it("pages entries under limit/cursor while total stays whole-prefix", () => {
    const first = docsTree(store, repoId, { limit: 2 });
    expect(first.entries.map((e) => e.path)).toEqual(["AGENTS.md", "projects/"]);
    expect(first.truncated).toBe(true);
    expect(first.total.docs).toBe(8);
    const second = docsTree(store, repoId, { limit: 2, cursor: first.cursor });
    expect(second.entries.map((e) => e.path)).toEqual(["scratch/", "terms/"]);
    expect(second.truncated).toBe(false);
    expect(second.cursor).toBeNull();
  });

  it("budget_tokens truncates with a resumable cursor", () => {
    const tight = docsTree(store, repoId, { budgetTokens: 1 });
    expect(tight.entries).toHaveLength(1);
    expect(tight.truncated).toBe(true);
    expect(tight.cursor).not.toBeNull();
  });
});
