//! The change feed (`spec/store` §3.1 `feed`/`feed_entries`, §5.4 step 5,
//! §7.4; `spec/surface` §3 `changes_since`; modular-core Phase 3d — D7/M5,
//! D4). The core's own record of every commit to a repository: one slim row
//! per commit (`epoch`, `seq`, `commit_id`, `ts`, `origin`, `actor`,
//! `reason`, `batch_id`, `plan_id`) and one entry per document the commit
//! touched (`path` as of the commit, the `head` token minted, the `hash` the
//! head renders to, `kind ∈ created | changed | deleted | moved`, `from_path`
//! on a move). It is what `changes_since` pages and what the sync base rests
//! on; it depends on no history table — the recorder's `commits` row shares
//! the id, epoch and seq ([`HistoryRecorder::record_commit`]) and keeps the
//! log. Retention is the core's (§7.4): floors `feed.retain_days` /
//! `feed.retain_entries`, cap `feed.max_entries`; "the feed is catch-up, a
//! rescan is recovery, the log is history". A cursor is `(epoch, seq)`: the
//! repository's EPOCH (`repos.epoch`, an `ep_` id minted with the repo) scopes
//! every `seq`, and a cursor from another epoch, past the head or behind the
//! oldest retained row is [`ExpiredCursor`] — the consumer rescans (`spec/sync`
//! §6). Port of `packages/core/src/core/store/feed.ts`.

use omgbase_format::hash::hex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::core::capabilities::HistoryRecorder;
use crate::core::manifest::capture;
use crate::core::mint::Mint;
use crate::core::settings::effective_settings;
use crate::core::time::plus_ms;
use crate::core::writers::{CommitRecord, Origin};
use crate::error::{Error, Result};

/// The repository's current epoch (`repos.epoch`).
pub fn repo_epoch(conn: &Connection, repo_id: &str) -> Result<String> {
    conn.query_row(
        "SELECT epoch FROM repos WHERE repo_id = ?1",
        params![repo_id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| Error::Other(format!("no repository {repo_id}")))
}

/// Mint the repository's epoch (an `ep` id, claimed at `minted_at`); the
/// caller writes it on the `repos` row.
pub fn mint_epoch(mint: &mut Mint<'_>, repo_id: &str, minted_at: &str) -> Result<String> {
    let epoch = mint.mint("ep")?;
    mint.claim("ep", &epoch, Some(repo_id), minted_at)?;
    Ok(epoch)
}

/// `spec/store` §7.5 (17.0): the epoch re-mint of a restore or a
/// rebuild-from-files. Mint and claim a new `ep` at `ts`, write it on the
/// `repos` row, and delete the repository's `feed`/`feed_entries` rows of
/// EVERY epoch — the old epoch is unreachable by any cursor (an
/// `expired_cursor` by construction) and the feed starts over at `seq = 1`
/// with the next commit. The recorder's `commits` keep their old `epoch`.
/// Runs in the caller's transaction; an unknown repository is an error.
pub fn remint_epoch(
    conn: &Connection,
    mint: &mut Mint<'_>,
    repo_id: &str,
    ts: &str,
) -> Result<String> {
    repo_epoch(conn, repo_id)?;
    let epoch = mint_epoch(mint, repo_id, ts)?;
    conn.execute(
        "DELETE FROM feed_entries WHERE repo_id = ?1",
        params![repo_id],
    )?;
    conn.execute("DELETE FROM feed WHERE repo_id = ?1", params![repo_id])?;
    conn.execute(
        "UPDATE repos SET epoch = ?1 WHERE repo_id = ?2",
        params![epoch, repo_id],
    )?;
    Ok(epoch)
}

/// What a feed row records besides its minted id and sequence number
/// (§5.4 step 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NewFeedRow<'a> {
    pub repo_id: &'a str,
    pub ts: &'a str,
    pub origin: Origin,
    pub actor: Option<&'a str>,
    pub reason: Option<&'a str>,
    /// The batch this commit belongs to (D4): the first committing member's
    /// commit id; `None` ⇒ this commit is its own batch (`batch_id =
    /// commit_id`).
    pub batch_id: Option<&'a str>,
    /// The admitted plan's digest for an effect-driven api commit
    /// (resolution 3); NULL otherwise.
    pub plan_id: Option<&'a str>,
    /// The ADR-003 intent record, handed to the recorder (`commits.ops`);
    /// never a feed column.
    pub ops: Option<&'a str>,
}

impl<'a> NewFeedRow<'a> {
    /// An `observed` row with every optional column `NULL`.
    #[must_use]
    pub fn observed(repo_id: &'a str, ts: &'a str) -> Self {
        Self {
            repo_id,
            ts,
            origin: Origin::Observed,
            actor: None,
            reason: None,
            batch_id: None,
            plan_id: None,
            ops: None,
        }
    }
}

