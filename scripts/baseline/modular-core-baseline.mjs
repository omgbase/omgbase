#!/usr/bin/env node
// The modular-core Phase 0 baseline: one reproducible workload over a fresh
// workspace, driven through the `omg` CLI of either engine, recording what the
// store is made of (`doctor --size --json`) after every stage, the bytes the
// database grew by, and the wall-clock latency of every operation. Nothing
// here changes behaviour; it measures the engine as it is so that Phase 3–5's
// claims ("history-off eliminates this", "repeated edits do not grow that")
// are judged against numbers, not the October 13 snapshot.
//
//   node scripts/baseline/modular-core-baseline.mjs --engine rust [--docs 200] [--edits 50] [--out docs/modular-core/baseline]
//   node scripts/baseline/modular-core-baseline.mjs --engine ts
//   node scripts/baseline/modular-core-baseline.mjs --bin /path/to/omg   # any CLI that speaks the same verbs
//
// The corpus is synthetic and seeded (`--seed`), so two runs over two engines
// see byte-identical files: N documents in three folders, six frontmatter keys,
// a dozen blocks each (headings, paragraphs, a task list, links to other
// documents by rooted path), one "journal" document that the rolling-append
// workload grows. Workloads (each `--edits` times unless noted), in order:
//
//   import           init --no-embedder, source add (the initial sync)
//   frontmatter-hot  meta --set counter=<i> on one document          (the attn-style hot update)
//   block-edit       update <block> -m … on one paragraph              (repeated edits to one entity)
//   journal-append   append <heading> -m "- note <i>" on the journal   (a bounded rolling journal)
//   task-churn       done / done --undo alternating on one task
//   link-churn       meta --set-json related=[…] alternating two lists (edge churn)
//   doc-churn        rm --doc + new of the same path (edits/5 times)   (delete/recreate churn)
//   queries          20 × four read shapes                              (latency only)
//   gc               the default mark-and-sweep, then the final size     (post-maintenance growth)
//
// Every CLI call is one process: the latencies are CLI round trips (the
// process start is measured separately as `spawn-baseline` and reported, not
// subtracted). The size report is the store's own (spec/store §7.2): bytes per
// category and table from dbstat, the file, the WAL, what VACUUM would reclaim.
// Categories are read by name — the six of store 17.0 slice 3e (content,
// identity, recovery, history, search, sync); a report from an older engine
// lacks `identity`/`recovery` and those columns print empty.
// Output: `<out>/<engine>-<stamp>.json` (everything) and `.md` (the tables).

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- arguments -------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
const engine = opt("engine", "rust");
const docs = Number(opt("docs", "200"));
const edits = Number(opt("edits", "50"));
const seed = Number(opt("seed", "1"));
const out = resolve(ROOT, opt("out", "docs/modular-core/baseline"));
const keep = args.includes("--keep");
const bin = opt("bin", null);

/** The CLI as argv prefix: the Rust binary, or node + the TS CLI's main. */
function cliFor() {
  if (bin) return [bin];
  if (engine === "rust") return [resolve(ROOT, "target/debug/omgbase")];
  if (engine === "ts") return [process.execPath, resolve(ROOT, "packages/cli/dist/src/main.js")];
  throw new Error(`--engine ts|rust (got ${engine})`);
}
const CLI = cliFor();

// ---- a seeded corpus -------------------------------------------------------------------

function rng(s) { let x = s >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; }; }
const WORDS = "calcination salt sulphur mercury vessel furnace retort athanor nigredo albedo citrinitas rubedo prima materia philosopher stone tincture elixir distillation sublimation coagulation solution putrefaction fermentation projection multiplication".split(" ");
const FOLDERS = ["processes", "substances", "practitioners"];

