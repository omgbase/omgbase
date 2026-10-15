import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Store } from "./store.js";
import { SCHEMA_VERSION } from "./schema.js";
import { mintId } from "../ids.js";
import { sweepUnreachable } from "./gc.js";
import {
  evaluateRetention, parseSettingsJson, ReachMarker, LAST_SEGMENT_SETTINGS_KEY, RETENTION_SETTINGS_KEY,
  type EvaluateOptions, type RetentionPlan, type RetentionPolicy,
} from "./retention.js";

// Archive segments (spec/store §7 "Retention: plan, export, squash", 15.0).
//
// A segment is ONE SQLite file per `history export`, never appended: the bodies
// (blobs, tree nodes) of the revisions the policy archived, self-contained,
// plus copies of their `revisions`/`commits` rows, the `dispositions` and
// `block_changes` of the commits that are wholly archived, and one `manifest`
// row (`ARCHIVE_DDL` = spec/store/archive.sql, embedded verbatim). The main
// store then SQUASHES in one transaction: an archived revision keeps its row
// (id, doc, seq, path, rendered hash, commit — so the `revisions` target,
// `docs_history` and `changes_since` keep listing it) and loses `root_tree` and
// `frontmatter_blob`, gaining `archive` = the segment id; the wholly archived
// commits' dispositions go, their block_changes go except each block's EARLIEST
// row (the mint oracle of spec/store §2.1 reads `block_changes`, so a minted id
// stays known); the GC sweep reclaims the bodies now reachable from nothing;
// the segment is recorded in `archives`. Two phases on purpose: the file is
// complete and durable before a single row of the store moves, and a crash
// between the phases leaves a complete, unrecorded segment that the next run
// finds and finishes (the crash rule).
//
// Reading an archived revision ATTACHes its segment on demand (one alias per
// segment, `arc_<id>`, read-only by construction — the file is written with
// mode 0444 and the engine never writes through an alias) so `docs_read { at }`,
// `docs_diff` and the fixture runner's `read_at` reconstruct through it. A
// segment that is not recorded or not on disk is `RevisionArchived`.

/** spec/store/archive.sql, verbatim — the segment's DDL. */
export const ARCHIVE_DDL = /* sql */ `-- ---- an archive segment (spec/store §7 "Retention", 15.0) --------------------
-- One file per \`history export\`, never appended: the bodies of the revisions
-- the retention policy squashed, self-contained (every blob and tree node
-- reachable from them), plus copies of their revision, commit, disposition and
-- block-change rows, and one manifest row. The same DDL subset as schema.sql
-- minus the foreign keys (a segment holds no repos or docs rows).
CREATE TABLE IF NOT EXISTS manifest (
  segment_id          TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  policy              TEXT NOT NULL,
  seq_lo              INTEGER NOT NULL,
  seq_hi              INTEGER NOT NULL,
  revision_count      INTEGER NOT NULL,
  previous_segment    TEXT,
  schema_user_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
  rev_id           TEXT PRIMARY KEY,
  doc_id           TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  root_tree        BLOB NOT NULL,
  frontmatter_blob BLOB,
  rendered_hash    BLOB NOT NULL,
  path             TEXT NOT NULL,
  commit_id        TEXT NOT NULL,
  UNIQUE (doc_id, seq)
);

CREATE TABLE IF NOT EXISTS commits (
  commit_id     TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  ts            TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
  actor         TEXT,
  reason        TEXT,
  checkpoint_id TEXT,
  ops           TEXT
);

CREATE TABLE IF NOT EXISTS blobs (
  hash  BLOB PRIMARY KEY,
  bytes BLOB NOT NULL,
  size  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tree_nodes (
  hash    BLOB PRIMARY KEY,
  entries TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispositions (
  commit_id  TEXT NOT NULL,
  block_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN
             ('same','edited','moved','edited_moved','inserted','deleted',
              'split_from','merged_into','copied_from','resurrected','bulk_rewrite')),
  confidence REAL,
  reason     TEXT,
  matcher_v  TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (commit_id, block_id, kind)
);

CREATE TABLE IF NOT EXISTS block_changes (
  block_id  TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  kind      TEXT NOT NULL,
  PRIMARY KEY (block_id, commit_id, kind)
);
`;

