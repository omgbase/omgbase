import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DDL, SCHEMA_VERSION } from "./schema.js";

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
    } else if (current !== SCHEMA_VERSION) {
      throw new Error(
        `schema version mismatch: db=${current} expected=${SCHEMA_VERSION} (migrations not yet implemented)`,
      );
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
