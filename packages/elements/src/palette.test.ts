import { describe, expect, it } from "vitest";
import {
  createSuggestion, docItemOf, docTier, escapeRegex, filterActions, findQuery, itemsFor, matchTier, newDocumentPath, parseInput, rankDocs, stepIndex, termsOf,
  type DocItem, type PaletteAction,
} from "./palette.js";

const doc = (path: string, title?: string): DocItem => ({ kind: "doc", id: `d_${path.length}`, path, title: title ?? path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "") });

describe("parseInput", () => {
  it("find by default, trimmed", () => {
    expect(parseInput("  calc  ")).toEqual({ kind: "find", text: "calc" });
    expect(parseInput("")).toEqual({ kind: "find", text: "" });
  });
  it("> is an action search", () => {
    expect(parseInput("> undo")).toEqual({ kind: "action", text: "undo" });
    expect(parseInput(">")).toEqual({ kind: "action", text: "" });
  });
  it("+ and `new ` create; `new` alone is a find", () => {
    expect(parseInput("+ notes/x")).toEqual({ kind: "create", path: "notes/x" });
    expect(parseInput("+notes/x")).toEqual({ kind: "create", path: "notes/x" });
    expect(parseInput("new  salt")).toEqual({ kind: "create", path: "salt" });
    expect(parseInput("New /a.md")).toEqual({ kind: "create", path: "/a.md" });
    expect(parseInput("new")).toEqual({ kind: "find", text: "new" });
    expect(parseInput("newer things")).toEqual({ kind: "find", text: "newer things" });
  });
});

describe("findQuery", () => {
  it("empty text lists by path", () => {
    expect(findQuery("", 20)).toBe("docs { select _id, _path, _title order by _path limit 20 }");
    expect(findQuery("   ", 5)).toBe("docs { select _id, _path, _title order by _path limit 5 }");
  });
  it("one term: path or title, case-insensitive regex", () => {
    expect(findQuery("calc", 10)).toBe('docs { select _id, _path, _title where (_path ~* "calc" or _title ~* "calc") order by _path limit 10 }');
  });
  it("every term must match (and of or-pairs)", () => {
    expect(findQuery("proc  calc", 10)).toBe('docs { select _id, _path, _title where (_path ~* "proc" or _title ~* "proc") and (_path ~* "calc" or _title ~* "calc") order by _path limit 10 }');
    expect(termsOf(" a  b ")).toEqual(["a", "b"]);
  });
  it("a term with regex metacharacters is escaped for the OQX baseline and JSON-quoted", () => {
    expect(escapeRegex("a.b(c)")).toBe("a\\.b\\(c\\)");
    // `/` and `-` are metacharacters in the OQX baseline (SEMANTICS §11), unlike JavaScript's.
    expect(escapeRegex("x/y-z")).toBe("x\\/y\\-z");
    expect(escapeRegex("[a]{2}|b*+?^$\\")).toBe("\\[a\\]\\{2\\}\\|b\\*\\+\\?\\^\\$\\\\");
    expect(escapeRegex("plain_text")).toBe("plain_text");
    expect(findQuery("calc.md", 10)).toBe('docs { select _id, _path, _title where (_path ~* "calc\\\\.md" or _title ~* "calc\\\\.md") order by _path limit 10 }');
    expect(findQuery('say "hi"', 3)).toBe('docs { select _id, _path, _title where (_path ~* "say" or _title ~* "say") and (_path ~* "\\"hi\\"" or _title ~* "\\"hi\\"") order by _path limit 3 }');
  });
});

