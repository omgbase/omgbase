// The store-backed indexes behind `makeStoreContext().indexFor` (store-index.ts):
// a nested block over a root scan with a correlated or constant equality is
// answered by ONE indexed statement per probe and the root is never read whole.
// The differential suite (corpus/oqx/conformance.test.ts) proves the results do
// not change; this file proves the WORK changed — which statements ran, that the
// scan did not, that typed equality and the absent fallback hold against the
// naive engine — and that the correlated shape stays fast at a few thousand docs.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, InMemoryEngine } from "@omgbase/oqx";
import type { TraceEvent, OqxResult } from "@omgbase/oqx";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { ingestFile } from "../core/ingest.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { makeStoreContext } from "./context.js";
import { indexablePaths } from "./store-index.js";
import { oqxRun } from "./run.js";
import "../format/index.js";

const DIR = fileURLToPath(new URL("../../corpus/oqx/fixtures/alchemy/", import.meta.url));
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) { const f = join(dir, e); if (statSync(f).isDirectory()) out.push(...walk(f)); else if (e.endsWith(".md")) out.push(f); }
  return out.sort();
}

/** Every SQL text prepared on `store.db` while `fn` runs. */
function prepared(store: Store, fn: () => void): string[] {
  const db = store.db as unknown as { prepare: (sql: string) => unknown };
  const orig = db.prepare.bind(store.db);
  const seen: string[] = [];
  db.prepare = (sql: string) => { seen.push(sql.replace(/\s+/g, " ").trim()); return orig(sql); };
  try { fn(); } finally { db.prepare = orig; }
  return seen;
}

