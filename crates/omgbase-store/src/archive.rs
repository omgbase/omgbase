//! Archive segments (`spec/store/README.md` §7.1 "Retention: plan, export,
//! squash", §6.2 "Through a segment", 15.0). Port of
//! `packages/core/src/core/store/archive.ts`.
//!
//! A segment is ONE SQLite file per `history export`, never appended: the
//! bodies (blobs, tree nodes) of the revisions the policy archived,
//! self-contained, plus copies of their `revisions`/`commits` rows, the
//! `dispositions` and `block_changes` of the commits that are wholly archived,
//! and one `manifest` row ([`ARCHIVE_SQL`] = `spec/store/archive.sql`,
//! embedded verbatim). The main store then SQUASHES in one transaction: an
//! archived revision keeps its row (id, doc, seq, path, rendered hash, commit
//! — so the `revisions` target, `docs_history` and `changes_since` keep
//! listing it) and loses `root_tree` and `frontmatter_blob`, gaining
//! `archive` = the segment id; the wholly archived commits' dispositions go,
//! their block_changes go except each block's EARLIEST row (the mint oracle of
//! §2.1 reads `block_changes`, so a minted id stays known); the GC sweep
//! reclaims the bodies now reachable from nothing; the segment is recorded in
//! `archives`. Two phases on purpose: the file is complete and durable before
//! a single row of the store moves, and a crash between the phases leaves a
//! complete, unrecorded segment that the next run finds and finishes (the
//! crash rule).
//!
//! Reading an archived revision ATTACHes its segment on demand (one alias per
//! segment, `arc_<id>`, read-only by construction — the file is written with
//! mode 0444 and the engine never writes through an alias). The attached
//! aliases are the connection's own state (`PRAGMA database_list`), so every
//! read over a `&Connection` finds them; past eight the oldest is detached.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use omgbase_format::hash::hex;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Map, Value as Json};

use crate::derived::sweep_unreachable;
use crate::error::{Error, Result};
use crate::mint::Mint;
use crate::retention::{
    LAST_SEGMENT_SETTINGS_KEY, RETENTION_SETTINGS_KEY, ReachMarker, RetentionOptions,
    RetentionPlan, RevBodies, evaluate_retention, repo_settings,
};
pub use crate::schema::ARCHIVE_SQL;
use crate::schema::SCHEMA_VERSION;
use crate::tree::from_hex;

/// The file suffix every segment carries.
pub const ARCHIVE_SUFFIX: &str = ".omgarchive.db";
/// The default directory under `.omgbase/`.
pub const ARCHIVE_DIR: &str = "archives";
/// The suffix of a segment still being written (never a complete segment).
const PARTIAL_SUFFIX: &str = ".partial";
/// How many segments stay attached to one connection (SQLite's default cap is 10).
const MAX_ATTACHED: usize = 8;

/// `<repo_id>-<seq_lo>-<seq_hi>-<segment_id>.omgarchive.db`
#[must_use]
pub fn segment_file_name(repo_id: &str, seq_lo: i64, seq_hi: i64, segment_id: &str) -> String {
    format!("{repo_id}-{seq_lo}-{seq_hi}-{segment_id}{ARCHIVE_SUFFIX}")
}

/// The parts a segment file name carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentName {
    pub repo_id: String,
    pub seq_lo: i64,
    pub seq_hi: i64,
    pub segment_id: String,
}

/// The parts of a segment file name, or `None` when the name is not one
/// (`^([a-z]+_[0-9a-z]+)-(\d+)-(\d+)-([a-z]+_[0-9a-z]+)\.omgarchive\.db$`).
#[must_use]
pub fn parse_segment_file_name(name: &str) -> Option<SegmentName> {
    let stem = name.strip_suffix(ARCHIVE_SUFFIX)?;
    let is_id = |s: &str| {
        let (p, rest) = s.split_once('_')?;
        (!p.is_empty()
            && p.bytes().all(|b| b.is_ascii_lowercase())
            && !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase()))
        .then_some(())
    };
    let is_num = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    // The ids may carry a `-`-free body only, so split on `-` is exact.
    let parts: Vec<&str> = stem.split('-').collect();
    if parts.len() != 4 {
        return None;
    }
    is_id(parts[0])?;
    is_id(parts[3])?;
    if !is_num(parts[1]) || !is_num(parts[2]) {
        return None;
    }
    Some(SegmentName {
        repo_id: parts[0].to_owned(),
        seq_lo: parts[1].parse().ok()?,
        seq_hi: parts[2].parse().ok()?,
        segment_id: parts[3].to_owned(),
    })
}

/// A segment's `manifest` row.
#[derive(Clone, Debug, PartialEq)]
pub struct Manifest {
    pub segment_id: String,
    pub repo_id: String,
    pub created_at: String,
    pub policy: Json,
    pub seq_lo: i64,
    pub seq_hi: i64,
    pub revision_count: i64,
    pub previous_segment: Option<String>,
    pub schema_user_version: i64,
}

fn not_a_segment(path: &Path, detail: &str) -> Error {
    Error::NotASegment {
        path: path.to_string_lossy().into_owned(),
        detail: detail.to_owned(),
    }
}

