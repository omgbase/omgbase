import { statSync } from "node:fs";
import type { Store } from "./store.js";
import { archivedSummary } from "./archive.js";
import { evaluateRetention, retentionPolicy } from "./retention.js";

// The size report (spec/store §7 "Size", 14.1): what the database is made of,
// table by table through SQLite's `dbstat` virtual table, grouped into the four
// categories a reader reasons about — the live state (`content`), the
// append-only record (`history`), the derived indexes (`search`) and the
// workspace bookkeeping (`sync`) — plus the file's page accounting and the
// deterministic advice `omg doctor --size` prints. The categorization is the
// spec's: every table of `schema.sql` is assigned, an index counts toward its
// table, an FTS5 virtual table's shadow tables fold into it, and anything the
// spec does not name (`sqlite_schema`, `sqlite_stat1`, a table from a newer
// schema) is `sync`.

export const SIZE_CATEGORIES = ["content", "history", "search", "sync"] as const;
export type SizeCategory = (typeof SIZE_CATEGORIES)[number];

/** spec/store §7: the category of every table `schema.sql` creates. */
export const TABLE_CATEGORY: Readonly<Record<string, SizeCategory>> = {
  docs: "content",
  blocks: "content",
  sections: "content",
  nodes: "content",
  edges: "content",
  doc_edges: "content",
  inferred_edges: "content",
  external_nodes: "content",
  properties: "content",
  collections: "content",
  blobs: "history",
  tree_nodes: "history",
  revisions: "history",
  commits: "history",
  dispositions: "history",
  block_changes: "history",
  resurrection_pool: "history",
  pending_materializations: "history",
  archives: "history",
  blocks_fts: "search",
  nodes_fts: "search",
  embeddings: "search",
  doc_embeddings: "search",
  repos: "sync",
  sources: "sync",
  adapters: "sync",
  attachments: "sync",
  checkpoints: "sync",
  file_stats: "sync",
  sync_state: "sync",
  workspace_settings: "sync",
};

/** The category of a table: the spec's assignment, `sync` for anything else. */
export function categoryOf(table: string): SizeCategory {
  return TABLE_CATEGORY[table] ?? "sync";
}

export interface SizeTable {
  name: string;
  /** Pages of the table and its indexes (and shadow tables), in bytes; null without dbstat. */
  bytes: number | null;
  /** `bytes` over the total, one decimal; null without dbstat. */
  share: number | null;
  rows: number;
  /** The bytes of the table's indexes alone (included in `bytes`); null without dbstat. */
  indexes: number | null;
}

export interface SizeCategoryReport {
  name: SizeCategory;
  bytes: number | null;
  share: number | null;
  rows: number;
  /** By bytes desc then name (rows desc then name without dbstat). */
  tables: SizeTable[];
}

export interface SizeFile {
  path: string;
  /** The main file's bytes on disk (`page_count * page_size` for an in-memory database). */
  bytes: number;
  /** The `-wal` file's bytes on disk, 0 when absent. */
  wal_bytes: number;
  page_size: number;
  page_count: number;
  freelist_count: number;
  /** `freelist_count * page_size`: what `VACUUM` returns to the filesystem. */
  reclaimable: number;
}

export interface SizeArchived {
  /** `revisions` rows whose bodies live in a segment (`archive IS NOT NULL`). */
  revisions: number;
  /** Recorded segments (`archives` rows). */
  segments: number;
  /** The recorded segments' bytes on disk (a missing file counts 0). */
  bytes: number;
}

/** What the retention policy would archive now (spec/store §7 "Retention"), summed over the store's repositories. */
export interface SizeRetention {
  revisions: number;
  bytes: number;
}

export interface SizeReport {
  file: SizeFile;
  /** Always the four categories, in the fixed order content, history, search, sync. */
  categories: SizeCategoryReport[];
  /** spec/store §7 (14.2): `dispositions` rows with `kind = 'same'` — what a store through 14.1 wrote and `omg gc` removes. */
  same_dispositions: number;
  /** spec/store §7 "Retention" (15.0): archived revisions, recorded segments, and the segments' bytes on disk. */
  archived: SizeArchived;
  advice: string[];
  /** Present only when the SQLite build lacks `dbstat` (row counts only). */
  detail?: "dbstat unavailable";
}

/** The advice thresholds (spec/store §7). */
export const VACUUM_ADVICE_MIN_BYTES = 1024 * 1024;
export const VACUUM_ADVICE_MIN_SHARE = 10;
export const HISTORY_ADVICE_MIN_SHARE = 50;
export const SAME_ADVICE_MIN_SHARE = 25;
export const EMBEDDINGS_ADVICE_MIN_SHARE = 25;
/** The retention advice fires when the plan's bytes exceed this share of the `history` category (15.0). */
export const RETENTION_ADVICE_MIN_SHARE = 10;

