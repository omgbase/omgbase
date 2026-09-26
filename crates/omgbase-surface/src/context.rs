//! The query binding (`spec/surface/README.md` §1): a [`DataContext`] over
//! the store, so the `oqx` in-memory engine reproduces the whole OQX surface
//! — roots, intrinsics, reach-through, structural relations, the edge graph,
//! the row functions — without a bespoke compiler. Port of
//! `packages/core/src/oqx-js/context.ts`.
//!
//! Rows are the store's raw column objects (blobs as hex) carrying a hidden
//! tag column ([`TAG_KEY`]) naming their target; `get` routes field /
//! intrinsic / relation resolution per target, lazily querying the store.
//! Row functions (`text`, `under`, …) arrive as methods on the `$self`
//! receiver (see the runner's AST rewrite), since a free function sees no row.
//!
//! The tier-3 planner ([`crate::planner`]) hands the rows its SQL produced
//! back through [`StoreContext::with_rows_root`]: the context then serves them
//! as the residual query's [`oqx::ROWS_ROOT`] scan, while every other root,
//! relation, intrinsic and row function still reaches the store — the
//! reference's `rowsRoot` context option.
//!
//! Errors travel the engine's channel: a failure inside a property read or a
//! row function — the reserved-basename guard, a store failure — is the
//! `Err` of `get` / `call_method` (an eval-stage [`OqxError`], since `oqx`
//! 0.13), which aborts the run exactly like a throw from the reference's
//! `get`; the runner maps it to `filter_invalid` with the same message. The
//! one seam still without a channel is `root` (the engine reads a named root
//! for the top-level source and for a caret that reaches the root scope), so
//! a store failure during a root scan is kept in [`StoreContext::take_root_failure`]
//! and the runner reports it after the run.
//!
//! One seam differs from the reference and is bridged here:
//!
//! * the Rust engine expands `entries(x)` in row position itself (never via
//!   `call_function`), so the `frontmatter` / `inline` source handles are
//!   materialized eagerly as plain objects — one key per top-level property
//!   in key order, valued by the scalar-vs-list rule — instead of the
//!   reference's lazy handle. `frontmatter.<k>` and `entries(frontmatter)`
//!   read the same values either way.

use std::cell::RefCell;
use std::collections::HashMap;

use omgbase_properties::Bound;
use omgbase_search::{cosine_bytes, sanitize_fts_query};
use oqx::semantics::{builtin_function, builtin_method_with, make_range};
use oqx::{DataContext, Object, OqxError, RegexDialect, Value};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OptionalExtension, params_from_iter};

/// The hidden column tagging a store row with its target.
pub const TAG_KEY: &str = "__oqx_target";
const REPO_TAG: &str = "$repo";

/// The four scan targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Docs,
    Blocks,
    Nodes,
    Edges,
}

impl Target {
    /// The root name: `docs` | `blocks` | `nodes` | `edges`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Target::Docs => "docs",
            Target::Blocks => "blocks",
            Target::Nodes => "nodes",
            Target::Edges => "edges",
        }
    }

    /// The target a root name denotes, if any.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "docs" => Target::Docs,
            "blocks" => Target::Blocks,
            "nodes" => Target::Nodes,
            "edges" => Target::Edges,
            _ => return None,
        })
    }
}

/// docs intrinsics whose BARE form is almost always a typo: a loud error
/// ("did you mean the intrinsic").
const RESERVED_DOC_BASENAMES: [&str; 5] = ["id", "path", "updated_at", "content_hash", "body"];

/// A query phrase's embedding: the model whose cache to read and the vector
/// as a float32 little-endian blob.
#[derive(Clone, Debug, PartialEq)]
pub struct SemanticVec {
    pub model: String,
    pub vec: Vec<u8>,
}

/// The store-backed context for one repo.
pub struct StoreContext<'a> {
    conn: &'a Connection,
    repo_id: String,
    semantic: HashMap<String, SemanticVec>,
    /// A store failure inside [`DataContext::root`], the one read the
    /// engine's seam cannot fail through (see the module doc).
    root_failure: RefCell<Option<OqxError>>,
    /// The rows a tier-3 plan produced, served as [`oqx::ROWS_ROOT`].
    rows_root: Option<Vec<Value>>,
}

fn sql_value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i as f64),
        ValueRef::Real(f) => Value::Number(f),
        ValueRef::Text(t) => Value::Str(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Str(omgbase_format::hash::hex(b)),
    }
}

/// A [`Value`] as a SQL parameter (`has_edge`'s destination, the planner's
/// bound operands): booleans as 1/0 — how `json_extract` surfaces JSON
/// booleans, so `attrs.b == true` compares against `1` — numbers as REAL
/// (a JavaScript number binds as a double), absent as NULL.
pub(crate) fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Undefined | Value::Null | Value::Range(_) => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => SqlValue::Real(*n),
        Value::Str(s) => SqlValue::Text(s.clone()),
        Value::Array(_) | Value::Object(_) => SqlValue::Text(v.to_string()),
    }
}

/// JavaScript `String(v)` of an argument.
fn js_string(v: &Value) -> String {
    v.to_string()
}

/// `String(args[0] ?? "")`.
fn arg_or_empty(args: &[Value], i: usize) -> String {
    match args.get(i) {
        None | Some(Value::Undefined) | Some(Value::Null) => String::new(),
        Some(v) => js_string(v),
    }
}

/// `JSON.parse` when a string, else the value (`null` → absent).
fn parse_json(v: &Value) -> Value {
    match v {
        Value::Str(s) => {
            serde_json::from_str::<serde_json::Value>(s).map_or_else(|_| v.clone(), Value::from)
        }
        Value::Null | Value::Undefined => Value::Undefined,
        other => other.clone(),
    }
}

/// A store failure as the engine's eval error (the message the reference's
/// raw exception would carry).
fn sql_err(e: rusqlite::Error) -> OqxError {
    OqxError::eval(format!("sqlite: {e}"))
}

/// The tag of a store row, if it is one.
pub fn target_of(row: &Value) -> Option<Target> {
    row.as_object()
        .and_then(|o| o.get(TAG_KEY))
        .and_then(Value::as_str)
        .and_then(Target::parse)
}

fn is_repo_root(row: &Value) -> bool {
    row.as_object()
        .and_then(|o| o.get(TAG_KEY))
        .and_then(Value::as_str)
        == Some(REPO_TAG)
}

fn col<'v>(row: &'v Value, key: &str) -> &'v Value {
    row.as_object()
        .and_then(|o| o.get(key))
        .unwrap_or(&Value::Undefined)
}

fn col_str(row: &Value, key: &str) -> String {
    match col(row, key) {
        Value::Undefined | Value::Null => String::new(),
        v => js_string(v),
    }
}

