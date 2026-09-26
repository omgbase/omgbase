// Fixture bridge for spec/store (README §9). Pure pieces, no vitest:
//
//   schemaFingerprint()     a database → the §9.2 fingerprint (tables, indexes, FKs, user_version)
//   runSchemaCase()         the fingerprint of a fresh `:memory:` store
//   runMigrationCase()      §9.3: authored pre-state → open with the reference → projection (or the refusal)
//   runObserveCase()        §9.4: run an observation script through the production observe path,
//                           check the §8 invariants after every observe step, project the tables
//   checkInvariants()       README §8 I1–I8 on a store
//   projectStore()          the §9.4 table projection (ordering, hex hashes, JSON attrs/detail)
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//
// Nothing here decides anything about the store; it drives the same code paths
// production uses (`observeBatch`, `sweepResurrectionPool`, `new Store`) with the
// fixture minter installed and re-expresses the resulting rows so the two
// implementations can be compared.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { sequentialMinter, setIdMinter } from "../../src/core/ids.js";
import { sha256 } from "../../src/core/hash.js";
import { reconstructContent, readDocumentAtRevision } from "../../src/core/read/document.js";
import { sweepResurrectionPool } from "../../src/core/store/gc.js";
import { observeBatch, type BatchOutcome } from "../../src/sync/observe.js";
import { CONFIG_KEYS, toReconcileConfig, deepEqualTol, type FixtureConfig } from "../reconcile/fixture.js";

export { deepEqualTol };

// ---- fixture shapes ------------------------------------------------------------

/** A projected SQLite value: INTEGER/REAL → number, TEXT → string, BLOB → hex string, NULL → null. */
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;
/** A row with JSON-valued columns decoded (`blocks.attrs`, `dispositions.detail`). */
export type JsonRow = Record<string, SqlValue | Record<string, unknown>>;

// §9.2 schema fingerprint.
export interface SchemaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
export interface SchemaForeignKey {
  from: string;
  table: string;
  to: string;
}
export interface SchemaIndex {
  table: string;
  unique: number;
  origin: string;
  partial: number;
  columns: string[];
}
export interface SchemaFingerprint {
  user_version: number;
  tables: Record<string, { columns: SchemaColumn[]; foreign_keys: SchemaForeignKey[] }>;
  indexes: Record<string, SchemaIndex>;
}
export interface SchemaCase {
  name: string;
  notes?: string;
  expect: SchemaFingerprint;
}

// §9.3 migrations.
export interface MigrationExpect {
  user_version: number;
  /** every table → column names in cid order */
  tables: Record<string, string[]>;
  /** the tables named in the case's `rows` → full contents, ORDER BY rowid */
  rows: Record<string, Row[]>;
}
/** The opener refused the database (README §1 step 3); `error` is the exact message. */
export interface MigrationRefusal {
  error: string;
}
export interface MigrationCase {
  name: string;
  notes?: string;
  setup: string[];
  user_version: number;
  rows: string[];
  expect: MigrationExpect | MigrationRefusal;
}

// §9.4 observation scripts.
export interface ObserveItem {
  path: string;
  /** the exact file content, or null when the path is gone */
  source: string | null;
}
export type Step = { observe: { ts: string; items: ObserveItem[] } } | { sweep: { ts: string } };

export interface ObservedOutcome {
  path: string;
  echo: boolean;
  doc: string;
  commit: string | null;
  rev: string | null;
  converged: boolean;
  conflicted: boolean;
  dispositions: Record<string, number>;
}
export interface GoneOutcome {
  path: string;
  deleted: boolean;
  doc: string | null;
}
export type StepOutcome = (ObservedOutcome | GoneOutcome)[] | { swept: number };

export interface Projection {
  steps: StepOutcome[];
  docs: Row[];
  commits: Row[];
  revisions: Row[];
  blobs: Row[];
  tree_nodes: Row[];
  blocks: JsonRow[];
  dispositions: JsonRow[];
  block_changes: Row[];
  resurrection_pool: Row[];
  sections: Row[];
}
/** The projected tables, in the order the fixture emits them. */
export const PROJECTED_TABLES = [
  "docs", "commits", "revisions", "blobs", "tree_nodes", "blocks",
  "dispositions", "block_changes", "resurrection_pool", "sections",
] as const;

export interface ObserveCase {
  name: string;
  notes?: string;
  config?: FixtureConfig;
  steps: Step[];
  expect: Projection;
}

export type FixtureCase = SchemaCase | MigrationCase | ObserveCase;

export interface FixtureFile {
  suite: string;
  cases: FixtureCase[];
}

export type CaseKind = "schema" | "migration" | "observe";

/** The three suite kinds, told apart by the file stem (README §9.1). */
export function suiteKind(suite: string): CaseKind {
  if (suite === "schema") return "schema";
  if (suite === "migrations") return "migration";
  return "observe";
}

export const CASE_KEYS: Record<CaseKind, readonly string[]> = {
  schema: ["name", "notes", "expect"],
  migration: ["name", "notes", "setup", "user_version", "rows", "expect"],
  observe: ["name", "notes", "config", "steps", "expect"],
};

/** The repo every observation case runs in (README §9.4 "Inputs"). */
export const FIXTURE_REPO_SLUG = "fixture";
/** README §2.4: RFC 3339 UTC, exactly three fractional digits, `Z`. */
export const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

