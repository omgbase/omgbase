import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { bareFollowFields, messageRuns, queryHints } from "../src/lib/hints.ts";

const q = (follow: string) => parse(`select $path from docs where $path == "a.md" follow ${follow}`);

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

  it("messageRuns alternates prose and code", () => {
    expect(messageRuns("`a` b `c`")).toEqual(["", "a", " b ", "c", ""]);
  });
});
