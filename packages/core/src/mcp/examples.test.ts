// The example ladders (spec/surface §4 "Descriptions", 4.3) and their drift
// gate. Each tool of the minimal profile describes itself as a ladder: a
// one-line summary, one example call per line, a last line pointing at
// `query_syntax`. The examples are extracted MECHANICALLY here — the rule
// below, mirrored by the Rust catalog's test — into the step list of
// `spec/surface/cases/examples.json`, which the surface spec runner
// (`corpus/surface/spec.test.ts`) executes against a fresh alchemy workspace.
// So: a description's example that stops being true fails the suite, and an
// example edited in the description without regenerating the suite fails HERE.
//
// Extraction rule (the rung grammar):
//  1. Only lines beginning `{` are candidates (a rung); the rest is prose.
//  2. A rung is the call's arguments as JSON, then three or more spaces, then a
//     comment. The JSON ends where the first run of three spaces begins, so a
//     rung's JSON never contains one.
//  3. A candidate holding an ellipsis (`…`) or an angle-bracket placeholder
//     (`<64 hex>`) is a schema line and skipped.
//  4. Steps are listed tool by tool in registration order (the catalog's), the
//     rungs of a tool in description order. A write tool's steps (WRITE_TOOLS)
//     carry the fixed clock EXAMPLES_TS so their commits are deterministic.
//
// TODO(mutate 3.2 sugar, the next commit): the selector rungs are written in
// the `{ "oqx": "<expr>" }` slot form and the document targets as `{ kind:
// "document", path }`; both switch to the `-> expr` leader and bare paths when
// that sugar lands in both engines (the design's §3), and the ladders shorten.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { buildServer, toolDescriptions, MINIMAL_TOOLS, WRITE_TOOLS } from "./server.js";

/** The suite the ladders feed (README §6). */
const EXAMPLES_FILE = fileURLToPath(new URL("../../../../spec/surface/cases/examples.json", import.meta.url));
/** The clock every writing rung runs under (a `read` step's `ts`), so the suite's commits are deterministic. */
export const EXAMPLES_TS = "2026-10-13T00:00:00.000Z";
/** The one case of the suite: every rung, in order, over one workspace. */
export const EXAMPLES_CASE = "ladders";
/** Client portability: keep a description under about this many characters (the design's bound is ~900; `plan`'s targets shrink with the sugar of the next commit). */
const DESCRIPTION_BUDGET = 1400;

const PLACEHOLDER = /<[^>]*>/;

export interface Rung {
  /** the arguments, parsed */
  args: Record<string, unknown>;
  /** the comment after the three spaces */
  comment: string;
  /** the line, verbatim */
  line: string;
}

/** The rungs of one description (rule 1–3); `skipped` lists the schema lines for the record. */
export function extractLadder(description: string): { rungs: Rung[]; skipped: string[] } {
  const rungs: Rung[] = [];
  const skipped: string[] = [];
  for (const line of description.split("\n")) {
    if (!line.startsWith("{")) continue;
    if (line.includes("…") || PLACEHOLDER.test(line)) {
      skipped.push(line);
      continue;
    }
    const m = / {3,}/.exec(line);
    const json = m ? line.slice(0, m.index) : line;
    const comment = m ? line.slice(m.index + m[0].length) : "";
    rungs.push({ args: JSON.parse(json) as Record<string, unknown>, comment, line });
  }
  return { rungs, skipped };
}

export type ExampleStep = { read: { tool: string; args: Record<string, unknown>; ts?: string } };

/** Rule 4: the suite's steps from the catalog's descriptions (registration order), the minimal tools only. */
export function exampleSteps(descriptions: Record<string, string>): ExampleStep[] {
  const steps: ExampleStep[] = [];
  for (const [tool, description] of Object.entries(descriptions)) {
    if (!MINIMAL_TOOLS.includes(tool)) continue;
    for (const { args } of extractLadder(description).rungs) {
      steps.push({ read: { tool, args, ...(WRITE_TOOLS.has(tool) ? { ts: EXAMPLES_TS } : {}) } });
    }
  }
  return steps;
}

async function referenceDescriptions(): Promise<Record<string, string>> {
  const store = new Store({ path: ":memory:" });
  try {
    return await toolDescriptions(buildServer({ store, repoId: ensureRepo(store, "fixture", null) }));
  } finally {
    store.close();
  }
}

