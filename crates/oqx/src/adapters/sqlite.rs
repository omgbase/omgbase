//! A real storage adapter (feature `sqlite`): pushes the flat core of an OQX
//! query — the source scan, the translatable conjunctive predicates, and a
//! `LIMIT` for an unordered `first`/`single` — into SQL over a
//! [`rusqlite::Connection`], and leaves everything it cannot translate (nested
//! consumer ops, `follow`, negation/disjunction at the where level, method
//! calls like `matches()`, `in`, member navigation, custom functions) as a
//! residual the in-memory engine finishes over the rows SQL returned. Port of
//! `packages/oqx/src/adapters/sqlite.ts`.
//!
//! Semantics note, inherited from the reference: OQX equality is typed and
//! strict (see [`crate::semantics`]). SQL `=` uses column affinity and SQL
//! comparisons against `NULL` are `NULL` (never true), so this adapter assumes
//! a well-typed schema for the columns it pushes — `NOT NULL` columns of the
//! declared type; anything it cannot translate faithfully stays residual.
//!
//! # What is pushed
//!
//! A top-level `where` conjunct (see [`partition_pushable`]) is pushed when its
//! whole expression is translatable:
//!
//! | OQX | SQL |
//! | --- | --- |
//! | literal, `${…}` binding | `?` — bound as a parameter, never spliced as text |
//! | bare `column` (declared) | `"table"."column"` |
//! | `a == b`, `a != b` | `(a = b)`, `(a <> b)` |
//! | `a < b`, `<=`, `>`, `>=` | `(a < b)`, … |
//! | `a + b`, `-`, `*`, `/`, `%` | `(a + b)`, … |
//! | `!a`, `-a` | `(NOT a)`, `(-a)` |
//! | `a && b`, `a \|\| b` (as a scalar expression) | `(a AND b)`, `(a OR b)` |
//!
//! Everything else — `^outer`, `$value`, `.member`, calls, `in`, ranges, and an
//! identifier that is not a declared column — makes the conjunct residual.
//! The statement is always `SELECT * FROM "table"`, optionally `WHERE` the
//! pushed conjuncts joined by `AND`, and `LIMIT 1` / `LIMIT 2` for an unordered
//! `first` / `single` when nothing is residual and the query has no
//! `limit`/`offset` of its own (the residual applies those, and a SQL `LIMIT`
//! underneath would starve them).
//!
//! # Values
//!
//! Bound parameters follow `node:sqlite`'s binding of JavaScript values:
//! absent (`Undefined`/`Null`) → `NULL`, `Bool` → `1`/`0`, `Number` → `REAL`
//! (JavaScript numbers are doubles; SQLite compares `INTEGER` and `REAL`
//! numerically), `Str` → `TEXT`, and anything else (array, object, range) →
//! its `String(v)` text ([`Value`]'s `Display`).
//!
//! Result columns map the other way: `INTEGER`/`REAL` → `Number`, `TEXT` →
//! `Str` (invalid UTF-8 is replaced, not rejected), `NULL` → `Null`, and
//! `BLOB` → an `Array` of byte `Number`s (the reference yields a `Uint8Array`,
//! which has no `Value` counterpart; a JSON-shaped byte list is the closest).
//!
//! # Deviations from the reference
//!
//! * Options are builder methods ([`SqliteTable::json_columns`],
//!   [`SqliteTable::map`]) rather than an options record.
//! * `json_columns` parses with `serde_json` (the `sqlite` feature implies
//!   `json`). Where the reference's `JSON.parse` would throw on malformed
//!   text, the text is left as the string it was.
//! * `plan()` has no error channel, so a SQL failure (a misdeclared table or
//!   column, an I/O error) panics with the statement and the error — the
//!   analogue of the reference's throw. [`SqliteTable::try_plan`] returns the
//!   [`rusqlite::Error`] instead for callers who want to handle it.
//! * Column references are table-qualified (`"emp"."level"`, where the
//!   reference emits `"level"`). A bare double-quoted name that matches no
//!   column is, by SQLite's legacy fallback, silently read as a *string
//!   literal* — so a misdeclared column would compare as text and match
//!   rows instead of failing. A qualified name can never be a string, so the
//!   same mistake is a "no such column" error. Identifiers are quoted with
//!   embedded `"` doubled, so a name containing a quote cannot break out.
//! * [`SqliteTable::compile`] exposes the SQL, parameters, and residual a
//!   query produces without running it.

