//! The mutation error (`spec/mutate/README.md` §8): a code and a data object
//! whose listed fields (`op_index`, `block`, `current`, `retriable`, …) the
//! fixtures compare; the message is not pinned.

use std::fmt;

use serde_json::{Map, Value};

/// The §8 error codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    StaleExpectation,
    BlockMissing,
    TargetMissing,
    ParentMissing,
    DocMissing,
    CycleMove,
    NotContiguous,
    TypeMismatch,
    PathTaken,
    NodeNotEditable,
    StalePlan,
    PlanNotConvergent,
    SyncConflict,
}

impl ErrorCode {
    /// Every code, in the §8 order.
    pub const ALL: [ErrorCode; 13] = [
        ErrorCode::StaleExpectation,
        ErrorCode::BlockMissing,
        ErrorCode::TargetMissing,
        ErrorCode::ParentMissing,
        ErrorCode::DocMissing,
        ErrorCode::CycleMove,
        ErrorCode::NotContiguous,
        ErrorCode::TypeMismatch,
        ErrorCode::PathTaken,
        ErrorCode::NodeNotEditable,
        ErrorCode::StalePlan,
        ErrorCode::PlanNotConvergent,
        ErrorCode::SyncConflict,
    ];

    /// The spec's spelling.
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::StaleExpectation => "stale_expectation",
            ErrorCode::BlockMissing => "block_missing",
            ErrorCode::TargetMissing => "target_missing",
            ErrorCode::ParentMissing => "parent_missing",
            ErrorCode::DocMissing => "doc_missing",
            ErrorCode::CycleMove => "cycle_move",
            ErrorCode::NotContiguous => "not_contiguous",
            ErrorCode::TypeMismatch => "type_mismatch",
            ErrorCode::PathTaken => "path_taken",
            ErrorCode::NodeNotEditable => "node_not_editable",
            ErrorCode::StalePlan => "stale_plan",
            ErrorCode::PlanNotConvergent => "plan_not_convergent",
            ErrorCode::SyncConflict => "sync_conflict",
        }
    }

    /// The code for a spec spelling.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|c| c.as_str() == s)
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A refused mutation: the reference's `MutationError` (`code`, `message`,
/// `data`).
#[derive(Clone, Debug, PartialEq)]
pub struct MutationError {
    pub code: ErrorCode,
    pub message: String,
    /// The §8 data fields (`op_index`, `block`, `current`, `retriable`, …).
    pub data: Map<String, Value>,
}

impl MutationError {
    /// An error with no data.
    #[must_use]
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: Map::new(),
        }
    }

    /// An error with a data object.
    #[must_use]
    pub fn with_data(code: ErrorCode, message: impl Into<String>, data: Value) -> Self {
        let data = match data {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        Self {
            code,
            message: message.into(),
            data,
        }
    }

    /// `{ code, ...data }` — the wire shape (§9 `expect.steps[i].error`).
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert(
            "code".to_owned(),
            Value::String(self.code.as_str().to_owned()),
        );
        for (k, v) in &self.data {
            m.insert(k.clone(), v.clone());
        }
        Value::Object(m)
    }
}

impl fmt::Display for MutationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MutationError {}

/// `Result` with a [`MutationError`].
pub type Result<T> = std::result::Result<T, MutationError>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codes_round_trip() {
        for c in ErrorCode::ALL {
            assert_eq!(ErrorCode::parse(c.as_str()), Some(c));
        }
        assert_eq!(ErrorCode::parse("nope"), None);
        assert_eq!(ErrorCode::ALL.len(), 13);
    }

    #[test]
    fn wire_shape_flattens_data_under_code() {
        let e = MutationError::with_data(
            ErrorCode::BlockMissing,
            "block b_x not found",
            json!({ "op_index": 2, "block": "b_x" }),
        );
        assert_eq!(
            e.to_json(),
            json!({ "code": "block_missing", "op_index": 2, "block": "b_x" })
        );
        assert_eq!(e.to_string(), "block_missing: block b_x not found");
        let plain = MutationError::new(ErrorCode::CycleMove, "x");
        assert_eq!(plain.to_json(), json!({ "code": "cycle_move" }));
    }
}