const UPDATE = (() => {
  const v = process.env.SURFACE_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

interface ExamplesFile {
  suite: "examples";
  corpus: Record<string, string>;
  cases: { name: string; notes?: string; workspace?: boolean; steps: ExampleStep[]; expect?: unknown }[];
}

const descriptions = await referenceDescriptions();

if (UPDATE) {
  // Write the steps; the corpus and `expect` are the surface spec runner's
  // (run `SURFACE_SPEC_UPDATE=1 vitest run corpus/surface/spec.test.ts` after
  // this file). A changed step list drops the stale `expect` so the runner's
  // shape check accepts the file while it regenerates.
  const steps = exampleSteps(descriptions);
  const previous: ExamplesFile | null = existsSync(EXAMPLES_FILE) ? (JSON.parse(readFileSync(EXAMPLES_FILE, "utf8")) as ExamplesFile) : null;
  const prior = previous?.cases.find((c) => c.name === EXAMPLES_CASE);
  const same = prior !== undefined && JSON.stringify(prior.steps) === JSON.stringify(steps);
  const file: ExamplesFile = {
    suite: "examples",
    corpus: previous?.corpus ?? {},
    cases: [{
      name: EXAMPLES_CASE,
      notes: prior?.notes ?? "§4 \"Descriptions\": every example rung of the minimal tools' descriptions, extracted mechanically (mcp/examples.test.ts) and run in catalog order over the alchemy corpus in a workspace — the reads first (docs_read, docs_tree, query, blocks_resolve), then apply's commits, plan's previews over the written state, execute's digest form, and changes_since/version last. A write rung runs under the clock 2026-10-13T00:00:00.000Z.",
      workspace: true,
      steps,
      ...(same && prior?.expect !== undefined ? { expect: prior.expect } : {}),
    }],
  };
  writeFileSync(EXAMPLES_FILE, JSON.stringify(file, null, 2) + "\n");
  process.stderr.write(`[examples] ${steps.length} steps written to ${EXAMPLES_FILE}${same ? " (unchanged)" : " — regenerate expect with SURFACE_SPEC_UPDATE=1 on corpus/surface/spec.test.ts"}\n`);
}

describe("example ladders (spec/surface §4 \"Descriptions\")", () => {
  const ladders = MINIMAL_TOOLS.map((tool) => [tool, extractLadder(descriptions[tool] ?? "")] as const);

  it("every minimal tool's description is a ladder: a summary line, at least one rung, a last line naming query_syntax", () => {
    for (const [tool, { rungs }] of ladders) {
      const lines = descriptions[tool]!.split("\n");
      expect(lines[0], `${tool}: the first line is the summary`).toMatch(new RegExp(`^${tool} — `));
      expect(lines[0]!.startsWith("{"), `${tool}: the summary is prose`).toBe(false);
      expect(rungs.length, `${tool}: no example rung`).toBeGreaterThanOrEqual(1);
      expect(lines.at(-1), `${tool}: the last line points at query_syntax`).toContain("query_syntax");
      expect(lines.at(-1)!.startsWith("{"), `${tool}: the last line is prose`).toBe(false);
    }
  });

  it("every rung is the call's arguments as JSON, three spaces, a comment; a rung never carries a placeholder", () => {
    for (const [tool, { rungs, skipped }] of ladders) {
      for (const r of rungs) {
        expect(typeof r.args, `${tool}: ${r.line}`).toBe("object");
        expect(r.comment.length, `${tool}: a rung needs its comment — ${r.line}`).toBeGreaterThan(0);
        expect(r.line, `${tool}: a rung's JSON must not hold a run of three spaces`).toMatch(/^\{.*\} {3,}\S/);
      }
      // Schema lines are allowed but every one of them is deliberate — list them.
      for (const s of skipped) expect(s, `${tool}: a skipped line must hold … or <…>`).toMatch(/…|<[^>]*>/);
    }
  });

  it("every description stays within the portability budget", () => {
    for (const tool of MINIMAL_TOOLS) {
      expect(descriptions[tool]!.length, `${tool}: ${descriptions[tool]!.length} chars`).toBeLessThanOrEqual(DESCRIPTION_BUDGET);
    }
  });

  it("the ladders cover every minimal tool and nothing else, in catalog order", () => {
    const tools = [...new Set(exampleSteps(descriptions).map((s) => s.read.tool))];
    expect(tools.sort()).toEqual([...MINIMAL_TOOLS].sort());
    const order = Object.keys(descriptions).filter((t) => MINIMAL_TOOLS.includes(t));
    expect([...new Set(exampleSteps(descriptions).map((s) => s.read.tool))]).toEqual(order);
  });

  it("spec/surface/cases/examples.json's steps are exactly the extraction, bytewise (the drift gate; SURFACE_SPEC_UPDATE=1 regenerates)", () => {
    const file = JSON.parse(readFileSync(EXAMPLES_FILE, "utf8")) as ExamplesFile;
    expect(file.suite).toBe("examples");
    expect(file.cases.map((c) => c.name)).toEqual([EXAMPLES_CASE]);
    expect(file.cases[0]!.workspace).toBe(true);
    expect(JSON.stringify(file.cases[0]!.steps, null, 2)).toBe(JSON.stringify(exampleSteps(descriptions), null, 2));
  });
});
