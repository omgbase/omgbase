import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { bareFollowFields, barePathsAgainstProperties, messageRuns, queryHints, slashPrefixedPaths } from "../src/lib/hints.ts";

const q = (follow: string) => parse(`select $path from docs where $path == "a.md" follow ${follow}`);
const SLASHED = `select $path from docs where $path == "a.md" follow refs(before), $it.in collect { where ("/" + ^$path) in list(after) }`;
const BARE = `select $path from docs where $path == "a.md" follow refs(before), $it.in collect { where ^$path in list(after) }`;

describe("queryHints", () => {
  it("flags a bare frontmatter-looking follow destination and names the refs() form", () => {
    const hints = queryHints(q("before"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ kind: "follow-bare-field", field: "before" });
    expect(hints[0]!.message).toBe("`before` holds document references; `follow refs(before)` walks the documents (a bare field follows the strings)");
    // The span covers the destination token.
    const src = `select $path from docs where $path == "a.md" follow before`;
    expect(src.slice(...hints[0]!.span)).toBe("before");
  });

  it("flags each bare destination, in source order", () => {
    expect(queryHints(q("before, refs(after), owner")).map((h) => h.field)).toEqual(["before", "owner"]);
  });

  it("stays quiet for refs(), blocks, dotted paths, intrinsics and structural relations", () => {
    for (const follow of [
      "refs(before)", "refs(^before)", "refs(before), refs(after)",
      "doc.out", "doc.in", "in", "out", "children", "subsections", "$it.in", "$it.before",
      "$repo.docs collect { where after.contains(\"/\" + ^$path) }",
      "distinct refs(before), $it.in collect { where (\"/\" + ^$path) in list(after) }",
    ]) {
      expect(queryHints(q(follow)), follow).toEqual([]);
    }
    expect(queryHints(parse("select $path from docs"))).toEqual([]);
    expect(queryHints(null)).toEqual([]);
  });

  it("bareFollowFields is the same reading without the prose", () => {
    expect(bareFollowFields(q("before, after")).map((f) => f.field)).toEqual(["before", "after"]);
  });

  it("flags `\"/\" + ^$path` on a 2.0 server (the path is already rooted) and nothing on 1.x", () => {
    const hints = queryHints(parse(SLASHED), "2.0");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ kind: "path-already-rooted", field: "^$path" });
    expect(hints[0]!.message).toBe("`$path` is already `/`-rooted on this server; use `^$path`");
    expect(SLASHED.slice(...hints[0]!.span)).toBe('("/" + ^$path)'); // the parser's span keeps the parentheses
    expect(queryHints(parse(SLASHED), "1.5")).toEqual([]);
    expect(queryHints(parse(SLASHED), null)).toEqual([]); // version unknown: no path hints
    // The same with `$path` at the top level and with `$dst_path`.
    const top = parse(`select p: "/" + $path from docs`);
    expect(queryHints(top, "2.0")[0]!.message).toBe("`$path` is already `/`-rooted on this server; use `$path`");
    expect(slashPrefixedPaths(parse(`select x from edges where ("/" + $dst_path) in ^before`)).map((m) => m.ref)).toEqual(["$dst_path"]);
    // A slash prefixed to something else is not a path.
    expect(queryHints(parse(`select p: "/" + title from docs`), "2.0")).toEqual([]);
  });

  it("flags a bare `^$path` compared with a property on a 1.x server (no leading slash there) and nothing on 2.0", () => {
    const hints = queryHints(parse(BARE), "1.5");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ kind: "path-not-rooted", field: "^$path" });
    expect(hints[0]!.message).toBe('this server\'s `$path` has no leading slash; use `"/" + ^$path`');
    expect(BARE.slice(...hints[0]!.span)).toBe("^$path in list(after)");
    expect(queryHints(parse(BARE), "2.0")).toEqual([]);
    expect(queryHints(parse(BARE), null)).toEqual([]);
    // The other spellings of the comparison, either way round.
    for (const where of ["after.contains(^$path)", "customer == ^$path", "^$path != customer", "list(after) in ^$path", "^before.contains($path)"]) {
      const m = barePathsAgainstProperties(parse(`select $path from docs follow $it.in collect { where ${where} }`));
      expect(m, where).toHaveLength(1);
    }
    // Not flagged: a literal (the server spells it), another intrinsic, the slash-prefixed form.
    for (const where of ['$path == "a.md"', '$path == "/a.md"', "$path == ^^$path", '("/" + ^$path) in list(after)', "$path.startsWith(\"timeline/\")", "size(after) == 1"]) {
      expect(barePathsAgainstProperties(parse(`select $path from docs follow $it.in collect { where ${where} }`)), where).toEqual([]);
    }
  });

  it("orders hints by source position and keeps the follow hint beside a path hint", () => {
    const src = `select $path from docs follow before, $it.in collect { where ("/" + ^$path) in list(after) }`;
    expect(queryHints(parse(src), "2.0").map((h) => h.kind)).toEqual(["follow-bare-field", "path-already-rooted"]);
  });

  it("messageRuns alternates prose and code", () => {
    expect(messageRuns("`a` b `c`")).toEqual(["", "a", " b ", "c", ""]);
  });
});