/// The feed row a commit transaction appended: the `(epoch, seq)` every
/// per-document entry is written under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedRow {
    pub commit_id: String,
    pub epoch: String,
    pub seq: i64,
    pub batch_id: String,
}

/// `spec/store` §5.4 step 5: mint `c` (claim it), `seq = 1 + max(seq)` over
/// the repo's feed rows of the current epoch, insert the row with `batch_id`
/// (the given batch's id, else this commit's own), then hand the recorder its
/// `commits` row ([`HistoryRecorder::record_commit`] — the same id, epoch and
/// seq; `history` is `None` when the store runs without the recorder or the
/// repository's manifest has capture off — the caller's `capture_for`, Phase
/// 4a; a failure is [`Error::CaptureFailed`] for the owner of the transaction,
/// the member's path its to name) and enforce the cap (`feed.max_entries`,
/// §7.4) inside the same transaction. Runs in the caller's transaction on
/// `conn`.
pub fn append_feed_row(
    conn: &Connection,
    mint: &mut Mint<'_>,
    history: Option<&dyn HistoryRecorder>,
    input: &NewFeedRow<'_>,
) -> Result<FeedRow> {
    let epoch = repo_epoch(conn, input.repo_id)?;
    let commit_id = mint.mint("c")?;
    mint.claim("c", &commit_id, Some(input.repo_id), input.ts)?;
    let seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM feed WHERE repo_id = ?1 AND epoch = ?2",
        params![input.repo_id, epoch],
        |r| r.get(0),
    )?;
    let batch_id = input.batch_id.unwrap_or(&commit_id).to_owned();
    conn.execute(
        "INSERT INTO feed (repo_id, epoch, seq, commit_id, ts, origin, actor, reason, batch_id, plan_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            input.repo_id,
            epoch,
            seq,
            commit_id,
            input.ts,
            input.origin.as_str(),
            input.actor,
            input.reason,
            batch_id,
            input.plan_id,
        ],
    )?;
    if let Some(history) = history {
        capture(
            None,
            history.record_commit(
                conn,
                &CommitRecord {
                    commit_id: &commit_id,
                    repo_id: input.repo_id,
                    epoch: &epoch,
                    seq,
                    ts: input.ts,
                    origin: input.origin,
                    actor: input.actor,
                    reason: input.reason,
                    batch_id: &batch_id,
                    ops: input.ops,
                },
            ),
        )?;
    }
    enforce_feed_cap(conn, input.repo_id, &epoch)?;
    Ok(FeedRow {
        commit_id,
        epoch,
        seq,
        batch_id,
    })
}

/// `feed_entries.kind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedEntryKind {
    Created,
    Changed,
    Deleted,
    Moved,
}

impl FeedEntryKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            FeedEntryKind::Created => "created",
            FeedEntryKind::Changed => "changed",
            FeedEntryKind::Deleted => "deleted",
            FeedEntryKind::Moved => "moved",
        }
    }

    /// The column's text back to the kind (`None` for anything else).
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "created" => Some(FeedEntryKind::Created),
            "changed" => Some(FeedEntryKind::Changed),
            "deleted" => Some(FeedEntryKind::Deleted),
            "moved" => Some(FeedEntryKind::Moved),
            _ => None,
        }
    }
}

/// One `feed_entries` row to write (§5.4 step 5, the entry; §5.6 step 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NewFeedEntry<'a> {
    pub repo_id: &'a str,
    pub epoch: &'a str,
    pub seq: i64,
    pub doc_id: &'a str,
    /// The path as of the commit (storage form).
    pub path: &'a str,
    /// The head token minted (`None` for `deleted`).
    pub head: Option<&'a str>,
    /// `docs.file_hash` after the commit (`None` for `deleted`).
    pub hash: Option<&'a [u8]>,
    pub kind: FeedEntryKind,
    /// `moved` only: the previous path (storage form).
    pub from_path: Option<&'a str>,
}

/// §5.4 step 5 (the entry), §5.6 step 1: one `feed_entries` row for a
/// document the feed row touched.
pub fn append_feed_entry(conn: &Connection, e: &NewFeedEntry<'_>) -> Result<()> {
    let from_path = match e.kind {
        FeedEntryKind::Moved => e.from_path,
        _ => None,
    };
    conn.execute(
        "INSERT OR REPLACE INTO feed_entries (repo_id, epoch, seq, doc_id, path, head, hash, kind, from_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            e.repo_id,
            e.epoch,
            e.seq,
            e.doc_id,
            e.path,
            e.head,
            e.hash,
            e.kind.as_str(),
            from_path,
        ],
    )?;
    Ok(())
}

// ---- retention (§7.4) -------------------------------------------------------------------

