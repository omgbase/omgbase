//! An in-memory optimizing planner: it hash-indexes a named root collection on
//! chosen fields and, for a query whose where-clause contains equality
//! predicates on those fields, answers from the index (candidate intersection)
//! instead of a full scan. Everything it can't turn into an index probe is left
//! as a residual query the in-memory engine finishes over the candidate rows.
//! Port of `packages/oqx/src/adapters/indexed.ts`.
//!
//! This is the smallest honest demonstration of plan optimization: same answers
//! as a naive scan, far fewer rows examined, and partial-pushdown correctness
//! via the residual.
//!
//! # Index keys
//!
//! The reference keys its buckets by the raw field value in a JS `Map`
//! (SameValueZero). [`Value`] is neither `Hash` nor `Eq` (it holds `f64`), so
//! buckets here are keyed by a canonical string, [`index_key`], chosen so that
//! two values share a key iff OQX `==` ([`crate::semantics::equals`]) holds
//! between them — which is exactly what makes an index probe give the same
//! rows as the scan it replaces:
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
//! field is or contains `NaN` is never found by a probe, and a probe for `NaN`
//! finds nothing.
//!
//! Two consequences differ from the reference, in the direction of agreeing
//! with the in-memory engine: `field == null` finds rows whose field is
//! absent or `null` alike (the reference's `Map` keeps `null` and `undefined`
//! apart), and object-valued fields match structurally rather than by
//! reference.

use std::collections::HashMap;

use crate::ast::Query;
use crate::context::{DataContext, DefaultContext};
use crate::plan::{as_equality, const_value, partition_pushable, residual_query};
use crate::planner::{Plan, QueryPlanner};
use crate::value::Value;

/// A named root collection hash-indexed on chosen fields; see the module docs.
#[derive(Clone, Debug)]
pub struct IndexedCollection {
    name: String,
    rows: Vec<Value>,
    /// field → index key → positions in `rows`, ascending (built in row order).
    indexes: HashMap<String, HashMap<String, Vec<usize>>>,
}

impl IndexedCollection {
    /// Index `rows` (exposed as root `name`) on each field in `index_fields`.
    /// A field is read off each row exactly as the default context would
    /// (object property; array element for an integer-spelled name); a row
    /// without it is indexed under the absent key.
    pub fn new(name: impl Into<String>, rows: Vec<Value>, index_fields: &[&str]) -> Self {
        let reader = DefaultContext::default();
        let mut indexes = HashMap::with_capacity(index_fields.len());
        for &field in index_fields {
            let mut idx: HashMap<String, Vec<usize>> = HashMap::new();
            for (pos, row) in rows.iter().enumerate() {
                if let Some(key) = index_key(&reader.get(row, field)) {
                    idx.entry(key).or_default().push(pos);
                }
            }
            indexes.insert(field.to_owned(), idx);
        }
        Self {
            name: name.into(),
            rows,
            indexes,
        }
    }

    /// The root name this collection answers for.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The indexed rows, in their original order.
    pub fn rows(&self) -> &[Value] {
        &self.rows
    }

    /// True when `field` has an index.
    pub fn is_indexed(&self, field: &str) -> bool {
        self.indexes.contains_key(field)
    }

    /// The rows whose `field` equals `value` (under OQX `==`), in row order,
    /// or `None` when `field` is not indexed.
    fn probe(&self, field: &str, value: &Value) -> Option<&[usize]> {
        let idx = self.indexes.get(field)?;
        let positions = index_key(value)
            .and_then(|key| idx.get(&key))
            .map_or(&[][..], Vec::as_slice);
        Some(positions)
    }
}

impl QueryPlanner for IndexedCollection {
    fn plan(&self, query: &Query, params: &[Value]) -> Option<Plan> {
        match &query.source {
            crate::ast::Expr::Ident { name } if *name == self.name => {}
            _ => return None,
        }
        if !query.from.is_empty() || query.follow.is_some() {
            return None;
        }

        let (pushed, residual) = partition_pushable(query.r#where.as_ref(), |e| {
            as_equality(e).is_some_and(|eq| self.is_indexed(eq.field))
        });
        if pushed.is_empty() {
            return None; // no index probe available — let the scan handle it
        }

