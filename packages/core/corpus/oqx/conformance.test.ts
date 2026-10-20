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
import { ingestFile } from "../../src/core/ingest.js";
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

// Queries spanning the surface: pushable scalar leaves (path ==/startsWith),
// non-pushable (bare props, nested ops), every consumer, order by, follow,
// distinct, correlation, and each target. Each must agree planned vs in-memory.
const QUERIES: string[] = [
  // pushable path predicates (the planner reduces the scan in SQL)
  'from docs where _path == "index.md"',
  'from docs where _path.startsWith("substances/")',
  'from docs where _path.startsWith("substances/") && _path.endsWith("mercury.md")',
  'from docs where _path != "index.md"',
  'from blocks where _path.startsWith("lab/")',
  'from nodes where _path.startsWith("processes/")',
  'from links where _path.startsWith("index")',
  // pushable composed with a non-pushable residual (mixed)
  'from docs where _path.startsWith("substances/") && "substance" in list(_tags)',
  'from docs where _path.startsWith("processes/") && _nodes exists { where _kind == "md:task" }',
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
  'from docs where _nodes exists { where _kind == "md:task" && !_attrs.checked }',
  'from blocks where _type == "task" && _doc.type == "lab-note"',
  'from nodes where _kind == "md:section"',
  'from docs where _format == "markdown"',          // a docs COLUMN, not a property
  'from nodes where _kind == "md:task" && _attrs.checked == true',   // boolean param → 1/0
  'from nodes where _kind == "md:task" && _attrs.checked == false',
  // flattened attrs: a bare identifier reads attrs.<key> on nodes/blocks; planned
  // (json_extract) must equal in-memory for the SAME queries the attrs.<k> form covers
  'from nodes where _kind == "md:task" && checked == true',
  'from nodes where _kind == "md:task" && checked == false',
  'from nodes where _kind == "md:task" && !checked',
  'from blocks where _type == "task" && checked == false',
  'from nodes where _kind == "md:section" && level == 1',
  'from docs where _nodes exists { where _kind == "md:task" && !checked }',
  'select _path, checked from nodes where _kind == "md:task" && checked == false',
  // consumers
  'docs count { where _path.startsWith("substances/") }',
  'docs exists { where _path == "index.md" }',
  'docs first { where type == "practitioner" order by era desc }',
  'select _path, layer from docs where type == "substance"',
  // order by + pagination surface
  'from docs where type == "practitioner" order by era asc',
  'from docs order by _path',
  // distinct
  'select distinct type from docs',
  'select k: _nodes collect distinct { select _kind } from docs where _path == "processes/magnum-opus.md"',
  'from docs where _nodes count distinct { select _kind } == 3',
  // values / $it (top-level values is shaped by the runner; nested by the engine)
  'select era values from docs where type == "practitioner" order by era asc',
  'select distinct type values from docs',
  'docs first { select _path values where type == "practitioner" order by era desc }',
  'select tags: _tags collect { $it values where $it != "substance" } from docs where type == "substance"',
  'from docs where _tags exists { where $it == "tria-prima" }',
  // none / limit / offset (top-level bounds are applied by the runner, nested by the engine)
  'from docs where type == "substance" && _nodes none { where _kind == "md:task" }',
  'docs none { where type == "nope" }',
  'from docs where type == "practitioner" order by era desc limit 2',
  'from docs where type == "practitioner" order by era desc limit 2 offset 1',
  'select distinct type values from docs limit 2',
  'from docs where _nodes exists { where _kind == "md:task" offset 3 }',
  'docs first { select _path values where type == "practitioner" order by era asc offset 1 }',
  // entries() / $key (a free call → residual; the store context materializes frontmatter/inline)
  'select fm: entries(_frontmatter) collect { k: $key, v: $it } from docs where _path == "substances/salt.md"',
  'from docs where entries(_frontmatter) exists { where $key == "era" && $it > 1600 }',
  'select ks: entries(_inline) collect { $key values } from docs where entries(_inline) exists { }',
  'select _path from nodes where _kind == "md:task" && entries(_attrs) exists { where $key == "checked" && $it }',
  'select h: _nodes collect { select _name values where _kind == "md:section" order by first_ordinal limit 2 } from docs where _path == "processes/magnum-opus.md"',
  // follow (planner declines → in-memory both ways, still must agree)
  'from docs where _path == "substances/philosophers-stone.md" follow distinct _out_links collect { from _dst }',
  'select n: _name, d: $depth from nodes where _kind == "md:section" && _name == "The magnum opus" follow $it._children',
  // correlation / lifts
  'select slug from docs where type == "substance" && ^nodes exists { where _kind == "md:wikilink" && _value == ^slug }',
  'select _path, open from docs where _nodes collect { ^open: _value where _kind == "md:task" && !_attrs.checked }',
  // links target
  'select _doc_id, _dst_path from links where _predicate == "references"',
  // nested blocks over a ROOT SCAN with a correlated / constant equality: the
  // store answers these from SQLite indexes (oqx-js/store-index.ts) instead of
  // materializing `^<target>` — results must not move an inch
  'select _path, cited: ^docs collect { _path where _out_links exists { where _dst_path == ^^_path } } from docs',
  'select name, orders: ^docs collect { _path where type == "order" && customer == ^_path } from docs where type == "customer"',
  'from docs where _path == "index.md" follow _out_links collect { from _dst }, ^docs collect { where after.contains(^_path) }',
  'select _path, same_type: ^docs collect { _path where type == ^type && _path != ^_path } from docs',
  'select _path, same_era: ^docs collect { _path where era == ^era } from docs where type == "practitioner"',
  'select _path, same_layer: ^docs collect { _path values where layer == ^layer } from docs',
  'from docs where ^docs count { where layer == ^layer } > 3',
  'from docs where ^docs exists { where _title == ^_title && _id != ^_id }',
  'select _path, by_title: ^docs collect { _path values where _title == ^_title } from docs where type == "process"',
  'select _path, self: ^docs first { _path values where _path == ^_path } from docs',
  'select _path, by_id: ^docs single { _path values where _id == ^_id } from docs where type == "substance"',
  // mixed value kinds on one property: a number probe against a string property
  // (and the reverse) matches nothing; an absent probe matches the documents
  // lacking the key (the in-memory fallback)
  'select _path, s: ^docs collect { _path where slug == ^era } from docs where type == "practitioner"',
  'select _path, e: ^docs collect { _path where era == ^slug } from docs where type == "substance"',
  'from docs where ^docs none { where era == ^type }',
  'select _path, no_era: ^docs collect { _path values where era == ^nope } from docs where _path == "index.md"',
  'select _path, no_slug: ^docs collect { _path where slug == null } from docs where type == "text"',
  'select _path, l: ^docs collect { _path values where _tags == ^_tags } from docs',
  'select _path, l: ^docs collect { _path values where layer == ^_tags } from docs',
  // the other targets as receivers: a links-target correlated block, blocks by doc_id, nodes by kind
  'select _path, inbound: ^links collect { _doc_id where _dst_id == ^_id } from docs',
  'select _path, outbound: ^links collect { _dst_path values where _path == ^_path } from docs',
  'from docs where ^links count { where _path == ^_path } > 2',
  'select _doc_id, same_dst: ^links collect { _doc_id values where _dst_path == ^_dst_path && _id != ^_id } from links where _predicate == "references"',
  'select _id, paragraphs: ^blocks collect { _ordinal values where _doc_id == ^_doc_id && _type == "paragraph" } from blocks where _type == "heading"',
  'from blocks where _type == "heading" && ^blocks count { where _doc_id == ^_doc_id && _type == "paragraph" } > 3',
  'from nodes where _kind == "md:section" && ^nodes count { where _kind == ^_kind } > 10',
  'select _name, same_kind: ^nodes collect { _name values where _kind == ^_kind && _doc_id == ^_doc_id } from nodes where _kind == "md:section"',
  'select _path, by_name: ^nodes collect { _id where _name == ^_name } from nodes where _kind == "md:section" && _name == "Preparation"',
  'select _path, nameless: ^nodes collect { _kind values where _name == ^nope } from nodes where _kind == "md:section" && _name == "Preparation"',
  // group by (oqx 0.24): the planner declines a grouped query whole (even with a
  // pushable `where`), so both paths run in memory — and must still agree
  'select layer, n: count() from docs group by layer order by count() desc, layer',
  'select layer, n: count(), eras: collect(era) from docs where _path.startsWith("practitioners/") group by layer',
  'select type, open: rows count { where _nodes exists { where _kind == "md:task" and not _attrs.checked } } from docs group by type having count() > 1 order by type',
  'select _path, done: rows count { where checked }, all: count() from blocks where _type == "task" group by _path order by _path',
  'docs count { group by layer }',
  'select _kind values from nodes group by _kind order by _kind',
  // flatten (oqx 0.25): declined whole as well — the fan-out runs in memory on both paths
  'select _path, _tags from docs where type == "process" flatten _tags order by _path, _tags',
  'select _path, t: b._text from docs where layer == "canon" flatten _blocks { where _type == "task" and not checked } as b order by _path, t',
  'select _tags, n: count() from docs where has(_tags) flatten _tags group by _tags order by count() desc, _tags',
];