/// The settings key of the feed policy.
pub const FEED_SETTINGS_KEY: &str = "feed";
pub const FEED_RETAIN_DAYS_DEFAULT: i64 = 10;
pub const FEED_RETAIN_ENTRIES_DEFAULT: i64 = 10_000;
pub const FEED_MAX_ENTRIES_DEFAULT: i64 = 100_000;

const DAY_MS: i64 = 86_400_000;

/// The feed retention policy (§7.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeedPolicy {
    /// floor: a row younger than this many days is never pruned by the floors
    pub retain_days: i64,
    /// floor: the newest N rows are never pruned by the floors
    pub retain_entries: i64,
    /// cap: a row with more than this many newer rows is pruned regardless
    pub max_entries: i64,
}

impl Default for FeedPolicy {
    fn default() -> Self {
        Self {
            retain_days: FEED_RETAIN_DAYS_DEFAULT,
            retain_entries: FEED_RETAIN_ENTRIES_DEFAULT,
            max_entries: FEED_MAX_ENTRIES_DEFAULT,
        }
    }
}

fn non_negative_int(v: Option<&Json>, key: &str, default: i64) -> Result<i64> {
    let Some(v) = v else {
        return Ok(default);
    };
    if v.is_null() {
        return Ok(default);
    }
    let n = v
        .as_f64()
        .filter(|f| f.is_finite() && f.fract() == 0.0 && *f >= 0.0)
        .ok_or_else(|| {
            Error::Other(format!(
                "feed.{key} must be a non-negative integer (got {v})"
            ))
        })?;
    #[allow(clippy::cast_possible_truncation)]
    Ok(n as i64)
}

/// The feed policy out of a settings blob (§7.4): `feed.retain_days`
/// (default 10), `feed.retain_entries` (default 10 000), `feed.max_entries`
/// (default 100 000) — each a non-negative integer. A `max_entries` below
/// `retain_entries` is a malformed policy and refused, as is any other value.
pub fn feed_policy(settings: &Map<String, Json>) -> Result<FeedPolicy> {
    let empty = Map::new();
    let feed = settings
        .get(FEED_SETTINGS_KEY)
        .and_then(Json::as_object)
        .unwrap_or(&empty);
    let policy = FeedPolicy {
        retain_days: non_negative_int(
            feed.get("retain_days"),
            "retain_days",
            FEED_RETAIN_DAYS_DEFAULT,
        )?,
        retain_entries: non_negative_int(
            feed.get("retain_entries"),
            "retain_entries",
            FEED_RETAIN_ENTRIES_DEFAULT,
        )?,
        max_entries: non_negative_int(
            feed.get("max_entries"),
            "max_entries",
            FEED_MAX_ENTRIES_DEFAULT,
        )?,
    };
    if policy.max_entries < policy.retain_entries {
        return Err(Error::Other(format!(
            "feed.max_entries ({}) must not be below feed.retain_entries ({})",
            policy.max_entries, policy.retain_entries
        )));
    }
    Ok(policy)
}

/// The repo's effective feed policy (the workspace layer with the repo's own
/// over it).
pub fn repo_feed_policy(conn: &Connection, repo_id: &str) -> Result<FeedPolicy> {
    feed_policy(&effective_settings(conn, repo_id)?)
}