use std::collections::HashSet;
use std::fmt;

pub use rusqlite;
use rusqlite::Connection;
use rusqlite::types::{Value as SqlValue, ValueRef};

use crate::ast::{BinaryOp, Consumer, Expr, LogicalOp, Query, UnaryOp};
use crate::plan::{partition_pushable, residual_query};
use crate::planner::{Plan, QueryPlanner};
use crate::value::{Object, Value};

type RowMapper = Box<dyn Fn(Object) -> Value>;

/// A [`QueryPlanner`] over one SQLite table; see the module docs.
pub struct SqliteTable<'c> {
    db: &'c Connection,
    table: String,
    /// Columns that map to bare OQX fields (only these are pushable).
    columns: HashSet<String>,
    /// Columns whose stored text is parsed as JSON back into row values.
    json_columns: Vec<String>,
    /// Custom mapper from a raw SQL row to a query row (overrides `json_columns`).
    map: Option<RowMapper>,
}

/// What a query compiles to, before it runs — see [`SqliteTable::compile`].
#[derive(Clone, Debug, PartialEq)]
pub struct Compiled {
    /// The statement, with `?` placeholders.
    pub sql: String,
    /// The bound parameters, in placeholder order.
    pub params: Vec<SqlValue>,
    /// The query to finish in-memory over the rows the statement returns.
    pub residual: Query,
}

impl<'c> SqliteTable<'c> {
    /// A planner for `table` on `db`, pushing predicates over `columns` only.
    /// The rows it produces carry every column of the table (`SELECT *`);
    /// `columns` gates what is pushable, not what is returned.
    pub fn new<S: AsRef<str>>(db: &'c Connection, table: impl Into<String>, columns: &[S]) -> Self {
        Self {
            db,
            table: table.into(),
            columns: columns.iter().map(|c| c.as_ref().to_owned()).collect(),
            json_columns: Vec::new(),
            map: None,
        }
    }

    /// Columns whose stored text should be parsed as JSON back into row values
    /// (ignored when a [`SqliteTable::map`] is set, as in the reference).
    pub fn json_columns<S: AsRef<str>>(mut self, columns: &[S]) -> Self {
        self.json_columns = columns.iter().map(|c| c.as_ref().to_owned()).collect();
        self
    }

    /// A custom mapper from a raw SQL row (column → value) to a query row.
    /// Overrides `json_columns`.
    pub fn map(mut self, map: impl Fn(Object) -> Value + 'static) -> Self {
        self.map = Some(Box::new(map));
        self
    }

    /// The table this planner answers for (as the root name in `from`).
    pub fn table(&self) -> &str {
        &self.table
    }

    /// True when `name` is a declared (pushable) column.
    pub fn is_column(&self, name: &str) -> bool {
        self.columns.contains(name)
    }

