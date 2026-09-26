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

/// `Result` with this crate's [`Error`].
pub type Result<T> = std::result::Result<T, Error>;