        // Intersect the candidate sets from each indexed equality.
        let mut candidate: Option<Vec<usize>> = None;
        for e in &pushed {
            let eq = as_equality(e).expect("pushed conjuncts are indexed equalities");
            let value = const_value(eq.value, params).expect("an equality's value side is const");
            let bucket = self
                .probe(eq.field, &value)
                .expect("pushed conjuncts are indexed equalities");
            candidate = Some(match candidate {
                None => bucket.to_vec(),
                Some(current) => intersect(&current, bucket),
            });
        }
        let rows = candidate
            .unwrap_or_default()
            .into_iter()
            .map(|pos| self.rows[pos].clone())
            .collect();
        Some(Plan::new(rows, residual_query(query, residual)))
    }
}

/// Intersection of two ascending position lists, ascending.
fn intersect(a: &[usize], b: &[usize]) -> Vec<usize> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{parse_string, parse_template};
    use crate::semantics::equals;
    use crate::value::Range;

    fn num(n: f64) -> Value {
        Value::Number(n)
    }

    fn s(x: &str) -> Value {
        Value::Str(x.to_owned())
    }

    fn obj(pairs: &[(&str, Value)]) -> Value {
        Value::Object(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
    }

    fn employees() -> Vec<Value> {
        let emp = |id: f64, name: &str, dept: &str, level: f64, city: &str| {
            obj(&[
                ("id", num(id)),
                ("name", s(name)),
                ("dept", s(dept)),
                ("level", num(level)),
                ("city", s(city)),
            ])
        };
        vec![
            emp(1.0, "Bob", "eng", 5.0, "NYC"),
            emp(2.0, "Alice", "eng", 7.0, "SF"),
            emp(3.0, "Carol", "sales", 4.0, "NYC"),
            emp(4.0, "Dave", "eng", 3.0, "SF"),
        ]
    }

    fn ids(rows: &[Value]) -> Vec<f64> {
        rows.iter()
            .map(|r| r.as_object().unwrap().get("id").unwrap().as_f64().unwrap())
            .collect()
    }

    // ---- the reference's direct plan-inspection test -------------------------

    #[test]
    fn answers_an_equality_from_the_index_not_a_scan() {
        let idx = IndexedCollection::new("emp", employees(), &["dept", "city"]);
        // Only the eng rows are produced (index probe), and the equality
        // predicate is fully consumed (no residual where).
        let q = parse_string("name from emp where dept == \"eng\"").unwrap();
        let plan = idx
            .plan(&q, &[])
            .expect("planner should handle an indexed equality");
        assert_eq!(ids(&plan.rows), [1.0, 2.0, 4.0]);
        assert_eq!(plan.residual.r#where, None);
        assert!(plan.context.is_none());
    }

    #[test]
    fn rows_examined_shrinks_with_each_intersected_probe() {
        let idx = IndexedCollection::new("emp", employees(), &["dept", "city"]);
        let q = parse_string("name from emp where dept == \"eng\"").unwrap();
        assert_eq!(idx.plan(&q, &[]).unwrap().rows.len(), 3);

        let q = parse_string("name from emp where dept == \"eng\" && city == \"SF\"").unwrap();
        let plan = idx.plan(&q, &[]).unwrap();
        assert_eq!(ids(&plan.rows), [2.0, 4.0], "row order is preserved");
        assert_eq!(plan.residual.r#where, None);

        // Residual conjuncts do not reduce the produced rows; they run later.
        let q = parse_string("name from emp where city == \"NYC\" && level >= 5").unwrap();
        let plan = idx.plan(&q, &[]).unwrap();
        assert_eq!(ids(&plan.rows), [1.0, 3.0]);
        assert!(plan.residual.r#where.is_some(), "level >= 5 is residual");

        // Empty intersection produces no rows at all.
        let q = parse_string("name from emp where dept == \"sales\" && city == \"SF\"").unwrap();
        assert!(idx.plan(&q, &[]).unwrap().rows.is_empty());
    }

    #[test]
    fn probe_values_come_from_bindings_too() {
        let idx = IndexedCollection::new("emp", employees(), &["dept"]);
        let q = parse_template(&["name from emp where ", " == dept"], 1).unwrap();
        let plan = idx.plan(&q, &[s("sales")]).unwrap();
        assert_eq!(ids(&plan.rows), [3.0]);
        // A missing binding reads as undefined, which matches nothing here.
        assert!(idx.plan(&q, &[]).unwrap().rows.is_empty());
    }

    #[test]
    fn declines_what_it_cannot_optimize() {
        let idx = IndexedCollection::new("emp", employees(), &["dept"]);
        let decline = |src: &str| {
            let q = parse_string(src).unwrap();
            assert!(idx.plan(&q, &[]).is_none(), "{src}");
        };
        decline("name from emp where level >= 5"); // no indexed equality
        decline("name from emp where city == \"SF\""); // city is not indexed
        decline("name from other where dept == \"eng\""); // another root
        // A top-level `from` re-projection (an AST-level shape; the parser admits
        // one `from`, so build it directly).
        let mut q = parse_string("name from emp where dept == \"eng\"").unwrap();
        q.from.push(crate::ast::Expr::Ident {
            name: "reports".to_owned(),
        });
        assert!(idx.plan(&q, &[]).is_none(), "re-projection");
        decline("name from emp where dept == \"eng\" follow manager"); // follow
        decline("name from emp where dept == \"eng\" || dept == \"sales\""); // disjunction
        decline("name from emp where !(dept == \"eng\")"); // negation
        decline("name from emp where dept != \"eng\""); // not an equality
        decline("name from emp where dept == \"e\" + \"ng\""); // not a constant
        decline("name from emp"); // no where
    }

    #[test]
    fn rows_without_the_field_land_under_the_absent_key() {
        let rows = vec![
            obj(&[("id", num(1.0)), ("tag", Value::Null)]),
            obj(&[("id", num(2.0))]),
            obj(&[("id", num(3.0)), ("tag", s("x"))]),
            num(4.0), // not an object: no fields at all
        ];
        let idx = IndexedCollection::new("t", rows, &["tag"]);
        let q = parse_string("id from t where tag == null").unwrap();
        let plan = idx.plan(&q, &[]).unwrap();
        assert_eq!(plan.rows.len(), 3);
        assert_eq!(ids(&plan.rows[..2]), [1.0, 2.0]);
        assert_eq!(plan.rows[2], num(4.0));
    }

    #[test]
    fn accessors() {
        let idx = IndexedCollection::new("emp", employees(), &["dept"]);
        assert_eq!(idx.name(), "emp");
        assert_eq!(idx.rows().len(), 4);
        assert!(idx.is_indexed("dept"));
        assert!(!idx.is_indexed("city"));
    }

    // ---- the key scheme ------------------------------------------------------

    fn range(lo: Option<Value>, hi: Option<Value>, exclusive_end: bool) -> Value {
        Value::Range(Box::new(Range {
            lo,
            hi,
            exclusive_end,
        }))
    }

    #[test]
    fn keys_are_distinct_across_types_and_stable_within() {
        assert_eq!(index_key(&num(5.0)), Some("n5".to_owned()));
        assert_eq!(index_key(&s("5")), Some("s5".to_owned()));
        assert_eq!(index_key(&Value::Bool(true)), Some("t".to_owned()));
        assert_eq!(index_key(&Value::Bool(false)), Some("f".to_owned()));
        assert_eq!(index_key(&Value::Null), Some("_".to_owned()));
        assert_eq!(index_key(&Value::Undefined), Some("_".to_owned()));
        assert_eq!(index_key(&num(-0.0)), index_key(&num(0.0)));
        assert_eq!(index_key(&num(1.5)), Some("n1.5".to_owned()));
        assert_eq!(index_key(&num(f64::NAN)), None);
        assert_eq!(index_key(&Value::Array(vec![num(f64::NAN)])), None);
        assert_ne!(index_key(&s("true")), index_key(&Value::Bool(true)));
        assert_ne!(index_key(&s("null")), index_key(&Value::Null));
        assert_ne!(index_key(&s("")), index_key(&Value::Null));
    }

    #[test]
    fn nested_keys_are_injective_and_ignore_object_key_order() {
        let a = Value::Array(vec![num(1.0), s("x")]);
        assert_eq!(index_key(&a), Some("a[2:n12:sx]".to_owned()));
        // `[1, "x"]` vs `["1x"]` vs `[1, "x", …]`: length prefixes keep them apart.
        assert_ne!(index_key(&a), index_key(&Value::Array(vec![s("1x")])));
        assert_ne!(
            index_key(&Value::Array(vec![s("a,b")])),
            index_key(&Value::Array(vec![s("a"), s("b")]))
        );
        assert_ne!(index_key(&Value::Array(vec![])), index_key(&obj(&[])));
        assert_ne!(
            index_key(&Value::Array(vec![s("_")])),
            index_key(&Value::Array(vec![Value::Null]))
        );

        let o1 = obj(&[("a", num(1.0)), ("b", Value::Null)]);
        let o2 = obj(&[("b", Value::Undefined), ("a", num(1.0))]);
        assert_eq!(index_key(&o1), index_key(&o2));
        assert_eq!(index_key(&o1), Some("o{1:a=2:n11:b=1:_}".to_owned()));
        assert_ne!(index_key(&obj(&[("a", num(1.0))])), index_key(&o1));
        assert_ne!(
            index_key(&obj(&[("a=1", num(1.0))])),
            index_key(&obj(&[("a", s("1"))]))
        );

        let r = range(Some(num(1.0)), Some(num(2.0)), true);
        assert_eq!(index_key(&r), Some("rx2:n12:n2".to_owned()));
        assert_ne!(
            index_key(&r),
            index_key(&range(Some(num(1.0)), Some(num(2.0)), false))
        );
        assert_eq!(
            index_key(&range(None, Some(num(2.0)), false)),
            Some("ri-2:n2".to_owned())
        );
    }

    #[test]
    fn key_equality_agrees_with_oqx_equality() {
        let samples = vec![
            Value::Undefined,
            Value::Null,
            Value::Bool(true),
            Value::Bool(false),
            num(0.0),
            num(-0.0),
            num(1.0),
            num(1.5),
            s(""),
            s("1"),
            s("true"),
            s("null"),
            Value::Array(vec![]),
            Value::Array(vec![num(1.0)]),
            Value::Array(vec![s("1")]),
            Value::Array(vec![num(1.0), num(1.0)]),
            obj(&[]),
            obj(&[("a", num(1.0))]),
            obj(&[("a", num(1.0)), ("b", Value::Null)]),
            obj(&[("b", Value::Undefined), ("a", num(1.0))]),
            range(Some(num(1.0)), Some(num(2.0)), true),
            range(Some(num(1.0)), Some(num(2.0)), false),
            range(Some(num(1.0)), None, false),
        ];
        for x in &samples {
            for y in &samples {
                let kx = index_key(x).expect("no NaN in samples");
                let ky = index_key(y).expect("no NaN in samples");
                assert_eq!(kx == ky, equals(x, y), "{x:?} vs {y:?}: {kx} / {ky}");
            }
        }
    }

    #[test]
    fn intersect_is_an_ordered_merge() {
        assert_eq!(intersect(&[0, 1, 3, 5], &[1, 2, 3, 6]), [1, 3]);
        assert_eq!(intersect(&[], &[1]), Vec::<usize>::new());
        assert_eq!(intersect(&[1], &[]), Vec::<usize>::new());
        assert_eq!(intersect(&[2, 4], &[2, 4]), [2, 4]);
    }
}
