import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The dependency-direction check of the modular-core program (Phase 1 gate,
// docs/modular-core/README.md §5 "Dependency-direction check"): the
// current-state layers — `core/**` (except `core/capabilities/**`, the seam),
// `mutate/**`, `sync/**`, `oqx-js/**`, `reconcile/**` — import nothing from the
// concrete HISTORY modules (`graph/history.ts`, `core/store/{archive,retention,
// delta}.ts`) or the concrete SEMANTIC modules (`search/{embeddings,vector,
// tasks,drain}.ts`, `search/cel/**`); they reach them through the capability
// interfaces. Only the composition layer (`mcp/server.ts`, `index.ts`, the CLI
// package) and the capability implementations may import them.
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
const SEAM_DIR = "core/capabilities";
const HISTORY_MODULES = ["graph/history.ts", "core/store/archive.ts", "core/store/retention.ts", "core/store/delta.ts"];
const SEMANTIC_MODULES = ["search/embeddings.ts", "search/vector.ts", "search/tasks.ts", "search/drain.ts"];
const SEMANTIC_DIRS = ["search/cel"];

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

function isRestrictedTarget(file: string): boolean {
  return HISTORY_MODULES.includes(file) || SEMANTIC_MODULES.includes(file) || SEMANTIC_DIRS.some((d) => file.startsWith(`${d}/`));
}

function isRestrictedImporter(file: string): boolean {
  if (isTest(file) || file.startsWith(`${SEAM_DIR}/`) || isRestrictedTarget(file)) return false;
  return RESTRICTED_IMPORTERS.some((d) => file.startsWith(`${d}/`));
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
    if (!isRestrictedImporter(from)) continue;
    for (const to of importsOf(abs)) if (isRestrictedTarget(to)) edges.push({ from, to });
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
    for (const m of [...HISTORY_MODULES, ...SEMANTIC_MODULES.filter((m) => m !== "search/drain.ts")]) expect(reached, `core/capabilities should implement over ${m}`).toContain(m);
  });

  it("the dead CEL filter compiler is gone (D9) and nothing imports search/cel/ outside its own tests", () => {
    const files = walk(SRC).map(rel);
    expect(files).not.toContain("search/cel/compile.ts");
    const importers = files.filter((f) => !isTest(f) && !f.startsWith("search/cel/")).filter((f) => importsOf(join(SRC, f)).some((t) => t.startsWith("search/cel/")));
    expect(importers).toEqual([]);
  });
});