    /// The SQL, parameters, and residual `query` compiles to, or `None` when
    /// the planner declines it (another source, a `from` re-projection, or a
    /// `follow`). Nothing is executed.
    pub fn compile(&self, query: &Query, params: &[Value]) -> Option<Compiled> {
        match &query.source {
            Expr::Ident { name } if *name == self.table => {}
            _ => return None,
        }
        if !query.from.is_empty() || query.follow.is_some() {
            return None;
        }

        let (pushed, residual) =
            partition_pushable(query.r#where.as_ref(), |e| self.translatable(e));
        let mut sql_params = Vec::new();
        let where_sql = pushed
            .iter()
            .map(|e| self.translate(e, params, &mut sql_params))
            .collect::<Vec<_>>()
            .join(" AND ");

        // A LIMIT is only safe when nothing is left to filter in-memory, the
        // result is unordered (first/single are "some row" without an order
        // by), and the query carries no limit/offset of its own (the residual
        // applies those, so a SQL LIMIT underneath would starve them).
        let mut tail = "";
        if residual.is_none()
            && query.order_by.is_none()
            && query.limit.is_none()
            && query.offset.is_none()
        {
            tail = match query.consumer {
                Consumer::First => " LIMIT 1",
                Consumer::Single => " LIMIT 2",
                _ => "",
            };
        }

        let mut sql = format!("SELECT * FROM {}", quote_ident(&self.table));
        if !where_sql.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_sql);
        }
        sql.push_str(tail);
        Some(Compiled {
            sql,
            params: sql_params,
            residual: residual_query(query, residual),
        })
    }

    /// [`QueryPlanner::plan`] with the SQL error surfaced instead of panicking.
    pub fn try_plan(&self, query: &Query, params: &[Value]) -> rusqlite::Result<Option<Plan>> {
        let Some(compiled) = self.compile(query, params) else {
            return Ok(None);
        };
        let mut stmt = self.db.prepare(&compiled.sql)?;
        let names: Vec<String> = stmt
            .column_names()
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let mut rows = stmt.query(rusqlite::params_from_iter(compiled.params.iter()))?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let mut raw = Object::with_capacity(names.len());
            for (i, name) in names.iter().enumerate() {
                raw.insert(name.clone(), from_sql(row.get_ref(i)?));
            }
            out.push(self.map_row(raw));
        }
        Ok(Some(Plan::new(out, compiled.residual)))
    }

    fn translatable(&self, e: &Expr) -> bool {
        match e {
            Expr::Lit(_) | Expr::Binding { .. } => true,
            // A bare name is always the current row's column.
            Expr::Ident { name } => self.columns.contains(name),
            // Both unary ops (`!`, `-`) translate.
            Expr::Unary { expr, .. } => self.translatable(expr),
            Expr::Logical { left, right, .. } => {
                self.translatable(left) && self.translatable(right)
            }
            // Every binary op (comparison and arithmetic) translates.
            Expr::Binary { left, right, .. } => self.translatable(left) && self.translatable(right),
            // member/index/call/in/range/outer(^) → residual
            _ => false,
        }
    }

    fn translate(&self, e: &Expr, params: &[Value], out: &mut Vec<SqlValue>) -> String {
        match e {
            Expr::Lit(v) => {
                out.push(to_sql_param(v));
                "?".to_owned()
            }
            Expr::Binding { index } => {
                out.push(to_sql_param(
                    params.get(*index).unwrap_or(&Value::Undefined),
                ));
                "?".to_owned()
            }
            Expr::Ident { name } => format!("{}.{}", quote_ident(&self.table), quote_ident(name)),
            Expr::Unary { op, expr } => {
                let inner = self.translate(expr, params, out);
                match op {
                    UnaryOp::Not => format!("(NOT {inner})"),
                    UnaryOp::Neg => format!("(-{inner})"),
                }
            }
            Expr::Logical { op, left, right } => {
                let l = self.translate(left, params, out);
                let r = self.translate(right, params, out);
                let op = match op {
                    LogicalOp::And => "AND",
                    LogicalOp::Or => "OR",
                };
                format!("({l} {op} {r})")
            }
            Expr::Binary { op, left, right } => {
                let l = self.translate(left, params, out);
                let r = self.translate(right, params, out);
                format!("({l} {} {r})", binary_sql(*op))
            }
            other => unreachable!("sqlite: not translatable: {other:?}"),
        }
    }

    fn map_row(&self, raw: Object) -> Value {
        if let Some(map) = &self.map {
            return map(raw);
        }
        if self.json_columns.is_empty() {
            return Value::Object(raw);
        }
        let mut out = raw;
        for c in &self.json_columns {
            let parsed = match out.get(c) {
                Some(Value::Str(text)) => serde_json::from_str::<serde_json::Value>(text)
                    .ok()
                    .map(Value::from_json),
                _ => None,
            };
            if let Some(v) = parsed {
                out.insert(c.clone(), v);
            }
        }
        Value::Object(out)
    }
}

impl QueryPlanner for SqliteTable<'_> {
    /// Runs the compiled statement. Panics on a SQL error (see the module
    /// docs); use [`SqliteTable::try_plan`] to handle it instead.
    fn plan(&self, query: &Query, params: &[Value]) -> Option<Plan> {
        match self.try_plan(query, params) {
            Ok(plan) => plan,
            Err(e) => {
                let sql = self
                    .compile(query, params)
                    .map_or_else(String::new, |c| c.sql);
                panic!("oqx sqlite adapter: {e} (statement: {sql})")
            }
        }
    }
}

