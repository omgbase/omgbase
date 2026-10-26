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
//       so the CAS and recovery checks have a working tree) and RE-POINTS every
//       `fs` source of the copy at the copied tree (5a-ii): a root inside the
//       workspace directory follows the copy; a root elsewhere (a database-only
//       copy of a workspace) is copied too under `--with-files` — byte count
//       printed — or replaced by an empty directory, so NOTHING the script runs
//       can read or write the original tree. Every `omg` it runs passes
//       `--stale` (no pre-verb sweep: with an empty root one would tombstone
//       every cached file);
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
//       (`omg doctor --json` — the open runs the migration), reads the
//       `legacy_bytes` alert the migration may raise (spec/store §5.11: rows
//       imported before block trivia was stored do not reproduce their file;
//       `legacy_bytes` in the report) and, with `--repair`, runs `omg sync` on
//       the copy — the sweep repairs those rows from the copied files — then
//       `doctor` again; records AFTER through the TS CLI and, with `--rust-bin
//       <omgbase>`, through the Rust one;
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
//       build" error — recognised by the MESSAGE whatever the exit status (5a-ii:
//       omgbase 0.27.3 prints it as a JSON error and exits 0 under `--json`) —
//       or opens it when it shares the schema major (reported);
//   (f) prints the report `{ before, after, diff, cas, recovery, compatible_open,
//       sizes, repair?, compositions?, ok }` as JSON and the six-category size table.
//
// `--compositions` (the gate's "measured amplification"): after the migration
// the copy is cloned four times and `history disable` + `history purge` /
// `embed disable` produce the plan's four compositions on disk — full,
// history (embedder off), semantic (history off + purged), core (both) — each
// re-read (the snapshot must equal AFTER's), CAS-checked, recovered, and sized.
//
//   node scripts/qualify/migrate-copy.mjs --workspace <dir> [--before-bin <omg>] [--rust-bin <omgbase>] [--with-files] [--repair] [--compositions] [--out <report.json>] [--keep] [--bin <omg>]
//
// A directory that holds no omgbase workspace database (no `docs` table) is
// reported `{ ok: false, reason }` and exits 2. The human output is NUMBERS
// ONLY (counts, bytes, ok flags). The JSON report names document paths in its
// `diff` entries when something differs — keep it out of public documents.
// Nothing outside the temporary directory is written.

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
    withFiles: argv.includes("--with-files"),
    repair: argv.includes("--repair"),
    keep: argv.includes("--keep"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

const USAGE = "usage: migrate-copy.mjs --workspace <dir> [--before-bin <omg>] [--rust-bin <omgbase>] [--with-files] [--repair] [--compositions] [--out <report.json>] [--keep] [--bin <omg>]";

// ---- helpers --------------------------------------------------------------------------------

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const hex = (b) => (b === null || b === undefined ? null : Buffer.isBuffer(b) ? b.toString("hex") : String(b));
const fileBytes = (p) => { try { return statSync(p).size; } catch { return 0; } };
const dbBytes = (db) => ({ db: fileBytes(db), wal: fileBytes(`${db}-wal`), total: fileBytes(db) + fileBytes(`${db}-wal`) });
const sortRows = (rows) => rows.map((r) => JSON.stringify(r)).sort();

/** Run a CLI (argv prefix) over a workspace with `--stale` (no pre-verb sweep — the copy's root may be empty); `json` parses stdout. Throws only when `must` and the exit is non-zero. */
function run(cli, ws, argv, { json = false, must = true, env = {} } = {}) {
  const r = spawnSync(cli[0], [...cli.slice(1), ...(json ? ["--json"] : []), "--stale", "-C", ws, ...argv], { encoding: "utf8", maxBuffer: 1 << 30, env: { ...process.env, NO_COLOR: "1", ...env } });
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

/**
 * The `--before-bin` refusal (runbook §4): the old engine must refuse the
 * migrated copy with the pinned message. Recognised by the MESSAGE, on either
 * stream, whatever the exit status — omgbase 0.27.3 prints
 * `{"error":"error","message":"database schema (v17) is newer than this build (v16); upgrade omgbase"}`
 * and exits 0 under `--json` (qualification finding F3); the exit is recorded.
 */
export function refusalOf(exit, text) {
  const refused = /newer than this build/.test(text);
  return { refused, exit, message: refused ? (/database schema \(v\d+\) is newer than this build \(v\d+\)[^"\n]*/.exec(text) ?? [null])[0] : null };
}

// ---- (a) the copy ---------------------------------------------------------------------------

const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const hasColumn = (db, table, column) => hasTable(db, table) && db.pragma(`table_info(${table})`).some((c) => c.name === column);

/** Whether `p` is `dir` or lies under it. */
function inside(p, dir) {
  const rel = relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** `cpSync` of a tree, skipping any `.omgbase` directory inside it, summing the bytes of the files copied. */
function copyTree(from, to) {
  let bytes = 0;
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (p) => {
      if (p.split(/[\\/]/).includes(".omgbase") && relative(from, p) !== "") return false;
      try { const st = statSync(p); if (st.isFile()) bytes += st.size; } catch { /* vanished */ }
      return true;
    },
  });
  return bytes;
}

/**
 * Copy the workspace into `dest`: every file but the database and its WAL/SHM
 * (the working tree the checks need), then the database through `VACUUM INTO`
 * on a read-only connection — the WAL's committed frames land in the copy, the
 * original's files are not written. Then every `fs` source of the copy is
 * RE-POINTED (5a-ii): a root inside the workspace follows the copy; a root
 * elsewhere is copied under `--with-files` (`withFiles`) into `<dest>/.omgbase-roots/<n>`
 * or replaced by an empty directory there — so no `omg` the script runs can
 * reach the original tree. Returns `{ dbPath, roots }` — one entry per fs
 * source `{ source, inside, copied, bytes, available }`.
 */
export function copyWorkspace(workspace, dest, { withFiles = false, log = () => {} } = {}) {
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
  const ro = new Database(raw, { readonly: true });
  try {
    ro.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    ro.close();
  }
  for (const f of [raw, `${raw}-wal`, `${raw}-shm`]) rmSync(f, { force: true });
  // Re-point the fs sources (the registry exists since schema v9; `config` is `{"root": …}` since v13).
  const roots = [];
  const db = new Database(target);
  try {
    if (hasColumn(db, "sources", "config")) {
      const sources = db.prepare("SELECT source_id, config FROM sources WHERE adapter = 'fs' ORDER BY rowid").all();
      let n = 0;
      for (const s of sources) {
        let config;
        try { config = JSON.parse(s.config ?? "{}"); } catch { config = {}; }
        if (typeof config.root !== "string" || config.root === "") continue;
        const from = resolve(config.root);
        let to;
        let copied = false;
        let bytes = 0;
        let available;
        if (inside(from, src)) {
          to = join(dest, relative(src, from));
          available = existsSync(to);
          bytes = available ? treeBytes(to) : 0;
        } else {
          to = join(dest, ".omgbase-roots", String(n++));
          mkdirSync(to, { recursive: true });
          if (withFiles && existsSync(from)) {
            bytes = copyTree(from, to);
            copied = true;
            available = true;
          } else {
            available = false;
          }
        }
        db.prepare("UPDATE sources SET config = ? WHERE source_id = ?").run(JSON.stringify({ ...config, root: to }), s.source_id);
        roots.push({ source: s.source_id, inside: inside(from, src), copied, bytes, available });
        log(`source ${s.source_id}: root ${inside(from, src) ? "inside the workspace, follows the copy" : copied ? `outside the workspace, copied (${(bytes / 1e6).toFixed(2)} MB)` : "outside the workspace, replaced by an empty directory (pass --with-files to copy it)"}`);
      }
    }
  } finally {
    db.close();
  }
  return { dbPath: target, roots };
}

/** The bytes of every regular file under `dir` (a `.omgbase` directory excluded). */
function treeBytes(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const entry of require("node:fs").readdirSync(d, { withFileTypes: true })) {
      if (entry.name === ".omgbase") continue;
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) bytes += statSync(p).size;
    }
  };
  walk(dir);
  return bytes;
}

// ---- (b) the snapshot ------------------------------------------------------------------------

/**
 * The read-side snapshot of a database, schema-aware: the 17.x columns (`head`,
 * `deleted_at`) or the 16.x ones (`current_rev`, `deleted_commit`). Timestamps
 * are null on a pre-17 database (there they are commit joins the migration
 * computes — not compared). `bytes` (path → raw) is filled by the caller when
 * an engine can render them. `legacy_bytes` is the count the active
 * `legacy_bytes` alert carries (0 when none, spec/store §5.11; 17.4).
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
    const legacyBytes = hasTable(db, "alerts")
      ? db.prepare("SELECT coalesce(sum(json_extract(detail, '$.docs')), 0) n FROM alerts WHERE code = 'legacy_bytes' AND cleared_at IS NULL").get().n
      : 0;
    return { version, docs, blocks, properties, links, claims, pending, tombstoned_blocks: tombstonedBlocks, repos, legacy_bytes: legacyBytes, bytes: null };
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
export function diffSnapshots(before, after, expected = {}) {
  const diff = [];
  const syncedIds = expected.syncedIds ?? new Set();
  const syncedPaths = expected.syncedPaths ?? new Set();
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
  // Classify what is expected rather than wrong: (1) a document the `--repair` sweep ingested from a NEWER file on
  // disk (ordinary sync activity on the copy — its hash/head/blocks/properties/links legitimately moved); (2) a `bytes`
  // difference where BEFORE was read through an old engine that could not reproduce the file (legacy trivia) and AFTER
  // reproduces `file_hash` exactly — the fidelity improvement §5.11 promises. `report.diff` keeps only the unexpected.
  const ab2 = byId(after.blocks);
  for (const d of diff) {
    const docOf = d.id && ab2.has(d.id) ? ab2.get(d.id).doc : d.doc;
    if (syncedIds.has(d.id) || syncedIds.has(docOf) || syncedPaths.has(d.path) || (d.row && syncedPaths.has(d.row.path))) d.expected = "synced_from_disk";
    else if (d.kind === "bytes") {
      const a = ad.get(d.id); const b = bd.get(d.id);
      if (a && b && a._hash === b._hash && sha256hex(after.bytes[a._path]) === a._hash) d.expected = "legacy_bytes_repaired";
    }
  }
  return diff;
}

// ---- the checks through the library ------------------------------------------------------------

/** CAS and recovery on a workspace copy, through `@omgbase/core`'s dist. Recovery needs the files (`filesAvailable`). */
async function libraryChecks(ws, { filesAvailable = true } = {}) {
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
    if (!repo.rootPath) {
      out.recovery = { skipped: "no filesystem root" };
    } else if (!filesAvailable || !existsSync(repo.rootPath)) {
      out.recovery = { skipped: "files not copied (pass --with-files)" };
    } else {
      const first = core.recoverRepo(w.store, repo.repoId, repo.rootPath);
      const second = core.recoverRepo(w.store, repo.repoId, repo.rootPath);
      out.recovery = {
        first: { materialized: first.materialized.length, healed: first.healed.length, missing: first.missing.length },
        second: { materialized: second.materialized.length, healed: second.healed.length, missing: second.missing.length },
        noop: second.materialized.length === 0 && second.healed.length === 0 && second.missing.length === 0,
      };
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
  const report = { tool: "migrate-copy", before: null, after: {}, diff: [], cas: null, recovery: null, compatible_open: {}, sizes: {}, repair: null, compositions: null, ok: false, temp: opts.keep ? tmp : null };
  try {
    // (a)
    const { dbPath, roots } = copyWorkspace(opts.workspace, copy, { withFiles: opts.withFiles ?? false, log });
    const filesAvailable = roots.every((r) => r.available);
    report.copy = { roots, files_available: filesAvailable };
    log(`copied the workspace (${(dbBytes(dbPath).total / 1e6).toFixed(2)} MB database, WAL checkpointed)`);
    // A database without a `docs` table is not an omgbase workspace (a toy or
    // pre-release database): report it and stop, rather than crash on the first
    // query (qualification finding F4).
    {
      const db = new Database(dbPath, { readonly: true });
      try {
        if (!hasTable(db, "docs")) {
          report.reason = `not an omgbase workspace (no docs table; user_version ${db.pragma("user_version", { simple: true })})`;
          log(report.reason);
          return report;
        }
      } finally {
        db.close();
      }
    }
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
    let doctor = run(tsCli, copy, ["doctor"], { json: true, must: false });
    const legacyBefore = snapshotRows(dbPath).legacy_bytes;
    log(`migrated: doctor ${doctor.json?.ok ? "ok" : "NOT ok"}, legacy_bytes ${legacyBefore}`);
    // `--repair`: the sweep repairs the legacy documents from the copied files (spec/store §5.11, spec/sync §4.3 step 5), then `doctor` again.
    let syncedFromDisk = { ids: new Set(), paths: new Set() };
    if (opts.repair) {
      if (!filesAvailable) {
        report.repair = { legacy_bytes_before: legacyBefore, repaired: 0, remaining: legacyBefore, error: "no files to repair from (pass --with-files)" };
        log("--repair: the copy has no files to repair from (pass --with-files)");
      } else {
        const preRepair = snapshotRows(dbPath);
        const sync = run(tsCli, copy, ["sync"], { json: true, must: false });
        doctor = run(tsCli, copy, ["doctor"], { json: true, must: false });
        const postRepair = snapshotRows(dbPath);
        const remaining = postRepair.legacy_bytes;
        // A document whose hash moved across the sweep was ingested from a newer file on disk (the legacy repair never changes a hash).
        const preHash = new Map(preRepair.docs.map((d) => [d._id, d._hash]));
        const synced = postRepair.docs.filter((d) => preHash.has(d._id) && preHash.get(d._id) !== d._hash);
        for (const d of preRepair.docs) if (!postRepair.docs.some((x) => x._id === d._id)) synced.push(d);
        for (const d of postRepair.docs) if (!preHash.has(d._id)) synced.push(d);
        syncedFromDisk = { ids: new Set(synced.map((d) => d._id)), paths: new Set(synced.map((d) => d._path)) };
        report.repair = { legacy_bytes_before: legacyBefore, repaired: Array.isArray(sync.json?.repaired) ? sync.json.repaired.length : legacyBefore - remaining, remaining, sync_exit: sync.exit, synced_from_disk: { docs: synced.length, sample: synced.slice(0, 20).map((d) => d._id) } };
        log(`repaired: ${report.repair.repaired} of ${legacyBefore} legacy document(s), ${remaining} remaining; doctor ${doctor.json?.ok ? "ok" : "NOT ok"}`);
      }
    }
    const after = snapshotRows(dbPath);
    after.bytes = bytesThrough(tsCli, copy);
    after.sizes = sizesOf(dbPath, categoryOf);
    after.version_json = run(tsCli, copy, ["version"], { json: true }).json;
    after.reads = readsThrough(tsCli, copy);
    log(`AFTER (ts): schema v${after.version}, ${after.docs.length} docs, ${after.blocks.length} blocks, ${after.claims} claims, ${after.pending.length} pending, ${after.tombstoned_blocks} tombstoned block rows, legacy_bytes ${after.legacy_bytes}, doctor ${doctor.json?.ok ? "ok" : "NOT ok"}`);
    report.after.ts = { version: after.version, docs: after.docs.length, blocks: after.blocks.length, properties: after.properties.length, links: after.links.length, claims: after.claims, pending: after.pending.length, tombstoned_blocks: after.tombstoned_blocks, legacy_bytes: after.legacy_bytes, doctor: doctor.json, engine: after.version_json?.engine ?? null, engine_version: after.version_json?.version ?? null, schema: after.version_json?.schema ?? null, capabilities: after.version_json?.capabilities ?? null };
    // The composition clones are taken NOW — from the migrated copy before the
    // CAS probe writes to it — so their reads must equal AFTER's exactly.
    const clones = opts.compositions
      ? Object.keys(COMPOSITION_VERBS).map((name) => {
        const ws = join(tmp, `composition-${name}`);
        cpSync(copy, ws, { recursive: true, dereference: true, filter: (p) => !/omgbase\.db-(wal|shm)$/.test(p) });
        // The clone's fs roots point into `copy`; re-point them into the clone so its sweep and recovery stay inside it.
        const db = new Database(join(ws, ".omgbase", "omgbase.db"));
        try {
          if (hasColumn(db, "sources", "config")) {
            for (const s of db.prepare("SELECT source_id, config FROM sources WHERE adapter = 'fs'").all()) {
              let config; try { config = JSON.parse(s.config ?? "{}"); } catch { config = {}; }
              if (typeof config.root === "string" && inside(resolve(config.root), copy)) db.prepare("UPDATE sources SET config = ? WHERE source_id = ?").run(JSON.stringify({ ...config, root: join(ws, relative(copy, resolve(config.root))) }), s.source_id);
            }
          }
        } finally {
          db.close();
        }
        return { name, ws };
      })
      : [];
    // (d)
    const allDiff = diffSnapshots(before, after, { syncedIds: syncedFromDisk.ids, syncedPaths: syncedFromDisk.paths });
    report.diff = allDiff.filter((d) => !d.expected);
    const tally = (xs) => { const m = {}; for (const d of xs) m[d.kind] = (m[d.kind] ?? 0) + 1; return m; };
    report.informational = {
      synced_from_disk: tally(allDiff.filter((d) => d.expected === "synced_from_disk")),
      legacy_bytes_repaired: allDiff.filter((d) => d.expected === "legacy_bytes_repaired").length,
    };
    if (allDiff.length !== report.diff.length) log(`expected differences set aside: ${allDiff.length - report.diff.length} (synced from newer files: ${Object.values(report.informational.synced_from_disk).reduce((a, b) => a + b, 0)}; legacy bytes now reproducing the file: ${report.informational.legacy_bytes_repaired})`);
    const checks = await libraryChecks(copy, { filesAvailable });
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
      // `version` never opens the database, so the refusal must be probed with a read that does;
      // `version` only supplies the old build's schema for the same-major case.
      const v = run(old, copy, ["version"], { json: true, must: false });
      const q = run(old, copy, ["query", "docs count"], { json: true, must: false });
      const refusal = refusalOf(q.exit, `${q.stderr}\n${q.stdout}`);
      report.compatible_open.before_bin = { ...refusal, opened_same_major: !refusal.refused && q.exit === 0 && q.json !== null && v.json?.schema === after.version };
      log(`compatible-open (before-bin): ${refusal.refused ? `refused the migrated copy (newer schema; exit ${q.exit})` : q.exit === 0 && q.json !== null ? "opened it (same schema major)" : `exit ${q.exit}`}`);
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
        // A clone must read exactly as AFTER does; `bytes_hash` is AFTER's own finding (a legacy document, reported once in `diff`), not a composition difference — the byte-level `bytes` kind still compares the clone to AFTER.
        const readDiff = diffSnapshots({ ...after, pending: [], claims: 0 }, { ...snap, pending: [], claims: 0 }).filter((d) => d.kind !== "bytes_hash");
        const doctorC = run(tsCli, ws, ["doctor"], { json: true, must: false }).json;
        const lib = await libraryChecks(ws, { filesAvailable });
        const sizesC = sizesOf(wsDb, categoryOf);
        const capabilities = run(tsCli, ws, ["version"], { json: true }).json?.capabilities ?? null;
        // A clone's `doctor` carries AFTER's legacy condition when the copy was not repaired; the composition is judged on everything else.
        const doctorOk = doctorC?.ok ?? false;
        const doctorOkButLegacy = !doctorOk && Array.isArray(doctorC?.checks) && doctorC.checks.every((c) => c.ok || c.name === "bytes reproducible" || (c.name === "alerts" && /^legacy_bytes\[/.test(c.detail ?? ""))) && after.legacy_bytes > 0;
        const okC = readDiff.length === 0 && (doctorOk || doctorOkButLegacy) && (lib.cas === null || (lib.cas.stale_refused && lib.cas.fresh_accepted)) && (lib.recovery === null || lib.recovery.skipped !== undefined || lib.recovery.noop);
        report.compositions.push({ name, steps, capabilities, reads_equal_after: readDiff.length === 0, read_diff: readDiff.slice(0, 20), doctor_ok: doctorOk, doctor_ok_but_legacy: doctorOkButLegacy, cas: lib.cas, recovery: lib.recovery, sizes: sizesC, ok: okC });
        log(`composition ${name.padEnd(8)} ${(sizesC.file.total / 1e6).toFixed(2)} MB  history ${(sizesC.categories.history / 1e6).toFixed(2)} MB  search ${(sizesC.categories.search / 1e6).toFixed(2)} MB  reads ${readDiff.length === 0 ? "equal" : `${readDiff.length} DIFFER`}  doctor ${doctorOk ? "ok" : doctorOkButLegacy ? "legacy only" : "NOT ok"}  cas ${lib.cas ? (lib.cas.stale_refused && lib.cas.fresh_accepted ? "ok" : "NOT ok") : "n/a"}  recovery ${lib.recovery?.noop ? "no-op" : lib.recovery?.skipped ?? "NOT no-op"}`);
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
  if (report.reason) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: report.reason }, null, 2)}\n`);
    process.exit(2);
  }
  const human = { ...report, diff: report.diff.length, diff_kinds: [...new Set(report.diff.map((d) => d.kind))] };
  process.stdout.write(`${sizeTable(report)}\n${JSON.stringify(human, null, 2)}\n`);
  if (report.temp) console.error(`kept ${report.temp}`);
  process.exit(report.ok ? 0 : 1);
}
