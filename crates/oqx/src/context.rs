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
    /// is `Value::Undefined`; the engine never looks elsewhere for it.
    fn get(&self, row: &Value, key: &str) -> Value;

    /// Coerce a relation/source value into rows.
    fn to_rows(&self, value: &Value) -> Vec<Value>;

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
}

impl DataContext for DefaultContext {
    fn root(&self, name: &str) -> Value {
        self.roots.get(name).cloned().unwrap_or(Value::Undefined)
    }

    fn get(&self, row: &Value, key: &str) -> Value {
        match row {
            Value::Object(o) => o.get(key).cloned().unwrap_or(Value::Undefined),
            Value::Array(a) => match key.parse::<usize>() {
                Ok(i) if key == i.to_string() => a.get(i).cloned().unwrap_or(Value::Undefined),
                _ => Value::Undefined,
            },
            _ => Value::Undefined,
        }
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
