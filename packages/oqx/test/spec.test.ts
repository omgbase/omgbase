// The OQX spec conformance runner: executes every fixture under spec/oqx/cases
// against the reference implementation. The fixture format, canonicalization
// rules, and what may appear in a fixture are defined in spec/oqx/README.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseString, parseTemplate } from "../src/parser.ts";
import { run, OqxError } from "../src/index.ts";
import type { OqxResult, Query } from "../src/index.ts";

const CASES_DIR = join(import.meta.dirname, "../../../spec/oqx/cases");

// ---- fixture shape -----------------------------------------------------------

interface SpecError { stage: "lex" | "parse" | "eval"; includes?: string[] }
interface SpecCase {
  name: string;
  tags?: string[];
  notes?: string;
  roots?: Record<string, unknown>;
  query?: string;
  template?: { strings: string[]; values: unknown[] };
  expect: { result?: unknown; error?: SpecError };
}
interface SpecFile { suite: string; cases: SpecCase[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate a parsed fixture file, returning the problems found (empty = valid). */
function validate(file: string, doc: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(doc)) return [`${file}: not an object`];
  if (typeof doc.suite !== "string" || doc.suite === "") problems.push(`${file}: missing \`suite\``);
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) return [...problems, `${file}: \`cases\` must be a non-empty array`];
  const seen = new Set<string>();
  doc.cases.forEach((c: unknown, i: number) => {
    const at = `${file}#${i}`;
    if (!isRecord(c)) { problems.push(`${at}: not an object`); return; }
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name '${c.name}'`);
    else seen.add(c.name);
    const hasQuery = typeof c.query === "string";
    const hasTemplate = isRecord(c.template);
    if (hasQuery === hasTemplate) problems.push(`${at}: exactly one of \`query\` / \`template\` is required`);
    if (hasTemplate) {
      const t = c.template as Record<string, unknown>;
      if (!Array.isArray(t.strings) || !Array.isArray(t.values) || t.strings.length !== t.values.length + 1) {
        problems.push(`${at}: \`template.strings\` must have one more element than \`template.values\``);
      }
    }
    if (c.roots !== undefined && !isRecord(c.roots)) problems.push(`${at}: \`roots\` must be an object`);
    if (!isRecord(c.expect)) { problems.push(`${at}: missing \`expect\``); return; }
    const hasResult = "result" in c.expect;
    const hasError = "error" in c.expect;
    if (hasResult === hasError) problems.push(`${at}: \`expect\` needs exactly one of \`result\` / \`error\``);
    if (hasError) {
      const e = c.expect.error;
      if (!isRecord(e) || !["lex", "parse", "eval"].includes(e.stage as string)) problems.push(`${at}: \`expect.error.stage\` must be lex | parse | eval`);
      else if (e.includes !== undefined && (!Array.isArray(e.includes) || !e.includes.every((s) => typeof s === "string"))) {
        problems.push(`${at}: \`expect.error.includes\` must be an array of strings`);
      }
    }
  });
  return problems;
}

// ---- result canonicalization -------------------------------------------------

// Fail loudly on a value the spec forbids in a result: JSON.stringify would turn
// NaN / ±Infinity into null and a fixture could pass by accident.
function assertFinite(v: unknown, path: string): void {
  if (typeof v === "number") {
    assert.ok(Number.isFinite(v), `non-finite number ${v} at ${path} — a spec bug (see README: result canonicalization)`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => assertFinite(x, `${path}[${i}]`));
  } else if (isRecord(v)) {
    for (const k of Object.keys(v)) assertFinite(v[k], `${path}.${k}`);
  }
}

/** JSON round trip (drops undefined properties, nulls undefined elements, -0 → 0),
 * with a top-level undefined becoming null as the README specifies. */
function canonicalize(v: unknown): unknown {
  if (v === undefined) return null;
  assertFinite(v, "$");
  return JSON.parse(JSON.stringify(v)) as unknown;
}

/** Recursively rebuild objects with sorted keys so deepStrictEqual ignores key order. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

// The consumer-shaped value of a result — the same unwrap `oqx` / `execute` apply.
function unwrap(result: OqxResult): unknown {
  switch (result.consumer) {
    case "collect": return result.rows;
    case "exists": return result.exists;
    case "none": return result.none;
    case "count": return result.count;
    case "first": case "single": return result.row;
  }
}

// ---- execution ---------------------------------------------------------------

function execute(c: SpecCase): unknown {
  let query: Query;
  let values: unknown[] = [];
  if (c.template) {
    values = c.template.values;
    query = parseTemplate(c.template.strings, values.length);
  } else {
    query = parseString(c.query!);
  }
  return unwrap(run(query, { values, roots: c.roots ?? {} }));
}

function runCase(c: SpecCase): void {
  if (c.expect.error) {
    const want = c.expect.error;
    let thrown: unknown = null;
    try {
      execute(c);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown !== null, "expected an OqxError, but the query succeeded");
    assert.ok(thrown instanceof OqxError, `expected an OqxError, got ${String(thrown)}`);
    assert.equal(thrown.stage, want.stage, `stage: ${thrown.message}`);
    for (const frag of want.includes ?? []) {
      assert.ok(thrown.message.includes(frag), `message should include ${JSON.stringify(frag)}: ${thrown.message}`);
    }
    return;
  }
  const actual = sortKeys(canonicalize(execute(c)));
  const expected = sortKeys(c.expect.result);
  assert.deepStrictEqual(actual, expected);
}

// ---- registration ------------------------------------------------------------

const fileNames = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort();
const loaded: string[] = [];
const problems: string[] = [];

for (const file of fileNames) {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8"));
  } catch (e) {
    problems.push(`${file}: ${String(e)}`);
    continue;
  }
  const found = validate(file, doc);
  if (found.length > 0) { problems.push(...found); continue; }
  const spec = doc as SpecFile;
  loaded.push(file);
  const stem = file.replace(/\.json$/, "");
  for (const c of spec.cases) {
    test(`${stem}::${c.name}`, () => runCase(c));
  }
}

test("spec: fixture files are well-formed", () => {
  assert.deepEqual(problems, []);
});

test("spec: every case file was loaded", () => {
  assert.ok(fileNames.length > 0, `no case files found under ${CASES_DIR}`);
  assert.deepEqual(loaded, fileNames);
});