/** The file suffix every segment carries. */
export const ARCHIVE_SUFFIX = ".omgarchive.db";
/** The default directory under `.omgbase/`. */
export const ARCHIVE_DIR = "archives";
/** The suffix of a segment still being written (never a complete segment). */
const PARTIAL_SUFFIX = ".partial";
/** How many segments stay attached to one connection (SQLite's default cap is 10). */
const MAX_ATTACHED = 8;

/** `<repo_id>-<seq_lo>-<seq_hi>-<segment_id>.omgarchive.db` */
export function segmentFileName(repoId: string, seqLo: number, seqHi: number, segmentId: string): string {
  return `${repoId}-${seqLo}-${seqHi}-${segmentId}${ARCHIVE_SUFFIX}`;
}

const FILE_RE = /^([a-z]+_[0-9a-z]+)-(\d+)-(\d+)-([a-z]+_[0-9a-z]+)\.omgarchive\.db$/;

/** The parts a segment file name carries, or null when the name is not one. */
export function parseSegmentFileName(name: string): { repoId: string; seqLo: number; seqHi: number; segmentId: string } | null {
  const m = FILE_RE.exec(name);
  return m ? { repoId: m[1]!, seqLo: Number(m[2]), seqHi: Number(m[3]), segmentId: m[4]! } : null;
}

export interface Manifest {
  segment_id: string;
  repo_id: string;
  created_at: string;
  policy: RetentionPolicy;
  seq_lo: number;
  seq_hi: number;
  revision_count: number;
  previous_segment: string | null;
  schema_user_version: number;
}

/** A read of an archived revision whose segment is not recorded, or recorded but not on disk (spec/surface: `revision_archived`). */
export class RevisionArchived extends Error {
  constructor(public readonly rev: string, public readonly archive: string, public readonly path: string | null) {
    super(path === null
      ? `revision ${JSON.stringify(rev)} is archived in segment ${archive}, which is not attached (omg history attach <file>)`
      : `revision ${JSON.stringify(rev)} is archived in segment ${archive} at ${path}, which is not on disk`);
    this.name = "RevisionArchived";
  }
}

/** Not an archive segment, or one of another repository. */
export class NotASegment extends Error {
  constructor(public readonly path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "NotASegment";
  }
}

/** Open a segment read-only and return its manifest; `NotASegment` when the file is not one. */
export function readManifest(path: string): Manifest {
  if (!existsSync(path)) throw new NotASegment(path, "no such file");
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT segment_id, repo_id, created_at, policy, seq_lo, seq_hi, revision_count, previous_segment, schema_user_version FROM manifest").get() as
      | (Omit<Manifest, "policy"> & { policy: string })
      | undefined;
    if (!row) throw new NotASegment(path, "no manifest row");
    return { ...row, policy: JSON.parse(row.policy) as RetentionPolicy };
  } catch (e) {
    if (e instanceof NotASegment) throw e;
    throw new NotASegment(path, "not an archive segment");
  } finally {
    db?.close();
  }
}

/** The revision ids a segment holds, in `(doc_id, seq)` order. */
function segmentRevisionIds(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT rev_id FROM revisions ORDER BY doc_id, seq").all() as { rev_id: string }[]).map((r) => r.rev_id);
  } finally {
    db.close();
  }
}

// ---- the registry ------------------------------------------------------------------

export interface ArchiveRow {
  segment_id: string;
  repo_id: string;
  path: string;
  seq_lo: number;
  seq_hi: number;
  created_at: string;
  revision_count: number;
  bytes: number;
}

function archiveRow(store: Store, segmentId: string): ArchiveRow | undefined {
  return store.db.prepare("SELECT segment_id, repo_id, path, seq_lo, seq_hi, created_at, revision_count, bytes FROM archives WHERE segment_id = ?").get(segmentId) as ArchiveRow | undefined;
}

