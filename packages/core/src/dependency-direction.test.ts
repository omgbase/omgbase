import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The dependency-direction check of the modular-core program (Phase 1 gate,
// docs/modular-core/README.md §5 "Dependency-direction check"; Phase 2 §6): the
// current-state layers — `core/**` (except `core/capabilities/**`, the seam),
// `mutate/**`, `sync/**`, `oqx-js/**`, `reconcile/**` — import nothing from the
// concrete HISTORY modules (`graph/history.ts`, `core/store/{archive,retention,
// delta}.ts`); they reach them through the capability interfaces. The concrete
// SEMANTIC bundle is the whole of `semantic/**` (Phase 2 moved it out of
// `search/`, which keeps the lexical FTS parts and the fusion ranker) plus the
// dead `search/cel/**`, and its importer set is WIDER: `mcp/**` (the tool
// bodies), `search/**` (FTS, fusion), `graph/**` and `format/**` are free of it
// too — the engine reaches a vector only through `SemanticProvider`. Only the
// composition layer (`index.ts`, the CLI package) and the capability
// implementations may import it.
//
// The import graph is read from the sources (every `import … from "…"`,
// `export … from "…"` and bare `import "…"` of a production `.ts` file — test
// files compose modules to build fixtures and are exempt). What Phase 1 leaves
// in place is `core/capabilities/import-allowlist.json`, one entry per edge
// with its inventory row; this test fails on an edge the list does not name AND
// on a listed edge that is no longer live, so the list only shrinks. The eslint
// rule in `eslint.config.js` exempts the same files for the editor's signal.

const SRC = dirname(fileURLToPath(import.meta.url));

const RESTRICTED_IMPORTERS = ["core", "mutate", "sync", "oqx-js", "reconcile"];
/** Who must not import the semantic bundle: the history importers plus every engine layer a tool body or a lexical search runs through. */
const SEMANTIC_FREE_IMPORTERS = [...RESTRICTED_IMPORTERS, "mcp", "search", "graph", "format"];
const SEAM_DIR = "core/capabilities";
const HISTORY_MODULES = ["graph/history.ts", "core/store/archive.ts", "core/store/retention.ts", "core/store/delta.ts", "core/store/history-writers.ts", "core/store/history-gc.ts"];
/** Where SQL may name a history table (Phase 4a): the bundle, the recorder, the DDL, and the migration's backfill (`store.ts`, which reads the 16.x tables it upgrades from). */
const HISTORY_SQL_ALLOWED = [...HISTORY_MODULES, "core/capabilities/history.ts", "core/store/schema.ts", "core/store/store.ts"];
const HISTORY_TABLES = ["commits", "revisions", "blobs", "tree_nodes", "dispositions", "block_changes", "edge_transitions", "archives"];
/** The semantic modules the seam must implement over (the ones the Phase 1 list named, at their Phase 2 paths, plus the indexer). */
const SEMANTIC_MODULES = ["semantic/embeddings.ts", "semantic/vector.ts", "semantic/tasks.ts", "semantic/indexer.ts"];
const SEMANTIC_DIRS = ["semantic", "search/cel"];

interface Edge { from: string; to: string }
interface AllowlistEntry extends Edge { inventory: string; note: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const posix = (p: string): string => p.split(sep).join("/");
const rel = (abs: string): string => posix(relative(SRC, abs));

function isTest(file: string): boolean {
  return file.endsWith(".test.ts") || file.endsWith(".test.helpers.ts");
}

function isHistoryTarget(file: string): boolean {
  return HISTORY_MODULES.includes(file);
}
function isSemanticTarget(file: string): boolean {
  return SEMANTIC_DIRS.some((d) => file.startsWith(`${d}/`));
}
function isRestrictedTarget(file: string): boolean {
  return isHistoryTarget(file) || isSemanticTarget(file);
}

/** Is `from` → `to` an edge the rule forbids? History targets bind the Phase 1 importers; semantic targets the wider set. */
function isRestrictedEdge(from: string, to: string): boolean {
  if (isTest(from) || from.startsWith(`${SEAM_DIR}/`) || isRestrictedTarget(from)) return false;
  if (isHistoryTarget(to)) return RESTRICTED_IMPORTERS.some((d) => from.startsWith(`${d}/`));
  if (isSemanticTarget(to)) return SEMANTIC_FREE_IMPORTERS.some((d) => from.startsWith(`${d}/`));
  return false;
}

const SPECIFIER = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

/** The relative imports of a source file, as `src`-relative `.ts` paths (packages and bare specifiers are skipped). */
function importsOf(abs: string): string[] {
  const text = readFileSync(abs, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[1] ?? m[2];
    if (!spec || !spec.startsWith(".")) continue;
    const target = resolve(dirname(abs), spec).replace(/\.js$/, ".ts");
    out.push(rel(target));
  }
  return out;
}

/** Every production edge from a restricted importer into a restricted target. */
export function restrictedEdges(): Edge[] {
  const edges: Edge[] = [];
  for (const abs of walk(SRC)) {
    const from = rel(abs);
    for (const to of importsOf(abs)) if (isRestrictedEdge(from, to)) edges.push({ from, to });
  }
  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function allowlist(): AllowlistEntry[] {
  const raw = JSON.parse(readFileSync(join(SRC, SEAM_DIR, "import-allowlist.json"), "utf8")) as { entries: AllowlistEntry[] };
  return raw.entries;
}

const key = (e: Edge): string => `${e.from} -> ${e.to}`;

describe("dependency direction (modular-core Phase 1)", () => {
  it("the current-state layers import the history/semantic modules only through the capability seams or the allowlist", () => {
    const allowed = new Set(allowlist().map(key));
    const violations = restrictedEdges().map(key).filter((k) => !allowed.has(k));
    expect(violations, `imports the capability seams should carry (route them through core/capabilities/, or allowlist them with their inventory row):\n  ${violations.join("\n  ")}`).toEqual([]);
  });

  it("every allowlist entry is still a live import (the list only shrinks) and cites its inventory row", () => {
    const live = new Set(restrictedEdges().map(key));
    for (const e of allowlist()) {
      expect(live.has(key(e)), `${key(e)} is no longer imported — remove it from import-allowlist.json`).toBe(true);
      expect(e.inventory, `${key(e)} must cite its inventory-ts row`).toMatch(/inventory-ts §\d/);
      expect(e.note.length).toBeGreaterThan(0);
    }
  });

  it("the seam directory is the only core/ directory that imports the concrete modules", () => {
    const seamFiles = walk(join(SRC, SEAM_DIR)).filter((f) => !isTest(rel(f)));
    const reached = new Set(seamFiles.flatMap(importsOf).filter(isRestrictedTarget));
    // The default implementations wrap every concrete history module and every semantic module.
    for (const m of [...HISTORY_MODULES, ...SEMANTIC_MODULES]) expect(reached, `core/capabilities should implement over ${m}`).toContain(m);
  });

  it("the semantic bundle is reached only through the seam: no production module outside semantic/ and the seam imports it, save the composition entry", () => {
    const files = walk(SRC).map(rel).filter((f) => !isTest(f) && !isSemanticTarget(f) && !f.startsWith(`${SEAM_DIR}/`));
    const importers = files.filter((f) => importsOf(join(SRC, f)).some(isSemanticTarget));
    // `index.ts` is the package's composition surface: the CLI's `omg embed`/`omg mcp` compose the worker and the provider from it.
    expect(importers).toEqual(["index.ts"]);
  });

  it("the core's current-state tables are the only ones the engine reads outside the bundle: no SQL outside semantic/ names the vector tables", () => {
    const SQL_ON_VECTORS = /\b(FROM|INTO|UPDATE|JOIN)\s+(doc_)?embeddings\b/i;
    const offenders = walk(SRC).map(rel).filter((f) => !isTest(f) && !isSemanticTarget(f) && f !== "core/store/schema.ts")
      .filter((f) => SQL_ON_VECTORS.test(readFileSync(join(SRC, f), "utf8")));
    // `schema.ts` holds the DDL (the split is the store 17 major); `size.ts` only categorizes the names (spec/store §7.5) and `sqlite_master` walks them.
    expect(offenders).toEqual([]);
  });

  it("the core writes and reads no history table: no SQL outside the history bundle names one (Phase 4a; the Rust `tests/boundaries.rs` is the model)", () => {
    // A statement that reads or writes a history table: the table name after FROM/INTO/UPDATE/JOIN/TABLE. `schema.ts`
    // holds the DDL, `store.ts` the migration that reads the 16.x tables it upgrades from (and tolerates their absence);
    // `size.ts` only categorizes the names (spec/store §7.5) and walks `sqlite_master`; `manifest.ts` executes the
    // bundle's DDL text, which is `schema.ts`'s.
    // Case-sensitive on purpose: every statement of this codebase spells its keywords in upper case, and a comment
    // saying "re-derived from dispositions" is prose, not SQL (the Rust twin strips comments instead).
    const SQL_ON_HISTORY = new RegExp(`\\b(FROM|INTO|UPDATE|JOIN|TABLE)\\s+(${HISTORY_TABLES.join("|")})\\b`);
    const offenders = walk(SRC).map(rel).filter((f) => !isTest(f) && !HISTORY_SQL_ALLOWED.includes(f))
      .filter((f) => SQL_ON_HISTORY.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the dead CEL filter compiler is gone (D9) and nothing imports search/cel/ outside its own tests", () => {
    const files = walk(SRC).map(rel);
    expect(files).not.toContain("search/cel/compile.ts");
    const importers = files.filter((f) => !isTest(f) && !f.startsWith("search/cel/")).filter((f) => importsOf(join(SRC, f)).some((t) => t.startsWith("search/cel/")));
    expect(importers).toEqual([]);
  });
});