/// Delete every feed row of `(repo, epoch)` with more than `keep` newer rows
/// (so `keep + 1` rows survive at most — a row with exactly `keep` newer rows
/// is not "more than"), optionally only those with `ts < older_than`, oldest
/// first, together with their entries. Never the row with the greatest `seq`
/// (it has no newer row). Returns the rows deleted.
fn prune_beyond(
    conn: &Connection,
    repo_id: &str,
    epoch: &str,
    keep: i64,
    older_than: Option<&str>,
) -> Result<usize> {
    let offset = keep.saturating_add(1);
    let victims: Vec<i64> = match older_than {
        Some(cutoff) => {
            let mut stmt = conn.prepare(
                "SELECT seq FROM feed WHERE repo_id = ?1 AND epoch = ?2 AND ts < ?3
                 AND seq IN (SELECT seq FROM feed WHERE repo_id = ?1 AND epoch = ?2 ORDER BY seq DESC LIMIT -1 OFFSET ?4)
                 ORDER BY seq",
            )?;
            let it = stmt.query_map(params![repo_id, epoch, cutoff, offset], |r| r.get(0))?;
            it.collect::<std::result::Result<Vec<_>, _>>()?
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT seq FROM feed WHERE repo_id = ?1 AND epoch = ?2
                 AND seq IN (SELECT seq FROM feed WHERE repo_id = ?1 AND epoch = ?2 ORDER BY seq DESC LIMIT -1 OFFSET ?3)
                 ORDER BY seq",
            )?;
            let it = stmt.query_map(params![repo_id, epoch, offset], |r| r.get(0))?;
            it.collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    if victims.is_empty() {
        return Ok(0);
    }
    let mut del_entries = conn.prepare_cached(
        "DELETE FROM feed_entries WHERE repo_id = ?1 AND epoch = ?2 AND seq = ?3",
    )?;
    let mut del_row =
        conn.prepare_cached("DELETE FROM feed WHERE repo_id = ?1 AND epoch = ?2 AND seq = ?3")?;
    for seq in &victims {
        del_entries.execute(params![repo_id, epoch, seq])?;
        del_row.execute(params![repo_id, epoch, seq])?;
    }
    Ok(victims.len())
}

/// The cap (§7.4): enforced in the transaction that appended a row — a feed
/// never exceeds `max_entries + 1` rows.
fn enforce_feed_cap(conn: &Connection, repo_id: &str, epoch: &str) -> Result<()> {
    let policy = repo_feed_policy(conn, repo_id)?;
    prune_beyond(conn, repo_id, epoch, policy.max_entries, None)?;
    Ok(())
}

/// The feed prune `gc` runs (§7.4): for every repository, the rows of its
/// current epoch older than `retain_days` (by `ts` against `now`) AND with
/// more than `retain_entries` newer rows, then the cap. Returns the feed rows
/// pruned. Runs in the caller's transaction.
pub fn prune_feed(conn: &Connection, now: &str) -> Result<usize> {
    let repos: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT repo_id, epoch FROM repos ORDER BY rowid")?;
        let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut pruned = 0usize;
    for (repo_id, epoch) in &repos {
        let policy = repo_feed_policy(conn, repo_id)?;
        let cutoff = plus_ms(now, -(policy.retain_days.saturating_mul(DAY_MS)))?;
        pruned += prune_beyond(conn, repo_id, epoch, policy.retain_entries, Some(&cutoff))?;
        pruned += prune_beyond(conn, repo_id, epoch, policy.max_entries, None)?;
    }
    Ok(pruned)
}

// ---- status and the change feed (`spec/surface` §3 `changes_since`) ----------------------

/// `{ epoch, oldest, head }` of the repository's feed in its current epoch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FeedStatus {
    pub epoch: String,
    /// the smallest `seq` the feed still holds (0 when empty)
    pub oldest: i64,
    /// the greatest `seq` (0 when empty)
    pub head: i64,
}

impl FeedStatus {
    /// `{ epoch, oldest, head }` as `repos_status` carries it.
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({ "epoch": self.epoch, "oldest": self.oldest, "head": self.head })
    }
}

/// The repository's feed position.
pub fn feed_status(conn: &Connection, repo_id: &str) -> Result<FeedStatus> {
    let epoch = repo_epoch(conn, repo_id)?;
    let (oldest, head): (i64, i64) = conn.query_row(
        "SELECT COALESCE(MIN(seq), 0), COALESCE(MAX(seq), 0) FROM feed WHERE repo_id = ?1 AND epoch = ?2",
        params![repo_id, epoch],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(FeedStatus {
        epoch,
        oldest,
        head,
    })
}

/// `expired_cursor` (`spec/surface` §3, 6.0; `retriable: false`): the
/// cursor's epoch is not the repository's, or the cursor is past the head, or
/// behind the oldest retained row. `data` is `{ epoch, oldest, head }` — the
/// repository's current position, which the rescan (`spec/sync` §6) resumes
/// from. The message is pinned, spelled alike by both engines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpiredCursor {
    pub cursor: i64,
    /// The epoch the caller gave (the repository's when it gave none).
    pub given: String,
    pub epoch: String,
    pub oldest: i64,
    pub head: i64,
}

impl ExpiredCursor {
    /// The pinned message.
    #[must_use]
    pub fn message(&self) -> String {
        format!(
            "cursor {} of epoch {} has expired — the feed now begins at ({}, {}); rescan the repository and resume from head {}",
            self.cursor, self.given, self.epoch, self.oldest, self.head
        )
    }

    /// The envelope's `data`.
    #[must_use]
    pub fn data(&self) -> Json {
        json!({ "epoch": self.epoch, "oldest": self.oldest, "head": self.head })
    }
}

impl std::fmt::Display for ExpiredCursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// One document of a digest: the row's names, the entry's kind, `from_path`
/// on a move; `hash` `None` for a deletion. Paths in the storage form (the
/// surface roots them, `spec/surface` §1 "Paths").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DigestRevision {
    pub doc: String,
    pub path: String,
    /// Hex of the entry's `hash`.
    pub hash: Option<String>,
    pub kind: FeedEntryKind,
    pub from_path: Option<String>,
}

