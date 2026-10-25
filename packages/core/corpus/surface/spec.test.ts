// The surface spec conformance runner: every case under spec/surface/cases is
// run by the reference — corpus-backed query suites through `oqxRun` (planned
// AND pure in-memory, which must agree), `reads.json` scripts through the MCP
// tool handlers of the built server, `cursor.json` through the cursor codec —
// and compared to the committed `expect`. The fixture contract is
// spec/surface/README.md §6.
//
// SURFACE_SPEC_UPDATE=1 rewrites each case's `expect` in place from its inputs
// (inputs, notes and case order untouched) and re-embeds every query suite's
// `corpus` from packages/core/corpus/oqx/fixtures/alchemy before running; the
// diff is reviewed like code, because a changed `expect` *is* a surface change.
import { afterAll, describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/core/store/store.js";
import { envCapabilities } from "../../src/core/capabilities/default.js";
import { coreCapabilities } from "../../src/core/capabilities/core.js";
import { ensureRepo } from "../../src/core/attach.js";
import { buildServer, toolDescriptions, toolNames, TOOLS_PROFILES, type ToolsProfile } from "../../src/mcp/server.js";
import {
  carriesCorpus, coreModeQueryExpect, coreModeReadsExpect, deepEqualTol, describeChange, diffQueryExpect, loadCorpus, readCorpusFromDisk, runCursorCase, runQueryCase, runReadsCase, sortKeys, suiteKind, validateFixtureFile,
  type CursorCase, type CursorSuite, type ExamplesSuite, type FixtureFile, type LoadedCorpus, type ProfilesSuite, type QueryCase, type QuerySuite, type ReadsCase, type ReadsSuite,
} from "./fixture.js";

// packages/core/corpus/surface → repo root is four levels up.
const SPEC_DIR = fileURLToPath(new URL("../../../../spec/surface/", import.meta.url));
const CASES_DIR = join(SPEC_DIR, "cases");
/** README §4/§6: the catalog's tool names (registration order) and descriptions, pinned for both engines. */
const DESCRIPTIONS_FILE = join(SPEC_DIR, "tool-descriptions.json");

/** The reference catalog's `{ name → description }` in registration order (a `full` server — the profiles filter the listing, never the text). */
async function referenceDescriptions(): Promise<Record<string, string>> {
  const store = new Store({ path: ":memory:" });
  try {
    const repoId = ensureRepo(store, "fixture", null);
    return await toolDescriptions(buildServer({ store, repoId }));
  } finally {
    store.close();
  }
}

/** README §4 "Profiles" (4.3): the tool names a server built for `profile` lists, in registration order. */
async function referenceProfile(profile: ToolsProfile): Promise<string[]> {
  const store = new Store({ path: ":memory:" });
  try {
    const repoId = ensureRepo(store, "fixture", null);
    return await toolNames(buildServer({ store, repoId, tools: profile }));
  } finally {
    store.close();
  }
}

/** `profiles.json`'s content, from the reference. */
async function referenceProfiles(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const p of TOOLS_PROFILES) out[p] = await referenceProfile(p);
  return out;
}

