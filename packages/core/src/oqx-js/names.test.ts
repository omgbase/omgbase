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
// unit — the vocabulary and its cache, the name rule on a tiny repository, the
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

describe("the name rule (§1.5, 5.0: a bare name is the author's, an underscore name the engine's)", () => {
  const hints = (q: string): string[] | undefined => checkNamesHints(q);
  const checkNamesHints = (q: string): string[] | undefined => {
    const h = checkNames(store, repoId, parse(q), "hint");
    return h.length === 0 ? undefined : h;
  };

  it("engine names — attributes, handles and relations — are silent", () => {
    expect(hints("select _title, _tags, _path, _blocks, d: $it._id from docs where _nodes exists { where _kind == \"md:task\" }")).toBeUndefined();
    expect(hints("select _type, _text, _attrs, _children, _section.level, _doc._title from blocks")).toBeUndefined();
    expect(hints("select _dst_path, s: _doc._title, t: _dst._title from links")).toBeUndefined();
  });

  it("a bare property some objects carry is silent; a dotted prefix of a key is known", () => {
    expect(hints("select stage, kind from docs where meta.owner == \"bb\"")).toBeUndefined();
    expect(hints("select meta from docs")).toBeUndefined();
    expect(hints("select checked from blocks where lang == \"js\"")).toBeUndefined();
  });

  it("a bare name no object carries is one hint per name, first-reference order, deduplicated", () => {
    expect(hints("select stag, kynd from docs where stag == \"x\" order by kynd")).toEqual([
      "no document in this repository carries a property `stag`; did you mean `stage`?",
      "no document in this repository carries a property `kynd`; did you mean `kind`?",
    ]);
    expect(hints("select meta.ownr, stage.x from docs")).toEqual([
      "no document in this repository carries a property `meta.ownr`; did you mean `meta.owner`?",
      "no document in this repository carries a property `stage.x`; did you mean `stage`?",
    ]);
  });

  it("a bare name that spells an engine attribute without its prefix is pointed at the engine name outright", () => {
    expect(hints("select id, title, path, tags, format from docs")).toEqual([
      "no document in this repository carries a property `id`; did you mean `_id`?",
      "no document in this repository carries a property `title`; did you mean `_title`?",
      "no document in this repository carries a property `path`; did you mean `_path`?",
      "no document in this repository carries a property `tags`; did you mean `_tags`?",
      "no document in this repository carries a property `format`; did you mean `_format`?",
    ]);
    expect(hints("select text, preview from blocks")).toEqual([
      "no block in this repository carries a property `text`; did you mean `_text`?",
      "no block in this repository carries a property `preview`",
    ]);
  });

  it("an underscore name that is no engine name of the kind is filter_invalid naming the kind's engine names, in either mode", () => {
    const docsErr = "`_nope` is not an engine name of docs (engine names: _id, _path, _raw, _hash, _updated_at, _created_at, _title, _tags, _format, _data, _frontmatter, _inline, _blocks, _nodes, _out_links, _in_links, _revisions); did you mean `_nodes`?";
    expect(() => checkNames(store, repoId, parse("select _nope from docs"), "hint")).toThrow(docsErr);
    expect(() => checkNames(store, repoId, parse("select _nope from docs"), "refuse")).toThrow(docsErr);
    expect(() => oqxRun(store, repoId, "select _nope from docs")).toThrow(FilterInvalid);
    // the nearest match is drawn from the engine names and the authored keys: a `_kind` written for the authored `kind` is pointed at it
    expect(() => checkNames(store, repoId, parse("from docs where _kind == \"x\""), "hint")).toThrow("`_kind` is not an engine name of docs (engine names: _id, _path, _raw, _hash, _updated_at, _created_at, _title, _tags, _format, _data, _frontmatter, _inline, _blocks, _nodes, _out_links, _in_links, _revisions); did you mean `kind`?");
    expect(() => checkNames(store, repoId, parse("select _tittle from blocks"), "hint")).toThrow("`_tittle` is not an engine name of blocks (engine names: _id, _path, _raw, _hash, _updated_at, _created_at, _doc_id, _type, _text, _attrs, _depth, _ordinal, _doc, _children, _nodes, _out_links, _section)");
    // behind a reach-through the name is judged against the reached kind
    expect(() => checkNames(store, repoId, parse("select _doc._nope from blocks"), "hint")).toThrow("`_nope` is not an engine name of docs");
  });

  it("a name under a source handle is shown with the handle, with the authored keys alone as candidates", () => {
    expect(hints("select p: _data.path, k: _frontmatter.kynd from docs")).toEqual([
      "no document in this repository carries a property `path` (`_data.path`)",
      "no document in this repository carries a property `kynd` (`_frontmatter.kynd`); did you mean `kind`?",
    ]);
  });

  it("a bare name on links is the closed-kind error in either mode; a name reached through _dst is a docs hint", () => {
    const err = "`target` reads an authored property, and a link carries none (engine names: _id, _path, _doc_id, _block_id, _via_id, _dst_id, _dst_path, _uri, _field, _dst_kind, _predicate, _provenance, _anchor, _doc, _dst, _block)";
    expect(() => checkNames(store, repoId, parse("select target from links"), "hint")).toThrow(err);
    expect(() => checkNames(store, repoId, parse("from docs where _out_links exists { where target == \"x\" }"), "hint")).toThrow(err);
    expect(() => checkNames(store, repoId, parse("select dst_path from links"), "hint")).toThrow("`dst_path` reads an authored property, and a link carries none (engine names: _id, _path, _doc_id, _block_id, _via_id, _dst_id, _dst_path, _uri, _field, _dst_kind, _predicate, _provenance, _anchor, _doc, _dst, _block); did you mean `_dst_path`?");
    expect(() => checkNames(store, repoId, parse("select rev from revisions"), "hint")).toThrow("`rev` reads an authored property, and a revision carries none (engine names: _id, _path, _rev, _seq, _doc_id, _commit, _ts, _origin, _actor, _reason, _hash, _is_current, _archived, _doc); did you mean `_rev`?");
    expect(hints("select _dst.kynd from links")).toEqual(["no document in this repository carries a property `kynd`; did you mean `kind`?"]);
  });

  it("refuse mode throws the hint text as filter_invalid before any row is read", () => {
    let thrown: unknown;
    try { checkNames(store, repoId, parse("select stag from docs"), "refuse"); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(FilterInvalid);
    expect((thrown as FilterInvalid).message).toBe("no document in this repository carries a property `stag`; did you mean `stage`?");
    expect((thrown as FilterInvalid).hint).toBe("OQX");
  });

  it("what is not judged: aliases where resolved, lifts, $-names, function names, attribute tails, unknown-kind scopes", () => {
    expect(hints("select s: stage, n: s from docs where s == \"x\"")).toBeUndefined();
    expect(hints("select p: _path, open from docs where _nodes collect { ^open: _value where _kind == \"md:task\" }")).toBeUndefined();
    expect(hints("select $key: _id from docs where $depth > 0 and has(stage) and size(list(kind)) > 0")).toBeUndefined();
    expect(hints("select a: _attrs.whatever from blocks")).toBeUndefined();
    expect(hints("select n: _tags.size() from docs")).toBeUndefined();
    // `refs(before)` yields documents (judged); a tuple receiver has no one kind (not judged).
    expect(hints("select r: refs(stage) collect { select kynd } from docs")).toHaveLength(1);
    expect(hints("select t: (_blocks, _nodes) collect { select kynd } from docs")).toBeUndefined();
  });

  it("a repository with no object of a kind has no vocabulary: the check is skipped for that kind", () => {
    const empty = new Store({ path: ":memory:" });
    try {
      const r = ensureRepo(empty, "empty", "/tmp/empty");
      expect(oqxRun(empty, r, "select titel from docs where layr == \"x\"").hints).toBeUndefined();
      expect(oqxRun(empty, r, "select preview from blocks").hints).toBeUndefined();
      // links stay closed even in an empty repository
      expect(() => oqxRun(empty, r, "select target from links")).toThrow("reads an authored property, and a link carries none");
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

  it("distance ≤ 2 or a substring of ≥ 3 characters, case-insensitive; the exact `_`-prefixed/unprefixed twin first, then one typo, then a substring, then distance 2; shorter, alphabetical; under 3 characters or none → null", () => {
    const links = ["_id", "_path", "_doc_id", "_block_id", "_via_id", "_dst_id", "_dst_path", "_uri", "_field", "_dst_kind", "_predicate", "_provenance", "_anchor"];
    // the one certain hint: a name that is a candidate with the engine prefix added or removed wins outright, whatever its length
    expect(nearest("id", links)).toBe("_id"); // under three characters, but the twin rule comes first
    expect(nearest("dst_path", links)).toBe("_dst_path");
    expect(nearest("title", ["titel", "_title"])).toBe("_title"); // beats the one-typo `titel`
    expect(nearest("_kind", ["kinds", "kind"])).toBe("kind"); // the reverse: an engine spelling of an authored key
    expect(nearest("dst_pth", links)).toBe("_dst_path");
    expect(nearest("target", links)).toBeNull();
    expect(nearest("DST", links)).toBe("_dst_id"); // three substring matches at distance 4, 6, 6 — the lowest distance
    expect(nearest("via", links)).toBe("_via_id"); // the substring outranks `_id` at distance 2
    expect(nearest("x", links)).toBeNull(); // under three characters: no suggestion
    expect(nearest("in", ["_id", "_in_links", "_out_links"])).toBeNull();
    expect(nearest("tag", ["_id", "_path", "_tags", "_title"])).toBe("_tags");
    expect(nearest("preview", ["_id", "_path", "_type", "_text", "_attrs", "_depth", "_ordinal", "_children"])).toBeNull();
    expect(nearest("predicat", links)).toBe("_predicate");
    expect(nearest("abc", ["acb", "abc_x", "abd"])).toBe("abd"); // one typo (two of them, alphabetical) beats the substring
    expect(nearest("abcd", ["abxy", "abcd_x"])).toBe("abcd_x");
    expect(nearest("abc", ["abcd", "xabc"])).toBe("abcd"); // equal distance: alphabetical
  });
});

describe("the two entry points", () => {
  it("the source entry hints and appends `hints` last; the AST entry refuses", () => {
    const res = oqxRun(store, repoId, "select stag from docs order by _path");
    expect(Object.keys(res)).toEqual(["hits", "truncated", "cursor", "consumer", "hints"]);
    expect(res.hits).toHaveLength(2);
    expect(oqxRun(store, repoId, "docs count { where stag == \"x\" }")).toMatchObject({ consumer: "count", count: 0, hints: [expect.stringContaining("`stag`")] });
    expect(oqxRun(store, repoId, "select stage from docs")).not.toHaveProperty("hints");
    expect(() => oqxRunQuery(store, repoId, parse("select stag from docs"))).toThrow("did you mean `stage`?");
    expect(oqxRunQuery(store, repoId, parse("select stag from docs"), { unknownNames: "hint" }).hints).toHaveLength(1);
    expect(() => oqxRun(store, repoId, "select stag from docs", { unknownNames: "refuse" })).toThrow(FilterInvalid);
  });
});