describe("rankDocs", () => {
  const hits = [
    { _id: "d_1", _path: "/zz/calcination-notes.md", _title: "Notes on calcination" },
    { _id: "d_2", _path: "/processes/calcination.md", _title: "Calcination" },
    { _id: "d_3", _path: "/calc/index.md", _title: "Index" },
    { _id: "d_4", _path: "/misc/recalc.md", _title: "Totals" },
    { _id: "d_5", _path: "/other.md", _title: "Other" },
    { _id: "d_6", _path: "/a/calcium.md", _title: "Calcium" },
    { _path: "/no-id.md" },
  ];
  it("tiers: title prefix, title contains, path segment prefix, path contains, rest; stable by path within a tier", () => {
    expect(rankDocs(hits, "calc").map((d) => d.path)).toEqual([
      "/a/calcium.md", // title starts with (tier 0), before…
      "/processes/calcination.md", // …by path
      "/zz/calcination-notes.md", // title contains (tier 1)
      "/calc/index.md", // a path segment starts with (tier 2)
      "/misc/recalc.md", // path contains (tier 3)
      "/other.md", // rest
    ]);
    expect(docTier(doc("/a/calcium.md", "Calcium"), "calc")).toBe(0);
    expect(docTier(doc("/misc/recalc.md", "Totals"), "calc")).toBe(3);
    expect(docTier(doc("/misc/recalc.md", "Recalculated"), "calc")).toBe(1);
    expect(docTier(doc("/other.md", "Other"), "calc")).toBe(4);
  });
  it("empty text keeps path order; a row without the envelope is dropped", () => {
    expect(rankDocs(hits, "").map((d) => d.path)).toEqual(["/a/calcium.md", "/calc/index.md", "/misc/recalc.md", "/other.md", "/processes/calcination.md", "/zz/calcination-notes.md"]);
  });
  it("the title falls back to the file name without .md; a bare path is rooted", () => {
    expect(docItemOf({ _id: "d_9", _path: "notes/dry-run.md" })).toEqual({ kind: "doc", id: "d_9", path: "/notes/dry-run.md", title: "dry-run" });
    expect(docItemOf({ _id: "d_9", _path: "/x.md", _title: "  " })?.title).toBe("x");
    expect(docItemOf({ _path: "/x.md" })).toBeNull();
  });
  it("accepts already-built items too", () => {
    expect(rankDocs([doc("/b.md"), doc("/a.md")], "").map((d) => d.path)).toEqual(["/a.md", "/b.md"]);
  });
});

describe("filterActions", () => {
  const actions: PaletteAction[] = [
    { id: "undo", label: "Undo last write", shortcut: "⌘Z", keywords: ["revert"] },
    { id: "redo", label: "Redo", shortcut: "⇧⌘Z" },
    { id: "tree", label: "Toggle the tree", hint: "show or hide the repository tree", keywords: ["sidebar"] },
    { id: "console", label: "Open the query console", keywords: ["oqx", "sql"] },
  ];
  it("empty text keeps every action in order, without keywords", () => {
    const all = filterActions(actions, "");
    expect(all.map((a) => a.id)).toEqual(["undo", "redo", "tree", "console"]);
    expect(all[0]).toEqual({ kind: "action", id: "undo", label: "Undo last write", shortcut: "⌘Z" });
    expect(all[2]).toEqual({ kind: "action", id: "tree", label: "Toggle the tree", hint: "show or hide the repository tree" });
  });
  it("prefix > contiguous > subsequence; label over keyword within a tier", () => {
    expect(matchTier("un", "Undo")).toBe(0);
    expect(matchTier("do", "Undo")).toBe(1);
    expect(matchTier("uo", "Undo")).toBe(2);
    expect(matchTier("x", "Undo")).toBeNull();
    // "re": Redo (label prefix) > the "revert" keyword prefix (undo; its label only has r…e as a subsequence) > "tree" contains it > "query console" only as a subsequence
    expect(filterActions(actions, "re").map((a) => a.id)).toEqual(["redo", "undo", "tree", "console"]);
    // "tq": subsequence of "Toggle the tree"? t..q — no; of "Open the query console" — yes.
    expect(filterActions(actions, "tq").map((a) => a.id)).toEqual(["console"]);
    expect(filterActions(actions, "oqx").map((a) => a.id)).toEqual(["console"]);
    expect(filterActions(actions, "zzz")).toEqual([]);
  });
});

describe("newDocumentPath", () => {
  it("a bare name lands beside the open document, with .md", () => {
    expect(newDocumentPath("salt", "/substances/sulfur.md")).toBe("/substances/salt.md");
    expect(newDocumentPath("notes/salt", "/substances/sulfur.md")).toBe("/substances/notes/salt.md");
    expect(newDocumentPath("salt", null)).toBe("/salt.md");
    expect(newDocumentPath("salt", "/top.md")).toBe("/salt.md");
  });
  it("a rooted input is taken as written; an extension is kept", () => {
    expect(newDocumentPath("/a/b", "/substances/sulfur.md")).toBe("/a/b.md");
    expect(newDocumentPath("/a/b.markdown", null)).toBe("/a/b.markdown");
    expect(newDocumentPath("/a/b.txt", null)).toBe("/a/b.txt");
    expect(newDocumentPath("v1.2", null)).toBe("/v1.2.md"); // `.2` is not an extension (an extension starts with a letter)
  });
  it("collapses // and reads \\ as /", () => {
    expect(newDocumentPath("//a//b", null)).toBe("/a/b.md");
    expect(newDocumentPath("a\\b", null)).toBe("/a/b.md");
  });
  it("rejects empty input, .., ., blank segments and a trailing slash", () => {
    expect(newDocumentPath("", null)).toBeNull();
    expect(newDocumentPath("   ", null)).toBeNull();
    expect(newDocumentPath("../x", "/a/b.md")).toBeNull();
    expect(newDocumentPath("/a/../x", null)).toBeNull();
    expect(newDocumentPath("./x", null)).toBeNull();
    expect(newDocumentPath("a/ /b", null)).toBeNull();
    expect(newDocumentPath("a/", null)).toBeNull();
    expect(newDocumentPath("/", null)).toBeNull();
  });
});

