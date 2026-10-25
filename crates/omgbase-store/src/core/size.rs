//! The size report (`spec/store/README.md` §7 "Size", 14.1): what the
//! database is made of, table by table through SQLite's `dbstat` virtual
//! table, grouped into the four categories a reader reasons about — the live
//! state (`content`), the append-only record (`history`), the derived indexes
//! (`search`) and the workspace bookkeeping (`sync`) — plus the file's page
//! accounting, the deterministic advice `omg doctor --size` prints, and
//! `VACUUM`. The categorization is the spec's: every table of `schema.sql`
//! is assigned, an index counts toward its table, an FTS5 virtual table's
//! shadow tables fold into it, and anything the spec does not name
//! (`sqlite_schema`, `sqlite_stat1`, a table from a newer schema) is `sync`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::Connection;
use serde_json::{Map, Value as Json, json};

use crate::core::capabilities::HistoryRecorder;
use crate::error::Result;

/// The four categories, in the report's fixed order.
pub const SIZE_CATEGORIES: [&str; 4] = ["content", "history", "search", "sync"];

/// §7: the category of every table `schema.sql` creates.
// seam: the categories recast as content / identity / recovery / history /
// search / sync (Phase 3, D9 — `resurrection_pool` and
// `pending_materializations` are core, not history; inventory-rust.md §2.6
// `size.rs:24-57`, §6.9).
pub const TABLE_CATEGORY: &[(&str, &str)] = &[
    ("docs", "content"),
    ("blocks", "content"),
    ("sections", "content"),
    ("nodes", "content"),
    ("edges", "content"),
    ("doc_edges", "content"),
    ("inferred_edges", "content"),
    ("external_nodes", "content"),
    ("properties", "content"),
    ("collections", "content"),
    ("blobs", "history"),
    ("tree_nodes", "history"),
    ("revisions", "history"),
    ("commits", "history"),
    ("dispositions", "history"),
    ("block_changes", "history"),
    ("resurrection_pool", "history"),
    ("pending_materializations", "history"),
    ("archives", "history"),
    ("blocks_fts", "search"),
    ("nodes_fts", "search"),
    ("embeddings", "search"),
    ("doc_embeddings", "search"),
    ("repos", "sync"),
    ("sources", "sync"),
    ("adapters", "sync"),
    ("attachments", "sync"),
    ("checkpoints", "sync"),
    ("file_stats", "sync"),
    ("sync_state", "sync"),
    ("workspace_settings", "sync"),
];

/// The category of a table: the spec's assignment, `sync` for anything else.
#[must_use]
pub fn category_of(table: &str) -> &'static str {
    TABLE_CATEGORY
        .iter()
        .find(|(t, _)| *t == table)
        .map_or("sync", |(_, c)| c)
}

/// The advice thresholds (§7).
pub const VACUUM_ADVICE_MIN_BYTES: u64 = 1024 * 1024;
pub const VACUUM_ADVICE_MIN_SHARE: u64 = 10;
pub const HISTORY_ADVICE_MIN_SHARE: f64 = 50.0;
/// 14.2: `same` rows past this share of the `dispositions` table's rows.
pub const SAME_ADVICE_MIN_SHARE: u64 = 25;
/// 15.0: the retention advice fires when the plan's bytes exceed this share
/// of the `history` category's bytes.
pub const RETENTION_ADVICE_MIN_SHARE: u64 = 10;
pub const EMBEDDINGS_ADVICE_MIN_SHARE: f64 = 25.0;

