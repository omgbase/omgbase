import { describe, it, expect } from "vitest";
import { parse } from "@omgbase/oqx";
import { checkRootSpellings } from "./run.js";
import { REPO_REMOVED_MESSAGE, bareTargetMessage, pastRootMessage } from "./root-row.js";

// The root row (spec/surface §1.1, 2.0): `$repo` and a bare `docs`/`edges` at
// depth ≥ 1 are refused before evaluation; the fixtures (`query-root.json`) pin
// the engine behavior, this pins the walk's depth counting and the messages.
describe("root-row spellings", () => {
  it("refuses every spelling of $repo with the one message", () => {
    for (const q of [
      "from docs where $repo",
      "select r: size($repo.docs) from docs",
      "select r: $repo.$id from docs",
      "select r: nodes first { select x: ^$repo.$id values } from docs",
      "select r: nodes first { select x: 0^$repo values } from docs",
      "$repo.docs count { }",
      'from docs where $path == "nope" && $repo.docs exists { }',
    ]) {
      expect(() => checkRootSpellings(parse(q)), q).toThrow(REPO_REMOVED_MESSAGE);
    }
  });

  it("refuses a bare docs/edges at depth ≥ 1, the hint counting the carets", () => {
    expect(() => checkRootSpellings(parse("select x: docs collect { } from docs"))).toThrow(bareTargetMessage("docs", 1));
    expect(bareTargetMessage("docs", 1)).toBe("`docs` inside a block reads a property of the current row, which has none — did you mean `^docs` (the repository's documents)?");
    expect(() => checkRootSpellings(parse("select x: nodes collect { select y: size(edges) } from docs"))).toThrow("did you mean `^^edges` (the repository's edges)?");
    expect(() => checkRootSpellings(parse("docs collect { from docs }"))).toThrow("`^docs`");
    expect(() => checkRootSpellings(parse('from docs where $path == "/index.md" follow docs'))).toThrow("`^docs`");
    // the read-time message spells out the rule
    expect(bareTargetMessage("blocks", null)).toBe("`blocks` inside a block reads a property of the current row, which has none — did you mean `^blocks` (the repository's blocks; one caret per enclosing block, or the absolute `0^blocks`)?");
  });

  it("refuses a ^target that reaches past the root", () => {
    expect(() => checkRootSpellings(parse("^docs count { }"))).toThrow(pastRootMessage("docs", 1));
    expect(pastRootMessage("docs", 1)).toBe("`^docs` reaches past the root — there is no enclosing row at this depth; at the top level the repository's documents are the bare `docs` (`docs count { … }`, `from docs`, `entries(docs)`)");
    expect(() => checkRootSpellings(parse("select $path from docs where ^^edges exists { }"))).toThrow("`^^edges` reaches past the root");
    expect(() => checkRootSpellings(parse("select n: size(^docs) from docs"))).not.toThrow();
  });

  it("leaves the root scope and the relations alone", () => {
    for (const q of [
      "docs count { }",
      "from docs where nodes exists { }",
      "entries(docs) first { }",
      "select n: size(^docs), id: ^$id, k: size(0^edges) from docs",
      "from blocks where blocks exists { }", // blocks/nodes are judged by the context at read time
    ]) {
      expect(() => checkRootSpellings(parse(q)), q).not.toThrow();
    }
  });
});