// The root-scan shape of sql/scan.ts (`SELECT ${COLS[t]} FROM ${FROM[t]} … ORDER BY`).
const SCAN = /^SELECT (d\.\*|[bne]\.\*, d\.path AS __path) FROM (docs|blocks|nodes|edges) [dbne]\b.*ORDER BY/;
const isScan = (sql: string): boolean => SCAN.test(sql) && !/= \?\s*ORDER BY|IN \(SELECT|CROSS JOIN/.test(sql);

function engineRun(store: Store, repoId: string, q: string, opts: { naive?: boolean } = {}): { result: OqxResult; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  const engine = new InMemoryEngine(makeStoreContext(store, repoId), opts.naive ? { rules: [] } : { trace: (e) => events.push(e) });
  return { result: engine.run(parse(q), []), events };
}

describe("store-backed indexes for correlated blocks over a root scan", () => {
  let store: Store, repoId: string;
  beforeAll(() => {
    store = new Store({ path: ":memory:" });
    repoId = ensureRepo(store, "alchemy", DIR);
    processCheckpoint(store, repoId, DIR, walk(DIR).map((f) => ({ path: relative(DIR, f) })));
  });
  afterAll(() => store.close());

  it("indexFor answers for a root-scan handle on an indexable path, and for nothing else", () => {
    const ctx = makeStoreContext(store, repoId);
    const repo = ctx.rootObject!();
    const docs = ctx.get(repo, "docs");
    expect(ctx.indexFor!(docs, ["$path"])?.lookupRows).toBeTypeOf("function");
    expect(ctx.indexFor!(docs, ["$path"])).toBe(ctx.indexFor!(docs, ["$path"])); // one index per (target, path)
    expect(ctx.get(repo, "docs")).toBe(docs); // one handle per target per context
    expect(ctx.indexFor!(docs, ["$id"])).toBeDefined();
    expect(ctx.indexFor!(docs, ["type"])).toBeDefined(); // a property
    expect(ctx.indexFor!(docs, ["$title"])).toBeDefined(); // the computed scalar
    expect(ctx.indexFor!(docs, ["format"])).toBeUndefined(); // a column without an index
    expect(ctx.indexFor!(docs, ["$tags"])).toBeUndefined(); // list-valued
    expect(ctx.indexFor!(docs, ["out"])).toBeUndefined(); // a relation
    expect(ctx.indexFor!(docs, ["path"])).toBeUndefined(); // reserved: the scan raises
    expect(ctx.indexFor!(docs, ["meta", "id"])).toBeUndefined(); // multi-segment
    expect(ctx.indexFor!(ctx.root("edges"), ["$dst"])).toBeDefined(); // a bare root at the root scope
    expect(ctx.indexFor!(ctx.get(repo, "edges"), ["predicate"])).toBeUndefined(); // no leading index
    expect(ctx.indexFor!(ctx.get(repo, "blocks"), ["$doc"])).toBeDefined();
    expect(ctx.indexFor!(ctx.get(repo, "nodes"), ["name"])).toBeDefined();
    // a relation's rows are an ordinary array: the engine indexes those itself
    const index = ctx.get((docs as unknown[])[0], "out");
    expect(ctx.indexFor!(index, ["$path"])).toBeUndefined();
    expect(indexablePaths("edges")).toEqual(["$id", "$src", "$dst", "$path", "$dst_path"]);
  });

  it("a correlated block over ^docs probes SQLite per outer row and never runs the docs scan", () => {
    const q = 'select $path, same_type: ^docs collect { $path values where type == ^type && $path != ^$path } from docs';
    let out!: { result: OqxResult; events: TraceEvent[] };
    const sql = prepared(store, () => { out = engineRun(store, repoId, q); });
    const rows = out.result.consumer === "collect" ? out.result.rows : [];
    expect(rows.length).toBeGreaterThan(10);
    // every outer row was answered by a direct lookup (no index built, no bucket probe)
    const lookups = out.events.filter((e) => e.kind === "lookup");
    expect(lookups.length).toBe(rows.length);
    expect(lookups.every((e) => e.kind === "lookup" && e.path[0] === "type")).toBe(true);
    expect(out.events.filter((e) => e.kind === "index" || e.kind === "probe" || e.kind === "fallback")).toEqual([]);
    // the top-level `from docs` scanned docs ONCE; the nested `^docs` never did
    const scans = sql.filter(isScan);
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatch(/^SELECT d\.\* FROM docs d\b/);
    // the probe statement is the indexed property lookup, prepared once (cached per index)
    const probes = sql.filter((s) => /FROM properties p CROSS JOIN docs d ON d\.doc_id = p\.doc_id WHERE p\.repo_id = \? AND p\.key = \? AND p\.type = 'string' AND p\.val_text = \?/.test(s));
    expect(probes).toHaveLength(1);
    // substances see the other four substances, in (path, id) order
    const salt = rows.find((r) => (r as { $path: string }).$path === "/substances/salt.md") as { same_type: string[] };
    expect(salt.same_type).toEqual(["/substances/mercury.md", "/substances/philosophers-stone.md", "/substances/prima-materia.md", "/substances/sulphur.md"]);
    // and the whole thing equals the naive engine
    expect(out.result).toEqual(engineRun(store, repoId, q, { naive: true }).result);
  });

  it("an edges-target correlated block is answered from idx_edges_dst; blocks from idx_blocks_doc; nodes from idx_nodes_kind", () => {
    const cases: [string, RegExp][] = [
      ['select $path, inbound: ^edges collect { $src values where $dst == ^$id } from docs', /e\.dst_node = \? ORDER BY/],
      ['select $id, paragraphs: ^blocks collect { $ordinal values where $doc == ^$doc && type == "paragraph" } from blocks where type == "heading"', /b\.doc_id = \? ORDER BY/],
      ['select name, same_kind: ^nodes collect { name values where kind == ^kind && $doc_id == ^$doc_id } from nodes where kind == "md:section"', /n\.kind = \? ORDER BY/],
    ];
    for (const [q, probe] of cases) {
      let out!: { result: OqxResult; events: TraceEvent[] };
      const sql = prepared(store, () => { out = engineRun(store, repoId, q); });
      expect(sql.filter(isScan), q).toHaveLength(1); // the top-level source only
      expect(sql.some((s) => probe.test(s)), q).toBe(true);
      expect(out.events.filter((e) => e.kind === "lookup").length, q).toBeGreaterThan(0);
      expect(out.events.filter((e) => e.kind === "index" || e.kind === "fallback"), q).toEqual([]);
      expect(out.result, q).toEqual(engineRun(store, repoId, q, { naive: true }).result);
    }
  });

  it("typed equality: a number probe reaches val_num, a string val_text, a boolean val_bool; other kinds match nothing", () => {
    const ctx = makeStoreContext(store, repoId);
    const docs = ctx.get(ctx.rootObject!(), "docs");
    const era = ctx.indexFor!(docs, ["era"])!;
    const paths = (rows: Iterable<unknown>): unknown[] => Array.from(rows, (r) => ctx.get(r, "$path"));
    expect(paths(era.lookupRows!(800))).toEqual(["/practitioners/jabir-ibn-hayyan.md", "/texts/emerald-tablet.md"]);
    expect(paths(era.lookupRows!(-0))).toEqual([]);
    expect(paths(era.lookupRows!("800"))).toEqual([]); // §5: a string never equals a number
    expect(paths(era.lookupRows!(NaN))).toEqual([]);
    expect(paths(era.lookupRows!(true))).toEqual([]);
    expect(paths(era.lookupRows!({}))).toEqual([]);
    const type = ctx.indexFor!(docs, ["type"])!;
    expect(paths(type.lookupRows!("text"))).toEqual(["/texts/emerald-tablet.md", "/texts/mutus-liber.md"]);
    expect(paths(type.lookupRows!(1))).toEqual([]);
    // a column probe: only strings — and for `$path` only the reference form
    // (spec/surface §1 "Paths"): `$path` reads `/index.md`, so a bare probe equals no row
    const path = ctx.indexFor!(docs, ["$path"])!;
    expect(paths(path.lookupRows!("/index.md"))).toEqual(["/index.md"]);
    expect(paths(path.lookupRows!("index.md"))).toEqual([]);
    expect(paths(path.lookupRows!(5))).toEqual([]);
    // the absent probe is the fallback: the documents LACKING the key (and null scalars)
    const all = Array.from(ctx.toRows(docs));
    const lacking = paths(all.filter((r) => ctx.get(r, "era") == null));
    expect(lacking.length).toBeGreaterThan(5);
    const scan = prepared(store, () => {
      expect(paths(era.lookupRows!(null))).toEqual(lacking);
      expect(paths(era.lookupRows!(undefined))).toEqual(lacking);
    });
    expect(scan.filter(isScan)).toHaveLength(0); // the handle was already read above; the fallback reuses it
    // `lookup` (positions) agrees with `lookupRows`
    expect(era.lookup(800).map((i) => ctx.get(all[i], "$path"))).toEqual(paths(era.lookupRows!(800)));
    expect(type.lookup("nope")).toEqual([]);
  });

  it("the runner path: planned and in-memory agree and the in-memory run uses the indexes", () => {
    const q = 'select $path, cited: ^docs collect { $path where doc.out exists { where $path == ^^$path } } from docs where type == "substance"';
    const planned = oqxRun(store, repoId, q, { limit: 100 });
    const memory = oqxRun(store, repoId, q, { limit: 100, plan: false });
    expect(planned).toEqual(memory);
    expect(planned.hits.length).toBe(5);
    // this shape is NOT index-answerable (the inner block's receiver is a per-row
    // relation), but `^docs` is now ONE handle per run: the top-level
    // `from docs` and the nested receiver share a single SELECT (was one per outer row)
    const sql = prepared(store, () => { oqxRun(store, repoId, q, { limit: 100, plan: false }); });
    expect(sql.filter(isScan).length).toBe(1);
  });
});

describe.skipIf(!!process.env.CI)("perf: a correlated block over ~5k documents", () => {
  const N = 5000;
  let store: Store, repoId: string;
  beforeAll(() => {
    store = new Store({ path: ":memory:" });
    repoId = ensureRepo(store, "perf", "/tmp");
    const t0 = performance.now();
    store.db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const customer = i % 10 === 0;
        const body = customer
          ? `---\ntype: customer\nname: Customer ${i}\n---\n\n# Customer ${i}\n`
          : `---\ntype: order\ncustomer: /customers/c${i - (i % 10)}.md\nseq: ${i}\n---\n\n# Order ${i}\n`;
        ingestFile(store, repoId, customer ? `customers/c${i}.md` : `orders/o${i}.md`, body);
      }
    })();
    console.info(`ingested ${N} docs in ${(performance.now() - t0).toFixed(0)} ms`);
  });
  afterAll(() => store.close());

  it("orders per customer: 500 outer rows × 4,500 candidates in well under a second (indexed probe, no scan)", () => {
    const q = 'select name, orders: ^docs collect { $path where type == "order" && customer == ^$path } from docs where type == "customer"';
    let out!: { result: OqxResult; events: TraceEvent[] };
    const t0 = performance.now();
    const sql = prepared(store, () => { out = engineRun(store, repoId, q); });
    const ms = performance.now() - t0;
    const rows = out.result.consumer === "collect" ? out.result.rows : [];
    expect(rows).toHaveLength(N / 10);
    expect((rows[0] as { orders: unknown[] }).orders).toHaveLength(9);
    expect(sql.filter(isScan)).toHaveLength(1); // the top-level `from docs` only
    expect(out.events.filter((e) => e.kind === "lookup")).toHaveLength(N / 10);
    expect(out.events.filter((e) => e.kind === "lookup" && e.path[0] === "customer")).toHaveLength(N / 10);
    console.info(`correlated probe over ${N} docs: ${ms.toFixed(0)} ms (${rows.length} probes)`);
    expect(ms).toBeLessThan(3000);
  });
});