/**
 * `<n> B` under 1024, else one decimal of KB/MB/GB/TB (1024-based), the tenths
 * rounded half up — `4096` → `4.0 KB`, `13734297` → `13.1 MB`. Both engines
 * format from the integer tenths so the bytes never differ by a rounding mode.
 */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const tenths = Math.round(v * 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10} ${units[u]}`;
}

/** A share as `<n>.<d>%` from its one-decimal value (`48.2` → `48.2%`, `50` → `50.0%`). */
export function formatShare(share: number): string {
  const tenths = Math.round(share * 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** `bytes / total` in percent, one decimal, rounded half up; 0 when the total is 0. */
export function shareOf(bytes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((bytes * 1000) / total) / 10;
}

/** spec/store §7: the advice lines, in this order; `nothing to reclaim` when none applies. */
export function sizeAdvice(file: SizeFile, categories: SizeCategoryReport[], sameDispositions = 0, retention: SizeRetention = { revisions: 0, bytes: 0 }): string[] {
  const advice: string[] = [];
  const logical = file.page_count * file.page_size;
  if (file.reclaimable > VACUUM_ADVICE_MIN_BYTES && file.reclaimable * 100 > logical * VACUUM_ADVICE_MIN_SHARE) {
    advice.push(`run \`omg gc --vacuum\` to return ${humanBytes(file.reclaimable)} of free pages to the filesystem`);
  }
  const history = categories.find((c) => c.name === "history");
  if (history && history.share !== null && history.share > HISTORY_ADVICE_MIN_SHARE) {
    advice.push(`history dominates (${formatShare(history.share)}): blobs, tree nodes and dispositions grow with every commit — enable gc (\`omg config set gc.enabled true\`) and run \`omg gc --vacuum\``);
  }
  // 14.2: `same` rows are what a 14.1 store wrote for every untouched block;
  // past a quarter of the table they are worth a sweep (the share is over rows,
  // so it holds with or without dbstat).
  const dispositionRows = history?.tables.find((t) => t.name === "dispositions")?.rows ?? 0;
  if (sameDispositions > 0 && sameDispositions * 100 > dispositionRows * SAME_ADVICE_MIN_SHARE) {
    advice.push(`${sameDispositions} same dispositions are history nothing reads (store 14.2): \`omg gc\` removes them, \`--vacuum\` reclaims the pages`);
  }
  // 15.0: what the retention policy would move to a segment, when it is worth
  // a run — more than a tenth of the history category's pages (dbstat only:
  // the comparison needs the bytes).
  if (retention.revisions > 0 && history && history.bytes !== null && retention.bytes * 100 > history.bytes * RETENTION_ADVICE_MIN_SHARE) {
    advice.push(`${retention.revisions} revisions older than the policy would archive ${humanBytes(retention.bytes)}: \`omg history export --prune\``);
  }
  const search = categories.find((c) => c.name === "search");
  if (search && search.bytes !== null) {
    const total = categories.reduce((n, c) => n + (c.bytes ?? 0), 0);
    const embBytes = search.tables.filter((t) => t.name === "embeddings" || t.name === "doc_embeddings").reduce((n, t) => n + (t.bytes ?? 0), 0);
    const embShare = shareOf(embBytes, total);
    if (embShare > EMBEDDINGS_ADVICE_MIN_SHARE) {
      advice.push(`embeddings are ${formatShare(embShare)} of the database: a smaller model (\`embedding.model\` / \`embedding.dim\`) or \`omg embed drain --prune\` after a model switch shrinks them`);
    }
  }
  if (advice.length === 0) advice.push("nothing to reclaim");
  return advice;
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** The `dbstat` bytes per b-tree name, or null when the build lacks the virtual table. */
function dbstatBytes(store: Store): Map<string, number> | null {
  try {
    const rows = store.db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name").all() as { name: string; bytes: number }[];
    return new Map(rows.map((r) => [r.name, Number(r.bytes)]));
  } catch {
    return null;
  }
}

