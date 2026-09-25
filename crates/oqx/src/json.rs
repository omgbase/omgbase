//! Conversions between [`Value`] and `serde_json::Value` (feature `json`).
//!
//! JSON → OQX is lossless: `null` → [`Value::Null`], numbers → `f64`, and
//! objects keep their key order (the crate enables `serde_json`'s
//! `preserve_order` feature, so a parsed document's insertion order is the
//! order `entries()` and projection observe, as the spec requires).
//!
//! OQX → JSON applies the spec's result canonicalization
//! (`spec/oqx/README.md`, "Result canonicalization"), which is
//! `JSON.stringify` behavior:
//!
//! * [`Value::Undefined`] as an **object property is dropped**; as an **array
//!   element or the top-level value it becomes `null`**.
//! * Integer-valued numbers serialize without a fraction (`2`, not `2.0`);
//!   `-0` becomes `0`. A non-finite number becomes `null`, exactly as
//!   `JSON.stringify(NaN)` does — the spec forbids such a result, so a
//!   conformance runner must check finiteness *before* converting.
//! * [`Value::Range`] never appears in a result, so it has no JSON form; it
//!   maps to `null` rather than failing, so the conversion stays infallible.

use serde_json::{Map, Value as Json};

use crate::value::{Object, Value};

impl From<Json> for Value {
    fn from(j: Json) -> Self {
        match j {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(b),
            Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => Value::Str(s),
            Json::Array(a) => Value::Array(a.into_iter().map(Value::from).collect()),
            Json::Object(o) => {
                Value::Object(o.into_iter().map(|(k, v)| (k, Value::from(v))).collect())
            }
        }
    }
}

impl From<&Json> for Value {
    fn from(j: &Json) -> Self {
        match j {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
            Json::String(s) => Value::Str(s.clone()),
            Json::Array(a) => Value::Array(a.iter().map(Value::from).collect()),
            Json::Object(o) => {
                Value::Object(o.iter().map(|(k, v)| (k.clone(), Value::from(v))).collect())
            }
        }
    }
}

impl From<&Value> for Json {
    /// The spec's canonical JSON form; see the module docs.
    fn from(v: &Value) -> Self {
        match v {
            // Top-level (or array-element) `undefined` → null. Object
            // properties are handled in the `Object` arm, which drops them.
            Value::Undefined | Value::Null => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Number(n) => number_to_json(*n),
            Value::Str(s) => Json::String(s.clone()),
            Value::Array(a) => Json::Array(a.iter().map(Json::from).collect()),
            Value::Object(o) => Json::Object(object_to_json(o)),
            // Ranges never appear in results (spec); `null` keeps this total.
            Value::Range(_) => Json::Null,
        }
    }
}

impl From<Value> for Json {
    fn from(v: Value) -> Self {
        Json::from(&v)
    }
}

impl Value {
    /// Build a [`Value`] from a JSON document (`null` → `Null`, never
    /// `Undefined`; object key order preserved).
    pub fn from_json(j: Json) -> Value {
        Value::from(j)
    }

    /// The spec's canonical JSON form of a result: `Undefined` properties
    /// dropped, `Undefined` elements / top-level → `null`, integral numbers
    /// without a fraction. See the module docs.
    pub fn to_canonical_json(&self) -> Json {
        Json::from(self)
    }
}

fn object_to_json(o: &Object) -> Map<String, Json> {
    let mut m = Map::with_capacity(o.len());
    for (k, v) in o.iter() {
        if !matches!(v, Value::Undefined) {
            m.insert(k.to_owned(), Json::from(v));
        }
    }
    m
}

