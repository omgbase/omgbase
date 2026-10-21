import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../store/store.js";
import { ensureRepo } from "../attach.js";
import { ingestFile } from "../ingest.js";
import { docsList, docsTree, normalizeTreePrefix } from "./reader.js";

// docs_list (the flat `ls`) and docs_tree (the path-separator-aware
// orientation read). Both page under the uniform list contract (mcp-api §1).

let store: Store;
let repoId: string;

// The storage paths ingested; the surface lists them in the reference form.
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

/** The reference form of every ingested path, in path order. */
const ROOTED = Object.keys(FILES).sort().map((p) => "/" + p);

describe("docsList — paged flat listing", () => {
  it("lists every live doc ordered by path with an honest truncated=false", () => {
    const page = docsList(store, repoId);
    expect(page.items.map((r) => r._path)).toEqual(ROOTED);
    expect(page.truncated).toBe(false);
    expect(page.cursor).toBeNull();
    const omg = page.items.find((r) => r._path === "/projects/omg.md")!;
    expect(omg.blocks).toBe(3);
    expect(typeof omg._updated_at).toBe("string");
  });

  it("path_glob is a LIKE match where * crosses '/'", () => {
    const page = docsList(store, repoId, { pathGlob: "projects/*" });
    expect(page.items.map((r) => r._path)).toEqual(["/projects/muviz.md", "/projects/omg.md", "/projects/omg/complaints.md"]);
  });

  it("limit + cursor page through without gaps or overlap", () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = docsList(store, repoId, { limit: 3, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((r) => r._path));
      if (page.truncated) expect(page.cursor).not.toBeNull();
      else expect(page.cursor).toBeNull();
      cursor = page.truncated ? page.cursor : null;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(ROOTED);
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
    expect(next.items[0]!._path).toBe(ROOTED[1]);
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

  it("depth 1 at the root is one row per top-level dir with totals; the root's own documents are counted, not listed (5.1)", () => {
    const tree = docsTree(store, repoId);
    expect(tree.prefix).toBe("/");
    expect(tree.depth).toBe(1);
    const rows = docsList(store, repoId).items;
    const blocksUnder = (prefix: string): number => rows.filter((r) => r._path.startsWith(prefix)).reduce((n, r) => n + r.blocks, 0);
    expect(tree.total).toEqual({ docs: 8, blocks: blocksUnder("/") });
    expect(tree.files_here).toBe(1);
    expect(tree.truncated).toBe(false);
    expect(tree.entries.map((e) => [e._path, e.docs])).toEqual([
      ["/projects/", 3],
      ["/scratch/", 1],
      ["/terms/", 3],
    ]);
    const projects = tree.entries.find((e) => e._path === "/projects/")!;
    expect(Object.keys(projects)).toEqual(["_path", "docs", "blocks"]);
    expect(projects.blocks).toBe(blocksUnder("/projects/"));
    expect(projects.blocks).toBeGreaterThan(rows.find((r) => r._path === "/projects/omg.md")!.blocks);
    // the dirs' blocks + the root's own documents' blocks == total when nothing is paged out
    const rootDocs = rows.filter((r) => !r._path.slice(1).includes("/")).reduce((n, r) => n + r.blocks, 0);
    expect(tree.entries.reduce((n, e) => n + e.blocks, 0) + rootDocs).toBe(tree.total.blocks);
  });

  it("files lists the documents as lean rows and updated adds _updated_at to every entry (5.1)", () => {
    const tree = docsTree(store, repoId, { files: true, updated: true });
    expect(tree.entries.map((e) => [e._path, e._id !== undefined, e.docs])).toEqual([
      ["/AGENTS.md", true, undefined],
      ["/projects/", false, 3],
      ["/scratch/", false, 1],
      ["/terms/", false, 3],
    ]);
    const agents = tree.entries[0]!;
    expect(Object.keys(agents)).toEqual(["_id", "_path", "blocks", "_updated_at"]);
    expect(typeof agents._updated_at).toBe("string");
    expect(Object.keys(tree.entries[1]!)).toEqual(["_path", "docs", "blocks", "_updated_at"]);
    expect(typeof tree.entries[1]!._updated_at).toBe("string");
  });

  it("a prefix scopes the tree and depth descends into nested directories (each listed after its parent)", () => {
    const one = docsTree(store, repoId, { path: "projects" });
    expect(one.prefix).toBe("/projects/");
    expect(one.total.docs).toBe(3);
    expect(one.files_here).toBe(2);
    expect(one.entries.map((e) => [e._path, e.docs])).toEqual([["/projects/omg/", 1]]);
    const files = docsTree(store, repoId, { path: "projects", files: true });
    expect(files.entries.map((e) => e._path)).toEqual(["/projects/muviz.md", "/projects/omg.md", "/projects/omg/"]);

    const two = docsTree(store, repoId, { path: "/terms/", depth: 2 });
    expect(two.files_here).toBe(0);
    expect(two.entries.map((e) => [e._path, e.docs])).toEqual([
      ["/terms/fields/", 1],
      ["/terms/rules/", 1],
      ["/terms/types/", 1],
    ]);
    const deep = docsTree(store, repoId, { depth: 2, files: true });
    expect(deep.entries.map((e) => e._path)).toEqual([
      "/AGENTS.md", "/projects/", "/projects/muviz.md", "/projects/omg.md", "/projects/omg/", "/scratch/", "/scratch/x.md", "/terms/", "/terms/fields/", "/terms/rules/", "/terms/types/",
    ]);
  });

  it("an unknown prefix is an empty tree, not an error", () => {
    const tree = docsTree(store, repoId, { path: "nope" });
    expect(tree.entries).toEqual([]);
    expect(tree.total).toEqual({ docs: 0, blocks: 0 });
    expect(tree.truncated).toBe(false);
  });

  it("pages entries under limit/cursor while total stays whole-prefix", () => {
    const first = docsTree(store, repoId, { files: true, limit: 2 });
    expect(first.entries.map((e) => e._path)).toEqual(["/AGENTS.md", "/projects/"]);
    expect(first.truncated).toBe(true);
    expect(first.total.docs).toBe(8);
    expect(first.files_here).toBe(1);
    const second = docsTree(store, repoId, { files: true, limit: 2, cursor: first.cursor });
    expect(second.entries.map((e) => e._path)).toEqual(["/scratch/", "/terms/"]);
    expect(second.truncated).toBe(false);
    expect(second.cursor).toBeNull();
    expect(second.files_here).toBe(1);
  });

  it("budget_tokens truncates with a resumable cursor", () => {
    const tight = docsTree(store, repoId, { budgetTokens: 1 });
    expect(tight.entries).toHaveLength(1);
    expect(tight.truncated).toBe(true);
    expect(tight.cursor).not.toBeNull();
  });
});
