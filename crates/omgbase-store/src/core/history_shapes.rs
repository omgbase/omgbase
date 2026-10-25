//! The shapes the history capability answers in (`spec/store` §7.1, 15.0):
//! the retention policy and plan, the archive segments' records. Pure data
//! and their JSON renderings, owned by the core so the
//! [`HistoryRecorder`](crate::core::capabilities::HistoryRecorder) trait can
//! speak them; the rules that produce them live in `history::retention` and
//! `history::archive`, which re-export every name here under its old path.

use std::path::PathBuf;

use serde_json::{Map, Value as Json, json};

/// `one per <period>`: a ladder rung's thinning grain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LadderKeep {
    Day,
    Week,
    Month,
    Year,
}

/// The wire spellings, in the order the policy error lists them.
pub const LADDER_KEEPS: [&str; 4] = [
    "one per day",
    "one per week",
    "one per month",
    "one per year",
];

impl LadderKeep {
    /// The wire spelling (`one per day`, …).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            LadderKeep::Day => "one per day",
            LadderKeep::Week => "one per week",
            LadderKeep::Month => "one per month",
            LadderKeep::Year => "one per year",
        }
    }

    /// Parse the wire spelling.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "one per day" => LadderKeep::Day,
            "one per week" => LadderKeep::Week,
            "one per month" => LadderKeep::Month,
            "one per year" => LadderKeep::Year,
            _ => return None,
        })
    }
}

/// One ladder rung: applies to a revision whose age in whole days is at
/// least `after_days`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LadderRung {
    pub after_days: u64,
    pub keep: LadderKeep,
}

/// A per-path override: the keys given replace the base policy's for the
/// documents the glob matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetentionOverride {
    pub glob: String,
    pub keep_days: Option<u64>,
    pub per_doc_max: Option<u64>,
    pub ladder: Option<Vec<LadderRung>>,
    pub keep_origins: Option<Vec<String>>,
}

/// The policy (§7.1 "The policy").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetentionPolicy {
    /// Every revision younger than this many days is kept.
    pub keep_days: u64,
    /// Beyond `keep_days`, one revision per period per rung (sorted by `after_days`).
    pub ladder: Vec<LadderRung>,
    /// The newest N revisions of a document are kept regardless of age.
    pub per_doc_max: u64,
    /// A revision whose commit has one of these origins AND a non-empty reason is kept.
    pub keep_origins: Vec<String>,
    pub overrides: Vec<RetentionOverride>,
}

impl Default for RetentionPolicy {
    /// The defaults (§7.1): a month hot, then one a day for a year, then one
    /// a month; 200 per document; `api` commits with a reason.
    fn default() -> Self {
        Self {
            keep_days: 30,
            ladder: vec![
                LadderRung {
                    after_days: 30,
                    keep: LadderKeep::Day,
                },
                LadderRung {
                    after_days: 365,
                    keep: LadderKeep::Month,
                },
            ],
            per_doc_max: 200,
            keep_origins: vec!["api".to_owned()],
            overrides: Vec::new(),
        }
    }
}

fn ladder_json(ladder: &[LadderRung]) -> Json {
    Json::Array(
        ladder
            .iter()
            .map(|r| json!({ "after_days": r.after_days, "keep": r.keep.as_str() }))
            .collect(),
    )
}

