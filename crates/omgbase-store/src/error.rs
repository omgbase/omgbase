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
