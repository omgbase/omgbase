import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DDL, SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

// SQLite store (02 §2). One database per workspace at
// <workspace>/.omgbase/omgbase.db, WAL mode, synchronous=NORMAL, FK on. All
// writes funnel through a single serialized writer connection (short txns);
// reads use the same connection in v1 (single-process engine).

export interface StoreOptions {
  /** ':memory:' for tests, or a filesystem path (parent dirs created). */
  path: string;
}

export class Store {
  readonly db: Database.Database;

  constructor(opts: StoreOptions) {
    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new Database(opts.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
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

  /**
   * Run fn inside a single write transaction (02 §2: one transaction per
   * commit). better-sqlite3 transactions are synchronous and serialized.
   */
  write<T>(fn: (db: Database.Database) => T): T {
    return this.db.transaction(fn)(this.db);
  }

  pragma(name: string): unknown {
    return this.db.pragma(name, { simple: true });
  }

  close(): void {
    this.db.close();
  }
}
