// Fixture bridge for spec/store (README §9). Pure pieces, no vitest:
//
//   schemaFingerprint()     a database → the §9.2 fingerprint (tables, indexes, FKs, user_version)
//   runSchemaCase()         the fingerprint of a fresh `:memory:` store
//   runMigrationCase()      §9.3: authored pre-state → open with the reference → projection (or the refusal)
//   runObserveCase()        §9.4: run an observation script through the production observe path,
//                           check the §8 invariants after every observe step, project the tables
//   runEdgeTransitionsCase() §9.5 (17.0): the recorder's edge suite (`cases/history/edge-transitions.json`) —
//                           the same scripts projecting `edge_transitions` alone
//   checkInvariants()       README §8 on a store: the core invariants C1–C8 and F1–F3 (the feed) and, with legacy capture on, H1–H5/I10
//   projectStore()          the §9.4 table projection (ordering, hex hashes, JSON attrs/detail)
//   validateFixtureFile()   the shape check a runner applies before trusting a file
//
// Nothing here decides anything about the store; it drives the same code paths
// production uses (`observeBatch`, `sweepResurrectionPool`, `new Store`) with the
// fixture minter installed and re-expresses the resulting rows so the two
// implementations can be compared.
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/store/store.js";
import { ensureRepo } from "../../src/core/attach.js";
import { repeatingMinter, sequentialMinter, setIdMinter } from "../../src/core/ids.js";
import { sha256 } from "../../src/core/hash.js";
import { pinClock } from "../../src/core/clock.js";
import { activeAlerts, MATERIALIZATION_BACKLOG_ALERT } from "../../src/core/store/alerts.js";
import { reconstructContent, readDocumentAtRevision } from "../../src/core/read/document.js";
import { runGc, sweepResurrectionPool } from "../../src/core/store/gc.js";
import { attachArchive, detachArchive, exportHistory, RevisionArchived, segmentBasename, ARCHIVE_SUFFIX } from "../../src/core/store/archive.js";
import { evaluateRetention, retentionPolicy, type RetentionPlan } from "../../src/core/store/retention.js";
import { ARCHIVED_COMMITS_SQL } from "../../src/core/store/archive.js";
import {
  DeltaError, TreeResolver, byteLength, encodeBodyDelta, encodeFrontmatterDelta, entryText, explicitEntries, fullNodeText, isCheckpointSeq, parseFrontmatterBlob, parseNodeText,
  type ResolvedList,
} from "../../src/core/store/delta.js";
import { observeBatch, type BatchOutcome } from "../../src/sync/observe.js";
import { disableHistory, enableHistory, historyBundlePresent, historyReader, purgeHistory, readCapability, type CoverageInterval } from "../../src/core/store/manifest.js";
import { bindCapabilities } from "../../src/core/capabilities/registry.js";
import { HAS_HISTORY } from "../composition.js";
import type { Capabilities, HistoryRecorder } from "../../src/core/capabilities/types.js";
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
export type Step =
  | { observe: { ts: string; items: ObserveItem[] } }
  | { sweep: { ts: string } }
  /** README §9.4 (14.2, 17.0): the §7 garbage collection, enabled → `{ gc: { blobs, tree_nodes, same_dispositions, claims_released, feed_pruned } }`; `ts` is the clock of the claims prune (§7.3) and the feed prune (§7.4), the runner's clock without it */
  | { gc: { ts?: string } }
  /** README §9.4 (14.2): authored SQL run verbatim — the device that puts a 14.1 store's rows into a case → `{ changes: n }` */
  | { exec: { sql: string[] } }
  /** README §9.4 (15.0): the retention plan at `ts` under the policy (a partial over the defaults) → `{ plan }` */
  | { history_plan: { ts: string; policy?: unknown; before?: string } }
  /** README §9.4 (15.0): `history export` into the case's archive directory → `{ export: { segment, reused, squashed, gc } }` */
  | { history_export: { ts: string; policy?: unknown; before?: string; prune: boolean } }
  /** README §9.4 (15.0): attach the case's segment file by id → `{ attached: [...] }` */
  | { history_attach: { segment: string } }
  /** README §9.4 (15.0): detach a segment by id → `{ detached }` */
  | { history_detach: { segment: string } }
  /** README §9.4 (Phase 4a; §5.9): `history enable` at `ts` (`writer_requires` default true) → `{ history: { state, coverage, writer_requires, changed, baseline? } }` */
  | { history_enable: { ts: string; writer_requires?: boolean } }
  /** README §9.4 (Phase 4a; §5.9): `history disable` at `ts` → `{ history: { state, coverage, writer_requires, changed } }` */
  | { history_disable: { ts: string } }
  /** README §9.4 (Phase 4b; §7.6): `history purge [--before]` at `ts` → `{ purge: { purged: { <table>: n }, claims_released, coverage, tables_dropped } }` */
  | { history_purge: { ts: string; before?: string } }
  /** README §9.4 (Phase 4a; §5.4 step 15, resolution 18): the recorder fault device — `fail: true` makes every capture throw until `fail: false` → `{ fault: boolean }` */
  | { recorder_fault: { fail: boolean } }
  /** README §9.4 (15.0): reconstruct at a revision (§6.2, through a segment when archived) → `{ raw, rendered_hash_match }` or the error */
  | { read_at: { doc: string; rev: string } }
  /** README §9.4 (17.0, §7.5): the epoch re-mint of a restore / rebuild-from-files at `ts` — a new `ep`, the feed emptied → `{ epoch }` */
  | { remint_epoch: { ts: string } };

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
/** README §9.4 (Phase 4a): a member rolled back because its capture failed (resolution 18) — the `failing_recorder` device is what produces one. */
export interface FailedOutcome {
  path: string;
  failed: true;
  doc: string | null;
  error: string;
}
export interface GcOutcome {
  gc: { blobs: number; tree_nodes: number; same_dispositions: number; claims_released: number; feed_pruned: number };
}
export interface PlanOutcome {
  plan: RetentionPlan;
}
export interface ExportOutcome {
  export: {
    segment: { id: string; seq_lo: number; seq_hi: number; revision_count: number; previous_segment: string | null } | null;
    reused: boolean;
    squashed: { revisions: number; commits: number; dispositions: number; block_changes: number } | null;
    gc: { blobs: number; tree_nodes: number } | null;
  };
}
export interface AttachOutcome {
  attached: { segment_id: string; seq_lo: number; seq_hi: number; revision_count: number }[];
}
export interface DetachOutcome {
  detached: string | null;
}
export type ReadAtOutcome =
  | { raw: string; rendered_hash_match: boolean }
  | { error: "revision_archived"; rev: string; archive: string; path?: string }
  | { error: "target_missing" };
/** README §9.4 (Phase 4a): a `history_enable`/`history_disable` step's outcome — the manifest row's capture state after the verb. */
export interface LifecycleOutcome {
  history: { state: "enabled" | "disabled"; coverage: CoverageInterval[]; writer_requires: boolean; changed: boolean; baseline?: { commit: string; revisions: number } };
}
/** README §9.4 (Phase 4b): a `history_purge` step's outcome — the receipt (§7.6). */
export interface PurgeOutcome {
  purge: { purged: Record<string, number>; claims_released: number; coverage: CoverageInterval[]; tables_dropped: boolean };
}
export type StepOutcome = (ObservedOutcome | GoneOutcome | FailedOutcome)[] | { swept: number } | GcOutcome | { changes: number } | PlanOutcome | ExportOutcome | AttachOutcome | DetachOutcome | ReadAtOutcome | { epoch: string } | LifecycleOutcome | PurgeOutcome | { fault: boolean };

/** README §9.4 (15.0): where a case's segments are written — a temporary directory, `<dest>` in every projected path. */
export interface HistoryContext {
  dest: string;
}
export const DEST_TOKEN = "<dest>";

export type HistoryStep = Extract<Step, { history_plan: unknown } | { history_export: unknown } | { history_attach: unknown } | { history_detach: unknown } | { read_at: unknown }>;

export function isHistoryStep(step: object): step is HistoryStep {
  return "history_plan" in step || "history_export" in step || "history_attach" in step || "history_detach" in step || "read_at" in step;
}

/** The file of a segment under the case's `dest`, by id (`…-<segment>.omgarchive.db`). */
function segmentFile(ctx: HistoryContext, segmentId: string): string {
  const name = readdirSync(ctx.dest).find((n) => n.endsWith(`-${segmentId}${ARCHIVE_SUFFIX}`));
  if (!name) throw new Error(`no segment file for ${segmentId} under ${ctx.dest}`);
  return join(ctx.dest, name);
}

/**
 * README §9.4 (15.0): the retention steps, through the production paths
 * (`evaluateRetention`, `exportHistory`, `attachArchive`, `detachArchive`,
 * `readDocumentAtRevision`). `policy` is a partial over the defaults (the repo
 * has no settings in a fixture); `ts` is the clock. Shared with the surface
 * runner, which drives the same steps around its `read` calls.
 */
export function runHistoryStep(store: Store, repoId: string, step: HistoryStep, ctx: HistoryContext): StepOutcome {
  if ("history_plan" in step) {
    const { ts, policy, before } = step.history_plan;
    return { plan: evaluateRetention(store, repoId, { now: ts, policy: retentionPolicy(store, repoId, policy), ...(before !== undefined ? { before } : {}) }) };
  }
  if ("history_export" in step) {
    const { ts, policy, before, prune } = step.history_export;
    const r = exportHistory(store, repoId, { dest: ctx.dest, now: ts, policy: retentionPolicy(store, repoId, policy), prune, ...(before !== undefined ? { before } : {}) });
    return {
      export: {
        segment: r.segment ? { id: r.segment.id, seq_lo: r.segment.seq_lo, seq_hi: r.segment.seq_hi, revision_count: r.segment.revision_count, previous_segment: r.segment.previous_segment } : null,
        reused: r.reused,
        squashed: r.squashed,
        gc: r.gc,
      },
    };
  }
  if ("history_attach" in step) {
    const r = attachArchive(store, repoId, segmentFile(ctx, step.history_attach.segment));
    return { attached: r.attached.map((a) => ({ segment_id: a.segment_id, seq_lo: a.seq_lo, seq_hi: a.seq_hi, revision_count: a.revision_count })) };
  }
  if ("history_detach" in step) {
    return { detached: detachArchive(store, repoId, step.history_detach.segment) };
  }
  const { doc, rev } = step.read_at;
  try {
    const at = readDocumentAtRevision(store, doc, rev);
    if (!at) return { error: "target_missing" };
    return { raw: at._raw, rendered_hash_match: at.renderedHashMatch };
  } catch (e) {
    if (e instanceof RevisionArchived) return { error: "revision_archived", rev: e.rev, archive: e.archive, ...(e.path !== null ? { path: `${DEST_TOKEN}/${segmentBasename(e.path)}` } : {}) };
    throw e;
  }
}

/** README §9.4 (14.2, 17.0): the `gc` step — `runGc` enabled, never a dry run, `ts` the claims prune's clock (§7.3); the counts in the fixture's spelling. */
export function runGcStep(store: Store, ts?: string): GcOutcome {
  const r = runGc(store, { enabled: true, ...(ts !== undefined ? { now: ts } : {}) });
  return { gc: { blobs: r.blobsSwept, tree_nodes: r.treeNodesSwept, same_dispositions: r.sameDispositionsSwept, claims_released: r.claimsReleased, feed_pruned: r.feedPruned } };
}

/** README §9.4 (14.2): the `exec` step — every statement run verbatim, in order, in one transaction; the rows changed summed. */
export function runExecStep(store: Store, sql: string[]): { changes: number } {
  return store.write((db) => {
    let changes = 0;
    for (const statement of sql) changes += db.prepare(statement).run().changes;
    return { changes };
  });
}