fn open_read_only(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

/// Open a segment read-only and return its manifest; [`Error::NotASegment`]
/// when the file is not one.
pub fn read_manifest(path: &Path) -> Result<Manifest> {
    if !path.exists() {
        return Err(not_a_segment(path, "no such file"));
    }
    let read = || -> rusqlite::Result<Option<Manifest>> {
        let db = open_read_only(path)?;
        let row = db
            .query_row(
                "SELECT segment_id, repo_id, created_at, policy, seq_lo, seq_hi, revision_count, previous_segment, schema_user_version FROM manifest",
                [],
                |r| {
                    let policy: String = r.get(3)?;
                    Ok(Manifest {
                        segment_id: r.get(0)?,
                        repo_id: r.get(1)?,
                        created_at: r.get(2)?,
                        policy: serde_json::from_str(&policy).unwrap_or(Json::Null),
                        seq_lo: r.get(4)?,
                        seq_hi: r.get(5)?,
                        revision_count: r.get(6)?,
                        previous_segment: r.get(7)?,
                        schema_user_version: r.get(8)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    };
    match read() {
        Ok(Some(m)) => Ok(m),
        Ok(None) => Err(not_a_segment(path, "no manifest row")),
        Err(_) => Err(not_a_segment(path, "not an archive segment")),
    }
}

/// The revision ids a segment holds, in `(doc_id, seq)` order.
fn segment_revision_ids(path: &Path) -> Result<Vec<String>> {
    let db = open_read_only(path).map_err(|_| not_a_segment(path, "not an archive segment"))?;
    let mut stmt = db
        .prepare("SELECT rev_id FROM revisions ORDER BY doc_id, seq")
        .map_err(|_| not_a_segment(path, "not an archive segment"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

// ---- the registry ------------------------------------------------------------------

/// An `archives` row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveRow {
    pub segment_id: String,
    pub repo_id: String,
    pub path: String,
    pub seq_lo: i64,
    pub seq_hi: i64,
    pub created_at: String,
    pub revision_count: i64,
    pub bytes: i64,
}

fn archive_row(conn: &Connection, segment_id: &str) -> Result<Option<ArchiveRow>> {
    Ok(conn
        .query_row(
            "SELECT segment_id, repo_id, path, seq_lo, seq_hi, created_at, revision_count, bytes FROM archives WHERE segment_id = ?1",
            params![segment_id],
            |r| {
                Ok(ArchiveRow {
                    segment_id: r.get(0)?,
                    repo_id: r.get(1)?,
                    path: r.get(2)?,
                    seq_lo: r.get(3)?,
                    seq_hi: r.get(4)?,
                    created_at: r.get(5)?,
                    revision_count: r.get(6)?,
                    bytes: r.get(7)?,
                })
            },
        )
        .optional()?)
}

fn record_archive(conn: &Connection, row: &ArchiveRow) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO archives (segment_id, repo_id, path, seq_lo, seq_hi, created_at, revision_count, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            row.segment_id,
            row.repo_id,
            row.path,
            row.seq_lo,
            row.seq_hi,
            row.created_at,
            row.revision_count,
            row.bytes
        ],
    )?;
    Ok(())
}

/// A file's size on disk; 0 when it cannot be read.
#[must_use]
pub fn file_bytes(path: &Path) -> i64 {
    std::fs::metadata(path).map_or(0, |m| i64::try_from(m.len()).unwrap_or(i64::MAX))
}

/// One segment `attach` recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachedSegment {
    pub segment_id: String,
    pub path: String,
    pub seq_lo: i64,
    pub seq_hi: i64,
    pub revision_count: i64,
    pub bytes: i64,
}

/// `attach`'s result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachResult {
    pub attached: Vec<AttachedSegment>,
    /// Files in a directory that are not this repository's segments.
    pub skipped: usize,
}

/// `omg history attach <file|dir>` (§7.1 "Attach / detach"): record a segment
/// (idempotent — a known segment's path is re-recorded) or every
/// `.omgarchive.db` of a directory whose manifest `repo_id` is this
/// repository's. A single file of another repository or a non-segment is
/// [`Error::NotASegment`]; in a directory they are skipped.
pub fn attach_archive(conn: &Connection, repo_id: &str, target: &Path) -> Result<AttachResult> {
    let mut attached = Vec::new();
    let mut skipped = 0usize;
    let mut one = |file: &Path, strict: bool| -> Result<()> {
        let manifest = match read_manifest(file) {
            Ok(m) => m,
            Err(e) => {
                if strict {
                    return Err(e);
                }
                skipped += 1;
                return Ok(());
            }
        };
        if manifest.repo_id != repo_id {
            if strict {
                return Err(not_a_segment(
                    file,
                    &format!(
                        "a segment of repository {}, not {repo_id}",
                        manifest.repo_id
                    ),
                ));
            }
            skipped += 1;
            return Ok(());
        }
        let row = ArchiveRow {
            segment_id: manifest.segment_id.clone(),
            repo_id: repo_id.to_owned(),
            path: file.to_string_lossy().into_owned(),
            seq_lo: manifest.seq_lo,
            seq_hi: manifest.seq_hi,
            created_at: manifest.created_at,
            revision_count: manifest.revision_count,
            bytes: file_bytes(file),
        };
        // A re-attached segment may have moved: drop a stale alias so the
        // next read re-attaches.
        detach_alias(conn, &manifest.segment_id)?;
        record_archive(conn, &row)?;
        attached.push(AttachedSegment {
            segment_id: row.segment_id,
            path: row.path,
            seq_lo: row.seq_lo,
            seq_hi: row.seq_hi,
            revision_count: row.revision_count,
            bytes: row.bytes,
        });
        Ok(())
    };
    if target.is_dir() {
        let mut names: Vec<String> = std::fs::read_dir(target)
            .map_err(|e| Error::Other(format!("cannot read {}: {e}", target.display())))?
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|n| n.ends_with(ARCHIVE_SUFFIX))
            .collect();
        names.sort();
        for name in names {
            one(&target.join(name), false)?;
        }
    } else {
        one(target, true)?;
    }
    Ok(AttachResult { attached, skipped })
}

/// `omg history detach <segment_id|path>`: forget a segment. The revisions it
/// holds keep their `archive` pointer; reading one is `revision_archived`
/// until the segment is attached again. Returns the id, or `None` when
/// nothing matched.
pub fn detach_archive(conn: &Connection, repo_id: &str, r: &str) -> Result<Option<String>> {
    let by_id: Option<String> = conn
        .query_row(
            "SELECT segment_id FROM archives WHERE repo_id = ?1 AND segment_id = ?2",
            params![repo_id, r],
            |row| row.get(0),
        )
        .optional()?;
    let id = match by_id {
        Some(id) => Some(id),
        None => conn
            .query_row(
                "SELECT segment_id FROM archives WHERE repo_id = ?1 AND path = ?2",
                params![repo_id, r],
                |row| row.get::<_, String>(0),
            )
            .optional()?,
    };
    let Some(id) = id else {
        return Ok(None);
    };
    detach_alias(conn, &id)?;
    conn.execute("DELETE FROM archives WHERE segment_id = ?1", params![id])?;
    Ok(Some(id))
}

/// A segment's state (§7.1): recorded and on disk (`attached`), recorded but
/// not on disk (`missing`); or unrecorded under the archives directory —
/// `pending` (complete, its revisions still live: the crash rule finishes it
/// on the next `export --prune`), `detached` (complete and squashed: `attach`
/// brings it back), `stale` (some of its revisions live, some not: it belongs
/// to another store or predates a different squash).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveState {
    Attached,
    Missing,
    Pending,
    Detached,
    Stale,
}

impl ArchiveState {
    /// The wire spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            ArchiveState::Attached => "attached",
            ArchiveState::Missing => "missing",
            ArchiveState::Pending => "pending",
            ArchiveState::Detached => "detached",
            ArchiveState::Stale => "stale",
        }
    }
}