const UPDATE = (() => {
  const v = process.env.SURFACE_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

/**
 * The core-only run (modular-core Phase 2 gate, `OMGBASE_CAPABILITIES=core`):
 * the stores have no semantic module, the semantic cases' expectations are
 * mapped to `capability_unavailable { semantic, disabled }` (fixture.ts), the
 * count is reported, and the fixtures are never regenerated from it.
 */
const CORE_MODE = envCapabilities() === coreCapabilities;
if (CORE_MODE && UPDATE) throw new Error("SURFACE_SPEC_UPDATE under OMGBASE_CAPABILITIES=core would record the core-only composition's answers; run it on the full one");
const coreMapped: string[] = [];

/** Nothing projected is floating point except search scores; compare within 1e-9. */
const EPS = 1e-9;

function fileNames(): string[] {
  return existsSync(CASES_DIR) ? readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort() : [];
}

// ---- regeneration ------------------------------------------------------------

/**
 * Rewrite every case's `expect` from its inputs (and every query suite's `corpus`
 * from disk); returns the change report. `interop.json` (README §7) is left to
 * interop.test.ts, which regenerates it under the same variable through the
 * two-process harness.
 */
async function regenerate(): Promise<string[]> {
  const report: string[] = [];
  const corpus = readCorpusFromDisk();
  for (const file of fileNames()) {
    const path = join(CASES_DIR, file);
    const text = readFileSync(path, "utf8");
    const doc = JSON.parse(text) as FixtureFile;
    const shapeProblems = validateFixtureFile(file, doc, { requireExpect: false });
    if (shapeProblems.length > 0) {
      report.push(`${file}: NOT regenerated — ${shapeProblems.length} shape problem(s):`, ...shapeProblems.map((p) => `  ! ${p}`));
      continue;
    }
    const kind = suiteKind(doc.suite);
    if (kind === "interop") {
      report.push(`${file}: ${(doc as QuerySuite).cases.length} cases — regenerated by interop.test.ts (README §7), not here`);
      continue;
    }
    if (kind === "profiles") {
      // README §4 "Profiles": each profile's listing, from the reference.
      const suite = doc as ProfilesSuite;
      suite.profiles = await referenceProfiles();
      const json = JSON.stringify(suite, null, 2) + "\n";
      if (json !== text) writeFileSync(path, json);
      report.push(`${file}: ${Object.keys(suite.profiles).length} profiles${json !== text ? "" : " (unchanged)"}`);
      continue;
    }
    const cased = doc as QuerySuite | ReadsSuite | CursorSuite | ExamplesSuite;
    const before = cased.cases.map((c) => ({ ...c }));
    if (kind === "query") {
      const suite = doc as QuerySuite;
      suite.corpus = corpus;
      const loaded = loadCorpus(corpus);
      try {
        for (const c of suite.cases) {
          const { expect: generated, problems } = runQueryCase(loaded, c);
          if (problems.length > 0) report.push(`  ! ${doc.suite}::${c.name}: ${problems.join("; ")}`);
          (c as { expect: unknown }).expect = generated;
        }
      } finally {
        loaded.store.close();
      }
    } else if (kind === "reads") {
      for (const c of (doc as ReadsSuite).cases) {
        const { expect: generated, problems } = await runReadsCase(c);
        if (problems.length > 0) report.push(`  ! ${doc.suite}::${c.name}: ${problems.join("; ")}`);
        (c as { expect: unknown }).expect = generated;
      }
    } else if (kind === "examples") {
      // README §6 (4.3): the steps are written by mcp/examples.test.ts from the
      // descriptions (run it first under the same variable); the corpus and the
      // expectations are regenerated here like a corpus-backed reads case.
      const suite = doc as ExamplesSuite;
      suite.corpus = corpus;
      for (const c of suite.cases) {
        const { expect: generated, problems } = await runReadsCase(c, suite.corpus);
        if (problems.length > 0) report.push(`  ! ${doc.suite}::${c.name}: ${problems.join("; ")}`);
        (c as { expect: unknown }).expect = generated;
      }
    } else {
      for (const c of (doc as CursorSuite).cases) (c as { expect: unknown }).expect = runCursorCase(c);
    }
    // Assigning an existing key keeps its position; a missing `expect` lands last.
    const json = JSON.stringify(doc, null, 2) + "\n";
    const changed = json !== text;
    if (changed) writeFileSync(path, json);
    report.push(`${file}: ${cased.cases.length} cases${changed ? "" : " (unchanged)"}`);
    report.push(...describeChange(doc.suite, before, cased.cases));
  }
  return report;
}

if (UPDATE) {
  const report = await regenerate();
  // The tool catalog's descriptions (README §4): one source for both engines —
  // `scripts/gen-tool-descriptions.mjs` turns this file into the Rust
  // catalog's `descriptions.rs`, and the surface crate's `tests/spec.rs` pins it.
  const descriptions = JSON.stringify(await referenceDescriptions(), null, 2) + "\n";
  const previous = existsSync(DESCRIPTIONS_FILE) ? readFileSync(DESCRIPTIONS_FILE, "utf8") : "";
  if (descriptions !== previous) writeFileSync(DESCRIPTIONS_FILE, descriptions);
  report.push(`tool-descriptions.json${descriptions === previous ? " (unchanged)" : " — regenerated; run node scripts/gen-tool-descriptions.mjs for the Rust catalog"}`);
  process.stderr.write(`[surface spec] regenerated expectations under ${CASES_DIR}\n${report.join("\n")}\n`);
}

// ---- loading -------------------------------------------------------------------

const files = fileNames();
const loaded = new Map<string, FixtureFile>();
const problems: string[] = [];

for (const file of files) {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8"));
  } catch (e) {
    problems.push(`${file}: ${String(e)}`);
    continue;
  }
  const found = validateFixtureFile(file, doc);
  if (found.length > 0) {
    problems.push(...found);
    continue;
  }
  loaded.set(file, doc as FixtureFile);
}

// ---- per-case ------------------------------------------------------------------

function runQuery(corpus: LoadedCorpus, c: QueryCase, suite: string): void {
  const { expect: actual, problems: runnerProblems } = runQueryCase(corpus, c);
  expect(runnerProblems, "planned and in-memory engines must agree").toEqual([]);
  let expected = c.expect;
  if (CORE_MODE) {
    const m = coreModeQueryExpect(c.expect);
    if (m.mapped) coreMapped.push(`${suite}::${c.name}`);
    expected = m.expect;
  }
  const diff = diffQueryExpect(actual, expected);
  if (diff !== null) expect(sortKeys(actual), diff).toEqual(sortKeys(expected));
}

async function runReads(c: ReadsCase, suite: string, corpus?: Record<string, string>): Promise<void> {
  const { expect: actual, problems: runnerProblems } = await runReadsCase(c, corpus);
  expect(runnerProblems).toEqual([]);
  let expected = c.expect;
  if (CORE_MODE) {
    const m = coreModeReadsExpect(c.expect);
    if (m.mapped > 0) coreMapped.push(`${suite}::${c.name} (${m.mapped} step outcome${m.mapped === 1 ? "" : "s"})`);
    expected = m.expect;
  }
  const diff = deepEqualTol(actual, expected, EPS);
  if (diff !== null) expect(sortKeys(actual), diff).toEqual(sortKeys(expected));
}

function runCursor(c: CursorCase): void {
  expect(runCursorCase(c)).toEqual(c.expect);
}

// ---- registration --------------------------------------------------------------

describe("surface spec fixtures (spec/surface/cases)", () => {
  it("spec/surface/VERSION is <major>.<minor> (README 'Versioning')", () => {
    expect(readFileSync(join(SPEC_DIR, "VERSION"), "utf8").trim()).toMatch(/^\d+\.\d+$/);
  });

  it("fixture files are well-formed", () => {
    expect(problems).toEqual([]);
  });

  it("every case file was loaded and case ids are unique", () => {
    expect(files.length).toBeGreaterThan(0);
    expect([...loaded.keys()]).toEqual(files);
    const ids = new Set<string>();
    for (const [file, fixture] of loaded) {
      const stem = file.replace(/\.json$/, "");
      if (!("cases" in fixture)) continue;
      for (const c of fixture.cases) {
        const id = `${stem}::${c.name}`;
        expect(ids.has(id), `duplicate case id ${id}`).toBe(false);
        ids.add(id);
      }
    }
  });

  it("tool-descriptions.json is the catalog's names (in order) and descriptions (README §4; SURFACE_SPEC_UPDATE=1 regenerates)", async () => {
    const pinned = JSON.parse(readFileSync(DESCRIPTIONS_FILE, "utf8")) as Record<string, string>;
    const actual = await referenceDescriptions();
    expect(Object.keys(actual)).toEqual(Object.keys(pinned));
    for (const [name, description] of Object.entries(actual)) expect(description, `description of ${name} drifted from spec/surface/tool-descriptions.json`).toBe(pinned[name]);
  });

  it("every corpus-backed suite embeds the alchemy corpus exactly as it is on disk (README §6)", () => {
    const disk = readCorpusFromDisk();
    expect(Object.keys(disk).length).toBe(20);
    for (const [file, fixture] of loaded) {
      if (!carriesCorpus(suiteKind(fixture.suite))) continue;
      expect((fixture as QuerySuite).corpus, `${file}: corpus drifted from corpus/oqx/fixtures/alchemy — run SURFACE_SPEC_UPDATE=1`).toEqual(disk);
    }
  });

  for (const [file, fixture] of loaded) {
    const stem = file.replace(/\.json$/, "");
    const kind = suiteKind(fixture.suite);
    describe(stem, () => {
      if (kind === "interop") {
        // README §7: two engines as separate processes over MCP stdio — a different
        // harness. Its shape was validated above; the cases run in interop.test.ts.
        it(`${stem}: ${(fixture as QuerySuite).cases.length} cases are run by interop.test.ts (README §7)`, () => {
          expect(existsSync(fileURLToPath(new URL("./interop.test.ts", import.meta.url)))).toBe(true);
        });
      } else if (kind === "query") {
        const suite = fixture as QuerySuite;
        // One store per suite: the corpus is read-only under every query.
        let corpus: LoadedCorpus | null = null;
        const get = (): LoadedCorpus => (corpus ??= loadCorpus(suite.corpus));
        for (const c of suite.cases) it(`${stem}::${c.name}`, () => runQuery(get(), c, stem));
        afterAll(() => {
          corpus?.store.close();
          corpus = null;
        });
      } else if (kind === "reads") {
        for (const c of (fixture as ReadsSuite).cases) it(`${stem}::${c.name}`, () => runReads(c, stem));
      } else if (kind === "examples") {
        // README §6 (4.3): the descriptions' ladders over the alchemy corpus; the
        // steps themselves are pinned to the descriptions by mcp/examples.test.ts.
        const suite = fixture as ExamplesSuite;
        for (const c of suite.cases) it(`${stem}::${c.name}`, () => runReads(c, stem, suite.corpus));
      } else if (kind === "profiles") {
        // README §4 "Profiles" (4.3): what each profile's server lists.
        const suite = fixture as ProfilesSuite;
        for (const [profile, names] of Object.entries(suite.profiles)) {
          it(`${stem}::${profile} lists exactly the pinned tools, in registration order`, async () => {
            expect(TOOLS_PROFILES).toContain(profile);
            expect(await referenceProfile(profile as ToolsProfile)).toEqual(names);
          });
        }
        it(`${stem}: full is the whole catalog of tool-descriptions.json`, () => {
          const pinned = JSON.parse(readFileSync(DESCRIPTIONS_FILE, "utf8")) as Record<string, string>;
          expect(suite.profiles.full).toEqual(Object.keys(pinned));
        });
      } else {
        for (const c of (fixture as CursorSuite).cases) it(`${stem}::${c.name}`, () => runCursor(c));
      }
    });
  }
});

// The core-only run's ledger: which semantic cases answered `capability_unavailable`
// instead of the fixture's full-composition outcome (none on the full run).
afterAll(() => {
  if (!CORE_MODE) return;
  process.stderr.write(`[surface spec] OMGBASE_CAPABILITIES=core: ${coreMapped.length} semantic case(s) mapped to capability_unavailable { semantic, disabled }:\n${coreMapped.map((c) => `  ${c}`).join("\n")}\n`);
});
