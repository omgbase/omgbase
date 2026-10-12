import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { DEFAULT_QUERY, DEFAULT_START, isDefaultQuery } from "../src/lib/default-query.ts";
import { inferCandidates } from "../src/lib/candidates.ts";
import { queryHints } from "../src/lib/hints.ts";

describe("DEFAULT_QUERY", () => {
  it("walks the sample timeline from kickoff both ways: refs(before) and the backlink block over the link rows", () => {
    expect(DEFAULT_START).toBe("/timeline/kickoff.md");
    expect(DEFAULT_QUERY).toBe(`select path, title, phase, before, after
from docs
where path == "/timeline/kickoff.md"
follow distinct refs(before), in_links collect { from doc where ^path in list(after) }
order by $ordinal`);
  });

  it("parses, yields the pair and its two fields as candidates, and raises no hint", () => {
    const q = parse(DEFAULT_QUERY);
    expect(inferCandidates(q, []).map((c) => [c.name, c.defaults.direction])).toEqual([["before/after", "forward"], ["before", "forward"], ["after", "backward"]]);
    expect(queryHints(q)).toEqual([]);
  });

  it("isDefaultQuery recognizes the default and nothing the user wrote", () => {
    expect(isDefaultQuery(DEFAULT_QUERY)).toBe(true);
    expect(isDefaultQuery(`${DEFAULT_QUERY}\nlimit 5`)).toBe(false);
    expect(isDefaultQuery("select path from docs")).toBe(false);
  });
});
