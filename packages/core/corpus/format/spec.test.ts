// The format spec conformance runner: every fixture under spec/format/cases is
// parsed by the reference, checked against the §1 invariants, and compared to
// the committed `expect`. The fixture contract is spec/format/README.md §5.
//
// FORMAT_SPEC_UPDATE=1 regenerates the fixtures from the round-trip corpus
// (one suite per corpus directory) before running; the diff is reviewed like
// code, because a changed fixture *is* a block-model change.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTree, assertFullCoverage } from "../../src/core/parse/tree.js";
import { render } from "../../src/core/parse/render.js";
import type { BlockTree, RawBlock } from "../../src/core/parse/types.js";
import { toFixtureExpect, validateFixtureFile } from "./fixture.js";
import type { FixtureBlock, FixtureCase, FixtureFile } from "./fixture.js";

// packages/core/corpus/format → repo root is four levels up.
const CASES_DIR = fileURLToPath(new URL("../../../../spec/format/cases/", import.meta.url));
const CORPUS_DIR = fileURLToPath(new URL("../roundtrip/", import.meta.url));

const UPDATE = (() => {
  const v = process.env.FORMAT_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

// ---- corpus --------------------------------------------------------------------

/** Corpus suites: each immediate subdirectory of corpus/roundtrip holding .md files. */
function corpusSuites(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((e) => statSync(join(CORPUS_DIR, e)).isDirectory())
    .sort();
}

/** name → source for every .md file directly under a corpus suite directory. */
function corpusFiles(suite: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(join(CORPUS_DIR, suite)).sort()) {
    if (!f.endsWith(".md")) continue;
    out.set(f.replace(/\.md$/, ""), readFileSync(join(CORPUS_DIR, suite, f), "utf8"));
  }
  return out;
}

// ---- regeneration ------------------------------------------------------------

function buildSuite(suite: string): FixtureFile {
  const cases: FixtureCase[] = [];
  for (const [name, source] of corpusFiles(suite)) {
    cases.push({ name, source, expect: toFixtureExpect(parseTree(source)) });
  }
  cases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { suite, format: "markdown", cases };
}

function describeChange(before: FixtureFile | null, after: FixtureFile): string[] {
  if (before === null) return after.cases.map((c) => `  + ${after.suite}::${c.name} (new file)`);
  const lines: string[] = [];
  const old = new Map(before.cases.map((c) => [c.name, c] as const));
  const seen = new Set<string>();
  for (const c of after.cases) {
    seen.add(c.name);
    const prev = old.get(c.name);
    if (!prev) lines.push(`  + ${after.suite}::${c.name}`);
    else if (JSON.stringify(prev) !== JSON.stringify(c)) lines.push(`  ~ ${after.suite}::${c.name}`);
  }
  for (const name of old.keys()) if (!seen.has(name)) lines.push(`  - ${after.suite}::${name}`);
  return lines;
}

function regenerate(): string[] {
  mkdirSync(CASES_DIR, { recursive: true });
  const report: string[] = [];
  const written = new Set<string>();
  for (const suite of corpusSuites()) {
    const file = `${suite}.json`;
    const path = join(CASES_DIR, file);
    const before = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FixtureFile) : null;
    const after = buildSuite(suite);
    const json = JSON.stringify(after, null, 2) + "\n";
    const changed = before === null || readFileSync(path, "utf8") !== json;
    if (changed) writeFileSync(path, json);
    written.add(file);
    report.push(`${file}: ${after.cases.length} cases${changed ? "" : " (unchanged)"}`);
    report.push(...describeChange(before, after));
  }
  for (const f of readdirSync(CASES_DIR)) {
    if (f.endsWith(".json") && !written.has(f)) report.push(`${f}: stale — no corpus directory named '${f.replace(/\.json$/, "")}' (left in place; delete it by hand)`);
  }
  return report;
}

if (UPDATE) {
  const report = regenerate();
  process.stderr.write(`[format spec] regenerated fixtures under ${CASES_DIR}\n${report.join("\n")}\n`);
}

// ---- loading -------------------------------------------------------------------

const fileNames = existsSync(CASES_DIR)
  ? readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort()
  : [];
const loaded = new Map<string, FixtureFile>();
const problems: string[] = [];

