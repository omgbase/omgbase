//! A hash index over the rows of one collection, keyed under OQX equality
//! (SEMANTICS §5) — the only key discipline that makes an index probe return
//! exactly the rows a `local == value` scan would keep. Port of
//! `packages/oqx/src/optimize/hash-index.ts`; the key scheme is this crate's
//! own ([`index_key`], formerly in `adapters::indexed`), because a [`Value`]
//! is neither `Hash` nor `Eq` and this crate's `equals` is structural where
//! the reference's is by reference.
//!
//! # Index keys
//!
//! Buckets are keyed by a canonical string chosen so that two values share a
//! key iff [`crate::semantics::equals`] holds between them:
//!
//! | value | key |
//! | --- | --- |
//! | `Undefined`, `Null` | `_` (absent ≡ absent under `==`) |
//! | `Bool` | `t` / `f` |
//! | `Number` | `n` + the number's [`Display`](std::fmt::Display) (`-0` is `0`, so it meets `0`) |
//! | `Str` | `s` + the string (the prefix keeps `"5"` apart from `5`) |
//! | `Array` | `a[` + each element as `<len>:<key>` + `]` |
//! | `Object` | `o{` + entries sorted by name, each `<len>:<name>=<len>:<key>` + `}` |
//! | `Range` | `r` + `i`/`x` (inclusive/exclusive end) + lo and hi as `<len>:<key>` or `-` |
//!
//! Nested keys are length-prefixed so the encoding is injective without
//! escaping. `NaN` has no key (`NaN == NaN` is false): a row whose indexed
//! value is or contains `NaN` is never indexed, and a probe for `NaN` finds
//! nothing. Buckets hold row positions in ascending order, so a probe yields
//! rows in the receiver's order (§3, §13).

use std::collections::HashMap;

use crate::errors::Result;
use crate::value::Value;

/// A pre-built equality index a [`crate::DataContext`] may expose for a
/// collection (see `DataContext::index_for`): `lookup(value)` returns the
/// ascending positions, into `to_rows(collection)` in order, of the rows whose
/// key equals `value` under §5.
///
/// `lookup_rows`, when implemented (`Some`), answers the same probe with the
/// ROWS themselves — exactly the rows `lookup(value)` would select, in
/// receiver order — without the engine ever materializing
/// `to_rows(collection)`. A store-backed context implements it over its own
/// indexes (one indexed statement per probe); the engine prefers it for a
/// statically stable receiver, so the collection is never read whole. An
/// `Err` is the query's error (as an `Err` from `get` is).
pub trait RowIndex {
    fn lookup(&self, value: &Value) -> Vec<usize>;
    fn lookup_rows(&self, value: &Value) -> Option<Result<Vec<Value>>> {
        let _ = value;
        None
    }
}

/// The engine's own [`RowIndex`]: `add` every row's key in row order, then probe.
#[derive(Clone, Debug, Default)]
pub struct HashIndex {
    buckets: HashMap<String, Vec<usize>>,
    count: usize,
}

impl HashIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that the row at `position` has key `value`. Positions must be
    /// added in ascending order (row order). A `NaN` key is not indexed.
    pub fn add(&mut self, value: &Value, position: usize) {
        if let Some(key) = index_key(value) {
            self.buckets.entry(key).or_default().push(position);
            self.count += 1;
        }
    }

    /// How many rows were indexed (rows whose key is or contains `NaN` are not).
    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// The ascending positions of the rows whose key equals `value` (§5), as
    /// a borrowed slice — what [`RowIndex::lookup`] copies.
    pub fn positions(&self, value: &Value) -> &[usize] {
        index_key(value)
            .and_then(|key| self.buckets.get(&key))
            .map_or(&[][..], Vec::as_slice)
    }
}

impl RowIndex for HashIndex {
    fn lookup(&self, value: &Value) -> Vec<usize> {
        self.positions(value).to_vec()
    }
}

/// The canonical index key of a value — see the module docs for the scheme.
/// `None` when the value is or contains `NaN`, which equals nothing.
pub fn index_key(v: &Value) -> Option<String> {
    let mut out = String::new();
    push_key(v, &mut out).then_some(out)
}

fn push_key(v: &Value, out: &mut String) -> bool {
    match v {
        Value::Undefined | Value::Null => out.push('_'),
        Value::Bool(true) => out.push('t'),
        Value::Bool(false) => out.push('f'),
        Value::Number(n) => {
            if n.is_nan() {
                return false;
            }
            out.push('n');
            out.push_str(&v.to_string());
        }
        Value::Str(s) => {
            out.push('s');
            out.push_str(s);
        }
        Value::Array(items) => {
            out.push_str("a[");
            for item in items {
                if !push_nested(item, out) {
                    return false;
                }
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut entries: Vec<(&str, &Value)> = o.iter().collect();
            entries.sort_by_key(|(a, _)| *a);
            out.push_str("o{");
            for (name, value) in entries {
                out.push_str(&name.len().to_string());
                out.push(':');
                out.push_str(name);
                out.push('=');
                if !push_nested(value, out) {
                    return false;
                }
            }
            out.push('}');
        }
        Value::Range(r) => {
            out.push('r');
            out.push(if r.exclusive_end { 'x' } else { 'i' });
            for bound in [&r.lo, &r.hi] {
                match bound {
                    None => out.push('-'),
                    Some(b) => {
                        if !push_nested(b, out) {
                            return false;
                        }
                    }
                }
            }
        }
    }
    true
}

/// Append `v`'s key as `<byte length>:<key>`.
fn push_nested(v: &Value, out: &mut String) -> bool {
    let mut inner = String::new();
    if !push_key(v, &mut inner) {
        return false;
    }
    out.push_str(&inner.len().to_string());
    out.push(':');
    out.push_str(&inner);
    true
}

/// Intersection of two ascending position lists, ascending.
pub fn intersect_positions(a: &[usize], b: &[usize]) -> Vec<usize> {
    let mut out = Vec::with_capacity(a.len().min(b.len()));
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn num(n: f64) -> Value {
        Value::Number(n)
    }

    #[test]
    fn buckets_follow_equality_and_keep_row_order() {
        let mut idx = HashIndex::new();
        let keys = [
            num(1.0),
            Value::Null,
            num(-0.0),
            Value::Undefined,
            num(0.0),
            num(f64::NAN),
            num(1.0),
        ];
        for (i, k) in keys.iter().enumerate() {
            idx.add(k, i);
        }
        assert_eq!(idx.len(), 6, "the NaN row is not indexed");
        assert_eq!(idx.positions(&num(1.0)), &[0, 6]);
        assert_eq!(idx.lookup(&Value::Null), vec![1, 3]);
        assert_eq!(idx.positions(&Value::Undefined), &[1, 3]);
        assert_eq!(idx.positions(&num(0.0)), &[2, 4]);
        assert_eq!(idx.positions(&num(-0.0)), &[2, 4]);
        assert!(idx.positions(&num(f64::NAN)).is_empty());
        assert!(idx.lookup(&Value::Str("1".to_owned())).is_empty());
    }

    #[test]
    fn intersect_is_an_ordered_merge() {
        assert_eq!(intersect_positions(&[0, 1, 3, 5], &[1, 2, 3, 6]), [1, 3]);
        assert_eq!(intersect_positions(&[], &[1]), Vec::<usize>::new());
        assert_eq!(intersect_positions(&[1], &[]), Vec::<usize>::new());
        assert_eq!(intersect_positions(&[2, 4], &[2, 4]), [2, 4]);
    }
}
