// node --test scripts/qualify/migrate-copy.test.mjs
//
// The qualification script end to end (modular-core Phase 5a; 5a-ii's fixes):
// on a 16.x database extracted from `spec/store/cases/migrations.json` (the one
// pre-17 pre-state the spec authors), on a 17.x workspace built by the
// baseline harness — with the four compositions, as a database-only copy
// under `--with-files`, and with a legacy document repaired under `--repair` —
// and on a database that is no workspace at all. Needs `pnpm build` (the TS
// CLI and core dist); the Rust half runs when a built `omgbase` binary exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSITION_VERBS, cliOf, copyWorkspace, diffSnapshots, parseArgs, qualify, refusalOf, sizeTable, snapshotRows } from "./migrate-copy.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(ROOT, "packages", "core", "package.json"));
const Database = require("better-sqlite3");
const TS_MAIN = join(ROOT, "packages", "cli", "dist", "src", "main.js");
const RUST_BIN = ["target/release/omgbase", "target/debug/omgbase"].map((p) => join(ROOT, p)).find((p) => existsSync(p)) ?? null;
const { DDL, HISTORY_DDL, SYNC_DDL } = await import(join(ROOT, "packages", "core", "dist", "src", "core", "store", "schema.js"));
const quiet = () => {};

assert.ok(existsSync(TS_MAIN), `the built CLI is missing at ${TS_MAIN} — run pnpm build`);

// ---------------------------------------------------------------- unit

test("parseArgs and cliOf", () => {
  const o = parseArgs(["--workspace", "/w", "--rust-bin", "/r", "--compositions", "--keep", "--before-bin", "/old/omg", "--with-files", "--repair"]);
  assert.equal(o.workspace, "/w");
  assert.equal(o.rustBin, "/r");
  assert.equal(o.beforeBin, "/old/omg");
  assert.equal(o.compositions, true);
  assert.equal(o.keep, true);
  assert.equal(o.withFiles, true);
  assert.equal(o.repair, true);
  assert.deepEqual(parseArgs(["--workspace", "/w"]), { workspace: "/w", beforeBin: null, rustBin: null, bin: null, out: null, compositions: false, withFiles: false, repair: false, keep: false, help: false });
  assert.deepEqual(cliOf("/x/main.js"), [process.execPath, "/x/main.js"]);
  assert.deepEqual(cliOf("/x/omgbase"), ["/x/omgbase"]);
  assert.deepEqual(Object.keys(COMPOSITION_VERBS), ["full", "history", "semantic", "core"]);
});

test("refusalOf recognises the pinned refusal by its message whatever the exit (omgbase 0.27.3 exits 0 under --json)", () => {
  const msg = "database schema (v17) is newer than this build (v16); upgrade omgbase";
  assert.deepEqual(refusalOf(0, `\n{"error":"error","message":"${msg}"}\n`), { refused: true, exit: 0, message: msg });
  assert.deepEqual(refusalOf(1, `error: ${msg}\n`), { refused: true, exit: 1, message: msg });
  assert.deepEqual(refusalOf(0, '{"engine":"omgbase","schema":17}\n'), { refused: false, exit: 0, message: null });
});

test("diffSnapshots names every §7 step-4 invariant it finds broken, and nothing on identical snapshots", () => {
  const snap = () => ({
    version: 17,
    docs: [{ _id: "d_1", _path: "a.md", _hash: "aa", head: "r_1", created_at: "t0", updated_at: "t1" }],
    blocks: [{ _id: "b_1", doc: "d_1", parent: null, ordinal: 0, hash: "11" }, { _id: "b_2", doc: "d_1", parent: "b_1", ordinal: 1, hash: "22" }],
    properties: ['{"path":"a.md","key":"title"}'],
    links: ['{"path":"a.md","predicate":"links_to"}'],
    claims: 5,
    pending: [{ path: "a.md", kind: "write", from_path: null, doc_id: "d_1" }],
    bytes: null,
  });
  assert.deepEqual(diffSnapshots(snap(), snap()), []);
  const after = snap();
  after.docs[0]._hash = "bb";
  after.blocks[1].parent = null;
  after.blocks[1].ordinal = 2;
  after.properties = [];
  after.links.push('{"path":"a.md","predicate":"extra"}');
  after.claims = 4;
  after.pending = [];
  after.bytes = { "a.md": "# A\n" };
  const kinds = diffSnapshots(snap(), after).map((d) => d.kind).sort();
  assert.deepEqual(kinds, ["block_ordinal", "block_parent", "bytes_hash", "claims", "hash", "link_extra", "pending_lost", "property_missing"]);
  // A 16.x BEFORE carries no timestamps: they are not compared.
  const b16 = snap();
  b16.docs[0].created_at = null;
  b16.docs[0].updated_at = null;
  const a17 = snap();
  a17.docs[0].created_at = "x";
  assert.deepEqual(diffSnapshots(b16, a17), []);
});

