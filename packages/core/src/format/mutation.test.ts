import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { apply } from "../mutate/apply.js";
import "../format/index.js";

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-mutfmt-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(path: string, content: string): void {
  const abs = join(dir, path);
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(abs, content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}

function blockId(path: string, index: number): string {
  const rows = store.db
    .prepare("SELECT block_id FROM blocks WHERE doc_id = (SELECT doc_id FROM documents WHERE path = ?) AND parent_block IS NULL AND deleted_commit IS NULL ORDER BY ordinal")
    .all(path) as { block_id: string }[];
  return rows[index]!.block_id;
}

function contentHash(bid: string): string {
  const row = store.db.prepare("SELECT raw_hash FROM blocks WHERE block_id = ?").get(bid) as { raw_hash: Buffer };
  return row.raw_hash.toString("hex");
}

describe("YAML mutations", () => {
  it("update: replace a YAML mapping entry's value", () => {
    save("config.yaml", "database:\n  host: localhost\n  port: 5432\nlogging:\n  level: debug\n");
    const bid = blockId("config.yaml", 0); // database entry
    const hash = contentHash(bid);

    const result = apply(store, {
      repoId,
      rootPath: dir,
      ops: [{ op: "update", block: bid, markdown: "database:\n  host: production-db\n  port: 5432\n", expect: { content_hash: hash } }],
      origin: { actor: "test", reason: "update host" },
    });
    expect(result.committed).toBe(true);

    const content = readFileSync(join(dir, "config.yaml"), "utf8");
    expect(content).toContain("production-db");
    expect(content).toContain("logging");
  });

  it("remove: delete a YAML mapping entry", () => {
    save("config.yaml", "database:\n  host: localhost\nlogging:\n  level: debug\n");
    const bid = blockId("config.yaml", 1); // logging entry
    const hash = contentHash(bid);

    const result = apply(store, {
      repoId,
      rootPath: dir,
      ops: [{ op: "remove", blocks: [bid], expect: { [bid]: { content_hash: hash } } }],
      origin: { actor: "test", reason: "remove logging" },
    });
    expect(result.committed).toBe(true);

    const content = readFileSync(join(dir, "config.yaml"), "utf8");
    expect(content).toContain("database");
    expect(content).not.toContain("logging");
  });

  it("insert: add a new YAML mapping entry", () => {
    save("config.yaml", "database:\n  host: localhost\n");

    const result = apply(store, {
      repoId,
      rootPath: dir,
      ops: [{
        op: "insert",
        doc: (store.db.prepare("SELECT doc_id FROM documents WHERE path = 'config.yaml'").get() as { doc_id: string }).doc_id,
        to: { parent: { doc: true }, at: "end" },
        markdown: "cache_ttl: 300\n",
      }],
      origin: { actor: "test", reason: "add cache config" },
    });
    expect(result.committed).toBe(true);

    const content = readFileSync(join(dir, "config.yaml"), "utf8");
    expect(content).toContain("cache_ttl");
    expect(content).toContain("300");
  });

  it("move: reorder YAML mapping entries", () => {
    save("config.yaml", "database:\n  host: localhost\nlogging:\n  level: debug\ncache:\n  ttl: 300\n");
    const cacheId = blockId("config.yaml", 2);

    const result = apply(store, {
      repoId,
      rootPath: dir,
      ops: [{ op: "move", blocks: [cacheId], to: { parent: { doc: true }, at: "start" } }],
      origin: { actor: "test", reason: "move cache to top" },
    });
    expect(result.committed).toBe(true);

    const content = readFileSync(join(dir, "config.yaml"), "utf8");
    const lines = content.split("\n");
    const cacheIdx = lines.findIndex((l) => l.startsWith("cache"));
    const dbIdx = lines.findIndex((l) => l.startsWith("database"));
    expect(cacheIdx).toBeLessThan(dbIdx);
  });

  it("dry-run: returns diff without writing", () => {
    save("config.yaml", "database:\n  host: localhost\n");
    const bid = blockId("config.yaml", 0);
    const hash = contentHash(bid);

    const result = apply(store, {
      repoId,
      rootPath: dir,
      ops: [{ op: "update", block: bid, markdown: "database:\n  host: remote\n", expect: { content_hash: hash } }],
      origin: { actor: "test" },
      dryRun: true,
    });
    expect(result.committed).toBe(false);
    expect(result.diffs).toBeDefined();
    expect(result.diffs!["config.yaml"]!.after).toContain("remote");

    const content = readFileSync(join(dir, "config.yaml"), "utf8");
    expect(content).toContain("localhost");
  });
});

describe("JSON mutations", () => {
  it("update: replace a JSON property value", () => {
    save("data.json", `{\n  "name": "old",\n  "version": "1.0"\n}`);
    const bid = blockId("data.json", 0);
    const hash = contentHash(bid);

    const result = apply(store, {
      repoId,
      rootPath: dir,
      ops: [{ op: "update", block: bid, markdown: `"name": "new"`, expect: { content_hash: hash } }],
      origin: { actor: "test", reason: "rename" },
    });
    expect(result.committed).toBe(true);

    const content = readFileSync(join(dir, "data.json"), "utf8");
    expect(content).toContain('"new"');
    expect(content).toContain('"version"');
  });

  it("remove: delete a JSON property", () => {
    save("data.json", `{\n  "name": "test",\n  "debug": true\n}`);
    const bid = blockId("data.json", 1); // debug property
    const hash = contentHash(bid);

    const result = apply(store, {
      repoId,
      rootPath: dir,
      ops: [{ op: "remove", blocks: [bid], expect: { [bid]: { content_hash: hash } } }],
      origin: { actor: "test", reason: "remove debug" },
    });
    expect(result.committed).toBe(true);

    const content = readFileSync(join(dir, "data.json"), "utf8");
    expect(content).toContain("name");
    expect(content).not.toContain("debug");
  });

  it("move: reorder JSON properties (dry-run)", () => {
    save("data.json", `{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}`);
    const cId = blockId("data.json", 2);

    const result = apply(store, {
      repoId,
      rootPath: dir,
      ops: [{ op: "move", blocks: [cId], to: { parent: { doc: true }, at: "start" } }],
      origin: { actor: "test", reason: "move c first" },
      dryRun: true,
    });
    expect(result.committed).toBe(false);
    const after = result.diffs!["data.json"]!.after;
    const cIdx = after.indexOf('"c"');
    const aIdx = after.indexOf('"a"');
    expect(cIdx).toBeLessThan(aIdx);
  });
});