/// Strip the hidden tag from a value tree (the wire form never carries it).
#[must_use]
pub fn strip_tags(v: Value) -> Value {
    match v {
        Value::Object(o) => Value::Object(
            o.into_iter()
                .filter(|(k, _)| k != TAG_KEY)
                .map(|(k, x)| (k, strip_tags(x)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.into_iter().map(strip_tags).collect()),
        other => other,
    }
}

/// §1.4 rows as values (1.2): a store row that surfaces as a VALUE in a result
/// tree — a nested `collect { }` / `first { }` / `single { }` with an empty
/// projection, or a `values` item that is a row — renders as `{ id, path }`
/// (the target's id column as a string; the owning document's path: a docs
/// row's `path`, every other row's `__path` join column), never the store
/// row. Everything else recurses, dropping the hidden tag as [`strip_tags`].
#[must_use]
pub fn render_row_values(v: Value) -> Value {
    match v {
        Value::Object(o) => {
            let row = Value::Object(o);
            if let Some(t) = target_of(&row) {
                let (id_col, path_col) = match t {
                    Target::Docs => ("doc_id", "path"),
                    Target::Blocks => ("block_id", "__path"),
                    Target::Nodes => ("node_id", "__path"),
                    Target::Edges => ("edge_id", "__path"),
                };
                let mut out = Object::with_capacity(2);
                out.insert("id", Value::Str(col_str(&row, id_col)));
                out.insert("path", Value::Str(col_str(&row, path_col)));
                return Value::Object(out);
            }
            let Value::Object(o) = row else {
                unreachable!()
            };
            Value::Object(
                o.into_iter()
                    .filter(|(k, _)| k != TAG_KEY)
                    .map(|(k, x)| (k, render_row_values(x)))
                    .collect(),
            )
        }
        Value::Array(a) => Value::Array(a.into_iter().map(render_row_values).collect()),
        other => other,
    }
}

impl<'a> StoreContext<'a> {
    /// A context over `conn` scoped to `repo_id`, with the query phrases'
    /// vectors for `semantic(...)` (empty when no provider ran).
    #[must_use]
    pub fn new(
        conn: &'a Connection,
        repo_id: &str,
        semantic: HashMap<String, SemanticVec>,
    ) -> Self {
        Self {
            conn,
            repo_id: repo_id.to_owned(),
            semantic,
            root_failure: RefCell::new(None),
            rows_root: None,
        }
    }

    /// Serve `rows` — target-tagged store rows a plan produced — as the
    /// [`oqx::ROWS_ROOT`] scan (the residual query's source). Every other
    /// root and every relation, intrinsic and row function still hits the
    /// store, so the residual sees exactly what a full scan would.
    #[must_use]
    pub fn with_rows_root(mut self, rows: Vec<Value>) -> Self {
        self.rows_root = Some(rows);
        self
    }

    /// The store failure a root scan hit during the run, if any. Every other
    /// read fails through the engine's channel (`get` / `call_method` return
    /// `Err`); `root` has none, so it serves an empty scan and leaves the
    /// failure here for the runner to report.
    pub fn take_root_failure(&self) -> Option<OqxError> {
        self.root_failure.borrow_mut().take()
    }

    // ---- SQL helpers ------------------------------------------------------------------

    fn all(&self, sql: &str, params: &[SqlValue]) -> oqx::Result<Vec<Object>> {
        fetch_rows(self.conn, sql, params).map_err(sql_err)
    }

    fn one(&self, sql: &str, params: &[SqlValue]) -> oqx::Result<Option<Object>> {
        Ok(self.all(sql, params)?.into_iter().next())
    }

    fn scalar(&self, sql: &str, params: &[SqlValue]) -> oqx::Result<Value> {
        Ok(self
            .one(sql, params)?
            .and_then(|o| o.values().next().cloned())
            .unwrap_or(Value::Undefined))
    }

    fn exists(&self, sql: &str, params: &[SqlValue]) -> oqx::Result<bool> {
        let mut stmt = self.conn.prepare_cached(sql).map_err(sql_err)?;
        stmt.exists(params_from_iter(params.iter()))
            .map_err(sql_err)
    }

    fn tag_all(rows: Vec<Object>, t: Target) -> Value {
        Value::Array(tag_rows(rows, t))
    }

    fn tag(row: Object, t: Target) -> Value {
        tag_row(row, t)
    }

    fn repo_root(&self) -> Value {
        let mut o = Object::with_capacity(1);
        o.insert(TAG_KEY, Value::Str(REPO_TAG.to_owned()));
        Value::Object(o)
    }

    // ---- roots (ordered for a stable (path, id) default) ------------------------------

    fn root_scan(&self, t: Target) -> oqx::Result<Value> {
        let repo = [SqlValue::Text(self.repo_id.clone())];
        let sql = match t {
            Target::Docs => {
                "SELECT * FROM docs WHERE repo_id = ?1 AND deleted_commit IS NULL ORDER BY path, doc_id"
            }
            Target::Blocks => {
                "SELECT b.*, d.path AS __path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id
                 WHERE b.repo_id = ?1 AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL
                 ORDER BY d.path, b.block_id"
            }
            Target::Nodes => {
                "SELECT n.*, d.path AS __path FROM nodes n JOIN docs d ON d.doc_id = n.doc_id
                 WHERE n.repo_id = ?1 AND d.deleted_commit IS NULL ORDER BY d.path, n.node_id"
            }
            Target::Edges => {
                "SELECT e.*, d.path AS __path FROM edges e JOIN docs d ON d.doc_id = e.src_doc
                 WHERE e.repo_id = ?1 AND e.to_commit IS NULL AND d.deleted_commit IS NULL
                 ORDER BY d.path, e.edge_id"
            }
        };
        Ok(Self::tag_all(self.all(sql, &repo)?, t))
    }

    // ---- properties ---------------------------------------------------------------------

    /// A property row decoded to a plain scalar; a range-shaped string stays a
    /// string (`range(prop)` is the opt-in).
    fn decode_prop(r: &Object) -> Value {
        let get = |k: &str| r.get(k).cloned().unwrap_or(Value::Undefined);
        match get("type").as_str().unwrap_or("") {
            "number" => get("val_num"),
            "bool" => Value::Bool(get("val_bool").truthy()),
            "null" => Value::Null,
            "json" => parse_json(&get("val_json")),
            _ => get("val_text"),
        }
    }

    /// The scalar-vs-list rule: exactly one `card = scalar` row → the scalar;
    /// otherwise the array; no row → the nested object under `key.`.
    fn doc_prop(&self, doc_id: &str, key: &str, source: Option<&str>) -> oqx::Result<Value> {
        let rows = match source {
            Some(s) => self.all(
                "SELECT * FROM properties WHERE doc_id = ?1 AND key = ?2 AND source = ?3 AND deleted_commit IS NULL ORDER BY ord",
                &[SqlValue::Text(doc_id.to_owned()), SqlValue::Text(key.to_owned()), SqlValue::Text(s.to_owned())],
            )?,
            None => self.all(
                "SELECT * FROM properties WHERE doc_id = ?1 AND key = ?2 AND deleted_commit IS NULL ORDER BY ord",
                &[SqlValue::Text(doc_id.to_owned()), SqlValue::Text(key.to_owned())],
            )?,
        };
        if rows.is_empty() {
            return self.doc_prop_object(doc_id, key, source);
        }
        if rows.len() == 1 && rows[0].get("card").and_then(Value::as_str) == Some("scalar") {
            return Ok(Self::decode_prop(&rows[0]));
        }
        Ok(Value::Array(rows.iter().map(Self::decode_prop).collect()))
    }

    /// The nested object rebuilt from flattened dotted keys under `prefix.`
    /// (`Undefined` when none); leaves decoded.
    fn doc_prop_object(
        &self,
        doc_id: &str,
        prefix: &str,
        source: Option<&str>,
    ) -> oqx::Result<Value> {
        let like = SqlValue::Text(format!("{prefix}.%"));
        let rows = match source {
            Some(s) => self.all(
                "SELECT * FROM properties WHERE doc_id = ?1 AND key LIKE ?2 AND source = ?3 AND deleted_commit IS NULL ORDER BY ord",
                &[SqlValue::Text(doc_id.to_owned()), like, SqlValue::Text(s.to_owned())],
            )?,
            None => self.all(
                "SELECT * FROM properties WHERE doc_id = ?1 AND key LIKE ?2 AND deleted_commit IS NULL ORDER BY ord",
                &[SqlValue::Text(doc_id.to_owned()), like],
            )?,
        };
        if rows.is_empty() {
            return Ok(Value::Undefined);
        }
        let mut out = Object::new();
        for r in &rows {
            let key = r.get("key").and_then(Value::as_str).unwrap_or("");
            let rest: Vec<&str> = key[(prefix.len() + 1).min(key.len())..]
                .split('.')
                .collect();
            set_nested(&mut out, &rest, Self::decode_prop(r));
        }
        Ok(Value::Object(out))
    }

    /// The `frontmatter` / `inline` bag as a plain object: one entry per
    /// top-level key in key order, each valued by [`Self::doc_prop`].
    fn doc_prop_bag(&self, doc_id: &str, source: &str) -> oqx::Result<Value> {
        let keys = self.all(
            "SELECT DISTINCT key FROM properties WHERE doc_id = ?1 AND source = ?2 AND deleted_commit IS NULL ORDER BY key",
            &[SqlValue::Text(doc_id.to_owned()), SqlValue::Text(source.to_owned())],
        )?;
        let mut out = Object::new();
        for k in keys {
            let key = k.get("key").and_then(Value::as_str).unwrap_or("");
            let top = key.split('.').next().unwrap_or("");
            if !out.contains_key(top) {
                let v = self.doc_prop(doc_id, top, Some(source))?;
                out.insert(top, v);
            }
        }
        Ok(Value::Object(out))
    }

    // ---- structure ----------------------------------------------------------------------

    /// The ordinal of a block's top-level ancestor (section ranges are in
    /// top-level ordinals).
    fn top_ordinal(&self, block: &Value) -> oqx::Result<Value> {
        let ordinal = col(block, "ordinal").clone();
        if col(block, "parent_block").is_absent() {
            return Ok(ordinal);
        }
        let ap = col_str(block, "ancestor_path");
        let Some(first) = ap.split('/').find(|s| !s.is_empty()) else {
            return Ok(ordinal);
        };
        let r = self.scalar(
            "SELECT ordinal FROM blocks WHERE doc_id = ?1 AND block_id = ?2",
            &[
                SqlValue::Text(col_str(block, "doc_id")),
                SqlValue::Text(first.to_owned()),
            ],
        )?;
        Ok(if r.is_absent() { ordinal } else { r })
    }

    /// A document's live blocks in document order — pre-order over the
    /// containment tree (children by `ordinal` under their parent; a row whose
    /// parent is not live is a root) — tagged, with `__path` = `path`.
    fn doc_blocks_preorder(&self, doc_id: &str, path: &str) -> oqx::Result<Vec<Value>> {
        let rows = self.all(
            "SELECT b.*, ?1 AS __path FROM blocks b WHERE b.doc_id = ?2 AND b.deleted_commit IS NULL ORDER BY b.ordinal, b.block_id",
            &[SqlValue::Text(path.to_owned()), SqlValue::Text(doc_id.to_owned())],
        )?;
        let ids: Vec<String> = rows
            .iter()
            .map(|r| {
                r.get("block_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned()
            })
            .collect();
        let parent_index: Vec<Option<usize>> = rows
            .iter()
            .map(|r| {
                r.get("parent_block")
                    .and_then(Value::as_str)
                    .and_then(|p| ids.iter().position(|id| id == p))
            })
            .collect();
        let mut children: Vec<Vec<usize>> = vec![Vec::new(); rows.len()];
        let mut roots = Vec::new();
        for (i, p) in parent_index.iter().enumerate() {
            match p {
                Some(p) => children[*p].push(i),
                None => roots.push(i),
            }
        }
        fn walk(i: usize, children: &[Vec<usize>], order: &mut Vec<usize>) {
            order.push(i);
            for &c in &children[i] {
                walk(c, children, order);
            }
        }
        let mut order = Vec::with_capacity(rows.len());
        for r in roots {
            walk(r, &children, &mut order);
        }
        let mut slots: Vec<Option<Object>> = rows.into_iter().map(Some).collect();
        Ok(order
            .into_iter()
            .map(|i| Self::tag(slots[i].take().expect("visited once"), Target::Blocks))
            .collect())
    }

    fn jattr(row: &Value, k: &str) -> Value {
        match parse_json(col(row, "attrs")) {
            Value::Object(o) => o.get(k).cloned().unwrap_or(Value::Undefined),
            _ => Value::Undefined,
        }
    }

    /// `Ok(None)` when `key` is not a relation of `t`.
    fn relation(&self, row: &Value, t: Target, key: &str) -> oqx::Result<Option<Value>> {
        let path = || SqlValue::Text(col_str(row, "__path"));
        let doc_id = || SqlValue::Text(col_str(row, "doc_id"));
        let doc_path = || SqlValue::Text(col_str(row, "path"));
        let block_id = || SqlValue::Text(col_str(row, "block_id"));
        let repo = || SqlValue::Text(self.repo_id.clone());
        Ok(Some(match (t, key) {
            (Target::Docs, "nodes") => {
                // Document order: block-less nodes first, then by the owning
                // block's pre-order rank, `span_start`, `node_id`.
                let rows = self.all(
                    "SELECT n.*, ?1 AS __path FROM nodes n WHERE n.doc_id = ?2 ORDER BY n.node_id",
                    &[doc_path(), doc_id()],
                )?;
                let blocks = self.doc_blocks_preorder(&col_str(row, "doc_id"), &col_str(row, "path"))?;
                let rank: HashMap<String, usize> = blocks
                    .iter()
                    .enumerate()
                    .map(|(i, b)| (col_str(b, "block_id"), i))
                    .collect();
                let mut keyed: Vec<((usize, usize, f64, String), Object)> = rows
                    .into_iter()
                    .map(|r| {
                        let block = r.get("block_id").and_then(Value::as_str);
                        let (has_block, rk) = match block {
                            None => (0, 0),
                            Some(b) => (1, rank.get(b).copied().unwrap_or(usize::MAX)),
                        };
                        let span = r.get("span_start").and_then(Value::as_f64).unwrap_or(-1.0);
                        let id = r.get("node_id").and_then(Value::as_str).unwrap_or("").to_owned();
                        ((has_block, rk, span, id), r)
                    })
                    .collect();
                keyed.sort_by(|a, b| {
                    a.0.0
                        .cmp(&b.0.0)
                        .then(a.0.1.cmp(&b.0.1))
                        .then(a.0.2.total_cmp(&b.0.2))
                        .then(a.0.3.cmp(&b.0.3))
                });
                Value::Array(keyed.into_iter().map(|(_, r)| Self::tag(r, Target::Nodes)).collect())
            }
            (Target::Docs, "blocks") => {
                Value::Array(self.doc_blocks_preorder(&col_str(row, "doc_id"), &col_str(row, "path"))?)
            }
            (Target::Docs, "out") => Self::tag_all(
                self.all(
                    "SELECT DISTINCT d2.* FROM docs d2 JOIN edges e ON e.dst_node = d2.doc_id
                     WHERE e.src_doc = ?1 AND e.to_commit IS NULL AND d2.repo_id = ?2 AND d2.deleted_commit IS NULL ORDER BY d2.path, d2.doc_id",
                    &[doc_id(), repo()],
                )?,
                Target::Docs,
            ),
            (Target::Docs, "in") => Self::tag_all(
                self.all(
                    "SELECT DISTINCT d2.* FROM docs d2 JOIN edges e ON e.src_doc = d2.doc_id
                     WHERE e.dst_node = ?1 AND e.to_commit IS NULL AND d2.repo_id = ?2 AND d2.deleted_commit IS NULL ORDER BY d2.path, d2.doc_id",
                    &[doc_id(), repo()],
                )?,
                Target::Docs,
            ),
            (Target::Docs, "out_edges") => Self::tag_all(
                self.all(
                    "SELECT e.*, ?1 AS __path FROM edges e WHERE e.src_doc = ?2 AND e.to_commit IS NULL ORDER BY e.predicate, e.edge_id",
                    &[doc_path(), doc_id()],
                )?,
                Target::Edges,
            ),
            (Target::Docs, "in_edges") => Self::tag_all(
                self.all(
                    "SELECT e.*, d.path AS __path FROM edges e JOIN docs d ON d.doc_id = e.src_doc
                     WHERE e.dst_node = ?1 AND e.to_commit IS NULL AND d.deleted_commit IS NULL ORDER BY e.predicate, e.edge_id",
                    &[doc_id()],
                )?,
                Target::Edges,
            ),
            (Target::Blocks, "children") => Self::tag_all(
                self.all(
                    "SELECT b.*, ?1 AS __path FROM blocks b WHERE b.parent_block = ?2 AND b.deleted_commit IS NULL ORDER BY b.ordinal, b.block_id",
                    &[path(), block_id()],
                )?,
                Target::Blocks,
            ),
            (Target::Blocks, "nodes") => Self::tag_all(
                self.all(
                    "SELECT n.*, ?1 AS __path FROM nodes n WHERE n.block_id = ?2 ORDER BY n.span_start, n.node_id",
                    &[path(), block_id()],
                )?,
                Target::Nodes,
            ),
            (Target::Blocks, "out_edges") => Self::tag_all(
                self.all(
                    "SELECT e.*, ?1 AS __path FROM edges e WHERE e.src_block = ?2 AND e.to_commit IS NULL ORDER BY e.predicate, e.edge_id",
                    &[path(), block_id()],
                )?,
                Target::Edges,
            ),
            (Target::Blocks, "section") => {
                let top = to_sql(&self.top_ordinal(row)?);
                Self::tag_all(
                    self.all(
                        "SELECT n.*, ?1 AS __path FROM nodes n WHERE n.doc_id = ?2 AND n.kind = 'md:section'
                           AND json_extract(n.attrs,'$.first_ordinal') <= ?3 AND json_extract(n.attrs,'$.last_ordinal') >= ?4
                         ORDER BY json_extract(n.attrs,'$.first_ordinal'), n.node_id",
                        &[path(), doc_id(), top.clone(), top],
                    )?,
                    Target::Nodes,
                )
            }
            (Target::Nodes, "blocks") => {
                let (f, l) = (Self::jattr(row, "first_ordinal"), Self::jattr(row, "last_ordinal"));
                if f.is_absent() || l.is_absent() {
                    return Ok(Some(Value::Array(Vec::new())));
                }
                let (f, l) = (
                    f.as_f64().unwrap_or(f64::NAN),
                    l.as_f64().unwrap_or(f64::NAN),
                );
                let rows = self.doc_blocks_preorder(&col_str(row, "doc_id"), &col_str(row, "__path"))?;
                let mut kept: Vec<Value> = Vec::new();
                for b in rows {
                    let t = self.top_ordinal(&b)?.as_f64().unwrap_or(f64::NAN);
                    if t >= f && t <= l {
                        kept.push(b);
                    }
                }
                Value::Array(kept)
            }
            (Target::Nodes, "subsections") => {
                let (f, l, lvl) = (
                    Self::jattr(row, "first_ordinal"),
                    Self::jattr(row, "last_ordinal"),
                    Self::jattr(row, "level"),
                );
                if f.is_absent() {
                    return Ok(Some(Value::Array(Vec::new())));
                }
                Self::tag_all(
                    self.all(
                        "SELECT n.*, ?1 AS __path FROM nodes n WHERE n.doc_id = ?2 AND n.kind = 'md:section'
                           AND json_extract(n.attrs,'$.first_ordinal') >= ?3 AND json_extract(n.attrs,'$.last_ordinal') <= ?4
                           AND json_extract(n.attrs,'$.level') > ?5 ORDER BY json_extract(n.attrs,'$.first_ordinal'), n.node_id",
                        &[path(), doc_id(), to_sql(&f), to_sql(&l), to_sql(&lvl)],
                    )?,
                    Target::Nodes,
                )
            }
            (Target::Nodes, "children") => {
                let (f, l, lvl) = (
                    Self::jattr(row, "first_ordinal"),
                    Self::jattr(row, "last_ordinal"),
                    Self::jattr(row, "level"),
                );
                if f.is_absent() {
                    return Ok(Some(Value::Array(Vec::new())));
                }
                Self::tag_all(
                    self.all(
                        "SELECT i.*, ?1 AS __path FROM nodes i WHERE i.doc_id = ?2 AND i.kind = 'md:section'
                           AND json_extract(i.attrs,'$.level') > ?3
                           AND json_extract(i.attrs,'$.first_ordinal') >= ?4 AND json_extract(i.attrs,'$.last_ordinal') <= ?5
                           AND NOT EXISTS (SELECT 1 FROM nodes m WHERE m.doc_id = i.doc_id AND m.kind = 'md:section'
                             AND json_extract(m.attrs,'$.level') > ?6 AND json_extract(m.attrs,'$.level') < json_extract(i.attrs,'$.level')
                             AND json_extract(m.attrs,'$.first_ordinal') <= json_extract(i.attrs,'$.first_ordinal')
                             AND json_extract(m.attrs,'$.last_ordinal') >= json_extract(i.attrs,'$.last_ordinal'))
                         ORDER BY json_extract(i.attrs,'$.first_ordinal'), i.node_id",
                        &[path(), doc_id(), to_sql(&lvl), to_sql(&f), to_sql(&l), to_sql(&lvl)],
                    )?,
                    Target::Nodes,
                )
            }
            _ => return Ok(None),
        }))
    }

    fn owning_doc(&self, row: &Value) -> oqx::Result<Value> {
        let id = match col(row, "doc_id") {
            Value::Undefined | Value::Null => col(row, "src_doc").clone(),
            v => v.clone(),
        };
        Ok(self
            .one("SELECT * FROM docs WHERE doc_id = ?1", &[to_sql(&id)])?
            .map_or(Value::Undefined, |o| Self::tag(o, Target::Docs)))
    }

    fn owning_block(&self, row: &Value) -> oqx::Result<Value> {
        let id = col(row, "block_id");
        if !id.truthy() {
            return Ok(Value::Undefined);
        }
        Ok(self
            .one(
                "SELECT b.*, d.path AS __path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?1",
                &[to_sql(id)],
            )?
            .map_or(Value::Undefined, |o| Self::tag(o, Target::Blocks)))
    }

    // ---- intrinsics ---------------------------------------------------------------------

    fn null_if_absent(v: Value) -> Value {
        if v.is_absent() { Value::Null } else { v }
    }

    fn intrinsic(&self, row: &Value, t: Target, name: &str) -> oqx::Result<Value> {
        if name == "$self" {
            return Ok(row.clone());
        }
        let c = |k: &str| col(row, k).clone();
        Ok(match (t, name) {
            (Target::Docs, "$id") => c("doc_id"),
            (Target::Docs, "$path") => c("path"),
            (Target::Docs, "$content_hash") => Self::null_if_absent(c("file_hash")),
            (Target::Docs, "$updated_at") => Self::null_if_absent(self.scalar(
                "SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = ?1",
                &[to_sql(&c("current_rev"))],
            )?),
            (Target::Docs, "$body") => {
                match omgbase_store::read::reconstruct(self.conn, &col_str(row, "doc_id")) {
                    Ok(Some(s)) => Value::Str(s),
                    Ok(None) => Value::Null,
                    Err(e) => return Err(OqxError::eval(e.to_string())),
                }
            }
            (Target::Docs, "$title") => {
                Self::null_if_absent(self.doc_prop(&col_str(row, "doc_id"), "$title", Some("computed"))?)
            }
            (Target::Docs, "$tags") => {
                Self::null_if_absent(self.doc_prop(&col_str(row, "doc_id"), "$tags", Some("computed"))?)
            }
            (Target::Blocks, "$id") => c("block_id"),
            (Target::Blocks, "$doc") => c("doc_id"),
            (Target::Blocks, "$path") => c("__path"),
            (Target::Blocks, "$ordinal") => c("ordinal"),
            (Target::Blocks, "$depth") => c("depth"),
            (Target::Blocks, "$body") => c("text"),
            (Target::Blocks, "$content_hash") => Self::null_if_absent(c("raw_hash")),
            (Target::Blocks, "$updated_at") => Self::null_if_absent(self.scalar(
                "SELECT MAX(c.ts) FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?1",
                &[to_sql(&c("block_id"))],
            )?),
            (Target::Nodes, "$id" | "$node_id") => c("node_id"),
            (Target::Nodes, "$doc_id") => c("doc_id"),
            (Target::Nodes, "$block_id") => c("block_id"),
            (Target::Nodes, "$path") => c("__path"),
            (Target::Edges, "$id") => c("edge_id"),
            (Target::Edges, "$src") => c("src_doc"),
            (Target::Edges, "$dst") => c("dst_node"),
            (Target::Edges, "$src_block") => c("src_block"),
            (Target::Edges, "$via") => c("via_node"),
            (Target::Edges, "$from_commit") => c("from_commit"),
            (Target::Edges, "$path") => c("__path"),
            (Target::Edges, "$dst_path") => Self::null_if_absent(self.scalar(
                "SELECT path FROM docs WHERE doc_id = ?1",
                &[to_sql(&c("dst_node"))],
            )?),
            (Target::Edges, "$dst_uri") => Self::null_if_absent(self.scalar(
                "SELECT uri FROM external_nodes WHERE node_id = ?1",
                &[to_sql(&c("dst_node"))],
            )?),
            _ => Value::Undefined,
        })
    }

    // ---- row functions (methods on `$self`) ----------------------------------------------

    fn filter_invalid(msg: String) -> Option<oqx::Result<Value>> {
        Some(Err(OqxError::eval(msg)))
    }

    fn require_target(t: Target, want: Target, name: &str) -> Option<oqx::Result<Value>> {
        (t != want).then(|| {
            Err(OqxError::eval(format!(
                "{name}() is only available on the {} target",
                want.as_str()
            )))
        })
    }

    fn sql_result(r: oqx::Result<bool>) -> oqx::Result<Value> {
        r.map(Value::Bool)
    }

    fn row_method(
        &self,
        name: &str,
        row: &Value,
        t: Target,
        args: &[Value],
    ) -> Option<oqx::Result<Value>> {
        let c = |k: &str| col(row, k).clone();
        match name {
            "text" => Some(self.text_match(t, row, &arg_or_empty(args, 0))),
            "semantic" => Some(self.semantic_score(t, row, &arg_or_empty(args, 0))),
            "has_anchor" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                Some(Self::sql_result(self.exists(
                    "SELECT 1 FROM edges WHERE src_block = ?1 AND anchor IS NOT NULL LIMIT 1",
                    &[to_sql(&c("block_id"))],
                )))
            }),
            "child_count" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                Some(self.scalar(
                    "SELECT COUNT(*) FROM blocks WHERE parent_block = ?1 AND deleted_commit IS NULL",
                    &[to_sql(&c("block_id"))],
                ))
            }),
            "parent_type" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                Some(
                    self.scalar(
                        "SELECT type FROM blocks WHERE block_id = ?1",
                        &[to_sql(&c("parent_block"))],
                    )
                    .map(Self::null_if_absent),
                )
            }),
            "has_edge" => {
                let pred = js_string(args.first().unwrap_or(&Value::Undefined));
                let (src_col, src_val) = if t == Target::Blocks {
                    ("src_block", c("block_id"))
                } else {
                    ("src_doc", c("doc_id"))
                };
                let r = if args.len() >= 2 {
                    self.exists(
                        &format!("SELECT 1 FROM edges WHERE {src_col} = ?1 AND predicate = ?2 AND to_commit IS NULL AND dst_node = ?3 LIMIT 1"),
                        &[to_sql(&src_val), SqlValue::Text(pred), to_sql(&args[1])],
                    )
                } else {
                    self.exists(
                        &format!("SELECT 1 FROM edges WHERE {src_col} = ?1 AND predicate = ?2 AND to_commit IS NULL LIMIT 1"),
                        &[to_sql(&src_val), SqlValue::Text(pred)],
                    )
                };
                Some(Self::sql_result(r))
            }
            "under" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                let target = js_string(args.first().unwrap_or(&Value::Undefined));
                let ap = col_str(row, "ancestor_path");
                Some(Ok(Value::Bool(
                    ap.contains(&format!("/{target}/")) || col_str(row, "block_id") == target,
                )))
            }),
            "under_heading" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                let text = js_string(args.first().unwrap_or(&Value::Undefined));
                let top = match self.top_ordinal(row) {
                    Ok(v) => to_sql(&v),
                    Err(e) => return Some(Err(e)),
                };
                Some(Self::sql_result(self.exists(
                    "SELECT 1 FROM sections s JOIN blocks hb ON hb.block_id = s.heading_block
                     WHERE s.doc_id = ?1 AND lower(hb.text) LIKE '%' || lower(?2) || '%' AND s.first_ordinal <= ?3 AND s.last_ordinal >= ?4 LIMIT 1",
                    &[to_sql(&c("doc_id")), SqlValue::Text(text), top.clone(), top],
                )))
            }),
            "within" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                let target = js_string(args.first().unwrap_or(&Value::Undefined));
                if target.starts_with("d_") {
                    return Some(Ok(Value::Bool(col_str(row, "doc_id") == target)));
                }
                if target.contains('*') {
                    let like = glob_to_like(&target, false);
                    return Some(Self::sql_result(self.exists(
                        "SELECT 1 WHERE ?1 LIKE ?2 ESCAPE '\\'",
                        &[SqlValue::Text(col_str(row, "__path")), SqlValue::Text(like)],
                    )));
                }
                Some(Ok(Value::Bool(col_str(row, "__path") == target)))
            }),
            "under_kind" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                let kind = js_string(args.first().unwrap_or(&Value::Undefined));
                let ap: Vec<String> = col_str(row, "ancestor_path")
                    .split('/')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect();
                if ap.is_empty() {
                    return Some(Ok(Value::Bool(false)));
                }
                let placeholders: Vec<String> = (1..=ap.len()).map(|i| format!("?{i}")).collect();
                let placeholders = placeholders.join(",");
                let mut params: Vec<SqlValue> = ap.into_iter().map(SqlValue::Text).collect();
                let n = params.len();
                params.push(SqlValue::Text(kind));
                let r = match args.get(1) {
                    Some(v) if !v.is_absent() => {
                        let nm = js_string(v);
                        params.push(SqlValue::Text(nm.clone()));
                        params.push(SqlValue::Text(nm));
                        self.exists(
                            &format!(
                                "SELECT 1 FROM blocks WHERE block_id IN ({placeholders}) AND type = ?{} AND (lower(text) LIKE '%' || lower(?{}) || '%' OR json_extract(attrs,'$.key') = ?{}) LIMIT 1",
                                n + 1,
                                n + 2,
                                n + 3
                            ),
                            &params,
                        )
                    }
                    _ => self.exists(
                        &format!(
                            "SELECT 1 FROM blocks WHERE block_id IN ({placeholders}) AND type = ?{} LIMIT 1",
                            n + 1
                        ),
                        &params,
                    ),
                };
                Some(Self::sql_result(r))
            }),
            "yaml_path" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                Some(Ok(Self::key_path(row, &js_string(args.first().unwrap_or(&Value::Undefined)), "yaml")))
            }),
            "json_pointer" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                Some(Ok(Self::key_path(row, &js_string(args.first().unwrap_or(&Value::Undefined)), "json")))
            }),
            _ => None,
        }
    }

    fn key_path(row: &Value, path: &str, kind: &str) -> Value {
        let key = if kind == "json" {
            let mut p = path;
            p = p.strip_prefix('#').unwrap_or(p);
            p = p.strip_prefix('/').unwrap_or(p);
            p.split('/').collect::<Vec<_>>().join(".")
        } else {
            path.to_owned()
        };
        let leaf = key.rsplit('.').next().unwrap_or("").to_owned();
        if !col_str(row, "type").starts_with(&format!("{kind}:")) {
            return Value::Bool(false);
        }
        let k = Self::jattr(row, "key");
        Value::Bool(k == Value::Str(leaf) || k == Value::Str(key))
    }

    fn text_match(&self, t: Target, row: &Value, terms: &str) -> oqx::Result<Value> {
        if t == Target::Edges {
            return Err(OqxError::eval(
                "text(...) is not available on the edges target",
            ));
        }
        let m = sanitize_fts_query(terms);
        if m.is_empty() {
            return Ok(Value::Bool(false));
        }
        let r = match t {
            Target::Docs => self.exists(
                "SELECT 1 FROM blocks_fts JOIN blocks b ON b.rowid = blocks_fts.rowid WHERE b.doc_id = ?1 AND blocks_fts MATCH ?2 LIMIT 1",
                &[to_sql(col(row, "doc_id")), SqlValue::Text(m)],
            ),
            Target::Nodes => self.exists(
                "SELECT 1 FROM nodes_fts WHERE rowid = (SELECT rowid FROM nodes WHERE node_id = ?1) AND nodes_fts MATCH ?2",
                &[to_sql(col(row, "node_id")), SqlValue::Text(m)],
            ),
            _ => self.exists(
                "SELECT 1 FROM blocks_fts WHERE rowid = (SELECT rowid FROM blocks WHERE block_id = ?1) AND blocks_fts MATCH ?2",
                &[to_sql(col(row, "block_id")), SqlValue::Text(m)],
            ),
        };
        Self::sql_result(r)
    }

    fn semantic_score(&self, t: Target, row: &Value, phrase: &str) -> oqx::Result<Value> {
        if matches!(t, Target::Nodes | Target::Edges) {
            return Err(OqxError::eval(
                "semantic(...) is available on the docs and blocks targets",
            ));
        }
        let Some(resolved) = self.semantic.get(phrase) else {
            return Err(OqxError::eval(format!(
                "semantic({}) needs an embedding provider; none is configured for this query",
                serde_json::Value::String(phrase.to_owned())
            )));
        };
        let vec: oqx::Result<Option<Vec<u8>>> = match t {
            Target::Docs => self
                .conn
                .query_row(
                    "SELECT vec FROM doc_embeddings WHERE doc_id = ?1 AND model = ?2",
                    rusqlite::params![col_str(row, "doc_id"), resolved.model],
                    |r| r.get(0),
                )
                .optional()
                .map_err(sql_err),
            // The row for the block's current `(raw_hash, ctx_hash)` only
            // (`spec/search` §3, 1.1): a stale context row is never read.
            _ => omgbase_store::block_vector(self.conn, &col_str(row, "block_id"), &resolved.model)
                .map_err(|e| OqxError::eval(e.to_string())),
        };
        match vec? {
            Some(v) => Ok(Value::Number(cosine_bytes(&v, &resolved.vec))),
            None => Ok(Value::Null),
        }
    }
}

