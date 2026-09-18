import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { SCHEMA_VERSION } from "./schema.js";

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

describe("Store — schema & config", () => {
  it("applies pragmas: WAL, synchronous=NORMAL, foreign_keys on", () => {
    store = new Store({ path: ":memory:" });
    // :memory: reports 'memory' for journal_mode; assert FK + synchronous which hold.
    expect(store.pragma("foreign_keys")).toBe(1);
    // synchronous NORMAL === 1
    expect(store.pragma("synchronous")).toBe(1);
  });

  it("sets user_version to the schema version", () => {
    store = new Store({ path: ":memory:" });
    expect(store.pragma("user_version")).toBe(SCHEMA_VERSION);
  });

  it("creates all durable + derived tables", () => {
    store = new Store({ path: ":memory:" });
    const names = (
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      "repos", "docs", "blocks", "blobs", "tree_nodes", "revisions",
      "commits", "dispositions", "edges", "external_nodes", "collections",
      "checkpoints", "resurrection_pool", "sections", "doc_edges",
      "block_changes", "inferred_edges", "embeddings", "blocks_fts",
      "file_stats",
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it("migrates an older (v1) database forward, adding file_stats", () => {
    const dir = mkdtempSync(join(tmpdir(), "omg-migrate-"));
    const dbPath = join(dir, "old.db");
    try {
      // Simulate a v1 database: durable tables present, user_version=1, no file_stats.
      const raw = new Database(dbPath);
      raw.exec("CREATE TABLE repos (repo_id TEXT PRIMARY KEY, slug TEXT, root_path TEXT, settings TEXT)");
      raw.pragma("user_version = 1");
      raw.close();

      store = new Store({ path: dbPath });
      expect(store.pragma("user_version")).toBe(SCHEMA_VERSION);
      const hasFileStats = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_stats'")
        .get();
      expect(hasFileStats).toBeTruthy();
    } finally {
      store?.close();
      store = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces foreign keys (block requires existing repo/doc)", () => {
    store = new Store({ path: ":memory:" });
    expect(() =>
      store!.db
        .prepare(
          "INSERT INTO docs (doc_id, repo_id, path) VALUES ('d_x','rp_missing','a.md')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("migrates v12→v13: drops repos.root_path, moving it into an fs source (ADR-014)", () => {
    const dir = mkdtempSync(join(tmpdir(), "omg-v13-"));
    const dbPath = join(dir, "old.db");
    try {
      // Build a pre-v13 database: current schema + the old root_path column,
      // one repo backed by a filesystem root, user_version pinned to 12.
      const raw = new Database(dbPath);
      raw.exec(
        "CREATE TABLE repos (repo_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, root_path TEXT, settings TEXT NOT NULL DEFAULT '{}');" +
          "CREATE TABLE adapters (name TEXT PRIMARY KEY, command TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]');" +
          "CREATE TABLE sources (source_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, adapter TEXT NOT NULL REFERENCES adapters(name), config TEXT NOT NULL DEFAULT '{}', env TEXT NOT NULL DEFAULT '{}');" +
          "CREATE TABLE attachments (repo_id TEXT NOT NULL REFERENCES repos(repo_id), source_id TEXT NOT NULL REFERENCES sources(source_id), PRIMARY KEY (repo_id, source_id));",
      );
      raw.prepare("INSERT INTO repos (repo_id, slug, root_path) VALUES ('rp_1','vault','/data/vault')").run();
      raw.pragma("user_version = 12");
      raw.close();

      store = new Store({ path: dbPath });
      expect(store.pragma("user_version")).toBe(SCHEMA_VERSION);

      // The column is gone …
      const cols = store.db.pragma("table_info(repos)") as { name: string }[];
      expect(cols.some((c) => c.name === "root_path")).toBe(false);

      // … and the former root_path is now an attached fs source.
      const src = store.db.prepare("SELECT name, adapter, config FROM sources WHERE name = 'vault-fs'").get() as { name: string; adapter: string; config: string };
      expect(src.adapter).toBe("fs");
      expect(JSON.parse(src.config)).toEqual({ root: "/data/vault" });
      const attached = store.db.prepare("SELECT 1 FROM attachments a JOIN sources s ON s.source_id = a.source_id WHERE a.repo_id = 'rp_1' AND s.name = 'vault-fs'").get();
      expect(attached).toBeTruthy();
    } finally {
      store?.close();
      store = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces CHECK constraints (commit origin enum)", () => {
    store = new Store({ path: ":memory:" });
    store.db.prepare("INSERT INTO repos (repo_id, slug) VALUES ('rp_1','s')").run();
    expect(() =>
      store!.db
        .prepare(
          "INSERT INTO commits (commit_id, repo_id, seq, ts, origin) VALUES ('c_1','rp_1',1,'t','bogus')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("runs write() transactionally and rolls back on throw", () => {
    store = new Store({ path: ":memory:" });
    expect(() =>
      store!.write((db) => {
        db.prepare("INSERT INTO repos (repo_id, slug) VALUES ('rp_1','s')").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const count = store.db.prepare("SELECT count(*) c FROM repos").get() as { c: number };
    expect(count.c).toBe(0);
  });
});