/// `JSON.stringify` for a number: integral values (including `-0`) as
/// integers, other finite values as doubles, non-finite as `null`.
fn number_to_json(n: f64) -> Json {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_992.0; // 2^53
    if n.fract() == 0.0 && n.abs() < MAX_SAFE_INTEGER {
        // `-0.0 as i64` is 0, which is what `JSON.stringify(-0)` prints.
        Json::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Json::Null, Json::Number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Range;
    use serde_json::json;

    fn obj(pairs: &[(&str, Value)]) -> Value {
        Value::Object(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
    }

    #[test]
    fn json_to_value_scalars() {
        assert_eq!(Value::from(json!(null)), Value::Null);
        assert_eq!(Value::from(json!(true)), Value::Bool(true));
        assert_eq!(Value::from(json!(3)), Value::Number(3.0));
        assert_eq!(Value::from(json!(2.5)), Value::Number(2.5));
        assert_eq!(Value::from(json!(-7)), Value::Number(-7.0));
        assert_eq!(Value::from(json!("s")), Value::Str("s".into()));
        assert_eq!(
            Value::from_json(json!([1, null])),
            Value::Array(vec![Value::Number(1.0), Value::Null])
        );
    }

    #[test]
    fn json_to_value_preserves_object_order() {
        let j: Json = serde_json::from_str(r#"{"z":1,"a":2,"m":{"y":0,"b":1}}"#).unwrap();
        let v = Value::from(&j);
        let o = v.as_object().unwrap();
        assert_eq!(o.keys().collect::<Vec<_>>(), ["z", "a", "m"]);
        let inner = o.get("m").unwrap().as_object().unwrap();
        assert_eq!(inner.keys().collect::<Vec<_>>(), ["y", "b"]);
        // The owning conversion agrees with the borrowing one.
        assert_eq!(Value::from(j), v);
    }

    #[test]
    fn value_to_json_drops_undefined_properties_and_nulls_elements() {
        let v = obj(&[
            ("keep", Value::Number(1.0)),
            ("gone", Value::Undefined),
            ("nul", Value::Null),
            (
                "arr",
                Value::Array(vec![Value::Undefined, Value::Number(2.0)]),
            ),
            (
                "nested",
                obj(&[("gone", Value::Undefined), ("ok", Value::Bool(true))]),
            ),
        ]);
        assert_eq!(
            v.to_canonical_json(),
            json!({"keep": 1, "nul": null, "arr": [null, 2], "nested": {"ok": true}})
        );
        assert_eq!(Json::from(Value::Undefined), Json::Null);
        assert_eq!(
            Json::from(Value::Array(vec![Value::Undefined])),
            json!([null])
        );
    }

    #[test]
    fn value_to_json_keeps_key_order() {
        let v = obj(&[("z", Value::Number(1.0)), ("a", Value::Number(2.0))]);
        assert_eq!(v.to_canonical_json().to_string(), r#"{"z":1,"a":2}"#);
    }

    #[test]
    fn value_to_json_numbers_stringify_like_javascript() {
        assert_eq!(Json::from(Value::Number(2.0)).to_string(), "2");
        assert_eq!(Json::from(Value::Number(-0.0)).to_string(), "0");
        assert_eq!(Json::from(Value::Number(2.5)).to_string(), "2.5");
        assert_eq!(Json::from(Value::Number(-3.0)).to_string(), "-3");
        assert_eq!(Json::from(Value::Number(1e300)).as_f64(), Some(1e300));
        assert_eq!(Json::from(Value::Number(f64::NAN)), Json::Null);
        assert_eq!(Json::from(Value::Number(f64::INFINITY)), Json::Null);
    }

    #[test]
    fn range_has_no_json_form() {
        let r = Value::from(Range {
            lo: Some(Value::Number(1.0)),
            hi: None,
            exclusive_end: false,
        });
        assert_eq!(Json::from(r), Json::Null);
    }

    #[test]
    fn round_trip_of_plain_json_is_identity() {
        let j = json!({"b": [1, 2.5, "x", null, {"q": false}], "a": {"z": 0, "y": [-1]}});
        assert_eq!(Json::from(Value::from(j.clone())), j);
    }
}