/// Run `sql` and read every row as a column object (blobs as hex, integers
/// and reals as numbers) — the one shape a store row ever has in a query.
pub(crate) fn fetch_rows(
    conn: &Connection,
    sql: &str,
    params: &[SqlValue],
) -> rusqlite::Result<Vec<Object>> {
    let mut stmt = conn.prepare_cached(sql)?;
    let names: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    let rows = stmt.query_map(params_from_iter(params.iter()), |r| {
        let mut o = Object::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            o.insert(name.as_str(), sql_value(r.get_ref(i)?));
        }
        Ok(o)
    })?;
    rows.collect()
}

/// Tag a store row with its target so the context resolves it (the
/// reference's `tagRows`; the planner hands produced rows back this way).
pub(crate) fn tag_row(mut row: Object, t: Target) -> Value {
    row.insert(TAG_KEY, Value::Str(t.as_str().to_owned()));
    Value::Object(row)
}

/// [`tag_row`] over a result set.
pub(crate) fn tag_rows(rows: Vec<Object>, t: Target) -> Vec<Value> {
    rows.into_iter().map(|r| tag_row(r, t)).collect()
}

/// `cur[seg] = {}` down the path, then the leaf (a scalar in the way is
/// replaced by an object; an existing key keeps its position).
fn set_nested(out: &mut Object, path: &[&str], leaf: Value) {
    let Some((first, rest)) = path.split_first() else {
        return;
    };
    if rest.is_empty() {
        out.insert(*first, leaf);
        return;
    }
    let mut child = match out.get(first) {
        Some(Value::Object(o)) => o.clone(),
        _ => Object::new(),
    };
    set_nested(&mut child, rest, leaf);
    out.insert(*first, Value::Object(child));
}

