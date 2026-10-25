import { baseConfig, bannedSerializers } from "../../eslint.config.base.js";
import importAllowlist from "./src/core/capabilities/import-allowlist.json" with { type: "json" };

// core/ is the foundation: it MUST NOT import from any sibling module (07 §0).
const siblingBoundary = {
  group: ["**/reconcile/**", "**/sync/**", "**/mutate/**", "**/graph/**", "**/search/**", "**/mcp/**", "**/cli/**"],
  message: "core/ must not import from sibling modules (07 §0 boundary rule).",
};

// The dependency-direction check of the modular-core program (Phase 1,
// docs/modular-core/README.md §5): the concrete HISTORY and SEMANTIC modules
// are reached only through the capability interfaces (`src/core/capabilities/`)
// by the current-state layers — `core/**`, `mutate/**`, `sync/**`, `oqx-js/**`,
// `reconcile/**`. Only the composition layer (`mcp/server.ts`, `index.ts`, the
// CLI package) and the capability implementations import them. The files named
// in `import-allowlist.json` are the Phase 3/4 leftovers, each citing its
// inventory row; `src/dependency-direction.test.ts` checks the same list edge by
// edge and fails when an entry stops being a live import (the list only shrinks).
export const historyAndSemanticModules = [
  "**/graph/history.js",
  "**/store/archive.js",
  "**/store/retention.js",
  "**/store/delta.js",
  "**/search/embeddings.js",
  "**/search/vector.js",
  "**/search/tasks.js",
  "**/search/drain.js",
  "**/search/cel/*",
  // The same modules imported from their own directory (`core/store/size.ts` →
  // `./archive.js`): `no-restricted-imports` matches the specifier, not the
  // resolved path, so the sibling spellings are listed too. The import-graph
  // test resolves paths and is the authoritative gate.
  "./archive.js",
  "./retention.js",
  "./delta.js",
];
const capabilityBoundary = {
  group: historyAndSemanticModules,
  message: "the history/semantic modules are reached through the capability interfaces (src/core/capabilities/, docs/modular-core/README.md §5 \"Dependency-direction check\"); only the composition layer and the capability implementations import them.",
};
const allowlisted = importAllowlist.entries.map((e) => `src/${e.from}`);
const concreteHistoryModules = ["src/graph/history.ts", "src/core/store/archive.ts", "src/core/store/retention.ts", "src/core/store/delta.ts"];
const testFiles = ["src/**/*.test.ts", "src/**/*.test.helpers.ts"];

export default [
  ...baseConfig(import.meta.dirname, { files: ["src/**/*.ts", "corpus/**/*.ts"] }),
  {
    // Production code only — test files legitimately compose modules to build
    // integration fixtures. `core/capabilities/` is the one place under core/
    // that names the concrete modules (it implements the interfaces), so both
    // boundaries exempt it; the concrete history modules under core/store/ and
    // the allowlisted files get the sibling rule alone (next block).
    files: ["src/core/**/*.ts"],
    ignores: [...testFiles, "src/core/capabilities/**", ...concreteHistoryModules, ...allowlisted],
    rules: {
      "no-restricted-imports": ["error", { paths: bannedSerializers, patterns: [siblingBoundary, capabilityBoundary] }],
    },
  },
  {
    files: [...concreteHistoryModules.filter((f) => f.startsWith("src/core/")), ...allowlisted.filter((f) => f.startsWith("src/core/"))],
    ignores: testFiles,
    rules: {
      "no-restricted-imports": ["error", { paths: bannedSerializers, patterns: [siblingBoundary] }],
    },
  },
  {
    files: ["src/mutate/**/*.ts", "src/sync/**/*.ts", "src/oqx-js/**/*.ts", "src/reconcile/**/*.ts"],
    ignores: [...testFiles, ...allowlisted],
    rules: {
      "no-restricted-imports": ["error", { paths: bannedSerializers, patterns: [capabilityBoundary] }],
    },
  },
];
