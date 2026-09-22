// Differential conformance (ADR-013): every query must return the SAME result
// whether run through the tier-3 SQLite pushdown planner or the pure in-memory
// engine. This is the guardrail that lets the planner push work into SQL — any
// divergence (a mistranslated predicate, a params-order bug) fails here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { processCheckpoint } from "../../src/sync/checkpoint.js";
import { oqxRun } from "../../src/oqx/run.js";
import "../../src/format/index.js";

const DIR = fileURLToPath(new URL("./fixtures/alchemy/", import.meta.url));
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) { const f = join(dir, e); if (statSync(f).isDirectory()) out.push(...walk(f)); else if (e.endsWith(".md")) out.push(f); }
  return out.sort();
}
let store: Store, repoId: string;
beforeAll(() => { store = new Store({ path: ":memory:" }); repoId = ensureRepo(store, "alchemy", DIR); processCheckpoint(store, repoId, DIR, walk(DIR).map((f) => ({ path: relative(DIR, f) }))); });
afterAll(() => store.close());

// Queries spanning the surface: pushable scalar leaves ($path ==/startsWith),
// non-pushable (bare props, nested ops), every consumer, order by, follow,
// distinct, correlation, and each target. Each must agree planned vs in-memory.
const QUERIES: string[] = [
  // pushable $path predicates (the planner reduces the scan in SQL)
  'from docs where $path == "index.md"',
  'from docs where $path.startsWith("substances/")',
  'from docs where $path.startsWith("substances/") && $path.endsWith("mercury.md")',
  'from docs where $path != "index.md"',
  'from blocks where $path.startsWith("lab/")',
  'from nodes where $path.startsWith("processes/")',
  'from edges where $path.startsWith("index")',
  // pushable composed with a non-pushable residual (mixed)
  'from docs where $path.startsWith("substances/") && "substance" in list(tags)',
  'from docs where $path.startsWith("processes/") && nodes exists { where kind == "md:task" }',
  // non-pushable (falls fully to in-memory)
  'from docs where type == "substance"',
  'from docs where layer == "canon"',
  'from docs where era < 1000',
  // range membership (declined by the planner → in-memory both ways, must agree)
  'from docs where era in 800..1680',
  'from docs where era in 800...1680',
  'from docs where era in 1600..',
  'from docs where era in ..300',
  'from docs where era in 1600..1700 && type == "practitioner"', // mixed: type pushed to SQL, range left residual
  // range-VALUED frontmatter (window: ISO-date range, stage_range: numeric range)
  'from docs where "2026-01-15" in range(window)', // range() coerces → residual, in-memory both ways
  'from docs where 2 in range(stage_range)',
  'from docs where window == "2026-01-01..2026-01-31"', // a bare range-valued prop is a plain string → pushable, agrees
  'from docs where stage_range == "1..4"',
  'from docs where !verified',
  'from docs where nodes exists { where kind == "md:task" && !attrs.checked }',
  'from blocks where type == "task" && doc.type == "lab-note"',
  'from nodes where kind == "md:section"',
  'from docs where format == "markdown"',          // a docs COLUMN, not a property
  'from nodes where kind == "md:task" && attrs.checked == true',   // boolean param → 1/0
  'from nodes where kind == "md:task" && attrs.checked == false',
  // flattened attrs: a bare identifier reads attrs.<key> on nodes/blocks; planned
  // (json_extract) must equal in-memory for the SAME queries the attrs.<k> form covers
  'from nodes where kind == "md:task" && checked == true',
  'from nodes where kind == "md:task" && checked == false',
  'from nodes where kind == "md:task" && !checked',
  'from blocks where type == "task" && checked == false',
  'from nodes where kind == "md:section" && level == 1',
  'from docs where nodes exists { where kind == "md:task" && !checked }',
  'from nodes where kind == "md:task" && checked == false select $path, checked',
  // consumers
  '$repo.docs count { where $path.startsWith("substances/") }',
  '$repo.docs exists { where $path == "index.md" }',
  '$repo.docs first { where type == "practitioner" order by era desc }',
  'from docs where type == "substance" select $path, layer',
  // order by + pagination surface
  'from docs where type == "practitioner" order by era asc',
  'from docs order by $path',
  // distinct
  'from docs select distinct type',
  'from docs where $path == "processes/magnum-opus.md" select k: nodes collect distinct { select kind }',
  'from docs where nodes count distinct { select kind } == 3',
  // values / $value (top-level values is shaped by the runner; nested by the engine)
  'from docs where type == "practitioner" select era values order by era asc',
  'from docs select distinct type values',
  '$repo.docs first { where type == "practitioner" select $path values order by era desc }',
  'from docs where type == "substance" select tags: tags collect { $value values where $value != "substance" }',
  'from docs where tags exists { where $value == "tria-prima" }',
  // follow (planner declines → in-memory both ways, still must agree)
  'from docs where $path == "substances/philosophers-stone.md" follow distinct doc.out',
  'from nodes where kind == "md:section" && name == "The magnum opus" select n: name, d: $depth follow section.children',
  // correlation / lifts
  'from docs where type == "substance" && $repo.nodes exists { where kind == "md:wikilink" && value == ^slug } select slug',
  'from docs where nodes collect { ^open: value where kind == "md:task" && !attrs.checked } select $path, open',
  // edges target
  'from edges where predicate == "references" select $src, $dst_path',
];

describe("OQX differential conformance — planned == in-memory", () => {
  for (const q of QUERIES) {
    it(q, () => {
      const planned = oqxRun(store, repoId, q, { limit: 100 });
      const memory = oqxRun(store, repoId, q, { limit: 100, plan: false });
      expect(planned).toEqual(memory);
    });
  }

  it("agrees across a paginated sweep (cursor continuity)", () => {
    // walk the whole docs set in pages of 5, both ways, comparing each page.
    let curP: string | null = null, curM: string | null = null;
    for (let i = 0; i < 6; i++) {
      const p = oqxRun(store, repoId, "from docs", { limit: 5, ...(curP ? { cursor: curP } : {}) });
      const m = oqxRun(store, repoId, "from docs", { limit: 5, plan: false, ...(curM ? { cursor: curM } : {}) });
      expect(p).toEqual(m);
      curP = p.cursor; curM = m.cursor;
      if (!curP) break;
    }
  });
});