// ---------------------------------------------------------------- a 16.x database from the spec's pre-state

/** The one pre-17 pre-state spec/store authors, as a workspace database at `user_version` 16. */
function v16Workspace(tmp) {
  const cases = JSON.parse(readFileSync(join(ROOT, "spec", "store", "cases", "migrations.json"), "utf8")).cases;
  const c = cases.find((x) => x.name === "v16-to-v17-heads-inline-bytes-time");
  assert.ok(c, "the v16 migration fixture");
  const ws = join(tmp, "ws16");
  mkdirSync(join(ws, ".omgbase"), { recursive: true });
  const db = new Database(join(ws, ".omgbase", "omgbase.db"));
  for (const sql of c.setup) db.exec(sql);
  // The pre-state is partial (spec/store §9.3): it carries neither the sync
  // registry nor the derived tables a real 16.x database has. The tables whose
  // DDL is unchanged since 16.x are added empty from the current core DDL (never
  // a 17-only table: the migration creates those), the sync registry from its DDL.
  db.exec(SYNC_DDL);
  const UNCHANGED_SINCE_16 = new Set(["external_nodes", "nodes", "sections", "doc_edges", "file_stats", "blocks_fts", "nodes_fts", "dispositions", "archives"]);
  for (const stmt of `${DDL}\n${HISTORY_DDL}`.split(/;\s*\n/)) {
    const m = /CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/.exec(stmt) ?? /CREATE INDEX IF NOT EXISTS \w+\s+ON (\w+)/.exec(stmt);
    if (m && UNCHANGED_SINCE_16.has(m[1])) db.exec(`${stmt};`);
  }
  // A real 16.x database has its leaves indexed (spec/search §1.1) — and an
  // older one every block, the tombstoned b_3 included: FTS5's `rebuild` over
  // the content table indexes all three rows, the state finding F2 found.
  db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')");
  db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  db.pragma(`user_version = ${c.user_version}`);
  db.close();
  return ws;
}