/// One line of `omg history list`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveListing {
    pub segment_id: String,
    pub path: String,
    pub seq_lo: i64,
    pub seq_hi: i64,
    pub revision_count: i64,
    pub bytes: i64,
    pub created_at: String,
    pub state: ArchiveState,
}

impl ArchiveListing {
    /// The `--json` row (`spec/cli` §6 `history list`).
    #[must_use]
    pub fn to_json(&self) -> Json {
        serde_json::json!({
            "segment_id": self.segment_id,
            "path": self.path,
            "seq_lo": self.seq_lo,
            "seq_hi": self.seq_hi,
            "revision_count": self.revision_count,
            "bytes": self.bytes,
            "created_at": self.created_at,
            "state": self.state.as_str(),
        })
    }
}

/// `omg history list`: the repository's recorded segments by `seq_lo` then
/// id, followed by the unrecorded complete segments found in `dest`, by file
/// name.
pub fn list_archives(
    conn: &Connection,
    repo_id: &str,
    dest: Option<&Path>,
) -> Result<Vec<ArchiveListing>> {
    let rows: Vec<ArchiveRow> = {
        let mut stmt = conn.prepare(
            "SELECT segment_id, repo_id, path, seq_lo, seq_hi, created_at, revision_count, bytes FROM archives WHERE repo_id = ?1 ORDER BY seq_lo, segment_id",
        )?;
        let it = stmt.query_map(params![repo_id], |r| {
            Ok(ArchiveRow {
                segment_id: r.get(0)?,
                repo_id: r.get(1)?,
                path: r.get(2)?,
                seq_lo: r.get(3)?,
                seq_hi: r.get(4)?,
                created_at: r.get(5)?,
                revision_count: r.get(6)?,
                bytes: r.get(7)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut out: Vec<ArchiveListing> = rows
        .into_iter()
        .map(|r| {
            let state = if Path::new(&r.path).exists() {
                ArchiveState::Attached
            } else {
                ArchiveState::Missing
            };
            ArchiveListing {
                segment_id: r.segment_id,
                path: r.path,
                seq_lo: r.seq_lo,
                seq_hi: r.seq_hi,
                revision_count: r.revision_count,
                bytes: r.bytes,
                created_at: r.created_at,
                state,
            }
        })
        .collect();
    if let Some(dest) = dest {
        for u in unrecorded_segments(conn, repo_id, dest)? {
            let m = read_manifest(&u.path)?;
            out.push(ArchiveListing {
                segment_id: m.segment_id,
                path: u.path.to_string_lossy().into_owned(),
                seq_lo: m.seq_lo,
                seq_hi: m.seq_hi,
                revision_count: m.revision_count,
                bytes: file_bytes(&u.path),
                created_at: m.created_at,
                state: u.state,
            });
        }
    }
    Ok(out)
}

/// A complete segment under the archives directory that no `archives` row records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnrecordedSegment {
    pub path: PathBuf,
    /// `Pending`, `Detached` or `Stale`.
    pub state: ArchiveState,
}

/// The complete segments of this repository under `dest` that no `archives`
/// row records, by file name, each classified by its revisions: all live →
/// `pending` (the crash rule's input), all archived → `detached`, else `stale`.
pub fn unrecorded_segments(
    conn: &Connection,
    repo_id: &str,
    dest: &Path,
) -> Result<Vec<UnrecordedSegment>> {
    if !dest.exists() {
        return Ok(Vec::new());
    }
    let known: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT segment_id FROM archives")?;
        let it = stmt.query_map([], |r| r.get::<_, String>(0))?;
        it.collect::<std::result::Result<HashSet<_>, _>>()?
    };
    let mut names: Vec<String> = std::fs::read_dir(dest)
        .map_err(|e| Error::Other(format!("cannot read {}: {e}", dest.display())))?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter(|name| {
            parse_segment_file_name(name)
                .is_some_and(|p| p.repo_id == repo_id && !known.contains(&p.segment_id))
        })
        .collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let path = dest.join(&name);
        let (mut live, mut archived) = (0usize, 0usize);
        for id in segment_revision_ids(&path)? {
            let row: Option<Option<String>> = conn
                .query_row(
                    "SELECT archive FROM revisions WHERE rev_id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?;
            match row {
                Some(None) => live += 1,
                _ => archived += 1,
            }
        }
        let state = if archived == 0 {
            ArchiveState::Pending
        } else if live == 0 {
            ArchiveState::Detached
        } else {
            ArchiveState::Stale
        };
        out.push(UnrecordedSegment { path, state });
    }
    Ok(out)
}

// ---- reading through a segment -----------------------------------------------------------

/// The alias a segment is attached under: `arc_<segment_id>` (every
/// character outside `[A-Za-z0-9_]` becomes `_`).
#[must_use]
pub fn archive_alias(segment_id: &str) -> String {
    let body: String = segment_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("arc_{body}")
}

/// The archive aliases attached to the connection, in attach order.
fn attached_aliases(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA database_list")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    let mut out = Vec::new();
    for name in rows {
        let name = name?;
        if name.starts_with("arc_") {
            out.push(name);
        }
    }
    Ok(out)
}

fn detach_alias(conn: &Connection, segment_id: &str) -> Result<()> {
    let alias = archive_alias(segment_id);
    if attached_aliases(conn)?.contains(&alias) {
        // Already gone with the connection, or inside a transaction: either
        // way the next read decides afresh.
        let _ = conn.execute_batch(&format!("DETACH DATABASE {alias}"));
    }
    Ok(())
}

/// The table prefix a revision's bodies are read under: `""` for a live
/// revision, `"<alias>."` for an archived one whose segment is attached on
/// demand (and verified to be the segment it claims). [`Error::RevisionArchived`]
/// when the segment is not recorded or not on disk.
pub fn archive_prefix(conn: &Connection, rev_id: &str, archive: Option<&str>) -> Result<String> {
    let Some(archive) = archive else {
        return Ok(String::new());
    };
    let alias = archive_alias(archive);
    let attached = attached_aliases(conn)?;
    if attached.contains(&alias) {
        return Ok(format!("{alias}."));
    }
    let Some(row) = archive_row(conn, archive)? else {
        return Err(Error::RevisionArchived {
            rev: rev_id.to_owned(),
            archive: archive.to_owned(),
            path: None,
        });
    };
    if !Path::new(&row.path).exists() {
        return Err(Error::RevisionArchived {
            rev: rev_id.to_owned(),
            archive: archive.to_owned(),
            path: Some(row.path),
        });
    }
    if attached.len() >= MAX_ATTACHED {
        if let Some(oldest) = attached.first() {
            let _ = conn.execute_batch(&format!("DETACH DATABASE {oldest}"));
        }
    }
    conn.execute(&format!("ATTACH DATABASE ?1 AS {alias}"), params![row.path])?;
    let claims: Option<String> = conn
        .query_row(
            &format!("SELECT segment_id FROM {alias}.manifest"),
            [],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None);
    if claims.as_deref() != Some(archive) {
        let _ = conn.execute_batch(&format!("DETACH DATABASE {alias}"));
        return Err(Error::RevisionArchived {
            rev: rev_id.to_owned(),
            archive: archive.to_owned(),
            path: Some(row.path),
        });
    }
    Ok(format!("{alias}."))
}

/// A revision's row with its bodies resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevisionBody {
    pub rev_id: String,
    pub doc_id: String,
    pub path: String,
    pub rendered_hash: Vec<u8>,
    pub root_tree: Vec<u8>,
    pub frontmatter_blob: Option<Vec<u8>>,
    /// `""` or `"<alias>."` — where `tree_nodes` and `blobs` for this revision live.
    pub prefix: String,
    pub archived: bool,
}

/// A revision's row with its bodies resolved: a live revision's from the
/// store, an archived one's from its segment (attached on demand). `None`
/// when `rev_id` is not a revision (of `doc_id`, when given);
/// [`Error::RevisionArchived`] when its segment is unavailable.
pub fn revision_body(
    conn: &Connection,
    rev_id: &str,
    doc_id: Option<&str>,
) -> Result<Option<RevisionBody>> {
    type Row = (
        String,
        String,
        String,
        Vec<u8>,
        Option<Vec<u8>>,
        Option<Vec<u8>>,
        Option<String>,
    );
    let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Row> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
        ))
    };
    const COLS: &str = "rev_id, doc_id, path, rendered_hash, root_tree, frontmatter_blob, archive";
    let row: Option<Row> = match doc_id {
        Some(d) => conn
            .query_row(
                &format!("SELECT {COLS} FROM revisions WHERE rev_id = ?1 AND doc_id = ?2"),
                params![rev_id, d],
                map,
            )
            .optional()?,
        None => conn
            .query_row(
                &format!("SELECT {COLS} FROM revisions WHERE rev_id = ?1"),
                params![rev_id],
                map,
            )
            .optional()?,
    };
    let Some((rev_id, doc_id, path, rendered_hash, root_tree, frontmatter_blob, archive)) = row
    else {
        return Ok(None);
    };
    let Some(archive) = archive else {
        return Ok(Some(RevisionBody {
            rev_id,
            doc_id,
            path,
            rendered_hash,
            root_tree: root_tree.unwrap_or_default(),
            frontmatter_blob,
            prefix: String::new(),
            archived: false,
        }));
    };
    let prefix = archive_prefix(conn, &rev_id, Some(&archive))?;
    let body: Option<(Vec<u8>, Option<Vec<u8>>)> = conn
        .query_row(
            &format!("SELECT root_tree, frontmatter_blob FROM {prefix}revisions WHERE rev_id = ?1"),
            params![rev_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((root_tree, frontmatter_blob)) = body else {
        return Err(Error::RevisionArchived {
            path: archive_row(conn, &archive)?.map(|r| r.path),
            rev: rev_id,
            archive,
        });
    };
    Ok(Some(RevisionBody {
        rev_id,
        doc_id,
        path,
        rendered_hash,
        root_tree,
        frontmatter_blob,
        prefix,
        archived: true,
    }))
}

// ---- export: write a segment, then squash -------------------------------------------------

/// The segment an export wrote (or finished).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentInfo {
    pub id: String,
    pub path: String,
    pub seq_lo: i64,
    pub seq_hi: i64,
    pub created_at: String,
    pub revision_count: i64,
    /// The file's size on disk.
    pub bytes: i64,
    pub previous_segment: Option<String>,
}

