import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parse } from "@omgbase/oqx";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { oqxRun, oqxRunQuery } from "./run.js";
import { checkNames, editDistance, nearest, vocabulary } from "./names.js";

// Unknown names (spec/surface §1.5, 4.6). The fixtures (`query-unknown.json`)
// pin the messages over the alchemy corpus; this file pins the rules at the
// unit — the vocabulary and its cache, the tiers on a tiny repository, the
// empty-vocabulary edge, the dotted-prefix rule, the nearest-match rule, and
// the two entry points' defaults.
let store: Store;
let repoId: string;
beforeAll(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "names", "/tmp/names");
  ingestFile(store, repoId, "a.md", "---\nkind: x\nmeta:\n  owner: bb\n---\n\n# A\n\n- [ ] a task\n\n```js\nlet x;\n```\n");
  ingestFile(store, repoId, "b.md", "---\nkind: y\n---\n\n# B\n\nstage:: calcination\n");
});
afterAll(() => store.close());

describe("the vocabulary (§1.5)", () => {
  it("docs: every live frontmatter and inline key, flattened; blocks and nodes: the attrs keys live rows carry; links: none", () => {
    expect(vocabulary(store, repoId, "docs")).toEqual({ present: true, keys: ["kind", "meta.owner", "stage"] });
    expect(vocabulary(store, repoId, "blocks")).toEqual({ present: true, keys: ["checked", "lang", "level", "ordered"] });
    expect(vocabulary(store, repoId, "nodes")).toEqual({ present: true, keys: ["checked", "first_ordinal", "last_ordinal", "level"] });
    expect(vocabulary(store, repoId, "links")).toEqual({ present: false, keys: [] });
  });

  it("is cached on the head commit: a new commit refreshes it", () => {
    const fresh = new Store({ path: ":memory:" });
    try {
      const r = ensureRepo(fresh, "cache", "/tmp/cache");
      ingestFile(fresh, r, "a.md", "---\nkind: x\n---\n\n# A\n");
      expect(vocabulary(fresh, r, "docs").keys).toEqual(["kind"]);
      expect(oqxRun(fresh, r, "select color from docs").hints).toHaveLength(1);
      ingestFile(fresh, r, "b.md", "---\ncolor: red\n---\n\n# B\n");
      expect(vocabulary(fresh, r, "docs").keys).toEqual(["color", "kind"]);
      expect(oqxRun(fresh, r, "select color from docs").hints).toBeUndefined();
    } finally {
      fresh.close();
    }
  });
});

