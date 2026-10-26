// node --test scripts/qualify/migrate-copy.test.mjs
//
// The qualification script end to end (modular-core Phase 5a): on a 16.x
// database extracted from `spec/store/cases/migrations.json` (the one
// pre-17 pre-state the spec authors) and on a 17.x workspace built by the
// baseline harness, with the four compositions. Needs `pnpm build` (the TS
// CLI and core dist); the Rust half runs when a built `omgbase` binary exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSITION_VERBS, cliOf, diffSnapshots, parseArgs, qualify, sizeTable, snapshotRows } from "./migrate-copy.mjs";

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
  const o = parseArgs(["--workspace", "/w", "--rust-bin", "/r", "--compositions", "--keep", "--before-bin", "/old/omg"]);
  assert.equal(o.workspace, "/w");
  assert.equal(o.rustBin, "/r");
  assert.equal(o.beforeBin, "/old/omg");
  assert.equal(o.compositions, true);
  assert.equal(o.keep, true);
  assert.deepEqual(cliOf("/x/main.js"), [process.execPath, "/x/main.js"]);
  assert.deepEqual(cliOf("/x/omgbase"), ["/x/omgbase"]);
  assert.deepEqual(Object.keys(COMPOSITION_VERBS), ["full", "history", "semantic", "core"]);
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
  // A real 16.x database has its live leaves indexed (spec/search §1.1); an
  // external-content FTS table with an empty index would answer the tombstone's
  // `delete` with "database disk image is malformed".
  db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild')");
  db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  db.pragma(`user_version = ${c.user_version}`);
  db.close();
  return ws;
}

test("a 16.x database: copied, snapshotted schema-aware, migrated to 17, the maps and rows preserved, the pending rows kept", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qualify-test-"));
  try {
    const ws = v16Workspace(tmp);
    const before = snapshotRows(join(ws, ".omgbase", "omgbase.db"));
    assert.equal(before.version, 16);
    assert.deepEqual(before.docs.map((d) => [d._id, d._path, d.head]), [["d_1", "a.md", "r_2"]]);
    assert.deepEqual(before.blocks.map((b) => b._id), ["b_1", "b_2"]);
    assert.equal(before.pending.length, 2);
    assert.equal(before.tombstoned_blocks, 1);
    const report = await qualify({ workspace: ws, compositions: false, keep: false }, quiet);
    assert.equal(report.before.version, 16);
    assert.equal(report.after.ts.version, 17);
    assert.equal(report.after.ts.docs, 1);
    assert.equal(report.after.ts.blocks, 2);
    assert.equal(report.after.ts.tombstoned_blocks, 0, "17.3 (D2 step two): the migration leaves no tombstoned block row");
    assert.equal(report.after.ts.pending, 2, "the pre-migration pending rows are still present (no filesystem root to replay them into)");
    assert.ok(report.after.ts.claims >= 10, `claims backfilled (${report.after.ts.claims})`);
    // The authored pre-state carries FAKE file hashes (X'06'), so the only diff the
    // tool may report is the hash-level byte check; every id/parent/order/property/
    // link row and every pending row must be preserved.
    const kinds = [...new Set(report.diff.map((d) => d.kind))];
    assert.deepEqual(kinds, ["bytes_hash"], JSON.stringify(report.diff));
    assert.equal(report.diff.length, 1);
    assert.equal(report.cas?.stale_refused, true, JSON.stringify(report.cas));
    assert.equal(report.cas?.fresh_accepted, true, JSON.stringify(report.cas));
    assert.deepEqual(report.recovery, { skipped: "no filesystem root" });
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

// ---------------------------------------------------------------- a 17.x workspace from the baseline harness

/** A small workspace built by `scripts/baseline/modular-core-baseline.mjs --keep` (the harness needs at least 22 documents). */
function harnessWorkspace(tmp) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "baseline", "modular-core-baseline.mjs"), "--engine", "ts", "--docs", "24", "--edits", "2", "--keep", "--out", join(tmp, "baseline-out")], { encoding: "utf8", maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const kept = /kept (\S+)/.exec(r.stderr);
  assert.ok(kept, `no "kept <dir>" line in:\n${r.stderr.slice(-1000)}`);
  const ws = join(kept[1], "ws");
  assert.ok(existsSync(join(ws, ".omgbase", "omgbase.db")));
  return { ws, kept: kept[1] };
}

test("a 17.x workspace from the baseline harness: no diff, CAS and recovery hold, the four compositions read alike and are sized; the original is untouched", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "qualify-test-"));
  let kept = null;
  try {
    const h = harnessWorkspace(tmp);
    kept = h.kept;
    const dbPath = join(h.ws, ".omgbase", "omgbase.db");
    const stat = (p) => { try { const s = statSync(p); return [s.size, s.mtimeMs]; } catch { return null; } };
    const origDb = stat(dbPath);
    const origWal = stat(`${dbPath}-wal`);
    const out = join(tmp, "report.json");
    const report = await qualify({ workspace: h.ws, compositions: true, keep: false, rustBin: RUST_BIN, out }, quiet);
    assert.equal(report.before.version, 17);
    assert.equal(report.after.ts.version, 17);
    assert.ok(report.before.docs >= 24, `${report.before.docs} docs`);
    assert.equal(report.after.ts.docs, report.before.docs);
    assert.equal(report.after.ts.blocks, report.before.blocks);
    assert.deepEqual(report.diff, []);
    assert.equal(report.after.ts.doctor.ok, true);
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
    // The original workspace's database and WAL were not written.
    assert.deepEqual(stat(dbPath), origDb);
    assert.deepEqual(stat(`${dbPath}-wal`), origWal);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (kept) rmSync(kept, { recursive: true, force: true });
  }
});
