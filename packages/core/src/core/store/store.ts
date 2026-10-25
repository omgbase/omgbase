import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DDL, SCHEMA_VERSION, MIGRATIONS, SYNC_DDL, ARCHIVES_DDL } from "./schema.js";
import { mintId, registerIdOracle } from "../ids.js";
import type { Capabilities, CapabilitiesFactory } from "../capabilities/types.js";
import { bindCapabilities } from "../capabilities/registry.js";
import { envCapabilities } from "../capabilities/default.js";

// SQLite store (02 §2). One database per workspace at
// <workspace>/.omgbase/omgbase.db, WAL mode, synchronous=NORMAL, FK on. All
// writes funnel through a single serialized writer connection (short txns);
// reads use the same connection in v1 (single-process engine).

export interface StoreOptions {
  /** ':memory:' for tests, or a filesystem path (parent dirs created). */
  path: string;
  /**
   * The capabilities this store runs with (modular-core Phase 1,
   * `core/capabilities/`): the history recorder, the semantic provider and
   * the identity claims. The composition layer (`Workspace`, the CLI, a
   * library embedding) names a factory; absent, `envCapabilities()` — the
   * full set unless `OMGBASE_CAPABILITIES=core` selects the core-only one — so
   * a bare store (fixtures, tests) behaves exactly as one opened through the
   * composition layer, and one environment variable runs every fixture suite
   * with the semantic module absent (the Phase 2 gate).
   */
  capabilities?: CapabilitiesFactory;
}

export class Store {
  readonly db: Database.Database;
  /** The capabilities bound to this store's connection (`capabilitiesOf(store.db)` is the same object). */
  readonly capabilities: Capabilities;
  // The in-use oracle this store registered with `mintId` (spec/store §2.1):
  // the claims capability's `isClaimed`; `close()` calls it to unregister.
  private readonly unregisterOracle: () => void;

