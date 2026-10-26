#!/usr/bin/env node
// The modular-core real-corpus measurement (Phase 4b — the program's
// motivation, docs/modular-core/baseline.md §3): given a directory of Markdown,
// import it into FRESH workspaces under every composition and print, per
// composition, the six-category size table and the amplification (× the
// Markdown). Nothing here changes behaviour and nothing is written outside a
// temporary directory: the source directory is COPIED into the temp workspace's
// parent before `source add`, so the corpus itself is never touched.
//
//   node scripts/baseline/real-corpus.mjs --source <dir> [--engine ts|rust] [--bin <omg>] [--embedder <cmd|url>] [--out <dir>] [--keep]
//   node scripts/baseline/real-corpus.mjs --source docs                                    # this repository's docs/ (a public corpus)
//   node scripts/baseline/real-corpus.mjs --source docs --embedder "node $PWD/packages/embedder/dist/src/bin.js"
//
// Compositions (each a fresh `init` + one `source add`):
//   history on  + embedder off     init --no-embedder; source add
//   history off + embedder off     init --no-embedder; source add --no-history   (the core alone)
//   history on  + embedder on      init --embedder <cmd>; source add; embed drain          (only with --embedder)
//   history off + embedder on      init --embedder <cmd>; source add --no-history; embed drain
//
// The size report is the store's own (`doctor --size --json`, spec/store §7.2):
// bytes per category from dbstat, the file and the WAL. The table prints
// NUMBERS ONLY — document and block counts, bytes, ratios — never a path or a
// line of content, so a run over a private corpus can be pasted into a public
// document as it is. Output: the Markdown table on stdout, the full JSON (every
// table's bytes and rows per composition) under `--out` when given.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- arguments -------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
const source = opt("source", null);
if (!source) { console.error("usage: real-corpus.mjs --source <dir> [--engine ts|rust] [--bin <omg>] [--embedder <cmd|url>] [--out <dir>] [--keep]"); process.exit(2); }
const engine = opt("engine", "ts");
const bin = opt("bin", null);
const embedder = opt("embedder", null);
const out = opt("out", null);
const keep = args.includes("--keep");

function cliFor() {
  if (bin) return [bin];
  if (engine === "rust") return [resolve(ROOT, "target/debug/omgbase")];
  if (engine === "ts") return [process.execPath, resolve(ROOT, "packages/cli/dist/src/main.js")];
  throw new Error(`--engine ts|rust (got ${engine})`);
}
const CLI = cliFor();

// ---- the corpus (copied, never touched) ------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "mc-real-corpus-"));
const corpus = join(tmp, "corpus");
cpSync(resolve(source), corpus, { recursive: true, dereference: true });

/** Markdown files under the copy: count and bytes (the amplification's denominator). */
function markdownStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) { files++; bytes += statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}
const md = markdownStats(corpus);

// ---- running the CLI -------------------------------------------------------------------