for (const file of fileNames) {
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

// ---- invariants (README §1) ----------------------------------------------------

/** Recursively rebuild objects with sorted keys so deep equality ignores key order. */
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

function* walk(blocks: RawBlock[], parent: RawBlock | null = null): Generator<[RawBlock, RawBlock | null]> {
  for (const b of blocks) {
    yield [b, parent];
    yield* walk(b.children, b);
  }
}

function assertInvariants(tree: BlockTree): void {
  const { source } = tree;
  // 1. Round trip: splice rendering reproduces the source byte for byte.
  expect(render(tree)).toBe(source);
  // 2. Full coverage: top-level blocks and their trivia tile the source.
  expect(assertFullCoverage(tree)).toBe(true);
  // 6. A leading BOM is leading trivia and the first block starts after it.
  if (source.charCodeAt(0) === 0xfeff) {
    expect(tree.leadingTrivia.charCodeAt(0)).toBe(0xfeff);
    expect(tree.children[0]?.span.start ?? 1).toBeGreaterThanOrEqual(1);
  }
  for (const [b, parent] of walk(tree.children)) {
    // raw is the source at span.
    expect(b.span.start).toBeLessThanOrEqual(b.span.end);
    expect(b.raw).toBe(source.slice(b.span.start, b.span.end));
    // 4. Spans exclude the terminating line ending.
    expect(b.raw.endsWith("\n") || b.raw.endsWith("\r")).toBe(false);
    if (parent) {
      // 3. Nesting: within the parent's span and a substring of the parent's raw.
      expect(b.span.start).toBeGreaterThanOrEqual(parent.span.start);
      expect(b.span.end).toBeLessThanOrEqual(parent.span.end);
      expect(parent.raw.includes(b.raw)).toBe(true);
      // Nested blocks carry no trivia.
      expect(b.trivia).toBe("");
    }
    // Only containers nest (README §3).
    if (b.children.length > 0) expect(["list", "list_item", "task", "blockquote", "table"]).toContain(b.type);
  }
}

/** 5. Offsets are bytes: the fixture's span must slice the UTF-8 source to the implementation's raw. */
function assertByteSpans(source: string, fixtureBlocks: FixtureBlock[], impl: RawBlock[]): void {
  const bytes = Buffer.from(source, "utf8");
  expect(fixtureBlocks.length).toBe(impl.length);
  fixtureBlocks.forEach((fb, i) => {
    const ib = impl[i]!;
    expect(fb.span[1]).toBeLessThanOrEqual(bytes.length);
    expect(bytes.subarray(fb.span[0], fb.span[1]).toString("utf8")).toBe(ib.raw);
    assertByteSpans(source, fb.children, ib.children);
  });
}

function runCase(c: FixtureCase): void {
  const tree = parseTree(c.source); // 7. never throws
  assertInvariants(tree);
  assertByteSpans(c.source, c.expect.blocks, tree.children);
  const actual = sortKeys(toFixtureExpect(tree));
  const expected = sortKeys(c.expect);
  expect(actual).toEqual(expected);
}

// ---- registration --------------------------------------------------------------

describe("format spec fixtures (spec/format/cases)", () => {
  it("fixture files are well-formed", () => {
    expect(problems).toEqual([]);
  });

  it("has at least the three corpus suites", () => {
    expect(fileNames.length).toBeGreaterThanOrEqual(3);
    expect([...loaded.keys()]).toEqual(fileNames);
  });

  it("every corpus file has a fixture case with the same source, and vice versa", () => {
    const suites = corpusSuites();
    expect(suites.length).toBeGreaterThanOrEqual(3);
    for (const suite of suites) {
      const fixture = loaded.get(`${suite}.json`);
      expect(fixture, `missing fixture file ${suite}.json — run FORMAT_SPEC_UPDATE=1`).toBeDefined();
      const files = corpusFiles(suite);
      const caseNames = fixture!.cases.map((c) => c.name);
      expect(caseNames).toEqual([...caseNames].sort());
      expect(new Set(caseNames)).toEqual(new Set(files.keys()));
      for (const c of fixture!.cases) {
        expect(c.source, `${suite}::${c.name} source drifted from the corpus file`).toBe(files.get(c.name));
      }
    }
    // No fixture suite without a corpus directory behind it.
    for (const file of loaded.keys()) expect(suites).toContain(file.replace(/\.json$/, ""));
  });

  if (UPDATE) {
    it("regenerated every suite from the corpus", () => {
      for (const suite of corpusSuites()) expect(existsSync(join(CASES_DIR, `${suite}.json`))).toBe(true);
    });
  }

  for (const [file, fixture] of loaded) {
    const stem = file.replace(/\.json$/, "");
    describe(stem, () => {
      for (const c of fixture.cases) {
        it(`${stem}::${c.name}`, () => runCase(c));
      }
    });
  }
});
