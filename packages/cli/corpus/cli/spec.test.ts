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
import { compositionHasGitProvider, compositionHasHistory, compositionHasSemantic, envComposition } from "@omgbase/core";
import {
  BIN, CASES_DIR, Workspaces, assignExpects, describeChange, diffExpect, expectsOf, isSequence, runCase, validateFixtureFile,
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

// ---- the four compositions (spec/cli §8 "The four compositions"; modular-core Phase 5a) ----
//
// `OMGBASE_CAPABILITIES=core|history|semantic|full` reaches every spawned binary
// (`baseEnv`), so the SAME cases run against the composition named. The fixtures
// are the full composition's record; under a reduced one a case whose inputs or
// recorded outputs carry an OBSERVABLE of the absent module is skipped and
// counted (a verb of the module, or a word of its wire — the recorder's table
// names and disposition summary, the embed queue and the vector tables, the
// capability states), and every other case must pass UNCHANGED. The classifier
// is deliberately textual and conservative: it reads the case, never the run.
const COMPOSITION = envComposition();
const HAS_HISTORY = compositionHasHistory(COMPOSITION);
const HAS_SEMANTIC = compositionHasSemantic(COMPOSITION);
const HAS_GIT = compositionHasGitProvider(COMPOSITION);
if (UPDATE && COMPOSITION !== "full") throw new Error(`CLI_SPEC_UPDATE under OMGBASE_CAPABILITIES=${COMPOSITION} would record that composition's answers; run it on the full one`);
const ledger = { compared: [] as string[], skipped: [] as string[] };

/** The verbs that reach the history module (the capture verbs, the log/history readers, `show --history`, `cat --at`). */
const HISTORY_VERBS = new Set(["log", "hist", "diff", "history"]);
const HISTORY_FLAGS = new Set(["--history", "--at"]);
/** The verbs that reach the semantic module. */
const SEMANTIC_VERBS = new Set(["embed", "find"]);
/** Words of the history module's wire: its tables in a size report, the recorder's disposition summary, its capability state and the doctor's capture check. */
const HISTORY_TEXT = /\b(commits|revisions|dispositions|block_changes|tree_nodes|blobs|edge_transitions|archives)\b|"history":\{"state":"enabled|history\s+enabled|"coverage_from":"(\d|<string>)|"writer_requires":true|capture complete| — \d+ (inserted|edited|deleted|moved|resurrected|same|split|merged)|history unavailable|writer_refused|capability_unavailable|revision/;
/** Words that bind a GIT case to the native module too (spec/cli §8, 5.5): the provider conflict, `checkpoint` refused on a native repository, a native provider in a size report. */
const NATIVE_TEXT = /with the native provider|history is native|"provider":"native"/;
/** Words of the semantic module's wire: the embed queue, the vector tables, its capability state, the provider. */
const SEMANTIC_TEXT = /\bqueued\b|"embedQueue":[1-9]|\bdoc_embeddings\b|\bembeddings\b|"semantic":\{"state":"enabled|embedding|provider_unavailable|capability_unavailable|semantic\(/;

function caseText(c: FixtureCase): { argv: string[]; text: string } {
  const steps = isSequence(c) ? c.steps : [c];
  const argv = steps.flatMap((s) => s.argv);
  const text = steps.map((s) => `${s.stdin ?? ""}\n${s.expect?.stdout ?? ""}\n${s.expect?.stderr ?? ""}`).join("\n") + Object.values({ ...(c.files ?? {}), ...(c.sql ? { sql: c.sql.join("\n") } : {}) }).join("\n");
  return { argv, text };
}

/** Why the case is skipped under this composition, or null when it must pass as recorded. */
/** A GIT case (spec/cli §8, 5.5; 5.6): a step names `--provider git`, `history checkpoint`, or (Phase 6b) `history remote|push|fetch`. */
const GIT_HISTORY_SUBS = new Set(["checkpoint", "remote", "push", "fetch"]);
function isGitCase(argv: string[]): boolean {
  return argv.some((a, i) => (a === "--provider" && argv[i + 1] === "git") || (a === "history" && GIT_HISTORY_SUBS.has(argv[i + 1] ?? "")));
}

function skipReason(c: FixtureCase): string | null {
  const { argv, text } = caseText(c);
  // spec/cli §8 "The five compositions" (5.5, Phase 6a): a git case runs where the provider is attached (`full`, `git`);
  // on `git` — no native module — it is skipped only when it also needs the native provider (NATIVE_TEXT), not for the
  // history wire its own outputs carry.
  if (isGitCase(argv)) {
    if (!HAS_GIT) return "needs the git history provider";
    if (!HAS_HISTORY && NATIVE_TEXT.test(text)) return "needs the history module";
    if (!HAS_SEMANTIC && (argv.some((a) => SEMANTIC_VERBS.has(a)) || SEMANTIC_TEXT.test(text))) return "needs the semantic module";
    return null;
  }
  if (!HAS_HISTORY && (argv.some((a) => HISTORY_VERBS.has(a) || HISTORY_FLAGS.has(a)) || HISTORY_TEXT.test(text))) return "needs the history module";
  if (!HAS_SEMANTIC && (argv.some((a) => SEMANTIC_VERBS.has(a)) || SEMANTIC_TEXT.test(text))) return "needs the semantic module";
  return null;
}

afterAll(() => {
  let out = `[cli spec] composition=${COMPOSITION}: compared=${ledger.compared.length} mapped=0 skipped=${ledger.skipped.length}\n`;
  if (COMPOSITION !== "full") for (const s of ledger.skipped) out += `  skip ${s}\n`;
  process.stderr.write(out);
});

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
        const reason = skipReason(c);
        if (reason !== null) {
          ledger.skipped.push(`${doc.suite}::${c.name} — ${reason}`);
          it.skip(`${doc.suite}::${c.name} — skipped: ${reason} [OMGBASE_CAPABILITIES=${COMPOSITION}]`, () => {});
          continue;
        }
        it(`${doc.suite}::${c.name}`, () => {
          ledger.compared.push(`${doc.suite}::${c.name}`);
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