function corpus(n, random) {
  const files = [];
  const pathOf = (i) => `/${FOLDERS[i % FOLDERS.length]}/doc-${String(i).padStart(4, "0")}.md`;
  const sentence = (k) => Array.from({ length: k }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
  for (let i = 0; i < n; i++) {
    const links = [1, 2, 3].map((d) => pathOf((i + d * 7) % n));
    const body = [
      "---",
      `title: Document ${i}`,
      `layer: ${["canon", "working", "draft"][i % 3]}`,
      `status: ${["open", "done"][i % 2]}`,
      `owner: /practitioners/doc-${String((i * 3) % n).padStart(4, "0")}.md`,
      `tags: [${sentence(2).split(" ").join(", ")}]`,
      `counter: 0`,
      "---",
      `# Document ${i}`,
      "",
      `Abstract: ${sentence(14)}.`,
      "",
      "## Procedure",
      "",
      `${sentence(12)}. See [${i + 1}](${links[0]}) and [${i + 2}](${links[1]}).`,
      "",
      `- step one: ${sentence(5)}`,
      `- step two: ${sentence(5)}`,
      `- step three: ${sentence(5)}`,
      "",
      "## Tasks",
      "",
      `- [ ] ${sentence(4)}`,
      `- [x] ${sentence(4)}`,
      `- [ ] ${sentence(4)}`,
      "",
      "## Notes",
      "",
      `> ${sentence(9)}.`,
      "",
      `${sentence(16)}. Related: [${i + 3}](${links[2]}).`,
      "",
    ].join("\n");
    files.push({ path: pathOf(i), body });
  }
  files.push({ path: "/journal/2026-10-24.md", body: "---\ntitle: Journal\nlayer: draft\n---\n# Journal\n\n## Log\n\n- 00:00 opened\n" });
  return files;
}

// ---- running the CLI -------------------------------------------------------------------

const timings = {};
function time(stage, fn) {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  (timings[stage] ??= []).push(ms);
  return r;
}

function omg(ws, argv, stage, { json = false, input } = {}) {
  const full = [...CLI.slice(1), ...(json ? ["--json"] : []), "-C", ws, ...argv];
  const run = () => spawnSync(CLI[0], full, { encoding: "utf8", input, maxBuffer: 64 << 20 });
  const r = stage ? time(stage, run) : run();
  if (r.status !== 0) throw new Error(`${argv.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}

function sizeReport(ws) {
  const r = spawnSync(CLI[0], [...CLI.slice(1), "-C", ws, "doctor", "--size", "--json"], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`doctor --size failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function dbBytes(ws) {
  const db = join(ws, ".omgbase", "omgbase.db");
  const sz = (p) => { try { return statSync(p).size; } catch { return 0; } };
  return { db: sz(db), wal: sz(`${db}-wal`) };
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1], total: s.reduce((a, b) => a + b, 0) };
};

// ---- the run -------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const tmp = mkdtempSync(join(tmpdir(), "mc-baseline-"));
const ws = join(tmp, "ws");
const src = join(tmp, "bench");
mkdirSync(src, { recursive: true });
const random = rng(seed);
const files = corpus(docs, random);
let sourceBytes = 0;
for (const f of files) {
  const p = join(src, f.path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.body);
  sourceBytes += Buffer.byteLength(f.body);
}

const stages = [];
let last = { db: 0, wal: 0 };
function snapshot(stage, extra = {}) {
  const size = sizeReport(ws);
  const bytes = dbBytes(ws);
  const grew = bytes.db + bytes.wal - (last.db + last.wal);
  last = bytes;
  const cats = Object.fromEntries(size.categories.map((c) => [c.name, { bytes: c.bytes, rows: c.rows }]));
  const tables = Object.fromEntries(size.categories.flatMap((c) => c.tables.map((t) => [t.name, { bytes: t.bytes, rows: t.rows }])));
  stages.push({ stage, ...extra, file: { db: bytes.db, wal: bytes.wal, grew }, categories: cats, tables, same_dispositions: size.same_dispositions ?? null, reclaimable: size.file.reclaimable });
  console.error(`  ${stage.padEnd(16)} db ${(bytes.db / 1e6).toFixed(2)} MB wal ${(bytes.wal / 1e6).toFixed(2)} MB  grew ${(grew / 1e3).toFixed(0)} KB  history ${(cats.history.bytes / 1e6).toFixed(2)} MB content ${(cats.content.bytes / 1e6).toFixed(2)} MB identity ${((cats.identity?.bytes ?? 0) / 1e6).toFixed(2)} MB`);
}

console.error(`engine ${engine} (${CLI.join(" ")}), ${docs} docs, ${edits} edits, seed ${seed}, workspace ${ws}`);

// spawn baseline: the process start, which every latency below includes
for (let i = 0; i < 10; i++) time("spawn-baseline", () => spawnSync(CLI[0], [...CLI.slice(1), "--version"], { encoding: "utf8" }));

// import
time("init", () => spawnSync(CLI[0], [...CLI.slice(1), "init", ws, "--yes", "--no-embedder"], { encoding: "utf8" }));
omg(ws, ["source", "add", src, "--repo", "bench", "-y"], "import");
snapshot("import", { docs: files.length, sourceBytes });

const target = files[1].path; // a document with the full shape
const journal = "/journal/2026-10-24.md";
const idOf = (q) => omg(ws, ["query", q, "-n", "1", "--ids"]).trim().split("\n")[0];
// The top-level abstract paragraph — named by its marker so both engines edit the SAME block (an unordered
// `limit 1` may land on a paragraph nested in a list item, whose edit also re-encodes the item: twice the rows).
const paragraph = idOf(`blocks { select _id where _path == ${JSON.stringify(target)} and _type == "paragraph" and _text.startsWith("Abstract:") }`);
const task = idOf(`nodes { select _block_id where _path == ${JSON.stringify(target)} and _kind == "md:task" }`);
const logHeading = idOf(`nodes { select _block_id where _path == ${JSON.stringify(journal)} and _kind == "md:section" and _name == "Log" }`);

// frontmatter hot update
for (let i = 1; i <= edits; i++) omg(ws, ["meta", target, "--set", `counter=${i}`], "frontmatter-hot");
snapshot("frontmatter-hot", { ops: edits });

// block edit
for (let i = 1; i <= edits; i++) omg(ws, ["update", paragraph, "-m", `Edited ${i}: ${Array.from({ length: 12 }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ")}.`], "block-edit");
snapshot("block-edit", { ops: edits });

// rolling journal
for (let i = 1; i <= edits; i++) omg(ws, ["append", logHeading, "-m", `- ${String(i).padStart(2, "0")}:00 note ${i} ${WORDS[i % WORDS.length]}`], "journal-append");
snapshot("journal-append", { ops: edits });

// task churn
for (let i = 1; i <= edits; i++) omg(ws, i % 2 ? ["done", task] : ["done", task, "--undo"], "task-churn");
snapshot("task-churn", { ops: edits });

// link churn
const a = JSON.stringify([files[5].path, files[9].path]);
const b = JSON.stringify([files[13].path, files[17].path, files[21].path]);
for (let i = 1; i <= edits; i++) omg(ws, ["meta", target, "--set-json", `related=${i % 2 ? a : b}`], "link-churn");
snapshot("link-churn", { ops: edits });

// delete / recreate churn
const churnDoc = files[2];
const churn = Math.max(1, Math.floor(edits / 5));
const churnBody = join(tmp, "churn-body.md");
writeFileSync(churnBody, churnDoc.body);
for (let i = 1; i <= churn; i++) {
  omg(ws, ["rm", "--doc", churnDoc.path], "doc-churn");
  omg(ws, ["new", churnDoc.path, "-f", churnBody], "doc-churn");
}
snapshot("doc-churn", { ops: churn * 2 });

// queries
const QUERIES = {
  "query-docs": `docs { select _path, _title, layer order by _path }`,
  "query-blocks-filter": `blocks { select _path, _text where _type == "paragraph" and _text.contains("salt") limit 50 }`,
  "query-text": `blocks { select _path where text("furnace") order by _path limit 50 }`,
  "query-links": `links { select _path, _dst_path where _dst_path == ${JSON.stringify(target)} }`,
};
for (let i = 0; i < 20; i++) for (const [name, q] of Object.entries(QUERIES)) omg(ws, ["query", q, "-n", "50"], name);
for (let i = 0; i < 20; i++) omg(ws, ["outline", target], "outline");

// gc and the final state (the sweep is flag-gated: enable it in the repo settings first)
omg(ws, ["config", "set", "gc.enabled", "true"]);
omg(ws, ["gc"], "gc");
snapshot("gc");

// ---- report -------------------------------------------------------------------------

const latency = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, stats(v)]));
const versions = { cli: spawnSync(CLI[0], [...CLI.slice(1), "--version"], { encoding: "utf8" }).stdout.trim(), node: process.version };
const report = { engine, cli: CLI.join(" "), versions, seed, docs: files.length, edits, sourceBytes, stamp, stages, latency };
mkdirSync(out, { recursive: true });
const base = join(out, `${engine}-${stamp}`);
writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + "\n");