test("a 16.x database: copied, snapshotted schema-aware, migrated to 17, the maps and rows preserved, the pending rows kept, the FTS index clean, the fake hash named by legacy_bytes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qualify-test-"));
  try {
    const ws = v16Workspace(tmp);
    const before = snapshotRows(join(ws, ".omgbase", "omgbase.db"));
    assert.equal(before.version, 16);
    assert.deepEqual(before.docs.map((d) => [d._id, d._path, d.head]), [["d_1", "a.md", "r_2"]]);
    assert.deepEqual(before.blocks.map((b) => b._id), ["b_1", "b_2"]);
    assert.equal(before.pending.length, 2);
    assert.equal(before.tombstoned_blocks, 1);
    assert.equal(before.legacy_bytes, 0);
    const report = await qualify({ workspace: ws, compositions: false, keep: false }, quiet);
    assert.equal(report.before.version, 16);
    assert.equal(report.after.ts.version, 17);
    assert.equal(report.after.ts.docs, 1);
    assert.equal(report.after.ts.blocks, 2);
    assert.equal(report.after.ts.tombstoned_blocks, 0, "17.3 (D2 step two): the migration leaves no tombstoned block row");
    assert.equal(report.after.ts.pending, 2, "the pre-migration pending rows are still present (no filesystem root to replay them into)");
    assert.ok(report.after.ts.claims >= 10, `claims backfilled (${report.after.ts.claims})`);
    // F2: the index built over every block (b_3 included) comes out holding exactly the live leaves.
    const check = (name) => report.after.ts.doctor.checks.find((c) => c.name === name);
    assert.equal(check("fts rows == live leaf blocks").ok, true, JSON.stringify(check("fts rows == live leaf blocks")));
    // The authored pre-state carries FAKE file hashes (X'06'), so the only diff the
    // tool may report is the hash-level byte check; every id/parent/order/property/
    // link row and every pending row must be preserved — and the fidelity check of
    // step 17 (16) names the document (spec/store §5.11): `legacy_bytes` 1.
    const kinds = [...new Set(report.diff.map((d) => d.kind))];
    assert.deepEqual(kinds, ["bytes_hash"], JSON.stringify(report.diff));
    assert.equal(report.diff.length, 1);
    assert.equal(report.after.ts.legacy_bytes, 1);
    assert.equal(check("bytes reproducible").ok, false);
    assert.equal(report.cas?.stale_refused, true, JSON.stringify(report.cas));
    assert.equal(report.cas?.fresh_accepted, true, JSON.stringify(report.cas));
    assert.deepEqual(report.recovery, { skipped: "no filesystem root" });
    assert.deepEqual(report.copy, { roots: [], files_available: true });
    assert.equal(report.ok, false, "the authored hashes fail the byte check — a real database passes it");
    assert.ok(sizeTable(report).includes("| before |"));
    // The original was never written.
    const orig = statSync(join(ws, ".omgbase", "omgbase.db"));
    assert.equal(snapshotRows(join(ws, ".omgbase", "omgbase.db")).version, 16);
    assert.ok(orig.size > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a database with no docs table is reported as no workspace (F4), nothing crashes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qualify-test-"));
  try {
    const ws = join(tmp, "toy");
    mkdirSync(join(ws, ".omgbase"), { recursive: true });
    const db = new Database(join(ws, ".omgbase", "omgbase.db"));
    db.exec("CREATE TABLE only_this (x TEXT)");
    db.pragma("user_version = 17");
    db.close();
    const report = await qualify({ workspace: ws, compositions: false, keep: false }, quiet);
    assert.equal(report.ok, false);
    assert.equal(report.reason, "not an omgbase workspace (no docs table; user_version 17)");
    assert.equal(report.before, null);
    // The CLI entry exits 2 with the reason.
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "qualify", "migrate-copy.mjs"), "--workspace", ws], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, reason: "not an omgbase workspace (no docs table; user_version 17)" });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- a 17.x workspace from the baseline harness

/** A small workspace built by `scripts/baseline/modular-core-baseline.mjs --keep` (the harness needs at least 22 documents); its `fs` source root is the sibling `src` tree, OUTSIDE the workspace directory. */
function harnessWorkspace(tmp) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "baseline", "modular-core-baseline.mjs"), "--engine", "ts", "--docs", "24", "--edits", "2", "--keep", "--out", join(tmp, "baseline-out")], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const kept = /kept (\S+)/.exec(r.stderr);
  assert.ok(kept, `no "kept <dir>" line in:\n${r.stderr.slice(-1000)}`);
  const ws = join(kept[1], "ws");
  assert.ok(existsSync(join(ws, ".omgbase", "omgbase.db")));
  return { ws, kept: kept[1] };
}

const stat = (p) => { try { const s = statSync(p); return [s.size, s.mtimeMs]; } catch { return null; } };