/// One commit of the feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitDigest {
    pub commit: String,
    pub seq: i64,
    pub ts: String,
    pub origin: String,
    pub actor: Option<String>,
    pub batch_id: String,
    pub plan_id: Option<String>,
    /// A human line composed from the entries (unpinned); the disposition
    /// counts follow only when the recorder holds the commit.
    pub summary: String,
    /// The disposition counts the summary was composed from (`None` when the
    /// recorder has no row for the commit) — the surface re-renders the
    /// summary over the rooted paths.
    pub counts: Option<Vec<(String, i64)>>,
    pub revisions: Vec<DigestRevision>,
}

/// A page of the feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangesPage {
    pub digests: Vec<CommitDigest>,
    /// The last digest's `seq`, or the input cursor when the page is empty.
    pub cursor: i64,
    pub epoch: String,
    pub oldest: i64,
    pub head: i64,
    /// More commits follow.
    pub truncated: bool,
}

impl DigestRevision {
    /// The document under the row's engine names (`spec/surface` §1.2, 5.0):
    /// `{ _id, _path, _hash, kind, from_path? }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("_id".to_owned(), Json::String(self.doc.clone()));
        m.insert("_path".to_owned(), Json::String(self.path.clone()));
        m.insert(
            "_hash".to_owned(),
            self.hash.clone().map_or(Json::Null, Json::String),
        );
        m.insert(
            "kind".to_owned(),
            Json::String(self.kind.as_str().to_owned()),
        );
        if let Some(from) = &self.from_path {
            m.insert("from_path".to_owned(), Json::String(from.clone()));
        }
        Json::Object(m)
    }
}

impl CommitDigest {
    /// The digest as the MCP surface renders it (`spec/surface` §3, 6.0):
    /// the digest's own keys describe a commit and stay bare; `plan_id` only
    /// when set.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("commit".to_owned(), Json::String(self.commit.clone()));
        m.insert("seq".to_owned(), json!(self.seq));
        m.insert("ts".to_owned(), Json::String(self.ts.clone()));
        m.insert("origin".to_owned(), Json::String(self.origin.clone()));
        m.insert(
            "actor".to_owned(),
            self.actor.clone().map_or(Json::Null, Json::String),
        );
        m.insert("batch_id".to_owned(), Json::String(self.batch_id.clone()));
        if let Some(p) = &self.plan_id {
            m.insert("plan_id".to_owned(), Json::String(p.clone()));
        }
        m.insert("summary".to_owned(), Json::String(self.summary.clone()));
        m.insert(
            "revisions".to_owned(),
            Json::Array(self.revisions.iter().map(DigestRevision::to_json).collect()),
        );
        Json::Object(m)
    }
}

impl ChangesPage {
    /// The page as the MCP surface renders it.
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "digests": self.digests.iter().map(CommitDigest::to_json).collect::<Vec<_>>(),
            "cursor": self.cursor,
            "epoch": self.epoch,
            "oldest": self.oldest,
            "head": self.head,
            "truncated": self.truncated,
        })
    }
}

/// The arguments of `changes_since` (`spec/surface` §3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChangesSinceOptions<'a> {
    pub cursor: i64,
    /// The cursor's epoch; `None` is the repository's current one.
    pub epoch: Option<&'a str>,
    pub limit: usize,
    pub origin: Option<&'a str>,
}

impl Default for ChangesSinceOptions<'_> {
    fn default() -> Self {
        Self {
            cursor: 0,
            epoch: None,
            limit: 50,
            origin: None,
        }
    }
}

