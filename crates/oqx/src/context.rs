//! The tier-2 seam: a [`DataContext`] binds OQX's query semantics to a concrete
//! data model. The engine never reaches into host data directly — it asks the
//! context to resolve named roots, read properties/relations, coerce a relation
//! result into rows, compute identity (for `follow` dedup and `distinct` over
//! unprojected rows), and optionally supply custom scalar functions/methods.
//! The same query semantics then run over plain values, a lazy store-backed
//! graph, or a remote API without changing the engine.
//!
//! (Performant execution over a real store is the tier-3 seam — see
//! [`crate::planner`] — which pushes work into the store instead of driving it
//! row by row here.)

use crate::Result;
use std::rc::Rc;

use crate::optimize::hash_index::RowIndex;
use crate::regex_dialect::RegexDialect;
use crate::semantics::{builtin_function, builtin_method_with, coerce_collection};
use crate::value::{Object, Value};

pub trait DataContext {
    /// Resolve a named root (the `from <name>` source / directive receiver).
    /// Unknown names are `Value::Undefined`.
    fn root(&self, name: &str) -> Value;

    /// Read a property/relation off a row: a bare identifier (`field`), a
    /// `.field` segment, or a `^field` outer reference all come through here,
    /// each against exactly the row of the scope it names. An absent property
    /// is `Ok(Value::Undefined)`; the engine never looks elsewhere for it.
    ///
    /// The error channel is the host's: an `Err` (an eval-stage
    /// [`crate::OqxError`], see [`crate::OqxError::eval`]) aborts the query and
    /// is returned from `run` exactly like a thrown error from the reference's
    /// `get` — a context can reject a reserved name or surface a failed store
    /// read at the point it happens instead of stashing it for after the run.
    /// A context that never fails wraps its value in `Ok`;
    /// [`DefaultContext::read`] is the plain-value read to delegate to.
    fn get(&self, row: &Value, key: &str) -> Result<Value>;

    /// Coerce a relation/source value into rows.
    fn to_rows(&self, value: &Value) -> Vec<Value>;

    /// Optional: a value this context handed out as a stand-in for a
    /// collection it has not read yet (a lazy table handle), resolved to what
    /// it stands for. The engine calls it on every value it is about to observe
    /// AS A VALUE — an operand of `==`/`in`/arithmetic, a function or method
    /// argument, a projected item, an `order by` or `distinct` key, a `where`
    /// scalar, a lift — and never on a value it reads in ROW POSITION (the
    /// query source, a block receiver, a body-level `from`, a `follow`
    /// destination), which goes to [`DataContext::to_rows`] and
    /// [`DataContext::index_for`] as the context handed it out, so a
    /// store-backed context can answer a probe on the handle without reading the
    /// table and still never lets the stand-in be seen by the language. The
    /// default is the identity (a context whose values are what they are).
    fn materialize(&self, value: Value) -> Value {
        value
    }

    /// Identity of a row for `follow` cycle detection / dedup and for
    /// `distinct` over unprojected rows.
    fn identity(&self, row: &Value) -> Value;

    /// Optional custom free function. `None` = not handled: the engine falls
    /// back to the builtin table, then errors if that has no such function.
    fn call_function(&self, name: &str, args: &[Value]) -> Option<Result<Value>> {
        let _ = (name, args);
        None
    }

    /// Optional custom method (`recv.name(args)`). `None` = not handled, as
    /// for [`DataContext::call_function`].
    fn call_method(&self, name: &str, recv: &Value, args: &[Value]) -> Option<Result<Value>> {
        let _ = (name, recv, args);
        None
    }

    /// The regex dialect `matches()` compiles against. [`RegexDialect::Oqx`]
    /// (the default) is the portable baseline the spec tests;
    /// [`RegexDialect::Native`] hands the pattern to the `regex` crate as is —
    /// implementation-defined, not portable. The engine dispatches `matches`
    /// through [`DataContext::call_method`], so this is read by the context's
    /// own `matches` ([`DefaultContext`] does, via
    /// [`crate::semantics::builtin_method_with`]); plain
    /// [`crate::semantics::builtin_method`] is always the baseline.
    fn regex_dialect(&self) -> RegexDialect {
        RegexDialect::Oqx
    }

