//! The crate's error type.

use std::fmt;
use std::path::PathBuf;

/// Everything that can go wrong around a sync.
#[derive(Debug)]
pub enum Error {
    /// The store refused (SQLite, a bad timestamp, …).
    Store(omgbase_store::Error),
    /// A filesystem operation failed.
    Io {
        what: String,
        path: PathBuf,
        source: std::io::Error,
    },
    /// A JSON column or protocol line did not parse.
    Json(serde_json::Error),
    /// `spec/sync` §1: no repo matched; `candidates` are the slugs that exist.
    RepoNotFound {
        message: String,
        candidates: Vec<String>,
    },
    /// §5: the adapter could not be spawned.
    AdapterSpawn { command: String, message: String },
    /// §5: the adapter exited before answering.
    AdapterExited { command: String },
    /// §5: the handshake was missing, unparsable or not protocol 1.
    AdapterHandshake { command: String, line: String },
    /// §5: the adapter answered a request with `{"error": …}`.
    AdapterError { method: String, message: String },
    /// A method the source's capabilities do not include (`write`/`remove`
    /// without `writeThrough`, `watch` without `watch`).
    Unsupported(String),
    /// §7: the writer lock stayed held past the timeout.
    WriterLockTimeout {
        lock_path: PathBuf,
        holder_pid: Option<i64>,
    },
    /// Anything else, with a message.
    Other(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Store(e) => write!(f, "store: {e}"),
            Error::Io { what, path, source } => write!(f, "{what} {}: {source}", path.display()),
            Error::Json(e) => write!(f, "json: {e}"),
            Error::RepoNotFound { message, .. } => f.write_str(message),
            Error::AdapterSpawn { command, message } => {
                write!(f, "sync adapter '{command}' failed to spawn: {message}")
            }
            Error::AdapterExited { command } => {
                write!(f, "sync adapter '{command}' exited early")
            }
            Error::AdapterHandshake { command, line } => {
                let shown: String = line.chars().take(120).collect();
                write!(
                    f,
                    "sync adapter '{command}' sent an invalid handshake: {shown}"
                )
            }
            Error::AdapterError { method, message } => {
                write!(f, "sync adapter error ({method}): {message}")
            }
            Error::Unsupported(what) => write!(f, "the source does not support {what}"),
            Error::WriterLockTimeout {
                lock_path,
                holder_pid,
            } => write!(
                f,
                "could not acquire writer lock {} (held by pid {})",
                lock_path.display(),
                holder_pid.map_or_else(|| "?".to_owned(), |p| p.to_string())
            ),
            Error::Other(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Store(e) => Some(e),
            Error::Io { source, .. } => Some(source),
            Error::Json(e) => Some(e),
            _ => None,
        }
    }
}

impl From<omgbase_store::Error> for Error {
    fn from(e: omgbase_store::Error) -> Self {
        Error::Store(e)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Store(omgbase_store::Error::Sqlite(e))
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Json(e)
    }
}

impl Error {
    /// An [`Error::Io`] for `what` at `path`.
    pub(crate) fn io(what: &str, path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Error::Io {
            what: what.to_owned(),
            path: path.into(),
            source,
        }
    }
}

/// `Result` with this crate's [`Error`].
pub type Result<T> = std::result::Result<T, Error>;