function omg(ws, argv, { json = false, allowFail = false } = {}) {
  const full = [...CLI.slice(1), ...(json ? ["--json"] : []), "-C", ws, ...argv];
  const r = spawnSync(CLI[0], full, { encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0 && !allowFail) throw new Error(`${argv.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return json ? JSON.parse(r.stdout) : r.stdout;
}

function dbBytes(ws) {
  const db = join(ws, ".omgbase", "omgbase.db");
  const sz = (p) => { try { return statSync(p).size; } catch { return 0; } };
  return { db: sz(db), wal: sz(`${db}-wal`) };
}

/** One composition: fresh workspace, init, source add, (drain), size report. */
function measure(name, { history, embed }) {
  const ws = join(tmp, name.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(ws, { recursive: true });
  const t0 = performance.now();
  const init = spawnSync(CLI[0], [...CLI.slice(1), "init", ws, "--yes", ...(embed ? ["--embedder", embedder] : ["--no-embedder"])], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  omg(ws, ["source", "add", corpus, "--repo", "real", "-y", ...(history ? [] : ["--no-history"])]);
  const importMs = performance.now() - t0;
  let drainMs = null;
  let drained = null;
  if (embed) {
    const t1 = performance.now();
    drained = omg(ws, ["embed", "drain"], { json: true });
    drainMs = performance.now() - t1;
  }
  const size = omg(ws, ["doctor", "--size"], { json: true });
  const bytes = dbBytes(ws);
  const counts = omg(ws, ["status"], { json: true, allowFail: true });
  const cats = Object.fromEntries(size.categories.map((c) => [c.name, { bytes: c.bytes, rows: c.rows }]));
  const tables = Object.fromEntries(size.categories.flatMap((c) => c.tables.map((t) => [t.name, { bytes: t.bytes, rows: t.rows }])));
  const total = bytes.db + bytes.wal;
  console.error(`  ${name.padEnd(28)} db ${(total / 1e6).toFixed(2)} MB  ${(total / md.bytes).toFixed(1)}×  history ${((cats.history?.bytes ?? 0) / 1e6).toFixed(2)} MB  search ${((cats.search?.bytes ?? 0) / 1e6).toFixed(2)} MB  (${(importMs / 1000).toFixed(1)} s import${drainMs !== null ? `, ${(drainMs / 1000).toFixed(1)} s drain` : ""})`);
  return {
    name, history, embed, file: bytes, total, amplification: total / md.bytes, categories: cats, tables,
    docs: typeof counts?.docs === "number" ? counts.docs : (tables.docs?.rows ?? null), blocks: tables.blocks?.rows ?? null,
    import_ms: Math.round(importMs), drain_ms: drainMs === null ? null : Math.round(drainMs), drained,
  };
}

console.error(`engine ${engine} (${CLI.join(" ")}); ${md.files} Markdown files, ${(md.bytes / 1e6).toFixed(2)} MB${embedder ? `; embedder ${embedder}` : ""}; workspaces under ${tmp}`);
const runs = [
  measure("history on, embedder off", { history: true, embed: false }),
  measure("history off, embedder off", { history: false, embed: false }),
  ...(embedder ? [measure("history on, embedder on", { history: true, embed: true }), measure("history off, embedder on", { history: false, embed: true })] : []),
];

// ---- the table (numbers only) ------------------------------------------------------------

const mb = (b) => (b / 1e6).toFixed(2);
const cat = (r, name) => (r.categories[name] ? mb(r.categories[name].bytes) : "");
const share = (r, name) => (r.categories[name] && r.total > 0 ? `${((100 * r.categories[name].bytes) / r.total).toFixed(1)} %` : "");
let table = `| composition | docs | blocks | Markdown MB | database MB | × source | content | identity | recovery | history | search | sync |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
for (const r of runs) {
  table += `| ${r.name} | ${r.docs ?? ""} | ${r.blocks ?? ""} | ${mb(md.bytes)} | ${mb(r.total)} | ${r.amplification.toFixed(1)}× | ${cat(r, "content")} (${share(r, "content")}) | ${cat(r, "identity")} | ${cat(r, "recovery")} | ${cat(r, "history")} (${share(r, "history")}) | ${cat(r, "search")} (${share(r, "search")}) | ${cat(r, "sync")} |\n`;
}
const base = runs[0];
const off = runs[1];
table += `\nHistory off saves ${mb(base.total - off.total)} MB (${((100 * (base.total - off.total)) / base.total).toFixed(0)} % of the history-on database; ${base.amplification.toFixed(1)}× → ${off.amplification.toFixed(1)}× the Markdown).\n`;
if (runs.length === 4) {
  const [, , onE, offE] = runs;
  table += `With the embedder the vectors add ${mb(onE.total - base.total)} MB (history on) / ${mb(offE.total - off.total)} MB (history off); the four compositions span ${off.amplification.toFixed(1)}× – ${onE.amplification.toFixed(1)}×.\n`;
}
process.stdout.write(table);

if (out) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(resolve(ROOT, out), { recursive: true });
  const path = join(resolve(ROOT, out), `real-corpus-${engine}-${stamp}.json`);
  writeFileSync(path, JSON.stringify({ engine, cli: CLI.join(" "), embedder: embedder ? "(given)" : null, markdown: md, runs, stamp }, null, 2) + "\n");
  console.error(`wrote ${path}`);
}
if (!keep) rmSync(tmp, { recursive: true, force: true });
else console.error(`kept ${tmp}`);