impl SegmentInfo {
    /// The `--json` shape (`spec/cli` §6 `history export`).
    #[must_use]
    pub fn to_json(&self) -> Json {
        serde_json::json!({
            "id": self.id,
            "path": self.path,
            "seq_lo": self.seq_lo,
            "seq_hi": self.seq_hi,
            "created_at": self.created_at,
            "revision_count": self.revision_count,
            "bytes": self.bytes,
            "previous_segment": self.previous_segment,
        })
    }
}

/// What the squash changed (rows).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SquashResult {
    pub revisions: usize,
    /// Commits every revision of which is archived: their dispositions and block changes moved.
    pub commits: usize,
    pub dispositions: usize,
    /// The `block_changes` rows deleted.
    pub block_changes: usize,
}

/// What the squash's sweep reclaimed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SweptBodies {
    pub blobs: usize,
    pub tree_nodes: usize,
}

/// `history export`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct ExportResult {
    pub plan: RetentionPlan,
    /// `None` when nothing was to archive (no file written).
    pub segment: Option<SegmentInfo>,
    /// An unrecorded complete segment was finished instead of writing a new one (the crash rule).
    pub reused: bool,
    /// `None` without `prune`.
    pub squashed: Option<SquashResult>,
    /// `None` without `prune`.
    pub gc: Option<SweptBodies>,
}

