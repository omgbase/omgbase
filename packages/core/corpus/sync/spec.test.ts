// The sync spec conformance runner: every case under spec/sync/cases is run by
// the reference — `pure.json` through the pure functions, `registry.json` and
// `checkpoint.json` as scripts against a `:memory:` store (the latter over an
// in-memory filesystem), and the `adapter` cases of `protocol.json` against a
// scripted fake adapter process — and compared to the committed `expect`. The
// `coordinator` cases of `protocol.json` run from packages/sync (where the
// coordinator lives). The fixture contract is spec/sync/README.md §8.
//
// SYNC_SPEC_UPDATE=1 rewrites each case's `expect` in place from its inputs
// (inputs, notes and case order untouched; for `adapter` cases also the
// transcript's `out` lines, which are the engine's requests) before running;
// the diff is reviewed like code, because a changed `expect` *is* a sync change.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deepEqualTol, runPure, runRegistryCase, runCheckpointCase, runAdapterCase, suiteKind, validateFixtureFile,
  type AdapterCase, type CheckpointCase, type FixtureCase, type FixtureFile, type PureCase, type RegistryCase,
} from "./fixture.js";

// packages/core/corpus/sync → repo root is four levels up.
const SPEC_DIR = fileURLToPath(new URL("../../../../spec/sync/", import.meta.url));
const CASES_DIR = join(SPEC_DIR, "cases");
const FAKE_ADAPTER = fileURLToPath(new URL("./fake-adapter.mjs", import.meta.url));

const UPDATE = (() => {
  const v = process.env.SYNC_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

/** Nothing projected is floating point except `confidence`; compare within 1e-9 as spec/reconcile does. */
const EPS = 1e-9;

function fileNames(): string[] {
  return existsSync(CASES_DIR) ? readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort() : [];
}

/** Which cases this runner owns: everything but the coordinator cases of `protocol.json`. */
function ownsCase(c: FixtureCase): boolean {
  return !("kind" in c && c.kind === "coordinator");
}

type Evaluated = { expect: unknown; problems: string[]; transcriptOut?: string[] };

async function evaluate(suite: string, c: FixtureCase): Promise<Evaluated> {
  switch (suiteKind(suite)) {
    case "pure":
      return { expect: runPure(c as PureCase), problems: [] };
    case "registry":
      return { expect: runRegistryCase(c as RegistryCase).expect, problems: [] };
    case "checkpoint": {
      const r = runCheckpointCase(c as CheckpointCase);
      return { expect: r.expect, problems: r.problems };
    }
    case "protocol": {
      const a = c as AdapterCase;
      const r = await runAdapterCase(a, FAKE_ADAPTER);
      const want = a.transcript.filter((e) => e.dir === "out").map((e) => e.line);
      const problems: string[] = [];
      if (r.received.length !== want.length) problems.push(`the adapter received ${r.received.length} request line(s) for ${want.length} \`out\` entries: ${JSON.stringify(r.received)}`);
      else r.received.forEach((line, i) => {
        if (line !== want[i]) problems.push(`request ${i}: engine sent ${line}, transcript says ${want[i]}`);
      });
      return { expect: r.expect, problems, transcriptOut: r.received };
    }
    default:
      throw new Error(`unknown suite ${suite}`);
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
    else if (JSON.stringify(prev) !== JSON.stringify(c)) lines.push(`  ~ ${suite}::${c.name}`);
  }
  for (const name of old.keys()) if (!seen.has(name)) lines.push(`  - ${suite}::${name}`);
  return lines;
}

/** Rewrite every owned case's `expect` from its inputs; returns the change report. */
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
    const before = doc.cases.map((c) => JSON.parse(JSON.stringify(c)) as FixtureCase);
    let owned = 0;
    for (const c of doc.cases) {
      if (!ownsCase(c)) continue;
      owned++;
      const { expect: generated, problems, transcriptOut } = await evaluate(doc.suite, c);
      if (transcriptOut !== undefined) {
        // The engine's requests are what the `out` lines pin: rewrite them when the count lines up.
        const outs = (c as AdapterCase).transcript.filter((e) => e.dir === "out");
        if (outs.length === transcriptOut.length) outs.forEach((e, i) => (e.line = transcriptOut[i]!));
        else report.push(`  ! ${doc.suite}::${c.name}: ${problems.join("; ")}`);
      } else if (problems.length > 0) report.push(`  ! ${doc.suite}::${c.name}: invariant problems: ${problems.join("; ")}`);
      // Assigning an existing key keeps its position; a missing `expect` lands last.
      (c as { expect: unknown }).expect = generated;
    }
    const json = JSON.stringify(doc, null, 2) + "\n";
    const changed = json !== text;
    if (changed) writeFileSync(path, json);
    report.push(`${file}: ${owned} cases${changed ? "" : " (unchanged)"}`);
    report.push(...describeChange(doc.suite, before, doc.cases));
  }
  return report;
}

if (UPDATE) {
  const report = await regenerate();
  process.stderr.write(`[sync spec] regenerated expectations under ${CASES_DIR}\n${report.join("\n")}\n`);
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

async function run(suite: string, c: FixtureCase): Promise<void> {
  const { expect: actual, problems: found } = await evaluate(suite, c);
  expect(found).toEqual([]);
  const diff = deepEqualTol(actual, c.expect, EPS);
  if (diff !== null) {
    // Beyond tolerance: let vitest print the structural diff (key order sorted).
    expect(sortKeys(actual), diff).toEqual(sortKeys(c.expect));
  }
}

// ---- registration --------------------------------------------------------------

describe("sync spec fixtures (spec/sync/cases)", () => {
  it("spec/sync/VERSION is <major>.<minor> (README 'Versioning')", () => {
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
        if (!ownsCase(c)) continue;
        it(`${stem}::${c.name}`, () => run(fixture.suite, c));
      }
    });
  }
});