describe("the three tiers (§1.5)", () => {
  const hints = (q: string): string[] | undefined => checkNamesHints(q);
  const checkNamesHints = (q: string): string[] | undefined => {
    const h = checkNames(store, repoId, parse(q), "hint");
    return h.length === 0 ? undefined : h;
  };

  it("tier 1: attributes, handles and relations are silent", () => {
    expect(hints("select title, tags, path, blocks, d: doc.id from docs where nodes exists { where kind == \"md:task\" }")).toBeUndefined();
    expect(hints("select type, text, attrs, children, section.level, doc.title from blocks")).toBeUndefined();
    expect(hints("select dst_path, s: doc.title, t: dst.title from links")).toBeUndefined();
  });

  it("tier 2: a property some objects carry is silent; a dotted prefix of a key is known", () => {
    expect(hints("select stage, kind from docs where meta.owner == \"bb\"")).toBeUndefined();
    expect(hints("select meta from docs")).toBeUndefined();
    expect(hints("select checked from blocks where lang == \"js\"")).toBeUndefined();
  });

  it("tier 3: a name no object carries is one hint per name, first-reference order, deduplicated", () => {
    expect(hints("select stag, kynd from docs where stag == \"x\" order by kynd")).toEqual([
      "`stag` is not a field of docs and no document in this repository carries a property by that name; did you mean `stage`?",
      "`kynd` is not a field of docs and no document in this repository carries a property by that name; did you mean `kind`?",
    ]);
    expect(hints("select meta.ownr, stage.x from docs")).toEqual([
      "`meta.ownr` is not a field of docs and no document in this repository carries a property by that name; did you mean `meta.owner`?",
      "`stage.x` is not a field of docs and no document in this repository carries a property by that name; did you mean `stage`?",
    ]);
  });

  it("a name under a source handle is the handle form, with authored keys as candidates", () => {
    expect(hints("select p: data.path, k: frontmatter.kynd from docs")).toEqual([
      "no document in this repository carries a property `path` (`data.path`)",
      "no document in this repository carries a property `kynd` (`frontmatter.kynd`); did you mean `kind`?",
    ]);
  });

  it("a name on links is the error in either mode; a name reached through dst is a docs hint", () => {
    const err = "`target` is not a field of links (fields: id, path, doc_id, block_id, via_id, dst_id, dst_path, uri, field, dst_kind, predicate, provenance, anchor)";
    expect(() => checkNames(store, repoId, parse("select target from links"), "hint")).toThrow(err);
    expect(() => checkNames(store, repoId, parse("from docs where out_links exists { where target == \"x\" }"), "hint")).toThrow(err);
    expect(hints("select dst.kynd from links")).toEqual(["`kynd` is not a field of docs and no document in this repository carries a property by that name; did you mean `kind`?"]);
  });

  it("refuse mode throws the hint text as filter_invalid before any row is read", () => {
    let thrown: unknown;
    try { checkNames(store, repoId, parse("select stag from docs"), "refuse"); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(FilterInvalid);
    expect((thrown as FilterInvalid).message).toBe("`stag` is not a field of docs and no document in this repository carries a property by that name; did you mean `stage`?");
    expect((thrown as FilterInvalid).hint).toBe("OQX");
  });

  it("what is not judged: aliases where resolved, lifts, $-names, function names, attribute tails, unknown-kind scopes", () => {
    expect(hints("select s: stage, n: s from docs where s == \"x\"")).toBeUndefined();
    expect(hints("select p: path, open from docs where nodes collect { ^open: value where kind == \"md:task\" }")).toBeUndefined();
    expect(hints("select $key: id from docs where $depth > 0 and has(stage) and size(list(kind)) > 0")).toBeUndefined();
    expect(hints("select a: attrs.whatever from blocks")).toBeUndefined();
    expect(hints("select n: tags.size() from docs")).toBeUndefined();
    // `refs(before)` yields documents (judged); a tuple receiver has no one kind (not judged).
    expect(hints("select r: refs(stage) collect { select kynd } from docs")).toHaveLength(1);
    expect(hints("select t: (blocks, nodes) collect { select kynd } from docs")).toBeUndefined();
  });

  it("a repository with no object of a kind has no vocabulary: the check is skipped for that kind", () => {
    const empty = new Store({ path: ":memory:" });
    try {
      const r = ensureRepo(empty, "empty", "/tmp/empty");
      expect(oqxRun(empty, r, "select titel from docs where layr == \"x\"").hints).toBeUndefined();
      expect(oqxRun(empty, r, "select preview from blocks").hints).toBeUndefined();
      // links stay closed even in an empty repository
      expect(() => oqxRun(empty, r, "select target from links")).toThrow("is not a field of links");
    } finally {
      empty.close();
    }
  });
});

describe("the nearest match (§1.5)", () => {
  it("optimal string alignment: substitutions, insertions, deletions and adjacent transpositions cost one", () => {
    expect(editDistance("title", "titel")).toBe(1);
    expect(editDistance("stag", "stage")).toBe(1);
    expect(editDistance("value", "text")).toBe(5);
    expect(editDistance("via", "via_id")).toBe(3);
    expect(editDistance("x", "id")).toBe(2);
  });

  it("distance ≤ 2 or a substring of ≥ 3 characters, case-insensitive; one typo first, then a substring, then distance 2; shorter, alphabetical; under 3 characters or none → null", () => {
    const links = ["id", "path", "doc_id", "block_id", "via_id", "dst_id", "dst_path", "uri", "field", "dst_kind", "predicate", "provenance", "anchor"];
    expect(nearest("dst_pth", links)).toBe("dst_path");
    expect(nearest("target", links)).toBeNull();
    expect(nearest("DST", links)).toBe("dst_id"); // three prefix matches at distance 3, 5, 5 — the lowest distance
    expect(nearest("via", links)).toBe("via_id"); // the substring outranks `id` at distance 2
    expect(nearest("x", links)).toBeNull(); // under three characters: no suggestion
    expect(nearest("in", ["id", "in_links", "out_links"])).toBeNull();
    expect(nearest("tag", ["id", "path", "tags", "title"])).toBe("tags");
    expect(nearest("preview", ["id", "path", "type", "text", "attrs", "depth", "ordinal", "children"])).toBeNull();
    expect(nearest("predicat", links)).toBe("predicate");
    expect(nearest("abc", ["acb", "abc_x", "abd"])).toBe("abd"); // one typo (two of them, alphabetical) beats the substring
    expect(nearest("abcd", ["abxy", "abcd_x"])).toBe("abcd_x");
    expect(nearest("abc", ["abcd", "xabc"])).toBe("abcd"); // equal distance: alphabetical
  });
});

describe("the two entry points", () => {
  it("the source entry hints and appends `hints` last; the AST entry refuses", () => {
    const res = oqxRun(store, repoId, "select stag from docs order by path");
    expect(Object.keys(res)).toEqual(["hits", "truncated", "cursor", "consumer", "hints"]);
    expect(res.hits).toHaveLength(2);
    expect(oqxRun(store, repoId, "docs count { where stag == \"x\" }")).toMatchObject({ consumer: "count", count: 0, hints: [expect.stringContaining("`stag`")] });
    expect(oqxRun(store, repoId, "select stage from docs")).not.toHaveProperty("hints");
    expect(() => oqxRunQuery(store, repoId, parse("select stag from docs"))).toThrow("did you mean `stage`?");
    expect(oqxRunQuery(store, repoId, parse("select stag from docs"), { unknownNames: "hint" }).hints).toHaveLength(1);
    expect(() => oqxRun(store, repoId, "select stag from docs", { unknownNames: "refuse" })).toThrow(FilterInvalid);
  });
});