describe("OQX differential conformance — planned == in-memory", () => {
  for (const q of QUERIES) {
    it(q, () => {
      const planned = oqxRun(store, repoId, q, { limit: 100 });
      const memory = oqxRun(store, repoId, q, { limit: 100, plan: false });
      expect(planned).toEqual(memory);
    });
  }

  // spec/properties §3.4 (1.2): a yaml/json document's top-level mapping is its
  // frontmatter — the same `properties` rows the planner already pushes down —
  // so a bare-key predicate over a YAML file must plan to the same answer the
  // in-memory engine gives. A separate store: the alchemy corpus is Markdown only.
  describe("yaml/json documents (spec/properties §3.4)", () => {
    let yj: Store, yjRepo: string;
    beforeAll(() => {
      yj = new Store({ path: ":memory:" });
      yjRepo = ensureRepo(yj, "yj", null);
      ingestFile(yj, yjRepo, "attn/focus.yaml", "focused_intent: /notes/plan.md\nsince: 2026-10-17\ntitle: Focus\ntags: [attn, now]\nmeta:\n  owner: bb\nn: 3\n");
      ingestFile(yj, yjRepo, "config.json", "{\"name\": \"attn\", \"version\": 2, \"features\": {\"focus\": true}, \"n\": 3}\n");
      ingestFile(yj, yjRepo, "attn/list.yaml", "- a\n- b\n");
      ingestFile(yj, yjRepo, "notes/plan.md", "---\nn: 3\n---\n\n# Plan\n\nThe plan.\n");
      ingestFile(yj, yjRepo, "notes/other.md", "# Other\n\nNot focused.\n");
    });
    afterAll(() => yj.close());
    const YJ_QUERIES = [
      'from docs where focused_intent == "/notes/plan.md"',
      'select focused_intent, since from docs where _path == "/attn/focus.yaml"',
      'from docs where name == "attn" and version == 2',
      'from docs where n == 3 order by _path',
      'from docs where n == 3 and _format != "markdown" order by _path',
      'select _path, o: _data.meta.owner, f: _frontmatter.title, t: _title, tg: _tags from docs where _format == "yaml" order by _path',
      'select _path from docs where _format == "markdown" and ^docs exists { where _path == "/attn/focus.yaml" and focused_intent == ^_path }',
      'select _path, focused: ^docs count { where _path == "/attn/focus.yaml" and focused_intent == ^_path } from docs where _format == "markdown" order by _path',
      'select e: entries(_frontmatter) collect { k: $key, v: $it } from docs where _path == "/config.json"',
      'from docs where entries(_frontmatter) exists { where $key == "version" && $it > 1 }',
      'select _path from docs where entries(_frontmatter) none { } order by _path',
      'from docs where "attn" in list(_tags)',
    ];
    for (const q of YJ_QUERIES) {
      it(q, () => {
        const planned = oqxRun(yj, yjRepo, q, { limit: 100 });
        const memory = oqxRun(yj, yjRepo, q, { limit: 100, plan: false });
        expect(planned).toEqual(memory);
      });
    }
    it("a bare key over a yaml document is answered (not empty)", () => {
      expect(oqxRun(yj, yjRepo, 'from docs where focused_intent == "/notes/plan.md"', { limit: 10 }).hits.map((h) => h._path)).toEqual(["/attn/focus.yaml"]);
    });
  });

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
