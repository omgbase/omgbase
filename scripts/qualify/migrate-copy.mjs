#!/usr/bin/env node
// The qualification script of the modular-core migration (Phase 5a; the plan's
// §7 "Migration and rollback" steps 2–5 as a tool, `docs/modular-core/
// migration-runbook.md`): given a workspace (`<dir>/.omgbase/omgbase.db` + its
// WAL) at ANY supported schema version, it
//
//   (a) COPIES the database into a temporary workspace with the WAL checkpointed
//       into the copy (the file and its WAL copied byte for byte, then `VACUUM
//       INTO` from a read-only connection on the copy — the original is never
//       opened, let alone written; the workspace's files are copied beside it
//       so the CAS and recovery checks have a working tree);
//   (b) records the BEFORE state as a JSON snapshot — every live document
//       `{ _id, _path, _hash, head, created_at, updated_at }`, every live block
//       `{ _id, doc, parent, ordinal, hash }`, the property and link rows sorted,
//       the id-claim count, the pending rows, the schema version, the sizes —
//       through the OLD engine when `--before-bin <omg>` is given (its `q` over
//       `docs { _path, _raw }` supplies the BYTES per document), else by
//       reading the copy's rows directly, schema-aware (16.x: `current_rev`,
//       `deleted_commit`; 17.x: `head`, `deleted_at`). LIMITATION without
//       `--before-bin`: a pre-17 database's current bytes live in the recorder's
//       Merkle tree and cannot be rendered without the old engine, so the
//       byte check is at the HASH level — AFTER's rendered bytes must hash to
//       BEFORE's `docs.file_hash` (which under I1 is the same promise);
//   (c) MIGRATES the copy by opening it with the current TypeScript engine
//       (`omg doctor --json` — the open runs the migration), records AFTER
//       through the TS CLI and, with `--rust-bin <omgbase>`, through the Rust one;
//   (d) DIFFS BEFORE/AFTER on the §7 step-4 invariants — bytes per document
//       (hash-level, or byte-level with `--before-bin`), the id / parent / order
//       maps, the property and link rows, every pre-migration pending row still
//       present or materialized, claims >= before — and runs CAS (a stale
//       `expect.content_hash` refused `stale_expectation`, a fresh one accepted)
//       and recovery (`recoverRepo` on the copy: its first pass records what it
//       replayed/healed, its second pass must be a no-op) on the copy;
//   (e) verifies compatible-open: the Rust binary opens the migrated copy with
//       the same `version.schema` and the same docs/blocks/links answers; a
//       `--before-bin` binary refuses the copy with the pinned "newer than this
//       build" error (or opens it when it shares the schema major — reported);
//   (f) prints the report `{ before, after, diff, cas, recovery, compatible_open,
//       sizes, compositions?, ok }` as JSON and the six-category size table.
//
// `--compositions` (the gate's "measured amplification"): after the migration
// the copy is cloned four times and `history disable` + `history purge` /
// `embed disable` produce the plan's four compositions on disk — full,
// history (embedder off), semantic (history off + purged), core (both) — each
// re-read (the snapshot must equal AFTER's), CAS-checked, recovered, and sized.
//
//   node scripts/qualify/migrate-copy.mjs --workspace <dir> [--before-bin <omg>] [--rust-bin <omgbase>] [--compositions] [--out <report.json>] [--keep] [--bin <omg>]
//
// The human output is NUMBERS ONLY (counts, bytes, ok flags). The JSON report
// names document paths in its `diff` entries when something differs — keep it
// out of public documents. Nothing outside the temporary directory is written.

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE_DIST = join(ROOT, "packages", "core", "dist", "src");
const TS_MAIN = join(ROOT, "packages", "cli", "dist", "src", "main.js");
const require = createRequire(join(ROOT, "packages", "core", "package.json"));
const Database = require("better-sqlite3");

// ---- arguments -----------------------------------------------------------------------------