test("a 17.x workspace from the baseline harness: no diff, CAS and recovery hold, the four compositions read alike and are sized; the original is untouched", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qualify-test-"));
  let kept = null;
  try {
    const h = harnessWorkspace(tmp);
    kept = h.kept;
    const dbPath = join(h.ws, ".omgbase", "omgbase.db");
    const origDb = stat(dbPath);
    const origWal = stat(`${dbPath}-wal`);
    const out = join(tmp, "report.json");
    // The harness's source root lies outside the workspace: `--with-files` copies it beside the copied database and the copy's source is re-pointed at it.
    const report = await qualify({ workspace: h.ws, compositions: true, withFiles: true, keep: false, rustBin: RUST_BIN, out }, quiet);
    assert.equal(report.before.version, 17);
    assert.equal(report.after.ts.version, 17);
    assert.ok(report.before.docs >= 24, `${report.before.docs} docs`);
    assert.equal(report.after.ts.docs, report.before.docs);
    assert.equal(report.after.ts.blocks, report.before.blocks);
    assert.deepEqual(report.diff, []);
    assert.equal(report.after.ts.doctor.ok, true);
    assert.equal(report.after.ts.legacy_bytes, 0);
    assert.equal(report.copy.roots.length, 1);
    assert.equal(report.copy.roots[0].inside, false);
    assert.equal(report.copy.roots[0].copied, true);
    assert.ok(report.copy.roots[0].bytes > 0);
    assert.equal(report.copy.files_available, true);
    assert.equal(report.cas.stale_refused, true);
    assert.equal(report.cas.fresh_accepted, true);
    assert.equal(report.recovery.noop, true, JSON.stringify(report.recovery));
    assert.equal(report.compositions.length, 4);
    assert.deepEqual(report.compositions.map((c) => c.name), ["full", "history", "semantic", "core"]);
    for (const c of report.compositions) {
      assert.equal(c.reads_equal_after, true, `${c.name}: ${JSON.stringify(c.read_diff)}`);
      assert.equal(c.doctor_ok, true, c.name);
      assert.equal(c.cas.stale_refused && c.cas.fresh_accepted, true, c.name);
      assert.equal(c.recovery.noop, true, c.name);
      assert.equal(c.ok, true, c.name);
    }
    const byName = Object.fromEntries(report.compositions.map((c) => [c.name, c]));
    assert.equal(byName.full.capabilities.history.state, "enabled");
    assert.equal(byName.history.capabilities.semantic.state, "disabled");
    assert.equal(byName.semantic.capabilities.history.state, "disabled");
    assert.equal(byName.core.capabilities.history.state, "disabled");
    assert.ok(byName.full.sizes.categories.history > 0, "the full composition keeps its history bytes");
    assert.equal(byName.semantic.sizes.categories.history, 0, "history off + purged: no history bytes");
    assert.equal(byName.core.sizes.categories.history, 0);
    assert.ok(byName.core.sizes.file.total < byName.full.sizes.file.total, "the core composition is the smallest database");
    if (RUST_BIN) {
      assert.equal(report.compatible_open.rust.opened, true);
      assert.equal(report.compatible_open.rust.schema_agrees, true);
      assert.equal(report.compatible_open.rust.reads_agree, true, JSON.stringify(report.compatible_open));
    }
    assert.equal(report.ok, true);
    const table = sizeTable(report);
    assert.equal(table.split("\n").filter((l) => l.startsWith("| ")).length, 2 + 2 + 4);
    assert.ok(existsSync(out));
    assert.equal(JSON.parse(readFileSync(out, "utf8")).ok, true);
    // The original workspace's database and WAL were not written, nor its source tree.
    assert.deepEqual(stat(dbPath), origDb);
    assert.deepEqual(stat(`${dbPath}-wal`), origWal);

    // Without `--with-files` the outside root is replaced by an empty directory: nothing can reach the original tree; recovery is skipped, everything else holds.
    const bare = await qualify({ workspace: h.ws, compositions: false, keep: false }, quiet);
    assert.equal(bare.copy.roots[0].copied, false);
    assert.equal(bare.copy.files_available, false);
    assert.deepEqual(bare.recovery, { skipped: "files not copied (pass --with-files)" });
    assert.deepEqual(bare.diff, []);
    assert.equal(bare.after.ts.doctor.ok, true);
    assert.equal(bare.ok, true);
    assert.deepEqual(stat(dbPath), origDb);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (kept) rmSync(kept, { recursive: true, force: true });
  }
});

