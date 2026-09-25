//! The OQX value model.
//!
//! OQX semantics are defined over JSON-shaped data plus two JavaScript-isms the
//! reference implementation relies on and the conformance fixtures observe:
//!
//! * [`Value::Undefined`] — an absent property (`row.missing`), navigation off
//!   an absent value, or a projected expression that produced nothing. The
//!   scalar rules treat `Undefined` and `Null` as the same "absent" value for
//!   equality (`absent == absent` is true) and for sorting (absent sorts last
//!   in both directions), but they are distinct at the boundary: JSON
//!   canonicalization drops an `Undefined` object property and turns an
//!   `Undefined` array element into `null` (see `spec/oqx/README.md`).
//! * [`Value::Range`] — the runtime value of `lo..hi` / `lo...hi` / `..hi` /
//!   `lo..` and of the `range(s)` builtin. Primarily the right-hand side of
//!   `in`. Never appears in a query result.
//!
//! Numbers are `f64`, as in the reference (JavaScript has one number type).
//! Strings are UTF-8; the spec defines ordering and length by code point, so
//! implementations must not compare by UTF-16 code unit or by byte.
//!
//! Objects preserve insertion order (JavaScript property order), because
//! `entries()` and projection order observe it.

use std::fmt;

/// A dynamically typed OQX value. See the module docs for the two non-JSON
/// variants.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// JavaScript `undefined`: absent. Distinct from `Null` only at the JSON
    /// boundary; equal to it under the scalar rules.
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
    Array(Vec<Value>),
    Object(Object),
    Range(Box<Range>),
}

impl Value {
    /// `Undefined` or `Null` — the scalar rules' notion of "absent".
    pub fn is_absent(&self) -> bool {
        matches!(self, Value::Undefined | Value::Null)
    }

    /// Truthiness as the `where` clause and `!` see it (JavaScript rules):
    /// absent, `false`, `0`, `NaN`, and `""` are false; everything else,
    /// including empty arrays and objects, is true.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Undefined | Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::Str(s) => !s.is_empty(),
            Value::Array(_) | Value::Object(_) | Value::Range(_) => true,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(o) => Some(o),
            _ => None,
        }
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}
impl From<f64> for Value {
    fn from(n: f64) -> Self {
        Value::Number(n)
    }
}
impl From<i64> for Value {
    fn from(n: i64) -> Self {
        Value::Number(n as f64)
    }
}
impl From<i32> for Value {
    fn from(n: i32) -> Self {
        Value::Number(n as f64)
    }
}
impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Str(s.to_owned())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Str(s)
    }
}
impl From<Vec<Value>> for Value {
    fn from(a: Vec<Value>) -> Self {
        Value::Array(a)
    }
}
impl From<Object> for Value {
    fn from(o: Object) -> Self {
        Value::Object(o)
    }
}
impl From<Range> for Value {
    fn from(r: Range) -> Self {
        Value::Range(Box::new(r))
    }
}

/// An insertion-ordered string-keyed map (JavaScript object property order).
/// Small objects dominate, so this is a plain vector; `insert` on an existing
/// key overwrites in place and keeps the original position, as JavaScript does.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object {
    entries: Vec<(String, Value)>,
}

impl Object {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(n: usize) -> Self {
        Self { entries: Vec::with_capacity(n) }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    /// Insert or overwrite. Returns the previous value if the key existed.
    pub fn insert(&mut self, key: impl Into<String>, value: Value) -> Option<Value> {
        let key = key.into();
        if let Some(slot) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            return Some(std::mem::replace(&mut slot.1, value));
        }
        self.entries.push((key, value));
        None
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let i = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(i).1)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }

    pub fn values(&self) -> impl Iterator<Item = &Value> {
        self.entries.iter().map(|(_, v)| v)
    }
}

impl FromIterator<(String, Value)> for Object {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(iter: I) -> Self {
        let mut o = Object::new();
        for (k, v) in iter {
            o.insert(k, v);
        }
        o
    }
}

impl IntoIterator for Object {
    type Item = (String, Value);
    type IntoIter = std::vec::IntoIter<(String, Value)>;
    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

/// A Ruby-style range value: `lo..hi` (inclusive), `lo...hi` (exclusive end),
/// with either bound optional for the open-ended forms `..hi` / `lo..`.
/// Bounds are numbers or ISO-8601 date strings; a range never mixes domains
/// (the `range(s)` builtin yields `Null` for such strings).
#[derive(Clone, Debug, PartialEq)]
pub struct Range {
    pub lo: Option<Value>,
    pub hi: Option<Value>,
    pub exclusive_end: bool,
}

impl fmt::Display for Value {
    /// JavaScript `String(v)` semantics, which the `+` concatenation rule,
    /// `.lower()`/`.upper()`, and `matches()` observe: `undefined`, `null`,
    /// `true`, numbers without a trailing `.0`, arrays comma-joined, objects
    /// as `[object Object]`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Undefined => f.write_str("undefined"),
            Value::Null => f.write_str("null"),
            Value::Bool(b) => write!(f, "{b}"),
            Value::Number(n) => {
                if n.fract() == 0.0 && n.is_finite() && n.abs() < 1e21 {
                    write!(f, "{}", *n as i128)
                } else {
                    write!(f, "{n}")
                }
            }
            Value::Str(s) => f.write_str(s),
            Value::Array(a) => {
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        f.write_str(",")?;
                    }
                    if !v.is_absent() {
                        write!(f, "{v}")?;
                    }
                }
                Ok(())
            }
            Value::Object(_) => f.write_str("[object Object]"),
            Value::Range(r) => {
                if let Some(lo) = &r.lo {
                    write!(f, "{lo}")?;
                }
                f.write_str(if r.exclusive_end { "..." } else { ".." })?;
                if let Some(hi) = &r.hi {
                    write!(f, "{hi}")?;
                }
                Ok(())
            }
        }
    }
}