/// `<n> B` under 1024, else one decimal of KB/MB/GB/TB (1024-based), the
/// tenths rounded half up — `4096` → `4.0 KB`, `13734297` → `13.1 MB`. Both
/// engines format from the integer tenths so the bytes never differ by a
/// rounding mode.
#[must_use]
pub fn human_bytes(n: u64) -> String {
    if n < 1024 {
        return format!("{n} B");
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    #[allow(clippy::cast_precision_loss)]
    let mut v = n as f64 / 1024.0;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let tenths = (v * 10.0).round() as u64;
    format!("{}.{} {}", tenths / 10, tenths % 10, UNITS[u])
}

/// A share as `<n>.<d>%` from its one-decimal value (`48.2` → `48.2%`, `50` → `50.0%`).
#[must_use]
pub fn format_share(share: f64) -> String {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let tenths = (share * 10.0).round() as u64;
    format!("{}.{}%", tenths / 10, tenths % 10)
}

/// `bytes / total` in percent, one decimal, rounded half up; 0 when the total is 0.
#[must_use]
#[allow(clippy::cast_precision_loss)]
pub fn share_of(bytes: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    ((bytes as f64 * 1000.0) / total as f64).round() / 10.0
}

/// One table of the report: its pages (indexes and shadow tables included).
#[derive(Clone, Debug, PartialEq)]
pub struct SizeTable {
    pub name: String,
    /// `None` without dbstat.
    pub bytes: Option<u64>,
    pub share: Option<f64>,
    pub rows: u64,
    /// The bytes of the table's indexes alone (included in `bytes`).
    pub indexes: Option<u64>,
}

/// One category: its tables by bytes desc then name (rows desc then name without dbstat).
#[derive(Clone, Debug, PartialEq)]
pub struct SizeCategory {
    pub name: &'static str,
    pub bytes: Option<u64>,
    pub share: Option<f64>,
    pub rows: u64,
    pub tables: Vec<SizeTable>,
}

/// The file's page accounting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SizeFile {
    pub path: String,
    /// The main file's bytes on disk (`page_count * page_size` in memory).
    pub bytes: u64,
    /// The `-wal` file's bytes on disk, 0 when absent.
    pub wal_bytes: u64,
    pub page_size: u64,
    pub page_count: u64,
    pub freelist_count: u64,
    /// `freelist_count * page_size`: what `VACUUM` returns to the filesystem.
    pub reclaimable: u64,
}

/// §7.2 (15.0): the history that already left the file.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SizeArchived {
    /// `revisions` rows whose bodies live in a segment (`archive IS NOT NULL`).
    pub revisions: u64,
    /// Recorded segments (`archives` rows).
    pub segments: u64,
    /// The recorded segments' bytes on disk (a missing file counts 0).
    pub bytes: u64,
}

/// What the retention policy would archive now (§7.1), summed over the
/// store's repositories.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SizeRetention {
    pub revisions: u64,
    pub bytes: u64,
}

/// The whole report.
#[derive(Clone, Debug, PartialEq)]
pub struct SizeReport {
    pub file: SizeFile,
    /// Always the four categories, in [`SIZE_CATEGORIES`] order.
    pub categories: Vec<SizeCategory>,
    /// §7 (14.2): `dispositions` rows with `kind = 'same'` — what a store
    /// through 14.1 wrote and `omg gc` removes; 0 on a fresh 14.2 store.
    pub same_dispositions: u64,
    /// §7.2 (15.0): archived revisions, recorded segments, their bytes on disk.
    pub archived: SizeArchived,
    pub advice: Vec<String>,
    /// `Some("dbstat unavailable")` when the SQLite build lacks the virtual table.
    pub detail: Option<&'static str>,
}

impl SizeReport {
    /// The JSON the CLI prints (`spec/cli` §6 `doctor --size --json`).
    #[must_use]
    pub fn to_json(&self) -> Json {
        let num = |n: Option<u64>| n.map_or(Json::Null, |v| json!(v));
        let share = |s: Option<f64>| s.map_or(Json::Null, |v| json!(v));
        let mut m = Map::new();
        m.insert(
            "file".into(),
            json!({
                "path": self.file.path,
                "bytes": self.file.bytes,
                "wal_bytes": self.file.wal_bytes,
                "page_size": self.file.page_size,
                "page_count": self.file.page_count,
                "freelist_count": self.file.freelist_count,
                "reclaimable": self.file.reclaimable,
            }),
        );
        m.insert(
            "categories".into(),
            Json::Array(
                self.categories
                    .iter()
                    .map(|c| {
                        json!({
                            "name": c.name,
                            "bytes": num(c.bytes),
                            "share": share(c.share),
                            "rows": c.rows,
                            "tables": c.tables.iter().map(|t| json!({
                                "name": t.name,
                                "bytes": num(t.bytes),
                                "share": share(t.share),
                                "rows": t.rows,
                                "indexes": num(t.indexes),
                            })).collect::<Vec<_>>(),
                        })
                    })
                    .collect(),
            ),
        );
        m.insert("same_dispositions".into(), json!(self.same_dispositions));
        m.insert(
            "archived".into(),
            json!({
                "revisions": self.archived.revisions,
                "segments": self.archived.segments,
                "bytes": self.archived.bytes,
            }),
        );
        m.insert("advice".into(), json!(self.advice));
        if let Some(d) = self.detail {
            m.insert("detail".into(), json!(d));
        }
        Json::Object(m)
    }
}