  constructor(opts: StoreOptions) {
    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new Database(opts.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    // The capabilities (modular-core Phase 1): bound to the connection so a
    // core path holding only `db` reaches them (`capabilitiesOf`). The
    // `cosine` SQL function is the semantic provider's to register (Phase 2):
    // a core-only store has none. Bound BEFORE the migration since 17.0: step
    // 17's backfill resolves every live head's frontmatter through the recorder
    // (`frontmatterAtRevision`), never through the delta module directly.
    this.capabilities = (opts.capabilities ?? envCapabilities())(this);
    bindCapabilities(this.db, this.capabilities);
    this.migrate();
    // Registered after the migration so every table the oracle reads exists.
    // (A migration's own mints — v13's `src_` per repo — are checked only
    // against the process's issued set; they land in tables that were empty.)
    // spec/store §2.1: does `id` name a row of the prefix's table(s)? — the
    // claims capability answers (`TableUnionClaims`, the same union).
    this.unregisterOracle = registerIdOracle((prefix, id) => this.capabilities.claims.isClaimed(prefix, id));
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current === 0) {
      this.db.exec(DDL);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      return;
    }
    if (current === SCHEMA_VERSION) return;
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `database schema (v${current}) is newer than this build (v${SCHEMA_VERSION}); upgrade omgbase`,
      );
    }
    // Apply forward additive migrations in order (each idempotent DDL).
    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
      if (v === 3) { this.migrateV3(); continue; }
      if (v === 4) { this.migrateV4(); continue; }
      if (v === 6) { this.migrateV6(); continue; }
      if (v === 7) { this.migrateV7(); continue; }
      if (v === 9) { this.migrateV9(); continue; }
      if (v === 11) { this.migrateV11(); continue; }
      if (v === 13) { this.migrateV13(); continue; }
      if (v === 15) { this.migrateV15(); continue; }
      if (v === 17) { this.migrateV17(); continue; }
      // v16 (spec/store §3.4 step 16, §4.1 "Delta nodes"): no DDL and no data
      // pass. A 15.x store holds only full (`[`-form) nodes and raw frontmatter
      // blobs, which ARE the 16.0 checkpoint forms, so every existing revision
      // is a checkpoint; deltas appear with the next commit. The major exists
      // because a 15.x engine cannot read a `{`-form node (§1 step 3 keeps it out).
      if (v === 16) continue;
      const ddl = MIGRATIONS[v];
      if (!ddl) throw new Error(`no migration to schema v${v}`);
      this.db.exec(ddl);
    }
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  private migrateV3(): void {
    const cols = this.db.pragma("table_info(documents)") as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === "format")) {
      this.db.exec("ALTER TABLE documents ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'");
    }
  }

  private migrateV4(): void {
    const cols = this.db.pragma("table_info(documents)") as { name: string }[];
    if (cols.length > 0 && cols.some((c) => c.name === "frontmatter") && !cols.some((c) => c.name === "metadata")) {
      this.db.exec("ALTER TABLE documents RENAME COLUMN frontmatter TO metadata");
    }
  }

  private migrateV6(): void {
    const docCols = this.db.pragma("table_info(documents)") as { name: string }[];
    if (docCols.length > 0 && !docCols.some((c) => c.name === "leading_trivia")) {
      this.db.exec("ALTER TABLE documents ADD COLUMN leading_trivia TEXT NOT NULL DEFAULT ''");
    }
    const blockCols = this.db.pragma("table_info(blocks)") as { name: string }[];
    if (blockCols.length > 0 && !blockCols.some((c) => c.name === "trivia_hash")) {
      this.db.exec("ALTER TABLE blocks ADD COLUMN trivia_hash BLOB");
    }
  }

  private migrateV7(): void {
    const docCols = this.db.pragma("table_info(documents)") as { name: string }[];
    if (docCols.length > 0 && !docCols.some((c) => c.name === "frontmatter_trivia")) {
      this.db.exec("ALTER TABLE documents ADD COLUMN frontmatter_trivia TEXT");
    }
  }

  // v9 (sync-plugins): add the adapters/sources/attachments/sync_state tables.
  // repos.root_path is relaxed to nullable in the base DDL for fresh dbs; an
  // existing NOT NULL column still accepts all prior (non-null) rows, so no table
  // rebuild is needed to migrate — new nullable inserts only happen on fresh dbs.
  private migrateV9(): void {
    this.db.exec(SYNC_DDL);
  }

  // v11: rename the `documents` table to `docs`. SQLite (>= 3.25, legacy_alter_table
  // off by default) rewrites the FK references in blocks/revisions automatically,
  // so no child-table rebuild is needed. Idempotent: skip if `docs` already exists
  // (fresh dbs get `docs` straight from the DDL and never run this).
  private migrateV11(): void {
    const tableExists = (name: string): boolean =>
      !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    // Fresh dbs already have `docs` from the DDL; a `documents` table only exists
    // on real pre-v11 dbs. Rename only when the old table is present and the new
    // one is not — otherwise there's nothing to do.
    if (tableExists("docs") || !tableExists("documents")) return;
    this.db.exec("ALTER TABLE documents RENAME TO docs");
  }

  // v13 (ADR-014): a repo owns identity, not a filesystem. Drop repos.root_path,
  // migrating each repo's former root_path into an `fs` source + attachment (the
  // durable "where its bytes come from"). Idempotent: skip if the column is gone
  // (fresh dbs get the columnless repos table straight from the DDL). Runs in one
  // transaction; DROP COLUMN needs modern SQLite (>= 3.35, bundled by
  // better-sqlite3), and root_path is a plain unindexed column so it drops cleanly.
  private migrateV13(): void {
    const cols = this.db.pragma("table_info(repos)") as { name: string }[];
    if (cols.length === 0 || !cols.some((c) => c.name === "root_path")) return;

    this.db.transaction(() => {
      // The fs adapter row backs the migrated sources (sources.adapter FK).
      this.db.exec("INSERT OR IGNORE INTO adapters (name, command, args) VALUES ('fs', 'omgbase-fs-adapter', '[]')");

      const repos = this.db
        .prepare("SELECT repo_id, slug, root_path FROM repos WHERE root_path IS NOT NULL AND root_path != ''")
        .all() as { repo_id: string; slug: string; root_path: string }[];
      const findByName = this.db.prepare("SELECT source_id FROM sources WHERE name = ?");
      const insSource = this.db.prepare("INSERT INTO sources (source_id, name, adapter, config, env) VALUES (?, ?, 'fs', ?, '{}')");
      const insAttach = this.db.prepare("INSERT OR IGNORE INTO attachments (repo_id, source_id) VALUES (?, ?)");
      for (const r of repos) {
        const name = `${r.slug}-fs`;
        const existing = findByName.get(name) as { source_id: string } | undefined;
        let sourceId = existing?.source_id;
        if (!sourceId) {
          sourceId = mintId("src");
          insSource.run(sourceId, name, JSON.stringify({ root: r.root_path }));
        }
        insAttach.run(r.repo_id, sourceId);
      }

      this.db.exec("ALTER TABLE repos DROP COLUMN root_path");
    })();
  }

  // v15 (spec/store §3.4 step 15, §7 "Retention"): `revisions.root_tree` and
  // `frontmatter_blob` become nullable and lose their foreign keys (an archived
  // revision keeps its row and loses its bodies), `revisions` gains `archive`,
  // and `archives` is created. SQLite cannot relax a NOT NULL or drop a FK in
  // place, so the table is rebuilt the documented way (sqlite.org/lang_altertable,
  // "making other kinds of table schema changes"): foreign keys off for the
  // duration — `pending_materializations.rev_id` references `revisions`, and the
  // DROP would otherwise be an implicit DELETE under the FK — create the new
  // table, copy every row with `archive = NULL`, drop the old, rename, check.
  // Idempotent: a `revisions` table that already carries `archive` is left alone
  // (a fresh database never reaches here); `archives` is `CREATE … IF NOT EXISTS`.
  private migrateV15(): void {
    const cols = this.db.pragma("table_info(revisions)") as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === "archive")) {
      // PRAGMA foreign_keys is a no-op inside a transaction, so it brackets one.
      this.db.pragma("foreign_keys = OFF");
      try {
        this.db.transaction(() => {
          this.db.exec(`
CREATE TABLE revisions_v15 (
  rev_id           TEXT PRIMARY KEY,
  doc_id           TEXT NOT NULL REFERENCES docs(doc_id),
  seq              INTEGER NOT NULL,
  root_tree        BLOB,
  frontmatter_blob BLOB,
  rendered_hash    BLOB NOT NULL,
  path             TEXT NOT NULL,
  commit_id        TEXT NOT NULL REFERENCES commits(commit_id),
  archive          TEXT,
  UNIQUE (doc_id, seq)
);
INSERT INTO revisions_v15 (rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id, archive)
  SELECT rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id, NULL FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_v15 RENAME TO revisions;
`);
          const violations = this.db.pragma("foreign_key_check") as unknown[];
          if (violations.length > 0) throw new Error(`migration v15: ${violations.length} foreign key violation(s) after rebuilding revisions`);
        })();
      } finally {
        this.db.pragma("foreign_keys = ON");
      }
    }
    this.db.exec(ARCHIVES_DDL);
  }

  // v17 (spec/store §3.4 step 17; modular-core Phase 3a — M1, M2, D10, D6):
  // the head and its bytes live on the current rows. `docs` gains `head`
  // (`current_rev` renamed), `frontmatter_raw`, `created_at`, `updated_at`,
  // `deleted_at` (`deleted_commit` gone); `blocks` gains `raw`, `trivia`,
  // `created_at`, `updated_at`, `deleted_at` (`created_commit`/`deleted_commit`
  // gone); `resurrection_pool` gains `created_at`. SQLite cannot rename a
  // column a partial index names or add a NOT NULL column without a default,
  // so the three tables are rebuilt the documented way (as v15 did), with
  // `foreign_keys = OFF` for the duration and `PRAGMA foreign_key_check`
  // empty at the end. The backfill reads the 16.x history tables ONCE: the
  // frontmatter raw by resolving every live head through the 16.x
  // `TreeResolver` (a delta chain, §6.1 "Resolving"), the block bytes from
  // `blobs` by hash (a hash with no blob aborts the migration — I5 made it
  // impossible), the timestamps from the `revisions`/`commits` and
  // `block_changes`/`commits` joins that the 16.x readers computed on every
  // read, `deleted_at` from the tombstone commit's `ts`. `blocks` keeps its
  // `rowid`s — `blocks_fts` is an external-content index keyed by them.
  // Idempotent: a `docs` table that already carries `head` is left alone.
  private migrateV17(): void {
    const docCols = this.db.pragma("table_info(docs)") as { name: string }[];
    if (docCols.length === 0 || docCols.some((c) => c.name === "head")) return;
    const clock = new Date().toISOString();
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        const db = this.db;
        const tsOfCommit = db.prepare("SELECT ts FROM commits WHERE commit_id = ?");
        const commitTs = (id: string | null): string | null => (id === null ? null : ((tsOfCommit.get(id) as { ts: string } | undefined)?.ts ?? null));

        // ---- docs ----
        db.exec(`
CREATE TABLE docs_v17 (
  doc_id             TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repos(repo_id),
  path               TEXT NOT NULL,
  format             TEXT NOT NULL DEFAULT 'markdown',
  head               TEXT,
  file_hash          BLOB,
  conflicted         INTEGER NOT NULL DEFAULT 0,
  leading_trivia     TEXT NOT NULL DEFAULT '',
  frontmatter_raw    TEXT,
  frontmatter_trivia TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  UNIQUE (repo_id, path)
);`);
        const history = this.capabilities.history;
        if (!history) throw new Error("migration v17: the history recorder is needed to resolve the 16.x frontmatter deltas");
        const revOf = db.prepare("SELECT doc_id, seq, frontmatter_blob, commit_id FROM revisions WHERE rev_id = ?");
        const firstRev = db.prepare("SELECT commit_id FROM revisions WHERE doc_id = ? AND seq = 1");
        const insDoc = db.prepare(
          `INSERT INTO docs_v17 (rowid, doc_id, repo_id, path, format, head, file_hash, conflicted, leading_trivia, frontmatter_raw, frontmatter_trivia, created_at, updated_at, deleted_at)
           VALUES (@rowid, @doc_id, @repo_id, @path, @format, @head, @file_hash, @conflicted, @leading_trivia, @frontmatter_raw, @frontmatter_trivia, @created_at, @updated_at, @deleted_at)`,
        );
        const docs = db.prepare("SELECT rowid, doc_id, repo_id, path, format, current_rev, file_hash, conflicted, leading_trivia, frontmatter_trivia, deleted_commit FROM docs ORDER BY rowid").all() as {
          rowid: number; doc_id: string; repo_id: string; path: string; format: string; current_rev: string | null; file_hash: Buffer | null; conflicted: number;
          leading_trivia: string; frontmatter_trivia: string | null; deleted_commit: string | null;
        }[];
        for (const d of docs) {
          const rev = d.current_rev === null ? undefined : (revOf.get(d.current_rev) as { doc_id: string; seq: number; frontmatter_blob: Buffer | null; commit_id: string } | undefined);
          const frontmatterRaw = rev?.frontmatter_blob ? history.frontmatterAtRevision(d.current_rev!) : null;
          const first = firstRev.get(d.doc_id) as { commit_id: string } | undefined;
          const createdAt = commitTs(first?.commit_id ?? null) ?? clock;
          const updatedAt = commitTs(rev?.commit_id ?? null) ?? createdAt;
          insDoc.run({
            rowid: d.rowid, doc_id: d.doc_id, repo_id: d.repo_id, path: d.path, format: d.format, head: d.current_rev, file_hash: d.file_hash, conflicted: d.conflicted,
            leading_trivia: d.leading_trivia, frontmatter_raw: frontmatterRaw, frontmatter_trivia: d.frontmatter_trivia,
            created_at: createdAt, updated_at: updatedAt, deleted_at: commitTs(d.deleted_commit),
          });
        }
        db.exec("DROP TABLE docs; ALTER TABLE docs_v17 RENAME TO docs;");

        // ---- blocks ----
        db.exec(`
CREATE TABLE blocks_v17 (
  block_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repos(repo_id),
  doc_id         TEXT NOT NULL REFERENCES docs(doc_id),
  parent_block   TEXT,
  order_key      TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  depth          INTEGER NOT NULL,
  ancestor_path  TEXT NOT NULL,
  type           TEXT NOT NULL,
  attrs          TEXT NOT NULL DEFAULT '{}',
  text           TEXT NOT NULL,
  raw            TEXT NOT NULL,
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  trivia         TEXT,
  trivia_hash    BLOB,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);`);
        const blobOf = db.prepare("SELECT bytes FROM blobs WHERE hash = ?");
        const bytesOf = (hash: Buffer | null, what: string): string | null => {
          if (hash === null) return null;
          const b = blobOf.get(hash) as { bytes: Buffer } | undefined;
          if (!b) throw new Error(`migration v17: ${what} ${hash.toString("hex")} has no blobs row`);
          return b.bytes.toString("utf8");
        };
        const span = db.prepare("SELECT MIN(c.ts) AS lo, MAX(c.ts) AS hi FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?");
        const insBlock = db.prepare(
          `INSERT INTO blocks_v17 (rowid, block_id, repo_id, doc_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, text, raw, raw_hash, norm_hash, trivia, trivia_hash, created_at, updated_at, deleted_at)
           VALUES (@rowid, @block_id, @repo_id, @doc_id, @parent_block, @order_key, @ordinal, @depth, @ancestor_path, @type, @attrs, @text, @raw, @raw_hash, @norm_hash, @trivia, @trivia_hash, @created_at, @updated_at, @deleted_at)`,
        );
        const blocks = db.prepare("SELECT rowid, block_id, repo_id, doc_id, parent_block, order_key, ordinal, depth, ancestor_path, type, attrs, text, raw_hash, norm_hash, trivia_hash, created_commit, deleted_commit FROM blocks ORDER BY rowid").all() as {
          rowid: number; block_id: string; repo_id: string; doc_id: string; parent_block: string | null; order_key: string; ordinal: number; depth: number; ancestor_path: string;
          type: string; attrs: string; text: string; raw_hash: Buffer; norm_hash: Buffer; trivia_hash: Buffer | null; created_commit: string; deleted_commit: string | null;
        }[];
        for (const b of blocks) {
          const s = span.get(b.block_id) as { lo: string | null; hi: string | null };
          const fallback = commitTs(b.created_commit) ?? clock;
          insBlock.run({
            rowid: b.rowid, block_id: b.block_id, repo_id: b.repo_id, doc_id: b.doc_id, parent_block: b.parent_block, order_key: b.order_key, ordinal: b.ordinal, depth: b.depth,
            ancestor_path: b.ancestor_path, type: b.type, attrs: b.attrs, text: b.text,
            raw: bytesOf(b.raw_hash, `block ${b.block_id} raw_hash`), raw_hash: b.raw_hash, norm_hash: b.norm_hash,
            trivia: bytesOf(b.trivia_hash, `block ${b.block_id} trivia_hash`), trivia_hash: b.trivia_hash,
            created_at: s.lo ?? fallback, updated_at: s.hi ?? fallback, deleted_at: commitTs(b.deleted_commit),
          });
        }
        db.exec(`
DROP TABLE blocks;
ALTER TABLE blocks_v17 RENAME TO blocks;
CREATE INDEX IF NOT EXISTS idx_blocks_doc      ON blocks(doc_id, parent_block, order_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_type     ON blocks(repo_id, type)                   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_blocks_rawhash  ON blocks(raw_hash);
CREATE INDEX IF NOT EXISTS idx_blocks_ancestor ON blocks(doc_id, ancestor_path);`);

        // ---- resurrection_pool ----
        db.exec(`
CREATE TABLE resurrection_pool_v17 (
  block_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  type           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  deleted_commit TEXT NOT NULL,
  expires_ts     TEXT NOT NULL
);`);
        const insPool = db.prepare(
          `INSERT INTO resurrection_pool_v17 (rowid, block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, deleted_commit, expires_ts)
           VALUES (@rowid, @block_id, @repo_id, @doc_id, @raw_hash, @norm_hash, @type, @created_at, @deleted_commit, @expires_ts)`,
        );
        const pool = db.prepare("SELECT rowid, block_id, repo_id, doc_id, raw_hash, norm_hash, type, deleted_commit, expires_ts FROM resurrection_pool ORDER BY rowid").all() as {
          rowid: number; block_id: string; repo_id: string; doc_id: string; raw_hash: Buffer; norm_hash: Buffer; type: string; deleted_commit: string; expires_ts: string;
        }[];
        for (const p of pool) {
          const s = span.get(p.block_id) as { lo: string | null };
          insPool.run({ ...p, created_at: s.lo ?? commitTs(p.deleted_commit) ?? clock });
        }
        db.exec("DROP TABLE resurrection_pool; ALTER TABLE resurrection_pool_v17 RENAME TO resurrection_pool;");

        const violations = this.db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) throw new Error(`migration v17: ${violations.length} foreign key violation(s) after rebuilding docs, blocks and resurrection_pool`);
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  /**
   * Run fn inside a single write transaction (02 §2: one transaction per
   * commit). better-sqlite3 transactions are synchronous and serialized.
   */
  write<T>(fn: (db: Database.Database) => T): T {
    return this.db.transaction(fn)(this.db);
  }

  /**
   * Run fn inside a `BEGIN IMMEDIATE` transaction: the write lock is taken at
   * BEGIN, so every read fn makes is already protected from another writer and
   * a concurrent `BEGIN IMMEDIATE` waits (SQLITE_BUSY after the busy timeout).
   * The commit phase of a request uses it (spec/mutate §4 step 5(c), 2.2) so
   * the preconditions it re-validates cannot move before it writes. Nested
   * inside an open transaction it is a savepoint, like `write`.
   */
  writeImmediate<T>(fn: (db: Database.Database) => T): T {
    return this.db.transaction(fn).immediate(this.db);
  }

  pragma(name: string): unknown {
    return this.db.pragma(name, { simple: true });
  }

  close(): void {
    this.unregisterOracle();
    this.db.close();
  }
}