// ---- helpers ------------------------------------------------------------------

function hex(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v.toString("hex");
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  throw new Error(`expected a BLOB, got ${typeof v}`);
}

/** A raw better-sqlite3 row → fixture row: blobs as hex, everything else verbatim. */
function toRow(raw: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) out[k] = hex(v);
    else if (v === null || typeof v === "string" || typeof v === "number") out[k] = v;
    else if (typeof v === "bigint") out[k] = Number(v);
    else throw new Error(`column ${k}: unprojectable value ${String(v)}`);
  }
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** README §2.4: `ts + 30 days`, formatted the same way. */
export function expiresAfter(ts: string): string {
  return new Date(Date.parse(ts) + THIRTY_DAYS_MS).toISOString();
}

/** Run `body` with the fixture minter installed (README §2.2), restoring production afterwards. */
function withFixtureMinter<T>(body: () => T): T {
  setIdMinter(sequentialMinter());
  try {
    return body();
  } finally {
    setIdMinter(null);
  }
}

// ---- §9.2 schema fingerprint ------------------------------------------------------

type Db = Database.Database;

function userVersion(db: Db): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function tableNames(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

function columnNames(db: Db, table: string): string[] {
  return (db.pragma(`table_info("${table}")`) as { name: string }[]).map((c) => c.name);
}

/** README §3.3 / §9.2: every table's columns and foreign keys, every index, `user_version`. */
export function schemaFingerprint(db: Db): SchemaFingerprint {
  const tables: SchemaFingerprint["tables"] = {};
  const indexes: SchemaFingerprint["indexes"] = {};
  for (const table of tableNames(db)) {
    const columns = (db.pragma(`table_info("${table}")`) as SchemaColumn[]).map((c) => ({
      cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
    }));
    const fks = (db.pragma(`foreign_key_list("${table}")`) as { from: string; table: string; to: string }[]).map((f) => ({
      from: f.from, table: f.table, to: f.to,
    }));
    tables[table] = { columns, foreign_keys: fks };
    for (const ix of db.pragma(`index_list("${table}")`) as { name: string; unique: number; origin: string; partial: number }[]) {
      const cols = (db.pragma(`index_info("${ix.name}")`) as { seqno: number; name: string | null }[])
        .sort((a, b) => a.seqno - b.seqno)
        .map((c) => c.name ?? "");
      indexes[ix.name] = { table, unique: ix.unique, origin: ix.origin, partial: ix.partial, columns: cols };
    }
  }
  const sortedIndexes: SchemaFingerprint["indexes"] = {};
  for (const k of Object.keys(indexes).sort()) sortedIndexes[k] = indexes[k]!;
  return { user_version: userVersion(db), tables, indexes: sortedIndexes };
}

/** The fingerprint of a fresh `:memory:` store. */
export function runSchemaCase(): SchemaFingerprint {
  const store = new Store({ path: ":memory:" });
  try {
    return schemaFingerprint(store.db);
  } finally {
    store.close();
  }
}

// ---- §9.3 migrations ---------------------------------------------------------------

export type MigrationCaseInput = Omit<MigrationCase, "expect">;

/**
 * Run `setup` on an empty file database, pin `user_version`, close, then open it
 * with the reference (which migrates) under the fixture minter. Returns the
 * projection — or `{ error }` when the opener refused.
 */
export function runMigrationCase(c: MigrationCaseInput): MigrationExpect | MigrationRefusal {
  const dir = mkdtempSync(join(tmpdir(), "omgbase-store-spec-"));
  const path = join(dir, "case.db");
  try {
    const raw = new Database(path);
    try {
      for (const stmt of c.setup) raw.exec(stmt);
      raw.pragma(`user_version = ${c.user_version}`);
    } finally {
      raw.close();
    }
    return withFixtureMinter(() => {
      let store: Store;
      try {
        store = new Store({ path });
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
      try {
        const db = store.db;
        const tables: Record<string, string[]> = {};
        for (const t of tableNames(db)) tables[t] = columnNames(db, t);
        const rows: Record<string, Row[]> = {};
        for (const t of c.rows) {
          rows[t] = (db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Record<string, unknown>[]).map(toRow);
        }
        return { user_version: userVersion(db), tables, rows };
      } finally {
        store.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- §9.4 observation scripts --------------------------------------------------------

export type ObserveCaseInput = Omit<ObserveCase, "expect">;

export interface ObserveEvaluation {
  expect: Projection;
  /** §8 invariant violations, prefixed with the step they were found after (empty = fine). */
  problems: string[];
}

function toOutcome(o: BatchOutcome): ObservedOutcome | GoneOutcome {
  if (o.kind === "deleted") return { path: o.path, deleted: o.docId !== null, doc: o.docId };
  const dispositions: Record<string, number> = {};
  for (const d of o.dispositions) dispositions[d.kind] = d.count;
  return { path: o.path, echo: o.echo, doc: o.docId, commit: o.commitId, rev: o.rev, converged: o.converged, conflicted: o.conflicted, dispositions };
}

/**
 * Run a case: fresh `:memory:` store, fixture minter, repo `rp_0` (slug
 * `fixture`), then every step through the production paths — `observeBatch`
 * for `observe` (a `source: null` item is a gone member), `sweepResurrectionPool`
 * for `sweep`. The §8 invariants are checked after every observe step and at the
 * end; the projection is taken after the last step.
 */
export function runObserveCase(c: ObserveCaseInput): ObserveEvaluation {
  const config = toReconcileConfig(c.config);
  return withFixtureMinter(() => {
    const store = new Store({ path: ":memory:" });
    try {
      const repoId = ensureRepo(store, FIXTURE_REPO_SLUG, null);
      const lastSource = new Map<string, string>();
      const steps: StepOutcome[] = [];
      const problems: string[] = [];
      c.steps.forEach((step, i) => {
        if ("observe" in step) {
          const items = step.observe.items.map((it) => ({ path: it.path, content: it.source }));
          const outcomes = observeBatch(store, repoId, items, step.observe.ts, { config });
          for (const it of step.observe.items) {
            if (it.source === null) lastSource.delete(it.path);
            else lastSource.set(it.path, it.source);
          }
          steps.push(outcomes.map(toOutcome));
          for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`after step ${i}: ${p}`);
        } else {
          steps.push({ swept: sweepResurrectionPool(store, step.sweep.ts) });
        }
      });
      for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`at end: ${p}`);
      return { expect: { steps, ...projectStore(store.db, repoId) }, problems };
    } finally {
      store.close();
    }
  });
}

// ---- projection (README §9.4 "Expect") ------------------------------------------------

interface BlockRaw {
  block_id: string;
  doc_id: string;
  parent_block: string | null;
  order_key: string;
  ordinal: number;
  depth: number;
  ancestor_path: string;
  type: string;
  attrs: string;
  text: string;
  raw_hash: Buffer;
  norm_hash: Buffer;
  trivia_hash: Buffer | null;
  created_commit: string;
  deleted_commit: string | null;
}

const BLOCK_COLUMNS = "block_id, doc_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, text, raw_hash, norm_hash, trivia_hash, created_commit, deleted_commit";

/** A doc's `blocks` rows in pre-order (children by `parent_block`, `ordinal` order); tombstoned rows included. */
function docBlocksPreorder(db: Db, docId: string, liveOnly: boolean): BlockRaw[] {
  const rows = db
    .prepare(`SELECT ${BLOCK_COLUMNS} FROM blocks WHERE doc_id = ? ${liveOnly ? "AND deleted_commit IS NULL" : ""} ORDER BY ordinal, block_id`)
    .all(docId) as BlockRaw[];
  const ids = new Set(rows.map((r) => r.block_id));
  const byParent = new Map<string | null, BlockRaw[]>();
  for (const r of rows) {
    const parent = r.parent_block !== null && ids.has(r.parent_block) ? r.parent_block : null;
    let list = byParent.get(parent);
    if (!list) byParent.set(parent, (list = []));
    list.push(r);
  }
  const out: BlockRaw[] = [];
  const walk = (parent: string | null): void => {
    for (const r of byParent.get(parent) ?? []) {
      out.push(r);
      walk(r.block_id);
    }
  };
  walk(null);
  return out;
}

function projectBlock(r: BlockRaw): JsonRow {
  return {
    block_id: r.block_id,
    doc_id: r.doc_id,
    parent_block: r.parent_block,
    order_key: r.order_key,
    ordinal: r.ordinal,
    depth: r.depth,
    ancestor_path: r.ancestor_path,
    type: r.type,
    attrs: JSON.parse(r.attrs) as Record<string, unknown>,
    text: r.text,
    raw_hash: hex(r.raw_hash)!,
    norm_hash: hex(r.norm_hash)!,
    trivia_hash: hex(r.trivia_hash),
    created_commit: r.created_commit,
    deleted_commit: r.deleted_commit,
  };
}

/** The §9.4 projection of the durable + pinned derived tables of one repo (`repo_id` omitted). */
export function projectStore(db: Db, repoId: string): Omit<Projection, "steps"> {
  const docs = (db
    .prepare("SELECT doc_id, path, format, current_rev, file_hash, conflicted, leading_trivia, frontmatter_trivia, deleted_commit FROM docs WHERE repo_id = ? ORDER BY path")
    .all(repoId) as Record<string, unknown>[]).map(toRow);
  const docIds = docs.map((d) => d.doc_id as string);

  const commits = (db
    .prepare("SELECT commit_id, seq, ts, origin, actor, reason, checkpoint_id, ops FROM commits WHERE repo_id = ? ORDER BY seq")
    .all(repoId) as Record<string, unknown>[]).map(toRow);
  const commitSeq = new Map(commits.map((c) => [c.commit_id as string, c.seq as number]));
  const seqOf = (commitId: string): number => commitSeq.get(commitId) ?? Number.MAX_SAFE_INTEGER;

  const revisions = (db
    .prepare(
      `SELECT r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.rendered_hash, r.path, r.commit_id
       FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?`,
    )
    .all(repoId) as Record<string, unknown>[])
    .map(toRow)
    .sort((a, b) => cmp(a.doc_id as string, b.doc_id as string) || (a.seq as number) - (b.seq as number));

  // blobs / tree_nodes are not repo-scoped; a fixture database holds one repo.
  const blobs = (db.prepare("SELECT hash, size, bytes FROM blobs").all() as { hash: Buffer; size: number; bytes: Buffer }[])
    .map((b) => ({ hash: hex(b.hash)!, size: b.size, bytes: b.bytes.toString("utf8") }))
    .sort((a, b) => cmp(a.hash, b.hash));
  const tree_nodes = (db.prepare("SELECT hash, entries FROM tree_nodes").all() as { hash: Buffer; entries: string }[])
    .map((t) => ({ hash: hex(t.hash)!, entries: t.entries }))
    .sort((a, b) => cmp(a.hash, b.hash));

  const blocks: Projection["blocks"] = [];
  for (const docId of docIds) for (const r of docBlocksPreorder(db, docId, false)) blocks.push(projectBlock(r));

  const byCommitBlockKind = (a: JsonRow, b: JsonRow): number =>
    seqOf(a.commit_id as string) - seqOf(b.commit_id as string) || cmp(a.block_id as string, b.block_id as string) || cmp(a.kind as string, b.kind as string);

  const dispositions = (db
    .prepare(
      `SELECT x.commit_id, x.block_id, x.kind, x.confidence, x.reason, x.matcher_v, x.detail
       FROM dispositions x JOIN commits c ON c.commit_id = x.commit_id WHERE c.repo_id = ?`,
    )
    .all(repoId) as Record<string, unknown>[])
    .map((r): JsonRow => ({ ...toRow({ ...r, detail: null }), detail: JSON.parse(r.detail as string) as Record<string, unknown> }))
    .sort(byCommitBlockKind);

  const block_changes = (db
    .prepare("SELECT bc.block_id, bc.commit_id, bc.kind FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE c.repo_id = ?")
    .all(repoId) as Record<string, unknown>[])
    .map(toRow)
    .sort(byCommitBlockKind);

  const resurrection_pool = (db
    .prepare("SELECT block_id, doc_id, raw_hash, norm_hash, type, deleted_commit, expires_ts FROM resurrection_pool WHERE repo_id = ?")
    .all(repoId) as Record<string, unknown>[])
    .map(toRow)
    .sort((a, b) => cmp(a.expires_ts as string, b.expires_ts as string) || cmp(a.block_id as string, b.block_id as string));

  const sections = (db
    .prepare("SELECT s.doc_id, s.heading_block, s.level, s.first_ordinal, s.last_ordinal FROM sections s JOIN docs d ON d.doc_id = s.doc_id WHERE d.repo_id = ?")
    .all(repoId) as Record<string, unknown>[])
    .map(toRow)
    .sort((a, b) => cmp(a.doc_id as string, b.doc_id as string) || (a.first_ordinal as number) - (b.first_ordinal as number));

  return { docs, commits, revisions, blobs, tree_nodes, blocks, dispositions, block_changes, resurrection_pool, sections };
}

// ---- invariants (README §8) --------------------------------------------------------------

/** One §4.1 entry: [block_id, raw_hash_hex, child_tree_hash_hex | null, type, attrs, trivia_hash_hex | null]. */
type Entry = [string, string, string | null, string, Record<string, unknown>, string | null];

function parseEntries(text: string): Entry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const e of parsed) {
    if (!Array.isArray(e) || e.length !== 6) return null;
    const [id, raw, child, type, attrs, trivia] = e as unknown[];
    if (typeof id !== "string" || typeof raw !== "string" || typeof type !== "string" || !isRecord(attrs)) return null;
    if (child !== null && typeof child !== "string") return null;
    if (trivia !== null && typeof trivia !== "string") return null;
  }
  return parsed as Entry[];
}

/**
 * README §8 I1–I8 on a store. `lastSource` is the last observed source per
 * live path (I1 needs the bytes the store is supposed to hold). Returns the
 * problems found (empty = every invariant holds).
 */
export function checkInvariants(store: Store, repoId: string, lastSource: ReadonlyMap<string, string>): string[] {
  const db = store.db;
  const problems: string[] = [];

  const blobRows = db.prepare("SELECT hash, bytes, size FROM blobs").all() as { hash: Buffer; bytes: Buffer; size: number }[];
  const blobHashes = new Set(blobRows.map((b) => b.hash.toString("hex")));
  const treeRows = db.prepare("SELECT hash, entries FROM tree_nodes").all() as { hash: Buffer; entries: string }[];
  const trees = new Map<string, Entry[]>();
  const treeHashes = new Set(treeRows.map((t) => t.hash.toString("hex")));
  const commits = db.prepare("SELECT commit_id, seq, ts FROM commits WHERE repo_id = ? ORDER BY ts, seq").all(repoId) as { commit_id: string; seq: number; ts: string }[];
  const commitById = new Map(commits.map((c) => [c.commit_id, c]));
  const docs = db
    .prepare("SELECT doc_id, path, current_rev, file_hash, deleted_commit FROM docs WHERE repo_id = ? ORDER BY path")
    .all(repoId) as { doc_id: string; path: string; current_rev: string | null; file_hash: Buffer | null; deleted_commit: string | null }[];
  const revisions = db
    .prepare("SELECT r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.rendered_hash, r.commit_id FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?")
    .all(repoId) as { rev_id: string; doc_id: string; seq: number; root_tree: Buffer; frontmatter_blob: Buffer | null; rendered_hash: Buffer; commit_id: string }[];
  const revById = new Map(revisions.map((r) => [r.rev_id, r]));

  // ---- I2 hash integrity --------------------------------------------------------
  for (const b of blobRows) {
    const h = b.hash.toString("hex");
    if (!sha256(b.bytes).equals(b.hash)) problems.push(`I2: blob ${h} hash != sha256(bytes)`);
    if (b.size !== b.bytes.length) problems.push(`I2: blob ${h} size ${b.size} != |bytes| ${b.bytes.length}`);
  }
  for (const t of treeRows) {
    const h = t.hash.toString("hex");
    if (!sha256(t.entries).equals(t.hash)) problems.push(`I2: tree_node ${h} hash != sha256(entries)`);
    const entries = parseEntries(t.entries);
    if (!entries) {
      problems.push(`I2: tree_node ${h} entries do not parse as §4.1`);
      continue;
    }
    trees.set(h, entries);
    for (const [id, raw, child, , , trivia] of entries) {
      if (!blobHashes.has(raw)) problems.push(`I2: tree_node ${h} entry ${id} raw_hash ${raw} not in blobs`);
      if (trivia !== null && !blobHashes.has(trivia)) problems.push(`I2: tree_node ${h} entry ${id} trivia_hash ${trivia} not in blobs`);
      if (child !== null && !treeHashes.has(child)) problems.push(`I2: tree_node ${h} entry ${id} child tree ${child} not in tree_nodes`);
    }
  }
  for (const r of revisions) {
    if (!treeHashes.has(r.root_tree.toString("hex"))) problems.push(`I2: revision ${r.rev_id} root_tree not in tree_nodes`);
    if (r.frontmatter_blob && !blobHashes.has(r.frontmatter_blob.toString("hex"))) problems.push(`I2: revision ${r.rev_id} frontmatter_blob not in blobs`);
  }

  // ---- I1 convergence, I3 blocks mirror the current revision ------------------------
  for (const d of docs) {
    if (d.deleted_commit !== null || d.current_rev === null) continue;
    const at = `doc ${d.doc_id} (${d.path})`;
    const rev = revById.get(d.current_rev);
    if (!rev) {
      problems.push(`I1: ${at} current_rev ${d.current_rev} is not a revision`);
      continue;
    }
    const source = lastSource.get(d.path);
    if (source === undefined) {
      problems.push(`I1: ${at} is live but no source was observed for its path`);
    } else {
      const want = sha256(source);
      if (!d.file_hash || !d.file_hash.equals(want)) problems.push(`I1: ${at} file_hash != sha256(source)`);
      if (!rev.rendered_hash.equals(want)) problems.push(`I1: ${at} rendered_hash != sha256(source)`);
      if (reconstructContent(db, d.doc_id) !== source) problems.push(`I1: ${at} reconstruct(doc) != source`);
      const atRev = readDocumentAtRevision(store, d.doc_id, d.current_rev);
      if (!atRev) problems.push(`I1: ${at} reconstruct at ${d.current_rev} returned nothing`);
      else {
        if (atRev.content !== source) problems.push(`I1: ${at} reconstruct at ${d.current_rev} != source`);
        if (!atRev.renderedHashMatch) problems.push(`I1: ${at} rendered_hash_match is false at the current revision`);
      }
    }

    // I3: live rows as a tree vs the revision's Merkle tree.
    const live = db.prepare(`SELECT ${BLOCK_COLUMNS} FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL`).all(d.doc_id) as BlockRaw[];
    const liveIds = new Set(live.map((r) => r.block_id));
    const children = new Map<string | null, BlockRaw[]>();
    for (const r of live) {
      let list = children.get(r.parent_block);
      if (!list) children.set(r.parent_block, (list = []));
      list.push(r);
    }
    for (const list of children.values()) list.sort((a, b) => cmp(a.order_key, b.order_key));
    for (const [parent] of children) {
      if (parent !== null && !liveIds.has(parent)) problems.push(`I3: ${at} live rows name a parent ${parent} that is not live`);
    }
    const compare = (treeHex: string | null, parent: BlockRaw | null, depth: number, ancestorPath: string): void => {
      const rows = children.get(parent?.block_id ?? null) ?? [];
      const entries = treeHex === null ? [] : trees.get(treeHex) ?? [];
      const where = parent ? `${at} under ${parent.block_id}` : `${at} top level`;
      if (rows.length !== entries.length) {
        problems.push(`I3: ${where}: ${rows.length} live rows vs ${entries.length} tree entries`);
        return;
      }
      rows.forEach((r, i) => {
        const [id, raw, child, type, attrs, trivia] = entries[i]!;
        if (r.block_id !== id) problems.push(`I3: ${where}[${i}]: block ${r.block_id} vs tree entry ${id}`);
        if (r.type !== type) problems.push(`I3: ${where}[${i}]: type ${r.type} vs ${type}`);
        if (r.raw_hash.toString("hex") !== raw) problems.push(`I3: ${where}[${i}]: raw_hash differs from the tree entry`);
        if ((r.trivia_hash ? r.trivia_hash.toString("hex") : null) !== trivia) problems.push(`I3: ${where}[${i}]: trivia_hash differs from the tree entry`);
        if (r.ordinal !== i) problems.push(`I3: ${where}[${i}]: ordinal ${r.ordinal} (order_key order says ${i})`);
        if (r.depth !== depth) problems.push(`I3: ${where}[${i}]: depth ${r.depth} != ${depth}`);
        if (r.ancestor_path !== ancestorPath) problems.push(`I3: ${where}[${i}]: ancestor_path ${r.ancestor_path} != ${ancestorPath}`);
        if (!sha256(r.text).equals(r.norm_hash)) problems.push(`I3: ${where}[${i}]: norm_hash != sha256(text)`);
        const diff = deepEqualTol(JSON.parse(r.attrs), attrs, 0);
        if (diff) problems.push(`I3: ${where}[${i}]: attrs differ from the tree entry (${diff})`);
        compare(child, r, depth + 1, `${ancestorPath}${r.block_id}/`);
      });
    };
    compare(rev.root_tree.toString("hex"), null, 0, "/");
  }

  // ---- I4 dense sequences --------------------------------------------------------------
  commits.forEach((c, i) => {
    if (c.seq !== i + 1) problems.push(`I4: commit ${c.commit_id} has seq ${c.seq} at position ${i + 1} in (ts, seq) order`);
  });
  for (const d of docs) {
    const revs = revisions.filter((r) => r.doc_id === d.doc_id).sort((a, b) => a.seq - b.seq);
    revs.forEach((r, i) => {
      if (r.seq !== i + 1) problems.push(`I4: revision ${r.rev_id} of ${d.doc_id} has seq ${r.seq}, expected ${i + 1}`);
    });
    if (revs.length > 0 && d.current_rev !== revs[revs.length - 1]!.rev_id) problems.push(`I4: doc ${d.doc_id} current_rev ${d.current_rev} is not its greatest-seq revision`);
    if (revs.length === 0 && d.current_rev !== null) problems.push(`I4: doc ${d.doc_id} has current_rev but no revisions`);
  }

  // ---- I5 nothing to collect -----------------------------------------------------------
  const markedTrees = new Set<string>();
  const markedBlobs = new Set<string>();
  const mark = (treeHex: string): void => {
    if (markedTrees.has(treeHex)) return;
    markedTrees.add(treeHex);
    for (const [, raw, child, , , trivia] of trees.get(treeHex) ?? []) {
      markedBlobs.add(raw);
      if (trivia !== null) markedBlobs.add(trivia);
      if (child !== null) mark(child);
    }
  };
  for (const r of revisions) {
    mark(r.root_tree.toString("hex"));
    if (r.frontmatter_blob) markedBlobs.add(r.frontmatter_blob.toString("hex"));
  }
  for (const h of treeHashes) if (!markedTrees.has(h)) problems.push(`I5: tree_node ${h} is unreachable from every revision`);
  for (const h of blobHashes) if (!markedBlobs.has(h)) problems.push(`I5: blob ${h} is unreachable from every revision`);

  // ---- I6 pool -----------------------------------------------------------------------
  const liveRowOf = db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_commit IS NULL");
  const pool = db.prepare("SELECT block_id, deleted_commit, expires_ts FROM resurrection_pool WHERE repo_id = ?").all(repoId) as { block_id: string; deleted_commit: string; expires_ts: string }[];
  for (const p of pool) {
    const c = commitById.get(p.deleted_commit);
    if (!c) problems.push(`I6: pool row ${p.block_id} names a missing commit ${p.deleted_commit}`);
    else if (p.expires_ts !== expiresAfter(c.ts)) problems.push(`I6: pool row ${p.block_id} expires_ts ${p.expires_ts} != ${c.ts} + 30 days`);
    if (liveRowOf.get(p.block_id)) problems.push(`I6: pool row ${p.block_id} has a live blocks row`);
  }

  // ---- I7 dispositions ----------------------------------------------------------------
  // Every disposition names an existing commit. For each live doc's CURRENT
  // commit — the one state the rows can still vouch for — a disposition on a
  // block that survives the commit (every kind but `deleted` / `merged_into`)
  // names a live row of that doc, and a `deleted` / `merged_into` one names no
  // live row of that doc.
  const dispositions = db
    .prepare("SELECT x.commit_id, x.block_id, x.kind FROM dispositions x JOIN commits c ON c.commit_id = x.commit_id WHERE c.repo_id = ?")
    .all(repoId) as { commit_id: string; block_id: string; kind: string }[];
  for (const x of dispositions) if (!commitById.has(x.commit_id)) problems.push(`I7: disposition ${x.block_id}/${x.kind} names a missing commit ${x.commit_id}`);
  for (const d of docs) {
    if (d.deleted_commit !== null || d.current_rev === null) continue;
    const rev = revById.get(d.current_rev);
    if (!rev) continue;
    for (const x of dispositions) {
      if (x.commit_id !== rev.commit_id || x.block_id === "DOC") continue;
      const row = liveRowOf.get(x.block_id) as { doc_id: string } | undefined;
      const gone = x.kind === "deleted" || x.kind === "merged_into";
      if (gone && row?.doc_id === d.doc_id) problems.push(`I7: ${x.kind} block ${x.block_id} of ${x.commit_id} is still live in ${d.doc_id}`);
      if (!gone && row?.doc_id !== d.doc_id) problems.push(`I7: ${x.kind} block ${x.block_id} of ${x.commit_id} is not live in ${d.doc_id}`);
    }
  }

  // ---- I8 rebuild equivalence -------------------------------------------------------
  for (const d of docs) {
    if (d.deleted_commit !== null) continue;
    const tops = db
      .prepare("SELECT block_id, ordinal, type, json_extract(attrs, '$.level') AS level FROM blocks WHERE doc_id = ? AND parent_block IS NULL AND deleted_commit IS NULL ORDER BY ordinal")
      .all(d.doc_id) as { block_id: string; ordinal: number; type: string; level: number | null }[];
    const maxOrdinal = tops.length > 0 ? tops[tops.length - 1]!.ordinal : -1;
    const headings = tops.filter((t) => t.type === "heading");
    const want = headings.map((h, i) => {
      const level = h.level ?? 1;
      let last = maxOrdinal;
      for (let j = i + 1; j < headings.length; j++) {
        if ((headings[j]!.level ?? 1) <= level) {
          last = headings[j]!.ordinal - 1;
          break;
        }
      }
      return { heading_block: h.block_id, doc_id: d.doc_id, level, first_ordinal: h.ordinal, last_ordinal: last };
    });
    const have = db.prepare("SELECT heading_block, doc_id, level, first_ordinal, last_ordinal FROM sections WHERE doc_id = ? ORDER BY first_ordinal").all(d.doc_id);
    const diff = deepEqualTol(have, want, 0);
    if (diff) problems.push(`I8: sections of ${d.doc_id} differ from a rebuild (${diff})`);
  }
  const bcHave = (db.prepare("SELECT block_id, commit_id, kind FROM block_changes ORDER BY block_id, commit_id, kind").all() as Row[]);
  const bcWant = (db.prepare("SELECT DISTINCT block_id, commit_id, kind FROM dispositions ORDER BY block_id, commit_id, kind").all() as Row[]);
  const bcDiff = deepEqualTol(bcHave, bcWant, 0);
  if (bcDiff) problems.push(`I8: block_changes differ from a rebuild out of dispositions (${bcDiff})`);

  return problems;
}

// ---- validation -------------------------------------------------------------------------

export interface ValidateOptions {
  /** false while regenerating: cases may not have an `expect` yet */
  requireExpect?: boolean;
}

function validateConfig(at: string, config: unknown, problems: string[]): void {
  if (!isRecord(config)) {
    problems.push(`${at}: \`config\` must be an object`);
    return;
  }
  for (const [k, v] of Object.entries(config)) {
    if (!(k in CONFIG_KEYS)) problems.push(`${at}: unknown config key \`${k}\``);
    else if (k === "matcher_v" ? typeof v !== "string" : typeof v !== "number") problems.push(`${at}: config.${k} has the wrong type`);
  }
}

function validateSteps(at: string, steps: unknown, problems: string[]): number {
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push(`${at}: \`steps\` must be a non-empty array`);
    return -1;
  }
  steps.forEach((s, i) => {
    const here = `${at}.steps[${i}]`;
    if (!isRecord(s)) {
      problems.push(`${here}: not an object`);
      return;
    }
    const keys = Object.keys(s);
    if (keys.length !== 1 || (keys[0] !== "observe" && keys[0] !== "sweep")) {
      problems.push(`${here}: a step is exactly one of \`observe\` / \`sweep\` (got ${keys.join(", ")})`);
      return;
    }
    const body = s[keys[0]!];
    if (!isRecord(body) || typeof body.ts !== "string" || !TS_RE.test(body.ts)) {
      problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (§2.4)`);
    }
    if (keys[0] === "sweep") {
      if (isRecord(body) && Object.keys(body).some((k) => k !== "ts")) problems.push(`${here}: sweep takes only \`ts\``);
      return;
    }
    if (!isRecord(body)) return;
    if (Object.keys(body).some((k) => k !== "ts" && k !== "items")) problems.push(`${here}: observe takes \`ts\` and \`items\``);
    if (!Array.isArray(body.items) || body.items.length === 0) {
      problems.push(`${here}: \`items\` must be a non-empty array`);
      return;
    }
    const paths = new Set<string>();
    body.items.forEach((it, j) => {
      const where = `${here}.items[${j}]`;
      if (!isRecord(it)) {
        problems.push(`${where}: not an object`);
        return;
      }
      if (Object.keys(it).some((k) => k !== "path" && k !== "source")) problems.push(`${where}: an item is { path, source }`);
      if (typeof it.path !== "string" || it.path === "" || it.path.startsWith("/") || !it.path.endsWith(".md")) {
        problems.push(`${where}: \`path\` must be repo-relative, no leading slash, ending in .md`);
      } else if (paths.has(it.path)) problems.push(`${where}: path ${it.path} appears twice in one batch`);
      else paths.add(it.path);
      if (it.source !== null && typeof it.source !== "string") problems.push(`${where}: \`source\` must be a string or null`);
    });
  });
  return steps.length;
}

function validateProjection(at: string, e: unknown, stepCount: number, problems: string[]): void {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return;
  }
  const want = ["steps", ...PROJECTED_TABLES];
  const keys = Object.keys(e).sort();
  const wantSorted = [...want].sort();
  if (keys.length !== wantSorted.length || keys.some((k, i) => k !== wantSorted[i])) {
    problems.push(`${at}: must have exactly the keys ${want.join(", ")} (got ${keys.join(", ")})`);
    return;
  }
  for (const k of want) if (!Array.isArray(e[k])) problems.push(`${at}.${k}: must be an array`);
  if (Array.isArray(e.steps) && stepCount >= 0 && e.steps.length !== stepCount) problems.push(`${at}.steps: ${e.steps.length} outcomes for ${stepCount} steps`);
}

