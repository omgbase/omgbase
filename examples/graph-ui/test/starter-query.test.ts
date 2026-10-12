import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { DEFAULT_QUERY } from "../src/lib/default-query.ts";
import { SAMPLE_PROBE_PATH, SAMPLE_REPO, STARTER_QUERY, chooseQuery, existsQuery, isPresetQuery, isSampleRepository, isStarterQuery, timelineStarter } from "../src/lib/starter-query.ts";
import { inferCandidates } from "../src/lib/candidates.ts";
import { defaultView } from "../src/lib/view.ts";
import { queryHints } from "../src/lib/hints.ts";

const SAMPLE = { slug: SAMPLE_REPO, hasProbeDoc: true };
const NOTES = { slug: "notes", hasProbeDoc: false };

describe("STARTER_QUERY", () => {
  it("is the generic recent-documents query", () => {
    expect(STARTER_QUERY).toBe(`select path, title
from docs
order by updated_at desc
limit 40`);
    const q = parse(STARTER_QUERY);
    expect(q.follow).toBeNull();
    expect(q.where).toBeNull();
    expect(queryHints(q)).toEqual([]);
  });

  it("has no relationships of its own, so the builtin links are what the picker offers: links drawn, force layout (`updated_at` is an attribute, not a sequence key)", () => {
    const c = inferCandidates(parse(STARTER_QUERY), [{ id: "d_1", path: "/a.md", title: "A" }]);
    expect(c.map((x) => [x.name, x.kind, x.sources, x.defaults.edge])).toEqual([
      ["doc.out_links", "links", ["builtin"], true],
      ["doc.in_links", "backlinks", ["builtin"], false],
    ]);
    expect(defaultView(c)).toEqual({ edges: ["doc.out_links"], layout: { axis: null, direction: "forward" }, projection: { label: null, shown: [] } });
  });

  it("is a preset, like the sample default, and nothing the user wrote", () => {
    expect(isStarterQuery(STARTER_QUERY)).toBe(true);
    expect(isPresetQuery(STARTER_QUERY)).toBe(true);
    expect(isPresetQuery(DEFAULT_QUERY)).toBe(true);
    expect(isPresetQuery(`${STARTER_QUERY}\nlimit 5`)).toBe(false);
    expect(isStarterQuery("select path from docs")).toBe(false);
  });
});

describe("timelineStarter", () => {
  it("is the sample default's walk from a chosen document (rooted), or a placeholder", () => {
    expect(timelineStarter("/notes/kickoff.md")).toBe(`select path, title, before, after
from docs
where path == "/notes/kickoff.md"
follow distinct refs(before), in_links collect { from doc where ^path in list(after) }`);
    expect(timelineStarter("notes/kickoff.md")).toContain(`where path == "/notes/kickoff.md"`);
    expect(timelineStarter()).toContain(`where path == "/path/to/start.md"`);
    const q = parse(timelineStarter("a.md"));
    // Both ends of the sequence are named, so the pair comes first (rule 5) and lays out.
    expect(inferCandidates(q, []).map((c) => [c.name, c.defaults.direction])).toEqual([["before/after", "forward"], ["before", "forward"], ["after", "backward"]]);
    expect(queryHints(q)).toEqual([]);
  });

  it("existsQuery probes one path with limit 1, rooted", () => {
    expect(existsQuery(SAMPLE_PROBE_PATH)).toBe(`select path from docs where path == "/timeline/kickoff.md" limit 1`);
    expect(existsQuery("timeline/kickoff.md")).toBe(existsQuery(SAMPLE_PROBE_PATH));
    expect(() => parse(existsQuery('odd "quoted".md'))).not.toThrow();
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
  it("gives the sample workspace its timeline default", () => {
    expect(chooseQuery(DEFAULT_QUERY, SAMPLE)).toBeNull(); // already right
    // Coming back from another repository: the starter is a preset too.
    expect(chooseQuery(STARTER_QUERY, SAMPLE)).toBe(DEFAULT_QUERY);
  });

  it("gives any other repository the starter", () => {
    expect(chooseQuery(DEFAULT_QUERY, NOTES)).toBe(STARTER_QUERY);
    expect(chooseQuery(STARTER_QUERY, NOTES)).toBeNull();
    // A workspace whose slug is `sample` but lacks the timeline is not the sample.
    expect(chooseQuery(DEFAULT_QUERY, { slug: SAMPLE_REPO, hasProbeDoc: false })).toBe(STARTER_QUERY);
  });

  it("never replaces a user's edit", () => {
    const edited = `${DEFAULT_QUERY}\nlimit 3`;
    expect(chooseQuery(edited, NOTES)).toBeNull();
    expect(chooseQuery(edited, SAMPLE)).toBeNull();
    expect(chooseQuery("select path from docs", NOTES)).toBeNull();
    expect(chooseQuery(timelineStarter("/a.md"), NOTES)).toBeNull(); // the suggestion, once taken, is the user's
  });
});