/// §7: the advice lines, in this order; `nothing to reclaim` when none applies.
/// `same_dispositions` (14.2) is the report's count of `same` rows;
/// `retention` (15.0) what the policy would archive now.
#[must_use]
pub fn size_advice(
    file: &SizeFile,
    categories: &[SizeCategory],
    same_dispositions: u64,
    retention: SizeRetention,
) -> Vec<String> {
    let mut advice = Vec::new();
    let logical = file.page_count * file.page_size;
    if file.reclaimable > VACUUM_ADVICE_MIN_BYTES
        && file.reclaimable * 100 > logical * VACUUM_ADVICE_MIN_SHARE
    {
        advice.push(format!(
            "run `omg gc --vacuum` to return {} of free pages to the filesystem",
            human_bytes(file.reclaimable)
        ));
    }
    let history = categories.iter().find(|c| c.name == "history");
    if let Some(share) = history
        .and_then(|c| c.share)
        .filter(|s| *s > HISTORY_ADVICE_MIN_SHARE)
    {
        advice.push(format!(
            "history dominates ({}): blobs, tree nodes and dispositions grow with every commit — enable gc (`omg config set gc.enabled true`) and run `omg gc --vacuum`",
            format_share(share)
        ));
    }
    // 14.2: `same` rows are what a 14.1 store wrote for every untouched block;
    // past a quarter of the table they are worth a sweep (the share is over
    // rows, so it holds with or without dbstat).
    let disposition_rows = history
        .and_then(|c| c.tables.iter().find(|t| t.name == "dispositions"))
        .map_or(0, |t| t.rows);
    if same_dispositions > 0 && same_dispositions * 100 > disposition_rows * SAME_ADVICE_MIN_SHARE {
        advice.push(format!(
            "{same_dispositions} same dispositions are history nothing reads (store 14.2): `omg gc` removes them, `--vacuum` reclaims the pages"
        ));
    }
    // 15.0: what the retention policy would move to a segment, when it is
    // worth a run — more than a tenth of the history category's pages (dbstat
    // only: the comparison needs the bytes).
    if retention.revisions > 0
        && let Some(history_bytes) = history.and_then(|c| c.bytes)
        && retention.bytes * 100 > history_bytes * RETENTION_ADVICE_MIN_SHARE
    {
        advice.push(format!(
            "{} revisions older than the policy would archive {}: `omg history export --prune`",
            retention.revisions,
            human_bytes(retention.bytes)
        ));
    }
    if let Some(search) = categories
        .iter()
        .find(|c| c.name == "search" && c.bytes.is_some())
    {
        let total: u64 = categories.iter().filter_map(|c| c.bytes).sum();
        let emb: u64 = search
            .tables
            .iter()
            .filter(|t| t.name == "embeddings" || t.name == "doc_embeddings")
            .filter_map(|t| t.bytes)
            .sum();
        let emb_share = share_of(emb, total);
        if emb_share > EMBEDDINGS_ADVICE_MIN_SHARE {
            advice.push(format!(
                "embeddings are {} of the database: a smaller model (`embedding.model` / `embedding.dim`) or `omg embed drain --prune` after a model switch shrinks them",
                format_share(emb_share)
            ));
        }
    }
    if advice.is_empty() {
        advice.push("nothing to reclaim".to_owned());
    }
    advice
}

fn pragma_u64(conn: &Connection, name: &str) -> Result<u64> {
    let v: i64 = conn.query_row(&format!("PRAGMA {name}"), [], |r| r.get(0))?;
    Ok(u64::try_from(v).unwrap_or(0))
}

/// `freelist_count * page_size`: the bytes a `VACUUM` would return now.
pub fn reclaimable_bytes(conn: &Connection) -> Result<u64> {
    Ok(pragma_u64(conn, "freelist_count")? * pragma_u64(conn, "page_size")?)
}

/// The `dbstat` bytes per b-tree name, or `None` when the build lacks the virtual table.
fn dbstat_bytes(conn: &Connection) -> Option<BTreeMap<String, u64>> {
    let mut stmt = conn
        .prepare("SELECT name, sum(pgsize) FROM dbstat GROUP BY name")
        .ok()?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .ok()?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (name, bytes) = row.ok()?;
        out.insert(name, u64::try_from(bytes).unwrap_or(0));
    }
    Some(out)
}