describe("createSuggestion", () => {
  const docs = [doc("/substances/salt.md", "Salt"), doc("/processes/calcination.md", "Calcination")];
  it("suggests the resolved path when no document has it or that exact title", () => {
    expect(createSuggestion("sulfur", docs, "/substances/salt.md")).toEqual({ kind: "create", path: "/substances/sulfur.md" });
    expect(createSuggestion("/notes/sulfur.md", docs, null)).toEqual({ kind: "create", path: "/notes/sulfur.md" });
  });
  it("no suggestion for an exact path or title match, or an invalid path", () => {
    expect(createSuggestion("salt", docs, "/substances/x.md")).toBeNull();
    expect(createSuggestion("/Substances/Salt.md", docs, null)).toBeNull();
    expect(createSuggestion("calcination", docs, null)).toBeNull(); // title match
    expect(createSuggestion("../x", docs, null)).toBeNull();
  });
});

describe("itemsFor", () => {
  const actions: PaletteAction[] = [{ id: "undo", label: "Undo" }, { id: "redo", label: "Redo" }];
  const hits = [{ _id: "d_1", _path: "/processes/calcination.md", _title: "Calcination" }, { _id: "d_2", _path: "/a/calcium.md", _title: "Calcium" }];
  it("find: ranked documents then the create suggestion", () => {
    const items = itemsFor(parseInput("calc"), { docs: hits, actions, currentDoc: "/processes/x.md" });
    expect(items.map((i) => (i.kind === "doc" ? i.path : i.kind))).toEqual(["/a/calcium.md", "/processes/calcination.md", "create"]);
    expect(items[2]).toEqual({ kind: "create", path: "/processes/calc.md" });
  });
  it("find: an exact title match offers no create; empty text never does", () => {
    expect(itemsFor(parseInput("Calcium"), { docs: hits, actions, currentDoc: null }).map((i) => i.kind)).toEqual(["doc", "doc"]);
    expect(itemsFor(parseInput(""), { docs: hits, actions, currentDoc: null }).map((i) => i.kind)).toEqual(["doc", "doc"]);
  });
  it("action: the filtered actions", () => {
    expect(itemsFor(parseInput("> re"), { docs: hits, actions, currentDoc: null })).toEqual([{ kind: "action", id: "redo", label: "Redo" }]);
    expect(itemsFor(parseInput(">"), { docs: hits, actions, currentDoc: null }).map((i) => (i as { id: string }).id)).toEqual(["undo", "redo"]);
  });
  it("create: the one item, or nothing for an invalid path", () => {
    expect(itemsFor(parseInput("+ notes/x"), { docs: hits, actions, currentDoc: "/a/b.md" })).toEqual([{ kind: "create", path: "/a/notes/x.md" }]);
    expect(itemsFor(parseInput("new ../x"), { docs: hits, actions, currentDoc: "/a/b.md" })).toEqual([]);
    expect(itemsFor(parseInput("+"), { docs: hits, actions, currentDoc: null })).toEqual([]);
  });
});

describe("stepIndex", () => {
  it("arrows wrap at both ends", () => {
    expect(stepIndex(0, 3, "ArrowDown")).toBe(1);
    expect(stepIndex(2, 3, "ArrowDown")).toBe(0);
    expect(stepIndex(0, 3, "ArrowUp")).toBe(2);
    expect(stepIndex(-1, 3, "ArrowDown")).toBe(0);
    expect(stepIndex(-1, 3, "ArrowUp")).toBe(2);
  });
  it("Home/End jump; PageUp/PageDown move by a page and wrap at the ends", () => {
    expect(stepIndex(5, 30, "Home")).toBe(0);
    expect(stepIndex(5, 30, "End")).toBe(29);
    expect(stepIndex(5, 30, "PageDown")).toBe(15);
    expect(stepIndex(25, 30, "PageDown")).toBe(29);
    expect(stepIndex(29, 30, "PageDown")).toBe(0);
    expect(stepIndex(15, 30, "PageUp")).toBe(5);
    expect(stepIndex(3, 30, "PageUp")).toBe(0);
    expect(stepIndex(0, 30, "PageUp")).toBe(29);
    expect(stepIndex(5, 30, "PageDown", 3)).toBe(8);
  });
  it("no items is -1; an unknown key leaves the index", () => {
    expect(stepIndex(0, 0, "ArrowDown")).toBe(-1);
    expect(stepIndex(1, 3, "a")).toBe(1);
    expect(stepIndex(7, 3, "a")).toBe(-1);
  });
});
