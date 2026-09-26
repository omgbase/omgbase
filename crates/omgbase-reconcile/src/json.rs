//! The fixture shape of `spec/reconcile` (§9) as `serde_json` values, behind
//! the `json` feature: what a store persists for `detail` and what the
//! conformance runner compares (before canonicalizing minted ids).

use serde_json::{Map, Value, json};

use crate::types::{Detail, DetailValue, Disposition, ReconcileResult};

impl From<&DetailValue> for Value {
    fn from(v: &DetailValue) -> Self {
        match v {
            DetailValue::Str(s) => Value::String(s.clone()),
            DetailValue::Int(n) => Value::from(*n),
            DetailValue::Num(n) => Value::from(*n),
            DetailValue::List(items) => Value::Array(items.iter().map(Value::from).collect()),
            DetailValue::Map(m) => detail_to_json(m),
        }
    }
}

impl From<DetailValue> for Value {
    fn from(v: DetailValue) -> Self {
        Value::from(&v)
    }
}

/// A `detail` as a JSON object (keys sorted: `Detail` is a `BTreeMap`).
#[must_use]
pub fn detail_to_json(detail: &Detail) -> Value {
    Value::Object(
        detail
            .iter()
            .map(|(k, v)| (k.clone(), Value::from(v)))
            .collect::<Map<_, _>>(),
    )
}

impl Disposition {
    /// `{ block_id, kind, confidence, reason, matcher_v, detail }`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "block_id": self.block_id,
            "kind": self.kind.as_str(),
            "confidence": self.confidence,
            "reason": self.reason.map(|r| r.as_str()),
            "matcher_v": self.matcher_v,
            "detail": detail_to_json(&self.detail),
        })
    }
}

impl ReconcileResult {
    /// `{ assignment, dispositions, deleted, consumed_pool }` with the ids as
    /// assigned (a fixture's `expect` additionally canonicalizes minted ids
    /// to `new:<key>`, sorts the dispositions and drops `matcher_v`; §9).
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "assignment": self.assignment,
            "dispositions": self.dispositions.iter().map(Disposition::to_json).collect::<Vec<_>>(),
            "deleted": self.deleted,
            "consumed_pool": self.consumed_pool,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DispositionKind, Reason, detail};

    #[test]
    fn shapes() {
        let d = Disposition {
            block_id: "b_1".to_owned(),
            kind: DispositionKind::Edited,
            confidence: Some(0.75),
            reason: Some(Reason::Scored),
            matcher_v: "m2.1".to_owned(),
            detail: detail([(
                "near_misses",
                DetailValue::List(vec![DetailValue::Map(detail([
                    ("blockId", DetailValue::Str("b_2".to_owned())),
                    ("score", DetailValue::Num(0.6)),
                ]))]),
            )]),
        };
        assert_eq!(
            d.to_json(),
            json!({
                "block_id": "b_1", "kind": "edited", "confidence": 0.75, "reason": "scored",
                "matcher_v": "m2.1",
                "detail": { "near_misses": [{ "blockId": "b_2", "score": 0.6 }] }
            })
        );
        let inserted = Disposition {
            block_id: "n".to_owned(),
            kind: DispositionKind::Inserted,
            confidence: None,
            reason: None,
            matcher_v: "m2.1".to_owned(),
            detail: Detail::new(),
        };
        assert_eq!(inserted.to_json()["confidence"], Value::Null);
        assert_eq!(inserted.to_json()["reason"], Value::Null);
        assert_eq!(inserted.to_json()["detail"], json!({}));
        assert_eq!(Value::from(DetailValue::Int(3)), json!(3));
        let res = ReconcileResult::default();
        assert_eq!(
            res.to_json(),
            json!({ "assignment": {}, "dispositions": [], "deleted": [], "consumed_pool": [] })
        );
    }
}