test("a legacy document in a 17.x workspace: the open names it, --repair restores its rows from the copied file, the report is green", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qualify-test-"));
  let kept = null;
  try {
    const h = harnessWorkspace(tmp);
    kept = h.kept;
    // A database-only copy of the harness workspace (as 5b's copies are), with
    // one document's separators erased — the rows a 16 → 17 migration of a
    // pre-v6 document produces (spec/store §5.11). Its source root still names
    // the harness's tree, outside this directory.
    const dbonly = join(tmp, "dbonly");
    mkdirSync(join(dbonly, ".omgbase"), { recursive: true });
    copyFileSync(join(h.ws, ".omgbase", "omgbase.db"), join(dbonly, ".omgbase", "omgbase.db"));
    if (existsSync(join(h.ws, ".omgbase", "omgbase.db-wal"))) copyFileSync(join(h.ws, ".omgbase", "omgbase.db-wal"), join(dbonly, ".omgbase", "omgbase.db-wal"));
    const raw = new Database(join(dbonly, ".omgbase", "omgbase.db"));
    raw.pragma("journal_mode = WAL");
    const doc = raw.prepare("SELECT d.doc_id FROM docs d WHERE d.deleted_at IS NULL AND (SELECT count(*) FROM blocks b WHERE b.doc_id = d.doc_id AND b.parent_block IS NULL) >= 3 ORDER BY d.path LIMIT 1").get();
    assert.ok(doc, "a document with several top-level blocks");
    raw.prepare("UPDATE blocks SET trivia = NULL, trivia_hash = NULL WHERE doc_id = ?").run(doc.doc_id);
    raw.close();
    const origDb = stat(join(dbonly, ".omgbase", "omgbase.db"));

    // Without `--repair`: the migration (here the on-open finish step) raises `legacy_bytes`, doctor fails on it, the report is red.
    const red = await qualify({ workspace: dbonly, compositions: false, withFiles: true, keep: false }, quiet);
    assert.equal(red.after.ts.legacy_bytes, 1);
    assert.equal(red.after.ts.doctor.ok, false);
    assert.deepEqual(red.diff.map((d) => d.kind), ["bytes_hash"]);
    assert.equal(red.repair, null);
    assert.equal(red.ok, false);

    // With `--repair` (and the files): the sweep repairs the rows, doctor is green, no diff.
    const green = await qualify({ workspace: dbonly, compositions: true, withFiles: true, repair: true, keep: false, rustBin: RUST_BIN }, quiet);
    assert.deepEqual(green.repair, { legacy_bytes_before: 1, repaired: 1, remaining: 0, sync_exit: 0 });
    assert.equal(green.after.ts.legacy_bytes, 0);
    assert.equal(green.after.ts.doctor.ok, true);
    assert.deepEqual(green.diff, []);
    assert.equal(green.recovery.noop, true);
    for (const c of green.compositions) assert.equal(c.ok, true, `${c.name}: ${JSON.stringify(c.read_diff)}`);
    assert.equal(green.ok, true);

    // `--repair` without the files cannot repair and says so.
    const nofiles = await qualify({ workspace: dbonly, compositions: false, repair: true, keep: false }, quiet);
    assert.equal(nofiles.repair.error, "no files to repair from (pass --with-files)");
    assert.equal(nofiles.repair.remaining, 1);
    assert.equal(nofiles.ok, false);

    assert.deepEqual(stat(join(dbonly, ".omgbase", "omgbase.db")), origDb, "the database-only copy was never written");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (kept) rmSync(kept, { recursive: true, force: true });
  }
});

test("copyWorkspace re-points an inside root at the copy and never opens the original", () => {
  const tmp = mkdtempSync(join(tmpdir(), "qualify-test-"));
  try {
    const ws = join(tmp, "ws");
    mkdirSync(join(ws, ".omgbase"), { recursive: true });
    mkdirSync(join(ws, "notes"));
    const db = new Database(join(ws, ".omgbase", "omgbase.db"));
    db.exec(SYNC_DDL);
    db.exec("INSERT INTO adapters (name, command, args) VALUES ('fs', 'omgbase-fs-adapter', '[]')");
    db.prepare("INSERT INTO sources (source_id, name, adapter, config, env) VALUES ('src_1', 'n', 'fs', ?, '{}')").run(JSON.stringify({ root: join(ws, "notes") }));
    db.pragma("user_version = 16");
    db.close();
    const before = stat(join(ws, ".omgbase", "omgbase.db"));
    const dest = join(tmp, "copy");
    const { dbPath, roots } = copyWorkspace(ws, dest);
    assert.deepEqual(roots, [{ source: "src_1", inside: true, copied: false, bytes: 0, available: true }]);
    const copy = new Database(dbPath, { readonly: true });
    assert.deepEqual(JSON.parse(copy.prepare("SELECT config FROM sources").get().config), { root: join(dest, "notes") });
    copy.close();
    assert.deepEqual(stat(join(ws, ".omgbase", "omgbase.db")), before);
    assert.equal(existsSync(join(ws, ".omgbase", "omgbase.db-wal")), false, "the original was not opened");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