export interface Projection {
  steps: StepOutcome[];
  docs: Row[];
  /** README §9.4 (17.0): the recorder's commit rows `{ commit_id, epoch, seq, ts, origin, actor, reason, batch_id, ops }` by `seq`. */
  commits: Row[];
  /** README §9.4 (17.0, 3d): the change feed `{ epoch, seq, commit_id, ts, origin, actor, reason, batch_id, plan_id }` by `seq`. */
  feed: Row[];
  /** README §9.4 (17.0, 3d): the feed's entries `{ epoch, seq, doc_id, path, head, hash, kind, from_path }` by (`seq`, insertion order). */
  feed_entries: Row[];
  revisions: Row[];
  blobs: Row[];
  tree_nodes: Row[];
  blocks: JsonRow[];
  dispositions: JsonRow[];
  block_changes: Row[];
  resurrection_pool: Row[];
  /** README §9.4 (17.0): the §2.1 claims of the case's repo as `{ prefix, id, minted_at, holders }` by (`prefix`, `id` bytewise) — the repo's own `rp` and `ep` claims omitted, like `repo_id`. */
  id_claims: Row[];
  sections: Row[];
  /** README §9.4 (14.0): the api path's recorded file intent — always `[]` for an observation script. */
  pending_materializations: Row[];
  /** README §9.4 (15.0): the recorded archive segments — `path` as `file` (the name under `<dest>`), `bytes` omitted (a page layout). */
  archives: Row[];
}
/** The projected tables, in the order the fixture emits them. */
export const PROJECTED_TABLES = [
  "docs", "commits", "feed", "feed_entries", "revisions", "blobs", "tree_nodes", "blocks",
  "dispositions", "block_changes", "resurrection_pool", "id_claims", "sections", "pending_materializations", "archives",
] as const;

/** README §9.4: which fixture minter a case installs — the sequential counter (default) or the repeating one (13.5). */
export type MinterKind = "sequential" | "repeat";
export const MINTER_KINDS: readonly MinterKind[] = ["sequential", "repeat"];

export interface ObserveCase {
  name: string;
  notes?: string;
  config?: FixtureConfig;
  minter?: MinterKind;
  /** README §9.4 (Phase 4a): the case's composition — `{ history: false }` creates the repository with capture off (`disabled`, no coverage, `writer_requires 0`), as a core-only build or `omg source add --no-history` would; the default is on. */
  capabilities?: { history: boolean };
  steps: Step[];
  expect: Projection;
}

export type FixtureCase = SchemaCase | MigrationCase | ObserveCase | EdgeTransitionsCase;

export interface FixtureFile {
  suite: string;
  cases: FixtureCase[];
}

export type CaseKind = "schema" | "migration" | "observe" | "edges";

/** The four suite kinds, told apart by the file stem (README §9.1; `edge-transitions` under `cases/history/`, §9.5). */
export function suiteKind(suite: string): CaseKind {
  if (suite === "schema") return "schema";
  if (suite === "migrations") return "migration";
  if (suite === "edge-transitions") return "edges";
  return "observe";
}

export const CASE_KEYS: Record<CaseKind, readonly string[]> = {
  schema: ["name", "notes", "expect"],
  migration: ["name", "notes", "setup", "user_version", "rows", "expect"],
  observe: ["name", "notes", "config", "minter", "capabilities", "steps", "expect"],
  edges: ["name", "notes", "config", "steps", "expect"],
};

/** README §9.5 (17.0): an `edge_transitions` row as the recorder suite carries it — every column but `repo_id`. */
export interface EdgeTransitionRow {
  edge_id: string;
  src_doc: string;
  src_block: string | null;
  src_field: string | null;
  predicate: string;
  dst_kind: string;
  dst_node: string;
  anchor: string | null;
  provenance: string;
  via_node: string | null;
  from_commit: string;
  to_commit: string | null;
}
export const EDGE_TRANSITION_FIELDS = [
  "edge_id", "src_doc", "src_block", "src_field", "predicate", "dst_kind", "dst_node", "anchor", "provenance", "via_node", "from_commit", "to_commit",
] as const;
export interface EdgeTransitionsProjection {
  edge_transitions: EdgeTransitionRow[];
}
export interface EdgeTransitionsCase {
  name: string;
  notes?: string;
  config?: FixtureConfig;
  steps: Step[];
  expect: EdgeTransitionsProjection;
}

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

/** Run `body` with the fixture minter installed (README §2.2; the repeating one of §9.4 for `"minter": "repeat"`), restoring production afterwards. */
function withFixtureMinter<T>(body: () => T, kind: MinterKind = "sequential"): T {
  setIdMinter(kind === "repeat" ? repeatingMinter() : sequentialMinter());
  try {
    return body();
  } finally {
    setIdMinter(null);
  }
}

/**
 * README §9.4 (Phase 4a): the instant every fixture repository is born — the
 * runner creates it under this clock, before any authored `ts`, so the
 * manifest's coverage (`[{ from: <birth>, to: null }]`) covers the whole
 * script and the history invariants apply to every captured document; it is
 * also what `sync_status.capabilities.coverage_from` reads on the wire
 * (`spec/surface` §6). The `rp`/`ep` claims minted here are omitted from the
 * projection, as before.
 */
export const FIXTURE_BIRTH = "2000-01-01T00:00:00.000Z";

/** `ensureRepo` under the fixture birth clock (every runner that checks the §8 invariants or records the manifest creates its repository through this). */
export function createFixtureRepo(store: Store, slug: string, rootPath: string | null, opts: { history?: boolean } = {}): string {
  const restore = pinClock(FIXTURE_BIRTH);
  try {
    return ensureRepo(store, slug, rootPath, opts);
  } finally {
    restore();
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

/** README §9.3 (17.0, 3e-ii): the clock a migration case runs under — what step 17 writes where it says "the migration's clock" (the manifest's `updated_at`, a coverage start with no commit to anchor on). */
export const MIGRATION_CLOCK = "2026-09-27T00:00:00.000Z";

/**
 * Run `setup` on an empty file database, pin `user_version`, close, then open it
 * with the reference (which migrates) under the fixture minter and the fixture
 * clock. Returns the projection — or `{ error }` when the opener refused.
 */
export function runMigrationCase(c: MigrationCaseInput): MigrationExpect | MigrationRefusal {
  const restoreClock = pinClock(MIGRATION_CLOCK);
  try {
    return runMigrationCaseUnderClock(c);
  } finally {
    restoreClock();
  }
}

function runMigrationCaseUnderClock(c: MigrationCaseInput): MigrationExpect | MigrationRefusal {
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

/** One `observeBatch` outcome as the fixture records it (README §9.4 "Expect": `steps`). Exported for the specs that reuse the observation-script shape (graph, search, …). */
export function toOutcome(o: BatchOutcome): ObservedOutcome | GoneOutcome | FailedOutcome {
  if (o.kind === "deleted") return { path: o.path, deleted: o.docId !== null, doc: o.docId };
  if (o.kind === "failed") return { path: o.path, failed: true, doc: o.docId, error: o.error };
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
    // The case's archive directory (README §9.4, 15.0): created on the first
    // retention step, removed with the store.
    const history: { ctx: HistoryContext | null } = { ctx: null };
    const ctx = (): HistoryContext => (history.ctx ??= { dest: mkdtempSync(join(tmpdir(), "omgbase-store-spec-archives-")) });
    try {
      const repoId = createFixtureRepo(store, FIXTURE_REPO_SLUG, null, c.capabilities ? { history: c.capabilities.history } : {});
      const { steps, problems } = runSteps(store, repoId, c.steps, config, ctx);
      const tables = { ...projectStore(store.db, repoId), id_claims: projectClaims(store.db, repoId) };
      // Emit the tables in PROJECTED_TABLES order (README §9.4), `id_claims` in its place.
      const expect = { steps } as Projection;
      for (const t of PROJECTED_TABLES) (expect as unknown as Record<string, unknown>)[t] = tables[t];
      return { expect, problems };
    } finally {
      store.close();
      if (history.ctx) rmSync(history.ctx.dest, { recursive: true, force: true });
    }
  }, c.minter);
}

/**
 * The step loop every observation-script suite of this spec shares: each step
 * through its production path, the §8 invariants after every observe / gc /
 * export step and at the end. Returns the outcomes and the problems found.
 */
function runSteps(store: Store, repoId: string, stepsIn: Step[], config: ReturnType<typeof toReconcileConfig>, ctx: () => HistoryContext): { steps: StepOutcome[]; problems: string[] } {
  const lastSource = new Map<string, string>();
  const steps: StepOutcome[] = [];
  const problems: string[] = [];
  stepsIn.forEach((step, i) => {
    if (isHistoryStep(step)) {
      steps.push(runHistoryStep(store, repoId, step, ctx()));
      if ("history_export" in step) for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`after step ${i}: ${p}`);
    } else if ("observe" in step) {
      const items = step.observe.items.map((it) => ({ path: it.path, content: it.source }));
      const outcomes = observeBatch(store, repoId, items, step.observe.ts, { config });
      // A member rolled back by a capture failure (Phase 4a) left the store as it was: its source is not what the rows hold.
      const failed = new Set(outcomes.filter((o) => o.kind === "failed").map((o) => o.path));
      for (const it of step.observe.items) {
        if (failed.has(it.path)) continue;
        if (it.source === null) lastSource.delete(it.path);
        else lastSource.set(it.path, it.source);
      }
      steps.push(outcomes.map(toOutcome));
      for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`after step ${i}: ${p}`);
    } else if ("sweep" in step) {
      steps.push({ swept: sweepResurrectionPool(store, step.sweep.ts) });
    } else if ("gc" in step) {
      steps.push(runGcStep(store, step.gc.ts));
      for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`after step ${i}: ${p}`);
    } else if ("remint_epoch" in step) {
      // README §7.5 (17.0): the epoch re-mint — a new `ep`, the feed emptied; the
      // invariants hold on the new epoch (C4 with an empty feed, F1 vacuous).
      steps.push({ epoch: store.remintEpoch(repoId, step.remint_epoch.ts) });
      for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`after step ${i}: ${p}`);
    } else if (isLifecycleStep(step)) {
      // README §5.9 (Phase 4a): `history enable` (the baseline commit and the open
      // interval; every invariant holds after it), `history disable`, the fault device.
      steps.push(runLifecycleStep(store, repoId, step));
      if (!("recorder_fault" in step)) for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`after step ${i}: ${p}`);
    } else {
      steps.push(runExecStep(store, step.exec.sql));
    }
  });
  for (const p of checkInvariants(store, repoId, lastSource)) problems.push(`at end: ${p}`);
  return { steps, problems };
}

// ---- the capture lifecycle steps (README §9.4, §5.9 — Phase 4a) ---------------------------

export type LifecycleStep = Extract<Step, { history_enable: unknown } | { history_disable: unknown } | { history_purge: unknown } | { recorder_fault: unknown }>;

export function isLifecycleStep(step: object): step is LifecycleStep {
  return "history_enable" in step || "history_disable" in step || "history_purge" in step || "recorder_fault" in step;
}

/** `history_enable` / `history_disable` through the production verbs, the fault device through the test seam; shared with every observation-script runner. */
export function runLifecycleStep(store: Store, repoId: string, step: LifecycleStep): LifecycleOutcome | PurgeOutcome | { fault: boolean } {
  if ("history_purge" in step) {
    const r = purgeHistory(store.db, repoId, { now: step.history_purge.ts, before: step.history_purge.before ?? null });
    return { purge: { purged: r.purged, claims_released: r.claims_released, coverage: r.coverage, tables_dropped: r.tables_dropped } };
  }
  if ("history_enable" in step) {
    const r = enableHistory(store.db, repoId, { now: step.history_enable.ts, ...(step.history_enable.writer_requires !== undefined ? { writerRequires: step.history_enable.writer_requires } : {}) });
    return { history: { state: r.row.state, coverage: r.row.coverage, writer_requires: r.row.writer_requires, changed: r.changed, ...(r.baseline ? { baseline: r.baseline } : {}) } };
  }
  if ("history_disable" in step) {
    const r = disableHistory(store.db, repoId, { now: step.history_disable.ts });
    return { history: { state: r.row.state, coverage: r.row.coverage, writer_requires: r.row.writer_requires, changed: r.changed } };
  }
  return { fault: setRecorderFault(store, step.recorder_fault.fail) };
}