impl RetentionPolicy {
    /// The policy as JSON, in the reference's key order (`keep_days`,
    /// `ladder`, `per_doc_max`, `keep_origins`, `overrides`; an override's
    /// `glob` first, then only the keys it names).
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("keep_days".to_owned(), json!(self.keep_days));
        m.insert("ladder".to_owned(), ladder_json(&self.ladder));
        m.insert("per_doc_max".to_owned(), json!(self.per_doc_max));
        m.insert("keep_origins".to_owned(), json!(self.keep_origins));
        m.insert(
            "overrides".to_owned(),
            Json::Array(
                self.overrides
                    .iter()
                    .map(|o| {
                        let mut om = Map::new();
                        om.insert("glob".to_owned(), json!(o.glob));
                        if let Some(k) = o.keep_days {
                            om.insert("keep_days".to_owned(), json!(k));
                        }
                        if let Some(k) = o.per_doc_max {
                            om.insert("per_doc_max".to_owned(), json!(k));
                        }
                        if let Some(l) = &o.ladder {
                            om.insert("ladder".to_owned(), ladder_json(l));
                        }
                        if let Some(k) = &o.keep_origins {
                            om.insert("keep_origins".to_owned(), json!(k));
                        }
                        Json::Object(om)
                    })
                    .collect(),
            ),
        );
        Json::Object(m)
    }
}

/// One document of the plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetentionDocPlan {
    pub id: String,
    /// The document's current path, reference form.
    pub path: String,
    /// Live (non-archived) revisions of the document before the plan.
    pub revisions: usize,
    /// Revision ids kept, oldest first.
    pub keep: Vec<String>,
    /// Revision ids to archive, oldest first.
    pub archive: Vec<String>,
    /// Bytes of blobs and tree nodes reachable from the archived revisions and from no kept revision of the store.
    pub bytes: u64,
}

/// The plan's totals.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetentionTotals {
    /// Documents with at least one revision to archive.
    pub docs: usize,
    /// Live revisions of the repository before the plan.
    pub revisions: usize,
    pub keep: usize,
    pub archive: usize,
    /// Bytes reachable only from the archived revisions, over their union.
    pub bytes: u64,
}

/// The plan (§7.1 "The plan").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetentionPlan {
    pub policy: RetentionPolicy,
    pub now: String,
    pub before: Option<String>,
    /// Only the documents with something to archive, by path.
    pub docs: Vec<RetentionDocPlan>,
    pub totals: RetentionTotals,
}

impl RetentionPlan {
    /// The plan as the fixtures and `history plan --json` print it.
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "policy": self.policy.to_json(),
            "now": self.now,
            "before": self.before,
            "docs": self.docs.iter().map(|d| json!({
                "id": d.id,
                "path": d.path,
                "revisions": d.revisions,
                "keep": d.keep,
                "archive": d.archive,
                "bytes": d.bytes,
            })).collect::<Vec<_>>(),
            "totals": {
                "docs": self.totals.docs,
                "revisions": self.totals.revisions,
                "keep": self.totals.keep,
                "archive": self.totals.archive,
                "bytes": self.totals.bytes,
            },
        })
    }

    /// Every revision id the plan archives, in plan order (documents by
    /// path, revisions oldest first).
    #[must_use]
    pub fn archived_revisions(&self) -> Vec<String> {
        self.docs
            .iter()
            .flat_map(|d| d.archive.iter().cloned())
            .collect()
    }
}

/// What the retention plan is evaluated under
/// ([`HistoryRecorder::retention_plan`](crate::core::capabilities::HistoryRecorder::retention_plan)).
#[derive(Clone, Debug)]
pub struct RetentionOptions {
    /// The clock (`OMGBASE_SPEC_CLOCK` in a conformance run).
    pub now: String,
    /// Only revisions committed strictly before this instant are candidates.
    pub before: Option<String>,
    /// The policy in effect.
    pub policy: RetentionPolicy,
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
    /// Kept revisions re-written in checkpoint form because the squash
    /// archived their base (spec §4.4 "Base liveness", §7.1 step 0, 16.0).
    pub checkpointed: usize,
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

/// What a history export runs under
/// ([`HistoryRecorder::export_history`](crate::core::capabilities::HistoryRecorder::export_history)).
#[derive(Clone, Debug)]
pub struct ExportOptions {
    pub retention: RetentionOptions,
    /// The directory the segment is written to (created when missing).
    pub dest: PathBuf,
    /// Squash the store after the segment is durable.
    pub prune: bool,
}
