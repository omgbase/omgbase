// The coordinator half of the sync spec conformance runner: the `coordinator`
// cases of spec/sync/cases/protocol.json run the production `Coordinator` over a
// scripted source and a recording engine client and are compared to the
// committed `expect`. Everything else in spec/sync runs from
// packages/core/corpus/sync/spec.test.ts. The fixture contract is
// spec/sync/README.md §8.
//
// SYNC_SPEC_UPDATE=1 rewrites each coordinator case's `expect` in place (other
// cases, inputs, notes and case order untouched) before running.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCoordinatorCase, validateCoordinatorCase, type CoordinatorCase } from "./fixture.js";

// packages/sync/corpus/sync → repo root is four levels up.
const SPEC_DIR = fileURLToPath(new URL("../../../../spec/sync/", import.meta.url));
const CASES_FILE = `${SPEC_DIR}cases/protocol.json`;

const UPDATE = (() => {
  const v = process.env.SYNC_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

interface FixtureFile {
  suite: string;
  cases: ({ name: string; kind?: string } & Record<string, unknown>)[];
}

function isCoordinator(c: { kind?: string }): c is CoordinatorCase & Record<string, unknown> {
  return c.kind === "coordinator";
}

function load(): FixtureFile | null {
  return existsSync(CASES_FILE) ? (JSON.parse(readFileSync(CASES_FILE, "utf8")) as FixtureFile) : null;
}

function validate(doc: FixtureFile, requireExpect: boolean): string[] {
  const problems: string[] = [];
  doc.cases.forEach((c, i) => {
    if (isCoordinator(c)) validateCoordinatorCase(`protocol.json#${i}`, c, requireExpect, problems);
  });
  return problems;
}

// ---- regeneration ------------------------------------------------------------

async function regenerate(): Promise<string[]> {
  const doc = load();
  if (!doc) return ["protocol.json: missing"];
  const text = readFileSync(CASES_FILE, "utf8");
  const shapeProblems = validate(doc, false);
  if (shapeProblems.length > 0) return ["protocol.json: NOT regenerated — shape problem(s):", ...shapeProblems.map((p) => `  ! ${p}`)];
  const report: string[] = [];
  let n = 0;
  for (const c of doc.cases) {
    if (!isCoordinator(c)) continue;
    n++;
    const before = JSON.stringify(c.expect);
    const { expect: generated } = await runCoordinatorCase(c);
    (c as { expect: unknown }).expect = generated;
    const after = JSON.stringify(generated);
    if (before === undefined) report.push(`  + protocol::${c.name}`);
    else if (before !== after) report.push(`  ~ protocol::${c.name}`);
  }
  const json = JSON.stringify(doc, null, 2) + "\n";
  const changed = json !== text;
  if (changed) writeFileSync(CASES_FILE, json);
  return [`protocol.json: ${n} coordinator cases${changed ? "" : " (unchanged)"}`, ...report];
}

if (UPDATE) {
  const report = await regenerate();
  process.stderr.write(`[sync spec / coordinator] regenerated expectations in ${CASES_FILE}\n${report.join("\n")}\n`);
}

// ---- loading -------------------------------------------------------------------

const doc = load();
const problems = doc ? validate(doc, true) : ["protocol.json: missing"];
const cases = doc ? doc.cases.filter(isCoordinator) : [];

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

describe("sync spec fixtures — coordinator (spec/sync/cases/protocol.json)", () => {
  it("coordinator cases are well-formed", () => {
    expect(problems).toEqual([]);
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`protocol::${c.name}`, async () => {
      const { expect: actual } = await runCoordinatorCase(c);
      expect(sortKeys(actual)).toEqual(sortKeys(c.expect));
    });
  }
});
