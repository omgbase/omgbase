import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { query } from "./query.js";

// Proves the documents-target CEL path resolves against the `properties` table,
// not documents.metadata. To rule out silent fall-through to json_extract, each
// test NULLs out metadata after ingest so a metadata-based compile would fail.

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
});
afterEach(() => store.close());

function ingestNoMeta(path: string, content: string): void {
  ingestFile(store, repoId, path, content);
  // Blank the JSON blob so any residual json_extract path returns nothing —
  // if a query still matches, it MUST be coming from `properties`.
  store.db.prepare("UPDATE documents SET metadata = '{}' WHERE path = ?").run(path);
}

function paths(filter: string): string[] {
  return query(store, repoId, { from: "documents", filter }).hits.map((h) => h.path).sort();
}

describe("documents queries resolve from properties (metadata blanked)", () => {
  beforeEach(() => {
    ingestNoMeta("a.md", "---\nlayer: working\ntags: [pricing, saas]\npriority: 3\n---\n\n# A\n");
    ingestNoMeta("b.md", "---\nlayer: draft\ntags: docs\npriority: 1\n---\n\n# B\n");
    ingestNoMeta("c.md", "---\nlayer: canon\nmeta:\n  owner: alice\n---\n\n# C\n");
  });

  it("scalar equality", () => {
    expect(paths('layer == "working"')).toEqual(["a.md"]);
  });

  it("numeric range", () => {
    expect(paths("priority >= 2")).toEqual(["a.md"]);
  });

  it("nested dotted key", () => {
    expect(paths('meta.owner == "alice"')).toEqual(["c.md"]);
  });

  it("list() membership over a YAML list", () => {
    expect(paths('"pricing" in list(tags)')).toEqual(["a.md"]);
  });

  it("list() membership also matches a scalar-authored value", () => {
    expect(paths('"docs" in list(tags)')).toEqual(["b.md"]);
  });

  it("scalar == on a list value is FALSE (must use list())", () => {
    // a.md tags is a list [pricing, saas]; scalar equality must not match.
    expect(paths('tags == "pricing"')).toEqual([]);
  });

  it("size(list()) counts list vs scalar vs absent", () => {
    expect(paths("size(list(tags)) > 1")).toEqual(["a.md"]);         // list of 2
    expect(paths("size(list(tags)) == 1")).toEqual(["b.md"]);        // scalar ⇒ 1
    expect(paths("size(list(priority)) == 0")).toEqual(["c.md"]);    // c has no priority ⇒ 0
  });

  it("has() and bare-bool + negation", () => {
    expect(paths("has(meta.owner)")).toEqual(["c.md"]);
    expect(paths("layer")).toEqual(["a.md", "b.md", "c.md"]); // all have a truthy layer
    expect(paths("!priority")).toEqual(["c.md"]);             // c has no priority
  });
});

describe("source-scoped access", () => {
  beforeEach(() => {
    // frontmatter job=farmer; inline job:: janitor / salesman
    ingestNoMeta("d.md", "---\njob: farmer\n---\n\n# D\n\njob:: janitor\n\njob:: salesman\n");
  });

  it("bare key spans authored sources (frontmatter + inline)", () => {
    expect(paths('"farmer" in list(job)')).toEqual(["d.md"]);
    expect(paths('"janitor" in list(job)')).toEqual(["d.md"]);
    expect(paths('"salesman" in list(job)')).toEqual(["d.md"]);
    expect(paths("size(list(job)) == 3")).toEqual(["d.md"]);
  });

  it("frontmatter.<k> narrows to the fence", () => {
    expect(paths('frontmatter.job == "farmer"')).toEqual(["d.md"]);
    expect(paths('"janitor" in list(frontmatter.job)')).toEqual([]);
  });

  it("inline.<k> narrows to inline fields", () => {
    expect(paths('"janitor" in list(inline.job)')).toEqual(["d.md"]);
    expect(paths('"farmer" in list(inline.job)')).toEqual([]);
  });
});