// ---- the recorder fault device (README §9.4, Phase 4a) -----------------------------------
//
// `{ recorder_fault: { fail: true } }` wraps the store's recorder so that every
// capture call (`recordCommit`, `captureRevision`, `recordDispositions`,
// `recordEdgeTransitions`) throws; the next `observe` step then pins resolution
// 18 — the member is rolled back (`{ path, failed: true, doc, error }`), the
// feed and every table stay as they were, the next observe after `{ fail:
// false }` lands it. Test seam only: the composition is rebound on the connection.

const CAPTURE_METHODS = new Set<PropertyKey>(["recordCommit", "captureRevision", "recordDispositions", "recordEdgeTransitions", "retargetEdges"]);
const originalRecorder = new WeakMap<Store, HistoryRecorder | null>();

/** The fault's message, verbatim in the member's `error` (after `history capture of <path> failed: `). */
export const RECORDER_FAULT_REASON = "recorder fault (fixture device)";

function setRecorderFault(store: Store, fail: boolean): boolean {
  const current = store.capabilities;
  if (!originalRecorder.has(store)) originalRecorder.set(store, current.history);
  const original = originalRecorder.get(store) ?? null;
  const history = fail && original
    ? new Proxy(original, { get(target, key, receiver) { if (CAPTURE_METHODS.has(key)) return () => { throw new Error(RECORDER_FAULT_REASON); }; return Reflect.get(target, key, receiver) as unknown; } })
    : original;
  const caps: Capabilities = { ...current, history };
  (store as { capabilities: Capabilities }).capabilities = caps;
  bindCapabilities(store.db, caps);
  return fail && original !== null;
}

// ---- the runs without the history module (README §9.6, Phase 4a/5a — `OMGBASE_CAPABILITIES=core|semantic`) -------------
//
// Under a composition without the recorder the runner opens stores with none: a
// case's repository starts with history `disabled`, no history table exists
// and no history row is written. The SAME observation scripts run, the core
// invariants (C*, F*, A1) are checked, and the projection is compared on the
// core tables alone — `commits`, `revisions`, `blobs`, `tree_nodes`,
// `dispositions`, `block_changes`, `archives` are `[]` on both sides and the
// `id_claims` `holders` are compared with the recorder's bit masked off. A case
// that needs the module — a retention or lifecycle step, a `gc` (its counts are
// the recorder's and the claims prune sees the recorder's holds), an `exec`
// (which may name a history table), the fault device — is skipped and
// reported; `cases/history/` and `migrations.json` are skipped wholesale (a
// core-only build neither captures nor upgrades a 16.x database).

/** Is this process a run WITHOUT the history module (`OMGBASE_CAPABILITIES=core|semantic`; README §9.6)? The mutate runner shares the rule. */
export function lacksHistory(): boolean {
  return !HAS_HISTORY;
}

/** The tables whose projection the core-only run compares. */
export const CORE_PROJECTED_TABLES: readonly (typeof PROJECTED_TABLES)[number][] = ["docs", "feed", "feed_entries", "blocks", "resurrection_pool", "id_claims", "sections", "pending_materializations"];

/** Does the case run under the core-only composition (README §9.6)? */
export function runsUnderCore(c: { steps: Step[] }): boolean {
  return c.steps.every((s) => "observe" in s || "sweep" in s || "remint_epoch" in s);
}

/**
 * A projection reduced to what the core-only run compares: the core tables,
 * `id_claims` with bit 1 masked (a claim the recorder alone held — `holders
 * = 2` — drops out, since the core-only store never wrote it), and the
 * history tables emptied.
 */
export function coreModeProjection(p: Projection): Projection {
  const out = { ...p } as Projection;
  for (const t of PROJECTED_TABLES) if (!CORE_PROJECTED_TABLES.includes(t)) (out as unknown as Record<string, unknown>)[t] = [];
  out.id_claims = p.id_claims
    .map((r) => ({ ...r, holders: (r.holders as number) & 1 }))
    .filter((r) => (r.holders as number) !== 0);
  return out;
}

export type EdgeTransitionsCaseInput = Omit<EdgeTransitionsCase, "expect">;

export interface EdgeTransitionsEvaluation {
  expect: EdgeTransitionsProjection;
  problems: string[];
}

/**
 * README §9.5 (17.0): the recorder's edge suite — the same observation scripts
 * as spec/graph's, projecting `edge_transitions` alone: every column but
 * `repo_id`, by (`from_commit`'s seq, `edge_id` bytewise), `to_commit` as the
 * commit id or null. Runner checks beyond §8: every `from_commit`/`to_commit`
 * is a `commits` row (the check that moved here from spec/graph 2.x); every
 * open transition (`to_commit IS NULL`) has an `edges` row of the same
 * `edge_id` with the same `dst_node`, and every `edges` row an open transition
 * (§8 H6).
 */