/// A `*` glob as a `LIKE` pattern with `ESCAPE '\'`; `escape_backslash`
/// also escapes `\` (the list surfaces do, `within` does not).
#[must_use]
pub fn glob_to_like(glob: &str, escape_backslash: bool) -> String {
    let mut out = String::with_capacity(glob.len() + 4);
    for ch in glob.chars() {
        match ch {
            '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            '\\' if escape_backslash => out.push_str("\\\\"),
            '*' => out.push('%'),
            c => out.push(c),
        }
    }
    out
}

impl DataContext for StoreContext<'_> {
    fn root(&self, name: &str) -> Value {
        if let Some(rows) = self.rows_root.as_ref().filter(|_| name == oqx::ROWS_ROOT) {
            return Value::Array(rows.clone());
        }
        if name == "$repo" {
            return self.repo_root();
        }
        let Some(t) = Target::parse(name) else {
            return Value::Undefined;
        };
        // No error channel here: a failed scan is served empty and reported
        // by the runner (see `take_root_failure`).
        match self.root_scan(t) {
            Ok(rows) => rows,
            Err(e) => {
                let mut slot = self.root_failure.borrow_mut();
                if slot.is_none() {
                    *slot = Some(e);
                }
                Value::Array(Vec::new())
            }
        }
    }

    fn get(&self, row: &Value, key: &str) -> oqx::Result<Value> {
        if row.is_absent() {
            return Ok(Value::Undefined);
        }
        // `$repo` is an intrinsic of EVERY scope, so a correlated subquery at any
        // depth reaches the repository root without scope climbing.
        if key == "$repo" {
            return Ok(self.repo_root());
        }
        if is_repo_root(row) {
            if key == "$id" {
                return Ok(Value::Str(self.repo_id.clone()));
            }
            return match Target::parse(key) {
                Some(t) => self.root_scan(t),
                None => Ok(Value::Undefined),
            };
        }
        let Some(t) = target_of(row) else {
            // A plain value (parsed attrs, a property bag, a lifted element).
            return Ok(oqx::DefaultContext::read(row, key));
        };
        if key.starts_with('$') {
            return self.intrinsic(row, t, key);
        }
        // self-alias namespaces
        match (t, key) {
            (Target::Docs, "doc") | (Target::Blocks, "block") | (Target::Nodes, "section") => {
                return Ok(row.clone());
            }
            (_, "doc") => return self.owning_doc(row),
            (Target::Nodes, "block") => return self.owning_block(row),
            _ => {}
        }
        if let Some(v) = self.relation(row, t, key)? {
            return Ok(v);
        }
        let c = |k: &str| col(row, k).clone();
        Ok(match t {
            Target::Docs => {
                if key == "format" {
                    return Ok(c("format"));
                }
                let doc_id = col_str(row, "doc_id");
                if key == "frontmatter" || key == "inline" {
                    return self.doc_prop_bag(&doc_id, key);
                }
                if RESERVED_DOC_BASENAMES.contains(&key) {
                    // The reference's `FilterInvalid` thrown from `get`; the
                    // runner maps this eval error to `filter_invalid` with
                    // the same message.
                    return Err(OqxError::eval(format!(
                        "bare '{key}' reads a frontmatter key; did you mean the intrinsic ${key}? (use frontmatter.{key} to force the property)"
                    )));
                }
                return self.doc_prop(&doc_id, key, None);
            }
            Target::Blocks => match key {
                "type" => c("type"),
                "text" => c("text"),
                "attrs" => parse_json(&c("attrs")),
                _ => Self::jattr(row, key),
            },
            Target::Nodes => match key {
                "kind" => c("kind"),
                "name" => c("name"),
                "value" => c("value"),
                "attrs" => parse_json(&c("attrs")),
                _ => Self::jattr(row, key),
            },
            Target::Edges => match key {
                "predicate" | "provenance" | "dst_kind" | "anchor" | "src_field" => c(key),
                _ => Value::Undefined,
            },
        })
    }

    fn to_rows(&self, value: &Value) -> Vec<Value> {
        match value {
            Value::Undefined | Value::Null => Vec::new(),
            Value::Array(a) => a.clone(),
            other => vec![other.clone()],
        }
    }

    fn identity(&self, row: &Value) -> Value {
        match target_of(row) {
            Some(Target::Docs) => col(row, "doc_id").clone(),
            Some(Target::Blocks) => col(row, "block_id").clone(),
            Some(Target::Nodes) => col(row, "node_id").clone(),
            Some(Target::Edges) => col(row, "edge_id").clone(),
            None => row.clone(),
        }
    }

    fn call_function(&self, name: &str, args: &[Value]) -> Option<oqx::Result<Value>> {
        if name == "range" {
            let x = args.first().unwrap_or(&Value::Undefined);
            return Some(Ok(match x {
                Value::Range(_) => x.clone(),
                Value::Str(s) => match omgbase_properties::detect_range(s) {
                    Some(r) => {
                        let b = |b: &Bound| match b {
                            Bound::Open => Value::Undefined,
                            Bound::Num(n) => Value::Number(*n),
                            Bound::Iso(s) => Value::Str(s.clone()),
                        };
                        Value::from(make_range(b(&r.lo), b(&r.hi), r.exclusive_end))
                    }
                    None => Value::Null,
                },
                _ => Value::Null,
            }));
        }
        builtin_function(name, args)
    }

    fn call_method(&self, name: &str, recv: &Value, args: &[Value]) -> Option<oqx::Result<Value>> {
        if let Some(t) = target_of(recv) {
            if let Some(r) = self.row_method(name, recv, t, args) {
                return Some(r);
            }
        } else if matches!(
            name,
            "text"
                | "semantic"
                | "under"
                | "under_heading"
                | "within"
                | "under_kind"
                | "yaml_path"
                | "json_pointer"
                | "has_edge"
                | "has_anchor"
                | "child_count"
                | "parent_type"
        ) {
            return Self::filter_invalid(format!("{name}() needs a docs/blocks/nodes/edges row"));
        }
        builtin_method_with(RegexDialect::Oqx, name, recv, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_to_like_escapes() {
        assert_eq!(glob_to_like("a*/b_%", true), "a%/b\\_\\%");
        assert_eq!(glob_to_like("a\\b*", true), "a\\\\b%");
        assert_eq!(glob_to_like("a\\b*", false), "a\\b%");
    }

    #[test]
    fn rows_surfacing_as_values_render_id_and_path() {
        // §1.4 (1.2): a tagged store row anywhere in a value tree is
        // `{ id, path }`; untagged records keep their keys, minus the tag.
        let mut node = Object::new();
        node.insert("node_id", Value::Str("n_1".into()));
        node.insert("attrs", Value::Str("{\"checked\":true}".into()));
        node.insert("__path", Value::Str("a.md".into()));
        let mut doc = Object::new();
        doc.insert("doc_id", Value::Str("d_0".into()));
        doc.insert("path", Value::Str("a.md".into()));
        doc.insert("blob", Value::Str("ff".into()));
        let mut record = Object::new();
        record.insert(TAG_KEY, Value::Str("junk".into()));
        record.insert(
            "tasks",
            Value::Array(vec![
                tag_row(node, Target::Nodes),
                tag_row(doc, Target::Docs),
            ]),
        );
        let out = render_row_values(Value::Object(record));
        let o = out.as_object().unwrap();
        assert!(o.get(TAG_KEY).is_none());
        let tasks = o.get("tasks").unwrap().as_array().unwrap();
        let keys = |v: &Value| -> Vec<String> {
            v.as_object()
                .unwrap()
                .iter()
                .map(|(k, _)| k.to_owned())
                .collect()
        };
        assert_eq!(keys(&tasks[0]), ["id", "path"]);
        assert_eq!(
            tasks[0].as_object().unwrap().get("id"),
            Some(&Value::Str("n_1".into()))
        );
        assert_eq!(
            tasks[0].as_object().unwrap().get("path"),
            Some(&Value::Str("a.md".into()))
        );
        assert_eq!(keys(&tasks[1]), ["id", "path"]);
        assert_eq!(
            tasks[1].as_object().unwrap().get("id"),
            Some(&Value::Str("d_0".into()))
        );
        // An id column that is not a string still renders as its string form.
        let mut edge = Object::new();
        edge.insert("edge_id", Value::Number(7.0));
        let e = render_row_values(tag_row(edge, Target::Edges));
        assert_eq!(
            e.as_object().unwrap().get("id"),
            Some(&Value::Str("7".into()))
        );
        assert_eq!(
            e.as_object().unwrap().get("path"),
            Some(&Value::Str(String::new()))
        );
    }

    #[test]
    fn nested_property_objects_rebuild() {
        let mut o = Object::new();
        set_nested(&mut o, &["a", "b"], Value::Number(1.0));
        set_nested(&mut o, &["a", "c"], Value::Number(2.0));
        set_nested(&mut o, &["d"], Value::Str("x".into()));
        let a = o.get("a").unwrap().as_object().unwrap();
        assert_eq!(a.get("b"), Some(&Value::Number(1.0)));
        assert_eq!(a.get("c"), Some(&Value::Number(2.0)));
        assert_eq!(o.get("d"), Some(&Value::Str("x".into())));
        // A scalar in the way is replaced by an object.
        set_nested(&mut o, &["d", "e"], Value::Bool(true));
        assert!(o.get("d").unwrap().as_object().is_some());
    }

    #[test]
    fn json_and_sql_bridges() {
        assert_eq!(
            parse_json(&Value::Str("{\"a\":1}".into()))
                .as_object()
                .unwrap()
                .get("a"),
            Some(&Value::Number(1.0))
        );
        assert_eq!(
            parse_json(&Value::Str("nope".into())),
            Value::Str("nope".into())
        );
        assert_eq!(parse_json(&Value::Null), Value::Undefined);
        assert_eq!(arg_or_empty(&[], 0), "");
        assert_eq!(arg_or_empty(&[Value::Number(2.0)], 0), "2");
    }
}
