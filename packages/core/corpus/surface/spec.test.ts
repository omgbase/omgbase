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
import {
  deepEqualTol, diffQueryExpect, loadCorpus, readCorpusFromDisk, runCursorCase, runQueryCase, runReadsCase, suiteKind, validateFixtureFile,
  type CursorCase, type CursorSuite, type FixtureFile, type LoadedCorpus, type QueryCase, type QuerySuite, type ReadsCase, type ReadsSuite,
} from "./fixture.js";

// packages/core/corpus/surface → repo root is four levels up.
const SPEC_DIR = fileURLToPath(new URL("../../../../spec/surface/", import.meta.url));
const CASES_DIR = join(SPEC_DIR, "cases");

const UPDATE = (() => {
  const v = process.env.SURFACE_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

/** Nothing projected is floating point except search scores; compare within 1e-9. */
const EPS = 1e-9;

function fileNames(): string[] {
  return existsSync(CASES_DIR) ? readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort() : [];
}

// ---- regeneration ------------------------------------------------------------

function describeChange(suite: string, before: { name: string; expect?: unknown }[], after: { name: string; expect?: unknown }[]): string[] {
  const lines: string[] = [];
  const old = new Map(before.map((c) => [c.name, c] as const));
  const seen = new Set<string>();
  for (const c of after) {
    seen.add(c.name);
    const prev = old.get(c.name);
    if (!prev || prev.expect === undefined) lines.push(`  + ${suite}::${c.name}`);
    else if (JSON.stringify(prev.expect) !== JSON.stringify(c.expect)) lines.push(`  ~ ${suite}::${c.name}`);
  }
  for (const name of old.keys()) if (!seen.has(name)) lines.push(`  - ${suite}::${name}`);
  return lines;
}

/** Rewrite every case's `expect` from its inputs (and every query suite's `corpus` from disk); returns the change report. */
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
    const before = doc.cases.map((c) => ({ ...c }));
    const kind = suiteKind(doc.suite);
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
    } else {
      for (const c of (doc as CursorSuite).cases) (c as { expect: unknown }).expect = runCursorCase(c);
    }
    // Assigning an existing key keeps its position; a missing `expect` lands last.
    const json = JSON.stringify(doc, null, 2) + "\n";
    const changed = json !== text;
    if (changed) writeFileSync(path, json);
    report.push(`${file}: ${doc.cases.length} cases${changed ? "" : " (unchanged)"}`);
    report.push(...describeChange(doc.suite, before, doc.cases));
  }
  return report;
}

if (UPDATE) {
  const report = await regenerate();
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

/** Recursively rebuild objects with sorted keys so vitest's diff ignores key order. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) out[k] = sortKeys(rec[k]);
    return out;
  }
  return v;
}

function runQuery(corpus: LoadedCorpus, c: QueryCase): void {
  const { expect: actual, problems: runnerProblems } = runQueryCase(corpus, c);
  expect(runnerProblems, "planned and in-memory engines must agree").toEqual([]);
  const diff = diffQueryExpect(actual, c.expect);
  if (diff !== null) expect(sortKeys(actual), diff).toEqual(sortKeys(c.expect));
}

async function runReads(c: ReadsCase): Promise<void> {
  const { expect: actual, problems: runnerProblems } = await runReadsCase(c);
  expect(runnerProblems).toEqual([]);
  const diff = deepEqualTol(actual, c.expect, EPS);
  if (diff !== null) expect(sortKeys(actual), diff).toEqual(sortKeys(c.expect));
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
      for (const c of fixture.cases) {
        const id = `${stem}::${c.name}`;
        expect(ids.has(id), `duplicate case id ${id}`).toBe(false);
        ids.add(id);
      }
    }
  });

  it("every query suite embeds the alchemy corpus exactly as it is on disk (README §6)", () => {
    const disk = readCorpusFromDisk();
    expect(Object.keys(disk).length).toBe(18);
    for (const [file, fixture] of loaded) {
      if (suiteKind(fixture.suite) !== "query") continue;
      expect((fixture as QuerySuite).corpus, `${file}: corpus drifted from corpus/oqx/fixtures/alchemy — run SURFACE_SPEC_UPDATE=1`).toEqual(disk);
    }
  });

  for (const [file, fixture] of loaded) {
    const stem = file.replace(/\.json$/, "");
    const kind = suiteKind(fixture.suite);
    describe(stem, () => {
      if (kind === "query") {
        const suite = fixture as QuerySuite;
        // One store per suite: the corpus is read-only under every query.
        let corpus: LoadedCorpus | null = null;
        const get = (): LoadedCorpus => (corpus ??= loadCorpus(suite.corpus));
        for (const c of suite.cases) it(`${stem}::${c.name}`, () => runQuery(get(), c));
        afterAll(() => {
          corpus?.store.close();
          corpus = null;
        });
      } else if (kind === "reads") {
        for (const c of (fixture as ReadsSuite).cases) it(`${stem}::${c.name}`, () => runReads(c));
      } else {
        for (const c of (fixture as CursorSuite).cases) it(`${stem}::${c.name}`, () => runCursor(c));
      }
    });
  }
});
