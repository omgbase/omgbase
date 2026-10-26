import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DDL, SCHEMA_VERSION, MIGRATIONS, SYNC_DDL, ARCHIVES_DDL } from "./schema.js";
import { mintId, registerIdOracle } from "../ids.js";
import { FEED_DDL } from "./schema.js";
import { pruneFeed } from "./feed.js";
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
    if (current === SCHEMA_VERSION) {
      // 17.0 is unreleased and grew in slices (modular-core Phase 3a → 3b →
      // 3c → 3d): a database a 3a build already moved to 17 has `docs` but no
      // `id_claims` and the pool's `deleted_commit`; a 3a/3b build's still has
      // `pending_materializations.rev_id`; a 3a–3c build's has no `feed`, a
      // `checkpoints` table and `commits.checkpoint_id`. Each part of the step
      // is idempotent, so finish it here rather than spend a schema version on
      // a dev-only state. (A 17 database with no `docs` table — the
      // `already-current-is-untouched` fixture — is left exactly as it is.)
      if (this.tableExists("docs")) {
        this.migrateV17Claims();
        this.migrateV17Pending();
        this.migrateV17Feed();
      }
      return;
    }
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
      if (v === 17) { this.migrateV17(); this.migrateV17Claims(); this.migrateV17Pending(); this.migrateV17Feed(); continue; }
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

  private tableExists(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
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
  // gone); `resurrection_pool` gains `created_at` and (3b) `deleted_at` in
  // place of `deleted_commit`. SQLite cannot rename a
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
  // Idempotent: a `docs` table that already carries `head` is left alone. The
  // identity half of the step — the pool's `deleted_at` and the `id_claims`
  // backfill (3b) — is `migrateV17Claims`, idempotent on its own so a 3a
  // database at 17 can finish the step on open.
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
        this.rebuildPoolV17();

        const violations = this.db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) throw new Error(`migration v17: ${violations.length} foreign key violation(s) after rebuilding docs, blocks and resurrection_pool`);
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  // The pool rebuild of step 17 (spec/store §3.4 step 17 (3); runs inside
  // `migrateV17`'s transaction, or alone for a 3a database): `created_at` =
  // MIN(commits.ts) over the block's `block_changes`, else `deleted_at`;
  // `deleted_at` = the `ts` of `deleted_commit`'s commit, else `expires_ts −
  // 30 days` (I6 made the two equal, so the fallback is exact); `deleted_commit`
  // dropped; `rowid`s kept. Idempotent: a pool that already has `deleted_at`
  // is left alone.
  private rebuildPoolV17(): void {
    const db = this.db;
    const cols = db.pragma("table_info(resurrection_pool)") as { name: string }[];
    if (cols.length === 0 || cols.some((c) => c.name === "deleted_at")) return;
    const hadCreatedAt = cols.some((c) => c.name === "created_at");
    const tsOfCommit = db.prepare("SELECT ts FROM commits WHERE commit_id = ?");
    const span = db.prepare("SELECT MIN(c.ts) AS lo FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?");
    db.exec(`
CREATE TABLE resurrection_pool_v17 (
  block_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  doc_id         TEXT NOT NULL,
  raw_hash       BLOB NOT NULL,
  norm_hash      BLOB NOT NULL,
  type           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  deleted_at     TEXT NOT NULL,
  expires_ts     TEXT NOT NULL
);`);
    const insPool = db.prepare(
      `INSERT INTO resurrection_pool_v17 (rowid, block_id, repo_id, doc_id, raw_hash, norm_hash, type, created_at, deleted_at, expires_ts)
       VALUES (@rowid, @block_id, @repo_id, @doc_id, @raw_hash, @norm_hash, @type, @created_at, @deleted_at, @expires_ts)`,
    );
    const pool = db.prepare(`SELECT rowid, block_id, repo_id, doc_id, raw_hash, norm_hash, type, ${hadCreatedAt ? "created_at" : "NULL AS created_at"}, deleted_commit, expires_ts FROM resurrection_pool ORDER BY rowid`).all() as {
      rowid: number; block_id: string; repo_id: string; doc_id: string; raw_hash: Buffer; norm_hash: Buffer; type: string; created_at: string | null; deleted_commit: string; expires_ts: string;
    }[];
    for (const p of pool) {
      const deletedAt = (tsOfCommit.get(p.deleted_commit) as { ts: string } | undefined)?.ts ?? new Date(Date.parse(p.expires_ts) - 30 * 24 * 3600 * 1000).toISOString();
      const s = span.get(p.block_id) as { lo: string | null };
      insPool.run({
        rowid: p.rowid, block_id: p.block_id, repo_id: p.repo_id, doc_id: p.doc_id, raw_hash: p.raw_hash, norm_hash: p.norm_hash, type: p.type,
        created_at: p.created_at ?? s.lo ?? deletedAt, deleted_at: deletedAt, expires_ts: p.expires_ts,
      });
    }
    db.exec("DROP TABLE resurrection_pool; ALTER TABLE resurrection_pool_v17 RENAME TO resurrection_pool;");
  }

  // The recovery half of step 17 (spec/store §3.4 step 17 (5); modular-core
  // Phase 3c — M4): `pending_materializations` rebuilt self-contained — `head`
  // = the row's `rev_id` (the same `r_` token: the head IS the revision id the
  // core mints), `prior_hash` = the `rendered_hash` of the revision before it
  // (`seq − 1` of the same document, resolved ONCE from the 16.x history; NULL
  // for a first revision, a `remove` row or an unknown revision), `created_at`
  // = the recording commit's `ts` (the migration's clock when the commit is
  // gone); the two foreign keys (`revisions`, `commits`) dropped; `rowid`s
  // kept (a materializer replays in insertion order). Runs inside
  // `migrateV17`'s transaction with foreign keys off, or alone for a 3a/3b
  // database at 17 (a short transaction of its own; the table it rebuilds has
  // no incoming foreign key). Idempotent: a table that already carries `head`
  // is left alone.
  private migrateV17Pending(): void {
    const db = this.db;
    const cols = db.pragma("table_info(pending_materializations)") as { name: string }[];
    if (cols.length === 0 || cols.some((c) => c.name === "head")) return;
    const clock = new Date().toISOString();
    const hasRevisions = this.tableExists("revisions");
    const hasCommits = this.tableExists("commits");
    db.transaction(() => {
      db.exec(`
CREATE TABLE pending_materializations_v17 (
  repo_id       TEXT NOT NULL REFERENCES repos(repo_id),
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('write','rename','remove')),
  from_path     TEXT,
  doc_id        TEXT NOT NULL REFERENCES docs(doc_id),
  head          TEXT,
  rendered_hash BLOB NOT NULL,
  prior_hash    BLOB,
  commit_id     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)
);`);
      const prior = hasRevisions
        ? "(SELECT q.rendered_hash FROM revisions r JOIN revisions q ON q.doc_id = r.doc_id AND q.seq = r.seq - 1 WHERE r.rev_id = p.rev_id)"
        : "NULL";
      const createdAt = hasCommits ? "COALESCE((SELECT c.ts FROM commits c WHERE c.commit_id = p.commit_id), @clock)" : "@clock";
      db.prepare(
        `INSERT INTO pending_materializations_v17 (rowid, repo_id, path, kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id, created_at)
         SELECT p.rowid, p.repo_id, p.path, p.kind, p.from_path, p.doc_id, p.rev_id, p.rendered_hash,
                CASE WHEN p.kind = 'remove' THEN NULL ELSE ${prior} END, p.commit_id, ${createdAt}
           FROM pending_materializations p ORDER BY p.rowid`,
      ).run({ clock });
      db.exec("DROP TABLE pending_materializations; ALTER TABLE pending_materializations_v17 RENAME TO pending_materializations;");
    })();
  }

  // The identity half of step 17 (spec/store §3.4 step 17 (4)–(5); modular-core
  // Phase 3b — M3/D5): the pool's `deleted_at` (above) and the `id_claims`
  // table (§2.1) created and BACKFILLED with one row per id the current rows
  // and the history still name — `d` from `docs` (`minted_at = created_at`),
  // `b` from `blocks`, `resurrection_pool` (their `created_at`) and every
  // `block_changes`/`dispositions` row (MIN of its commits' `ts`), `r` from
  // `docs.head` (`updated_at`) and `revisions` (the commit's `ts`), `x` from
  // `external_nodes` (the earliest edge's commit), `e` from `edges` (its
  // `from_commit`), `rp` from `repos` (the repo's first commit), `src` from
  // `sources` (the clock; workspace-scoped, `repo_id` NULL). `holders` = bit 0
  // when a core row names the id, plus bit 1 when a history row does — so a
  // long-deleted block's `b` is `2`, a live block's `3`, an old revision's `r`
  // `2`, a repo's `rp` `1`. The recorder's `c` and `s` get no claim (their own
  // rows are their claims), nor does `cp`. Idempotent: an existing `id_claims`
  // table is left alone.
  private migrateV17Claims(): void {
    const db = this.db;
    const clock = new Date().toISOString();
    const hasClaims = this.tableExists("id_claims");
    const poolCols = db.pragma("table_info(resurrection_pool)") as { name: string }[];
    const poolDone = poolCols.length === 0 || poolCols.some((c) => c.name === "deleted_at");
    if (hasClaims && poolDone) return;
    db.transaction(() => {
      if (!poolDone) this.rebuildPoolV17();
      if (hasClaims) return;
      db.exec(`
CREATE TABLE IF NOT EXISTS id_claims (
  id        TEXT PRIMARY KEY,
  repo_id   TEXT,
  prefix    TEXT NOT NULL,
  minted_at TEXT NOT NULL,
  holders   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_repo_prefix ON id_claims(repo_id, prefix, minted_at);`);
      // Every statement upserts: a second source of the same id ORs its holder
      // bits in and keeps the earliest `minted_at`. The `WHERE true` disambiguates
      // the upsert clause from a join constraint (sqlite.org/lang_upsert).
      const upsert = "ON CONFLICT(id) DO UPDATE SET holders = holders | excluded.holders, minted_at = min(minted_at, excluded.minted_at)";
      // A migration fixture's pre-state is a PARTIAL old schema (spec/store
      // §3.4: the tables the step touches), so every source is read only when
      // its tables exist; a real database has them all.
      const has = (...tables: string[]): boolean => tables.every((t) => this.tableExists(t));
      const ins = (tables: string[], select: string): void => {
        if (!has(...tables)) return;
        const stmt = db.prepare(`INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) ${select} ${upsert}`);
        if (select.includes("@clock")) stmt.run({ clock });
        else stmt.run();
      };
      const commitTs = has("commits") ? "c.ts" : "NULL";
      const commitJoin = (on: string): string => (has("commits") ? `LEFT JOIN commits c ON c.commit_id = ${on}` : "");
      const anyRepo = has("repos") ? "(SELECT repo_id FROM repos ORDER BY rowid LIMIT 1)" : "NULL";
      // d
      ins(["docs"], "SELECT doc_id, repo_id, 'd', created_at, 1 FROM docs WHERE true");
      ins(["docs", "revisions"], "SELECT DISTINCT r.doc_id, d.repo_id, 'd', d.created_at, 2 FROM revisions r JOIN docs d ON d.doc_id = r.doc_id WHERE true");
      // b
      ins(["blocks"], "SELECT block_id, repo_id, 'b', created_at, 1 FROM blocks WHERE true");
      ins(["resurrection_pool"], "SELECT block_id, repo_id, 'b', created_at, 1 FROM resurrection_pool WHERE true");
      ins(["block_changes"], `SELECT bc.block_id, COALESCE(${has("commits") ? "c.repo_id" : "NULL"}, ${anyRepo}), 'b', COALESCE(MIN(${commitTs}), @clock), 2 FROM block_changes bc ${commitJoin("bc.commit_id")} WHERE true GROUP BY bc.block_id`);
      ins(["dispositions"], `SELECT x.block_id, COALESCE(${has("commits") ? "c.repo_id" : "NULL"}, ${anyRepo}), 'b', COALESCE(MIN(${commitTs}), @clock), 2 FROM dispositions x ${commitJoin("x.commit_id")} WHERE x.block_id != 'DOC' GROUP BY x.block_id`);
      // r
      ins(["docs"], "SELECT head, repo_id, 'r', updated_at, 1 FROM docs WHERE head IS NOT NULL");
      ins(["docs", "revisions"], `SELECT r.rev_id, d.repo_id, 'r', COALESCE(${commitTs}, @clock), 2 FROM revisions r JOIN docs d ON d.doc_id = r.doc_id ${commitJoin("r.commit_id")} WHERE true`);
      // x, e
      ins(["external_nodes", "edges"], `SELECT n.node_id, n.repo_id, 'x', COALESCE(MIN(${commitTs}), @clock), 1 FROM external_nodes n LEFT JOIN edges e ON e.dst_node = n.node_id ${commitJoin("e.from_commit")} WHERE true GROUP BY n.node_id`);
      ins(["edges"], `SELECT e.edge_id, e.repo_id, 'e', COALESCE(${commitTs}, @clock), 1 FROM edges e ${commitJoin("e.from_commit")} WHERE true`);
      // rp, src
      ins(["repos"], `SELECT r.repo_id, r.repo_id, 'rp', COALESCE(${has("commits") ? "(SELECT MIN(ts) FROM commits WHERE repo_id = r.repo_id)" : "NULL"}, @clock), 1 FROM repos r WHERE true`);
      ins(["sources"], "SELECT source_id, NULL, 'src', @clock, 1 FROM sources WHERE true");
    })();
  }

  // The feed half of step 17 (spec/store §3.4 step 17 (6)–(9); modular-core
  // Phase 3d — D7/M5, D4): the repository EPOCH, the `feed`/`feed_entries`
  // tables backfilled from the 16.x `commits`/`revisions`, the recorder's
  // `commits` row rebuilt with `epoch`/`batch_id` and without `checkpoint_id`,
  // the `sync_state` status row from the latest `checkpoints` row, and
  // `checkpoints` dropped. One transaction, `foreign_keys = OFF` for its
  // duration (`repos` and `commits` are rebuilt; both are referenced),
  // `PRAGMA foreign_key_check` empty at its end. Idempotent on each part:
  // `repos` with `epoch` is left alone, an existing `feed` is not backfilled
  // again, `commits` without `checkpoint_id` is left alone, `sync_state` with
  // the status columns is left alone, a missing `checkpoints` is nothing to
  // drop. Runs after the identity and recovery halves (the claims table must
  // exist for the `c`/`ep` claims). A pre-state without `repos` has no
  // repository to give an epoch and is left alone (the migration fixtures'
  // partial pre-states; a real database always has it).
  private migrateV17Feed(): void {
    const db = this.db;
    if (!this.tableExists("repos")) return;
    const repoCols = db.pragma("table_info(repos)") as { name: string }[];
    const commitCols = this.tableExists("commits") ? (db.pragma("table_info(commits)") as { name: string }[]) : [];
    const syncCols = this.tableExists("sync_state") ? (db.pragma("table_info(sync_state)") as { name: string }[]) : [];
    const needsEpoch = !repoCols.some((c) => c.name === "epoch");
    const needsFeed = !this.tableExists("feed");
    const needsCommits = commitCols.length > 0 && commitCols.some((c) => c.name === "checkpoint_id");
    const needsStatus = syncCols.length > 0 && !syncCols.some((c) => c.name === "last_batch_ts");
    const hasCheckpoints = this.tableExists("checkpoints");
    if (!needsEpoch && !needsFeed && !needsCommits && !needsStatus && !hasCheckpoints) return;
    const clock = new Date().toISOString();
    const hasCommits = this.tableExists("commits");
    const hasClaims = this.tableExists("id_claims");
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        // (6) repos: the epoch — one `ep` per repository in rowid order, the
        // claim minted at the repo's first commit's ts (the epoch is as old as
        // the feed it scopes), else the clock. A rebuild: SQLite cannot add a
        // NOT NULL column without a default.
        if (needsEpoch) {
          db.exec(`
CREATE TABLE repos_v17 (
  repo_id   TEXT PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  settings  TEXT NOT NULL DEFAULT '{}',
  epoch     TEXT NOT NULL
);`);
          const firstTs = hasCommits ? db.prepare("SELECT MIN(ts) AS ts FROM commits WHERE repo_id = ?") : null;
          const ins = db.prepare("INSERT INTO repos_v17 (rowid, repo_id, slug, settings, epoch) VALUES (?, ?, ?, ?, ?)");
          const claim = hasClaims ? db.prepare("INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) VALUES (?, ?, 'ep', ?, 1) ON CONFLICT(id) DO UPDATE SET holders = holders | 1") : null;
          for (const r of db.prepare("SELECT rowid, repo_id, slug, settings FROM repos ORDER BY rowid").all() as { rowid: number; repo_id: string; slug: string; settings: string | null }[]) {
            const epoch = mintId("ep");
            ins.run(r.rowid, r.repo_id, r.slug, r.settings ?? "{}", epoch);
            claim?.run(epoch, r.repo_id, (firstTs?.get(r.repo_id) as { ts: string | null } | undefined)?.ts ?? clock);
          }
          db.exec("DROP TABLE repos; ALTER TABLE repos_v17 RENAME TO repos;");
        }
        const epochOf = db.prepare("SELECT epoch FROM repos WHERE repo_id = ?");

        // (7) feed + feed_entries, backfilled from the 16.x `commits`/`revisions`:
        // one row per commit (`epoch` the new one, `seq = commits.seq`,
        // `batch_id = commit_id` — no checkpoint grouped them; `plan_id` NULL);
        // entries `created`/`changed` from `revisions` (seq 1 ⇒ created),
        // `deleted` from the tombstones whose `deleted_at` is the commit's ts,
        // `moved` only where a commit with no entry of its own records
        // `move <from> -> <to>` in its reason (resolution 12: what the rows
        // say, no path reconstruction) — the doc now at `<to>`, its current
        // head and hash. Then the prune under the defaults.
        if (needsFeed) {
          db.exec(FEED_DDL);
          if (hasCommits) {
            const hasRevisions = this.tableExists("revisions");
            const hasDocs = this.tableExists("docs") && (db.pragma("table_info(docs)") as { name: string }[]).some((c) => c.name === "deleted_at");
            const insRow = db.prepare("INSERT OR IGNORE INTO feed (repo_id, epoch, seq, commit_id, ts, origin, actor, reason, batch_id, plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)");
            const insEntry = db.prepare("INSERT OR IGNORE INTO feed_entries (repo_id, epoch, seq, doc_id, path, head, hash, kind, from_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
            const revs = hasRevisions ? db.prepare("SELECT doc_id, seq, rev_id, rendered_hash, path FROM revisions WHERE commit_id = ? ORDER BY rowid") : null;
            const gone = hasDocs ? db.prepare("SELECT doc_id, path FROM docs WHERE repo_id = ? AND deleted_at = ? ORDER BY path") : null;
            const at = hasDocs ? db.prepare("SELECT doc_id, head, file_hash FROM docs WHERE repo_id = ? AND path = ?") : null;
            const commits = db.prepare("SELECT commit_id, repo_id, seq, ts, origin, actor, reason FROM commits ORDER BY repo_id, seq").all() as { commit_id: string; repo_id: string; seq: number; ts: string; origin: string; actor: string | null; reason: string | null }[];
            for (const c of commits) {
              const epoch = (epochOf.get(c.repo_id) as { epoch: string } | undefined)?.epoch;
              if (epoch === undefined) continue;
              insRow.run(c.repo_id, epoch, c.seq, c.commit_id, c.ts, c.origin, c.actor, c.reason, c.commit_id);
              let entries = 0;
              for (const r of (revs?.all(c.commit_id) ?? []) as { doc_id: string; seq: number; rev_id: string; rendered_hash: Buffer; path: string }[]) {
                insEntry.run(c.repo_id, epoch, c.seq, r.doc_id, r.path, r.rev_id, r.rendered_hash, r.seq === 1 ? "created" : "changed", null);
                entries++;
              }
              for (const d of (gone?.all(c.repo_id, c.ts) ?? []) as { doc_id: string; path: string }[]) {
                insEntry.run(c.repo_id, epoch, c.seq, d.doc_id, d.path, null, null, "deleted", null);
                entries++;
              }
              if (entries === 0 && c.reason !== null && at) {
                const m = /^move (.+) -> (.+)$/.exec(c.reason);
                const doc = m ? (at.get(c.repo_id, m[2]!) as { doc_id: string; head: string | null; file_hash: Buffer | null } | undefined) : undefined;
                if (m && doc) insEntry.run(c.repo_id, epoch, c.seq, doc.doc_id, m[2]!, doc.head, doc.file_hash, "moved", m[1]!);
              }
            }
          }
          // The prune under the defaults (§7.4) — the settings layers exist on
          // every real database; a partial fixture pre-state may lack them.
          if (this.tableExists("workspace_settings")) pruneFeed(this, clock);
          // The `c` claims (§2.1, 3d: the core mints `c` and claims it): bit 0
          // for every commit the feed holds, bit 1 for every `commits` row.
          if (hasClaims && hasCommits) {
            db.prepare(
              `INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) SELECT commit_id, repo_id, 'c', ts, 1 FROM feed WHERE true
               ON CONFLICT(id) DO UPDATE SET holders = holders | 1, minted_at = min(minted_at, excluded.minted_at)`,
            ).run();
            db.prepare(
              `INSERT INTO id_claims (id, repo_id, prefix, minted_at, holders) SELECT commit_id, repo_id, 'c', ts, 2 FROM commits WHERE true
               ON CONFLICT(id) DO UPDATE SET holders = holders | 2, minted_at = min(minted_at, excluded.minted_at)`,
            ).run();
          }
        }

        // (8) commits: the recorder's row — `epoch` (the repo's), `batch_id =
        // commit_id`, `checkpoint_id` dropped, `rowid`s kept.
        if (needsCommits) {
          db.exec(`
CREATE TABLE commits_v17 (
  commit_id TEXT PRIMARY KEY,
  repo_id   TEXT NOT NULL REFERENCES repos(repo_id),
  epoch     TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  ts        TEXT NOT NULL,
  origin    TEXT NOT NULL CHECK (origin IN ('api','observed','import','projection')),
  actor     TEXT,
  reason    TEXT,
  batch_id  TEXT NOT NULL,
  ops       TEXT,
  UNIQUE (repo_id, epoch, seq)
);
INSERT INTO commits_v17 (rowid, commit_id, repo_id, epoch, seq, ts, origin, actor, reason, batch_id, ops)
  SELECT c.rowid, c.commit_id, c.repo_id, COALESCE((SELECT epoch FROM repos r WHERE r.repo_id = c.repo_id), ''), c.seq, c.ts, c.origin, c.actor, c.reason, c.commit_id, c.ops FROM commits c ORDER BY c.rowid;
DROP TABLE commits;
ALTER TABLE commits_v17 RENAME TO commits;`);
        }

        // (9) sync_state: the three status columns; per repository the reserved
        // row from the latest `checkpoints` row by ts (`last_batch_id` NULL — the
        // batch id is unknowable, `files` the array's length); then drop
        // `checkpoints`.
        if (needsStatus) {
          db.exec(`
ALTER TABLE sync_state ADD COLUMN last_batch_ts TEXT;
ALTER TABLE sync_state ADD COLUMN last_batch_id TEXT;
ALTER TABLE sync_state ADD COLUMN last_batch_files INTEGER;`);
        }
        if (hasCheckpoints && this.tableExists("sync_state")) {
          db.prepare(
            `INSERT OR IGNORE INTO sync_state (repo_id, source_id, path, revision, cursor, last_batch_ts, last_batch_id, last_batch_files)
             SELECT cp.repo_id, '', '', NULL, NULL, cp.ts, NULL, json_array_length(cp.files)
               FROM checkpoints cp WHERE cp.rowid = (SELECT c2.rowid FROM checkpoints c2 WHERE c2.repo_id = cp.repo_id ORDER BY c2.ts DESC, c2.rowid DESC LIMIT 1)`,
          ).run();
        }
        if (hasCheckpoints) db.exec("DROP TABLE checkpoints");

        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) throw new Error(`migration v17: ${violations.length} foreign key violation(s) after the feed step`);
      })();
    } finally {
      db.pragma("foreign_keys = ON");
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