const mb = (b) => (b / 1e6).toFixed(2);
const final = stages[stages.length - 1];
const imp = stages[0];
let md = `# Baseline — ${engine} (${versions.cli}), ${files.length} docs, ${edits} edits, seed ${seed}\n\n`;
md += `Source: ${mb(sourceBytes)} MB of Markdown. Database after import: ${mb(imp.file.db)} MB (${(imp.file.db / sourceBytes).toFixed(1)}× the source); after every workload and a gc: ${mb(final.file.db + final.file.wal)} MB (${((final.file.db + final.file.wal) / sourceBytes).toFixed(1)}×). Run ${stamp}.\n\n`;
const cat = (s, name) => (s.categories[name] ? mb(s.categories[name].bytes) : "");
md += `## Growth per stage\n\n| stage | ops | db MB | wal MB | grew KB | KB / op | content MB | identity MB | recovery MB | history MB | search MB | sync MB | same_dispositions |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
for (const s of stages) md += `| ${s.stage} | ${s.ops ?? ""} | ${mb(s.file.db)} | ${mb(s.file.wal)} | ${(s.file.grew / 1e3).toFixed(0)} | ${s.ops ? (s.file.grew / 1e3 / s.ops).toFixed(1) : ""} | ${cat(s, "content")} | ${cat(s, "identity")} | ${cat(s, "recovery")} | ${cat(s, "history")} | ${cat(s, "search")} | ${cat(s, "sync")} | ${s.same_dispositions ?? ""} |\n`;
md += `\n## History, identity, recovery and feed tables after gc\n\n| table | MB | rows |\n| --- | --- | --- |\n`;
for (const t of ["blobs", "tree_nodes", "dispositions", "block_changes", "revisions", "commits", "edge_transitions", "archives", "id_claims", "resurrection_pool", "pending_materializations", "edges", "feed", "feed_entries"]) if (final.tables[t]) md += `| ${t} | ${mb(final.tables[t].bytes)} | ${final.tables[t].rows} |\n`;
md += `\n## Latency (CLI round trips, ms)\n\n| op | n | p50 | p95 | max |\n| --- | --- | --- | --- | --- |\n`;
for (const [k, v] of Object.entries(latency)) md += `| ${k} | ${v.n} | ${v.p50.toFixed(0)} | ${v.p95.toFixed(0)} | ${v.max.toFixed(0)} |\n`;
md += `\nThe process start (\`spawn-baseline\`, \`--version\`) is included in every row above. Workspace: a fresh temp directory, \`init --no-embedder\`, one filesystem source; no embedder, so \`search\` is FTS only.\n`;
writeFileSync(`${base}.md`, md);
console.error(`wrote ${base}.json / .md`);
if (!keep) rmSync(tmp, { recursive: true, force: true });
else console.error(`kept ${tmp}`);