export function parseArgs(argv) {
  const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };
  return {
    workspace: opt("workspace", null),
    beforeBin: opt("before-bin", null),
    rustBin: opt("rust-bin", null),
    bin: opt("bin", null),
    out: opt("out", null),
    compositions: argv.includes("--compositions"),
    keep: argv.includes("--keep"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

const USAGE = "usage: migrate-copy.mjs --workspace <dir> [--before-bin <omg>] [--rust-bin <omgbase>] [--compositions] [--out <report.json>] [--keep] [--bin <omg>]";

// ---- helpers --------------------------------------------------------------------------------

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const hex = (b) => (b === null || b === undefined ? null : Buffer.isBuffer(b) ? b.toString("hex") : String(b));
const fileBytes = (p) => { try { return statSync(p).size; } catch { return 0; } };
const dbBytes = (db) => ({ db: fileBytes(db), wal: fileBytes(`${db}-wal`), total: fileBytes(db) + fileBytes(`${db}-wal`) });
const sortRows = (rows) => rows.map((r) => JSON.stringify(r)).sort();

/** Run a CLI (argv prefix) over a workspace; `json` parses stdout. Throws only when `must` and the exit is non-zero. */
function run(cli, ws, argv, { json = false, must = true, env = {} } = {}) {
  const r = spawnSync(cli[0], [...cli.slice(1), ...(json ? ["--json"] : []), "-C", ws, ...argv], { encoding: "utf8", maxBuffer: 1 << 30, env: { ...process.env, NO_COLOR: "1", ...env } });
  if (r.error) throw r.error;
  if (r.status !== 0 && must) throw new Error(`${cli.join(" ")} ${argv.join(" ")} failed (${r.status}): ${(r.stderr || r.stdout).slice(0, 2000)}`);
  if (!json) return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
  try { return { exit: r.status, stdout: r.stdout, stderr: r.stderr, json: JSON.parse(r.stdout) }; } catch { return { exit: r.status, stdout: r.stdout, stderr: r.stderr, json: null }; }
}

/** The CLI as an argv prefix: a path to a binary, or `node <main.js>` for a `.js`. */
export function cliOf(bin) {
  if (bin.endsWith(".js") || bin.endsWith(".mjs")) return [process.execPath, bin];
  return [bin];
}

// ---- (a) the copy ---------------------------------------------------------------------------

/**
 * Copy the workspace into `dest`: every file but the database and its WAL/SHM
 * (the working tree the checks need), then the database through `VACUUM INTO`
 * on a read-only connection — the WAL's committed frames land in the copy, the
 * original's files are not written. Returns the copy's database path.
 */
export function copyWorkspace(workspace, dest) {
  const src = resolve(workspace);
  const dbPath = join(src, ".omgbase", "omgbase.db");
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const isDbFile = (p) => /omgbase\.db(-wal|-shm)?$/.test(p) && dirname(p).endsWith(".omgbase");
  cpSync(src, dest, { recursive: true, dereference: true, filter: (p) => !isDbFile(p) });
  mkdirSync(join(dest, ".omgbase"), { recursive: true });
  const target = join(dest, ".omgbase", "omgbase.db");
  // The original is never OPENED (an open of a WAL database, even read-only,
  // creates its -wal/-shm beside it): the database file and its WAL are copied
  // byte for byte (step 1 of the runbook quiesces the writers first), the copy
  // is opened read-only and `VACUUM INTO` writes the final, WAL-free copy.
  const raw = join(dest, ".omgbase", "raw.db");
  copyFileSync(dbPath, raw);
  if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${raw}-wal`);
  const db = new Database(raw, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  for (const f of [raw, `${raw}-wal`, `${raw}-shm`]) rmSync(f, { force: true });
  return target;
}

// ---- (b) the snapshot ------------------------------------------------------------------------

const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const hasColumn = (db, table, column) => hasTable(db, table) && db.pragma(`table_info(${table})`).some((c) => c.name === column);

/**
 * The read-side snapshot of a database, schema-aware: the 17.x columns (`head`,
 * `deleted_at`) or the 16.x ones (`current_rev`, `deleted_commit`). Timestamps
 * are null on a pre-17 database (there they are commit joins the migration
 * computes — not compared). `bytes` (path → raw) is filled by the caller when
 * an engine can render them.
 */
export function snapshotRows(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const version = db.pragma("user_version", { simple: true });
    const v17 = hasColumn(db, "docs", "head");
    const docLive = v17 ? "d.deleted_at IS NULL" : "d.deleted_commit IS NULL";
    const docs = db.prepare(
      v17
        ? `SELECT d.doc_id _id, d.path _path, d.file_hash hash, d.head head, d.created_at created_at, d.updated_at updated_at FROM docs d WHERE ${docLive} ORDER BY d.path`
        : `SELECT d.doc_id _id, d.path _path, d.file_hash hash, d.current_rev head, NULL created_at, NULL updated_at FROM docs d WHERE ${docLive} ORDER BY d.path`,
    ).all().map((r) => ({ _id: r._id, _path: r._path, _hash: hex(r.hash), head: r.head, created_at: r.created_at, updated_at: r.updated_at }));
    const blockLive = v17 ? "b.deleted_at IS NULL" : "b.deleted_commit IS NULL";
    const blocks = db.prepare(
      `SELECT b.block_id _id, b.doc_id doc, b.parent_block parent, b.ordinal ordinal, b.raw_hash hash FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE ${blockLive} AND ${docLive} ORDER BY d.path, b.ordinal, b.block_id`,
    ).all().map((r) => ({ ...r, hash: hex(r.hash) }));
    const propLive = hasColumn(db, "properties", "deleted_commit") ? "AND p.deleted_commit IS NULL" : "";
    const properties = hasTable(db, "properties")
      ? sortRows(db.prepare(
        `SELECT d.path path, p.block_id block, p.source source, p.key key, p.card card, p.ord ord, p.val_text val_text, p.val_num val_num, p.val_bool val_bool, p.val_json val_json, p.type type
         FROM properties p JOIN docs d ON d.doc_id = p.doc_id WHERE ${docLive} ${propLive}`,
      ).all())
      : [];
    const edgeOpen = hasColumn(db, "edges", "to_commit") ? "AND e.to_commit IS NULL" : "";
    const links = hasTable(db, "edges")
      ? sortRows(db.prepare(
        `SELECT d.path path, e.src_block block, e.src_field field, e.predicate predicate, e.dst_kind dst_kind, e.dst_node dst_node, e.anchor anchor, e.provenance provenance, e.via_node via_node
         FROM edges e JOIN docs d ON d.doc_id = e.src_doc WHERE ${docLive} ${edgeOpen}`,
      ).all())
      : [];
    const claims = hasTable(db, "id_claims") ? db.prepare("SELECT count(*) c FROM id_claims").get().c : 0;
    const pending = hasTable(db, "pending_materializations")
      ? db.prepare("SELECT path, kind, from_path, doc_id FROM pending_materializations ORDER BY path").all()
      : [];
    const tombstonedBlocks = v17
      ? db.prepare("SELECT count(*) c FROM blocks WHERE deleted_at IS NOT NULL").get().c
      : db.prepare("SELECT count(*) c FROM blocks WHERE deleted_commit IS NOT NULL").get().c;
    const repos = db.prepare("SELECT repo_id, slug FROM repos ORDER BY rowid").all();
    return { version, docs, blocks, properties, links, claims, pending, tombstoned_blocks: tombstonedBlocks, repos, bytes: null };
  } finally {
    db.close();
  }
}

/** The six-category size table from the rows themselves (`dbstat`), by the engine's own table → category map; the file's bytes beside it. */
export function sizesOf(dbPath, categoryOf) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT name, sum(pgsize) bytes FROM dbstat GROUP BY name").all();
    const tableOfIndex = new Map(db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type IN ('table','index')").all().map((r) => [r.name, r.tbl_name]));
    const categories = { content: 0, identity: 0, recovery: 0, history: 0, search: 0, sync: 0 };
    for (const r of rows) {
      const table = tableOfIndex.get(r.name) ?? r.name;
      // An FTS shadow table folds into its virtual table.
      const base = table.replace(/_(data|idx|docsize|config|content)$/, "");
      const cat = categoryOf(base) ?? categoryOf(table) ?? "sync";
      categories[cat] = (categories[cat] ?? 0) + r.bytes;
    }
    return { file: dbBytes(dbPath), categories };
  } finally {
    db.close();
  }
}

/** The per-document bytes through an engine's `q` (any CLI that renders `docs { _path, _raw }`): path → raw, or null when the binary cannot. */
function bytesThrough(cli, ws) {
  const r = run(cli, ws, ["q", "docs { _path, _raw }", "--bare", "-n", "10000000"], { json: true, must: false });
  if (r.exit !== 0 || !r.json || !Array.isArray(r.json.hits)) return null;
  const out = {};
  for (const h of r.json.hits) out[String(h._path).replace(/^\//, "")] = h._raw;
  return out;
}

/** The read answers through an engine's `q` — the queries both engines must answer alike (spec/surface §1.1). */
function readsThrough(cli, ws) {
  const q = (text) => { const r = run(cli, ws, ["q", text, "--bare", "-n", "10000000"], { json: true }); return sortRows(r.json.hits); };
  return {
    docs: q("docs { _id, _path, _hash }"),
    blocks: q("blocks { _id, _doc_id, _ordinal, _hash }"),
    links: q("links { _id, _path, _block_id, _predicate, _dst_kind, _dst_path, _uri, _field }"),
  };
}

// ---- (d) the diff ----------------------------------------------------------------------------

/** The §7 step-4 invariants between two snapshots; each entry `{ kind, ...where }`. */
export function diffSnapshots(before, after) {
  const diff = [];
  const byId = (rows) => new Map(rows.map((r) => [r._id, r]));
  const bd = byId(before.docs);
  const ad = byId(after.docs);
  for (const [id, b] of bd) {
    const a = ad.get(id);
    if (!a) { diff.push({ kind: "doc_missing", id, path: b._path }); continue; }
    if (a._path !== b._path) diff.push({ kind: "path", id, before: b._path, after: a._path });
    if (a._hash !== b._hash) diff.push({ kind: "hash", id, path: b._path, before: b._hash, after: a._hash });
    if (a.head !== b.head) diff.push({ kind: "head", id, path: b._path, before: b.head, after: a.head });
    if (b.created_at !== null && b.created_at !== undefined && a.created_at !== b.created_at) diff.push({ kind: "created_at", id, path: b._path, before: b.created_at, after: a.created_at });
    if (b.updated_at !== null && b.updated_at !== undefined && a.updated_at !== b.updated_at) diff.push({ kind: "updated_at", id, path: b._path, before: b.updated_at, after: a.updated_at });
  }
  for (const [id, a] of ad) if (!bd.has(id)) diff.push({ kind: "doc_extra", id, path: a._path });
  const bb = byId(before.blocks);
  const ab = byId(after.blocks);
  for (const [id, b] of bb) {
    const a = ab.get(id);
    if (!a) { diff.push({ kind: "block_missing", id, doc: b.doc }); continue; }
    if (a.doc !== b.doc) diff.push({ kind: "block_doc", id, before: b.doc, after: a.doc });
    if (a.parent !== b.parent) diff.push({ kind: "block_parent", id, before: b.parent, after: a.parent });
    if (a.ordinal !== b.ordinal) diff.push({ kind: "block_ordinal", id, before: b.ordinal, after: a.ordinal });
    if (a.hash !== b.hash) diff.push({ kind: "block_hash", id, before: b.hash, after: a.hash });
  }
  for (const [id] of ab) if (!bb.has(id)) diff.push({ kind: "block_extra", id });
  const setDiff = (kind, x, y) => {
    const xs = new Set(x);
    const ys = new Set(y);
    for (const r of x) if (!ys.has(r)) diff.push({ kind: `${kind}_missing`, row: JSON.parse(r) });
    for (const r of y) if (!xs.has(r)) diff.push({ kind: `${kind}_extra`, row: JSON.parse(r) });
  };
  setDiff("property", before.properties, after.properties);
  setDiff("link", before.links, after.links);
  if (after.claims < before.claims) diff.push({ kind: "claims", before: before.claims, after: after.claims });
  // Every pre-migration pending row is still present, or its document's file now holds the bytes the row owed (materialized).
  const afterPending = new Set(after.pending.map((p) => `${p.path} ${p.kind}`));
  for (const p of before.pending) {
    if (afterPending.has(`${p.path} ${p.kind}`)) continue;
    const doc = after.docs.find((d) => d._id === p.doc_id);
    const bytes = after.bytes?.[p.path];
    const materialized = p.kind === "remove" ? doc === undefined : doc !== undefined && bytes !== undefined && sha256hex(bytes) === doc._hash;
    if (!materialized) diff.push({ kind: "pending_lost", path: p.path, pending_kind: p.kind });
  }
  // Bytes: byte-level when BEFORE could render, hash-level always.
  if (after.bytes) {
    for (const d of after.docs) {
      const raw = after.bytes[d._path];
      if (raw === undefined) { diff.push({ kind: "bytes_unreadable", id: d._id, path: d._path }); continue; }
      if (sha256hex(raw) !== d._hash) diff.push({ kind: "bytes_hash", id: d._id, path: d._path });
      const b = bd.get(d._id);
      if (before.bytes && b && before.bytes[b._path] !== undefined && before.bytes[b._path] !== raw) diff.push({ kind: "bytes", id: d._id, path: d._path });
    }
  }
  return diff;
}

// ---- the checks through the library ------------------------------------------------------------

/** CAS and recovery on a workspace copy, through `@omgbase/core`'s dist. */
async function libraryChecks(ws) {
  const core = await import(join(CORE_DIST, "index.js"));
  const w = core.Workspace.open(ws);
  try {
    const repos = w.repos();
    const out = { cas: null, recovery: null, repos: repos.length };
    const repo = repos[0];
    if (!repo) return out;
    const block = w.store.db.prepare("SELECT b.block_id id, lower(hex(b.raw_hash)) h, b.raw raw FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.repo_id = ? AND d.deleted_at IS NULL AND b.deleted_at IS NULL AND b.type = 'paragraph' ORDER BY b.rowid LIMIT 1").get(repo.repoId);
    const docStore = repo.rootPath ? new core.FsDocStore(repo.rootPath) : new core.NullDocStore();
    if (block) {
      let stale = null;
      try {
        core.apply(w.store, { repoId: repo.repoId, rootPath: repo.rootPath ?? undefined, docStore, ops: [{ op: "update", block: block.id, markdown: block.raw, expect: { content_hash: "00".repeat(32) } }], origin: { actor: "agent:qualify", reason: "stale CAS probe" } });
        stale = "accepted";
      } catch (e) {
        stale = e instanceof core.MutationError ? e.code : `threw ${e?.message ?? e}`;
      }
      let fresh = null;
      try {
        // The fresh token is the hash of the bytes themselves (C2 makes it the row's `raw_hash` on a real database; an authored fixture's fake hash would not pass).
        const r = core.apply(w.store, { repoId: repo.repoId, rootPath: repo.rootPath ?? undefined, docStore, ops: [{ op: "update", block: block.id, markdown: block.raw, expect: { content_hash: sha256hex(block.raw) } }], origin: { actor: "agent:qualify", reason: "fresh CAS probe (no-op content)" } });
        fresh = r.committed ? "committed" : "no-op";
      } catch (e) {
        fresh = e instanceof core.MutationError ? e.code : `threw ${e?.message ?? e}`;
      }
      out.cas = { block: block.id, stale_refused: stale === "stale_expectation", stale, fresh_accepted: fresh === "committed" || fresh === "no-op", fresh };
    }
    if (repo.rootPath && existsSync(repo.rootPath)) {
      const first = core.recoverRepo(w.store, repo.repoId, repo.rootPath);
      const second = core.recoverRepo(w.store, repo.repoId, repo.rootPath);
      out.recovery = {
        first: { materialized: first.materialized.length, healed: first.healed.length, missing: first.missing.length },
        second: { materialized: second.materialized.length, healed: second.healed.length, missing: second.missing.length },
        noop: second.materialized.length === 0 && second.healed.length === 0 && second.missing.length === 0,
      };
    } else {
      out.recovery = { skipped: "no filesystem root" };
    }
    return out;
  } finally {
    w.store.close();
  }
}

// ---- the compositions -------------------------------------------------------------------------

/** The verbs that produce each composition ON DISK from a migrated full copy. */
export const COMPOSITION_VERBS = {
  full: [],
  history: [["embed", "disable"]],
  semantic: [["history", "disable"], ["history", "purge"]],
  core: [["embed", "disable"], ["history", "disable"], ["history", "purge"]],
};

// ---- main ----------------------------------------------------------------------------------

export async function qualify(opts, log = (s) => process.stderr.write(`${s}\n`)) {
  const tsCli = cliOf(opts.bin ?? TS_MAIN);
  const size = await import(join(CORE_DIST, "core", "store", "size.js"));
  const categoryOf = (t) => size.TABLE_CATEGORY[t];
  const tmp = mkdtempSync(join(tmpdir(), "omgbase-qualify-"));
  const copy = join(tmp, "copy");
  const report = { tool: "migrate-copy", before: null, after: {}, diff: [], cas: null, recovery: null, compatible_open: {}, sizes: {}, compositions: null, ok: false, temp: opts.keep ? tmp : null };
  try {
    // (a)
    const dbPath = copyWorkspace(opts.workspace, copy);
    log(`copied the workspace (${(dbBytes(dbPath).total / 1e6).toFixed(2)} MB database, WAL checkpointed)`);
    // (b)
    const before = snapshotRows(dbPath);
    before.sizes = sizesOf(dbPath, categoryOf);
    if (opts.beforeBin) {
      before.bytes = bytesThrough(cliOf(opts.beforeBin), copy);
      before.through = before.bytes ? "before-bin" : "rows (before-bin could not render)";
      if (!before.bytes) log("the --before-bin binary could not render the documents; the byte check is hash-level");
    } else {
      before.through = "rows (hash-level bytes; no --before-bin)";
    }
    log(`BEFORE: schema v${before.version}, ${before.docs.length} docs, ${before.blocks.length} blocks, ${before.properties.length} property rows, ${before.links.length} links, ${before.claims} claims, ${before.pending.length} pending, ${before.tombstoned_blocks} tombstoned block rows`);
    report.before = { version: before.version, through: before.through, docs: before.docs.length, blocks: before.blocks.length, properties: before.properties.length, links: before.links.length, claims: before.claims, pending: before.pending.length, tombstoned_blocks: before.tombstoned_blocks, repos: before.repos.length, bytes: before.bytes ? Object.keys(before.bytes).length : null };
    // (c) migrate: the open runs the migration; `doctor` reports the invariants after it.
    const doctor = run(tsCli, copy, ["doctor"], { json: true, must: false });
    const after = snapshotRows(dbPath);
    after.bytes = bytesThrough(tsCli, copy);
    after.sizes = sizesOf(dbPath, categoryOf);
    after.version_json = run(tsCli, copy, ["version"], { json: true }).json;
    after.reads = readsThrough(tsCli, copy);
    log(`AFTER (ts): schema v${after.version}, ${after.docs.length} docs, ${after.blocks.length} blocks, ${after.claims} claims, ${after.pending.length} pending, ${after.tombstoned_blocks} tombstoned block rows, doctor ${doctor.json?.ok ? "ok" : "NOT ok"}`);
    report.after.ts = { version: after.version, docs: after.docs.length, blocks: after.blocks.length, properties: after.properties.length, links: after.links.length, claims: after.claims, pending: after.pending.length, tombstoned_blocks: after.tombstoned_blocks, doctor: doctor.json, engine: after.version_json?.engine ?? null, engine_version: after.version_json?.version ?? null, schema: after.version_json?.schema ?? null, capabilities: after.version_json?.capabilities ?? null };
    // The composition clones are taken NOW — from the migrated copy before the
    // CAS probe writes to it — so their reads must equal AFTER's exactly.
    const clones = opts.compositions
      ? Object.keys(COMPOSITION_VERBS).map((name) => {
        const ws = join(tmp, `composition-${name}`);
        cpSync(copy, ws, { recursive: true, dereference: true, filter: (p) => !/omgbase\.db-(wal|shm)$/.test(p) });
        return { name, ws };
      })
      : [];
    // (d)
    report.diff = diffSnapshots(before, after);
    const checks = await libraryChecks(copy);
    report.cas = checks.cas;
    report.recovery = checks.recovery;
    // (e)
    if (opts.rustBin) {
      const rust = cliOf(opts.rustBin);
      const v = run(rust, copy, ["version"], { json: true, must: false });
      const d = run(rust, copy, ["doctor"], { json: true, must: false });
      let readsAgree = null;
      try { readsAgree = JSON.stringify(readsThrough(rust, copy)) === JSON.stringify(after.reads); } catch (e) { readsAgree = false; report.compatible_open.rust_error = String(e.message ?? e).slice(0, 500); }
      report.compatible_open.rust = { opened: v.exit === 0 && v.json !== null, engine: v.json?.engine ?? null, version: v.json?.version ?? null, schema: v.json?.schema ?? null, schema_agrees: v.json?.schema === after.version_json?.schema, doctor_ok: d.json?.ok ?? false, reads_agree: readsAgree };
      log(`compatible-open (rust): ${report.compatible_open.rust.opened ? "opened" : "did not open"}, schema ${report.compatible_open.rust.schema} vs ${after.version_json?.schema}, doctor ${report.compatible_open.rust.doctor_ok ? "ok" : "NOT ok"}, reads ${readsAgree ? "agree" : "DIFFER"}`);
    }
    if (opts.beforeBin) {
      const old = cliOf(opts.beforeBin);
      const v = run(old, copy, ["version"], { json: true, must: false });
      const text = `${v.stderr}\n${v.stdout}`;
      const refused = v.exit !== 0 && /newer than this build/.test(text);
      report.compatible_open.before_bin = { refused, exit: v.exit, message: refused ? (/database schema \(v\d+\) is newer than this build \(v\d+\)[^"\n]*/.exec(text) ?? [null])[0] : null, opened_same_major: v.exit === 0 && v.json?.schema === after.version };
      log(`compatible-open (before-bin): ${refused ? "refused the migrated copy (newer schema)" : v.exit === 0 ? "opened it (same schema major)" : `exit ${v.exit}`}`);
    }
    // (f) sizes
    report.sizes = { before: before.sizes, after: after.sizes };
    // the compositions
    if (opts.compositions) {
      report.compositions = [];
      for (const { name, ws } of clones) {
        const steps = [];
        for (const argv of COMPOSITION_VERBS[name]) {
          const r = run(tsCli, ws, argv, { json: true, must: false });
          steps.push({ argv: argv.join(" "), exit: r.exit, result: r.json });
        }
        const wsDb = join(ws, ".omgbase", "omgbase.db");
        const snap = snapshotRows(wsDb);
        snap.bytes = bytesThrough(tsCli, ws);
        const readDiff = diffSnapshots({ ...after, pending: [], claims: 0 }, { ...snap, pending: [], claims: 0 });
        const doctorC = run(tsCli, ws, ["doctor"], { json: true, must: false }).json;
        const lib = await libraryChecks(ws);
        const sizesC = sizesOf(wsDb, categoryOf);
        const capabilities = run(tsCli, ws, ["version"], { json: true }).json?.capabilities ?? null;
        const okC = readDiff.length === 0 && (doctorC?.ok ?? false) && (lib.cas === null || (lib.cas.stale_refused && lib.cas.fresh_accepted)) && (lib.recovery === null || lib.recovery.skipped !== undefined || lib.recovery.noop);
        report.compositions.push({ name, steps, capabilities, reads_equal_after: readDiff.length === 0, read_diff: readDiff.slice(0, 20), doctor_ok: doctorC?.ok ?? false, cas: lib.cas, recovery: lib.recovery, sizes: sizesC, ok: okC });
        log(`composition ${name.padEnd(8)} ${(sizesC.file.total / 1e6).toFixed(2)} MB  history ${(sizesC.categories.history / 1e6).toFixed(2)} MB  search ${(sizesC.categories.search / 1e6).toFixed(2)} MB  reads ${readDiff.length === 0 ? "equal" : `${readDiff.length} DIFFER`}  doctor ${doctorC?.ok ? "ok" : "NOT ok"}  cas ${lib.cas ? (lib.cas.stale_refused && lib.cas.fresh_accepted ? "ok" : "NOT ok") : "n/a"}  recovery ${lib.recovery?.noop ? "no-op" : lib.recovery?.skipped ?? "NOT no-op"}`);
      }
    }
    report.ok = report.diff.length === 0
      && (doctor.json?.ok ?? false)
      && (report.cas === null || (report.cas.stale_refused && report.cas.fresh_accepted))
      && (report.recovery === null || report.recovery.skipped !== undefined || report.recovery.noop)
      && (report.compatible_open.rust === undefined || (report.compatible_open.rust.opened && report.compatible_open.rust.schema_agrees && report.compatible_open.rust.doctor_ok && report.compatible_open.rust.reads_agree))
      && (report.compatible_open.before_bin === undefined || report.compatible_open.before_bin.refused || report.compatible_open.before_bin.opened_same_major)
      && (report.compositions === null || report.compositions.every((c) => c.ok));
    if (opts.out) writeFileSync(resolve(opts.out), JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    if (!opts.keep) rmSync(tmp, { recursive: true, force: true });
  }
}

/** The six-category table, before and after (and per composition), numbers only. */
export function sizeTable(report) {
  const mb = (b) => (b / 1e6).toFixed(2);
  const cats = ["content", "identity", "recovery", "history", "search", "sync"];
  let t = `| state | database MB | ${cats.join(" | ")} |\n| --- | --- | ${cats.map(() => "---").join(" | ")} |\n`;
  const row = (name, s) => `| ${name} | ${mb(s.file.total)} | ${cats.map((c) => mb(s.categories[c] ?? 0)).join(" | ")} |\n`;
  t += row("before", report.sizes.before);
  t += row("after (migrated)", report.sizes.after);
  for (const c of report.compositions ?? []) t += row(`composition ${c.name}`, c.sizes);
  return t;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.workspace) { console.error(USAGE); process.exit(opts.help ? 0 : 2); }
  if (!existsSync(opts.bin ?? TS_MAIN)) { console.error(`the TypeScript CLI is missing at ${opts.bin ?? TS_MAIN} — run \`pnpm build\``); process.exit(2); }
  const report = await qualify(opts);
  const human = { ...report, diff: report.diff.length, diff_kinds: [...new Set(report.diff.map((d) => d.kind))] };
  process.stdout.write(`${sizeTable(report)}\n${JSON.stringify(human, null, 2)}\n`);
  if (report.temp) console.error(`kept ${report.temp}`);
  process.exit(report.ok ? 0 : 1);
}
