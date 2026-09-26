//! The crate's error type: the provider failures of `spec/search` §5.

use std::fmt;

/// What can go wrong talking to an embedding provider.
#[derive(Debug)]
pub enum Error {
    /// No provider is configured (`semantic_unavailable`).
    SemanticUnavailable,
    /// The provider could not be spawned, failed its handshake, or answered
    /// outside the protocol (`embedder_failed`).
    EmbedderFailed(String),
    /// The provider process or endpoint could not be reached.
    Io(std::io::Error),
    /// A protocol line or body was not the JSON the protocol expects.
    Json(serde_json::Error),
}

impl Error {
    /// The stable error code the engine reports (`spec/search` §5).
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Error::SemanticUnavailable => "semantic_unavailable",
            Error::EmbedderFailed(_) | Error::Io(_) | Error::Json(_) => "embedder_failed",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::SemanticUnavailable => f.write_str("no embedding provider configured"),
            Error::EmbedderFailed(msg) => f.write_str(msg),
            Error::Io(e) => write!(f, "embedder io: {e}"),
            Error::Json(e) => write!(f, "embedder protocol: {e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            Error::Json(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Json(e)
    }
}

/// `Result` with this crate's [`Error`].
pub type Result<T> = std::result::Result<T, Error>;