export function runEdgeTransitionsCase(c: EdgeTransitionsCaseInput): EdgeTransitionsEvaluation {
  const config = toReconcileConfig(c.config);
  return withFixtureMinter(() => {
    const store = new Store({ path: ":memory:" });
    const history: { ctx: HistoryContext | null } = { ctx: null };
    const ctx = (): HistoryContext => (history.ctx ??= { dest: mkdtempSync(join(tmpdir(), "omgbase-store-spec-archives-")) });
    try {
      const repoId = createFixtureRepo(store, FIXTURE_REPO_SLUG, null);
      const { problems } = runSteps(store, repoId, c.steps, config, ctx);
      const db = store.db;
      const commitSeq = new Map((db.prepare("SELECT commit_id FROM commits WHERE repo_id = ? ORDER BY ts, seq").all(repoId) as { commit_id: string }[]).map((r, i) => [r.commit_id, i] as const));
      const seqOf = (id: string): number => commitSeq.get(id) ?? Number.MAX_SAFE_INTEGER;
      const edge_transitions = (db
        .prepare(`SELECT ${EDGE_TRANSITION_FIELDS.join(", ")} FROM edge_transitions WHERE repo_id = ?`)
        .all(repoId) as EdgeTransitionRow[])
        .sort((a, b) => seqOf(a.from_commit) - seqOf(b.from_commit) || cmp(a.edge_id, b.edge_id));
      for (const t of edge_transitions) {
        if (!commitSeq.has(t.from_commit)) problems.push(`edge ${t.edge_id}: from_commit ${t.from_commit} is not a commit`);
        if (t.to_commit !== null && !commitSeq.has(t.to_commit)) problems.push(`edge ${t.edge_id}: to_commit ${t.to_commit} is not a commit`);
      }
      return { expect: { edge_transitions }, problems };
    } finally {
      store.close();
      if (history.ctx) rmSync(history.ctx.dest, { recursive: true, force: true });
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
  raw: string;
  raw_hash: Buffer;
  norm_hash: Buffer;
  trivia: string | null;
  trivia_hash: Buffer | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const BLOCK_COLUMNS = "block_id, doc_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, text, raw, raw_hash, norm_hash, trivia, trivia_hash, created_at, updated_at, deleted_at";

/** A doc's `blocks` rows in pre-order (children by `parent_block`, `ordinal` order); since 17.3 no tombstoned row exists (D2 step two). */
function docBlocksPreorder(db: Db, docId: string, liveOnly: boolean): BlockRaw[] {
  const rows = db
    .prepare(`SELECT ${BLOCK_COLUMNS} FROM blocks WHERE doc_id = ? ${liveOnly ? "AND deleted_at IS NULL" : ""} ORDER BY ordinal, block_id`)
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
    raw: r.raw,
    raw_hash: hex(r.raw_hash)!,
    norm_hash: hex(r.norm_hash)!,
    trivia: r.trivia,
    trivia_hash: hex(r.trivia_hash),
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted_at: r.deleted_at,
  };
}

/** The §9.4 projection of the durable + pinned derived tables of one repo (`repo_id` omitted). */
export function projectStore(db: Db, repoId: string): Omit<Projection, "steps" | "id_claims"> {
  const docs = (db
    .prepare("SELECT doc_id, path, format, head, file_hash, conflicted, leading_trivia, frontmatter_raw, frontmatter_trivia, created_at, updated_at, deleted_at FROM docs WHERE repo_id = ? ORDER BY path")
    .all(repoId) as Record<string, unknown>[]).map(toRow);
  const docIds = docs.map((d) => d.doc_id as string);

  // Phase 4a: a database no repository of which ever enabled capture has no
  // history table — every history projection is `[]` then.
  const history = historyBundlePresent(db);
  const rows = (sql: string, ...params: unknown[]): Record<string, unknown>[] => (history ? (db.prepare(sql).all(...params) as Record<string, unknown>[]) : []);

  // `commits` by (`ts`, `seq`) — the same order as by `seq` while one epoch
  // exists (I4), and the chronological one across an epoch re-mint (§7.5),
  // whose commits restart at `seq = 1`; the rank in this list orders the
  // dispositions and block_changes by commit.
  const commits = rows("SELECT commit_id, epoch, seq, ts, origin, actor, reason, batch_id, ops FROM commits WHERE repo_id = ? ORDER BY ts, seq", repoId).map(toRow);
  const commitSeq = new Map(commits.map((c, i) => [c.commit_id as string, i]));
  const seqOf = (commitId: string): number => commitSeq.get(commitId) ?? Number.MAX_SAFE_INTEGER;

  // 17.0 (3d): the feed and its entries — the rows of the repo's current epoch
  // (a fixture database has one), by `seq`; the entries of a row in the order
  // they were written (the member order of the commit).
  const feed = (db
    .prepare("SELECT epoch, seq, commit_id, ts, origin, actor, reason, batch_id, plan_id FROM feed WHERE repo_id = ? ORDER BY seq")
    .all(repoId) as Record<string, unknown>[]).map(toRow);
  const feed_entries = (db
    .prepare("SELECT epoch, seq, doc_id, path, head, hash, kind, from_path FROM feed_entries WHERE repo_id = ? ORDER BY seq, rowid")
    .all(repoId) as Record<string, unknown>[]).map(toRow);

  const revisions = rows(
    `SELECT r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.rendered_hash, r.path, r.commit_id, r.archive
       FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?`,
    repoId,
  )
    .map(toRow)
    .sort((a, b) => cmp(a.doc_id as string, b.doc_id as string) || (a.seq as number) - (b.seq as number));

  // blobs / tree_nodes are not repo-scoped; a fixture database holds one repo.
  const blobs = (rows("SELECT hash, size, bytes FROM blobs") as unknown as { hash: Buffer; size: number; bytes: Buffer }[])
    .map((b) => ({ hash: hex(b.hash)!, size: b.size, bytes: b.bytes.toString("utf8") }))
    .sort((a, b) => cmp(a.hash, b.hash));
  const tree_nodes = (rows("SELECT hash, entries FROM tree_nodes") as unknown as { hash: Buffer; entries: string }[])
    .map((t) => ({ hash: hex(t.hash)!, entries: t.entries }))
    .sort((a, b) => cmp(a.hash, b.hash));

  const blocks: Projection["blocks"] = [];
  for (const docId of docIds) for (const r of docBlocksPreorder(db, docId, false)) blocks.push(projectBlock(r));

  const byCommitBlockKind = (a: JsonRow, b: JsonRow): number =>
    seqOf(a.commit_id as string) - seqOf(b.commit_id as string) || cmp(a.block_id as string, b.block_id as string) || cmp(a.kind as string, b.kind as string);

  const dispositions = rows(
    `SELECT x.commit_id, x.block_id, x.kind, x.confidence, x.reason, x.matcher_v, x.detail
       FROM dispositions x JOIN commits c ON c.commit_id = x.commit_id WHERE c.repo_id = ?`,
    repoId,
  )
    .map((r): JsonRow => ({ ...toRow({ ...r, detail: null }), detail: JSON.parse(r.detail as string) as Record<string, unknown> }))
    .sort(byCommitBlockKind);

  const block_changes = rows("SELECT bc.block_id, bc.commit_id, bc.kind FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE c.repo_id = ?", repoId)
    .map(toRow)
    .sort(byCommitBlockKind);

  const resurrection_pool = (db
    .prepare("SELECT block_id, doc_id, raw_hash, norm_hash, type, created_at, deleted_at, expires_ts FROM resurrection_pool WHERE repo_id = ?")
    .all(repoId) as Record<string, unknown>[])
    .map(toRow)
    .sort((a, b) => cmp(a.expires_ts as string, b.expires_ts as string) || cmp(a.block_id as string, b.block_id as string));

  const sections = (db
    .prepare("SELECT s.doc_id, s.heading_block, s.level, s.first_ordinal, s.last_ordinal FROM sections s JOIN docs d ON d.doc_id = s.doc_id WHERE d.repo_id = ?")
    .all(repoId) as Record<string, unknown>[])
    .map(toRow)
    .sort((a, b) => cmp(a.doc_id as string, b.doc_id as string) || (a.first_ordinal as number) - (b.first_ordinal as number));

  const pending_materializations = (db
    .prepare("SELECT path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at FROM pending_materializations WHERE repo_id = ? ORDER BY path")
    .all(repoId) as Record<string, unknown>[]).map(toRow);

  // 15.0: the recorded segments, `path` reduced to its file name (the directory
  // is the run's) and `bytes` omitted (a page layout, not a behavior).
  const archives = rows("SELECT segment_id, path, seq_lo, seq_hi, created_at, revision_count FROM archives WHERE repo_id = ? ORDER BY seq_lo, segment_id", repoId)
    .map((r) => toRow({ segment_id: r.segment_id, file: segmentBasename(r.path as string), seq_lo: r.seq_lo, seq_hi: r.seq_hi, created_at: r.created_at, revision_count: r.revision_count }));

  return { docs, commits, feed, feed_entries, revisions, blobs, tree_nodes, blocks, dispositions, block_changes, resurrection_pool, sections, pending_materializations, archives };
}

/**
 * README §9.4 (17.0): the `id_claims` rows of the case's repo as `{ prefix, id,
 * minted_at, holders }`, by (`prefix` bytewise, `id` bytewise). The repository's
 * own `rp` claim and its epoch's `ep` claim (3d) are omitted like `repo_id` is
 * from every row: the runner minted both before the first step, at its own
 * clock. Projected by the store suite alone — the mutate/sync runners that
 * share `projectStore` do not carry it.
 */
export function projectClaims(db: Db, repoId: string): Row[] {
  return (db
    .prepare("SELECT prefix, id, minted_at, holders FROM id_claims WHERE repo_id = ? AND prefix NOT IN ('rp', 'ep')")
    .all(repoId) as Record<string, unknown>[])
    .map(toRow)
    .sort((a, b) => cmp(a.prefix as string, b.prefix as string) || cmp(a.id as string, b.id as string));
}

// ---- invariants (README §8) --------------------------------------------------------------

/**
 * README §8 on a store (17.0): the core invariants C1–C8 — convergence from the
 * rows alone, row hashes, the head present, the timestamps — and, legacy
 * capture being on for every repository through Phase 3, the history
 * invariants H1–H5 (I2, I4–I10 of 16.0, with I3 restated as the recorder's
 * capture AGREEING with the head: the live rows mirror the resolved tree of
 * the revision `docs.head` names, and `frontmatter_raw` equals its resolved
 * frontmatter). `lastSource` is the last observed source per live path (C1
 * needs the bytes the store is supposed to hold). Returns the problems found
 * (empty = every invariant holds).
 */
export function checkInvariants(store: Store, repoId: string, lastSource: ReadonlyMap<string, string>): string[] {
  const db = store.db;
  const problems: string[] = [];

  // ---- A1 alerts re-derive (17.0, 3e-ii) ------------------------------------------------
  // An active alert names a condition the store can re-derive, or is advisory:
  // after re-deriving the channel at the runner's clock (as every reader of it
  // does — a superseded pending row leaves the backlog alert stale until then),
  // a `materialization_backlog` alert's `detail.oldest` is the `created_at` of
  // a pending row of the repository and `detail.pending` counts at least one;
  // `materialization_failed` and `writer_refused` are advisory (a past event,
  // cleared by the next success). Every alert has a §2.4 `since` and a known severity.
  for (const a of activeAlerts(db, repoId)) {
    if (!TS_RE.test(a.since)) problems.push(`A1: alert ${a.code} has a malformed since ${JSON.stringify(a.since)}`);
    if (!["info", "warning", "error"].includes(a.severity)) problems.push(`A1: alert ${a.code} has severity ${JSON.stringify(a.severity)}`);
    if (a.code === MATERIALIZATION_BACKLOG_ALERT) {
      const d = a.detail ?? {};
      const row = typeof d.oldest === "string" ? db.prepare("SELECT 1 FROM pending_materializations WHERE repo_id = ? AND created_at = ?").get(repoId, d.oldest) : undefined;
      if (!row) problems.push(`A1: materialization_backlog names no pending row at ${JSON.stringify(d.oldest)}`);
      if (typeof d.pending !== "number" || d.pending < 1) problems.push(`A1: materialization_backlog counts ${JSON.stringify(d.pending)} pending rows`);
    }
  }

  // ---- the composition and the coverage (README §8, Phase 4a) -------------------------------
  // The history invariants are checked when the store carries the module and the
  // bundle's tables exist (`reader`); within them, what capture promised is
  // bounded by the repository's COVERAGE intervals (spec/store §3.1
  // `capabilities.coverage`): a document whose head was minted outside coverage
  // owes no revision (H1/H3 skip it unless the baseline captured it), a feed row
  // outside coverage owes no `commits` row (H4), `commits.seq` is dense only
  // when capture was never off (I4), and the edge record agrees with the open
  // edges only while capture is on (H6). A core-only run checks C*, F* and A1 alone.
  const reader = historyReader(db);
  const manifest = readCapability(db, repoId, "history");
  const coverage = manifest?.coverage ?? [];
  const captureOn = manifest?.state === "enabled";
  const inCoverage = (ts: string): boolean => coverage.some((i) => i.from <= ts && (i.to === null || ts < i.to));
  const neverOff = coverage.length === 1 && coverage[0]!.to === null && coverage[0]!.from <= FIXTURE_BIRTH;

  const blobRows = reader ? (db.prepare("SELECT hash, bytes, size FROM blobs").all() as { hash: Buffer; bytes: Buffer; size: number }[]) : [];
  const blobHashes = new Set(blobRows.map((b) => b.hash.toString("hex")));
  const blobText = new Map(blobRows.map((b) => [b.hash.toString("hex"), b.bytes.toString("utf8")] as const));
  const treeRows = reader ? (db.prepare("SELECT hash, entries FROM tree_nodes").all() as { hash: Buffer; entries: string }[]) : [];
  const treeHashes = new Set(treeRows.map((t) => t.hash.toString("hex")));
  const nodeTexts = new Map(treeRows.map((t) => [t.hash.toString("hex"), t.entries] as const));
  // 16.0: nodes resolve in revision context (README §4.1 "Delta nodes", §6) — the resolver prepares its statements on the bundle's tables, so only with the module.
  const resolver = reader ? new TreeResolver(db) : null;
  const commits = reader ? (db.prepare("SELECT commit_id, seq, ts FROM commits WHERE repo_id = ? ORDER BY ts, seq").all(repoId) as { commit_id: string; seq: number; ts: string }[]) : [];
  const commitById = new Map(commits.map((c) => [c.commit_id, c]));
  const docs = db
    .prepare("SELECT doc_id, path, head, file_hash, frontmatter_raw, created_at, updated_at, deleted_at FROM docs WHERE repo_id = ? ORDER BY path")
    .all(repoId) as { doc_id: string; path: string; head: string | null; file_hash: Buffer | null; frontmatter_raw: string | null; created_at: string; updated_at: string; deleted_at: string | null }[];
  const revisions = reader
    ? (db
      .prepare("SELECT r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.rendered_hash, r.path, r.commit_id, r.archive FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?")
      .all(repoId) as { rev_id: string; doc_id: string; seq: number; root_tree: Buffer | null; frontmatter_blob: Buffer | null; rendered_hash: Buffer; path: string; commit_id: string; archive: string | null }[])
    : [];
  const revById = new Map(revisions.map((r) => [r.rev_id, r]));

  // ---- I9 archived revisions (15.0) ---------------------------------------------------
  // `archive IS NOT NULL` ⇔ `root_tree IS NULL`, and an archived revision has no
  // frontmatter blob either: the bodies moved to the segment, the row stayed.
  for (const r of revisions) {
    if (r.archive !== null && (r.root_tree !== null || r.frontmatter_blob !== null)) problems.push(`I9: archived revision ${r.rev_id} still carries a root_tree or frontmatter_blob`);
    if (r.archive === null && r.root_tree === null) problems.push(`I9: live revision ${r.rev_id} has no root_tree`);
  }

  // ---- I2 hash integrity --------------------------------------------------------
  for (const b of blobRows) {
    const h = b.hash.toString("hex");
    if (!sha256(b.bytes).equals(b.hash)) problems.push(`I2: blob ${h} hash != sha256(bytes)`);
    if (b.size !== b.bytes.length) problems.push(`I2: blob ${h} size ${b.size} != |bytes| ${b.bytes.length}`);
  }
  for (const t of treeRows) {
    const h = t.hash.toString("hex");
    if (!sha256(t.entries).equals(t.hash)) problems.push(`I2: tree_node ${h} hash != sha256(entries)`);
    const node = parseNodeText(t.entries);
    if (!node) {
      problems.push(`I2: tree_node ${h} entries do not parse as §4.1 (full or delta)`);
      continue;
    }
    // 16.0: a `{`-node names only its own `+`/`~` entries; the kept ones are the base's.
    for (const [id, raw, child, , , trivia] of explicitEntries(node)) {
      if (!blobHashes.has(raw)) problems.push(`I2: tree_node ${h} entry ${id} raw_hash ${raw} not in blobs`);
      if (trivia !== null && !blobHashes.has(trivia)) problems.push(`I2: tree_node ${h} entry ${id} trivia_hash ${trivia} not in blobs`);
      if (child !== null && !treeHashes.has(child)) problems.push(`I2: tree_node ${h} entry ${id} child tree ${child} not in tree_nodes`);
    }
  }
  for (const r of revisions) {
    if (r.root_tree && !treeHashes.has(r.root_tree.toString("hex"))) problems.push(`I2: revision ${r.rev_id} root_tree not in tree_nodes`);
    if (r.frontmatter_blob) {
      const fh = r.frontmatter_blob.toString("hex");
      if (!blobHashes.has(fh)) problems.push(`I2: revision ${r.rev_id} frontmatter_blob not in blobs`);
      else if (parseFrontmatterBlob(blobText.get(fh)!) === null) problems.push(`I2: revision ${r.rev_id} frontmatter blob ${fh} is neither a raw nor a §4.1 frontmatter delta`);
    }
  }

  // ---- I10 delta nodes (16.0) ----------------------------------------------------------
  // Every live revision's root and frontmatter resolve in context; a delta's
  // previous revision exists and is live; a checkpoint revision is in
  // checkpoint form (a self-contained root, a raw frontmatter); every delta
  // reachable from a live revision is strictly smaller than its full form.
  const resolvedTrees = new Map<string, ReturnType<TreeResolver["tree"]>>();
  const resolvedFrontmatter = new Map<string, string>();
  for (const r of revisions) {
    if (r.root_tree === null) continue;
    const prev = revisions.find((p) => p.doc_id === r.doc_id && p.seq === r.seq - 1);
    const rootHex = r.root_tree.toString("hex");
    const rootText = nodeTexts.get(rootHex);
    const fmHex = r.frontmatter_blob ? r.frontmatter_blob.toString("hex") : null;
    const fmText = fmHex ? blobText.get(fmHex) : undefined;
    const rootIsDelta = rootText !== undefined && rootText.startsWith("{");
    const fmIsDelta = fmText !== undefined && fmText.startsWith("{");
    const checkpoint = isCheckpointSeq(r.seq) || prev === undefined || prev.archive !== null;
    if ((rootIsDelta || fmIsDelta) && (prev === undefined || prev.archive !== null)) {
      problems.push(`I10: revision ${r.rev_id} (seq ${r.seq}) is a delta but revision ${r.seq - 1} is ${prev === undefined ? "missing" : "archived"}`);
    }
    if (checkpoint && fmIsDelta) problems.push(`I10: checkpoint revision ${r.rev_id} (seq ${r.seq}) has a delta frontmatter`);
    try {
      const tree = resolver!.tree(r.doc_id, r.seq, rootHex);
      resolvedTrees.set(r.rev_id, tree);
      if (checkpoint && !tree.root.selfContained) problems.push(`I10: checkpoint revision ${r.rev_id} (seq ${r.seq}) root is not self-contained`);
      // The never-larger rule, over every list of the tree.
      const check = (list: ResolvedList, where: string): void => {
        if (list.form !== "delta") return;
        const text = nodeTexts.get(list.hash)!;
        const full = fullNodeText(list.entries.map(entryText));
        if (byteLength(text) >= byteLength(full)) problems.push(`I10: delta node ${list.hash} (${where}) is not smaller than its full form (${byteLength(text)} >= ${byteLength(full)})`);
      };
      check(tree.root, `root of ${r.rev_id}`);
      for (const [block, list] of tree.byBlock) check(list, `children of ${block} in ${r.rev_id}`);
      // A delta at a non-checkpoint is the Myers script against the base, exactly.
      if (rootIsDelta && prev?.root_tree) {
        const base = resolver!.tree(r.doc_id, prev.seq, prev.root_tree.toString("hex"));
        const want = encodeBodyDelta(base.root.texts, tree.root.texts);
        if (want !== rootText) problems.push(`I10: delta root of ${r.rev_id} is not the §4.1 encoding against revision ${prev.seq}`);
      }
    } catch (e) {
      if (e instanceof DeltaError) problems.push(`I10: revision ${r.rev_id} does not resolve: ${e.message}`);
      else throw e;
    }
    if (fmHex) {
      try {
        const raw = resolver!.frontmatter(r.doc_id, r.seq, fmHex);
        resolvedFrontmatter.set(r.rev_id, raw);
        if (fmIsDelta && byteLength(fmText!) >= byteLength(raw)) problems.push(`I10: frontmatter delta of ${r.rev_id} is not smaller than the raw`);
        if (fmIsDelta && prev?.frontmatter_blob) {
          const baseRaw = resolver!.frontmatter(r.doc_id, prev.seq, prev.frontmatter_blob.toString("hex"));
          if (encodeFrontmatterDelta(baseRaw, raw) !== fmText) problems.push(`I10: frontmatter delta of ${r.rev_id} is not the §4.1 encoding against revision ${prev.seq}`);
        }
      } catch (e) {
        if (e instanceof DeltaError) problems.push(`I10: frontmatter of ${r.rev_id} does not resolve: ${e.message}`);
        else throw e;
      }
    }
  }

  // ---- C2 row hashes (17.0): every block's bytes are on its row ------------------------
  const allBlocks = db.prepare(`SELECT ${BLOCK_COLUMNS} FROM blocks b WHERE EXISTS (SELECT 1 FROM docs d WHERE d.doc_id = b.doc_id AND d.repo_id = ?)`).all(repoId) as BlockRaw[];
  for (const b of allBlocks) {
    if (!sha256(b.raw).equals(b.raw_hash)) problems.push(`C2: block ${b.block_id} raw_hash != sha256(raw)`);
    if ((b.trivia === null) !== (b.trivia_hash === null)) problems.push(`C2: block ${b.block_id} trivia and trivia_hash disagree on NULL`);
    else if (b.trivia !== null && !sha256(b.trivia).equals(b.trivia_hash!)) problems.push(`C2: block ${b.block_id} trivia_hash != sha256(trivia)`);
    if (b.trivia === "") problems.push(`C2: block ${b.block_id} has an empty trivia instead of NULL`);
    if (!sha256(b.text).equals(b.norm_hash)) problems.push(`C2: block ${b.block_id} norm_hash != sha256(text)`);
    // C7: a block's timestamps are ordered and bounded by its document's.
    if (b.created_at > b.updated_at) problems.push(`C7: block ${b.block_id} created_at ${b.created_at} > updated_at ${b.updated_at}`);
  }
  const docById = new Map(docs.map((d) => [d.doc_id, d]));
  for (const b of allBlocks) {
    const d = docById.get(b.doc_id);
    if (!d) continue;
    // 17.3 (D2 step two): a tombstone deletes the rows — no `blocks` row is tombstoned and a tombstoned doc has none.
    if (b.deleted_at !== null) problems.push(`C7: block ${b.block_id} is tombstoned (deleted_at ${b.deleted_at}) — a tombstone deletes the rows since 17.3`);
    if (d.deleted_at !== null) problems.push(`C7: tombstoned doc ${d.doc_id} has a block row ${b.block_id}`);
    if (b.updated_at > d.updated_at) problems.push(`C7: block ${b.block_id} updated_at ${b.updated_at} > its document's ${d.updated_at}`);
  }

  // ---- C4 the head, C7 the document's timestamps ---------------------------------------
  for (const d of docs) {
    if (d.created_at > d.updated_at) problems.push(`C7: doc ${d.doc_id} created_at ${d.created_at} > updated_at ${d.updated_at}`);
    if (d.deleted_at === null && d.head === null) problems.push(`C4: live doc ${d.doc_id} (${d.path}) has no head`);
    if (d.deleted_at !== null && d.deleted_at !== d.updated_at) problems.push(`C7: tombstoned doc ${d.doc_id} deleted_at ${d.deleted_at} != updated_at ${d.updated_at}`);
  }

  // ---- C8 pending rows (17.0, M4): self-contained against the current rows ----------------
  // A `write`/`rename` row names a live document's current head and the bytes
  // that head renders to (`rendered_hash == docs.file_hash == sha256(reconstruct)`);
  // a `remove` row names a tombstoned document, no head, no prior, the bytes it
  // owes an unlink (`docs.file_hash` before the tombstone). `prior_hash` is
  // defined, not derivable (the bytes it names left the store), so only its
  // nullness is checked. Kind and `from_path` agree; `commit_id` is a `c_` id
  // and, with capture on, a `commits` row whose `ts` is `created_at`.
  const pendingRows = db
    .prepare("SELECT path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at FROM pending_materializations WHERE repo_id = ? ORDER BY path")
    .all(repoId) as { path: string; kind: string; from_path: string | null; doc_id: string; head: string | null; rendered_hash: Buffer; prior_hash: Buffer | null; commit_id: string; created_at: string }[];
  for (const p of pendingRows) {
    const at = `pending ${p.kind} at ${p.path}`;
    const d = docById.get(p.doc_id);
    if (!d) {
      problems.push(`C8: ${at} names no docs row (${p.doc_id})`);
      continue;
    }
    if ((p.kind === "rename") !== (p.from_path !== null)) problems.push(`C8: ${at} from_path ${p.from_path} disagrees with its kind`);
    if (!TS_RE.test(p.created_at)) problems.push(`C8: ${at} created_at ${p.created_at} is not a §2.4 timestamp`);
    if (!p.commit_id.startsWith("c_")) problems.push(`C8: ${at} commit_id ${p.commit_id} is not a c_ id`);
    const c = commitById.get(p.commit_id);
    if (c && c.ts !== p.created_at) problems.push(`C8: ${at} created_at ${p.created_at} != its commit's ts ${c.ts}`);
    if (p.kind === "remove") {
      if (p.head !== null) problems.push(`C8: ${at} carries a head (${p.head})`);
      if (p.prior_hash !== null) problems.push(`C8: ${at} carries a prior_hash`);
      if (d.deleted_at === null) problems.push(`C8: ${at} names a live document`);
      if (d.file_hash && !p.rendered_hash.equals(d.file_hash)) problems.push(`C8: ${at} rendered_hash != the tombstoned document's file_hash`);
      continue;
    }
    if (d.deleted_at !== null) problems.push(`C8: ${at} names a tombstoned document`);
    if (p.head === null || p.head !== d.head) problems.push(`C8: ${at} head ${p.head} != docs.head ${d.head}`);
    if (!d.file_hash || !p.rendered_hash.equals(d.file_hash)) problems.push(`C8: ${at} rendered_hash != docs.file_hash`);
    const bytes = reconstructContent(db, p.doc_id);
    if (bytes === null || !sha256(bytes).equals(p.rendered_hash)) problems.push(`C8: ${at} reconstruct(doc) does not hash to rendered_hash`);
  }

  // ---- C1 convergence from the rows; H1/H3 the recorder's capture agrees with the head ----
  for (const d of docs) {
    if (d.deleted_at !== null || d.head === null) continue;
    const at = `doc ${d.doc_id} (${d.path})`;
    const source = lastSource.get(d.path);
    if (source === undefined) {
      problems.push(`C1: ${at} is live but no source was observed for its path`);
    } else {
      const want = sha256(source);
      if (!d.file_hash || !d.file_hash.equals(want)) problems.push(`C1: ${at} file_hash != sha256(source)`);
      if (reconstructContent(db, d.doc_id) !== source) problems.push(`C1: ${at} reconstruct(doc) != source`);
    }
    // H1: with capture on, the head IS a captured revision — same path, same
    // bytes, the same commit instant as `updated_at` — and reconstruct at it
    // reproduces the source. Phase 4a: owed only for a head minted within
    // coverage (a head minted while capture was off has a row only when the
    // baseline of a later `history enable` wrote one — then the row's commit is
    // the baseline's, not the head's, so the instant is not compared); without
    // the module nothing is owed.
    const rev = revById.get(d.head);
    if (!rev) {
      if (reader && inCoverage(d.updated_at)) problems.push(`H1: ${at} head ${d.head} has no revisions row (capture disagrees with the head)`);
      continue;
    }
    if (rev.root_tree === null) {
      problems.push(`H1: ${at} head ${d.head} is archived (never prunable)`);
      continue;
    }
    if (rev.path !== d.path) problems.push(`H1: ${at} revision ${d.head} carries path ${rev.path}`);
    if (d.file_hash && !rev.rendered_hash.equals(d.file_hash)) problems.push(`H1: ${at} revision ${d.head} rendered_hash != file_hash`);
    const headCommit = commitById.get(rev.commit_id);
    if (headCommit && inCoverage(d.updated_at) && headCommit.ts !== d.updated_at) problems.push(`C7: ${at} updated_at ${d.updated_at} != the head commit's ts ${headCommit.ts}`);
    if (source !== undefined) {
      const atRev = readDocumentAtRevision(store, d.doc_id, d.head);
      if (!atRev) problems.push(`H1: ${at} reconstruct at ${d.head} returned nothing`);
      else {
        if (atRev._raw !== source) problems.push(`H1: ${at} reconstruct at ${d.head} != source`);
        if (!atRev.renderedHashMatch) problems.push(`H1: ${at} rendered_hash_match is false at the current revision`);
      }
    }
    // H3 (frontmatter): the row's current frontmatter equals the head revision's resolved one.
    const fmResolved = rev.frontmatter_blob ? resolvedFrontmatter.get(rev.rev_id) ?? null : null;
    if (fmResolved !== d.frontmatter_raw) problems.push(`H3: ${at} frontmatter_raw differs from the head revision's resolved frontmatter`);

    // H3: live rows as a tree vs the head revision's resolved Merkle tree.
    const live = db.prepare(`SELECT ${BLOCK_COLUMNS} FROM blocks WHERE doc_id = ? AND deleted_at IS NULL`).all(d.doc_id) as BlockRaw[];
    const liveIds = new Set(live.map((r) => r.block_id));
    const children = new Map<string | null, BlockRaw[]>();
    for (const r of live) {
      let list = children.get(r.parent_block);
      if (!list) children.set(r.parent_block, (list = []));
      list.push(r);
    }
    for (const list of children.values()) list.sort((a, b) => cmp(a.order_key, b.order_key));
    for (const [parent] of children) {
      if (parent !== null && !liveIds.has(parent)) problems.push(`C3: ${at} live rows name a parent ${parent} that is not live`);
    }
    // 16.0: the tree compared is the head revision's RESOLVED tree.
    const resolved = resolvedTrees.get(rev.rev_id);
    if (!resolved) {
      problems.push(`H3: ${at} head revision ${rev.rev_id} did not resolve`);
      continue;
    }
    const compare = (treeHex: string | null, parent: BlockRaw | null, depth: number, ancestorPath: string): void => {
      const rows = children.get(parent?.block_id ?? null) ?? [];
      const entries = treeHex === null ? [] : parent === null ? resolved.root.entries : resolved.byBlock.get(parent.block_id)?.entries ?? [];
      const where = parent ? `${at} under ${parent.block_id}` : `${at} top level`;
      if (rows.length !== entries.length) {
        problems.push(`H3: ${where}: ${rows.length} live rows vs ${entries.length} tree entries`);
        return;
      }
      rows.forEach((r, i) => {
        const [id, raw, child, type, attrs, trivia] = entries[i]!;
        if (r.block_id !== id) problems.push(`H3: ${where}[${i}]: block ${r.block_id} vs tree entry ${id}`);
        if (r.type !== type) problems.push(`H3: ${where}[${i}]: type ${r.type} vs ${type}`);
        if (r.raw_hash.toString("hex") !== raw) problems.push(`H3: ${where}[${i}]: raw_hash differs from the tree entry`);
        if ((r.trivia_hash ? r.trivia_hash.toString("hex") : null) !== trivia) problems.push(`H3: ${where}[${i}]: trivia_hash differs from the tree entry`);
        if (r.ordinal !== i) problems.push(`C3: ${where}[${i}]: ordinal ${r.ordinal} (order_key order says ${i})`);
        if (r.depth !== depth) problems.push(`C3: ${where}[${i}]: depth ${r.depth} != ${depth}`);
        if (r.ancestor_path !== ancestorPath) problems.push(`C3: ${where}[${i}]: ancestor_path ${r.ancestor_path} != ${ancestorPath}`);
        const diff = deepEqualTol(JSON.parse(r.attrs), attrs, 0);
        if (diff) problems.push(`H3: ${where}[${i}]: attrs differ from the tree entry (${diff})`);
        compare(child, r, depth + 1, `${ancestorPath}${r.block_id}/`);
      });
    };
    compare(rev.root_tree.toString("hex"), null, 0, "/");
  }

  // ---- C4 the dense feed, F1–F3 the entries, H4 the log's agreement (17.0, 3d) ----------
  const epoch = (db.prepare("SELECT epoch FROM repos WHERE repo_id = ?").get(repoId) as { epoch: string } | undefined)?.epoch;
  if (epoch === undefined || !epoch.startsWith("ep_")) problems.push(`C4: repo ${repoId} has no ep_ epoch (${epoch})`);
  const feedRows = db.prepare("SELECT epoch, seq, commit_id, ts, origin, actor, reason, batch_id, plan_id FROM feed WHERE repo_id = ? ORDER BY ts, seq").all(repoId) as { epoch: string; seq: number; commit_id: string; ts: string; origin: string; batch_id: string; plan_id: string | null }[];
  const feedBySeq = [...feedRows].sort((a, b) => a.seq - b.seq);
  const oldest = feedBySeq.length > 0 ? feedBySeq[0]!.seq : 0;
  const headSeq = feedBySeq.length > 0 ? feedBySeq[feedBySeq.length - 1]!.seq : 0;
  if (oldest > headSeq) problems.push(`F2: feed oldest ${oldest} > head ${headSeq}`);
  if ((oldest === 0) !== (headSeq === 0)) problems.push(`F2: feed oldest ${oldest} and head ${headSeq} disagree on emptiness`);
  feedRows.forEach((r, i) => {
    if (r.seq !== oldest + i) problems.push(`C4: feed row ${r.commit_id} has seq ${r.seq} at position ${i} of (ts, seq) order from oldest ${oldest} (the feed is not contiguous)`);
    if (r.epoch !== epoch) problems.push(`C4: feed row ${r.commit_id} carries epoch ${r.epoch}, the repo's is ${epoch}`);
    if (!TS_RE.test(r.ts)) problems.push(`C4: feed row ${r.commit_id} ts ${r.ts} is not a §2.4 timestamp`);
    if (!r.commit_id.startsWith("c_")) problems.push(`C4: feed row seq ${r.seq} commit_id ${r.commit_id} is not a c_ id`);
    if (!r.batch_id.startsWith("c_")) problems.push(`C4: feed row ${r.commit_id} batch_id ${r.batch_id} is not a c_ id`);
    // The batch id names a feed row of the same epoch at or before this one (D4: the first committing member), unless pruned.
    const batchRow = feedBySeq.find((b) => b.commit_id === r.batch_id);
    if (batchRow && batchRow.seq > r.seq) problems.push(`C4: feed row ${r.commit_id} (seq ${r.seq}) names a later batch ${r.batch_id} (seq ${batchRow.seq})`);
    if (!batchRow && r.batch_id !== r.commit_id && (oldest <= 1)) problems.push(`C4: feed row ${r.commit_id} names a batch ${r.batch_id} the feed does not hold`);
    if (r.plan_id !== null && !/^[0-9a-f]{64}$/.test(r.plan_id)) problems.push(`C4: feed row ${r.commit_id} plan_id ${r.plan_id} is not 64 hex`);
    if (r.plan_id !== null && r.origin !== "api") problems.push(`C4: feed row ${r.commit_id} of origin ${r.origin} carries a plan_id`);
  });
  const entries = db.prepare("SELECT epoch, seq, doc_id, path, head, hash, kind, from_path, rowid FROM feed_entries WHERE repo_id = ? ORDER BY seq, rowid").all(repoId) as { epoch: string; seq: number; doc_id: string; path: string; head: string | null; hash: Buffer | null; kind: string; from_path: string | null; rowid: number }[];
  const feedSeqs = new Set(feedBySeq.map((r) => r.seq));
  const lastKindOfDoc = new Map<string, string>();
  for (const e of entries) {
    const at = `feed entry (${e.seq}, ${e.doc_id})`;
    if (!feedSeqs.has(e.seq)) problems.push(`F1: ${at} has no feed row`);
    if (e.epoch !== epoch) problems.push(`F1: ${at} carries epoch ${e.epoch}`);
    if (!docById.has(e.doc_id)) problems.push(`F1: ${at} names no docs row`);
    if (e.kind === "deleted") {
      if (e.head !== null || e.hash !== null) problems.push(`F3: ${at} is deleted but carries a head or a hash`);
    } else {
      if (e.head === null || e.hash === null) problems.push(`F3: ${at} (${e.kind}) lacks a head or a hash`);
      if (e.head !== null && !e.head.startsWith("r_")) problems.push(`F3: ${at} head ${e.head} is not an r_ id`);
    }
    if ((e.kind === "moved") !== (e.from_path !== null)) problems.push(`F3: ${at} from_path ${e.from_path} disagrees with kind ${e.kind}`);
    if (e.kind === "moved" && e.from_path === e.path) problems.push(`F3: ${at} moved from its own path ${e.path}`);
    // The kinds in sequence per document (over the retained feed): a `created`
    // follows nothing or a `deleted`; a `changed`/`moved` never follows a `deleted`.
    const prev = lastKindOfDoc.get(e.doc_id);
    if (e.kind === "created" && prev !== undefined && prev !== "deleted") problems.push(`F3: ${at} is created but the document's previous entry is ${prev}`);
    if ((e.kind === "changed" || e.kind === "moved") && prev === "deleted") problems.push(`F3: ${at} is ${e.kind} right after a deleted entry (a revival is created)`);
    lastKindOfDoc.set(e.doc_id, e.kind);
  }
  // F1: every head still within the retained feed has its entry: every live
  // doc's head and every tombstone's deletion whose last change is not older
  // than the oldest retained row (a prune takes rows from the front; an epoch
  // re-mint, §7.5, empties the feed — the documents committed before it have
  // no entry and none is owed).
  const oldestTs = feedBySeq.length > 0 ? feedBySeq[0]!.ts : null;
  const headsInFeed = new Set(entries.map((e) => e.head).filter((h): h is string => h !== null));
  const deletedInFeed = new Set(entries.filter((e) => e.kind === "deleted").map((e) => e.doc_id));
  for (const d of docs) {
    const within = oldestTs !== null && d.updated_at >= oldestTs;
    if (!within) continue;
    if (d.deleted_at === null && d.head !== null && !headsInFeed.has(d.head)) problems.push(`F1: live doc ${d.doc_id} (${d.path}) head ${d.head} appears in no feed entry`);
    if (d.deleted_at !== null && !deletedInFeed.has(d.doc_id)) problems.push(`F1: tombstoned doc ${d.doc_id} (${d.path}) has no deleted entry`);
    // C7: the document's updated_at is the ts of the feed row whose entry carries its head.
    if (d.deleted_at === null && d.head !== null) {
      const e = entries.find((x) => x.head === d.head);
      const row = e ? feedBySeq.find((r) => r.seq === e.seq) : undefined;
      if (row && row.ts !== d.updated_at) problems.push(`C7: doc ${d.doc_id} updated_at ${d.updated_at} != the ts ${row.ts} of the feed row carrying its head`);
    }
  }
  // H4: the recorder's `commits` agree with the feed on every retained seq
  // WITHIN COVERAGE (Phase 4a: a feed row written while capture was off has no
  // log row) and AT OR AFTER THE LOG'S OLDEST ROW of the epoch (Phase 4b: a
  // `history purge` trims the log's head — a feed row older than every
  // retained commit owes none; a repository with no commit owes none), and
  // every log row of the current epoch at or after the oldest retained feed row
  // IS a feed row (the log is a subsequence of the feed).
  const commitRows = reader ? (db.prepare("SELECT commit_id, epoch, seq, ts, batch_id FROM commits WHERE repo_id = ? ORDER BY seq").all(repoId) as { commit_id: string; epoch: string; seq: number; ts: string; batch_id: string }[]) : [];
  const commitBySeq = new Map(commitRows.filter((c) => c.epoch === epoch).map((c) => [c.seq, c]));
  const oldestLogSeq = commitBySeq.size > 0 ? Math.min(...commitBySeq.keys()) : Infinity;
  for (const r of feedBySeq) {
    const c = commitBySeq.get(r.seq);
    if (!c) {
      if (reader && inCoverage(r.ts) && r.seq >= oldestLogSeq) problems.push(`H4: feed row ${r.commit_id} (seq ${r.seq}) has no commits row`);
    } else if (c.commit_id !== r.commit_id || c.epoch !== r.epoch || c.batch_id !== r.batch_id) problems.push(`H4: commits row at seq ${r.seq} (${c.commit_id}, ${c.epoch}, ${c.batch_id}) disagrees with the feed (${r.commit_id}, ${r.epoch}, ${r.batch_id})`);
  }
  const feedByCommit = new Map(feedBySeq.map((r) => [r.commit_id, r]));
  for (const c of commitRows) if (c.epoch === epoch && c.seq >= oldest && !feedByCommit.has(c.commit_id)) problems.push(`H4: commits row ${c.commit_id} (seq ${c.seq}) is within the retained feed but has no feed row`);
  // A commit of an earlier epoch is a re-mint's (§7.5): its epoch must still be a claimed `ep` of the repository.
  const epochClaim = db.prepare("SELECT 1 FROM id_claims WHERE id = ? AND prefix = 'ep' AND repo_id = ?");
  for (const c of commitRows) if (c.epoch !== epoch && !epochClaim.get(c.epoch, repoId)) problems.push(`H4: commit ${c.commit_id} carries epoch ${c.epoch}, which is neither the repository's nor a claimed earlier one`);

  // ---- I4 sequences (per epoch since 17.0: a re-mint restarts the seq) -----------------
  // `commits.seq` is strictly increasing in (ts, seq) order per epoch, and
  // dense from the oldest retained row when capture was never off (Phase 4a: a
  // disabled interval leaves the feed's seqs of that span out of the log; Phase
  // 4b: a purge trims the log's head, so the run starts where the log does).
  const commitsByEpoch = new Map<string, typeof commits>();
  for (const c of commitRows.slice().sort((a, b) => cmp(a.ts, b.ts) || a.seq - b.seq)) {
    let list = commitsByEpoch.get(c.epoch);
    if (!list) commitsByEpoch.set(c.epoch, (list = []));
    list.push(c);
  }
  for (const [ep, list] of commitsByEpoch) {
    list.forEach((c, i) => {
      if (neverOff && c.seq !== list[0]!.seq + i) problems.push(`I4: commit ${c.commit_id} has seq ${c.seq} at position ${i + 1} in (ts, seq) order of epoch ${ep} (the log begins at seq ${list[0]!.seq})`);
      if (i > 0 && c.seq <= list[i - 1]!.seq) problems.push(`I4: commit ${c.commit_id} has seq ${c.seq} after seq ${list[i - 1]!.seq} in (ts, seq) order of epoch ${ep}`);
    });
  }
  for (const d of docs) {
    const revs = revisions.filter((r) => r.doc_id === d.doc_id).sort((a, b) => a.seq - b.seq);
    // Per document the retained revisions' seqs are consecutive; they begin at 1
    // unless a purge trimmed the document's history (Phase 4b).
    revs.forEach((r, i) => {
      if (r.seq !== revs[0]!.seq + i) problems.push(`I4: revision ${r.rev_id} of ${d.doc_id} has seq ${r.seq}, expected ${revs[0]!.seq + i}`);
    });
    // Phase 4a: a head minted while capture was off is newer than every captured revision (until a baseline captures it).
    if (revs.length > 0 && d.deleted_at === null && inCoverage(d.updated_at) && d.head !== revs[revs.length - 1]!.rev_id) problems.push(`I4: doc ${d.doc_id} head ${d.head} is not its greatest-seq revision`);
    if (revs.length === 0 && d.head !== null && reader && inCoverage(d.updated_at)) problems.push(`I4: doc ${d.doc_id} has head but no revisions`);
  }

  // ---- I5 nothing to collect -----------------------------------------------------------
  // 16.0: the EXPLICIT mark — a node marks the entries its own text carries
  // (all of a `[`-node's, the `+`/`~` of a `{`-node); the kept entries are the
  // base revision's to mark, and I10 says the base is live.
  const markedTrees = new Set<string>();
  const markedBlobs = new Set<string>();
  const mark = (treeHex: string): void => {
    if (markedTrees.has(treeHex)) return;
    markedTrees.add(treeHex);
    const text = nodeTexts.get(treeHex);
    const node = text === undefined ? null : parseNodeText(text);
    if (!node) return;
    for (const [, raw, child, , , trivia] of explicitEntries(node)) {
      markedBlobs.add(raw);
      if (trivia !== null) markedBlobs.add(trivia);
      if (child !== null) mark(child);
    }
  };
  // 15.0: the mark walks the LIVE revisions; an archived one's bodies are its segment's.
  for (const r of revisions) {
    if (r.root_tree) mark(r.root_tree.toString("hex"));
    if (r.frontmatter_blob) markedBlobs.add(r.frontmatter_blob.toString("hex"));
  }
  for (const h of treeHashes) if (!markedTrees.has(h)) problems.push(`I5: tree_node ${h} is unreachable from every live revision`);
  for (const h of blobHashes) if (!markedBlobs.has(h)) problems.push(`I5: blob ${h} is unreachable from every live revision`);

  // ---- C6 pool (17.0; I6 restated over the row's own `deleted_at`) -----------------------
  const liveRowOf = db.prepare("SELECT doc_id FROM blocks WHERE block_id = ? AND deleted_at IS NULL");
  const pool = db.prepare("SELECT block_id, created_at, deleted_at, expires_ts FROM resurrection_pool WHERE repo_id = ?").all(repoId) as { block_id: string; created_at: string; deleted_at: string; expires_ts: string }[];
  for (const p of pool) {
    if (!TS_RE.test(p.deleted_at)) problems.push(`C6: pool row ${p.block_id} deleted_at ${p.deleted_at} is not a §2.4 timestamp`);
    if (p.expires_ts !== expiresAfter(p.deleted_at)) problems.push(`C6: pool row ${p.block_id} expires_ts ${p.expires_ts} != deleted_at ${p.deleted_at} + 30 days`);
    if (p.created_at > p.deleted_at) problems.push(`C6: pool row ${p.block_id} created_at ${p.created_at} > deleted_at ${p.deleted_at}`);
    if (liveRowOf.get(p.block_id)) problems.push(`C6: pool row ${p.block_id} has a live blocks row`);
  }

  // ---- C5 claims (17.0, §2.1) -------------------------------------------------------------
  // Every id a core row of the repo carries names an `id_claims` row with the
  // core's bit; a pool id is claimed; no claim has `holders = 0`; H6 — every id
  // a history row names has the recorder's bit.
  const claimOf = db.prepare("SELECT holders FROM id_claims WHERE id = ?");
  const coreIds: [string, string][] = [];
  for (const d of docs) {
    coreIds.push(["d", d.doc_id]);
    if (d.head !== null) coreIds.push(["r", d.head]);
  }
  for (const r of db.prepare("SELECT b.block_id FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE d.repo_id = ?").all(repoId) as { block_id: string }[]) coreIds.push(["b", r.block_id]);
  for (const p of pool) coreIds.push(["b", p.block_id]);
  for (const r of db.prepare("SELECT node_id FROM external_nodes WHERE repo_id = ?").all(repoId) as { node_id: string }[]) coreIds.push(["x", r.node_id]);
  for (const r of db.prepare("SELECT edge_id FROM edges WHERE repo_id = ?").all(repoId) as { edge_id: string }[]) coreIds.push(["e", r.edge_id]);
  coreIds.push(["rp", repoId]);
  if (epoch !== undefined) coreIds.push(["ep", epoch]);
  for (const r of feedBySeq) {
    coreIds.push(["c", r.commit_id]);
    coreIds.push(["c", r.batch_id]);
  }
  for (const e of entries) if (e.head !== null) coreIds.push(["r", e.head]);
  for (const [prefix, id] of coreIds) {
    const c = claimOf.get(id) as { holders: number } | undefined;
    if (!c) problems.push(`C5: ${prefix} ${id} names a core row but has no id_claims row`);
    else if ((c.holders & 1) === 0) problems.push(`C5: claim ${id} (${prefix}) lacks the core's bit (holders ${c.holders})`);
  }
  for (const r of db.prepare("SELECT id, prefix, holders, minted_at FROM id_claims WHERE repo_id = ?").all(repoId) as { id: string; prefix: string; holders: number; minted_at: string }[]) {
    if (r.holders === 0) problems.push(`C5: claim ${r.id} has holders = 0`);
    if (!r.id.startsWith(`${r.prefix}_`)) problems.push(`C5: claim ${r.id} is filed under prefix ${r.prefix}`);
    if (!TS_RE.test(r.minted_at)) problems.push(`C5: claim ${r.id} minted_at ${r.minted_at} is not a §2.4 timestamp`);
  }
  const unheld = !reader ? [] : db
    .prepare(
      `SELECT DISTINCT bc.block_id AS id FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE c.repo_id = ? AND bc.block_id != 'DOC'
         AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = bc.block_id AND (ic.holders & 2) != 0)
       UNION SELECT r.rev_id FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?
         AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = r.rev_id AND (ic.holders & 2) != 0)
       UNION SELECT DISTINCT r.doc_id FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE d.repo_id = ?
         AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = r.doc_id AND (ic.holders & 2) != 0)
       UNION SELECT c.commit_id FROM commits c WHERE c.repo_id = ?
         AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = c.commit_id AND (ic.holders & 2) != 0)
       UNION SELECT t.edge_id FROM edge_transitions t WHERE t.repo_id = ?
         AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = t.edge_id AND (ic.holders & 2) != 0)
       ORDER BY 1`,
    )
    .all(repoId, repoId, repoId, repoId, repoId) as { id: string }[];
  for (const r of unheld) problems.push(`H6: ${r.id} is named by a history row but its claim lacks the recorder's bit`);
  // Without the module nothing below applies: the dispositions, the projection and the archive rule are the recorder's.
  if (!reader) return problems;
  // H6 (17.0, M6): the open transitions and the edges agree — same ids, same
  // destination — while capture is on (Phase 4a: the edges move freely while
  // it is off; the baseline of the next `history enable` reconciles them).
  if (reader && captureOn) {
    const openOnlyInTransitions = db.prepare("SELECT t.edge_id FROM edge_transitions t WHERE t.repo_id = ? AND t.to_commit IS NULL AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.edge_id = t.edge_id) ORDER BY 1").all(repoId) as { edge_id: string }[];
    for (const r of openOnlyInTransitions) problems.push(`H6: open transition ${r.edge_id} has no edges row`);
    const edgesWithoutTransition = db.prepare("SELECT e.edge_id FROM edges e WHERE e.repo_id = ? AND NOT EXISTS (SELECT 1 FROM edge_transitions t WHERE t.edge_id = e.edge_id AND t.to_commit IS NULL) ORDER BY 1").all(repoId) as { edge_id: string }[];
    for (const r of edgesWithoutTransition) problems.push(`H6: edge ${r.edge_id} has no open transition`);
    const dstDisagree = db.prepare("SELECT e.edge_id FROM edges e JOIN edge_transitions t ON t.edge_id = e.edge_id WHERE e.repo_id = ? AND t.to_commit IS NULL AND t.dst_node != e.dst_node ORDER BY 1").all(repoId) as { edge_id: string }[];
    for (const r of dstDisagree) problems.push(`H6: edge ${r.edge_id} and its open transition disagree on dst_node`);
  }

  // ---- I7 dispositions ----------------------------------------------------------------
  // Every disposition names an existing commit. For each commit that is the
  // CURRENT commit of at least one live doc — the one state the rows can still
  // vouch for — take the live docs whose current revision it wrote (one on the
  // observe path; N for an api changeset, spec/store §5.4 "The api path"): a
  // disposition on a block that survives the commit (every kind but `deleted` /
  // `merged_into`) names a live row of one of those docs, and a `deleted` /
  // `merged_into` one names no live row of any of them.
  const dispositions = db
    .prepare("SELECT x.commit_id, x.block_id, x.kind FROM dispositions x JOIN commits c ON c.commit_id = x.commit_id WHERE c.repo_id = ?")
    .all(repoId) as { commit_id: string; block_id: string; kind: string }[];
  for (const x of dispositions) if (!commitById.has(x.commit_id)) problems.push(`I7: disposition ${x.block_id}/${x.kind} names a missing commit ${x.commit_id}`);
  const currentDocsOf = new Map<string, Set<string>>();
  for (const d of docs) {
    if (d.deleted_at !== null || d.head === null) continue;
    const rev = revById.get(d.head);
    if (!rev) continue;
    let set = currentDocsOf.get(rev.commit_id);
    if (!set) currentDocsOf.set(rev.commit_id, (set = new Set()));
    set.add(d.doc_id);
  }
  for (const [commitId, docIds] of currentDocsOf) {
    const label = [...docIds].sort().join(",");
    for (const x of dispositions) {
      if (x.commit_id !== commitId || x.block_id === "DOC") continue;
      const row = liveRowOf.get(x.block_id) as { doc_id: string } | undefined;
      const liveHere = row !== undefined && docIds.has(row.doc_id);
      const gone = x.kind === "deleted" || x.kind === "merged_into";
      if (gone && liveHere) problems.push(`I7: ${x.kind} block ${x.block_id} of ${x.commit_id} is still live in ${row.doc_id}`);
      if (!gone && !liveHere) problems.push(`I7: ${x.kind} block ${x.block_id} of ${x.commit_id} is not live in ${label}`);
    }
  }
  // 14.2: `same` is never persisted (§5.4 step 10; the §7 sweep removes a 14.1
  // store's), and a block's rows are its own history — so every live block has
  // at least one (its `inserted`, lineage or resurrection row) UNLESS the
  // commit that wrote it is wholly archived (17.0: the squash empties a wholly
  // archived commit's rows; the recorder's hold on the id's claim is what
  // remains of them, H6).
  for (const x of dispositions) if (x.kind === "same") problems.push(`I7: disposition ${x.block_id} of ${x.commit_id} is a persisted \`same\``);
  const unchanged = db
    .prepare(
      `SELECT b.block_id, b.created_at FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE d.repo_id = ? AND b.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM block_changes bc WHERE bc.block_id = b.block_id)
         AND NOT EXISTS (SELECT 1 FROM id_claims ic WHERE ic.id = b.block_id AND (ic.holders & 2) != 0) ORDER BY b.block_id`,
    )
    .all(repoId) as { block_id: string; created_at: string }[];
  // Phase 4a: a block born while capture was off has neither until a baseline holds it.
  for (const r of unchanged) if (inCoverage(r.created_at)) problems.push(`I7: live block ${r.block_id} has no block_changes row and no recorder hold on its claim`);

  // ---- I8 rebuild equivalence -------------------------------------------------------
  for (const d of docs) {
    if (d.deleted_at !== null) continue;
    const tops = db
      .prepare("SELECT block_id, ordinal, type, json_extract(attrs, '$.level') AS level FROM blocks WHERE doc_id = ? AND parent_block IS NULL AND deleted_at IS NULL ORDER BY ordinal")
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
  // 17.0: `block_changes` is exactly the projection of `dispositions` over
  // every commit — a wholly archived commit has neither (the squash deletes
  // both; 15.0–16.x kept each block's earliest row for the mint oracle, which
  // the claims table replaced).
  const bcHave = (db.prepare("SELECT block_id, commit_id, kind FROM block_changes ORDER BY block_id, commit_id, kind").all() as Row[]);
  const bcWant = (db.prepare("SELECT DISTINCT block_id, commit_id, kind FROM dispositions ORDER BY block_id, commit_id, kind").all() as Row[]);
  const bcDiff = deepEqualTol(bcHave, bcWant, 0);
  if (bcDiff) problems.push(`I8: block_changes differ from a rebuild out of dispositions (${bcDiff})`);
  const archivedDisp = (db.prepare(`SELECT count(*) AS c FROM dispositions WHERE commit_id IN (${ARCHIVED_COMMITS_SQL})`).get() as { c: number }).c;
  if (archivedDisp > 0) problems.push(`I9: ${archivedDisp} disposition rows of wholly archived commits remain`);
  const archivedBc = (db.prepare(`SELECT count(*) AS c FROM block_changes WHERE commit_id IN (${ARCHIVED_COMMITS_SQL})`).get() as { c: number }).c;
  if (archivedBc > 0) problems.push(`I9: ${archivedBc} block_changes rows of wholly archived commits remain`);

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

/** A spec-specific step validator: `body` is the step's single value, `here` its path (for messages). */
export type ExtraStepValidator = (body: unknown, here: string, problems: string[]) => void;

/** README §9.4 (15.0): the retention step kinds. */
export const HISTORY_STEP_KINDS = ["history_plan", "history_export", "history_attach", "history_detach", "read_at"] as const;

function validateHistoryStep(kind: string, body: unknown, here: string, problems: string[]): void {
  if (!isRecord(body)) {
    problems.push(`${here}: not an object`);
    return;
  }
  const allowed: Record<string, string[]> = {
    history_plan: ["ts", "policy", "before"],
    history_export: ["ts", "policy", "before", "prune"],
    history_attach: ["segment"],
    history_detach: ["segment"],
    read_at: ["doc", "rev"],
  };
  const extra = Object.keys(body).filter((k) => !allowed[kind]!.includes(k));
  if (extra.length > 0) problems.push(`${here}: ${kind} takes ${allowed[kind]!.map((k) => `\`${k}\``).join(", ")} (got ${extra.join(", ")})`);
  if (kind === "history_plan" || kind === "history_export") {
    if (typeof body.ts !== "string" || !TS_RE.test(body.ts)) problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (§2.4)`);
    if (body.policy !== undefined && !isRecord(body.policy)) problems.push(`${here}: \`policy\` must be an object (a partial over the defaults)`);
    if (body.before !== undefined && (typeof body.before !== "string" || !TS_RE.test(body.before))) problems.push(`${here}: \`before\` must be RFC 3339 UTC with three fractional digits and Z (§2.4)`);
    if (kind === "history_export" && typeof body.prune !== "boolean") problems.push(`${here}: \`prune\` must be a boolean`);
  } else if (kind === "read_at") {
    if (typeof body.doc !== "string" || typeof body.rev !== "string") problems.push(`${here}: read_at takes \`doc\` and \`rev\` ids`);
  } else if (typeof body.segment !== "string" || body.segment === "") problems.push(`${here}: \`segment\` must be a segment id`);
}

/**
 * Validate a §9.4 `steps` list, appending problems; returns the step count (or
 * -1 when the list itself is malformed). Exported because every observation-
 * script spec (graph, search, …) reuses this input shape verbatim; a spec that
 * adds step kinds of its own (search: `drain`, `search`) passes them in `extra`,
 * keyed by the step's single key.
 */
export function validateSteps(at: string, steps: unknown, problems: string[], extra: Record<string, ExtraStepValidator> = {}): number {
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push(`${at}: \`steps\` must be a non-empty array`);
    return -1;
  }
  const kinds = ["observe", "sweep", "gc", "exec", "remint_epoch", "history_enable", "history_disable", "history_purge", "recorder_fault", ...HISTORY_STEP_KINDS, ...Object.keys(extra)];
  steps.forEach((s, i) => {
    const here = `${at}.steps[${i}]`;
    if (!isRecord(s)) {
      problems.push(`${here}: not an object`);
      return;
    }
    const keys = Object.keys(s);
    if (keys.length !== 1 || !kinds.includes(keys[0]!)) {
      problems.push(`${here}: a step is exactly one of ${kinds.map((k) => `\`${k}\``).join(" / ")} (got ${keys.join(", ")})`);
      return;
    }
    const body = s[keys[0]!];
    const validator = extra[keys[0]!];
    if (validator) {
      validator(body, here, problems);
      return;
    }
    if (keys[0] === "gc") {
      if (!isRecord(body) || Object.keys(body).some((k) => k !== "ts")) problems.push(`${here}: gc takes only an optional \`ts\``);
      else if (body.ts !== undefined && (typeof body.ts !== "string" || !TS_RE.test(body.ts))) problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (§2.4)`);
      return;
    }
    if ((HISTORY_STEP_KINDS as readonly string[]).includes(keys[0]!)) {
      validateHistoryStep(keys[0]!, body, here, problems);
      return;
    }
    if (keys[0] === "history_enable") {
      if (!isRecord(body) || Object.keys(body).some((k) => k !== "ts" && k !== "writer_requires")) problems.push(`${here}: history_enable takes \`ts\` and an optional \`writer_requires\``);
      else {
        if (typeof body.ts !== "string" || !TS_RE.test(body.ts)) problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (§2.4)`);
        if (body.writer_requires !== undefined && typeof body.writer_requires !== "boolean") problems.push(`${here}: \`writer_requires\` must be a boolean`);
      }
      return;
    }
    if (keys[0] === "history_disable") {
      if (!isRecord(body) || Object.keys(body).some((k) => k !== "ts")) problems.push(`${here}: history_disable takes only \`ts\``);
      else if (typeof body.ts !== "string" || !TS_RE.test(body.ts)) problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (§2.4)`);
      return;
    }
    if (keys[0] === "history_purge") {
      if (!isRecord(body) || Object.keys(body).some((k) => k !== "ts" && k !== "before")) problems.push(`${here}: history_purge takes \`ts\` and an optional \`before\``);
      else {
        if (typeof body.ts !== "string" || !TS_RE.test(body.ts)) problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (§2.4)`);
        if (body.before !== undefined && (typeof body.before !== "string" || !TS_RE.test(body.before))) problems.push(`${here}: \`before\` must be RFC 3339 UTC with three fractional digits and Z (§2.4)`);
      }
      return;
    }
    if (keys[0] === "recorder_fault") {
      if (!isRecord(body) || Object.keys(body).some((k) => k !== "fail") || typeof body.fail !== "boolean") problems.push(`${here}: recorder_fault takes only a boolean \`fail\``);
      return;
    }
    if (keys[0] === "exec") {
      if (!isRecord(body) || Object.keys(body).some((k) => k !== "sql")) problems.push(`${here}: exec takes only \`sql\``);
      if (!isRecord(body) || !Array.isArray(body.sql) || body.sql.length === 0 || body.sql.some((q) => typeof q !== "string" || q === "")) {
        problems.push(`${here}: \`sql\` must be a non-empty array of statements`);
      }
      return;
    }
    if (!isRecord(body) || typeof body.ts !== "string" || !TS_RE.test(body.ts)) {
      problems.push(`${here}: \`ts\` must be RFC 3339 UTC with three fractional digits and Z (§2.4)`);
    }
    if (keys[0] === "sweep" || keys[0] === "remint_epoch") {
      if (isRecord(body) && Object.keys(body).some((k) => k !== "ts")) problems.push(`${here}: ${keys[0]} takes only \`ts\``);
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

function validateEdgeTransitions(at: string, e: unknown, problems: string[]): void {
  if (!isRecord(e) || Object.keys(e).length !== 1 || !Array.isArray(e.edge_transitions)) {
    problems.push(`${at}: must be exactly { edge_transitions: [...] }`);
    return;
  }
  e.edge_transitions.forEach((r, i) => {
    const here = `${at}.edge_transitions[${i}]`;
    if (!isRecord(r)) {
      problems.push(`${here}: not an object`);
      return;
    }
    const keys = Object.keys(r).sort();
    const want = [...EDGE_TRANSITION_FIELDS].sort();
    if (keys.length !== want.length || keys.some((k, j) => k !== want[j])) {
      problems.push(`${here}: a row has exactly the fields ${EDGE_TRANSITION_FIELDS.join(", ")} (got ${keys.join(", ")})`);
      return;
    }
    for (const k of ["edge_id", "src_doc", "predicate", "dst_kind", "dst_node", "provenance", "from_commit"]) if (typeof r[k] !== "string") problems.push(`${here}: ${k} must be a string`);
    for (const k of ["src_block", "src_field", "anchor", "via_node", "to_commit"]) if (r[k] !== null && typeof r[k] !== "string") problems.push(`${here}: ${k} must be a string or null`);
  });
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
  // The stem is the file's base name: a recorder suite lives under `cases/history/` (§9.5).
  const stem = file.replace(/\.json$/, "").replace(/^.*\//, "");
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
    } else if (kind === "observe" || kind === "edges") {
      if (c.config !== undefined) validateConfig(at, c.config, problems);
      if (kind === "observe" && c.minter !== undefined && !(MINTER_KINDS as readonly unknown[]).includes(c.minter)) {
        problems.push(`${at}: \`minter\` must be one of ${MINTER_KINDS.map((k) => JSON.stringify(k)).join(", ")} (got ${JSON.stringify(c.minter)})`);
      }
      if (kind === "observe" && c.capabilities !== undefined && (!isRecord(c.capabilities) || Object.keys(c.capabilities).some((k) => k !== "history") || typeof c.capabilities.history !== "boolean")) {
        problems.push(`${at}: \`capabilities\` is exactly { history: boolean } (README §9.4, Phase 4a)`);
      }
      stepCount = validateSteps(at, c.steps, problems);
    }

    // A regeneration pass (`requireExpect: false`) rewrites `expect` from the
    // inputs, so a stale one — a projection key the spec gained — is not a problem.
    if (c.expect === undefined || !requireExpect) {
      if (requireExpect) problems.push(`${at}: missing \`expect\` (run STORE_SPEC_UPDATE=1)`);
      return;
    }
    if (kind === "schema") validateFingerprint(`${at}.expect`, c.expect, problems);
    else if (kind === "migration") validateMigrationExpect(`${at}.expect`, c.expect, Array.isArray(c.rows) ? (c.rows as string[]) : [], problems);
    else if (kind === "edges") validateEdgeTransitions(`${at}.expect`, c.expect, problems);
    else validateProjection(`${at}.expect`, c.expect, stepCount, problems);
  });
  return problems;
}
