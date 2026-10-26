import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { ensureRepo } from "../attach.js";
import { processCheckpoint } from "../../sync/checkpoint.js";
import { ALL_DDL } from "./schema.js";
import {
  SIZE_CATEGORIES, TABLE_CATEGORY, categoryOf, formatShare, humanBytes, shareOf, sizeAdvice, sizeReport, vacuum,
  type SizeCategoryReport, type SizeFile,
} from "./size.js";
import { vectorSizeAdvice } from "../../semantic/advice.js";

const RETENTION = { revisions: 0, bytes: 0 };

// spec/store §7 "Size": the report over dbstat, the categorization, the advice,
// the fallback without dbstat, and VACUUM.

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-size-"));
  store = new Store({ path: join(dir, ".omgbase", "omgbase.db") });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(path: string, content: string): void {
  writeFileSync(join(dir, path), content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}

describe("humanize", () => {
  it("formats bytes 1024-based with one decimal from the integer tenths", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1023)).toBe("1023 B");
    expect(humanBytes(1024)).toBe("1.0 KB");
    expect(humanBytes(4096)).toBe("4.0 KB");
    expect(humanBytes(1280)).toBe("1.3 KB"); // 1.25 rounds half up
    expect(humanBytes(13734297)).toBe("13.1 MB");
    expect(humanBytes(104857600)).toBe("100.0 MB");
    expect(humanBytes(1024 ** 3)).toBe("1.0 GB");
    expect(humanBytes(1024 ** 4 * 3)).toBe("3.0 TB");
    expect(humanBytes(1024 ** 5)).toBe("1024.0 TB"); // capped unit
  });
  it("formats shares to one decimal", () => {
    expect(formatShare(48.2)).toBe("48.2%");
    expect(formatShare(50)).toBe("50.0%");
    expect(formatShare(0)).toBe("0.0%");
    expect(shareOf(1, 3)).toBe(33.3);
    expect(shareOf(1, 0)).toBe(0);
    expect(shareOf(2, 4)).toBe(50);
  });
});

