import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import { DEFAULT_QUERY, defaultQuery } from "../src/lib/default-query.ts";
import { SAMPLE_PROBE_PATH, SAMPLE_REPO, STARTER_QUERY, chooseQuery, existsQuery, isPresetQuery, isSampleRepository, isStarterQuery, starterQuery, timelineStarter } from "../src/lib/starter-query.ts";
import { NAMES_4, NAMES_5 } from "../src/lib/paths.ts";
import { inferCandidates } from "../src/lib/candidates.ts";
import { defaultView } from "../src/lib/view.ts";
import { queryHints } from "../src/lib/hints.ts";

const SAMPLE = { slug: SAMPLE_REPO, hasProbeDoc: true };
const NOTES = { slug: "notes", hasProbeDoc: false };

describe("STARTER_QUERY", () => {
  it("is the generic recent-documents query, in the 5.0 engine names (bare for a 4.x server)", () => {
    expect(STARTER_QUERY).toBe(`docs {
  select _path, _title
  order by _updated_at desc
  limit 40
}`);
    expect(starterQuery(NAMES_5)).toBe(STARTER_QUERY);
    expect(starterQuery(NAMES_4)).toBe(`docs {
  select path, title
  order by updated_at desc
  limit 40
}`);
    for (const src of [STARTER_QUERY, starterQuery(NAMES_4)]) {
      const q = parse(src);
      expect(q.follow).toBeNull();
      expect(q.where).toBeNull();
      expect(queryHints(q)).toEqual([]);
    }
  });

  it("has no relationships of its own, so the builtin links are what the picker offers: links drawn, force layout (`_updated_at` is an attribute, not a sequence key)", () => {
    const c = inferCandidates(parse(STARTER_QUERY), [{ _id: "d_1", _path: "/a.md", _title: "A" }]);
    expect(c.map((x) => [x.name, x.kind, x.sources, x.defaults.edge])).toEqual([
      ["_out_links", "links", ["builtin"], true],
      ["_in_links", "backlinks", ["builtin"], false],
    ]);
    expect(defaultView(c)).toEqual({ edges: ["_out_links"], layout: { axis: null, direction: "forward", algorithm: "force" }, projection: { label: null, shown: [] } });
    // The 4.x branch names the builtins for the link rows under the document's self alias.
    const old = inferCandidates(parse(starterQuery(NAMES_4)), [{ id: "d_1", path: "/a.md", title: "A" }], NAMES_4);
    expect(old.map((x) => [x.name, x.kind, x.sources, x.defaults.edge])).toEqual([
      ["doc.out_links", "links", ["builtin"], true],
      ["doc.in_links", "backlinks", ["builtin"], false],
    ]);
    expect(defaultView(old).edges).toEqual(["doc.out_links"]);
  });

  it("is a preset, like the sample default, in either spelling — and nothing the user wrote", () => {
    expect(isStarterQuery(STARTER_QUERY)).toBe(true);
    expect(isStarterQuery(starterQuery(NAMES_4))).toBe(true);
    expect(isPresetQuery(STARTER_QUERY)).toBe(true);
    expect(isPresetQuery(DEFAULT_QUERY)).toBe(true);
    expect(isPresetQuery(defaultQuery(NAMES_4))).toBe(true);
    expect(isPresetQuery(`${STARTER_QUERY}\nlimit 5`)).toBe(false);
    expect(isStarterQuery("docs { select _path }")).toBe(false);
  });
});

describe("timelineStarter", () => {
  it("is the sample default's walk from a chosen document (rooted), or a placeholder — in the server's spelling", () => {
    expect(timelineStarter("/notes/kickoff.md")).toBe(`docs {
  select _path, _title, before, after
  where _path == "/notes/kickoff.md"
  follow distinct refs(before), _in_links { from _doc where ^_path in list(after) }
}`);
    expect(timelineStarter("/notes/kickoff.md", NAMES_4)).toBe(`docs {
  select path, title, before, after
  where path == "/notes/kickoff.md"
  follow distinct refs(before), in_links { from doc where ^path in list(after) }
}`);
    expect(timelineStarter("notes/kickoff.md")).toContain(`where _path == "/notes/kickoff.md"`);
    expect(timelineStarter()).toContain(`where _path == "/path/to/start.md"`);
    for (const names of [NAMES_5, NAMES_4]) {
      const q = parse(timelineStarter("a.md", names));
      // Both ends of the sequence are named, so the pair comes first (rule 5) and lays out.
      expect(inferCandidates(q, [], names).map((c) => [c.name, c.defaults.direction])).toEqual([["before/after", "forward"], ["before", "forward"], ["after", "backward"]]);
      expect(queryHints(q)).toEqual([]);
    }
  });

  it("existsQuery probes one path with limit 1, rooted", () => {
    expect(existsQuery(SAMPLE_PROBE_PATH)).toBe(`docs { select _path where _path == "/timeline/kickoff.md" limit 1 }`);
    expect(existsQuery(SAMPLE_PROBE_PATH, NAMES_4)).toBe(`docs { select path where path == "/timeline/kickoff.md" limit 1 }`);
    expect(existsQuery("timeline/kickoff.md")).toBe(existsQuery(SAMPLE_PROBE_PATH));
    expect(() => parse(existsQuery('odd "quoted".md'))).not.toThrow();
  });
});

describe("isSampleRepository", () => {
  it("is the sample slug with its timeline start document; an unanswered probe on that slug still counts", () => {
    expect(isSampleRepository(SAMPLE)).toBe(true);
    // The probe document decides: the slug is a designation the server never confirmed
    // (no `repos` tool in the minimal profile), and a failed probe (null) is not the sample.
    expect(isSampleRepository({ slug: SAMPLE_REPO, hasProbeDoc: null })).toBe(false);
    expect(isSampleRepository({ slug: SAMPLE_REPO, hasProbeDoc: false })).toBe(false);
    expect(isSampleRepository(NOTES)).toBe(false);
    expect(isSampleRepository({ slug: "notes", hasProbeDoc: true })).toBe(true);
    expect(isSampleRepository({ slug: "", hasProbeDoc: true })).toBe(true);
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

  it("respells a preset for the connected server: a 4.x server gets the bare names, a 5.0 server the `_` ones", () => {
    expect(chooseQuery(DEFAULT_QUERY, SAMPLE, NAMES_4)).toBe(defaultQuery(NAMES_4));
    expect(chooseQuery(defaultQuery(NAMES_4), SAMPLE, NAMES_4)).toBeNull();
    expect(chooseQuery(defaultQuery(NAMES_4), SAMPLE, NAMES_5)).toBe(DEFAULT_QUERY);
    expect(chooseQuery(STARTER_QUERY, NOTES, NAMES_4)).toBe(starterQuery(NAMES_4));
    expect(chooseQuery(starterQuery(NAMES_4), NOTES, NAMES_5)).toBe(STARTER_QUERY);
    expect(chooseQuery(starterQuery(NAMES_4), SAMPLE, NAMES_4)).toBe(defaultQuery(NAMES_4));
  });

  it("never replaces a user's edit", () => {
    const edited = `${DEFAULT_QUERY}\nlimit 3`;
    expect(chooseQuery(edited, NOTES)).toBeNull();
    expect(chooseQuery(edited, SAMPLE)).toBeNull();
    expect(chooseQuery(edited, SAMPLE, NAMES_4)).toBeNull();
    expect(chooseQuery("docs { select _path }", NOTES)).toBeNull();
    expect(chooseQuery(timelineStarter("/a.md"), NOTES)).toBeNull(); // the suggestion, once taken, is the user's
  });
});
