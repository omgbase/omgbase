import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { PREVIOUS_DEFAULT_QUERIES, defaultQuery, isDefaultQuery } from "../src/lib/default-query.ts";
import { inferCandidates } from "../src/lib/candidates.ts";
import { queryHints } from "../src/lib/hints.ts";

describe("defaultQuery", () => {
  it("is the rooted form on 2.0 and the slash-prefixed form on 1.x (and while unknown)", () => {
    expect(defaultQuery("2.0")).toBe(`select $path, title, phase, before, after
from docs
where $path == "/timeline/kickoff.md"
follow distinct refs(before), $it.in collect { where ^$path in list(after) }
order by $ordinal`);
    expect(defaultQuery("1.5")).toBe(`select $path, title, phase, before, after
from docs
where $path == "timeline/kickoff.md"
follow distinct refs(before), $it.in collect { where ("/" + ^$path) in list(after) }
order by $ordinal`);
    expect(defaultQuery(null)).toBe(defaultQuery("1.x"));
  });

  it("parses, yields the same two candidates, and raises no hint on its own server", () => {
    for (const surface of ["1.5", "2.0"]) {
      const q = parse(defaultQuery(surface));
      expect(inferCandidates(q, []).map((c) => [c.name, c.defaults.direction])).toEqual([["before", "forward"], ["after", "backward"]]);
      expect(queryHints(q, surface), surface).toEqual([]);
    }
    // …and exactly one on the other server.
    expect(queryHints(parse(defaultQuery("1.5")), "2.0").map((h) => h.kind)).toEqual(["path-already-rooted"]);
    expect(queryHints(parse(defaultQuery("2.0")), "1.5").map((h) => h.kind)).toEqual(["path-not-rooted"]);
  });

  it("isDefaultQuery recognizes every default and nothing the user wrote", () => {
    expect(isDefaultQuery(defaultQuery("2.0"))).toBe(true);
    expect(isDefaultQuery(defaultQuery("1.5"))).toBe(true);
    for (const q of PREVIOUS_DEFAULT_QUERIES) expect(isDefaultQuery(q)).toBe(true);
    expect(isDefaultQuery(`${defaultQuery("2.0")}\nlimit 5`)).toBe(false);
    expect(isDefaultQuery("select $path from docs")).toBe(false);
  });
});