/// What [`export_history`] runs under.
#[derive(Clone, Debug)]
pub struct ExportOptions {
    pub retention: RetentionOptions,
    /// The directory the segment is written to (created when missing).
    pub dest: PathBuf,
    /// Squash the store after the segment is durable.
    pub prune: bool,
}

/// The commits of `rev_ids` every revision of which is in `rev_ids` or already
/// archived — whose change rows move with the bodies. Sorted by id.
fn wholly_archived_commits(conn: &Connection, rev_ids: &HashSet<String>) -> Result<Vec<String>> {
    let mut commits: BTreeSet<String> = BTreeSet::new();
    for id in rev_ids {
        let c: Option<String> = conn
            .query_row(
                "SELECT commit_id FROM revisions WHERE rev_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(c) = c {
            commits.insert(c);
        }
    }
    let mut out = Vec::new();
    let mut stmt = conn.prepare("SELECT rev_id, archive FROM revisions WHERE commit_id = ?1")?;
    for c in commits {
        let revs = stmt
            .query_map(params![c], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if revs
            .iter()
            .all(|(id, archive)| archive.is_some() || rev_ids.contains(id))
        {
            out.push(c);
        }
    }
    Ok(out)
}

fn last_segment(conn: &Connection, repo_id: &str) -> Result<Option<String>> {
    let settings = repo_settings(conn, repo_id)?;
    Ok(settings
        .get(RETENTION_SETTINGS_KEY)
        .and_then(Json::as_object)
        .and_then(|h| h.get(LAST_SEGMENT_SETTINGS_KEY))
        .and_then(Json::as_str)
        .map(str::to_owned))
}

fn set_last_segment(conn: &Connection, repo_id: &str, segment_id: &str) -> Result<()> {
    let mut settings = repo_settings(conn, repo_id)?;
    let mut history: Map<String, Json> = match settings.get(RETENTION_SETTINGS_KEY) {
        Some(Json::Object(h)) => h.clone(),
        _ => Map::new(),
    };
    history.insert(
        LAST_SEGMENT_SETTINGS_KEY.to_owned(),
        Json::String(segment_id.to_owned()),
    );
    settings.insert(RETENTION_SETTINGS_KEY.to_owned(), Json::Object(history));
    conn.execute(
        "UPDATE repos SET settings = ?1 WHERE repo_id = ?2",
        params![Json::Object(settings).to_string(), repo_id],
    )?;
    Ok(())
}

type RevisionRow = (
    String,
    String,
    i64,
    Vec<u8>,
    Option<Vec<u8>>,
    Vec<u8>,
    String,
    String,
);

/// Phase 1: write the segment for `rev_ids` to `dest`, durably — into a
/// `.partial` file, `synchronous = FULL`, one transaction, closed, made
/// read-only, then renamed to its final name, so a complete segment is
/// exactly a file with the final name.
fn write_segment(
    conn: &Connection,
    minter: &mut Mint<'_>,
    repo_id: &str,
    rev_ids: &[String],
    plan: &RetentionPlan,
    dest: &Path,
) -> Result<SegmentInfo> {
    let mut rev_stmt = conn.prepare(
        "SELECT rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id FROM revisions WHERE rev_id = ?1",
    )?;
    let mut revisions: Vec<RevisionRow> = Vec::with_capacity(rev_ids.len());
    for id in rev_ids {
        let row: Option<RevisionRow> = rev_stmt
            .query_row(params![id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            })
            .optional()?;
        if let Some(row) = row {
            revisions.push(row);
        }
    }
    let mut commit_ids: Vec<String> = Vec::new();
    for r in &revisions {
        if !commit_ids.contains(&r.7) {
            commit_ids.push(r.7.clone());
        }
    }
    type CommitRow = (
        String,
        String,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let mut commits: Vec<CommitRow> = Vec::with_capacity(commit_ids.len());
    {
        let mut stmt = conn.prepare(
            "SELECT commit_id, repo_id, seq, ts, origin, actor, reason, checkpoint_id, ops FROM commits WHERE commit_id = ?1",
        )?;
        for c in &commit_ids {
            let row: Option<CommitRow> = stmt
                .query_row(params![c], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                    ))
                })
                .optional()?;
            if let Some(row) = row {
                commits.push(row);
            }
        }
    }
    commits.sort_by_key(|c| c.2);
    let seq_lo = commits.first().map_or(0, |c| c.2);
    let seq_hi = commits.last().map_or(0, |c| c.2);
    let segment_id = minter.mint("s")?;
    let created_at = plan.now.clone();
    let previous = last_segment(conn, repo_id)?;

    let mut marker = ReachMarker::new(conn);
    let mut trees = HashSet::new();
    let mut blobs = HashSet::new();
    let bodies: Vec<RevBodies> = revisions
        .iter()
        .map(|r| (Some(r.3.clone()), r.4.clone()))
        .collect();
    marker.mark(&bodies, &mut trees, &mut blobs)?;
    let mut trees: Vec<String> = trees.into_iter().collect();
    trees.sort();
    let mut blobs: Vec<String> = blobs.into_iter().collect();
    blobs.sort();

    let wholly = wholly_archived_commits(conn, &rev_ids.iter().cloned().collect())?;

    std::fs::create_dir_all(dest)
        .map_err(|e| Error::Other(format!("cannot create {}: {e}", dest.display())))?;
    for entry in std::fs::read_dir(dest)
        .map_err(|e| Error::Other(format!("cannot read {}: {e}", dest.display())))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(&format!("{ARCHIVE_SUFFIX}{PARTIAL_SUFFIX}")) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let name = segment_file_name(repo_id, seq_lo, seq_hi, &segment_id);
    let final_path = dest.join(&name);
    let partial_path = dest.join(format!("{name}{PARTIAL_SUFFIX}"));

    {
        let seg = Connection::open(&partial_path)?;
        seg.pragma_update(None, "journal_mode", "DELETE")?;
        seg.pragma_update(None, "synchronous", "FULL")?;
        seg.execute_batch(ARCHIVE_SQL)?;
        let tx = seg.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO manifest (segment_id, repo_id, created_at, policy, seq_lo, seq_hi, revision_count, previous_segment, schema_user_version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                segment_id,
                repo_id,
                created_at,
                plan.policy.to_json().to_string(),
                seq_lo,
                seq_hi,
                i64::try_from(revisions.len()).unwrap_or(i64::MAX),
                previous,
                SCHEMA_VERSION
            ],
        )?;
        {
            let mut ins = tx.prepare(
                "INSERT INTO revisions (rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for r in &revisions {
                ins.execute(params![r.0, r.1, r.2, r.3, r.4, r.5, r.6, r.7])?;
            }
            let mut ins = tx.prepare(
                "INSERT INTO commits (commit_id, repo_id, seq, ts, origin, actor, reason, checkpoint_id, ops) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for c in &commits {
                ins.execute(params![c.0, c.1, c.2, c.3, c.4, c.5, c.6, c.7, c.8])?;
            }
            let mut tree_row =
                conn.prepare("SELECT hash, entries FROM tree_nodes WHERE hash = ?1")?;
            let mut ins = tx.prepare("INSERT INTO tree_nodes (hash, entries) VALUES (?1, ?2)")?;
            for t in &trees {
                let row: Option<(Vec<u8>, String)> = tree_row
                    .query_row(params![from_hex(t)?], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()?;
                if let Some((hash, entries)) = row {
                    ins.execute(params![hash, entries])?;
                }
            }
            let mut blob_row =
                conn.prepare("SELECT hash, bytes, size FROM blobs WHERE hash = ?1")?;
            let mut ins =
                tx.prepare("INSERT INTO blobs (hash, bytes, size) VALUES (?1, ?2, ?3)")?;
            for b in &blobs {
                let row: Option<(Vec<u8>, Vec<u8>, i64)> = blob_row
                    .query_row(params![from_hex(b)?], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })
                    .optional()?;
                if let Some((hash, bytes, size)) = row {
                    ins.execute(params![hash, bytes, size])?;
                }
            }
            let mut disp_rows = conn.prepare(
                "SELECT commit_id, block_id, kind, confidence, reason, matcher_v, detail FROM dispositions WHERE commit_id = ?1 ORDER BY block_id, kind",
            )?;
            let mut bc_rows = conn.prepare(
                "SELECT block_id, commit_id, kind FROM block_changes WHERE commit_id = ?1 ORDER BY block_id, kind",
            )?;
            let mut ins_disp = tx.prepare(
                "INSERT INTO dispositions (commit_id, block_id, kind, confidence, reason, matcher_v, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            let mut ins_bc = tx.prepare(
                "INSERT INTO block_changes (block_id, commit_id, kind) VALUES (?1, ?2, ?3)",
            )?;
            for c in &wholly {
                type Disp = (
                    String,
                    String,
                    String,
                    Option<f64>,
                    Option<String>,
                    Option<String>,
                    String,
                );
                let disps = disp_rows
                    .query_map(params![c], |r| {
                        Ok::<Disp, _>((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                for d in disps {
                    ins_disp.execute(params![d.0, d.1, d.2, d.3, d.4, d.5, d.6])?;
                }
                let bcs = bc_rows
                    .query_map(params![c], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                for b in bcs {
                    ins_bc.execute(params![b.0, b.1, b.2])?;
                }
            }
        }
        tx.commit()?;
        seg.close().map_err(|(_, e)| Error::Sqlite(e))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // A filesystem without modes: the engine still never writes through an alias.
        let _ = std::fs::set_permissions(&partial_path, std::fs::Permissions::from_mode(0o444));
    }
    std::fs::rename(&partial_path, &final_path).map_err(|e| {
        Error::Other(format!(
            "cannot rename {} to {}: {e}",
            partial_path.display(),
            final_path.display()
        ))
    })?;
    Ok(SegmentInfo {
        id: segment_id,
        path: final_path.to_string_lossy().into_owned(),
        seq_lo,
        seq_hi,
        created_at,
        revision_count: i64::try_from(revisions.len()).unwrap_or(i64::MAX),
        bytes: file_bytes(&final_path),
        previous_segment: previous,
    })
}

/// Phase 2: squash the store for a complete segment, in one transaction — the
/// archived revisions lose their bodies and gain `archive`; the wholly
/// archived commits lose their dispositions and every block_changes row but
/// each block's earliest; the GC sweep reclaims what is reachable from
/// nothing; the segment is recorded in `archives` and as the repo's
/// `history.last_segment`.
fn squash(
    conn: &Connection,
    repo_id: &str,
    segment: &SegmentInfo,
    rev_ids: &[String],
) -> Result<(SquashResult, SweptBodies)> {
    let tx = conn.unchecked_transaction()?;
    let wholly = wholly_archived_commits(&tx, &rev_ids.iter().cloned().collect())?;
    {
        let mut upd = tx.prepare(
            "UPDATE revisions SET root_tree = NULL, frontmatter_blob = NULL, archive = ?1 WHERE rev_id = ?2",
        )?;
        for id in rev_ids {
            upd.execute(params![segment.id, id])?;
        }
    }
    let mut dispositions = 0usize;
    let mut block_changes = 0usize;
    {
        let mut del_disp = tx.prepare("DELETE FROM dispositions WHERE commit_id = ?1")?;
        // The rows that stay: a block's earliest block_changes row (by commit
        // seq) — the mint oracle (§2.1) reads this table, so an id ever minted
        // stays in use after its row, its pool entry and its history are gone.
        let mut del_bc = tx.prepare(
            "DELETE FROM block_changes WHERE commit_id = ?1 AND EXISTS (
               SELECT 1 FROM block_changes b2 JOIN commits c2 ON c2.commit_id = b2.commit_id JOIN commits c ON c.commit_id = block_changes.commit_id
               WHERE b2.block_id = block_changes.block_id AND c2.seq < c.seq)",
        )?;
        for c in &wholly {
            dispositions += del_disp.execute(params![c])?;
            block_changes += del_bc.execute(params![c])?;
        }
    }
    let (blobs, tree_nodes) = sweep_unreachable(&tx)?;
    record_archive(
        &tx,
        &ArchiveRow {
            segment_id: segment.id.clone(),
            repo_id: repo_id.to_owned(),
            path: segment.path.clone(),
            seq_lo: segment.seq_lo,
            seq_hi: segment.seq_hi,
            created_at: segment.created_at.clone(),
            revision_count: segment.revision_count,
            bytes: segment.bytes,
        },
    )?;
    set_last_segment(&tx, repo_id, &segment.id)?;
    tx.commit()?;
    Ok((
        SquashResult {
            revisions: rev_ids.len(),
            commits: wholly.len(),
            dispositions,
            block_changes,
        },
        SweptBodies { blobs, tree_nodes },
    ))
}

/// `omg history export [--prune]` (§7.1): evaluate the policy, write ONE new
/// segment for the revisions to archive (or finish an unrecorded one — the
/// crash rule), and with `prune` squash the store. Nothing to archive → no
/// file, `segment: None`.
pub fn export_history(
    conn: &Connection,
    minter: &mut Mint<'_>,
    repo_id: &str,
    opts: &ExportOptions,
) -> Result<ExportResult> {
    let plan = evaluate_retention(conn, repo_id, &opts.retention)?;
    let dest = opts.dest.as_path();

    // The crash rule: a complete segment nobody recorded, whose revisions are
    // still live, is finished first; a detached one is left alone (`attach`
    // brings it back); a stale one is refused rather than guessed about.
    let unrecorded = unrecorded_segments(conn, repo_id, dest)?;
    if let Some(stale) = unrecorded.iter().find(|u| u.state == ArchiveState::Stale) {
        let mut offending = "?".to_owned();
        for id in segment_revision_ids(&stale.path)? {
            let row: Option<Option<String>> = conn
                .query_row(
                    "SELECT archive FROM revisions WHERE rev_id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?;
            if !matches!(row, Some(None)) {
                offending = id;
                break;
            }
        }
        return Err(Error::StaleSegment {
            path: stale.path.to_string_lossy().into_owned(),
            rev: offending,
        });
    }
    if let Some(pending) = unrecorded.iter().find(|u| u.state == ArchiveState::Pending) {
        let manifest = read_manifest(&pending.path)?;
        let rev_ids = segment_revision_ids(&pending.path)?;
        let segment = SegmentInfo {
            id: manifest.segment_id,
            path: pending.path.to_string_lossy().into_owned(),
            seq_lo: manifest.seq_lo,
            seq_hi: manifest.seq_hi,
            created_at: manifest.created_at,
            revision_count: manifest.revision_count,
            bytes: file_bytes(&pending.path),
            previous_segment: manifest.previous_segment,
        };
        if !opts.prune {
            return Ok(ExportResult {
                plan,
                segment: Some(segment),
                reused: true,
                squashed: None,
                gc: None,
            });
        }
        let (squashed, gc) = squash(conn, repo_id, &segment, &rev_ids)?;
        return Ok(ExportResult {
            plan,
            segment: Some(segment),
            reused: true,
            squashed: Some(squashed),
            gc: Some(gc),
        });
    }

    let rev_ids = plan.archived_revisions();
    if rev_ids.is_empty() {
        return Ok(ExportResult {
            plan,
            segment: None,
            reused: false,
            squashed: None,
            gc: None,
        });
    }
    let segment = write_segment(conn, minter, repo_id, &rev_ids, &plan, dest)?;
    if !opts.prune {
        return Ok(ExportResult {
            plan,
            segment: Some(segment),
            reused: false,
            squashed: None,
            gc: None,
        });
    }
    let (squashed, gc) = squash(conn, repo_id, &segment, &rev_ids)?;
    Ok(ExportResult {
        plan,
        segment: Some(segment),
        reused: false,
        squashed: Some(squashed),
        gc: Some(gc),
    })
}

/// The archived-history figures the size report carries (§7.2, 15.0):
/// `(revisions with archive IS NOT NULL, archives rows, the recorded files'
/// bytes on disk)`.
pub fn archived_summary(conn: &Connection) -> Result<(u64, u64, u64)> {
    let revisions: i64 = conn.query_row(
        "SELECT count(*) FROM revisions WHERE archive IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare("SELECT path FROM archives")?;
    let paths = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let bytes: u64 = paths
        .iter()
        .map(|p| u64::try_from(file_bytes(Path::new(p))).unwrap_or(0))
        .sum();
    Ok((
        u64::try_from(revisions).unwrap_or(0),
        u64::try_from(paths.len()).unwrap_or(0),
        bytes,
    ))
}

/// The file name of a segment path, for messages and fixtures.
#[must_use]
pub fn segment_basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

/// `hex` re-exported for callers assembling tree hashes (the fixture runners).
#[must_use]
pub fn hash_hex(h: &[u8]) -> String {
    hex(h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_names_round_trip() {
        let name = segment_file_name("rp_0", 2, 21, "s_0");
        assert_eq!(name, "rp_0-2-21-s_0.omgarchive.db");
        assert_eq!(
            parse_segment_file_name(&name),
            Some(SegmentName {
                repo_id: "rp_0".into(),
                seq_lo: 2,
                seq_hi: 21,
                segment_id: "s_0".into()
            })
        );
        assert_eq!(
            parse_segment_file_name("rp_k7z2p9q-1-1-s_abc1234.omgarchive.db").map(|p| p.segment_id),
            Some("s_abc1234".to_owned())
        );
        assert!(parse_segment_file_name("rp_0-2-21-s_0.omgarchive.db.partial").is_none());
        assert!(parse_segment_file_name("notes.txt").is_none());
        assert!(parse_segment_file_name("rp_0-x-21-s_0.omgarchive.db").is_none());
        assert!(parse_segment_file_name("RP_0-2-21-s_0.omgarchive.db").is_none());
        assert_eq!(archive_alias("s_0"), "arc_s_0");
        assert_eq!(archive_alias("s-x.y"), "arc_s_x_y");
        assert_eq!(
            segment_basename("/a/b/rp_0-1-1-s_0.omgarchive.db"),
            "rp_0-1-1-s_0.omgarchive.db"
        );
    }
}