/// `changes_since` (`spec/surface` §3, 6.0 — contracts §2.4): the feed rows
/// with `seq > cursor` of the repository's epoch (optionally of one origin),
/// in `seq` order, `limit + 1` fetched to set `truncated`; the given `epoch`
/// defaults to the repository's. Fails [`Error::ExpiredCursor`] when the
/// given epoch is not the repository's, or `cursor > head`, or `cursor <
/// oldest − 1` — for every cursor, 0 included (every entry after the cursor
/// is present exactly when `cursor ≥ oldest − 1`; an empty feed has `oldest =
/// 0`, a feed that begins at 1 serves cursor 0, a feed pruned to `oldest ≥ 2`
/// expires it — a first-time consumer must not silently miss deletions and
/// bootstraps by the `spec/sync` §6 rescan; the decision of 2026-10-26,
/// `spec/store` §10). Reads `feed`/`feed_entries` only; the disposition
/// counts of the summary come from the recorder when it holds the commit.
pub fn changes_since(
    conn: &Connection,
    history: Option<&dyn HistoryRecorder>,
    repo_id: &str,
    opts: &ChangesSinceOptions<'_>,
) -> Result<ChangesPage> {
    let cursor = opts.cursor;
    let status = feed_status(conn, repo_id)?;
    let given = opts.epoch.unwrap_or(&status.epoch);
    if given != status.epoch || cursor > status.head || cursor < status.oldest - 1 {
        return Err(Error::ExpiredCursor(ExpiredCursor {
            cursor,
            given: given.to_owned(),
            epoch: status.epoch,
            oldest: status.oldest,
            head: status.head,
        }));
    }
    let limit = opts.limit;
    let fetch = i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1);
    type Row = (
        i64,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
    );
    let read = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Row> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
        ))
    };
    let mut rows: Vec<Row> = match opts.origin {
        Some(o) => {
            let mut stmt = conn.prepare(
                "SELECT seq, commit_id, ts, origin, actor, reason, batch_id, plan_id FROM feed
                 WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 AND origin = ?4 ORDER BY seq LIMIT ?5",
            )?;
            let it = stmt.query_map(params![repo_id, status.epoch, cursor, o, fetch], read)?;
            it.collect::<std::result::Result<Vec<_>, _>>()?
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT seq, commit_id, ts, origin, actor, reason, batch_id, plan_id FROM feed
                 WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 ORDER BY seq LIMIT ?4",
            )?;
            let it = stmt.query_map(params![repo_id, status.epoch, cursor, fetch], read)?;
            it.collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    let truncated = rows.len() > limit;
    rows.truncate(limit);
    let mut entries_of = conn.prepare(
        "SELECT doc_id, path, head, hash, kind, from_path FROM feed_entries
         WHERE repo_id = ?1 AND epoch = ?2 AND seq = ?3 ORDER BY rowid",
    )?;
    let mut digests = Vec::with_capacity(rows.len());
    for (seq, commit_id, ts, origin, actor, _reason, batch_id, plan_id) in rows {
        type EntryRow = (
            String,
            String,
            Option<String>,
            Option<Vec<u8>>,
            String,
            Option<String>,
        );
        let entries: Vec<EntryRow> = entries_of
            .query_map(params![repo_id, status.epoch, seq], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<std::result::Result<_, _>>()?;
        let revisions: Vec<DigestRevision> = entries
            .into_iter()
            .map(|(doc, path, _head, hash, kind, from_path)| {
                let kind = FeedEntryKind::parse(&kind).unwrap_or(FeedEntryKind::Changed);
                DigestRevision {
                    doc,
                    path,
                    hash: hash.as_deref().map(hex),
                    from_path: match kind {
                        FeedEntryKind::Moved => from_path,
                        _ => None,
                    },
                    kind,
                }
            })
            .collect();
        let counts = match history {
            Some(h) => h.disposition_counts(conn, &commit_id)?,
            None => None,
        };
        let summary = render_summary(&origin, actor.as_deref(), &revisions, counts.as_deref());
        digests.push(CommitDigest {
            commit: commit_id,
            seq,
            ts,
            origin,
            actor,
            batch_id,
            plan_id,
            summary,
            counts,
            revisions,
        });
    }
    let next = digests.last().map_or(cursor, |d| d.seq);
    Ok(ChangesPage {
        digests,
        cursor: next,
        epoch: status.epoch,
        oldest: status.oldest,
        head: status.head,
        truncated,
    })
}

/// The digest's human line (`spec/surface` §3, unpinned): `<origin>: ` for an
/// observation, `<origin>(<actor>): ` otherwise; then the entries joined by
/// `; ` — `a.md — changed` (`created`), `deleted b.md`, `moved a.md → c.md`
/// — and, when the recorder holds the commit, the 16.0 disposition counts
/// (` — 12 edited, 1 inserted`, `same` excluded). The reference's
/// `renderSummary`, over whatever path form the revisions carry.
#[must_use]
pub fn render_summary(
    origin: &str,
    actor: Option<&str>,
    revisions: &[DigestRevision],
    counts: Option<&[(String, i64)]>,
) -> String {
    let prefix = if origin == "observed" {
        "observed: ".to_owned()
    } else {
        format!("{origin}({}): ", actor.unwrap_or("?"))
    };
    let parts: Vec<String> = revisions
        .iter()
        .map(|r| match r.kind {
            FeedEntryKind::Deleted => format!("deleted {}", r.path),
            FeedEntryKind::Moved => format!(
                "moved {} → {}",
                r.from_path.as_deref().unwrap_or("?"),
                r.path
            ),
            kind => format!("{} — {}", r.path, kind.as_str()),
        })
        .collect();
    let detail: Vec<String> = counts
        .unwrap_or(&[])
        .iter()
        .filter(|(kind, _)| kind != "same")
        .map(|(kind, n)| format!("{n} {kind}"))
        .collect();
    format!(
        "{prefix}{}{}",
        if parts.is_empty() {
            "(no documents)".to_owned()
        } else {
            parts.join("; ")
        },
        if detail.is_empty() {
            String::new()
        } else {
            format!(" — {}", detail.join(", "))
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BatchItem, SequentialMinter, Store};
    use omgbase_reconcile::Config;

    fn store_with_commits(n: usize) -> (Store, String) {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("r").unwrap();
        for i in 0..n {
            let items = [BatchItem::observed("a.md", &format!("# T\n\nv{i}\n"))];
            store
                .observe_batch(
                    &repo,
                    &items,
                    &format!("2026-09-26T10:0{i}:00.000Z"),
                    &Config::default(),
                )
                .unwrap();
        }
        (store, repo)
    }

    fn page(store: &Store, repo: &str, cursor: i64, limit: usize) -> ChangesPage {
        store
            .changes_since(
                repo,
                &ChangesSinceOptions {
                    cursor,
                    limit,
                    ..ChangesSinceOptions::default()
                },
            )
            .unwrap()
    }

    #[test]
    fn pages_in_seq_order_with_truncation_head_and_epoch() {
        let (store, repo) = store_with_commits(3);
        let p = page(&store, &repo, 0, 2);
        assert_eq!(p.digests.len(), 2);
        assert!(p.truncated);
        assert_eq!((p.cursor, p.oldest, p.head), (2, 1, 3));
        assert_eq!(p.epoch, "ep_0");
        assert_eq!(p.digests[0].seq, 1);
        assert_eq!(p.digests[0].commit, "c_0");
        assert_eq!(p.digests[0].batch_id, "c_0");
        assert_eq!(p.digests[0].plan_id, None);
        assert_eq!(p.digests[0].origin, "observed");
        assert_eq!(p.digests[0].revisions.len(), 1);
        assert_eq!(p.digests[0].revisions[0].path, "a.md");
        assert_eq!(p.digests[0].revisions[0].doc, "d_0");
        assert_eq!(p.digests[0].revisions[0].kind, FeedEntryKind::Created);
        assert_eq!(p.digests[0].revisions[0].hash.as_ref().unwrap().len(), 64);
        assert_eq!(
            p.digests[0].summary,
            "observed: a.md — created — 2 inserted"
        );
        assert_eq!(p.digests[1].revisions[0].kind, FeedEntryKind::Changed);
        assert_eq!(
            p.digests[1].summary,
            "observed: a.md — changed — 1 deleted, 1 inserted"
        );

        let rest = page(&store, &repo, p.cursor, 2);
        assert_eq!(rest.digests.len(), 1);
        assert!(!rest.truncated);
        assert_eq!(rest.cursor, 3);

        let empty = page(&store, &repo, 3, 50);
        assert!(empty.digests.is_empty());
        assert_eq!(empty.cursor, 3, "the input cursor when the page is empty");
        assert_eq!(empty.head, 3);
        let json = p.to_json();
        assert_eq!(json["digests"][0]["revisions"][0]["kind"], "created");
        assert!(json["digests"][0].get("plan_id").is_none());
        assert_eq!(json["epoch"], "ep_0");
    }

    #[test]
    fn filters_by_origin() {
        let (store, repo) = store_with_commits(2);
        let api = store
            .changes_since(
                &repo,
                &ChangesSinceOptions {
                    origin: Some("api"),
                    ..ChangesSinceOptions::default()
                },
            )
            .unwrap();
        assert!(api.digests.is_empty());
        assert_eq!(api.cursor, 0);
        assert_eq!(api.head, 2);
    }

    #[test]
    fn expired_cursor_under_exactly_three_conditions() {
        let (store, repo) = store_with_commits(3);
        let expired = |opts: ChangesSinceOptions<'_>| match store.changes_since(&repo, &opts) {
            Err(Error::ExpiredCursor(e)) => e,
            other => panic!("expected expired_cursor, got {other:?}"),
        };
        // Past the head.
        let e = expired(ChangesSinceOptions {
            cursor: 4,
            ..ChangesSinceOptions::default()
        });
        assert_eq!((e.oldest, e.head), (1, 3));
        assert_eq!(
            e.message(),
            "cursor 4 of epoch ep_0 has expired — the feed now begins at (ep_0, 1); rescan the repository and resume from head 3"
        );
        assert_eq!(e.data(), json!({ "epoch": "ep_0", "oldest": 1, "head": 3 }));
        // Another epoch, whatever the cursor.
        let e = expired(ChangesSinceOptions {
            epoch: Some("ep_nope"),
            ..ChangesSinceOptions::default()
        });
        assert_eq!(e.given, "ep_nope");
        assert!(
            e.message()
                .starts_with("cursor 0 of epoch ep_nope has expired")
        );
        // Behind the oldest retained row: prune to the newest two.
        store
            .conn()
            .execute(
                "UPDATE repos SET settings = '{\"feed\":{\"retain_days\":0,\"retain_entries\":1}}'",
                [],
            )
            .unwrap();
        let gc = store.gc_at(true, "2026-10-01T00:00:00.000Z").unwrap();
        assert_eq!(gc.feed_pruned, 1);
        let status = feed_status(store.conn(), &repo).unwrap();
        assert_eq!((status.oldest, status.head), (2, 3));
        assert!(
            store
                .changes_since(
                    &repo,
                    &ChangesSinceOptions {
                        cursor: 1,
                        ..ChangesSinceOptions::default()
                    }
                )
                .is_ok(),
            "oldest − 1 is served"
        );
        // Cursor 0 is not special: once the feed begins at 2 it is behind
        // `oldest − 1` like any other (2026-10-26 — a first-time consumer must
        // not silently miss deletions; it bootstraps by the §6 rescan).
        let e = expired(ChangesSinceOptions::default());
        assert_eq!((e.cursor, e.oldest, e.head), (0, 2, 3));
        assert_eq!(
            e.message(),
            "cursor 0 of epoch ep_0 has expired — the feed now begins at (ep_0, 2); rescan the repository and resume from head 3"
        );
        store
            .conn()
            .execute(
                "UPDATE repos SET settings = '{\"feed\":{\"retain_days\":0,\"retain_entries\":0}}'",
                [],
            )
            .unwrap();
        assert_eq!(
            store
                .gc_at(true, "2026-10-01T00:00:00.000Z")
                .unwrap()
                .feed_pruned,
            1
        );
        let e = expired(ChangesSinceOptions {
            cursor: 1,
            ..ChangesSinceOptions::default()
        });
        assert_eq!((e.oldest, e.head), (3, 3));
        // The log keeps every commit.
        let commits: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM commits", [], |r| r.get(0))
            .unwrap();
        assert_eq!(commits, 3);
    }

    #[test]
    fn the_policy_is_read_and_refused_like_the_reference() {
        let m = |v: Json| match v {
            Json::Object(m) => m,
            _ => unreachable!(),
        };
        assert_eq!(feed_policy(&Map::new()).unwrap(), FeedPolicy::default());
        let p = feed_policy(&m(
            json!({ "feed": { "retain_days": 0, "retain_entries": 2, "max_entries": null } }),
        ))
        .unwrap();
        assert_eq!(
            (p.retain_days, p.retain_entries, p.max_entries),
            (0, 2, 100_000)
        );
        let err = feed_policy(&m(
            json!({ "feed": { "retain_entries": 5, "max_entries": 1 } }),
        ))
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "feed.max_entries (1) must not be below feed.retain_entries (5)"
        );
        let err = feed_policy(&m(json!({ "feed": { "retain_days": -1 } }))).unwrap_err();
        assert_eq!(
            err.to_string(),
            "feed.retain_days must be a non-negative integer (got -1)"
        );
        assert!(feed_policy(&m(json!({ "feed": { "retain_days": "3" } }))).is_err());
        // `feed` that is not an object reads as unset.
        assert_eq!(
            feed_policy(&m(json!({ "feed": 7 }))).unwrap(),
            FeedPolicy::default()
        );
    }

    #[test]
    fn summary_follows_the_reference_shape() {
        let rev = |path: &str, kind: FeedEntryKind, from: Option<&str>| DigestRevision {
            doc: "d_0".into(),
            path: path.into(),
            hash: None,
            kind,
            from_path: from.map(str::to_owned),
        };
        assert_eq!(
            render_summary(
                "api",
                Some("agent"),
                &[rev("a.md", FeedEntryKind::Changed, None)],
                Some(&[("same".into(), 3), ("edited".into(), 1)]),
            ),
            "api(agent): a.md — changed — 1 edited"
        );
        assert_eq!(
            render_summary(
                "import",
                None,
                &[
                    rev("a.md", FeedEntryKind::Created, None),
                    rev("b.md", FeedEntryKind::Created, None)
                ],
                None
            ),
            "import(?): a.md — created; b.md — created"
        );
        assert_eq!(
            render_summary("observed", None, &[], Some(&[("inserted".into(), 2)])),
            "observed: (no documents) — 2 inserted"
        );
        assert_eq!(
            render_summary(
                "observed",
                None,
                &[rev("a.md", FeedEntryKind::Deleted, None)],
                None
            ),
            "observed: deleted a.md"
        );
        assert_eq!(
            render_summary(
                "api",
                Some("human:spec"),
                &[
                    rev("b/a.md", FeedEntryKind::Moved, Some("a.md")),
                    rev("index.md", FeedEntryKind::Changed, None)
                ],
                Some(&[("edited".into(), 31)])
            ),
            "api(human:spec): moved a.md → b/a.md; index.md — changed — 31 edited"
        );
    }
}