struct MasterRow {
    kind: String,
    name: String,
    tbl_name: String,
    virtual_table: bool,
}

fn file_bytes(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len())
}

/// The size report of an open connection (§7 "Size") at the wall clock.
pub fn size_report(conn: &Connection, history: Option<&dyn HistoryRecorder>) -> Result<SizeReport> {
    size_report_at(conn, history, &crate::time::now_ts())
}

/// The size report (§7 "Size") with the retention plans (15.0) evaluated at
/// `now` — the report is store-wide, the policy a repository's, so every
/// repository's plan under its effective policy is summed at one clock. The
/// history figures (the `same` rows, the archived summary, the plans) come
/// from the recorder ([`HistoryRecorder::size_figures`]); a store without
/// one reports them as zero.
pub fn size_report_at(
    conn: &Connection,
    history: Option<&dyn HistoryRecorder>,
    now: &str,
) -> Result<SizeReport> {
    let path = match conn.path() {
        Some(p) if !p.is_empty() => p.to_owned(),
        _ => ":memory:".to_owned(),
    };
    let page_size = pragma_u64(conn, "page_size")?;
    let page_count = pragma_u64(conn, "page_count")?;
    let freelist_count = pragma_u64(conn, "freelist_count")?;
    let on_disk = path != ":memory:";
    let file = SizeFile {
        bytes: if on_disk {
            file_bytes(Path::new(&path))
        } else {
            page_count * page_size
        },
        wal_bytes: if on_disk {
            file_bytes(Path::new(&format!("{path}-wal")))
        } else {
            0
        },
        path,
        page_size,
        page_count,
        freelist_count,
        reclaimable: freelist_count * page_size,
    };

    let master: Vec<MasterRow> = {
        let mut stmt = conn.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master")?;
        let rows = stmt.query_map([], |r| {
            let sql: Option<String> = r.get(3)?;
            Ok(MasterRow {
                kind: r.get(0)?,
                name: r.get(1)?,
                tbl_name: r.get(2)?,
                virtual_table: sql
                    .is_some_and(|s| s.to_ascii_uppercase().starts_with("CREATE VIRTUAL TABLE")),
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let virtuals: Vec<&str> = master
        .iter()
        .filter(|r| r.kind == "table" && r.virtual_table)
        .map(|r| r.name.as_str())
        .collect();
    // A shadow table (`blocks_fts_data`, …) folds into its virtual table.
    let owner_of = |name: &str| -> String {
        virtuals
            .iter()
            .find(|v| name.starts_with(&format!("{v}_")))
            .map_or_else(|| name.to_owned(), |v| (*v).to_owned())
    };
    let index_table = |name: &str| -> Option<&str> {
        master
            .iter()
            .find(|r| r.kind == "index" && r.name == name)
            .map(|r| r.tbl_name.as_str())
    };
    let stat = dbstat_bytes(conn);

    // Every table: sqlite_master's (shadow tables folded into their owner),
    // plus the schema table itself, which sqlite_master does not list but
    // dbstat does.
    let mut table_names: BTreeSet<String> = BTreeSet::new();
    table_names.insert("sqlite_schema".to_owned());
    for r in master.iter().filter(|r| r.kind == "table") {
        table_names.insert(owner_of(&r.name));
    }
    let mut table_bytes: BTreeMap<String, u64> = BTreeMap::new();
    let mut index_bytes: BTreeMap<String, u64> = BTreeMap::new();
    let mut total = 0u64;
    if let Some(stat) = &stat {
        for (name, bytes) in stat {
            total += bytes;
            if let Some(tbl) = index_table(name) {
                *index_bytes.entry(tbl.to_owned()).or_default() += bytes;
                *table_bytes.entry(tbl.to_owned()).or_default() += bytes;
            } else {
                let owner = owner_of(name);
                table_names.insert(owner.clone());
                *table_bytes.entry(owner).or_default() += bytes;
            }
        }
    }

    let count_rows = |name: &str| -> u64 {
        // An external-content FTS5 table answers `count(*)` from its content
        // table; the rows it indexes are its `_docsize` shadow's.
        let from = if virtuals.contains(&name) {
            format!("{name}_docsize")
        } else {
            name.to_owned()
        };
        let quoted = from.replace('"', "\"\"");
        conn.query_row(&format!("SELECT count(*) FROM \"{quoted}\""), [], |r| {
            r.get::<_, i64>(0)
        })
        .map_or(0, |n| u64::try_from(n).unwrap_or(0))
    };

    let mut categories: Vec<SizeCategory> = SIZE_CATEGORIES
        .iter()
        .map(|name| SizeCategory {
            name,
            bytes: None,
            share: None,
            rows: 0,
            tables: Vec::new(),
        })
        .collect();
    for name in &table_names {
        let bytes = stat
            .as_ref()
            .map(|_| table_bytes.get(name).copied().unwrap_or(0));
        let table = SizeTable {
            name: name.clone(),
            bytes,
            share: bytes.map(|b| share_of(b, total)),
            rows: count_rows(name),
            indexes: stat
                .as_ref()
                .map(|_| index_bytes.get(name).copied().unwrap_or(0)),
        };
        let cat = category_of(name);
        categories
            .iter_mut()
            .find(|c| c.name == cat)
            .expect("the four categories")
            .tables
            .push(table);
    }
    for c in &mut categories {
        c.tables.sort_by(|a, b| {
            b.bytes
                .unwrap_or(b.rows)
                .cmp(&a.bytes.unwrap_or(a.rows))
                .then_with(|| a.name.cmp(&b.name))
        });
        c.rows = c.tables.iter().map(|t| t.rows).sum();
        if stat.is_some() {
            let bytes: u64 = c.tables.iter().filter_map(|t| t.bytes).sum();
            c.bytes = Some(bytes);
            c.share = Some(share_of(bytes, total));
        }
    }

    let figures = match history {
        Some(h) => h.size_figures(conn, now)?,
        None => crate::core::capabilities::HistorySizeFigures::default(),
    };
    let same_dispositions = figures.same_dispositions;
    let archived = figures.archived;
    let retention = figures.retention;
    let advice = size_advice(&file, &categories, same_dispositions, retention);
    Ok(SizeReport {
        file,
        categories,
        same_dispositions,
        archived,
        advice,
        detail: stat.is_none().then_some("dbstat unavailable"),
    })
}

/// What a [`vacuum`] returned.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VacuumResult {
    /// `freelist_count * page_size` before the `VACUUM`: the bytes it returned.
    pub reclaimable: u64,
}

/// `VACUUM` the database (§7). Not a transaction's work — SQLite refuses a
/// VACUUM inside one — so it runs on the bare connection; returns the
/// free-page bytes measured before, which is what the file shrinks by.
pub fn vacuum(conn: &Connection) -> Result<VacuumResult> {
    let reclaimable = reclaimable_bytes(conn)?;
    conn.execute_batch("VACUUM")?;
    Ok(VacuumResult { reclaimable })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SCHEMA_SQL, SequentialMinter, Store};
    use omgbase_reconcile::Config;

    #[test]
    fn humanize_and_shares() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(4096), "4.0 KB");
        assert_eq!(human_bytes(1280), "1.3 KB");
        assert_eq!(human_bytes(13_734_297), "13.1 MB");
        assert_eq!(human_bytes(104_857_600), "100.0 MB");
        assert_eq!(human_bytes(1 << 30), "1.0 GB");
        assert_eq!(human_bytes(3 << 40), "3.0 TB");
        assert_eq!(human_bytes(1 << 50), "1024.0 TB");
        assert_eq!(format_share(48.2), "48.2%");
        assert_eq!(format_share(50.0), "50.0%");
        assert_eq!(format_share(0.0), "0.0%");
        assert_eq!(share_of(1, 3), 33.3);
        assert_eq!(share_of(1, 0), 0.0);
        assert_eq!(share_of(2, 4), 50.0);
    }

    #[test]
    fn every_schema_table_is_categorized() {
        let created: Vec<&str> = SCHEMA_SQL
            .lines()
            .filter_map(|l| {
                l.strip_prefix("CREATE TABLE IF NOT EXISTS ")
                    .or_else(|| l.strip_prefix("CREATE VIRTUAL TABLE IF NOT EXISTS "))
            })
            .map(|rest| {
                rest.split_whitespace()
                    .next()
                    .unwrap()
                    .trim_end_matches('(')
            })
            .collect();
        assert!(created.len() > 25, "{created:?}");
        let mut assigned: Vec<&str> = TABLE_CATEGORY.iter().map(|(t, _)| *t).collect();
        assigned.sort_unstable();
        let mut created_sorted = created.clone();
        created_sorted.sort_unstable();
        assert_eq!(assigned, created_sorted);
        assert_eq!(category_of("sqlite_schema"), "sync");
        assert_eq!(category_of("sqlite_stat1"), "sync");
        assert_eq!(category_of("blobs"), "history");
        assert_eq!(category_of("blocks_fts"), "search");
        assert_eq!(category_of("blocks"), "content");
    }

    fn file_of(over: impl FnOnce(&mut SizeFile)) -> SizeFile {
        let mut f = SizeFile {
            path: "x".into(),
            bytes: 0,
            wal_bytes: 0,
            page_size: 4096,
            page_count: 1000,
            freelist_count: 0,
            reclaimable: 0,
        };
        over(&mut f);
        f
    }

    fn cat(name: &'static str, bytes: u64, total: u64, tables: &[(&str, u64)]) -> SizeCategory {
        SizeCategory {
            name,
            bytes: Some(bytes),
            share: Some(share_of(bytes, total)),
            rows: 0,
            tables: tables
                .iter()
                .map(|(n, b)| SizeTable {
                    name: (*n).to_owned(),
                    bytes: Some(*b),
                    share: Some(share_of(*b, total)),
                    rows: 0,
                    indexes: Some(0),
                })
                .collect(),
        }
    }

    #[test]
    fn advice_rules() {
        let none = vec!["nothing to reclaim".to_owned()];
        assert_eq!(
            size_advice(
                &file_of(|_| {}),
                &[cat("content", 60, 100, &[]), cat("history", 40, 100, &[])],
                0,
                SizeRetention::default()
            ),
            none
        );
        // VACUUM: past 1 MiB AND 10 % of the pages.
        let small = file_of(|f| {
            f.freelist_count = 200;
            f.reclaimable = 200 * 4096;
        });
        assert_eq!(size_advice(&small, &[], 0, SizeRetention::default()), none);
        let thin = file_of(|f| {
            f.page_count = 100_000;
            f.freelist_count = 300;
            f.reclaimable = 300 * 4096;
        });
        assert_eq!(size_advice(&thin, &[], 0, SizeRetention::default()), none);
        let fat = file_of(|f| {
            f.freelist_count = 300;
            f.reclaimable = 300 * 4096;
        });
        assert_eq!(
            size_advice(&fat, &[], 0, SizeRetention::default()),
            vec!["run `omg gc --vacuum` to return 1.2 MB of free pages to the filesystem"]
        );
        // History past 50 %, embeddings past 25 %, in order.
        let cats = [
            cat("content", 13, 100, &[]),
            cat("history", 57, 100, &[]),
            cat("search", 30, 100, &[("embeddings", 26), ("blocks_fts", 4)]),
        ];
        assert_eq!(
            size_advice(&file_of(|_| {}), &cats, 0, SizeRetention::default()),
            vec![
                "history dominates (57.0%): blobs, tree nodes and dispositions grow with every commit — enable gc (`omg config set gc.enabled true`) and run `omg gc --vacuum`",
                "embeddings are 26.0% of the database: a smaller model (`embedding.model` / `embedding.dim`) or `omg embed drain --prune` after a model switch shrinks them",
            ]
        );
        // Exactly 50 / 25 do not fire; a blind (no dbstat) category never does.
        let edge = [
            cat("content", 25, 100, &[]),
            cat("history", 50, 100, &[]),
            cat("search", 25, 100, &[("embeddings", 25)]),
        ];
        assert_eq!(
            size_advice(&file_of(|_| {}), &edge, 0, SizeRetention::default()),
            none
        );
        let blind = SizeCategory {
            name: "history",
            bytes: None,
            share: None,
            rows: 9,
            tables: vec![],
        };
        assert_eq!(
            size_advice(&file_of(|_| {}), &[blind], 0, SizeRetention::default()),
            none
        );
    }

    /// 14.2: the `same` line fires past 25 % of the `dispositions` rows,
    /// ordered after the history line and before the embeddings line; the
    /// share is over rows, so a blind (no dbstat) history category counts.
    #[test]
    fn same_dispositions_advice() {
        let none = vec!["nothing to reclaim".to_owned()];
        let with_rows = |same: u64, rows: u64| {
            let mut history = cat("history", 57, 100, &[("dispositions", 10)]);
            history.tables[0].rows = rows;
            history.rows = rows;
            let cats = [
                cat("content", 13, 100, &[]),
                history,
                cat("search", 30, 100, &[("embeddings", 26)]),
            ];
            size_advice(&file_of(|_| {}), &cats, same, SizeRetention::default())
        };
        assert_eq!(
            with_rows(30, 100),
            vec![
                "history dominates (57.0%): blobs, tree nodes and dispositions grow with every commit — enable gc (`omg config set gc.enabled true`) and run `omg gc --vacuum`",
                "30 same dispositions are history nothing reads (store 14.2): `omg gc` removes them, `--vacuum` reclaims the pages",
                "embeddings are 26.0% of the database: a smaller model (`embedding.model` / `embedding.dim`) or `omg embed drain --prune` after a model switch shrinks them",
            ]
        );
        // Exactly 25 % does not fire; zero never does.
        assert_eq!(with_rows(25, 100).len(), 2);
        assert_eq!(with_rows(0, 100).len(), 2);
        // Without dbstat the row share still decides.
        let blind = SizeCategory {
            name: "history",
            bytes: None,
            share: None,
            rows: 8,
            tables: vec![SizeTable {
                name: "dispositions".into(),
                bytes: None,
                share: None,
                rows: 8,
                indexes: None,
            }],
        };
        assert_eq!(
            size_advice(
                &file_of(|_| {}),
                std::slice::from_ref(&blind),
                3,
                SizeRetention::default()
            ),
            vec![
                "3 same dispositions are history nothing reads (store 14.2): `omg gc` removes them, `--vacuum` reclaims the pages"
            ]
        );
        assert_eq!(
            size_advice(&file_of(|_| {}), &[blind], 2, SizeRetention::default()),
            none
        );
    }

    /// 15.0: the retention line fires when the plan's bytes exceed 10 % of
    /// the history category (dbstat only), after the `same` line and before
    /// the embeddings line.
    #[test]
    fn retention_advice() {
        let cats = [
            cat("content", 13, 100, &[]),
            cat("history", 57, 100, &[("blobs", 50)]),
            cat("search", 30, 100, &[("embeddings", 26)]),
        ];
        let lines = size_advice(
            &file_of(|_| {}),
            &cats,
            0,
            SizeRetention {
                revisions: 12,
                bytes: 6,
            },
        );
        assert_eq!(lines.len(), 3);
        assert_eq!(
            lines[1],
            "12 revisions older than the policy would archive 6 B: `omg history export --prune`"
        );
        // Exactly 10 % does not fire; no revisions never does; a blind history never does.
        assert_eq!(
            size_advice(
                &file_of(|_| {}),
                &cats,
                0,
                SizeRetention {
                    revisions: 1,
                    bytes: 5
                }
            )
            .len(),
            2
        );
        assert_eq!(
            size_advice(
                &file_of(|_| {}),
                &cats,
                0,
                SizeRetention {
                    revisions: 0,
                    bytes: 60
                }
            )
            .len(),
            2
        );
        let blind = SizeCategory {
            name: "history",
            bytes: None,
            share: None,
            rows: 9,
            tables: vec![],
        };
        assert_eq!(
            size_advice(
                &file_of(|_| {}),
                &[blind],
                0,
                SizeRetention {
                    revisions: 9,
                    bytes: 900
                }
            ),
            vec!["nothing to reclaim".to_owned()]
        );
    }

    fn observed_store() -> Store {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("t").unwrap();
        let ts = "2026-09-26T10:00:00.000Z";
        store
            .observe_one(
                &repo,
                "a.md",
                "# A\n\nbody one\n\nbody two\n",
                ts,
                &Config::default(),
            )
            .unwrap();
        store
            .observe_one(
                &repo,
                "b.md",
                "# B\n\n- [ ] a task [link](a.md)\n",
                ts,
                &Config::default(),
            )
            .unwrap();
        store
    }

    #[test]
    fn report_measures_every_table_and_folds_indexes_and_shadows() {
        let store = observed_store();
        let r = store.size_report().unwrap();
        assert_eq!(r.detail, None, "the bundled SQLite has dbstat");
        assert_eq!(r.file.path, ":memory:");
        assert_eq!(r.file.bytes, r.file.page_count * r.file.page_size);
        assert_eq!(r.file.reclaimable, r.file.freelist_count * r.file.page_size);
        let names: Vec<&str> = r.categories.iter().map(|c| c.name).collect();
        assert_eq!(names, SIZE_CATEGORIES);
        let all: Vec<&SizeTable> = r.categories.iter().flat_map(|c| &c.tables).collect();
        assert!(all.iter().any(|t| t.name == "blocks_fts"));
        assert!(all.iter().any(|t| t.name == "sqlite_schema"));
        assert!(!all.iter().any(|t| {
            t.name.ends_with("_data")
                || t.name.ends_with("_docsize")
                || t.name.starts_with("idx_")
                || t.name.starts_with("sqlite_autoindex")
        }));
        for t in &all {
            assert_eq!(t.bytes.unwrap() % r.file.page_size, 0, "{}", t.name);
            assert!(t.indexes.unwrap() <= t.bytes.unwrap());
        }
        let blocks = all.iter().find(|t| t.name == "blocks").unwrap();
        assert!(blocks.indexes.unwrap() > 0);
        let n: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM blocks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(blocks.rows, u64::try_from(n).unwrap());
        let fts = all.iter().find(|t| t.name == "blocks_fts").unwrap();
        let docsize: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM blocks_fts_docsize", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fts.rows, u64::try_from(docsize).unwrap());
        assert!(fts.rows > 0);
        let total: i64 = store
            .conn()
            .query_row("SELECT sum(pgsize) FROM dbstat", [], |r| r.get(0))
            .unwrap();
        let sum: u64 = r.categories.iter().map(|c| c.bytes.unwrap()).sum();
        assert_eq!(sum, u64::try_from(total).unwrap());
        let shares: f64 = r.categories.iter().map(|c| c.share.unwrap()).sum();
        assert!((shares - 100.0).abs() < 0.3, "{shares}");
        for c in &r.categories {
            assert_eq!(c.rows, c.tables.iter().map(|t| t.rows).sum::<u64>());
            let mut sorted = c.tables.clone();
            sorted.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
            assert_eq!(c.tables, sorted);
        }
        assert_eq!(r.same_dispositions, 0, "a 14.2 store writes no `same` row");
        assert_eq!(r.advice, vec!["nothing to reclaim"]);
        // The JSON shape the CLI prints: `same_dispositions` between the
        // categories and the advice (spec/cli §6).
        let j = r.to_json();
        assert_eq!(j["file"]["page_size"], json!(r.file.page_size));
        assert_eq!(j["same_dispositions"], json!(0));
        let keys: Vec<&String> = j.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "file",
                "categories",
                "same_dispositions",
                "archived",
                "advice"
            ]
        );
        assert_eq!(
            j["archived"],
            json!({ "revisions": 0, "segments": 0, "bytes": 0 })
        );
        assert_eq!(j["categories"][0]["name"], json!("content"));
        assert_eq!(j["categories"][0]["tables"][0]["name"], json!("blocks"));
        assert!(j.get("detail").is_none());
    }

    #[test]
    fn vacuum_returns_the_free_pages() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("t").unwrap();
        let body: String = (0..200)
            .map(|i| format!("paragraph {i} with some words to fill a page or two"))
            .collect::<Vec<_>>()
            .join("\n\n");
        store
            .observe_one(
                &repo,
                "a.md",
                &format!("# A\n\n{body}\n"),
                "2026-09-26T10:00:00.000Z",
                &Config::default(),
            )
            .unwrap();
        store
            .conn()
            .execute_batch(
                "DELETE FROM block_changes; DELETE FROM dispositions; DELETE FROM sections;",
            )
            .unwrap();
        let before = store.size_report().unwrap().file;
        assert!(before.freelist_count > 0);
        let res = store.vacuum().unwrap();
        assert_eq!(res.reclaimable, before.reclaimable);
        let after = store.size_report().unwrap().file;
        assert_eq!(after.freelist_count, 0);
        assert!(after.page_count < before.page_count);
        let n: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM blocks", [], |r| r.get(0))
            .unwrap();
        assert!(n > 200);
        let ok: String = store
            .conn()
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ok, "ok");
        assert_eq!(store.vacuum().unwrap().reclaimable, 0);
    }
}
