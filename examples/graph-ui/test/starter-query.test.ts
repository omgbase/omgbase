import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { PREVIOUS_DEFAULT_QUERIES, defaultQuery } from "../src/lib/default-query.ts";
import { SAMPLE_PROBE_PATH, SAMPLE_REPO, STARTER_QUERY, chooseQuery, existsQuery, isPresetQuery, isSampleRepository, isStarterQuery, starterQuery, timelineStarter } from "../src/lib/starter-query.ts";
import { inferCandidates } from "../src/lib/candidates.ts";
import { defaultView } from "../src/lib/view.ts";
import { queryHints } from "../src/lib/hints.ts";

const SAMPLE = { slug: SAMPLE_REPO, hasProbeDoc: true };
const NOTES = { slug: "notes", hasProbeDoc: false };

describe("starterQuery", () => {
  it("is the generic recent-documents query, parses, and is the same on every server", () => {
    expect(starterQuery()).toBe(`select $path, $title
from docs
order by $updated_at desc
limit 40`);
    const q = parse(STARTER_QUERY);
    expect(q.follow).toBeNull();
    expect(q.where).toBeNull();
    expect(queryHints(q, "2.0")).toEqual([]);
    expect(queryHints(q, "1.5")).toEqual([]);
  });

  it("has no relationships of its own, so the builtin links are what the picker offers: links drawn, force layout", () => {
    const c = inferCandidates(parse(STARTER_QUERY), [{ id: "d_1", path: "/a.md", $title: "A" }]);
    expect(c.map((x) => [x.name, x.kind, x.sources, x.defaults.edge])).toEqual([
      ["doc.out", "links", ["builtin"], true],
      ["doc.in", "backlinks", ["builtin"], false],
    ]);
    expect(defaultView(c)).toEqual({ edges: ["doc.out"], layout: { axis: null, direction: "forward" }, projection: { label: null, shown: [] } });
  });

  it("is a preset, like every sample default, and nothing the user wrote", () => {
    expect(isStarterQuery(STARTER_QUERY)).toBe(true);
    expect(isPresetQuery(STARTER_QUERY)).toBe(true);
    expect(isPresetQuery(defaultQuery("2.0"))).toBe(true);
    expect(isPresetQuery(defaultQuery("1.5"))).toBe(true);
    for (const q of PREVIOUS_DEFAULT_QUERIES) expect(isPresetQuery(q)).toBe(true);
    expect(isPresetQuery(`${STARTER_QUERY}\nlimit 5`)).toBe(false);
    expect(isStarterQuery("select $path from docs")).toBe(false);
  });
});

describe("timelineStarter", () => {
  it("is the sample default's walk from a chosen document, in the server's path form", () => {
    expect(timelineStarter("2.0", "/notes/kickoff.md")).toBe(`select $path, $title, before, after
from docs
where $path == "/notes/kickoff.md"
follow distinct refs(before), $it.in collect { where ^$path in list(after) }`);
    expect(timelineStarter("1.5", "/notes/kickoff.md")).toBe(`select $path, $title, before, after
from docs
where $path == "notes/kickoff.md"
follow distinct refs(before), $it.in collect { where ("/" + ^$path) in list(after) }`);
    expect(timelineStarter("2.0")).toContain(`where $path == "/path/to/start.md"`);
    for (const surface of ["1.5", "2.0"]) {
      const q = parse(timelineStarter(surface, "a.md"));
      // Both ends of the sequence are named, so the pair comes first (rule 5) and lays out.
      expect(inferCandidates(q, []).map((c) => [c.name, c.defaults.direction])).toEqual([["before/after", "forward"], ["before", "forward"], ["after", "backward"]]);
      expect(queryHints(q, surface)).toEqual([]);
    }
  });

  it("existsQuery probes one path with limit 1, spelled for the server", () => {
    expect(existsQuery("2.0", SAMPLE_PROBE_PATH)).toBe(`select $path from docs where $path == "/timeline/kickoff.md" limit 1`);
    expect(existsQuery("1.5", "/timeline/kickoff.md")).toBe(`select $path from docs where $path == "timeline/kickoff.md" limit 1`);
    expect(() => parse(existsQuery(null, "a.md"))).not.toThrow();
  });
});

describe("isSampleRepository", () => {
  it("is the sample slug with its timeline start document; an unanswered probe on that slug still counts", () => {
    expect(isSampleRepository(SAMPLE)).toBe(true);
    expect(isSampleRepository({ slug: SAMPLE_REPO, hasProbeDoc: null })).toBe(true);
    expect(isSampleRepository({ slug: SAMPLE_REPO, hasProbeDoc: false })).toBe(false);
    expect(isSampleRepository(NOTES)).toBe(false);
    expect(isSampleRepository({ slug: "notes", hasProbeDoc: true })).toBe(false);
  });
});

describe("chooseQuery", () => {
  it("gives the sample workspace its timeline default in the server's form", () => {
    expect(chooseQuery(defaultQuery(null), "2.0", SAMPLE)).toBe(defaultQuery("2.0"));
    expect(chooseQuery(defaultQuery("2.0"), "2.0", SAMPLE)).toBeNull(); // already right
    expect(chooseQuery(defaultQuery("2.0"), "1.5", SAMPLE)).toBe(defaultQuery("1.5"));
    expect(chooseQuery(PREVIOUS_DEFAULT_QUERIES[0]!, "2.0", SAMPLE)).toBe(defaultQuery("2.0"));
    // Coming back from another repository: the starter is a preset too.
    expect(chooseQuery(STARTER_QUERY, "2.0", SAMPLE)).toBe(defaultQuery("2.0"));
  });

  it("gives any other repository the starter — whichever default the editor held", () => {
    expect(chooseQuery(defaultQuery("2.0"), "2.0", NOTES)).toBe(STARTER_QUERY);
    expect(chooseQuery(defaultQuery("1.5"), "2.0", NOTES)).toBe(STARTER_QUERY);
    expect(chooseQuery(defaultQuery(null), "1.5", NOTES)).toBe(STARTER_QUERY);
    expect(chooseQuery(STARTER_QUERY, "2.0", NOTES)).toBeNull();
    // A workspace whose slug is `sample` but lacks the timeline is not the sample.
    expect(chooseQuery(defaultQuery("2.0"), "2.0", { slug: SAMPLE_REPO, hasProbeDoc: false })).toBe(STARTER_QUERY);
  });

  it("never replaces a user's edit", () => {
    const edited = `${defaultQuery("2.0")}\nlimit 3`;
    expect(chooseQuery(edited, "2.0", NOTES)).toBeNull();
    expect(chooseQuery(edited, "1.5", SAMPLE)).toBeNull();
    expect(chooseQuery("select $path from docs", "2.0", NOTES)).toBeNull();
    expect(chooseQuery(timelineStarter("2.0", "/a.md"), "2.0", NOTES)).toBeNull(); // the suggestion, once taken, is the user's
  });
});
