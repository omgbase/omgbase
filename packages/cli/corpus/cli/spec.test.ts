// The CLI spec conformance runner: every case under spec/cli/cases is run by
// the reference — the built `omg` binary spawned with the case's argv, stdin and
// environment in a scratch workspace under the two conformance seams — and its
// exit code, stdout and (when pinned) stderr compared to the committed `expect`.
// The fixture contract is spec/cli/README.md §8.
//
// CLI_SPEC_UPDATE=1 rewrites each case's `expect` in place from its inputs
// (inputs, notes and case order untouched) before running; the diff is reviewed
// like code, because a changed `expect` *is* a CLI change.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BIN, CASES_DIR, Workspaces, assignExpects, describeChange, diffExpect, expectsOf, runCase, validateFixtureFile,
  type CaseInput, type FixtureCase, type FixtureFile,
} from "./fixture.js";

const UPDATE = (() => {
  const v = process.env.CLI_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

/** A case spawns the binary a few times; a cold Node + better-sqlite3 start is ~300 ms. */
const CASE_MS = 120_000;

function fileNames(): string[] {
  return existsSync(CASES_DIR) ? readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort() : [];
}

if (!existsSync(BIN)) {
  throw new Error(`the built CLI is missing at ${BIN} — run \`pnpm build\` first`);
}

const ws = new Workspaces();
afterAll(() => ws.cleanup());

// ---- regeneration ------------------------------------------------------------

/** Rewrite every case's `expect` from its inputs; returns the change report. */
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
    const before = doc.cases.map((c) => JSON.parse(JSON.stringify(c)) as FixtureCase);
    for (const c of doc.cases) {
      try {
        const run = runCase(ws, c as CaseInput);
        assignExpects(c as CaseInput, run.expects);
      } catch (e) {
        report.push(`  ! ${doc.suite}::${c.name}: ${String((e as Error).message ?? e).split("\n")[0]} (expect left as it was)`);
      }
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
  process.stderr.write(`[cli spec] regenerated expectations under ${CASES_DIR}\n${report.join("\n")}\n`);
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
  const p = validateFixtureFile(file, doc);
  if (p.length > 0) problems.push(...p);
  else loaded.set(file, doc as FixtureFile);
}

// ---- registration ----------------------------------------------------------------

describe("cli spec (spec/cli/cases)", () => {
  it("has at least one suite", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every suite file is well-formed", () => {
    expect(problems).toEqual([]);
  });

  it("suite names match their files", () => {
    for (const [file, doc] of loaded) expect(doc.suite, file).toBe(file.replace(/\.json$/, ""));
  });

  for (const [, doc] of loaded) {
    describe(doc.suite, () => {
      for (const c of doc.cases) {
        it(`${doc.suite}::${c.name}`, () => {
          const run = runCase(ws, c as CaseInput);
          const want = expectsOf(c as CaseInput);
          run.expects.forEach((got, i) => {
            const d = diffExpect(got, want[i]!);
            if (d !== null) {
              const step = want.length > 1 ? ` step ${i + 1}` : "";
              const context = got.stderr === undefined ? `\n--- stderr ---\n${run.stderr[i]}` : "";
              expect.fail(`${doc.suite}::${c.name}${step}: ${d}${context}`);
            }
          });
        }, CASE_MS);
      }
    });
  }
});
