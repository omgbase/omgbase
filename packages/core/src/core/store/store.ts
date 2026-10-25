import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DDL, SCHEMA_VERSION, MIGRATIONS, SYNC_DDL, ARCHIVES_DDL } from "./schema.js";
import { cosineBytes } from "../vec.js";
import { mintId, registerIdOracle } from "../ids.js";
import type { Capabilities, CapabilitiesFactory } from "../capabilities/types.js";
import { bindCapabilities } from "../capabilities/registry.js";
import { defaultCapabilities } from "../capabilities/default.js";

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
   * library embedding) names a factory; absent, `defaultCapabilities` — the
   * same implementations — so a bare store (fixtures, tests) behaves exactly
   * as one opened through the composition layer.
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
    // cosine(vecBlob, queryBlob) → REAL: the similarity used by OQX's semantic()
    // scalar. Deterministic (same inputs → same score) so SQLite may cache it.
    this.db.function("cosine", { deterministic: true }, (a, b) =>
      cosineBytes(a as Uint8Array | null, b as Uint8Array | null),
    );
    this.migrate();
    // The capabilities (modular-core Phase 1): bound to the connection so a
    // core path holding only `db` reaches them (`capabilitiesOf`).
    this.capabilities = (opts.capabilities ?? defaultCapabilities)(this);
    bindCapabilities(this.db, this.capabilities);
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
