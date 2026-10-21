// The timeline corpus: a pure function of src/corpus.ts (two generations are
// byte-identical and the committed snapshot IS one), the authored data the tasks'
// answers rest on, and — through a real workspace — the oracle queries the tasks
// use, so a change to the generator that moves an answer fails here, not in a
// paid run.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_SEED, FENCED_TASK_DECOY, MILESTONES, OPEN_TASKS, PEOPLE, PROJECTS, TIMELINE_DIR, chainOf, diffTrees, generateTimeline, milestonePath, readTree, rng, writeTimeline } from "../src/corpus.ts";
import { OmgServer } from "../src/mcp.ts";
import { CORPORA, createWorkspace, fixtureBytes, vaultDiff, type Workspace } from "../src/workspace.ts";

const made: Workspace[] = [];
const spawned: OmgServer[] = [];
afterAll(async () => {
  for (const s of spawned) await s.close();
  for (const w of made) w.cleanup();
});

describe("generateTimeline", () => {
  const files = generateTimeline();

  it("is deterministic: two generations are byte-identical, and the PRNG is seeded", () => {
    expect(diffTrees(files, generateTimeline())).toEqual([]);
    const a = rng(CORPUS_SEED);
    const b = rng(CORPUS_SEED);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(rng(1)()).not.toBe(rng(2)());
  });

  it("the committed snapshot equals a fresh generation (regenerate with `pnpm --filter agent-bench corpus`)", () => {
    expect(diffTrees(files, readTree(TIMELINE_DIR))).toEqual([]);
    expect(CORPORA.timeline!.dir).toBe(TIMELINE_DIR);
  });

  it("writeTimeline replaces a directory with exactly the generated files", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bench-corpus-"));
    try {
      expect(writeTimeline(dir)).toBe(files.size);
      expect(diffTrees(files, readTree(dir))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has the shape the README states: 348 small Markdown files — 6 projects, 63 milestones, 10 people, 130 weekly meetings, 40 decisions, 30 journals, 30 glossary terms, 25 risks, 12 vendors, a hub and a template", () => {
    expect(files.size).toBe(348);
    const under = (prefix: string) => [...files.keys()].filter((p) => p.startsWith(prefix)).length;
    expect(under("/projects/")).toBe(6 + 63);
    expect(under("/people/")).toBe(10);
    expect(under("/meetings/")).toBe(130);
    expect(under("/decisions/")).toBe(40);
    expect(under("/journal/")).toBe(30);
    expect(under("/glossary/")).toBe(30);
    expect(under("/risks/")).toBe(25);
    expect(under("/vendors/")).toBe(12);
    expect(files.has("/index.md") && files.has("/templates/meeting.md")).toBe(true);
    for (const text of files.values()) expect(text.length).toBeLessThan(3000);
    expect([...files.values()].reduce((n, t) => n + Buffer.byteLength(t), 0)).toBeLessThan(400_000);
  });

  it("every milestone carries the authored frontmatter and ONE side of the chain (`after:` = the note before it, repository-root path)", () => {
    expect(MILESTONES).toHaveLength(63);
    expect(PROJECTS.map((p) => chainOf(p.slug).length)).toEqual([11, 9, 12, 13, 8, 10]);
    for (const p of PROJECTS) {
      const chain = chainOf(p.slug);
      chain.forEach((m, i) => {
        const text = files.get(milestonePath(m))!;
        expect(text).toMatch(new RegExp(`^type: milestone\\nproject: ${p.slug}\\ntitle: ${m.title}\\nwhen: ${m.when}\\nwindow: ${m.start}\\.\\.${m.when}\\nstatus: ${m.status}\\n`, "m"));
        expect(text).toContain(`\nowner: /people/${m.owner}.md\n`);
        expect(text).toContain(`\neffort: ${m.effort}\n`);
        expect(text).not.toContain("\nbefore:");
        if (i === 0) expect(text).not.toContain("\nafter:");
        else expect(text).toContain(`\nafter: ${milestonePath(chain[i - 1]!)}\n`);
        if (m.status === "done") expect(text).toContain(`\nclosed: ${m.closed}\n`);
        else expect(text).not.toContain("\nclosed:");
      });
    }
    // every owner is a person; every project lead too
    const people = new Set(PEOPLE.map((p) => p.slug));
    for (const m of MILESTONES) expect(people.has(m.owner)).toBe(true);
    for (const p of PROJECTS) expect(people.has(p.lead)).toBe(true);
  });

  it("the decoys are in place: aurora's dates disagree with its chain; the boundary windows; Mara Lind beside Mara Lindqvist; a fenced task", () => {
    const aurora = chainOf("aurora");
    const byWhen = [...aurora].sort((a, b) => (a.when < b.when ? -1 : 1)).map((m) => m.slug);
    expect(byWhen).not.toEqual(aurora.map((m) => m.slug));
    expect(aurora.map((m) => m.slug).indexOf("detector-cooldown-test")).toBeLessThan(aurora.map((m) => m.slug).indexOf("slit-mask-fabrication"));
    const inFlight = MILESTONES.filter((m) => m.start <= "2027-03-15" && "2027-03-15" <= m.when).map((m) => m.slug).sort();
    expect(inFlight).toEqual(["bench-alignment", "chiller-commissioning", "drainage-works", "pipeline-v1", "shutter-fabrication", "visitor-centre-brief"]);
    expect(MILESTONES.find((m) => m.slug === "foundation-pour")!.when).toBe("2027-03-14");
    expect(MILESTONES.find((m) => m.slug === "integration-with-dome")!.start).toBe("2027-03-16");
    expect(MILESTONES.find((m) => m.slug === "partner-agreements")).toMatchObject({ when: "2027-03-12", closed: "2027-03-15" });
    expect(PEOPLE.map((p) => p.slug)).toEqual(expect.arrayContaining(["mara-lindqvist", "mara-lind"]));
    expect(MILESTONES.filter((m) => m.owner === "mara-lind").map((m) => m.slug)).toEqual(["open-day"]);
    expect(files.get("/templates/meeting.md")).toContain(`\`\`\`markdown\n## Actions\n\n- [ ] ${FENCED_TASK_DECOY}\n`);
    // the sibling-project decoy names Aurora and is tagged with it, but sits in cirrus's chain
    expect(files.get("/projects/cirrus/dome-slit-alignment.md")).toMatch(/project: cirrus[\s\S]*tags: \[milestone, cirrus, done, aurora\][\s\S]*The Aurora team sat in/);
  });

  it("the open tasks are exactly the fourteen authored ones, each in its note, and nothing else is unchecked outside the fence", () => {
    expect(OPEN_TASKS).toHaveLength(14);
    let open = 0;
    for (const [path, text] of files) {
      const lines = text.split("\n").filter((l) => /^- \[ \] /.test(l));
      const expected = OPEN_TASKS.filter((t) => t.path === path).map((t) => `- [ ] ${t.text}`);
      if (path === "/templates/meeting.md") expect(lines).toEqual([`- [ ] ${FENCED_TASK_DECOY}`]);
      else expect(lines).toEqual(expected);
      open += path === "/templates/meeting.md" ? 0 : lines.length;
    }
    expect(open).toBe(14);
    expect([...files.values()].join("\n").match(/^- \[x\] /gm)!.length).toBe(487);
  });
});

describe("the timeline corpus through a workspace", () => {
  async function timeline(): Promise<OmgServer> {
    const ws = createWorkspace({ corpus: "timeline" });
    made.push(ws);
    expect(ws.corpus).toBe("timeline");
    expect(ws.env.OMGBASE_SPEC_MINTER).toBeUndefined(); // the sequential minter cannot mint past ~1000 blocks in a second process
    expect(vaultDiff(ws)).toEqual([]);
    const server = await OmgServer.spawn({ workspace: ws, profile: "full" });
    spawned.push(server);
    return server;
  }

  async function hits(server: OmgServer, query: string): Promise<Record<string, unknown>[]> {
    const r = await server.call("query", { query, limit: 500 });
    if (!r.ok) throw new Error(JSON.stringify(r.result));
    return (r.result as { hits: Record<string, unknown>[] }).hits;
  }

  it("ingests all 348 documents, and the tasks' oracle queries answer exactly what the task files expect", async () => {
    const server = await timeline();
    expect((await server.call("query", { query: "docs count { }" })).result).toMatchObject({ count: 348 });
    expect(fixtureBytes("/index.md", "timeline")).toMatch(/^---\ntype: hub\n/);

    // range-window-includes: six in flight on 2027-03-15, the boundary ones included
    const inFlight = await hits(server, 'select title from docs where type == "milestone" and "2027-03-15" in range(window) order by _path');
    expect(inFlight.map((h) => h.title)).toEqual(["Bench alignment", "Drainage works", "Shutter fabrication", "Pipeline v1", "Chiller commissioning", "Visitor centre brief"]);

    // aggregate-by-key: the counts, delta on top, ember absent (zero)
    const open = await hits(server, 'select project, n: count() from docs where type == "milestone" and status == "open" group by project order by count() desc');
    expect(open.map((h) => [h.project, h.n])).toEqual([["delta", 5], ["fjord", 4], ["cirrus", 3], ["aurora", 2], ["basalt", 1]]);

    // timeline-follow: the forward walk over the inverse `after:` relation, capped at depth 8, re-seeded from the frontier
    const first = await hits(server, 'select title, $frontier from docs where _path == "/projects/aurora/kickoff.md" follow ^docs collect { where after == ^_path depth 8 } order by $ordinal');
    expect(first.map((h) => h.title)).toEqual(chainOf("aurora").slice(0, 8).map((m) => m.title));
    expect(first[7]).toMatchObject({ title: "Integration with the dome", $frontier: true });
    const rest = await hits(server, 'select title from docs where _path == "/projects/aurora/integration-with-dome.md" follow ^docs collect { where after == ^_path } order by $ordinal');
    expect(rest.map((h) => h.title)).toEqual(chainOf("aurora").slice(7).map((m) => m.title));

    // timeline-between: the walk bounded by a frontier
    const between = await hits(server, 'select title from docs where _path == "/projects/delta/archive-schema-freeze.md" follow ^docs collect { where after == ^_path frontier _path == "/projects/delta/quicklook-viewer.md" } order by $ordinal');
    expect(between.map((h) => h.title)).toEqual(["Archive schema freeze", "Storage procurement", "Pipeline v1", "Calibration database", "Quick-look viewer"]);

    // open-tasks-across-corpus: fourteen md:task nodes unchecked — the fenced example is not one
    const tasks = await hits(server, 'select _path, _value from nodes where _kind == "md:task" and not checked order by _path');
    expect(tasks.map((h) => [h._path, h._value])).toEqual([...OPEN_TASKS].sort((a, b) => (a.path < b.path ? -1 : 1)).map((t) => [t.path, t.text]));

    // rollup-filtered: Mara Lindqvist's done-in-2027 milestones, by closing date; Mara Lind's Open day is not hers
    const mara = await hits(server, 'select _path, project from docs where type == "milestone" and status == "done" and owner == "/people/mara-lindqvist.md" and closed in "2027-01-01".."2027-12-31" order by closed');
    expect(mara.map((h) => `${h._path}: ${h.project}`)).toEqual(["/projects/cirrus/dome-slit-alignment.md: cirrus", "/projects/aurora/bench-alignment.md: aurora", "/projects/aurora/integration-with-dome.md: aurora"]);
    // `owner` is a frontmatter link too (spec/graph §3), so the person has in-links
    const owner = await hits(server, 'select n: _in_links count { where _field == "owner" } from docs where _path == "/people/mara-lind.md"');
    expect(owner[0]).toMatchObject({ n: 1 });
  }, 120_000);
});
