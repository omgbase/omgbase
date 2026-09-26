// The graph spec conformance runner: every case under spec/graph/cases is an
// observation script (spec/store §9.4) run by the reference into a `:memory:`
// store; the graph tables are read back, checked against the §7 runner checks
// (node_id derivation, commit references, open dst_node validity, doc_edges =
// a recomputed rollup) and compared to the committed `expect`. The fixture
// contract is spec/graph/README.md §7.
//
// GRAPH_SPEC_UPDATE=1 rewrites each case's `expect` in place from its steps
// (inputs, notes and case order untouched) before running; the diff is
// reviewed like code, because a changed `expect` *is* a graph change.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepEqualTol, runCase as evaluateCase, validateFixtureFile } from "./fixture.js";
import type { FixtureCase, FixtureFile } from "./fixture.js";

// packages/core/corpus/graph → repo root is four levels up.
const SPEC_DIR = fileURLToPath(new URL("../../../../spec/graph/", import.meta.url));
const CASES_DIR = join(SPEC_DIR, "cases");

const UPDATE = (() => {
  const v = process.env.GRAPH_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

/** Nothing projected is floating point; compare exactly. */
const EPS = 0;

function fileNames(): string[] {
  return existsSync(CASES_DIR) ? readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort() : [];
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

/** Rewrite every case's `expect` from its steps; returns the change report. */
function regenerate(): string[] {
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
      const { expect: generated, problems } = evaluateCase(c);
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
  const report = regenerate();
  process.stderr.write(`[graph spec] regenerated expectations under ${CASES_DIR}\n${report.join("\n")}\n`);
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

function runCase(c: FixtureCase): void {
  const { expect: actual, problems: checkProblems } = evaluateCase(c);
  expect(checkProblems).toEqual([]);
  const diff = deepEqualTol(actual, c.expect, EPS);
  if (diff !== null) {
    // Let vitest print the structural diff (key order sorted).
    expect(sortKeys(actual), diff).toEqual(sortKeys(c.expect));
  }
}

// ---- registration --------------------------------------------------------------

describe("graph spec fixtures (spec/graph/cases)", () => {
  it("spec/graph/VERSION is <major>.<minor> (README 'Versioning')", () => {
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
        it(`${stem}::${c.name}`, () => runCase(c));
      }
    });
  }
});