function recordArchive(store: Store, row: ArchiveRow): void {
  store.db
    .prepare("INSERT OR REPLACE INTO archives (segment_id, repo_id, path, seq_lo, seq_hi, created_at, revision_count, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(row.segment_id, row.repo_id, row.path, row.seq_lo, row.seq_hi, row.created_at, row.revision_count, row.bytes);
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export interface AttachedSegment {
  segment_id: string;
  path: string;
  seq_lo: number;
  seq_hi: number;
  revision_count: number;
  bytes: number;
}

export interface AttachResult {
  attached: AttachedSegment[];
  /** Files in a directory that are not this repository's segments. */
  skipped: number;
}

/**
 * `omg history attach <file|dir>`: record a segment (idempotent — a known
 * segment's path is re-recorded) or every `.omgarchive.db` of a directory
 * whose manifest `repo_id` is this repository's. A single file of another
 * repository or a non-segment is `NotASegment`; in a directory they are skipped.
 */
export function attachArchive(store: Store, repoId: string, target: string): AttachResult {
  const path = resolve(target);
  const attached: AttachedSegment[] = [];
  let skipped = 0;
  const one = (file: string, strict: boolean): void => {
    let manifest: Manifest;
    try {
      manifest = readManifest(file);
    } catch (e) {
      if (strict) throw e;
      skipped++;
      return;
    }
    if (manifest.repo_id !== repoId) {
      if (strict) throw new NotASegment(file, `a segment of repository ${manifest.repo_id}, not ${repoId}`);
      skipped++;
      return;
    }
    const row: ArchiveRow = {
      segment_id: manifest.segment_id, repo_id: repoId, path: file, seq_lo: manifest.seq_lo, seq_hi: manifest.seq_hi,
      created_at: manifest.created_at, revision_count: manifest.revision_count, bytes: fileBytes(file),
    };
    // A re-attached segment may have moved: drop a stale alias so the next read re-attaches.
    detachAlias(store, manifest.segment_id);
    recordArchive(store, row);
    attached.push({ segment_id: row.segment_id, path: row.path, seq_lo: row.seq_lo, seq_hi: row.seq_hi, revision_count: row.revision_count, bytes: row.bytes });
  };
  if (existsSync(path) && statSync(path).isDirectory()) {
    for (const name of readdirSync(path).filter((n) => n.endsWith(ARCHIVE_SUFFIX)).sort()) one(join(path, name), false);
  } else one(path, true);
  return { attached, skipped };
}

/**
 * `omg history detach <segment_id|path>`: forget a segment. The revisions it
 * holds keep their `archive` pointer; reading one is `revision_archived` until
 * the segment is attached again. Returns the id, or null when nothing matched.
 */
export function detachArchive(store: Store, repoId: string, ref: string): string | null {
  const byId = store.db.prepare("SELECT segment_id FROM archives WHERE repo_id = ? AND segment_id = ?").get(repoId, ref) as { segment_id: string } | undefined;
  const byPath = byId ? undefined : (store.db.prepare("SELECT segment_id FROM archives WHERE repo_id = ? AND path = ?").get(repoId, resolve(ref)) as { segment_id: string } | undefined);
  const id = byId?.segment_id ?? byPath?.segment_id;
  if (!id) return null;
  detachAlias(store, id);
  store.db.prepare("DELETE FROM archives WHERE segment_id = ?").run(id);
  return id;
}

/**
 * A segment's state (spec/store §7 "Retention"): recorded and on disk
 * (`attached`), recorded but not on disk (`missing`); or unrecorded under the
 * archives directory — `pending` (complete, its revisions still live: the
 * crash rule finishes it on the next `export --prune`), `detached` (complete
 * and squashed: `attach` brings it back), `stale` (some of its revisions live,
 * some not: it belongs to another store or predates a different squash).
 */
export type ArchiveState = "attached" | "missing" | "pending" | "detached" | "stale";

export interface ArchiveListing extends AttachedSegment {
  created_at: string;
  state: ArchiveState;
}

/**
 * `omg history list`: the repository's recorded segments by `seq_lo` then id,
 * followed by the unrecorded complete segments found in `dest`, by file name.
 */
export function listArchives(store: Store, repoId: string, opts: { dest?: string } = {}): ArchiveListing[] {
  const rows = store.db
    .prepare("SELECT segment_id, repo_id, path, seq_lo, seq_hi, created_at, revision_count, bytes FROM archives WHERE repo_id = ? ORDER BY seq_lo, segment_id")
    .all(repoId) as ArchiveRow[];
  const out: ArchiveListing[] = rows.map((r) => ({
    segment_id: r.segment_id, path: r.path, seq_lo: r.seq_lo, seq_hi: r.seq_hi, revision_count: r.revision_count,
    bytes: r.bytes, created_at: r.created_at, state: existsSync(r.path) ? "attached" : "missing",
  }));
  if (opts.dest) {
    for (const u of unrecordedSegments(store, repoId, opts.dest)) {
      const m = readManifest(u.path);
      out.push({ segment_id: m.segment_id, path: u.path, seq_lo: m.seq_lo, seq_hi: m.seq_hi, revision_count: m.revision_count, bytes: fileBytes(u.path), created_at: m.created_at, state: u.state });
    }
  }
  return out;
}

export interface UnrecordedSegment {
  path: string;
  state: "pending" | "detached" | "stale";
}

/**
 * The complete segments of this repository under `dest` that no `archives`
 * row records, by file name, each classified by its revisions: all live →
 * `pending` (the crash rule's input), all archived → `detached`, else `stale`.
 */
export function unrecordedSegments(store: Store, repoId: string, dest: string): UnrecordedSegment[] {
  if (!existsSync(dest)) return [];
  const known = new Set((store.db.prepare("SELECT segment_id FROM archives").all() as { segment_id: string }[]).map((r) => r.segment_id));
  const live = store.db.prepare("SELECT archive FROM revisions WHERE rev_id = ?");
  return readdirSync(dest)
    .map((name) => ({ name, parts: parseSegmentFileName(name) }))
    .filter((f) => f.parts !== null && f.parts.repoId === repoId && !known.has(f.parts.segmentId))
    .map((f) => f.name)
    .sort()
    .map((name) => {
      const path = join(dest, name);
      let liveCount = 0;
      let archivedCount = 0;
      for (const id of segmentRevisionIds(path)) {
        const r = live.get(id) as { archive: string | null } | undefined;
        if (r && r.archive === null) liveCount++;
        else archivedCount++;
      }
      const state = archivedCount === 0 ? "pending" : liveCount === 0 ? "detached" : "stale";
      return { path, state };
    });
}

// ---- reading through a segment -----------------------------------------------------------

const attachedAliases = new WeakMap<Database.Database, Map<string, string>>();

function aliasesOf(store: Store): Map<string, string> {
  let m = attachedAliases.get(store.db);
  if (!m) attachedAliases.set(store.db, (m = new Map()));
  return m;
}

export function archiveAlias(segmentId: string): string {
  return `arc_${segmentId.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function detachAlias(store: Store, segmentId: string): void {
  const m = aliasesOf(store);
  const alias = m.get(segmentId);
  if (!alias) return;
  try {
    store.db.exec(`DETACH DATABASE ${alias}`);
  } catch {
    // already gone with the connection
  }
  m.delete(segmentId);
}

/**
 * The table prefix a revision's bodies are read under: `""` for a live
 * revision, `"<alias>."` for an archived one whose segment is attached on
 * demand (and verified to be the segment it claims). `RevisionArchived` when
 * the segment is not recorded or not on disk.
 */
export function archivePrefix(store: Store, rev: { rev_id: string; archive: string | null }): string {
  if (rev.archive === null) return "";
  const m = aliasesOf(store);
  const have = m.get(rev.archive);
  if (have) return `${have}.`;
  const row = archiveRow(store, rev.archive);
  if (!row) throw new RevisionArchived(rev.rev_id, rev.archive, null);
  if (!existsSync(row.path)) throw new RevisionArchived(rev.rev_id, rev.archive, row.path);
  if (m.size >= MAX_ATTACHED) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) detachAlias(store, oldest);
  }
  const alias = archiveAlias(rev.archive);
  store.db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(row.path);
  const claims = store.db.prepare(`SELECT segment_id FROM ${alias}.manifest`).get() as { segment_id: string } | undefined;
  if (claims?.segment_id !== rev.archive) {
    store.db.exec(`DETACH DATABASE ${alias}`);
    throw new RevisionArchived(rev.rev_id, rev.archive, row.path);
  }
  m.set(rev.archive, alias);
  return `${alias}.`;
}

export interface RevisionBody {
  rev_id: string;
  doc_id: string;
  path: string;
  rendered_hash: Buffer;
  root_tree: Buffer;
  frontmatter_blob: Buffer | null;
  /** `""` or `"<alias>."` — where `tree_nodes` and `blobs` for this revision live. */
  prefix: string;
  archived: boolean;
}

/**
 * A revision's row with its bodies resolved: a live revision's from the store,
 * an archived one's from its segment (attached on demand). `undefined` when
 * `revId` is not a revision (of `docId`, when given); `RevisionArchived` when
 * its segment is unavailable.
 */
export function revisionBody(store: Store, revId: string, docId?: string): RevisionBody | undefined {
  const row = store.db
    .prepare(`SELECT rev_id, doc_id, path, rendered_hash, root_tree, frontmatter_blob, archive FROM revisions WHERE rev_id = ?${docId === undefined ? "" : " AND doc_id = ?"}`)
    .get(...(docId === undefined ? [revId] : [revId, docId])) as
    | { rev_id: string; doc_id: string; path: string; rendered_hash: Buffer; root_tree: Buffer | null; frontmatter_blob: Buffer | null; archive: string | null }
    | undefined;
  if (!row) return undefined;
  if (row.archive === null) {
    return { rev_id: row.rev_id, doc_id: row.doc_id, path: row.path, rendered_hash: row.rendered_hash, root_tree: row.root_tree!, frontmatter_blob: row.frontmatter_blob, prefix: "", archived: false };
  }
  const prefix = archivePrefix(store, row);
  const body = store.db.prepare(`SELECT root_tree, frontmatter_blob FROM ${prefix}revisions WHERE rev_id = ?`).get(revId) as { root_tree: Buffer; frontmatter_blob: Buffer | null } | undefined;
  if (!body) throw new RevisionArchived(revId, row.archive, archiveRow(store, row.archive)?.path ?? null);
  return { rev_id: row.rev_id, doc_id: row.doc_id, path: row.path, rendered_hash: row.rendered_hash, root_tree: body.root_tree, frontmatter_blob: body.frontmatter_blob, prefix, archived: true };
}

// ---- export: write a segment, then squash -------------------------------------------------

export interface SegmentInfo {
  id: string;
  path: string;
  seq_lo: number;
  seq_hi: number;
  created_at: string;
  revision_count: number;
  /** The file's size on disk. */
  bytes: number;
  previous_segment: string | null;
}

export interface SquashResult {
  revisions: number;
  /** Commits every revision of which is archived: their dispositions and block changes moved. */
  commits: number;
  dispositions: number;
  block_changes: number;
}

export interface ExportResult {
  plan: RetentionPlan;
  /** null when nothing was to archive (no file written). */
  segment: SegmentInfo | null;
  /** An unrecorded complete segment was finished instead of writing a new one (the crash rule). */
  reused: boolean;
  /** null without `prune`. */
  squashed: SquashResult | null;
  /** null without `prune`. */
  gc: { blobs: number; tree_nodes: number } | null;
}

export interface ExportOptions extends EvaluateOptions {
  /** The directory the segment is written to (created when missing). */
  dest: string;
  /** Squash the store after the segment is durable. */
  prune: boolean;
}

/** An unrecorded segment under `dest` names both live and non-live revisions (it predates another squash, or belongs elsewhere). */
export class StaleSegment extends Error {
  constructor(public readonly path: string, public readonly rev: string) {
    super(`${path}: an unrecorded segment naming revision ${rev}, which is not a live revision of this store — move the file out of the way`);
    this.name = "StaleSegment";
  }
}

interface RevisionRow {
  rev_id: string;
  doc_id: string;
  seq: number;
  root_tree: Buffer;
  frontmatter_blob: Buffer | null;
  rendered_hash: Buffer;
  path: string;
  commit_id: string;
}

/** The commits of `revIds` every revision of which is in `revIds` or already archived — whose change rows move with the bodies. */
function whollyArchivedCommits(store: Store, revIds: ReadonlySet<string>): string[] {
  const commits = new Set<string>();
  const commitOf = store.db.prepare("SELECT commit_id FROM revisions WHERE rev_id = ?");
  for (const id of revIds) {
    const r = commitOf.get(id) as { commit_id: string } | undefined;
    if (r) commits.add(r.commit_id);
  }
  const revsOf = store.db.prepare("SELECT rev_id, archive FROM revisions WHERE commit_id = ?");
  const out: string[] = [];
  for (const c of [...commits].sort()) {
    const revs = revsOf.all(c) as { rev_id: string; archive: string | null }[];
    if (revs.every((r) => r.archive !== null || revIds.has(r.rev_id))) out.push(c);
  }
  return out;
}

// The repo's OWN settings blob (`repos.settings`, the repo layer of
// `spec/sync`'s two-layer settings) — read and written directly: `core/` does
// not import `sync/settings.ts`, and the chain pointer belongs to the
// repository, not the workspace (a workspace holds several).
function repoSettings(store: Store, repoId: string): Record<string, unknown> {
  return parseSettingsJson((store.db.prepare("SELECT settings FROM repos WHERE repo_id = ?").get(repoId) as { settings: string } | undefined)?.settings);
}

function lastSegment(store: Store, repoId: string): string | null {
  const s = repoSettings(store, repoId)[RETENTION_SETTINGS_KEY];
  const v = s && typeof s === "object" ? (s as Record<string, unknown>)[LAST_SEGMENT_SETTINGS_KEY] : undefined;
  return typeof v === "string" ? v : null;
}

function setLastSegment(store: Store, repoId: string, segmentId: string): void {
  const settings = repoSettings(store, repoId);
  const history = settings[RETENTION_SETTINGS_KEY];
  const h: Record<string, unknown> = history && typeof history === "object" && !Array.isArray(history) ? { ...(history as Record<string, unknown>) } : {};
  h[LAST_SEGMENT_SETTINGS_KEY] = segmentId;
  settings[RETENTION_SETTINGS_KEY] = h;
  store.db.prepare("UPDATE repos SET settings = ? WHERE repo_id = ?").run(JSON.stringify(settings), repoId);
}

/**
 * Phase 1: write the segment for `revIds` to `dest`, durably — into a
 * `.partial` file, fsynced (`synchronous = FULL`) and closed, made read-only,
 * then renamed to its final name, so a complete segment is exactly a file with
 * the final name. Returns the segment's info.
 */
function writeSegment(store: Store, repoId: string, revIds: readonly string[], plan: RetentionPlan, dest: string): SegmentInfo {
  const db = store.db;
  const revRow = db.prepare("SELECT rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id FROM revisions WHERE rev_id = ?");
  const revisions = revIds.map((id) => revRow.get(id) as RevisionRow);
  const commitIds = [...new Set(revisions.map((r) => r.commit_id))];
  const commitRow = db.prepare("SELECT commit_id, repo_id, seq, ts, origin, actor, reason, checkpoint_id, ops FROM commits WHERE commit_id = ?");
  const commits = commitIds.map((c) => commitRow.get(c) as Record<string, unknown> & { seq: number }).sort((a, b) => a.seq - b.seq);
  const seqLo = commits[0]!.seq;
  const seqHi = commits[commits.length - 1]!.seq;
  const segmentId = mintId("s");
  const createdAt = plan.now;
  const previous = lastSegment(store, repoId);

  const marker = new ReachMarker(store);
  const trees = new Set<string>();
  const blobs = new Set<string>();
  marker.mark(revisions, trees, blobs);

  const wholly = whollyArchivedCommits(store, new Set(revIds));
  const dispRows = db.prepare("SELECT commit_id, block_id, kind, confidence, reason, matcher_v, detail FROM dispositions WHERE commit_id = ? ORDER BY block_id, kind");
  const bcRows = db.prepare("SELECT block_id, commit_id, kind FROM block_changes WHERE commit_id = ? ORDER BY block_id, kind");
  const treeRow = db.prepare("SELECT hash, entries FROM tree_nodes WHERE hash = ?");
  const blobRow = db.prepare("SELECT hash, bytes, size FROM blobs WHERE hash = ?");

  mkdirSync(dest, { recursive: true });
  for (const stale of readdirSync(dest)) if (stale.endsWith(ARCHIVE_SUFFIX + PARTIAL_SUFFIX)) unlinkSync(join(dest, stale));
  const name = segmentFileName(repoId, seqLo, seqHi, segmentId);
  const finalPath = join(dest, name);
  const partialPath = finalPath + PARTIAL_SUFFIX;

  const seg = new Database(partialPath);
  try {
    seg.pragma("journal_mode = DELETE");
    seg.pragma("synchronous = FULL");
    seg.exec(ARCHIVE_DDL);
    seg.transaction(() => {
      seg.prepare("INSERT INTO manifest (segment_id, repo_id, created_at, policy, seq_lo, seq_hi, revision_count, previous_segment, schema_user_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(segmentId, repoId, createdAt, JSON.stringify(plan.policy), seqLo, seqHi, revisions.length, previous, SCHEMA_VERSION);
      const insRev = seg.prepare("INSERT INTO revisions (rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const r of revisions) insRev.run(r.rev_id, r.doc_id, r.seq, r.root_tree, r.frontmatter_blob, r.rendered_hash, r.path, r.commit_id);
      const insCommit = seg.prepare("INSERT INTO commits (commit_id, repo_id, seq, ts, origin, actor, reason, checkpoint_id, ops) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const c of commits) insCommit.run(c.commit_id, c.repo_id, c.seq, c.ts, c.origin, c.actor, c.reason, c.checkpoint_id, c.ops);
      const insTree = seg.prepare("INSERT INTO tree_nodes (hash, entries) VALUES (?, ?)");
      for (const t of [...trees].sort()) {
        const row = treeRow.get(Buffer.from(t, "hex")) as { hash: Buffer; entries: string } | undefined;
        if (row) insTree.run(row.hash, row.entries);
      }
      const insBlob = seg.prepare("INSERT INTO blobs (hash, bytes, size) VALUES (?, ?, ?)");
      for (const b of [...blobs].sort()) {
        const row = blobRow.get(Buffer.from(b, "hex")) as { hash: Buffer; bytes: Buffer; size: number } | undefined;
        if (row) insBlob.run(row.hash, row.bytes, row.size);
      }
      const insDisp = seg.prepare("INSERT INTO dispositions (commit_id, block_id, kind, confidence, reason, matcher_v, detail) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const insBc = seg.prepare("INSERT INTO block_changes (block_id, commit_id, kind) VALUES (?, ?, ?)");
      for (const c of wholly) {
        for (const d of dispRows.all(c) as Record<string, unknown>[]) insDisp.run(d.commit_id, d.block_id, d.kind, d.confidence, d.reason, d.matcher_v, d.detail);
        for (const b of bcRows.all(c) as Record<string, unknown>[]) insBc.run(b.block_id, b.commit_id, b.kind);
      }
    })();
  } finally {
    seg.close();
  }
  try {
    chmodSync(partialPath, 0o444);
  } catch {
    // a filesystem without modes: the engine still never writes through an alias
  }
  renameSync(partialPath, finalPath);
  return { id: segmentId, path: finalPath, seq_lo: seqLo, seq_hi: seqHi, created_at: createdAt, revision_count: revisions.length, bytes: fileBytes(finalPath), previous_segment: previous };
}

/**
 * Phase 2: squash the store for a complete segment, in one transaction — the
 * archived revisions lose their bodies and gain `archive`; the wholly archived
 * commits lose their dispositions and every block_changes row but each block's
 * earliest; the GC sweep reclaims what is reachable from nothing; the segment
 * is recorded in `archives` and as the repo's `history.last_segment`.
 */
function squash(store: Store, repoId: string, segment: SegmentInfo, revIds: readonly string[]): { squashed: SquashResult; gc: { blobs: number; tree_nodes: number } } {
  return store.write((db) => {
    const wholly = whollyArchivedCommits(store, new Set(revIds));
    const upd = db.prepare("UPDATE revisions SET root_tree = NULL, frontmatter_blob = NULL, archive = ? WHERE rev_id = ?");
    for (const id of revIds) upd.run(segment.id, id);
    let dispositions = 0;
    let blockChanges = 0;
    const delDisp = db.prepare("DELETE FROM dispositions WHERE commit_id = ?");
    // The rows that stay: a block's earliest block_changes row (by commit seq) —
    // the mint oracle (spec/store §2.1) reads this table, so an id ever minted
    // stays in use after its row, its pool entry and its history are gone.
    const delBc = db.prepare(
      `DELETE FROM block_changes WHERE commit_id = ? AND EXISTS (
         SELECT 1 FROM block_changes b2 JOIN commits c2 ON c2.commit_id = b2.commit_id JOIN commits c ON c.commit_id = block_changes.commit_id
         WHERE b2.block_id = block_changes.block_id AND c2.seq < c.seq)`,
    );
    for (const c of wholly) {
      dispositions += delDisp.run(c).changes;
      blockChanges += delBc.run(c).changes;
    }
    const swept = sweepUnreachable(store);
    recordArchive(store, {
      segment_id: segment.id, repo_id: repoId, path: segment.path, seq_lo: segment.seq_lo, seq_hi: segment.seq_hi,
      created_at: segment.created_at, revision_count: segment.revision_count, bytes: segment.bytes,
    });
    setLastSegment(store, repoId, segment.id);
    return {
      squashed: { revisions: revIds.length, commits: wholly.length, dispositions, block_changes: blockChanges },
      gc: { blobs: swept.blobsSwept, tree_nodes: swept.treeNodesSwept },
    };
  });
}

/**
 * `omg history export [--prune]`: evaluate the policy, write ONE new segment
 * for the revisions to archive (or finish an unrecorded one — the crash
 * rule), and with `prune` squash the store. Nothing to archive → no file,
 * `segment: null`.
 */
export function exportHistory(store: Store, repoId: string, opts: ExportOptions): ExportResult {
  const plan = evaluateRetention(store, repoId, opts);
  const dest = resolve(opts.dest);

  // The crash rule: a complete segment nobody recorded, whose revisions are
  // still live, is finished first; a detached one is left alone (`attach`
  // brings it back); a stale one is refused rather than guessed about.
  const unrecorded = unrecordedSegments(store, repoId, dest);
  const stale = unrecorded.find((u) => u.state === "stale");
  if (stale) {
    const live = store.db.prepare("SELECT archive FROM revisions WHERE rev_id = ?");
    const offending = segmentRevisionIds(stale.path).find((id) => (live.get(id) as { archive: string | null } | undefined)?.archive !== null) ?? "?";
    throw new StaleSegment(stale.path, offending);
  }
  const pending = unrecorded.find((u) => u.state === "pending");
  if (pending) {
    const file = pending.path;
    const manifest = readManifest(file);
    const revIds = segmentRevisionIds(file);
    const segment: SegmentInfo = {
      id: manifest.segment_id, path: file, seq_lo: manifest.seq_lo, seq_hi: manifest.seq_hi, created_at: manifest.created_at,
      revision_count: manifest.revision_count, bytes: fileBytes(file), previous_segment: manifest.previous_segment,
    };
    if (!opts.prune) return { plan, segment, reused: true, squashed: null, gc: null };
    const done = squash(store, repoId, segment, revIds);
    return { plan, segment, reused: true, ...done };
  }

  const revIds = plan.docs.flatMap((d) => d.archive);
  if (revIds.length === 0) return { plan, segment: null, reused: false, squashed: null, gc: null };
  const segment = writeSegment(store, repoId, revIds, plan, dest);
  if (!opts.prune) return { plan, segment, reused: false, squashed: null, gc: null };
  const done = squash(store, repoId, segment, revIds);
  return { plan, segment, reused: false, ...done };
}

/** The archived-history figures the size report carries (spec/store §7 "Size", 15.0). */
export function archivedSummary(store: Store): { revisions: number; segments: number; bytes: number } {
  const revisions = (store.db.prepare("SELECT count(*) AS c FROM revisions WHERE archive IS NOT NULL").get() as { c: number }).c;
  const rows = store.db.prepare("SELECT path FROM archives").all() as { path: string }[];
  let bytes = 0;
  for (const r of rows) bytes += fileBytes(r.path);
  return { revisions, segments: rows.length, bytes };
}

/** The file name of a segment path, for messages and fixtures. */
export function segmentBasename(path: string): string {
  return basename(path);
}