function validateMigrationExpect(at: string, e: unknown, rows: string[], problems: string[]): void {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return;
  }
  if ("error" in e) {
    if (Object.keys(e).length !== 1 || typeof e.error !== "string") problems.push(`${at}: a refusal is exactly { error: string }`);
    return;
  }
  const extra = Object.keys(e).filter((k) => !["user_version", "tables", "rows"].includes(k));
  if (extra.length > 0) problems.push(`${at}: unknown keys ${extra.join(", ")}`);
  if (typeof e.user_version !== "number") problems.push(`${at}.user_version must be a number`);
  if (!isRecord(e.tables)) problems.push(`${at}.tables must be an object`);
  if (!isRecord(e.rows)) problems.push(`${at}.rows must be an object`);
  else {
    const have = Object.keys(e.rows).sort();
    const want = [...rows].sort();
    if (have.length !== want.length || have.some((k, i) => k !== want[i])) problems.push(`${at}.rows: tables {${have.join(",")}} vs case rows {${want.join(",")}}`);
  }
}

function validateFingerprint(at: string, e: unknown, problems: string[]): void {
  if (!isRecord(e)) {
    problems.push(`${at}: must be an object`);
    return;
  }
  const extra = Object.keys(e).filter((k) => !["user_version", "tables", "indexes"].includes(k));
  if (extra.length > 0) problems.push(`${at}: unknown keys ${extra.join(", ")}`);
  if (typeof e.user_version !== "number") problems.push(`${at}.user_version must be a number`);
  if (!isRecord(e.tables)) problems.push(`${at}.tables must be an object`);
  if (!isRecord(e.indexes)) problems.push(`${at}.indexes must be an object`);
}