/** The size report of an open store (spec/store §7 "Size"). */
export function sizeReport(store: Store, opts: { now?: string } = {}): SizeReport {
  const db = store.db;
  const path = db.name === "" ? ":memory:" : db.name;
  const page_size = db.pragma("page_size", { simple: true }) as number;
  const page_count = db.pragma("page_count", { simple: true }) as number;
  const freelist_count = db.pragma("freelist_count", { simple: true }) as number;
  const onDisk = path !== ":memory:";
  const fileBytes = (p: string): number => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  };
  const file: SizeFile = {
    path,
    bytes: onDisk ? fileBytes(path) : page_count * page_size,
    wal_bytes: onDisk ? fileBytes(`${path}-wal`) : 0,
    page_size,
    page_count,
    freelist_count,
    reclaimable: freelist_count * page_size,
  };

  const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all() as MasterRow[];
  const virtuals = master.filter((r) => r.type === "table" && /^CREATE VIRTUAL TABLE/i.test(r.sql ?? "")).map((r) => r.name);
  // A shadow table (`blocks_fts_data`, …) folds into its virtual table.
  const ownerOf = (name: string): string => virtuals.find((v) => name.startsWith(`${v}_`)) ?? name;
  const stat = dbstatBytes(store);

  // Every table: sqlite_master's (shadow tables folded into their owner), plus
  // the schema table itself, which sqlite_master does not list but dbstat does.
  const tableNames = new Set<string>(["sqlite_schema"]);
  for (const r of master) if (r.type === "table") tableNames.add(ownerOf(r.name));
  if (stat) for (const name of stat.keys()) if (!master.some((r) => r.name === name && r.type === "index")) tableNames.add(ownerOf(name));

  const indexBytes = new Map<string, number>();
  const tableBytes = new Map<string, number>();
  if (stat) {
    for (const [name, bytes] of stat) {
      const idx = master.find((r) => r.type === "index" && r.name === name);
      if (idx) {
        indexBytes.set(idx.tbl_name, (indexBytes.get(idx.tbl_name) ?? 0) + bytes);
        tableBytes.set(idx.tbl_name, (tableBytes.get(idx.tbl_name) ?? 0) + bytes);
      } else {
        const owner = ownerOf(name);
        tableBytes.set(owner, (tableBytes.get(owner) ?? 0) + bytes);
      }
    }
  }
  const total = stat ? [...stat.values()].reduce((n, b) => n + b, 0) : 0;

  const countRows = (name: string): number => {
    // An external-content FTS5 table answers `count(*)` from its content table;
    // the rows it indexes are its `_docsize` shadow's.
    const from = virtuals.includes(name) ? `${name}_docsize` : name;
    try {
      return (db.prepare(`SELECT count(*) AS c FROM "${from.replace(/"/g, '""')}"`).get() as { c: number }).c;
    } catch {
      return 0;
    }
  };

  const byCategory = new Map<SizeCategory, SizeTable[]>(SIZE_CATEGORIES.map((c) => [c, []]));
  for (const name of tableNames) {
    const bytes = stat ? (tableBytes.get(name) ?? 0) : null;
    byCategory.get(categoryOf(name))!.push({
      name,
      bytes,
      share: bytes === null ? null : shareOf(bytes, total),
      rows: countRows(name),
      indexes: stat ? (indexBytes.get(name) ?? 0) : null,
    });
  }
  const byBytesThenName = (a: SizeTable, b: SizeTable): number =>
    (b.bytes ?? b.rows) - (a.bytes ?? a.rows) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const categories: SizeCategoryReport[] = SIZE_CATEGORIES.map((name) => {
    const tables = byCategory.get(name)!.sort(byBytesThenName);
    const bytes = stat ? tables.reduce((n, t) => n + (t.bytes ?? 0), 0) : null;
    return { name, bytes, share: bytes === null ? null : shareOf(bytes, total), rows: tables.reduce((n, t) => n + t.rows, 0), tables };
  });

  const same_dispositions = (db.prepare("SELECT count(*) AS c FROM dispositions WHERE kind = 'same'").get() as { c: number }).c;
  const archived = archivedSummary(store);
  // The retention plan of every repository under its effective policy (the
  // report is store-wide; the policy is a repository's) at one clock.
  const now = opts.now ?? new Date().toISOString();
  const retention: SizeRetention = { revisions: 0, bytes: 0 };
  for (const r of db.prepare("SELECT repo_id FROM repos ORDER BY repo_id").all() as { repo_id: string }[]) {
    const plan = evaluateRetention(store, r.repo_id, { now, policy: retentionPolicy(store, r.repo_id) });
    retention.revisions += plan.totals.archive;
    retention.bytes += plan.totals.bytes;
  }
  const report: SizeReport = { file, categories, same_dispositions, archived, advice: sizeAdvice(file, categories, same_dispositions, retention) };
  if (!stat) report.detail = "dbstat unavailable";
  return report;
}

export interface VacuumResult {
  /** `freelist_count * page_size` before the `VACUUM`: the bytes it returned. */
  reclaimable: number;
}

/**
 * `VACUUM` the database (spec/store §7). Not a transaction's work — SQLite
 * refuses a VACUUM inside one — so it runs on the bare connection; returns the
 * free-page bytes measured before, which is what the file shrinks by.
 */
export function vacuum(store: Store): VacuumResult {
  const reclaimable = reclaimableBytes(store);
  store.db.exec("VACUUM");
  return { reclaimable };
}

/** `freelist_count * page_size`: the bytes a `VACUUM` would return now. */
export function reclaimableBytes(store: Store): number {
  const page_size = store.db.pragma("page_size", { simple: true }) as number;
  const freelist_count = store.db.pragma("freelist_count", { simple: true }) as number;
  return freelist_count * page_size;
}