impl fmt::Debug for SqliteTable<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut columns: Vec<&str> = self.columns.iter().map(String::as_str).collect();
        columns.sort_unstable();
        f.debug_struct("SqliteTable")
            .field("table", &self.table)
            .field("columns", &columns)
            .field("json_columns", &self.json_columns)
            .field("map", &self.map.as_ref().map(|_| "<fn>"))
            .finish_non_exhaustive()
    }
}

/// The SQL spelling of a binary operator.
fn binary_sql(op: BinaryOp) -> &'static str {
    match op {
        BinaryOp::Eq => "=",
        BinaryOp::Ne => "<>",
        BinaryOp::Lt => "<",
        BinaryOp::Le => "<=",
        BinaryOp::Gt => ">",
        BinaryOp::Ge => ">=",
        BinaryOp::Add => "+",
        BinaryOp::Sub => "-",
        BinaryOp::Mul => "*",
        BinaryOp::Div => "/",
        BinaryOp::Mod => "%",
    }
}

/// A double-quoted SQL identifier, with embedded quotes doubled.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// A bound parameter, as `node:sqlite` binds the corresponding JavaScript
/// value (see the module docs).
fn to_sql_param(v: &Value) -> SqlValue {
    match v {
        Value::Undefined | Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => SqlValue::Real(*n),
        Value::Str(s) => SqlValue::Text(s.clone()),
        Value::Array(_) | Value::Object(_) | Value::Range(_) => SqlValue::Text(v.to_string()),
    }
}

/// A result column as a [`Value`] (see the module docs).
fn from_sql(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i as f64),
        ValueRef::Real(f) => Value::Number(f),
        ValueRef::Text(bytes) => Value::Str(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => {
            Value::Array(bytes.iter().map(|b| Value::Number(f64::from(*b))).collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Range;

    #[test]
    fn params_bind_as_node_sqlite_would() {
        assert_eq!(to_sql_param(&Value::Undefined), SqlValue::Null);
        assert_eq!(to_sql_param(&Value::Null), SqlValue::Null);
        assert_eq!(to_sql_param(&Value::Bool(true)), SqlValue::Integer(1));
        assert_eq!(to_sql_param(&Value::Bool(false)), SqlValue::Integer(0));
        assert_eq!(to_sql_param(&Value::Number(5.0)), SqlValue::Real(5.0));
        assert_eq!(
            to_sql_param(&Value::from("x")),
            SqlValue::Text("x".to_owned())
        );
        assert_eq!(
            to_sql_param(&Value::Array(vec![Value::Number(1.0), Value::from("a")])),
            SqlValue::Text("1,a".to_owned())
        );
        assert_eq!(
            to_sql_param(&Value::Object(Object::new())),
            SqlValue::Text("[object Object]".to_owned())
        );
        assert_eq!(
            to_sql_param(&Value::from(Range {
                lo: Some(Value::Number(1.0)),
                hi: None,
                exclusive_end: false,
            })),
            SqlValue::Text("1..".to_owned())
        );
    }

    #[test]
    fn columns_map_back_to_values() {
        assert_eq!(from_sql(ValueRef::Null), Value::Null);
        assert_eq!(from_sql(ValueRef::Integer(7)), Value::Number(7.0));
        assert_eq!(from_sql(ValueRef::Real(1.5)), Value::Number(1.5));
        assert_eq!(from_sql(ValueRef::Text(b"hi")), Value::from("hi"));
        assert_eq!(
            from_sql(ValueRef::Text(b"a\xffb")),
            Value::from("a\u{fffd}b")
        );
        assert_eq!(
            from_sql(ValueRef::Blob(&[0, 255])),
            Value::Array(vec![Value::Number(0.0), Value::Number(255.0)])
        );
    }

    #[test]
    fn identifiers_are_quoted_and_escaped() {
        assert_eq!(quote_ident("dept"), "\"dept\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }
}
