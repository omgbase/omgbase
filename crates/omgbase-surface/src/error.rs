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

    /// The reference's `FilterInvalid(reason, hint)`: `filter_invalid` with
    /// `{ reason, hint }` — the `reason` is the message itself, the `hint`
    /// the caller's pointer (`"OQX"` for an engine error).
    #[must_use]
    pub fn filter_invalid(message: impl Into<String>, hint: &str) -> Self {
        let message = message.into();
        Self::with_data(
            "filter_invalid",
            message.clone(),
            json!({ "reason": message, "hint": hint }),
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

    /// A cursor refused for a named cause (§1.4, 2.0: a 1.x cursor whose path
    /// is not `/`-rooted): the message carries the reason, so does `data`.
    #[must_use]
    pub fn cursor_invalid_reason(reason: &str) -> Self {
        Self::with_data(
            "filter_invalid",
            format!("invalid cursor: {reason}"),
            json!({
                "reason": reason,
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
            omgbase_store::Error::InvalidEffect(m) => Self::filter_invalid(m, "arguments"),
            // `spec/surface` §2 (4.9): a read of an archived revision whose
            // segment is not attached or not on disk — `{ rev, archive,
            // path? }`, `path` only when the segment is recorded.
            // `spec/surface` §3 (6.0): a `changes_since` cursor the feed no
            // longer serves — `expired_cursor { epoch, oldest, head }`, never
            // retriable, the message pinned (`data.epoch` names an argument).
            omgbase_store::Error::ExpiredCursor(x) => {
                Self::with_data("expired_cursor", x.message(), x.data())
            }
            // `spec/store` §5.4 step 0 (17.0, 3e-ii — resolution 17): a
            // writer without the history module refused by
            // `writer_requires` — `capability_unavailable { capability:
            // "history", state: "unavailable" }`, retriable (an engine that
            // carries the module can), the reference's message byte for byte.
            omgbase_store::Error::HistoryWriterRequired => {
                let mut e = Self::with_data(
                    "capability_unavailable",
                    omgbase_store::HISTORY_WRITER_REQUIRED_MESSAGE,
                    json!({ "capability": "history", "state": "unavailable" }),
                );
                e.retriable = true;
                e
            }
            e @ omgbase_store::Error::RevisionArchived { .. } => {
                let message = e.to_string();
                let omgbase_store::Error::RevisionArchived { rev, archive, path } = e else {
                    unreachable!("matched above");
                };
                let mut data = Map::new();
                data.insert("rev".to_owned(), Value::String(rev));
                data.insert("archive".to_owned(), Value::String(archive));
                if let Some(p) = path {
                    data.insert("path".to_owned(), Value::String(p));
                }
                Self::with_data("revision_archived", message, Value::Object(data))
            }
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
            omgbase_sync::Error::FeedExpired {
                epoch,
                oldest,
                head,
                message,
            } => Self::with_data(
                "expired_cursor",
                message,
                json!({ "epoch": epoch, "oldest": oldest, "head": head }),
            ),
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
        assert_eq!(j["data"]["reason"], "bad");
        assert_eq!(j["data"]["hint"], "OQX");
        assert_eq!(j["retriable"], false);
        let plain = SurfaceError::other("boom").to_json();
        assert!(plain.get("data").is_none());
        assert_eq!(plain["error"], "repo_not_found");
    }

    #[test]
    fn revision_archived_carries_rev_archive_and_an_optional_path() {
        let e = SurfaceError::from(omgbase_store::Error::RevisionArchived {
            rev: "r_1".into(),
            archive: "s_0".into(),
            path: None,
        });
        assert_eq!(e.code, "revision_archived");
        assert_eq!(
            e.message,
            "revision \"r_1\" is archived in segment s_0, which is not attached (omg history attach <file>)"
        );
        assert_eq!(e.data, Some(json!({ "rev": "r_1", "archive": "s_0" })));
        let e = SurfaceError::from(omgbase_store::Error::RevisionArchived {
            rev: "r_1".into(),
            archive: "s_0".into(),
            path: Some("/x/s.db".into()),
        });
        assert_eq!(
            e.message,
            "revision \"r_1\" is archived in segment s_0 at /x/s.db, which is not on disk"
        );
        assert_eq!(e.data.unwrap()["path"], "/x/s.db");
    }

    #[test]
    fn expired_cursor_carries_the_position_and_is_never_retriable() {
        let e = SurfaceError::from(omgbase_store::Error::ExpiredCursor(
            omgbase_store::ExpiredCursor {
                cursor: 1,
                given: "ep_0".into(),
                epoch: "ep_0".into(),
                oldest: 3,
                head: 4,
            },
        ));
        assert_eq!(e.code, "expired_cursor");
        assert!(!e.retriable);
        assert_eq!(
            e.message,
            "cursor 1 of epoch ep_0 has expired — the feed now begins at (ep_0, 3); rescan the repository and resume from head 4"
        );
        assert_eq!(
            e.data,
            Some(json!({ "epoch": "ep_0", "oldest": 3, "head": 4 }))
        );
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
