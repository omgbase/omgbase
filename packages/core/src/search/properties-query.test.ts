import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { query } from "./query.js";

// The docs-target CEL path resolves against the `properties` table (the
// docs.metadata column no longer exists, so a match can only come from
// properties). These exercise scalar/list/nested/source-scoped resolution.

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", "/tmp");
});
afterEach(() => store.close());

function paths(filter: string): string[] {
  return query(store, repoId, { from: "docs", filter }).hits.map((h) => h.path).sort();
}

describe("docs queries resolve from properties", () => {
  beforeEach(() => {
    ingestFile(store, repoId, "a.md", "---\nlayer: working\ntags: [pricing, saas]\npriority: 3\n---\n\n# A\n");
    ingestFile(store, repoId, "b.md", "---\nlayer: draft\ntags: docs\npriority: 1\n---\n\n# B\n");
    ingestFile(store, repoId, "c.md", "---\nlayer: canon\nmeta:\n  owner: alice\n---\n\n# C\n");
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
    ingestFile(store, repoId, "d.md", "---\njob: farmer\n---\n\n# D\n\njob:: janitor\n\njob:: salesman\n");
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

describe("computed $-intrinsics ($title, $tags)", () => {
  beforeEach(() => {
    // Authored title=Fromage collides with the computed $title (first H1).
    ingestFile(store, repoId, "e.md", "---\ntitle: Fromage\n---\n\n# Cheese Guide\n\nabout #dairy and #cheese stuff\n");
    ingestFile(store, repoId, "f.md", "# Other\n\nno tags here\n");
  });

  it("$title is the first H1, distinct from authored title", () => {
    expect(paths('$title == "Cheese Guide"')).toEqual(["e.md"]);
    expect(paths('title == "Fromage"')).toEqual(["e.md"]);   // authored, not shadowed
    expect(paths('$title == "Fromage"')).toEqual([]);        // computed != authored
    expect(paths('title == "Cheese Guide"')).toEqual([]);
  });

  it("$tags is body hashtags via list()", () => {
    expect(paths('"dairy" in list($tags)')).toEqual(["e.md"]);
    expect(paths('"cheese" in list($tags)')).toEqual(["e.md"]);
    expect(paths("size(list($tags)) == 2")).toEqual(["e.md"]);
    expect(paths("has($tags)")).toEqual(["e.md"]);            // f.md has none
  });
});