/**
 * Validate a parsed `cases/<suite>.json`; returns the problems found (empty = valid).
 * `file` is the file name (with `.json`); the suite must equal its stem.
 */
export function validateFixtureFile(file: string, doc: unknown, opts: ValidateOptions = {}): string[] {
  const requireExpect = opts.requireExpect ?? true;
  const problems: string[] = [];
  if (!isRecord(doc)) return [`${file}: not an object`];
  const stem = file.replace(/\.json$/, "");
  if (doc.suite !== stem) problems.push(`${file}: \`suite\` must equal the file stem '${stem}' (got ${JSON.stringify(doc.suite)})`);
  const extra = Object.keys(doc).filter((k) => !["suite", "cases"].includes(k));
  if (extra.length > 0) problems.push(`${file}: unknown top-level keys ${extra.join(", ")}`);
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) return [...problems, `${file}: \`cases\` must be a non-empty array`];
  const kind = suiteKind(stem);
  if (kind === "schema" && doc.cases.length !== 1) problems.push(`${file}: the schema suite has exactly one case`);

  const seen = new Set<string>();
  doc.cases.forEach((c: unknown, i: number) => {
    const at = `${file}#${i}`;
    if (!isRecord(c)) {
      problems.push(`${at}: not an object`);
      return;
    }
    const unknown = Object.keys(c).filter((k) => !CASE_KEYS[kind].includes(k));
    if (unknown.length > 0) problems.push(`${at}: unknown case keys ${unknown.join(", ")}`);
    if (typeof c.name !== "string" || c.name === "") problems.push(`${at}: missing \`name\``);
    else if (seen.has(c.name)) problems.push(`${at}: duplicate name '${c.name}'`);
    else seen.add(c.name);
    if (c.notes !== undefined && typeof c.notes !== "string") problems.push(`${at}: \`notes\` must be a string`);

    let stepCount = -1;
    if (kind === "migration") {
      if (!Array.isArray(c.setup) || !c.setup.every((s) => typeof s === "string")) problems.push(`${at}: \`setup\` must be an array of SQL strings`);
      if (typeof c.user_version !== "number" || !Number.isInteger(c.user_version) || c.user_version < 0) problems.push(`${at}: \`user_version\` must be a non-negative integer`);
      if (!Array.isArray(c.rows) || !c.rows.every((s) => typeof s === "string")) problems.push(`${at}: \`rows\` must be an array of table names`);
    } else if (kind === "observe") {
      if (c.config !== undefined) validateConfig(at, c.config, problems);
      stepCount = validateSteps(at, c.steps, problems);
    }

    if (c.expect === undefined) {
      if (requireExpect) problems.push(`${at}: missing \`expect\` (run STORE_SPEC_UPDATE=1)`);
      return;
    }
    if (kind === "schema") validateFingerprint(`${at}.expect`, c.expect, problems);
    else if (kind === "migration") validateMigrationExpect(`${at}.expect`, c.expect, Array.isArray(c.rows) ? (c.rows as string[]) : [], problems);
    else validateProjection(`${at}.expect`, c.expect, stepCount, problems);
  });
  return problems;
}
