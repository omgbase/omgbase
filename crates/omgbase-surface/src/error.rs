//! The error envelope (`spec/surface/README.md` §4): `{ error, message,
//! data?, retriable }`. Every failure a tool can report is one of these;
//! `spec/mutate` §8 codes come through unchanged, an OQX or cursor failure is
//! `filter_invalid`, and anything unexpected is `repo_not_found` with its
//! message (§9, pinned).

use std::fmt;

use serde_json::{Map, Value, json};

/// A surfaced failure.
#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceError {
    /// The code (`filter_invalid`, `doc_missing`, …).
    pub code: String,
    pub message: String,
    /// The `data` member, when any.
    pub data: Option<Value>,
    pub retriable: bool,
}

impl SurfaceError {
    #[must_use]
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            data: None,
            retriable: false,
        }
    }

    #[must_use]
    pub fn with_data(code: &str, message: impl Into<String>, data: Value) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            data: Some(data),
            retriable: false,
        }
    }

    /// The reference's `FilterInvalid`: `filter_invalid` with `{ reason, hint }`.
    #[must_use]
    pub fn filter_invalid(message: impl Into<String>, reason: &str) -> Self {
        let message = message.into();
        Self::with_data(
            "filter_invalid",
            message,
            json!({ "reason": reason, "hint": "see query_syntax" }),
        )
    }

    /// The reference's `CursorInvalid`: a cursor `surface` did not issue.
    #[must_use]
    pub fn cursor_invalid(surface: &str) -> Self {
        Self::with_data(
            "filter_invalid",
            "invalid cursor",
            json!({
                "reason": format!("cursor was not issued by {surface}"),
                "hint": "resume only with a `cursor` returned by a truncated page of the same tool",
            }),
        )
    }

    /// `repo_not_found` — also the catch-all (§9).
    #[must_use]
    pub fn other(message: impl Into<String>) -> Self {
        Self::new("repo_not_found", message)
    }

    /// The wire envelope.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("error".to_owned(), Value::String(self.code.clone()));
        m.insert("message".to_owned(), Value::String(self.message.clone()));
        if let Some(d) = &self.data {
            m.insert("data".to_owned(), d.clone());
        }
        m.insert("retriable".to_owned(), Value::Bool(self.retriable));
        Value::Object(m)
    }
}

impl fmt::Display for SurfaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SurfaceError {}

impl From<omgbase_store::Error> for SurfaceError {
    fn from(e: omgbase_store::Error) -> Self {
        match e {
            omgbase_store::Error::Mutation(m) => Self::from(m),
            omgbase_store::Error::Search(s) => Self::new(s.code(), s.to_string()),
            other => Self::other(other.to_string()),
        }
    }
}

impl From<omgbase_store::MutationError> for SurfaceError {
    fn from(m: omgbase_store::MutationError) -> Self {
        let retriable = m
            .data
            .get("retriable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Self {
            code: m.code.as_str().to_owned(),
            message: m.message,
            data: Some(Value::Object(m.data)),
            retriable,
        }
    }
}

impl From<omgbase_sync::Error> for SurfaceError {
    fn from(e: omgbase_sync::Error) -> Self {
        match e {
            omgbase_sync::Error::Store(s) => Self::from(s),
            omgbase_sync::Error::RepoNotFound {
                message,
                candidates,
            } => Self::with_data(
                "repo_not_found",
                message,
                json!({ "candidates": candidates }),
            ),
            other => Self::other(other.to_string()),
        }
    }
}

impl From<rusqlite::Error> for SurfaceError {
    fn from(e: rusqlite::Error) -> Self {
        Self::other(format!("sqlite: {e}"))
    }
}

impl From<oqx::OqxError> for SurfaceError {
    /// An OQX error is `filter_invalid` with the engine's message (§1.4).
    fn from(e: oqx::OqxError) -> Self {
        Self::filter_invalid(e.message, "OQX")
    }
}

/// `Result` with this crate's error.
pub type Result<T> = std::result::Result<T, SurfaceError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_shape() {
        let e = SurfaceError::filter_invalid("bad", "OQX");
        let j = e.to_json();
        assert_eq!(j["error"], "filter_invalid");
        assert_eq!(j["message"], "bad");
        assert_eq!(j["data"]["reason"], "OQX");
        assert_eq!(j["retriable"], false);
        let plain = SurfaceError::other("boom").to_json();
        assert!(plain.get("data").is_none());
        assert_eq!(plain["error"], "repo_not_found");
    }

    #[test]
    fn mutation_errors_keep_code_and_data() {
        let m = omgbase_store::MutationError::with_data(
            omgbase_store::mutate_kernel::ErrorCode::StaleExpectation,
            "stale",
            json!({ "block": "b_1", "retriable": true }),
        );
        let e = SurfaceError::from(omgbase_store::Error::from(m));
        assert_eq!(e.code, "stale_expectation");
        assert!(e.retriable);
        assert_eq!(e.data.unwrap()["block"], "b_1");
    }
}
