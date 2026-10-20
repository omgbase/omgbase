import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { bareFollowFields, messageRuns, queryHints, slashPrefixedPaths } from "../src/lib/hints.ts";

const q = (follow: string) => parse(`select _path from docs where _path == "a.md" follow ${follow}`);
const SLASHED = `select _path from docs where _path == "a.md" follow refs(before), _in_links collect { from _doc where ("/" + ^_path) in list(after) }`;

describe("queryHints", () => {
  it("flags a bare frontmatter-looking follow destination and names the refs() form", () => {
    const hints = queryHints(q("before"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ kind: "follow-bare-field", field: "before" });
    expect(hints[0]!.message).toBe("`before` holds document references; `follow refs(before)` walks the documents (a bare field follows the strings)");
    // The span covers the destination token.
    const src = `select _path from docs where _path == "a.md" follow before`;
    expect(src.slice(...hints[0]!.span)).toBe("before");
  });

  it("flags each bare destination, in source order", () => {
    expect(queryHints(q("before, refs(after), owner")).map((h) => h.field)).toEqual(["before", "owner"]);
  });

  it("stays quiet for refs(), blocks, dotted paths, OQX's $-names and structural relations (in both spellings)", () => {
    for (const follow of [
      "refs(before)", "refs(^before)", "refs(before), refs(after)",
      "out_links", "doc.in_links", "children", "subsections", "$it.out_links", "$it.before",
      "out_links collect { from dst }", "in_links collect { from doc depth 2 }",
      "^docs collect { where after.contains(^path) }",
      "distinct refs(before), in_links collect { from doc where ^path in list(after) }",
      "_out_links", "_in_links", "_children", "_subsections", "$it._out_links",
      "_out_links collect { from _dst }", "_in_links collect { from _doc depth 2 }",
      "distinct refs(before), _in_links collect { from _doc where ^_path in list(after) }",
    ]) {
      expect(queryHints(q(follow)), follow).toEqual([]);
    }
    expect(queryHints(parse("select _path from docs"))).toEqual([]);
    expect(queryHints(null)).toEqual([]);
  });

  it("bareFollowFields is the same reading without the prose", () => {
    expect(bareFollowFields(q("before, after")).map((f) => f.field)).toEqual(["before", "after"]);
  });

  it("flags `\"/\" + ^_path` — the path is already rooted", () => {
    const hints = queryHints(parse(SLASHED));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ kind: "path-already-rooted", field: "^_path" });
    expect(hints[0]!.message).toBe("`_path` is already `/`-rooted; use `^_path`");
    expect(SLASHED.slice(...hints[0]!.span)).toBe('("/" + ^_path)'); // the parser's span keeps the parentheses
    expect(queryHints(parse(`select path from docs follow in_links collect { from doc where ^path in list(after) }`))).toEqual([]);
    // At the top level, and a link's destination path over the `links` rows (spec/surface §1.1–§1.2).
    expect(queryHints(parse(`select p: "/" + path from docs`))[0]!.message).toBe("`path` is already `/`-rooted; use `path`");
    expect(slashPrefixedPaths(parse(`select x from links where ("/" + dst_path) in ^before`)).map((m) => m.ref)).toEqual(["dst_path"]);
    expect(queryHints(parse(`select p: "/" + dst_path from links`))[0]!.message).toBe("`dst_path` is already `/`-rooted; use `dst_path`");
    // The 5.0 spellings: `_path`, `^_path`, `_dst_path`.
    expect(queryHints(parse(`select _path from docs follow refs(before), _in_links collect { from _doc where ("/" + ^_path) in list(after) }`))[0]!.message).toBe("`_path` is already `/`-rooted; use `^_path`");
    expect(queryHints(parse(`select p: "/" + _path from docs`))[0]!.message).toBe("`_path` is already `/`-rooted; use `_path`");
    expect(slashPrefixedPaths(parse(`select x from links where ("/" + _dst_path) in ^before`)).map((m) => m.ref)).toEqual(["_dst_path"]);
    expect(queryHints(parse(`select p: "/" + _title from docs`))).toEqual([]);
    expect(queryHints(parse(`select _path from docs where _path == "a.md" || _path == ^^_path`))).toEqual([]);
    // A slash prefixed to something else is not a path; a literal is the server's to root.
    expect(queryHints(parse(`select p: "/" + _title from docs`))).toEqual([]);
    expect(queryHints(parse(`select path from docs where path == "a.md" || path == ^^path`))).toEqual([]);
  });

  it("orders hints by source position and keeps the follow hint beside a path hint", () => {
    const src = `select _path from docs follow before, _in_links collect { from _doc where ("/" + ^_path) in list(after) }`;
    expect(queryHints(parse(src)).map((h) => h.kind)).toEqual(["follow-bare-field", "path-already-rooted"]);
  });

  it("messageRuns alternates prose and code", () => {
    expect(messageRuns("`a` b `c`")).toEqual(["", "a", " b ", "c", ""]);
  });
});
