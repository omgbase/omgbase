// The store spec conformance runner: every case under spec/store/cases is run
// through the reference store, checked against the §8 invariants, and its
// projection compared to the committed `expect`. The fixture contract is
// spec/store/README.md §9; `schema.sql` is asserted equal to the embedded DDL.
//
// STORE_SPEC_UPDATE=1 rewrites each case's `expect` in place from its inputs
// (inputs, notes and case order untouched) before running; the diff is
// reviewed like code, because a changed `expect` *is* a store change.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_DDL, DDL, HISTORY_DDL, SCHEMA_VERSION, SEMANTIC_DDL } from "../../src/core/store/schema.js";
import { ARCHIVE_DDL } from "../../src/core/store/archive.js";
import {
  deepEqualTol, runEdgeTransitionsCase, runMigrationCase, runObserveCase, runSchemaCase, suiteKind, validateFixtureFile,
} from "./fixture.js";
import type { EdgeTransitionsCase, FixtureCase, FixtureFile, MigrationCase, ObserveCase, SchemaCase } from "./fixture.js";

// packages/core/corpus/store → repo root is four levels up.
const SPEC_DIR = fileURLToPath(new URL("../../../../spec/store/", import.meta.url));
const CASES_DIR = join(SPEC_DIR, "cases");

const UPDATE = (() => {
  const v = process.env.STORE_SPEC_UPDATE;
  return v !== undefined && v !== "" && v !== "0";
})();

/** Nothing projected is floating point except `confidence`; compare within 1e-9 as spec/reconcile does. */
const EPS = 1e-9;

/** `cases/*.json` and the recorder suites under `cases/history/*.json` (README §9.1, §9.5), as paths relative to `cases/`. */
function fileNames(): string[] {
  if (!existsSync(CASES_DIR)) return [];
  const top = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort();
  const historyDir = join(CASES_DIR, "history");
  const history = existsSync(historyDir) ? readdirSync(historyDir).filter((f) => f.endsWith(".json")).sort().map((f) => `history/${f}`) : [];
  return [...top, ...history];
}

/** The suite name of a case file: its base name without `.json`. */
const stemOf = (file: string): string => file.replace(/\.json$/, "").replace(/^.*\//, "");

// ---- evaluation ------------------------------------------------------------------

interface Evaluation {
  expect: unknown;
  problems: string[];
}

function evaluate(suite: string, c: FixtureCase): Evaluation {
  switch (suiteKind(suite)) {
    case "schema":
      return { expect: runSchemaCase(), problems: [] };
    case "migration":
      return { expect: runMigrationCase(c as MigrationCase), problems: [] };
    case "observe":
      return runObserveCase(c as ObserveCase);
    case "edges":
      return runEdgeTransitionsCase(c as EdgeTransitionsCase);
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
      const { expect: generated, problems } = evaluate(doc.suite, c);
      if (problems.length > 0) report.push(`  ! ${doc.suite}::${c.name}: invariant problems: ${problems.join("; ")}`);
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
  process.stderr.write(`[store spec] regenerated expectations under ${CASES_DIR}\n${report.join("\n")}\n`);
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

function runCase(suite: string, c: FixtureCase): void {
  const { expect: actual, problems: invariantProblems } = evaluate(suite, c);
  expect(invariantProblems).toEqual([]);
  const diff = deepEqualTol(actual, c.expect, EPS);
  if (diff !== null) {
    // Beyond tolerance: let vitest print the structural diff (key order sorted).
    expect(sortKeys(actual), diff).toEqual(sortKeys(c.expect));
  }
}

// ---- registration --------------------------------------------------------------

describe("store spec fixtures (spec/store/cases)", () => {
  it("spec/store/schema.sql is the embedded core DDL, byte for byte (README §3.3)", () => {
    expect(readFileSync(join(SPEC_DIR, "schema.sql"), "utf8")).toBe(DDL);
  });

  it("spec/store/schema-history.sql and schema-semantic.sql are the embedded bundle DDLs, byte for byte (README §3.3, 17.0)", () => {
    expect(readFileSync(join(SPEC_DIR, "schema-history.sql"), "utf8")).toBe(HISTORY_DDL);
    expect(readFileSync(join(SPEC_DIR, "schema-semantic.sql"), "utf8")).toBe(SEMANTIC_DDL);
  });

  it("the three bundles partition the table set — no table lost or duplicated against 17.0's single file (README §3.3)", () => {
    const names = (ddl: string): string[] => [...ddl.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
    const core = names(DDL);
    const history = names(HISTORY_DDL);
    const semantic = names(SEMANTIC_DDL);
    const all = [...core, ...history, ...semantic];
    expect(new Set(all).size).toBe(all.length);
    expect(names(ALL_DDL)).toEqual(all);
    // The single-file table set of 17.0 through slice 3d, minus the D9 drops
    // (`collections`, `inferred_edges`), plus the history bundle's `edge_transitions`
    // and (3e-ii) the core's `capabilities` manifest and `alerts`.
    expect([...all].sort()).toEqual([
      "adapters", "alerts", "archives", "attachments", "blobs", "block_changes", "blocks", "blocks_fts", "capabilities", "commits", "dispositions", "doc_edges", "doc_embeddings", "docs",
      "edge_transitions", "edges", "embeddings", "external_nodes", "feed", "feed_entries", "file_stats", "id_claims", "nodes", "nodes_fts",
      "pending_materializations", "properties", "repos", "resurrection_pool", "revisions", "sections", "sources", "sync_state", "tree_nodes", "workspace_settings",
    ]);
    expect(history.sort()).toEqual(["archives", "blobs", "block_changes", "commits", "dispositions", "edge_transitions", "revisions", "tree_nodes"]);
    expect(semantic.sort()).toEqual(["doc_embeddings", "embeddings"]);
  });

  it("spec/store/archive.sql is the embedded segment DDL, byte for byte (README §3.3, 15.0)", () => {
    expect(readFileSync(join(SPEC_DIR, "archive.sql"), "utf8")).toBe(ARCHIVE_DDL);
  });

  it("spec/store/VERSION's major is the schema version (README 'Versioning')", () => {
    const version = readFileSync(join(SPEC_DIR, "VERSION"), "utf8").trim();
    expect(version).toMatch(/^\d+\.\d+$/);
    expect(Number(version.split(".")[0])).toBe(SCHEMA_VERSION);
  });

  it("fixture files are well-formed", () => {
    expect(problems).toEqual([]);
  });

  it("every case file was loaded and case ids are unique", () => {
    expect(files.length).toBeGreaterThan(0);
    expect([...loaded.keys()]).toEqual(files);
    const ids = new Set<string>();
    for (const [file, fixture] of loaded) {
      const stem = stemOf(file);
      for (const c of fixture.cases) {
        const id = `${stem}::${c.name}`;
        expect(ids.has(id), `duplicate case id ${id}`).toBe(false);
        ids.add(id);
      }
    }
  });

  it("the schema fingerprint carries the schema version", () => {
    const schema = loaded.get("schema.json");
    expect(schema, "missing schema.json — run STORE_SPEC_UPDATE=1").toBeDefined();
    expect((schema!.cases[0] as SchemaCase).expect.user_version).toBe(SCHEMA_VERSION);
  });

  for (const [file, fixture] of loaded) {
    const stem = stemOf(file);
    describe(stem, () => {
      for (const c of fixture.cases) {
        it(`${stem}::${c.name}`, () => runCase(stem, c));
      }
    });
  }
});
