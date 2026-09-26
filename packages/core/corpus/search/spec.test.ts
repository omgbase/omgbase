// The search spec conformance runner: every case under spec/search/cases is
// either a pure case (`sanitize.json`: string → MATCH expression; `cosine.json`:
// two vectors → number) or an observation script (spec/store §9.4 plus the
// `drain` / `search` / `resolve` steps) run by the reference into a `:memory:`
// store with the fixture embedder (README §6) as the provider; the outcomes and
// the §7 projection are compared to the committed `expect` within the §7
// tolerances. The fixture contract is spec/search/README.md §7.
//
// SEARCH_SPEC_UPDATE=1 rewrites each case's `expect` in place from its inputs
// (inputs, notes and case order untouched) before running; the diff is
// reviewed like code, because a changed `expect` *is* a search change.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EPS, compareExpect, runCosineCase, runObserveCase, runSanitizeCase, suiteKind, validateFixtureFile,
} from "./fixture.js";
import type { CosineCase, FixtureCase, FixtureFile, ObserveCase, SanitizeCase } from "./fixture.js";

// packages/core/corpus/search → repo root is four levels up.
const SPEC_DIR = fileURLToPath(new URL("../../../../spec/search/", import.meta.url));
const CASES_DIR = join(SPEC_DIR, "cases");

const UPDATE = (() => {
  const v = process.env.SEARCH_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

function fileNames(): string[] {
  return existsSync(CASES_DIR) ? readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort() : [];
}

// ---- evaluation ------------------------------------------------------------------

interface Evaluation {
  expect: unknown;
  problems: string[];
}

async function evaluate(suite: string, c: FixtureCase): Promise<Evaluation> {
  switch (suiteKind(suite)) {
    case "sanitize":
      return { expect: runSanitizeCase(c as SanitizeCase), problems: [] };
    case "cosine":
      return { expect: runCosineCase(c as CosineCase), problems: [] };
    case "observe":
      return runObserveCase(c as ObserveCase);
  }
}

// ---- regeneration ------------------------------------------------------------

function describeChange(suite: string, before: FixtureCase[], after: FixtureCase[]): string[] {
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

/** Rewrite every case's `expect` from its inputs; returns the change report. */
async function regenerate(): Promise<string[]> {
  const report: string[] = [];
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
    for (const c of doc.cases) {
      const { expect: generated, problems } = await evaluate(doc.suite, c);
      if (problems.length > 0) report.push(`  ! ${doc.suite}::${c.name}: runner-check problems: ${problems.join("; ")}`);
      // Assigning an existing key keeps its position; a missing `expect` lands last.
      (c as { expect: unknown }).expect = generated;
    }
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
  process.stderr.write(`[search spec] regenerated expectations under ${CASES_DIR}\n${report.join("\n")}\n`);
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

async function runCase(suite: string, c: FixtureCase): Promise<void> {
  const { expect: actual, problems: checkProblems } = await evaluate(suite, c);
  expect(checkProblems).toEqual([]);
  switch (suiteKind(suite)) {
    case "sanitize":
      expect(actual).toBe(c.expect);
      return;
    case "cosine":
      expect(Math.abs((actual as number) - (c.expect as number)), `${actual} vs ${c.expect}`).toBeLessThanOrEqual(EPS);
      return;
    case "observe": {
      const diff = compareExpect(actual as ObserveCase["expect"], c.expect);
      if (diff !== null) {
        // Beyond tolerance: let vitest print the structural diff (key order sorted).
        expect(sortKeys(actual), diff).toEqual(sortKeys(c.expect));
      }
    }
  }
}

// ---- registration --------------------------------------------------------------

describe("search spec fixtures (spec/search/cases)", () => {
  it("spec/search/VERSION is <major>.<minor> (README 'Versioning')", () => {
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

  for (const [file, fixture] of loaded) {
    const stem = file.replace(/\.json$/, "");
    describe(stem, () => {
      for (const c of fixture.cases) {
        it(`${stem}::${c.name}`, () => runCase(stem, c));
      }
    });
  }
});
