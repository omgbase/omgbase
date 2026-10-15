// Post-build fixup: `tsc --rewriteRelativeImportExtensions` rewrites relative
// `.ts` import specifiers to `.js` in emitted JS, but leaves them as `.ts` in
// the type-only import/export specifiers of the emitted `.d.ts` (a known gap).
// Consumers resolving under `module: NodeNext` reject those `.ts` specifiers
// (TS5097), so rewrite them to `.js` here. Idempotent.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;

// Rewrite `./x.ts` / `../x.ts` in `from "…"`, `import "…"`, and `import("…")`.
const REL_TS = /(from\s+|import\s*\(?\s*)(['"])(\.\.?\/[^'"]*?)\.ts\2/g;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".d.ts")) {
      const src = readFileSync(p, "utf8");
      const out = src.replace(REL_TS, (_m, pre, q, spec) => `${pre}${q}${spec}.js${q}`);
      if (out !== src) writeFileSync(p, out);
    }
  }
}

walk(DIST);
