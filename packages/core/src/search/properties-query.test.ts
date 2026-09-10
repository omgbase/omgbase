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

describe("inline cardinality (single vs repeated vs collision)", () => {
  beforeEach(() => {
    // g: a single inline field — scalar-comparable, multi-word value intact.
    ingestFile(store, repoId, "g.md", "# G\n\nelement:: fire\n\nknown_for:: tria prima\n");
    // h: the same inline key twice — a list, so scalar == must miss.
    ingestFile(store, repoId, "h.md", "# H\n\nmood:: calm\n\nmood:: restless\n");
    // i: an inline key that COLLIDES with a frontmatter key of the same name —
    //    the bare-key union is multi-valued, so scalar == falls back to list.
    ingestFile(store, repoId, "i.md", "---\nowner: alice\n---\n\n# I\n\nowner:: bob\n");
  });

  it("a lone inline field is scalar-comparable", () => {
    expect(paths('element == "fire"')).toEqual(["g.md"]);
    expect(paths('inline.element == "fire"')).toEqual(["g.md"]);
  });

  it("a multi-word inline value is comparable whole", () => {
    expect(paths('known_for == "tria prima"')).toEqual(["g.md"]);
    expect(paths('known_for == "tria"')).toEqual([]);   // no longer truncated
  });

  it("a repeated inline key is a list — scalar == misses, list() finds it", () => {
    expect(paths('mood == "calm"')).toEqual([]);
    expect(paths('"calm" in list(mood)')).toEqual(["h.md"]);
    expect(paths('"restless" in list(mood)')).toEqual(["h.md"]);
    expect(paths("size(list(mood)) == 2")).toEqual(["h.md"]);
  });

  it("a frontmatter+inline collision on a bare key is a list, not a scalar", () => {
    // Neither authored value satisfies bare scalar == (the union has 2 rows);
    // both are reachable via list(). Source-scoped access stays scalar per side.
    expect(paths('owner == "alice"')).toEqual([]);
    expect(paths('owner == "bob"')).toEqual([]);
    expect(paths('"alice" in list(owner)')).toEqual(["i.md"]);
    expect(paths('"bob" in list(owner)')).toEqual(["i.md"]);
    expect(paths('frontmatter.owner == "alice"')).toEqual(["i.md"]);
    expect(paths('inline.owner == "bob"')).toEqual(["i.md"]);
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
