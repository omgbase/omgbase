import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { DEFAULT_QUERY, DEFAULT_START, defaultQuery, isDefaultQuery } from "../src/lib/default-query.ts";
import { NAMES_4, NAMES_5 } from "../src/lib/paths.ts";
import { inferCandidates } from "../src/lib/candidates.ts";
import { queryHints } from "../src/lib/hints.ts";

describe("DEFAULT_QUERY", () => {
  it("walks the sample timeline from kickoff both ways: refs(before) and the backlink block over the link rows — in the 5.0 engine names", () => {
    expect(DEFAULT_START).toBe("/timeline/kickoff.md");
    expect(DEFAULT_QUERY).toBe(`docs {
  select _path, _title, phase, before, after
  where _path == "/timeline/kickoff.md"
  follow distinct refs(before), _in_links { from _doc where ^_path in list(after) }
  order by $ordinal
}`);
    expect(defaultQuery(NAMES_5)).toBe(DEFAULT_QUERY);
  });

  it("spells the same walk bare for a 3.x/4.x server", () => {
    expect(defaultQuery(NAMES_4)).toBe(`docs {
  select path, title, phase, before, after
  where path == "/timeline/kickoff.md"
  follow distinct refs(before), in_links { from doc where ^path in list(after) }
  order by $ordinal
}`);
  });

  it("parses in both spellings, yields the pair and its two fields as candidates, and raises no hint", () => {
    for (const names of [NAMES_5, NAMES_4]) {
      const q = parse(defaultQuery(names));
      expect(inferCandidates(q, [], names).map((c) => [c.name, c.defaults.direction]), String(names.major)).toEqual([["before/after", "forward"], ["before", "forward"], ["after", "backward"]]);
      expect(queryHints(q)).toEqual([]);
    }
  });

  it("isDefaultQuery recognizes the default in either spelling and nothing the user wrote", () => {
    expect(isDefaultQuery(DEFAULT_QUERY)).toBe(true);
    expect(isDefaultQuery(defaultQuery(NAMES_4))).toBe(true);
    expect(isDefaultQuery(`${DEFAULT_QUERY}\nlimit 5`)).toBe(false);
    expect(isDefaultQuery("docs { select _path }")).toBe(false);
  });
});
