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
//! The same indexes serve the engine's correlated probes: [`IndexedCollection::context`]
//! is a [`DataContext`] that resolves the root and answers
//! [`DataContext::index_for`] from them, so a nested `^emp first { where id ==
//! ^manager_id }` probes the pre-built index instead of building one per run.
//! The planner's own plans carry that context too, so a residual's nested
//! blocks still see the root.
//!
//! Buckets are [`HashIndex`]es keyed under OQX equality (see
//! [`crate::optimize::hash_index`] for the key scheme, formerly this module's):
//! `field == null` finds rows whose field is absent or `null` alike, and
//! object-valued fields match structurally — exactly what the in-memory
//! engine's `==` does in this crate.

use std::collections::HashMap;
use std::rc::Rc;

use crate::Result;
use crate::ast::Query;
use crate::context::{DataContext, DefaultContext};
use crate::optimize::hash_index::{HashIndex, RowIndex, intersect_positions};
use crate::plan::{ROWS_ROOT, as_equality, const_value, partition_pushable, residual_query};
use crate::planner::{Plan, QueryPlanner};
use crate::regex_dialect::RegexDialect;
use crate::semantics::equals;
use crate::value::{Object, Value};

pub use crate::optimize::hash_index::index_key;

/// A named root collection hash-indexed on chosen fields; see the module docs.
#[derive(Clone, Debug)]
pub struct IndexedCollection {
    name: String,
    rows: Vec<Value>,
    /// field → index over `rows` (shared with the engine through `index_for`).
    indexes: HashMap<String, Rc<HashIndex>>,
}

impl IndexedCollection {
    /// Index `rows` (exposed as root `name`) on each field in `index_fields`.
    /// A field is read off each row exactly as the default context would
    /// ([`DefaultContext::read`]: object property; array element for an
    /// integer-spelled name); a row without it is indexed under the absent key.
    pub fn new(name: impl Into<String>, rows: Vec<Value>, index_fields: &[&str]) -> Self {
        let mut indexes = HashMap::with_capacity(index_fields.len());
        for &field in index_fields {
            let mut idx = HashIndex::new();
            for (pos, row) in rows.iter().enumerate() {
                idx.add(&DefaultContext::read(row, field), pos);
            }
            indexes.insert(field.to_owned(), Rc::new(idx));
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

    /// The pre-built index for `collection` on `path` when `collection` is
    /// this collection's rows (a [`Value`] has no identity, so the array is
    /// compared structurally — once per run per block, cheaper than the index
    /// it saves) and `path` is one indexed field. The [`DataContext::index_for`]
    /// seam, which [`IndexedCollection::context`] wires up.
    pub fn index_for(&self, collection: &Value, path: &[String]) -> Option<Rc<dyn RowIndex>> {
        let [field] = path else { return None };
        let idx = self.indexes.get(field)?;
        match collection {
            Value::Array(items)
                if items.len() == self.rows.len()
                    && items.iter().zip(&self.rows).all(|(a, b)| equals(a, b)) =>
            {
                Some(Rc::clone(idx) as Rc<dyn RowIndex>)
            }
            _ => None,
        }
    }

    /// A [`DataContext`] over plain values that serves this collection as the
    /// root `name` (plus `extra_roots`) and exposes the indexes through
    /// [`DataContext::index_for`], so the engine's correlated probes reuse them.
    pub fn context(&self, extra_roots: Object) -> IndexedContext {
        let mut roots = extra_roots;
        roots.insert(self.name.clone(), Value::Array(self.rows.clone()));
        IndexedContext {
            owner: self.clone(),
            inner: DefaultContext::new(roots),
        }
    }

    /// The rows whose `field` equals `value` (under OQX `==`), in row order,
    /// or `None` when `field` is not indexed.
    fn probe(&self, field: &str, value: &Value) -> Option<&[usize]> {
        Some(self.indexes.get(field)?.positions(value))
    }
}

/// The context [`IndexedCollection::context`] returns: a [`DefaultContext`]
/// over the collection's root that answers [`DataContext::index_for`] from the
/// collection's indexes.
#[derive(Clone, Debug)]
pub struct IndexedContext {
    owner: IndexedCollection,
    inner: DefaultContext,
}

impl DataContext for IndexedContext {
    fn root(&self, name: &str) -> Value {
        self.inner.root(name)
    }

    fn get(&self, row: &Value, key: &str) -> Result<Value> {
        self.inner.get(row, key)
    }

    fn to_rows(&self, value: &Value) -> Vec<Value> {
        self.inner.to_rows(value)
    }

    fn identity(&self, row: &Value) -> Value {
        self.inner.identity(row)
    }

    fn call_function(&self, name: &str, args: &[Value]) -> Option<Result<Value>> {
        self.inner.call_function(name, args)
    }

    fn call_method(&self, name: &str, recv: &Value, args: &[Value]) -> Option<Result<Value>> {
        self.inner.call_method(name, recv, args)
    }

    fn regex_dialect(&self) -> RegexDialect {
        self.inner.regex_dialect()
    }

    fn index_for(&self, collection: &Value, path: &[String]) -> Option<Rc<dyn RowIndex + '_>> {
        self.owner.index_for(collection, path)
    }
}

impl QueryPlanner for IndexedCollection {
    fn plan(&self, query: &Query, params: &[Value]) -> Option<Plan> {
        match &query.source {
            crate::ast::Expr::Ident { name, .. } if *name == self.name => {}
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

        // Intersect the candidate sets from each indexed equality (smallest first).
        let mut buckets: Vec<&[usize]> = pushed
            .iter()
            .map(|e| {
                let eq = as_equality(e).expect("pushed conjuncts are indexed equalities");
                let value =
                    const_value(eq.value, params).expect("an equality's value side is const");
                self.probe(eq.field, &value)
                    .expect("pushed conjuncts are indexed equalities")
            })
            .collect();
        buckets.sort_by_key(|b| b.len());
        let mut candidate = buckets[0].to_vec();
        for bucket in &buckets[1..] {
            if candidate.is_empty() {
                break;
            }
            candidate = intersect_positions(&candidate, bucket);
        }
        let rows: Vec<Value> = candidate
            .into_iter()
            .map(|pos| self.rows[pos].clone())
            .collect();
        let mut extra = Object::with_capacity(1);
        extra.insert(ROWS_ROOT, Value::Array(rows.clone()));
        Some(Plan::new(rows, residual_query(query, residual)).with_context(self.context(extra)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{parse_string, parse_template};

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
        // the plan carries the collection's context: a residual's nested blocks
        // see the root (and the indexes through `index_for`)
        let ctx = plan.context.as_ref().expect("plan context");
        assert_eq!(ctx.root("emp").as_array().map(<[Value]>::len), Some(4));
        assert!(
            ctx.index_for(&ctx.root("emp"), &["dept".to_owned()])
                .is_some()
        );
        assert!(
            ctx.index_for(&ctx.root("emp"), &["level".to_owned()])
                .is_none()
        );
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
            span: crate::ast::Span::EMPTY,
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
}
