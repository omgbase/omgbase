//! The crate's error type.

use std::fmt;

/// Everything that can go wrong opening or writing a store.
#[derive(Debug)]
pub enum Error {
    /// SQLite reported an error.
    Sqlite(rusqlite::Error),
    /// The database's `user_version` is newer than this build (spec §1 step 3).
    SchemaTooNew {
        /// The database's `user_version`.
        found: i64,
        /// [`crate::SCHEMA_VERSION`].
        supported: i64,
    },
    /// A timestamp is not RFC 3339 UTC as spec §2.4 requires.
    InvalidTimestamp(String),
    /// A JSON column did not parse (tree entries, attrs, detail).
    Json(serde_json::Error),
    /// The embedding provider failed (`spec/search` §5).
    Search(omgbase_search::Error),
    /// A mutation was refused (`spec/mutate` §8): the code and its data.
    Mutation(omgbase_mutate::MutationError),
    /// A mint was rejected [`crate::MINT_GIVE_UP_AFTER`] times in a row
    /// (spec §2.1): the minter cannot produce an id that is not in use.
    MintExhausted {
        /// The prefix being minted.
        prefix: String,
        /// How many consecutive candidates were in use.
        rejected: usize,
    },
    /// An effect a plan cannot read (`spec/mutate` §11): a malformed shape,
    /// a field no target kind has, a value of the wrong type. The surface
    /// reports it as `filter_invalid`.
    InvalidEffect(String),
    /// A read of an archived revision whose segment is not recorded, or
    /// recorded but not on disk (spec §6.2 "Through a segment", 15.0; the
    /// surface's `revision_archived { rev, archive, path? }`).
    RevisionArchived {
        /// The revision asked for.
        rev: String,
        /// The segment its `archive` column names.
        archive: String,
        /// The recorded file, when the segment is recorded (then it is the
        /// file that is not on disk).
        path: Option<String>,
    },
    /// A file that is not an archive segment, or one of another repository
    /// (spec §7.1 "Attach / detach").
    NotASegment {
        /// The file.
        path: String,
        /// `no such file`, `no manifest row`, `not an archive segment`, or
        /// `a segment of repository <x>, not <y>`.
        detail: String,
    },
    /// An unrecorded segment under the archives directory names both live
    /// and non-live revisions (spec §7.1 "The crash rule"): it predates
    /// another squash or belongs to another store.
    StaleSegment {
        /// The file.
        path: String,
        /// The offending revision.
        rev: String,
    },
    /// A malformed retention policy (spec §7.1 "The policy").
    RetentionPolicy(String),
    /// A `changes_since` cursor the feed no longer serves (spec §7.4,
    /// `spec/surface` §3 `expired_cursor`, 17.0 D7): another epoch, past the
    /// head, pruned behind the oldest retained row. The consumer rescans.
    ExpiredCursor(crate::core::feed::ExpiredCursor),
    /// A delta node or frontmatter delta that cannot be resolved (spec §4.1
    /// "Delta nodes", §6, 16.0): a `{`-form with no base revision, ops that
    /// do not consume the base, a delta inside an archive segment. A corrupt
    /// store — the read fails rather than guessing.
    Delta(String),
    /// `spec/store` §5.4 step 0 (17.0, 3e-ii — resolution 17): a writer
    /// without the history module on a repository whose manifest requires
    /// capture (`capabilities.writer_requires`). The surface's
    /// `capability_unavailable { capability: "history", state: "unavailable"
    /// }`, retriable; the message is the reference's, byte for byte.
    HistoryWriterRequired,
    /// A history read on a composition without the history module
    /// (`phase-1-contracts.md` §2.1 `unavailable`, 17.1 Phase 4a): `docs_read
    /// { at }`, `docs_diff*`, `docs_history`, `blocks_history`, `history
    /// enable`. The surface's `capability_unavailable { capability:
    /// "history", state: "unavailable" }`, retriable; the message pinned.
    HistoryUnavailable,
    /// A history read on a repository whose capture is `disabled` whose
    /// target was never captured (§2.1 `disabled`; Phase 4a reads what WAS
    /// captured — a revision that has a row is served). `rev` names the
    /// revision asked for, when one was. The surface's `capability_unavailable
    /// { capability: "history", state: "disabled", rev? }`, not retriable.
    HistoryDisabled {
        /// The revision asked for.
        rev: Option<String>,
    },
    /// `spec/surface` §3's decision table (17.2, Phase 4b — `outside_coverage`):
    /// a revision token whose claim's `minted_at` falls in no coverage
    /// interval of the repository — capture was off when it was minted.
    /// `coverage_from` is the first interval's start; `fix` the current
    /// document (`docs_read {"_id":…}`) when the caller was `docs_read { at }`.
    /// The surface's `capability_unavailable { history, outside_coverage,
    /// rev, coverage_from, fix? }`, not retriable; the message pinned.
    HistoryOutsideCoverage {
        rev: String,
        coverage_from: String,
        fix: Option<String>,
    },
    /// `spec/surface` §3 `pruned` (17.2, Phase 4b): a token minted inside a
    /// coverage interval whose `revisions` row is gone — `history purge`
    /// removed it (`spec/store` §7.6). `fix` as [`Error::HistoryOutsideCoverage`].
    HistoryPruned { rev: String, fix: Option<String> },
    /// A revision token the recorder does not hold for the document asked
    /// about — nobody minted it here, or it is another document's (`spec/surface`
    /// §3; the surface's `target_missing { doc?, rev }`).
    TargetMissingRevision { rev: String, doc: Option<String> },
    /// `spec/store` §5.10 (17.2, Phase 4b): the repository's semantic row was
    /// switched off by `omg embed disable` while a provider stays configured —
    /// `semantic()`, `blocks_resolve`'s vector leg and the drain refuse. The
    /// surface's `capability_unavailable { semantic, disabled, fix: "omg embed
    /// enable" }`, not retriable; the message pinned.
    SemanticSwitchedOff,
    /// `embed enable` with no `embedding.provider` configured (`spec/store`
    /// §5.10): nothing to enable — the CLI renders it as a usage error with
    /// the `--provider` hint.
    SemanticProviderMissing,
    /// `spec/store` §5.4 step 15 (17.1, Phase 4a — resolution 18): the
    /// recorder failed inside a commit, so the member's transaction was
    /// rolled back — nothing is written without its capture — and the
    /// `capture_failed` alert is raised by the transaction's owner once the
    /// rollback is done. `path` is the member's (`None` until the owner names
    /// it — the commit row of a batch), `reason` the recorder's error. The
    /// surface's `capture_failed { path?, reason }`, retriable.
    CaptureFailed {
        path: Option<String>,
        reason: String,
    },
    /// `OMGBASE_FAULT` armed `site` for this `pass` (`spec/store` §9.7,
    /// modular-core Phase 5a): the test-only fault the engine raises at a
    /// named site — caught by nothing the engine owns except
    /// [`capture`](crate::core::manifest::capture), where it becomes
    /// [`Error::CaptureFailed`]. Message pinned: `injected fault at <site>
    /// (pass <n>)`.
    InjectedFault {
        site: crate::core::fault::FaultSite,
        pass: usize,
    },
    /// Anything else, with a message.
    Other(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Sqlite(e) => write!(f, "sqlite: {e}"),
            Error::SchemaTooNew { found, supported } => write!(
                f,
                "database schema (v{found}) is newer than this build (v{supported}); upgrade omgbase"
            ),
            Error::InvalidTimestamp(ts) => write!(f, "invalid RFC 3339 UTC timestamp {ts:?}"),
            Error::Json(e) => write!(f, "json: {e}"),
            Error::Search(e) => write!(f, "search: {e}"),
            Error::Mutation(e) => write!(f, "mutation: {e}"),
            Error::MintExhausted { prefix, rejected } => write!(
                f,
                "mint({prefix}): {rejected} consecutive candidates were already in use; the minter cannot produce a fresh id"
            ),
            Error::InvalidEffect(msg) => write!(f, "invalid effect: {msg}"),
            // The reference's `RevisionArchived` messages, byte for byte
            // (`spec/surface` §2: the CLI prints them).
            Error::RevisionArchived {
                rev,
                archive,
                path: None,
            } => write!(
                f,
                "revision {} is archived in segment {archive}, which is not attached (omg history attach <file>)",
                serde_json::Value::String(rev.clone())
            ),
            Error::RevisionArchived {
                rev,
                archive,
                path: Some(path),
            } => write!(
                f,
                "revision {} is archived in segment {archive} at {path}, which is not on disk",
                serde_json::Value::String(rev.clone())
            ),
            Error::NotASegment { path, detail } => write!(f, "{path}: {detail}"),
            Error::StaleSegment { path, rev } => write!(
                f,
                "{path}: an unrecorded segment naming revision {rev}, which is not a live revision of this store — move the file out of the way"
            ),
            Error::RetentionPolicy(msg) => f.write_str(msg),
            Error::ExpiredCursor(e) => f.write_str(&e.message()),
            Error::Delta(msg) => write!(f, "delta: {msg}"),
            Error::HistoryWriterRequired => {
                f.write_str(crate::core::manifest::HISTORY_WRITER_REQUIRED_MESSAGE)
            }
            Error::HistoryUnavailable => {
                f.write_str(crate::core::manifest::HISTORY_UNAVAILABLE_MESSAGE)
            }
            Error::HistoryDisabled { .. } => {
                f.write_str(crate::core::manifest::HISTORY_DISABLED_MESSAGE)
            }
            Error::HistoryOutsideCoverage {
                rev, coverage_from, ..
            } => f.write_str(&crate::core::manifest::history_outside_coverage_message(
                rev,
                coverage_from,
            )),
            Error::HistoryPruned { rev, .. } => {
                f.write_str(&crate::core::manifest::history_pruned_message(rev))
            }
            Error::TargetMissingRevision { rev, doc } => write!(
                f,
                "no revision {} for document {}",
                serde_json::Value::String(rev.clone()),
                doc.as_deref().unwrap_or("?")
            ),
            Error::SemanticSwitchedOff => {
                f.write_str(crate::core::manifest::SEMANTIC_SWITCHED_OFF_MESSAGE)
            }
            Error::SemanticProviderMissing => {
                f.write_str(crate::core::manifest::SEMANTIC_PROVIDER_MISSING_MESSAGE)
            }
            Error::CaptureFailed { path, reason } => f.write_str(
                &crate::core::manifest::capture_failed_message(path.as_deref(), reason),
            ),
            Error::InjectedFault { site, pass } => {
                f.write_str(&crate::core::fault::injected_fault_message(*site, *pass))
            }
            Error::Other(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Sqlite(e) => Some(e),
            Error::Json(e) => Some(e),
            Error::Search(e) => Some(e),
            Error::Mutation(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Sqlite(e)
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Json(e)
    }
}

impl From<omgbase_search::Error> for Error {
    fn from(e: omgbase_search::Error) -> Self {
        Error::Search(e)
    }
}

impl From<omgbase_mutate::MutationError> for Error {
    fn from(e: omgbase_mutate::MutationError) -> Self {
        Error::Mutation(e)
    }
}

impl Error {
    /// [`Error::CaptureFailed`] with `path` filled in when the failing call
    /// did not know it (the transaction's owner names the member); any other
    /// error is returned as it is.
    #[must_use]
    pub fn at_path(self, path: &str) -> Self {
        match self {
            Error::CaptureFailed { path: None, reason } => Error::CaptureFailed {
                path: Some(path.to_owned()),
                reason,
            },
            other => other,
        }
    }

    /// The mutation error inside, if this is one.
    #[must_use]
    pub fn as_mutation(&self) -> Option<&omgbase_mutate::MutationError> {
        match self {
            Error::Mutation(e) => Some(e),
            _ => None,
        }
    }
}

/// `Result` with this crate's [`Error`].
pub type Result<T> = std::result::Result<T, Error>;