    /// Optional: a pre-built equality index over `collection` (a value this
    /// context served as a root or relation) on the property path `path`
    /// (`["customer_id"]`, `["meta", "id"]`; an empty path keys by the row
    /// itself). The engine asks before building its own [`crate::optimize::HashIndex`]
    /// for a correlated equality in a nested block (`where id == ^customer_id`);
    /// `None` (the default) lets it build one. `lookup(value)` must return the
    /// ascending positions, into `to_rows(collection)` in order, of the rows
    /// whose value at `path` equals `value` under OQX equality (SEMANTICS §5).
    /// An index may also implement [`RowIndex::lookup_rows`]: the engine then
    /// probes it for a statically stable receiver BEFORE reading the
    /// collection, which is never materialized when the index answers.
    /// [`crate::adapters::indexed::IndexedContext`] implements the positional
    /// form. The `Rc` lets a context create indexes on demand.
    fn index_for(&self, collection: &Value, path: &[String]) -> Option<Rc<dyn RowIndex + '_>> {
        let _ = (collection, path);
        None
    }
}

/// The default context: plain [`Value`]s. Named roots come from an [`Object`]
/// map; properties are object keys (and array indices spelled as integers);
/// identity is the `id` property when present, else the row itself
/// (structural identity — the spec's rule; the reference uses reference
/// identity for id-less objects, which has no portable meaning).
#[derive(Clone, Debug, Default)]
pub struct DefaultContext {
    roots: Object,
    regex_dialect: RegexDialect,
}

impl DefaultContext {
    pub fn new(roots: Object) -> Self {
        Self {
            roots,
            regex_dialect: RegexDialect::Oqx,
        }
    }

    /// Opt `matches()` into a regex dialect (see [`DataContext::regex_dialect`]).
    pub fn with_regex_dialect(mut self, dialect: RegexDialect) -> Self {
        self.regex_dialect = dialect;
        self
    }

    pub fn roots(&self) -> &Object {
        &self.roots
    }

    /// The plain-value property read [`DataContext::get`] performs for
    /// [`DefaultContext`]: an object's own key, an array's element for an
    /// integer-spelled key (`"0"`, `"1"`, …), otherwise `Value::Undefined`
    /// (primitives have no properties). It cannot fail, so a custom context
    /// that only adds computed keys can fall back to it:
    ///
    /// ```
    /// use oqx::{DataContext, DefaultContext, Result, Value};
    ///
    /// struct Computed;
    /// impl DataContext for Computed {
    ///     fn root(&self, _name: &str) -> Value { Value::Undefined }
    ///     fn get(&self, row: &Value, key: &str) -> Result<Value> {
    ///         if key == "shout" {
    ///             return Ok(match DefaultContext::read(row, "name") {
    ///                 Value::Str(s) => Value::Str(s.to_uppercase()),
    ///                 _ => Value::Undefined,
    ///             });
    ///         }
    ///         Ok(DefaultContext::read(row, key))
    ///     }
    ///     fn to_rows(&self, v: &Value) -> Vec<Value> { DefaultContext::default().to_rows(v) }
    ///     fn identity(&self, row: &Value) -> Value { DefaultContext::default().identity(row) }
    /// }
    /// ```
    pub fn read(row: &Value, key: &str) -> Value {
        match row {
            Value::Object(o) => o.get(key).cloned().unwrap_or(Value::Undefined),
            Value::Array(a) => match key.parse::<usize>() {
                Ok(i) if key == i.to_string() => a.get(i).cloned().unwrap_or(Value::Undefined),
                _ => Value::Undefined,
            },
            _ => Value::Undefined,
        }
    }
}

impl DataContext for DefaultContext {
    fn root(&self, name: &str) -> Value {
        self.roots.get(name).cloned().unwrap_or(Value::Undefined)
    }

    fn get(&self, row: &Value, key: &str) -> Result<Value> {
        Ok(Self::read(row, key))
    }

    fn to_rows(&self, value: &Value) -> Vec<Value> {
        coerce_collection(value).into_owned()
    }

    fn identity(&self, row: &Value) -> Value {
        if let Value::Object(o) = row {
            if let Some(id) = o.get("id") {
                return id.clone();
            }
        }
        row.clone()
    }

    fn call_function(&self, name: &str, args: &[Value]) -> Option<Result<Value>> {
        builtin_function(name, args)
    }

    fn call_method(&self, name: &str, recv: &Value, args: &[Value]) -> Option<Result<Value>> {
        builtin_method_with(self.regex_dialect, name, recv, args)
    }

    fn regex_dialect(&self) -> RegexDialect {
        self.regex_dialect
    }
}