describe("categorization", () => {
  it("assigns every table schema.sql creates, and anything else to sync", () => {
    const created = [...ALL_DDL.matchAll(/CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
    expect(created.length).toBeGreaterThan(25);
    for (const t of created) expect(TABLE_CATEGORY[t], t).toBeDefined();
    expect(Object.keys(TABLE_CATEGORY).sort()).toEqual([...created].sort());
    expect(categoryOf("sqlite_schema")).toBe("sync");
    expect(categoryOf("sqlite_stat1")).toBe("sync");
    expect(categoryOf("blobs")).toBe("history");
    expect(categoryOf("blocks_fts")).toBe("search");
    expect(categoryOf("blocks")).toBe("content");
    expect(categoryOf("id_claims")).toBe("identity");
    expect(categoryOf("resurrection_pool")).toBe("identity");
    expect(categoryOf("pending_materializations")).toBe("recovery");
    expect(categoryOf("edge_transitions")).toBe("history");
    expect(categoryOf("feed")).toBe("sync");
  });
});

describe("sizeReport", () => {
  it("measures every table through dbstat, folds indexes and shadow tables, and sums the file", () => {
    save("a.md", "# A\n\nbody one\n\nbody two\n");
    save("b.md", "# B\n\n- [ ] a task [link](a.md)\n");
    const r = sizeReport(store);
    expect(r.detail).toBeUndefined();
    expect(r.file.path).toBe(join(dir, ".omgbase", "omgbase.db"));
    expect(r.file.bytes).toBe(statSync(r.file.path).size);
    expect(r.file.page_size).toBe(4096);
    expect(r.file.reclaimable).toBe(r.file.freelist_count * r.file.page_size);
    expect(r.categories.map((c) => c.name)).toEqual([...SIZE_CATEGORIES]);

    const all = r.categories.flatMap((c) => c.tables);
    const names = all.map((t) => t.name);
    // Shadow tables fold into their FTS table; indexes are not tables.
    expect(names).toContain("blocks_fts");
    expect(names.some((n) => /_fts_(data|idx|docsize|config)$/.test(n))).toBe(false);
    expect(names.some((n) => n.startsWith("idx_") || n.startsWith("sqlite_autoindex"))).toBe(false);
    expect(names).toContain("sqlite_schema");
    // Every table's bytes are whole pages, indexes included in them.
    for (const t of all) {
      expect(t.bytes! % 4096, t.name).toBe(0);
      expect(t.indexes!).toBeLessThanOrEqual(t.bytes!);
    }
    const blocks = all.find((t) => t.name === "blocks")!;
    expect(blocks.indexes).toBeGreaterThan(0); // four idx_blocks_* + the autoindex
    expect(blocks.rows).toBe((store.db.prepare("SELECT count(*) c FROM blocks").get() as { c: number }).c);
    // The FTS table's rows are the indexed rows (its _docsize shadow), the live leaves.
    const fts = all.find((t) => t.name === "blocks_fts")!;
    expect(fts.rows).toBe((store.db.prepare("SELECT count(*) c FROM blocks_fts_docsize").get() as { c: number }).c);
    expect(fts.rows).toBeGreaterThan(0);
    // The categories' bytes sum to the whole dbstat total, shares to ~100.
    const total = (store.db.prepare("SELECT sum(pgsize) s FROM dbstat").get() as { s: number }).s;
    expect(r.categories.reduce((n, c) => n + c.bytes!, 0)).toBe(total);
    const shares = r.categories.reduce((n, c) => n + c.share!, 0);
    expect(Math.abs(shares - 100)).toBeLessThan(0.3);
    // A category's rows are its tables' rows; tables by bytes desc then name.
    for (const c of r.categories) {
      expect(c.rows).toBe(c.tables.reduce((n, t) => n + t.rows, 0));
      const sorted = [...c.tables].sort((a, b) => b.bytes! - a.bytes! || a.name.localeCompare(b.name));
      expect(c.tables.map((t) => t.name)).toEqual(sorted.map((t) => t.name));
    }
    expect(r.advice).toEqual(["nothing to reclaim"]);
  });

  it("falls back to row counts when dbstat is unavailable", () => {
    save("a.md", "# A\n\nbody\n");
    const real = store.db.prepare.bind(store.db);
    (store.db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/\bdbstat\b/.test(sql)) throw new Error("no such table: dbstat");
      return real(sql);
    };
    const r = sizeReport(store);
    expect(r.detail).toBe("dbstat unavailable");
    for (const c of r.categories) {
      expect(c.bytes).toBeNull();
      expect(c.share).toBeNull();
      for (const t of c.tables) {
        expect(t.bytes).toBeNull();
        expect(t.indexes).toBeNull();
      }
      // Rows still count, tables by rows desc then name.
      const sorted = [...c.tables].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
      expect(c.tables.map((t) => t.name)).toEqual(sorted.map((t) => t.name));
    }
    expect(r.categories.find((c) => c.name === "content")!.rows).toBeGreaterThan(0);
    expect(r.file.page_count).toBeGreaterThan(0);
    expect(r.advice).toEqual(["nothing to reclaim"]);
  });

  it("reports an in-memory database by its pages", () => {
    const mem = new Store({ path: ":memory:" });
    try {
      const r = sizeReport(mem);
      expect(r.file.path).toBe(":memory:");
      expect(r.file.bytes).toBe(r.file.page_count * r.file.page_size);
      expect(r.file.wal_bytes).toBe(0);
    } finally {
      mem.close();
    }
  });
});

describe("advice", () => {
  const file = (over: Partial<SizeFile> = {}): SizeFile => ({
    path: "x", bytes: 0, wal_bytes: 0, page_size: 4096, page_count: 1000, freelist_count: 0, reclaimable: 0, ...over,
  });
  const cat = (name: SizeCategoryReport["name"], bytes: number, total: number, tables: [string, number][] = []): SizeCategoryReport => ({
    name, bytes, share: shareOf(bytes, total), rows: 0,
    tables: tables.map(([n, b]) => ({ name: n, bytes: b, share: shareOf(b, total), rows: 0, indexes: 0 })),
  });

  it("is `nothing to reclaim` when no rule fires", () => {
    expect(sizeAdvice(file(), [cat("content", 60, 100), cat("history", 40, 100)])).toEqual(["nothing to reclaim"]);
  });
  it("suggests VACUUM only past 1 MiB and 10 % of the pages", () => {
    const small = file({ freelist_count: 200, reclaimable: 200 * 4096 }); // 800 KB, 20 %
    expect(sizeAdvice(small, [])).toEqual(["nothing to reclaim"]);
    const thin = file({ page_count: 100000, freelist_count: 300, reclaimable: 300 * 4096 }); // 1.2 MB, 0.3 %
    expect(sizeAdvice(thin, [])).toEqual(["nothing to reclaim"]);
    const fat = file({ page_count: 1000, freelist_count: 300, reclaimable: 300 * 4096 }); // 1.2 MB, 30 %
    expect(sizeAdvice(fat, [])).toEqual(["run `omg gc --vacuum` to return 1.2 MB of free pages to the filesystem"]);
  });
  it("names history past 50 % and embeddings past 25 %, in order", () => {
    const cats = [cat("content", 13, 100), cat("history", 57, 100), cat("search", 30, 100, [["embeddings", 26], ["blocks_fts", 4]])];
    expect(sizeAdvice(file(), cats, 0, RETENTION, vectorSizeAdvice)).toEqual([
      "history dominates (57.0%): blobs, tree nodes and dispositions grow with every commit — enable gc (`omg config set gc.enabled true`) and run `omg gc --vacuum`",
      "embeddings are 26.0% of the database: a smaller model (`embedding.model` / `embedding.dim`) or `omg embed drain --prune` after a model switch shrinks them",
    ]);
    // Exactly 50 / 25 do not fire; null shares (no dbstat) never do.
    expect(sizeAdvice(file(), [cat("content", 25, 100), cat("history", 50, 100), cat("search", 25, 100, [["embeddings", 25]])], 0, RETENTION, vectorSizeAdvice)).toEqual(["nothing to reclaim"]);
    const blind: SizeCategoryReport = { name: "history", bytes: null, share: null, rows: 9, tables: [] };
    expect(sizeAdvice(file(), [blind])).toEqual(["nothing to reclaim"]);
  });
  it("names `same` dispositions past 25 % of the table, after history and before embeddings (store 14.2)", () => {
    const history = (rows: number): SizeCategoryReport => ({
      name: "history", bytes: 40, share: 40, rows,
      tables: [{ name: "dispositions", bytes: 40, share: 40, rows, indexes: 0 }],
    });
    expect(sizeAdvice(file(), [cat("content", 60, 100), history(100)], 26)).toEqual([
      "26 same dispositions are history nothing reads (store 14.2): `omg gc` removes them, `--vacuum` reclaims the pages",
    ]);
    // Exactly 25 % does not fire; zero never does; the share is over rows, so it holds without dbstat.
    expect(sizeAdvice(file(), [cat("content", 60, 100), history(100)], 25)).toEqual(["nothing to reclaim"]);
    expect(sizeAdvice(file(), [cat("content", 60, 100), history(100)], 0)).toEqual(["nothing to reclaim"]);
    const blind: SizeCategoryReport = { name: "history", bytes: null, share: null, rows: 10, tables: [{ name: "dispositions", bytes: null, share: null, rows: 10, indexes: null }] };
    expect(sizeAdvice(file(), [blind], 9)).toEqual([
      "9 same dispositions are history nothing reads (store 14.2): `omg gc` removes them, `--vacuum` reclaims the pages",
    ]);
    const cats = [cat("content", 13, 100), cat("history", 57, 100, [["dispositions", 57]]), cat("search", 30, 100, [["embeddings", 26]])];
    cats[1]!.tables[0]!.rows = 4;
    expect(sizeAdvice(file(), cats, 3, RETENTION, vectorSizeAdvice).map((a) => a.split(":")[0])).toEqual([
      "history dominates (57.0%)",
      "3 same dispositions are history nothing reads (store 14.2)",
      "embeddings are 26.0% of the database",
    ]);
  });
});

describe("vacuum", () => {
  it("returns the free pages' bytes and leaves none behind", () => {
    save("a.md", "# A\n\n" + Array.from({ length: 200 }, (_, i) => `paragraph ${i} with some words to fill a page or two`).join("\n\n") + "\n");
    // Drop derived rows outside the store's own paths so pages hit the freelist.
    store.db.exec("DELETE FROM block_changes; DELETE FROM dispositions; DELETE FROM sections;");
    const before = sizeReport(store).file;
    expect(before.freelist_count).toBeGreaterThan(0);
    const res = vacuum(store);
    expect(res.reclaimable).toBe(before.reclaimable);
    const after = sizeReport(store).file;
    expect(after.freelist_count).toBe(0);
    expect(after.page_count).toBeLessThan(before.page_count);
    // Content survives.
    expect((store.db.prepare("SELECT count(*) c FROM blocks").get() as { c: number }).c).toBeGreaterThan(200);
    expect(store.db.pragma("integrity_check", { simple: true })).toBe("ok");
  });
  it("is a no-op's worth of zero on a compact database", () => {
    const res = vacuum(store);
    expect(res.reclaimable).toBe(0);
  });
});
