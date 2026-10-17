//! The query binding (`spec/surface/README.md` §1): a [`DataContext`] over
//! the store, so the `oqx` in-memory engine reproduces the whole OQX surface
//! — roots, intrinsics, reach-through, structural relations, the edge graph,
//! the row functions — without a bespoke compiler. Port of
//! `packages/core/src/oqx-js/context.ts`.
//!
//! Rows are the store's raw column objects (blobs as hex) carrying a hidden
//! tag column ([`TAG_KEY`]) naming their target; `get` routes field /
//! attribute / relation resolution per target, lazily querying the store.
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
//! row function — a bare target name, a store failure — is the
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
//!   `call_function`), so the `data` / `frontmatter` / `inline` source
//!   handles are materialized eagerly as plain objects — one key per
//!   top-level property in key order, valued by the scalar-vs-list rule —
//!   instead of the reference's lazy handle. `frontmatter.<k>` and
//!   `entries(frontmatter)` read the same values either way.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use omgbase_properties::Bound;
use omgbase_search::{cosine_bytes, sanitize_fts_query};
use oqx::semantics::{builtin_function, builtin_method_with, make_range, string_form};
use oqx::{
    CompiledRegex, DataContext, Object, OqxError, RegexDialect, RowIndex, Value, compile_regex,
};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OptionalExtension, params_from_iter};

use crate::dates;
use crate::paths::{reference_path, storage_path};
use crate::planner;

/// The hidden column tagging a store row with its target.
pub const TAG_KEY: &str = "__oqx_target";
/// The key of a lazy ROOT SCAN marker: `{ "__oqx_scan": "docs" }` stands for
/// `^docs` / a bare `docs` at the root until the engine reads it in row position
/// (`to_rows`) or is about to observe it as a value (`materialize` — an
/// operand, an argument, a projected item, a key), or probes it through
/// `index_for`, in which case the scan never runs. The marker never reaches
/// the language: the engine materializes every value it observes, so `==`,
/// `in`, `entries(…)`, `size(…)`, truthiness, `distinct` and `order by` see
/// the rows exactly as the reference's `Proxy` array shows them. A `Value` has
/// no identity or laziness of its own, so this is the port of that handle.
pub const SCAN_KEY: &str = "__oqx_scan";

/// The five root collections (`spec/surface` §1.1): the four live row kinds
/// and, since 4.7, `revisions` — the history target, one row per revision of
/// the repository's documents (the `revisions` × `commits` join). The
/// reference splits the name in two (`Target`, the four kinds its planner
/// pushes down and its unknown-names pass first keyed by; `Kind`/`Root`, all
/// five); here one enum tags every row, and the planner declines the fifth
/// (`crate::planner::root_target` is five-wide, `compile` plans four).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Docs,
    Blocks,
    Nodes,
    Links,
    Revisions,
}

impl Target {
    /// The root name: `docs` | `blocks` | `nodes` | `links` | `revisions`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Target::Docs => "docs",
            Target::Blocks => "blocks",
            Target::Nodes => "nodes",
            Target::Links => "links",
            Target::Revisions => "revisions",
        }
    }

    /// The target a root name denotes, if any.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "docs" => Target::Docs,
            "blocks" => Target::Blocks,
            "nodes" => Target::Nodes,
            "links" => Target::Links,
            "revisions" => Target::Revisions,
            _ => return None,
        })
    }

    /// The plural noun of the kind's rows, as the root-row messages spell it
    /// (`crate::query`: "the repository's documents").
    #[must_use]
    pub fn noun(self) -> &'static str {
        match self {
            Target::Docs => "documents",
            Target::Blocks => "blocks",
            Target::Nodes => "nodes",
            Target::Links => "links",
            Target::Revisions => "revisions",
        }
    }
}

/// THE NAME RULE (`spec/surface` §1.2, 3.0). `$` belongs to OQX: `$it`,
/// `$key`, `$depth`, `$stop`, `$leaf`, `$frontier`, `$ordinal` are values the
/// LANGUAGE injects into a scope; omgbase adds no `$` names. Every engine
/// attribute is a bare snake_case name that WINS on collision — the convention
/// the relations (`children`, `blocks`, `out_links`, `doc`, `frontmatter`, …)
/// always followed: a bare name that is an engine attribute reads the
/// engine's value, never the author's. The attributes: every row's
/// `id`/`path`; docs' and blocks' `raw`/`hash`/`updated_at`/`created_at` (4.10:
/// the commit `ts` of the thing's first revision / earliest `block_changes`
/// row — "first observed by omgbase", not a filesystem time); docs' `title`
/// (the computed title) and `tags` (authored tags ∪ body hashtags) and
/// `format`; a foreign key named for what it is (`doc_id`, `block_id`,
/// `via_id`, `dst_id`, `dst_path`, `uri`), a column its column (`type`,
/// `text`, `depth`, `ordinal`, `kind`, `predicate`, `field`). User data is
/// bare too, read by any non-colliding key; where it collides it is reached
/// through a source handle — `data` (the merged authored view: frontmatter +
/// inline by the property rule, exactly the read a bare non-colliding key
/// performs), `frontmatter`, `inline` — so `data.path` is the author's `path:`
/// key, `data.tags` the authored list alone, `data.title` the authored title.
/// There is no loud-error set: a bare `id`/`path`/`updated_at`/`hash`/`raw`
/// is simply the engine's attribute (before this batch of 3.0 the attributes
/// were `$`-prefixed and the bare spelling was an error, §9). A bare target
/// name — `docs`, `links`, … — is a loud error of its own (`crate::query`).
const DOC_ATTRIBUTES: [&str; 9] = [
    "id",
    "path",
    "raw",
    "hash",
    "updated_at",
    "created_at",
    "title",
    "tags",
    "format",
];
const BLOCK_ATTRIBUTES: [&str; 12] = [
    "id",
    "path",
    "raw",
    "hash",
    "updated_at",
    "created_at",
    "doc_id",
    "type",
    "text",
    "attrs",
    "depth",
    "ordinal",
];
const NODE_ATTRIBUTES: [&str; 8] = [
    "id", "path", "doc_id", "block_id", "kind", "name", "value", "attrs",
];
const EDGE_ATTRIBUTES: [&str; 13] = [
    "id",
    "path",
    "doc_id",
    "block_id",
    "via_id",
    "dst_id",
    "dst_path",
    "uri",
    "field",
    "dst_kind",
    "predicate",
    "provenance",
    "anchor",
];
/// The history target (`spec/surface` §1.2, 4.7): a revision row's own
/// columns under the names `docs_history` already uses (`rev`, `seq`,
/// `commit`, `origin`, `actor`, `hash`), the commit's `ts` and `reason`,
/// `is_current`, and (4.9) `archived` — the revision's bodies live in an
/// archive segment (`spec/store` §7.1; `docs_read { at }` reads through it
/// when attached).
const REVISION_ATTRIBUTES: [&str; 13] = [
    "id",
    "path",
    "rev",
    "seq",
    "doc_id",
    "commit",
    "ts",
    "origin",
    "actor",
    "reason",
    "hash",
    "is_current",
    "archived",
];
/// The engine attributes per kind (`spec/surface` §1.2 table).
#[must_use]
pub fn attributes(t: Target) -> &'static [&'static str] {
    match t {
        Target::Docs => &DOC_ATTRIBUTES,
        Target::Blocks => &BLOCK_ATTRIBUTES,
        Target::Nodes => &NODE_ATTRIBUTES,
        Target::Links => &EDGE_ATTRIBUTES,
        Target::Revisions => &REVISION_ATTRIBUTES,
    }
}

/// The revisions scan (`spec/surface` §1.1, 4.7): every revision of every
/// document of the repository — tombstoned documents included, history is
/// history — with its commit. The `revisions` table carries no `repo_id`, so
/// the repository guard joins `docs`. `is_current` is `docs_history`'s
/// `isCurrent`: the revision is the document's `current_rev`. The planner's
/// clauses for the kind ([`crate::planner::columns`], `from_clause`) are
/// these same strings.
pub(crate) const REVISION_COLS: &str = "r.rev_id, r.doc_id, r.seq, r.rendered_hash, r.path, r.commit_id, c.ts, c.origin, c.actor, c.reason, (d.current_rev = r.rev_id) AS is_current, (r.archive IS NOT NULL) AS archived";
pub(crate) const REVISION_FROM: &str =
    "revisions r JOIN docs d ON d.doc_id = r.doc_id JOIN commits c ON c.commit_id = r.commit_id";
/// The source handles of a document (§1.2): `data` is the merged authored
/// view (frontmatter + inline), the other two one source each.
pub const SOURCE_HANDLES: [&str; 3] = ["data", "frontmatter", "inline"];

/// The key marking a LAZY OWNER row (foreign-key elimination, `spec/surface`
/// §1, 3.0): the owner a reach-through hands out (`doc` on a block, node or
/// edge; `block` on a node) carries only the columns the child row already
/// knows — `doc_id` + `path` (from the child's `doc_id`/`src_doc` and
/// `__path`), or `block_id` + `doc_id` + `__path` — tagged with the owner's
/// target, plus this key. `get` answers `id`, `path`, the owner's own
/// foreign keys, its relations and its properties (which need only the id)
/// from those columns and runs NO statement, exactly like the bare `doc_id`;
/// the first read of anything else (`format`, `hash`, `text`, …) loads the
/// full row ([`StoreContext::owner_full`], memoized per run). The port of the
/// reference's `lazyOwner` Proxy. The marker is a tagged row to everything
/// else (`identity`, `render_row_values`, `materialize`, hits) and the hidden
/// key is stripped with the tag.
pub const LAZY_KEY: &str = "__oqx_lazy";

/// The value of a statically SINGLE relation that has no row — `dst` on an
/// external or dangling link, `block` on a node without one (oqx 0.20,
/// SEMANTICS §3): an object the engine treats as one row with no rows
/// (`to_rows` empty, `is_single` true), so `dst { title }` is absent rather
/// than `[]`, while as a VALUE it is absent (`materialize`), so `dst == null`,
/// `has(dst)` and `dst.title` read as before. The port of the reference's
/// `ABSENT_SINGLE`.
pub const ABSENT_KEY: &str = "__oqx_absent";

fn absent_single() -> Value {
    let mut o = Object::with_capacity(1);
    o.insert(ABSENT_KEY, Value::Bool(true));
    Value::Object(o)
}

/// Whether `v` is the absent-single marker.
fn is_absent_single(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == 1 && o.contains_key(ABSENT_KEY))
}

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
    rows_root: Option<RowsRoot>,
    /// `matches()` patterns compiled during this run, by `(String(pattern),
    /// flags)`; see [`Self::matches_memoized`].
    regexes: RefCell<HashMap<(String, Option<String>), CompiledRegex>>,
    /// Root scans read during this run, by target: a context lives for one
    /// run, during which the store does not change, so `^docs` read from
    /// every outer row is one SELECT, not one per row.
    scans: RefCell<HashMap<Target, Rc<Vec<Value>>>>,
    /// How many root scans actually ran (tests prove a probe runs none).
    scans_run: Cell<usize>,
    /// How many statements this context has run in all (`all` / `exists`),
    /// so a test can prove a reach-through to the owner's identity runs none.
    statements_run: Cell<usize>,
    /// Lazy owners loaded in full during this run, by `(target, id)` — the
    /// store does not change within a run, so an owner is read at most once.
    owners: RefCell<HashMap<(Target, String), Option<Value>>>,
    /// The instant the named points of `date()` resolve against
    /// (`spec/surface` §1.3, 4.8): the host clock, UTC, as milliseconds —
    /// the wall clock unless the runner threads a pinned one in
    /// ([`Self::with_now_ms`]); read once per run.
    now_ms: i64,
}

/// The planned rows behind [`oqx::ROWS_ROOT`]: cloned out on every read, or
/// — when the runner has proven the residual reads the root exactly once —
/// moved out on the first read (`once`), which spares one deep copy and one
/// drop of every produced row.
struct RowsRoot {
    rows: RefCell<Option<Vec<Value>>>,
    once: bool,
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

/// Whether `row` is a lazy owner (see [`LAZY_KEY`]).
fn is_lazy_owner(row: &Value) -> bool {
    row.as_object().is_some_and(|o| o.contains_key(LAZY_KEY))
}

/// The target of a lazy root-scan marker, if `v` is one.
#[must_use]
pub fn scan_of(v: &Value) -> Option<Target> {
    v.as_object()
        .and_then(|o| o.get(SCAN_KEY))
        .and_then(Value::as_str)
        .and_then(Target::parse)
}

fn scan_marker(t: Target) -> Value {
    let mut o = Object::with_capacity(1);
    o.insert(SCAN_KEY, Value::Str(t.as_str().to_owned()));
    Value::Object(o)
}

/// The five root collections, in the order the root object lists them
/// (`spec/surface` §1.1; `revisions` the fifth since 4.7).
pub const ALL_TARGETS: [Target; 5] = [
    Target::Docs,
    Target::Blocks,
    Target::Nodes,
    Target::Links,
    Target::Revisions,
];

/// Whether `row` is the root object ([`StoreContext::root_object`]): a plain
/// object whose own keys are exactly the five collections, each the lazy
/// marker of its target. Recognized by shape — a hidden tag would show up in
/// `entries(^$it)`, which must name exactly the collections.
fn is_root_object(row: &Value) -> bool {
    row.as_object().is_some_and(|o| {
        o.len() == ALL_TARGETS.len()
            && ALL_TARGETS
                .iter()
                .all(|t| o.get(t.as_str()).is_some_and(|v| scan_of(v) == Some(*t)))
    })
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
                .filter(|(k, _)| k != TAG_KEY && k != LAZY_KEY)
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
/// (3.0: the hit envelope's own keys, spelled as the attributes; the target's
/// id column as a string; the owning document's path in the reference form,
/// §1 "Paths": a docs row's `path`, every other row's `__path` join column,
/// rooted), never the store row. Everything else
/// recurses, dropping the hidden tag as [`strip_tags`].
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
                    Target::Links => ("edge_id", "__path"),
                    // a revision's path is `revisions.path` — the path it was
                    // committed under (a move re-paths the current revision; §1.2, 4.7).
                    Target::Revisions => ("rev_id", "path"),
                };
                let mut out = Object::with_capacity(2);
                out.insert(crate::query::HIT_ID, Value::Str(col_str(&row, id_col)));
                let path = match col(&row, path_col) {
                    Value::Undefined | Value::Null => String::new(),
                    v => reference_path(&js_string(v)),
                };
                out.insert(crate::query::HIT_PATH, Value::Str(path));
                return Value::Object(out);
            }
            let Value::Object(o) = row else {
                unreachable!()
            };
            Value::Object(
                o.into_iter()
                    .filter(|(k, _)| k != TAG_KEY && k != LAZY_KEY)
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
            regexes: RefCell::new(HashMap::new()),
            scans: RefCell::new(HashMap::new()),
            scans_run: Cell::new(0),
            statements_run: Cell::new(0),
            owners: RefCell::new(HashMap::new()),
            now_ms: dates::wall_clock_ms(),
        }
    }

    /// Resolve the named points of `date()` (`today`, `now`, `sow`…) at
    /// `now_ms` instead of the wall clock — the `Surface`'s clock, which
    /// `OMGBASE_SPEC_CLOCK` pins (§1.3, 4.8).
    #[must_use]
    pub fn with_now_ms(mut self, now_ms: i64) -> Self {
        self.now_ms = now_ms;
        self
    }

    /// The instant `date("now")` reads in this run.
    #[must_use]
    pub fn now_ms(&self) -> i64 {
        self.now_ms
    }

    /// How many statements this context has run (every `SELECT`, the root
    /// scans included). A reach-through to the owner's identity adds none.
    #[must_use]
    pub fn statements_run(&self) -> usize {
        self.statements_run.get()
    }

    /// The repository this context is scoped to.
    #[must_use]
    pub fn repo_id(&self) -> &str {
        &self.repo_id
    }

    /// How many root scans (`SELECT … FROM <target>` whole) this context has
    /// run — at most one per target per run; none for a block whose probes
    /// the store indexes answered.
    #[must_use]
    pub fn scans_run(&self) -> usize {
        self.scans_run.get()
    }

    /// The rows of a root scan, read once per run and shared.
    pub(crate) fn scan_rows(&self, t: Target) -> oqx::Result<Rc<Vec<Value>>> {
        if let Some(rows) = self.scans.borrow().get(&t) {
            return Ok(Rc::clone(rows));
        }
        self.scans_run.set(self.scans_run.get() + 1);
        let rows = match self.root_scan(t)? {
            Value::Array(rows) => Rc::new(rows),
            _ => Rc::new(Vec::new()),
        };
        self.scans.borrow_mut().insert(t, Rc::clone(&rows));
        Ok(rows)
    }

    /// `refs(x)` (`spec/surface` §1.3, 1.5): the live documents the document
    /// references held in a property name. `x` is a string, a list, or absent;
    /// every string element that names a live document of this repo — a doc
    /// id (`d_…`), a repo-root-absolute path (`/a/b.md`) or a bare
    /// repo-relative path (`a/b.md`) — resolves to that document's row;
    /// anything else (a dangling reference, a non-string element) is dropped.
    /// Order preserved, duplicates kept. Port of the reference's `refs`.
    fn refs(&self, x: &Value) -> oqx::Result<Value> {
        let items: Vec<&Value> = match x {
            Value::Undefined | Value::Null => Vec::new(),
            Value::Array(a) => a.iter().collect(),
            other => vec![other],
        };
        let mut out = Vec::new();
        for item in items {
            if let Value::Str(s) = item
                && let Some(row) = self.ref_doc(s)?
            {
                out.push(row);
            }
        }
        Ok(Value::Array(out))
    }

    /// One document reference resolved: by `path` after stripping one leading
    /// `/`, else — when it begins with `d_` — by `doc_id`. Each is one indexed
    /// lookup under the root scan's guards, columns and order
    /// ([`crate::planner`]), so the row is indistinguishable from a scanned one
    /// and the docs root is never read.
    fn ref_doc(&self, r: &str) -> oqx::Result<Option<Value>> {
        let t = Target::Docs;
        let lookup = |column: &str, value: &str| -> oqx::Result<Option<Value>> {
            let sql = format!(
                "SELECT {} FROM {} WHERE {} AND d.{column} = ? ORDER BY {}",
                planner::columns(t),
                planner::from_clause(t),
                planner::guards(t),
                planner::order_clause(t)
            );
            let params = [
                SqlValue::Text(self.repo_id.clone()),
                SqlValue::Text(value.to_owned()),
            ];
            Ok(self.one(&sql, &params)?.map(|row| tag_row(row, t)))
        };
        if let Some(row) = lookup("path", storage_path(r))? {
            return Ok(Some(row));
        }
        if r.starts_with("d_") {
            return lookup("doc_id", r);
        }
        Ok(None)
    }

    /// The tagged rows of one store-index probe statement (`store_index`).
    pub(crate) fn probe_rows(
        &self,
        t: Target,
        sql: &str,
        params: &[SqlValue],
    ) -> oqx::Result<Vec<Value>> {
        Ok(tag_rows(self.all(sql, params)?, t))
    }

    /// A lazy root-scan marker expanded to its rows (`Err` → recorded as the
    /// run's root failure, served empty — the `root` discipline).
    fn expand_scan(&self, t: Target) -> Vec<Value> {
        match self.scan_rows(t) {
            Ok(rows) => rows.as_ref().clone(),
            Err(e) => {
                let mut slot = self.root_failure.borrow_mut();
                if slot.is_none() {
                    *slot = Some(e);
                }
                Vec::new()
            }
        }
    }

    /// Serve `rows` — target-tagged store rows a plan produced — as the
    /// [`oqx::ROWS_ROOT`] scan (the residual query's source). Every other
    /// root and every relation, intrinsic and row function still hits the
    /// store, so the residual sees exactly what a full scan would.
    #[must_use]
    pub fn with_rows_root(mut self, rows: Vec<Value>) -> Self {
        self.rows_root = Some(RowsRoot {
            rows: RefCell::new(Some(rows)),
            once: false,
        });
        self
    }

    /// [`Self::with_rows_root`] for a residual whose ONLY read of
    /// [`oqx::ROWS_ROOT`] is its source scan (the runner checks the AST: the
    /// name appears nowhere else — no `^`-reach, no `limit`/`offset`, no
    /// nested mention): the rows are moved out on that first read instead
    /// of deep-copied, and a second read — which cannot happen — would see
    /// an empty scan. Same results as [`Self::with_rows_root`], one row copy
    /// and one drop fewer.
    #[must_use]
    pub fn with_rows_root_once(mut self, rows: Vec<Value>) -> Self {
        self.rows_root = Some(RowsRoot {
            rows: RefCell::new(Some(rows)),
            once: true,
        });
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
        self.statements_run.set(self.statements_run.get() + 1);
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
        self.statements_run.set(self.statements_run.get() + 1);
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

    /// The root row (`spec/surface` §1.1, 2.0; `spec/oqx` 0.18 `root_object`):
    /// the repository, reached as `^$it` from a top-level row (`0^$it` from any
    /// depth). Its own keys are the five collections as lazy markers (in
    /// [`ALL_TARGETS`] order), so
    /// `entries(^$it)` names them without running a scan and `^$it.docs` is
    /// the same scan as `^docs`; `get` answers `id` with the repository id (an
    /// intrinsic, not an entry). Same shape as the reference's root row.
    fn root_row(&self) -> Value {
        let mut o = Object::with_capacity(ALL_TARGETS.len());
        for t in ALL_TARGETS {
            o.insert(t.as_str(), scan_marker(t));
        }
        Value::Object(o)
    }

    // ---- roots (ordered for a stable (path, id) default) ------------------------------

    /// The joined roots drive from `docs` in `(repo_id, path)` index order
    /// (`CROSS JOIN` fixes the loop order) and reach the rows of each doc
    /// through their `doc_id` index, so the `ORDER BY d.path, <id>` sorts one
    /// document's rows at a time instead of every full row of the repo in a
    /// temp b-tree. The `+` on the inner `repo_id` term keeps it a filter
    /// (SQLite's unary-plus idiom: the term is not used for index selection,
    /// which — without `ANALYZE` stats — would otherwise pick the
    /// `(repo_id, type)` index and rescan the repo per document). Same rows,
    /// same order: the key `(path, id)` is total (`UNIQUE (repo_id, path)`;
    /// the id is a primary key), so no plan can order them differently.
    fn root_scan(&self, t: Target) -> oqx::Result<Value> {
        let repo = [SqlValue::Text(self.repo_id.clone())];
        let sql = match t {
            Target::Docs => {
                "SELECT * FROM docs WHERE repo_id = ?1 AND deleted_commit IS NULL ORDER BY path, doc_id"
            }
            Target::Blocks => {
                "SELECT b.*, d.path AS __path FROM docs d CROSS JOIN blocks b ON b.doc_id = d.doc_id
                 WHERE d.repo_id = ?1 AND +b.repo_id = ?1 AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL
                 ORDER BY d.path, b.block_id"
            }
            Target::Nodes => {
                "SELECT n.*, d.path AS __path FROM docs d CROSS JOIN nodes n ON n.doc_id = d.doc_id
                 WHERE d.repo_id = ?1 AND +n.repo_id = ?1 AND d.deleted_commit IS NULL ORDER BY d.path, n.node_id"
            }
            Target::Links => {
                "SELECT e.*, d.path AS __path FROM docs d CROSS JOIN edges e ON e.src_doc = d.doc_id
                 WHERE d.repo_id = ?1 AND +e.repo_id = ?1 AND e.to_commit IS NULL AND d.deleted_commit IS NULL
                 ORDER BY d.path, e.edge_id"
            }
            // The history (4.7): its own statement, in the same `(path, id)`
            // keyset order as every target — `(path as of the revision, rev_id)`.
            Target::Revisions => {
                let sql = format!(
                    "SELECT {REVISION_COLS} FROM {REVISION_FROM} WHERE d.repo_id = ?1 ORDER BY r.path, r.rev_id"
                );
                return Ok(Self::tag_all(self.all(&sql, &repo)?, t));
            }
        };
        Ok(Self::tag_all(self.all(sql, &repo)?, t))
    }

    /// A document's revisions (the `revisions` relation of a docs row, §1.2,
    /// 4.7): oldest first, as `docs_history` lists them.
    fn doc_revisions(&self, doc_id: &str) -> oqx::Result<Value> {
        let sql = format!(
            "SELECT {REVISION_COLS} FROM {REVISION_FROM} WHERE r.doc_id = ?1 ORDER BY r.seq"
        );
        Ok(Self::tag_all(
            self.all(&sql, &[SqlValue::Text(doc_id.to_owned())])?,
            Target::Revisions,
        ))
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

    /// The `data` / `frontmatter` / `inline` bag as a plain object: one entry
    /// per top-level key in key order, each valued by [`Self::doc_prop`].
    /// `data` (`None`) is frontmatter ∪ inline — the keys deduped, each valued
    /// by the merged read.
    fn doc_prop_bag(&self, doc_id: &str, source: Option<&str>) -> oqx::Result<Value> {
        let keys = match source {
            Some(s) => self.all(
                "SELECT DISTINCT key FROM properties WHERE doc_id = ?1 AND source = ?2 AND deleted_commit IS NULL ORDER BY key",
                &[SqlValue::Text(doc_id.to_owned()), SqlValue::Text(s.to_owned())],
            )?,
            None => self.all(
                "SELECT DISTINCT key FROM properties WHERE doc_id = ?1 AND source IN ('frontmatter', 'inline') AND deleted_commit IS NULL ORDER BY key",
                &[SqlValue::Text(doc_id.to_owned())],
            )?,
        };
        let mut out = Object::new();
        for k in keys {
            let key = k.get("key").and_then(Value::as_str).unwrap_or("");
            let top = key.split('.').next().unwrap_or("");
            if !out.contains_key(top) {
                let v = self.doc_prop(doc_id, top, source)?;
                out.insert(top, v);
            }
        }
        Ok(Value::Object(out))
    }

    /// `tags` on a document: authored ∪ hashtags, each list as the property
    /// rule reads it (a scalar-authored `tags: x` is one element), deduped by
    /// canonical JSON of each element, authored first in authored order, then
    /// the computed `$tags` row (body hashtags, `spec/properties` §3.3) in
    /// document order; `Null` when both are absent.
    fn doc_tags(&self, doc_id: &str) -> oqx::Result<Value> {
        fn as_list(v: Value) -> Vec<Value> {
            match v {
                Value::Undefined | Value::Null => Vec::new(),
                Value::Array(a) => a,
                other => vec![other],
            }
        }
        let authored = as_list(self.doc_prop(doc_id, "tags", None)?);
        let hashtags = as_list(self.doc_prop(doc_id, "$tags", Some("computed"))?);
        if authored.is_empty() && hashtags.is_empty() {
            return Ok(Value::Null);
        }
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for v in authored.into_iter().chain(hashtags) {
            let k = v.to_canonical_json().to_string();
            if seen.contains(&k) {
                continue;
            }
            seen.push(k);
            out.push(v);
        }
        Ok(Value::Array(out))
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
            // A document's revision list (`spec/surface` §1.2, 4.7), oldest first.
            (Target::Docs, "revisions") => self.doc_revisions(&col_str(row, "doc_id"))?,
            // The linked / linking DOCUMENTS are reached through the link rows
            // (3.0 follow-up, §9: the `out` / `in` relations are gone):
            // `out_links collect distinct { from dst }` and `in_links collect
            // distinct { from doc }`.
            (Target::Docs, "out_links") => Self::tag_all(
                self.all(
                    "SELECT e.*, ?1 AS __path FROM edges e WHERE e.src_doc = ?2 AND e.to_commit IS NULL ORDER BY e.predicate, e.edge_id",
                    &[doc_path(), doc_id()],
                )?,
                Target::Links,
            ),
            (Target::Docs, "in_links") => Self::tag_all(
                self.all(
                    "SELECT e.*, d.path AS __path FROM edges e JOIN docs d ON d.doc_id = e.src_doc
                     WHERE e.dst_node = ?1 AND e.to_commit IS NULL AND d.deleted_commit IS NULL ORDER BY e.predicate, e.edge_id",
                    &[doc_id()],
                )?,
                Target::Links,
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
            (Target::Blocks, "out_links") => Self::tag_all(
                self.all(
                    "SELECT e.*, ?1 AS __path FROM edges e WHERE e.src_block = ?2 AND e.to_commit IS NULL ORDER BY e.predicate, e.edge_id",
                    &[path(), block_id()],
                )?,
                Target::Links,
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

    // ---- owning-entity reach-through: foreign-key elimination ------------------------
    //
    // The owner is handed out as a LAZY row (`LAZY_KEY`) whose identity columns
    // are already known from the child — a block's/node's `doc_id` and `__path`
    // name its document, an edge's `src_doc` and `__path` its source doc, a
    // node's `block_id` (+ `doc_id`, `__path`) its block — so `doc.id` and
    // `doc.path` (and `block.id`/`block.path`/`block.doc_id` on a node)
    // read those columns and run NO statement, exactly like the bare `doc_id`;
    // the full owner row is loaded on the first read of anything else
    // (`doc.format`, `block.text`). The translator mirrors this in SQL
    // (`doc.id` → the FK column). Port of the reference's `lazyOwner` Proxy.

    fn lazy_owner(known: &[(&str, Value)], t: Target) -> Value {
        let mut o = Object::with_capacity(known.len() + 2);
        for (k, v) in known {
            o.insert(*k, v.clone());
        }
        o.insert(LAZY_KEY, Value::Bool(true));
        tag_row(o, t)
    }

    fn owning_doc(&self, row: &Value) -> oqx::Result<Value> {
        let id = match col(row, "doc_id") {
            Value::Undefined | Value::Null => col(row, "src_doc").clone(),
            v => v.clone(),
        };
        if id.is_absent() {
            return Ok(absent_single());
        }
        match col(row, "__path") {
            Value::Str(path) => Ok(Self::lazy_owner(
                &[("doc_id", id), ("path", Value::Str(path.clone()))],
                Target::Docs,
            )),
            _ => Ok(self
                .load_owner(Target::Docs, &js_string(&id))?
                .unwrap_or_else(absent_single)),
        }
    }

    /// `dst` on a link row (`spec/surface` §1.2, 3.0 follow-up): the
    /// destination DOCUMENT row when the link points at one (`dst_kind ==
    /// "document"` and the document exists — a phantom target has the kind
    /// and no row), read by `dst_id` exactly as `dst_path` is; absent for a
    /// `block` or `external` destination (never reached into). `doc` stays
    /// the source document.
    fn destination_doc(&self, row: &Value) -> oqx::Result<Value> {
        if col(row, "dst_kind") != &Value::Str("document".to_owned()) {
            return Ok(absent_single());
        }
        Ok(self
            .load_owner(Target::Docs, &col_str(row, "dst_node"))?
            .unwrap_or_else(absent_single))
    }

    /// `doc` on a revision row (`spec/surface` §1.2, 4.7): the document's
    /// CURRENT live row — the revision's `path` may be an earlier one — and
    /// absent (the single-with-no-row marker, as `dst` on a dangling link)
    /// for a tombstoned document: its revisions are rows, `doc == null` tells
    /// them apart. Read in full, as the reference does (not a lazy owner: the
    /// liveness test is the point of the read).
    fn revision_doc(&self, row: &Value) -> oqx::Result<Value> {
        Ok(self
            .one(
                "SELECT * FROM docs WHERE doc_id = ?1 AND deleted_commit IS NULL",
                &[SqlValue::Text(col_str(row, "doc_id"))],
            )?
            .map_or_else(absent_single, |o| Self::tag(o, Target::Docs)))
    }

    fn owning_block(&self, row: &Value) -> oqx::Result<Value> {
        let id = col(row, "block_id");
        if !id.truthy() {
            return Ok(absent_single());
        }
        match col(row, "__path") {
            Value::Str(path) => Ok(Self::lazy_owner(
                &[
                    ("block_id", id.clone()),
                    ("doc_id", col(row, "doc_id").clone()),
                    ("__path", Value::Str(path.clone())),
                ],
                Target::Blocks,
            )),
            _ => Ok(self
                .load_owner(Target::Blocks, &js_string(id))?
                .unwrap_or_else(absent_single)),
        }
    }

    /// `block` on a link row (`spec/surface` §1.2, 4.11): the SOURCE block
    /// the link was written in — the blocks row `block_id` (the edge's
    /// `src_block`) names, in the source document (`__path` is already the
    /// block's document path) — mirroring `doc`; absent when the link has
    /// none (a frontmatter link).
    fn link_block(&self, row: &Value) -> oqx::Result<Value> {
        let id = col(row, "src_block");
        if !id.truthy() {
            return Ok(absent_single());
        }
        match col(row, "__path") {
            Value::Str(path) => Ok(Self::lazy_owner(
                &[
                    ("block_id", id.clone()),
                    ("doc_id", col(row, "src_doc").clone()),
                    ("__path", Value::Str(path.clone())),
                ],
                Target::Blocks,
            )),
            _ => Ok(self
                .load_owner(Target::Blocks, &js_string(id))?
                .unwrap_or_else(absent_single)),
        }
    }

    /// The full owner row by id (`None` when it is not in the store), read
    /// at most once per run.
    fn load_owner(&self, t: Target, id: &str) -> oqx::Result<Option<Value>> {
        let key = (t, id.to_owned());
        if let Some(v) = self.owners.borrow().get(&key) {
            return Ok(v.clone());
        }
        let loaded = match t {
            Target::Docs => self
                .one(
                    "SELECT * FROM docs WHERE doc_id = ?1",
                    &[SqlValue::Text(id.to_owned())],
                )?
                .map(|o| Self::tag(o, Target::Docs)),
            _ => self
                .one(
                    "SELECT b.*, d.path AS __path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?1",
                    &[SqlValue::Text(id.to_owned())],
                )?
                .map(|o| Self::tag(o, Target::Blocks)),
        };
        self.owners.borrow_mut().insert(key, loaded.clone());
        Ok(loaded)
    }

    /// Whether reading `key` off a lazy owner of `t` needs the full row. The
    /// known columns answer the identity (`id`, `path`), the self alias, the
    /// relations (keyed by `doc_id` / `path` / `block_id`), the properties
    /// and source handles (keyed by `doc_id`), `raw`, `title` and `tags` on
    /// docs (by id), `updated_at` on blocks (by id), a bare target name (an
    /// error) and an unknown `$x` (absent); everything that reads another
    /// column — `format`, `hash`, `updated_at` on docs; `type`, `text`,
    /// `attrs`, `ordinal`, `depth`, an attrs key, `section`, `raw`/`hash` on
    /// blocks — loads it.
    fn lazy_needs_load(t: Target, key: &str) -> bool {
        match t {
            Target::Docs => matches!(key, "format" | "hash" | "updated_at"),
            Target::Blocks => {
                !matches!(
                    key,
                    "id" | "path"
                        | "updated_at"
                        | "$self"
                        | "doc_id"
                        | "block"
                        | "doc"
                        | "children"
                        | "nodes"
                        | "out_links"
                ) && Target::parse(key).is_none()
            }
            // never handed out as lazy owners
            Target::Nodes | Target::Links | Target::Revisions => true,
        }
    }

    /// A lazy owner with the full row in its place when `key` needs it; the
    /// marker itself otherwise (`None` for a row that is not a lazy owner, or
    /// whose owner is gone from the store — then the partial columns stand).
    fn resolve_lazy(&self, row: &Value, t: Target, key: &str) -> oqx::Result<Option<Value>> {
        if !is_lazy_owner(row) || !Self::lazy_needs_load(t, key) {
            return Ok(None);
        }
        let id_col = if t == Target::Docs {
            "doc_id"
        } else {
            "block_id"
        };
        self.load_owner(t, &col_str(row, id_col))
    }

    // ---- engine attributes --------------------------------------------------------------

    fn null_if_absent(v: Value) -> Value {
        if v.is_absent() { Value::Null } else { v }
    }

    /// The engine attributes (see the name rule above; `spec/surface` §1.2,
    /// 3.0): bare, snake_case, winning on collision. `path` (and the edge
    /// field `dst_path`) is the REFERENCE form (`/a/b.md`, §1 "Paths", 2.0):
    /// the rows carry the storage form (`path`, the `__path` join column) and
    /// the read roots it, so nothing below the binding changes. The runner
    /// roots the string literals a query compares them with. The caller has
    /// checked `name` against [`attributes`], so the fallthrough is unreachable
    /// in practice (`Undefined`).
    fn attribute(&self, row: &Value, t: Target, name: &str) -> oqx::Result<Value> {
        let c = |k: &str| col(row, k).clone();
        let rooted = |k: &str| Value::Str(reference_path(&col_str(row, k)));
        Ok(match (t, name) {
            (Target::Docs, "id") => c("doc_id"),
            (Target::Docs, "path") => rooted("path"),
            (Target::Docs, "hash") => Self::null_if_absent(c("file_hash")),
            (Target::Docs, "updated_at") => Self::null_if_absent(self.scalar(
                "SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = ?1",
                &[to_sql(&c("current_rev"))],
            )?),
            // `created_at` (4.10): the commit `ts` of the document's first
            // revision (`seq = 1`, the row `revisions first { ts values }`
            // reads) — when omgbase first observed the document, not a
            // filesystem time. The retention squash (`spec/store` §7.1, 15.0)
            // keeps every revision and commit row, so the value survives
            // archiving.
            (Target::Docs, "created_at") => Self::null_if_absent(self.scalar(
                "SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.doc_id = ?1 AND r.seq = 1",
                &[to_sql(&c("doc_id"))],
            )?),
            // `raw`: the exact file bytes (`spec/store` §6.1, frontmatter included).
            (Target::Docs, "raw") => {
                match omgbase_store::read::reconstruct(self.conn, &col_str(row, "doc_id")) {
                    Ok(Some(s)) => Value::Str(s),
                    Ok(None) => Value::Null,
                    Err(e) => return Err(OqxError::eval(e.to_string())),
                }
            }
            // `title`: the computed title (`spec/properties` §3.3 — the
            // authored title, else the first H1, else absent → null); the
            // store writes it under `$title`. `data.title` is the authored
            // one alone.
            (Target::Docs, "title") => {
                Self::null_if_absent(self.doc_prop(&col_str(row, "doc_id"), "$title", Some("computed"))?)
            }
            // `tags`: authored tags ∪ body `#hashtags` (the computed `$tags`
            // row); `data.tags` is the authored list alone.
            (Target::Docs, "tags") => self.doc_tags(&col_str(row, "doc_id"))?,
            (Target::Docs, "format") => c("format"),
            (Target::Blocks, "id") => c("block_id"),
            (Target::Blocks, "path") => rooted("__path"),
            // `raw`: the block's raw source bytes — the blob its `raw_hash`
            // names (a container's raw holds its children verbatim); `text`
            // is the normalized text.
            (Target::Blocks, "raw") => match c("raw_hash") {
                Value::Str(hex) => {
                    let hash = omgbase_store::tree::from_hex(&hex)
                        .map_err(|e| OqxError::eval(e.to_string()))?;
                    let bytes: Option<Vec<u8>> = self
                        .conn
                        .query_row(
                            "SELECT bytes FROM blobs WHERE hash = ?1",
                            rusqlite::params![hash],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(sql_err)?;
                    self.statements_run.set(self.statements_run.get() + 1);
                    bytes.map_or(Value::Null, |b| {
                        Value::Str(String::from_utf8_lossy(&b).into_owned())
                    })
                }
                _ => Value::Null,
            },
            (Target::Blocks, "hash") => Self::null_if_absent(c("raw_hash")),
            (Target::Blocks, "updated_at") => Self::null_if_absent(self.scalar(
                "SELECT MAX(c.ts) FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?1",
                &[to_sql(&c("block_id"))],
            )?),
            // `created_at` (4.10): the EARLIEST commit `ts` among the block's
            // `block_changes` — the same join as `updated_at` under MIN: the
            // commit that first wrote the id (`inserted`, or the split/merge
            // lineage row that minted it). Store 14.2 keeps that row and the
            // 15.0 squash keeps each block's earliest row (`spec/store` §7.1),
            // so it survives archiving; a resurrected block keeps its original
            // creation.
            (Target::Blocks, "created_at") => Self::null_if_absent(self.scalar(
                "SELECT MIN(c.ts) FROM block_changes bc JOIN commits c ON c.commit_id = bc.commit_id WHERE bc.block_id = ?1",
                &[to_sql(&c("block_id"))],
            )?),
            // The structural columns and the foreign keys under the surface's
            // names (§1.2, 3.0).
            (Target::Blocks, "doc_id" | "type" | "text" | "ordinal" | "depth") => c(name),
            (Target::Blocks | Target::Nodes, "attrs") => parse_json(&c("attrs")),
            (Target::Nodes, "id") => c("node_id"),
            (Target::Nodes, "path") => rooted("__path"),
            (Target::Nodes, "doc_id" | "kind" | "name" | "value") => c(name),
            (Target::Nodes, "block_id") => Self::null_if_absent(c("block_id")),
            // edges: the store's columns under the surface's names (a foreign
            // key is named for what it is, the `src_field` column is `field`).
            (Target::Links, "id") => c("edge_id"),
            (Target::Links, "path") => rooted("__path"),
            (Target::Links, "doc_id") => c("src_doc"),
            (Target::Links, "block_id") => Self::null_if_absent(c("src_block")),
            (Target::Links, "via_id") => Self::null_if_absent(c("via_node")),
            (Target::Links, "dst_id") => c("dst_node"),
            (Target::Links, "dst_path") => match self.scalar(
                "SELECT path FROM docs WHERE doc_id = ?1",
                &[to_sql(&c("dst_node"))],
            )? {
                Value::Undefined | Value::Null => Value::Null,
                p => Value::Str(reference_path(&js_string(&p))),
            },
            (Target::Links, "uri") => Self::null_if_absent(self.scalar(
                "SELECT uri FROM external_nodes WHERE node_id = ?1",
                &[to_sql(&c("dst_node"))],
            )?),
            (Target::Links, "field") => Self::null_if_absent(c("src_field")),
            (Target::Links, "predicate" | "provenance" | "dst_kind" | "anchor") => c(name),
            // revisions: the `revisions` × `commits` columns under
            // docs_history's names (`spec/surface` §1.2, 4.7). `rendered_hash`
            // is a blob, already hex (`sql_value`).
            (Target::Revisions, "id" | "rev") => c("rev_id"),
            (Target::Revisions, "path") => rooted("path"),
            (Target::Revisions, "seq" | "doc_id" | "ts" | "origin") => c(name),
            (Target::Revisions, "commit") => c("commit_id"),
            (Target::Revisions, "actor" | "reason") => Self::null_if_absent(c(name)),
            (Target::Revisions, "hash") => c("rendered_hash"),
            (Target::Revisions, "is_current" | "archived") => Value::Bool(matches!(
                c(name),
                Value::Number(n) if n == 1.0
            )),
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
            // `within(t)`: a doc id, else a path in either form (`/texts/*`,
            // `texts/*`, `texts/x.md`) matched against the storage path.
            "within" => Self::require_target(t, Target::Blocks, name).or_else(|| {
                let target = js_string(args.first().unwrap_or(&Value::Undefined));
                if target.starts_with("d_") {
                    return Some(Ok(Value::Bool(col_str(row, "doc_id") == target)));
                }
                let target = storage_path(&target).to_owned();
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
        // links and revisions (4.7) have no indexed body: `filter_invalid`.
        if matches!(t, Target::Links | Target::Revisions) {
            return Err(OqxError::eval(format!(
                "text(...) is not available on the {} target",
                t.as_str()
            )));
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

    /// `recv.matches(pattern[, flags])` exactly as the builtin computes it —
    /// an absent receiver is `false` before the pattern is looked at, the
    /// pattern is `String(args[0])`, the flags are `args[1]`, then
    /// [`CompiledRegex::is_match`] on the receiver's string form — with the
    /// compiled pattern held for the run. The builtin's own cache hands out
    /// clones of the `regex::Regex`, and a clone starts with an empty
    /// search-cache pool, so a scan paid a lazy-DFA cache allocation (and its
    /// drop) per row. Flags that are not a string, and patterns that do not
    /// compile, are left to the builtin so its errors are reported verbatim.
    fn matches_memoized(&self, recv: &Value, args: &[Value]) -> Option<oqx::Result<Value>> {
        let flags = match args.get(1) {
            None | Some(Value::Undefined) | Some(Value::Null) => None,
            Some(Value::Str(s)) => Some(s.clone()),
            Some(_) => return None,
        };
        let Some(subject) = string_form(recv) else {
            return Some(Ok(Value::Bool(false)));
        };
        let pattern = args.first().unwrap_or(&Value::Undefined).to_string();
        let key = (pattern, flags);
        let mut memo = self.regexes.borrow_mut();
        if !memo.contains_key(&key) {
            let flags_value = args.get(1).cloned().unwrap_or(Value::Undefined);
            match compile_regex(&key.0, &flags_value, RegexDialect::Oqx) {
                Ok(re) => {
                    memo.insert(key.clone(), re);
                }
                Err(_) => return None,
            }
        }
        Some(Ok(Value::Bool(memo[&key].is_match(&subject))))
    }

    fn semantic_score(&self, t: Target, row: &Value, phrase: &str) -> oqx::Result<Value> {
        if matches!(t, Target::Nodes | Target::Links | Target::Revisions) {
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
        // One slot beyond the columns: every row read here is tagged next
        // ([`tag_row`]), and the tag must not regrow the entries per row.
        let mut o = Object::with_capacity(names.len() + 1);
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
        if let Some(rr) = self.rows_root.as_ref().filter(|_| name == oqx::ROWS_ROOT) {
            let mut slot = rr.rows.borrow_mut();
            let rows = if rr.once { slot.take() } else { slot.clone() };
            return Value::Array(rows.unwrap_or_default());
        }
        // The root scope's names (`spec/oqx` §2 step 5 at the root): the five
        // lazy scans and `id`, the repository id — so `^docs` / `0^docs` from
        // any row is the scan and `^id` / `0^id` the id.
        if name == "id" {
            return Value::Str(self.repo_id.clone());
        }
        // A root scan is handed out LAZILY (see `SCAN_KEY`): `to_rows` runs it
        // — once per run — and `index_for` probes it without running it.
        Target::parse(name).map_or(Value::Undefined, scan_marker)
    }

    /// The root scope's row (oqx 0.18): the repository, so `^$it` from a
    /// top-level row is the root row and `^$it.docs` the docs scan.
    fn root_object(&self) -> Value {
        self.root_row()
    }

    fn get(&self, row: &Value, key: &str) -> oqx::Result<Value> {
        if row.is_absent() {
            return Ok(Value::Undefined);
        }
        // The root row: `^$it.id` is the repository id, `^$it.<target>` the
        // lazy root scan (the same marker `^<target>` / `root(name)` hands out).
        if is_root_object(row) {
            if key == "id" {
                return Ok(Value::Str(self.repo_id.clone()));
            }
            return Ok(Target::parse(key).map_or(Value::Undefined, scan_marker));
        }
        let Some(t) = target_of(row) else {
            // A plain value (parsed attrs, a property bag, a lifted element).
            return Ok(oqx::DefaultContext::read(row, key));
        };
        // A lazy owner (`LAZY_KEY`) answers its identity, relations and
        // properties from the columns it carries; any other key loads the row.
        if let Some(full) = self.resolve_lazy(row, t, key)? {
            return self.get(&full, key);
        }
        // `$self` = the current row: the runner rewrites row functions
        // (text/under/…) to `$self.fn(…)` so they arrive via `call_method` with
        // the row as receiver. Any other `$` name is OQX's (resolved by the
        // engine before the row) or unknown — never an omgbase attribute.
        if key == "$self" {
            return Ok(row.clone());
        }
        // engine attributes win on collision (the name rule above).
        if attributes(t).contains(&key) {
            return self.attribute(row, t, key);
        }
        // self-alias namespaces
        match (t, key) {
            (Target::Docs, "doc") | (Target::Blocks, "block") | (Target::Nodes, "section") => {
                return Ok(row.clone());
            }
            // from a revision to its document's CURRENT row (4.7), before the
            // owning-doc arm the other kinds share.
            (Target::Revisions, "doc") => return self.revision_doc(row),
            (_, "doc") => return self.owning_doc(row),
            (Target::Nodes, "block") => return self.owning_block(row),
            (Target::Links, "dst") => return self.destination_doc(row),
            (Target::Links, "block") => return self.link_block(row),
            _ => {}
        }
        if let Some(v) = self.relation(row, t, key)? {
            return Ok(v);
        }
        // A bare target name that is not one of this row's relations reads a
        // property the row has none of (`spec/surface` §1.1, 2.0): loud, naming
        // the root-row spelling. `docs`/`links` never get here (the runner
        // refuses them statically); `blocks` on a block or edge row, `nodes`
        // on a node or edge row and `revisions` on anything but a document do.
        // The reference throws from `get` too.
        if let Some(named) = Target::parse(key) {
            return Err(OqxError::eval(crate::query::bare_target_message(
                named, None,
            )));
        }
        // the author's data.
        Ok(match t {
            Target::Docs => {
                let doc_id = col_str(row, "doc_id");
                // The source handles: `data` is the merged authored view
                // (frontmatter + inline), the other two one source each;
                // `data.<k>` reaches an authored key whose bare name is an
                // engine attribute (`data.path`, `data.tags`).
                if SOURCE_HANDLES.contains(&key) {
                    let source = (key != "data").then_some(key);
                    return self.doc_prop_bag(&doc_id, source);
                }
                return self.doc_prop(&doc_id, key, None);
            }
            // blocks / nodes: a bare non-structural identifier flattens into
            // `attrs.<k>` (the attributes above win on collision); an absent
            // key is undefined, matching a doc's missing frontmatter key.
            Target::Blocks | Target::Nodes => Self::jattr(row, key),
            // closed row shapes (§1.5): no authored data reaches a link or
            // revision row — an unknown name is absent (the names pass has
            // already refused a tier-3 name statically).
            Target::Links | Target::Revisions => Value::Undefined,
        })
    }

    fn to_rows(&self, value: &Value) -> Vec<Value> {
        match value {
            Value::Undefined | Value::Null => Vec::new(),
            Value::Array(a) => a.clone(),
            other if is_absent_single(other) => Vec::new(),
            other => match scan_of(other) {
                Some(t) => self.expand_scan(t),
                None => vec![other.clone()],
            },
        }
    }

    /// Row position (spec/oqx §3, 0.20): a lazy root scan is a collection; a
    /// store row, a lazy owner, the absent-single marker and any other object
    /// are one row.
    fn is_single(&self, value: &Value) -> bool {
        scan_of(value).is_none()
    }

    /// A lazy root-scan marker observed as a VALUE is its rows (read once per
    /// run); the absent-single marker is absent; everything else is itself. A
    /// store row is an object with several columns and the markers have exactly
    /// one key, so the common case is one length check.
    fn materialize(&self, value: Value) -> Value {
        if value.as_object().is_some_and(|o| o.len() == 1) {
            if let Some(t) = scan_of(&value) {
                return Value::Array(self.expand_scan(t));
            }
            if is_absent_single(&value) {
                return Value::Undefined;
            }
        }
        value
    }

    fn index_for(&self, collection: &Value, path: &[String]) -> Option<Rc<dyn RowIndex + '_>> {
        crate::store_index::index_for(self, scan_of(collection)?, path)
    }

    fn identity(&self, row: &Value) -> Value {
        match target_of(row) {
            Some(Target::Docs) => col(row, "doc_id").clone(),
            Some(Target::Blocks) => col(row, "block_id").clone(),
            Some(Target::Nodes) => col(row, "node_id").clone(),
            Some(Target::Links) => col(row, "edge_id").clone(),
            Some(Target::Revisions) => col(row, "rev_id").clone(),
            None => row.clone(),
        }
    }

    fn call_function(&self, name: &str, args: &[Value]) -> Option<oqx::Result<Value>> {
        // `size(^docs)`, `list(…)`, `has(…)`: the engine has materialized a
        // lazy scan argument into its rows before the call.
        if name == "refs" {
            return Some(self.refs(args.first().unwrap_or(&Value::Undefined)));
        }
        // `date(x)` / `dur(x)` (`spec/surface` §1.3 "Dates and durations",
        // 4.8): pure over their argument except the named points, which read
        // the host clock the runner threaded in. `query.rs` folds a literal
        // argument before planning, so the arm here serves the non-literal ones.
        if let Some(r) = dates::date_function(name, args, self.now_ms) {
            return Some(r);
        }
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
        // `^docs.size()`: the receiver, a value, is materialized by the
        // engine before the call.
        if let Some(t) = target_of(recv) {
            // A row function reads the row's columns: a lazy owner is loaded first.
            let full;
            let recv = if is_lazy_owner(recv) {
                let id_col = if t == Target::Docs {
                    "doc_id"
                } else {
                    "block_id"
                };
                match self.load_owner(t, &col_str(recv, id_col)) {
                    Ok(Some(v)) => {
                        full = v;
                        &full
                    }
                    Ok(None) => recv,
                    Err(e) => return Some(Err(e)),
                }
            } else {
                recv
            };
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
            return Self::filter_invalid(format!("{name}() needs a docs/blocks/nodes/links row"));
        }
        // The date methods (`plus`/`minus`/`until`/the fields/`format` on a
        // date string, `dur_text`/`dur_iso` on a number — §1.3, 4.8; total:
        // any other receiver is absent) sit after the row-scoped domain
        // methods and before the oqx builtins, as in the reference.
        if let Some(r) = dates::date_method(name, recv, args) {
            return Some(r);
        }
        if name == "matches" {
            if let Some(r) = self.matches_memoized(recv, args) {
                return Some(r);
            }
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
        // §1.4 (1.2, keys renamed in 3.0): a tagged store row anywhere in a
        // value tree is `{ id, path }`; untagged records keep their keys,
        // minus the tag.
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
            Some(&Value::Str("/a.md".into()))
        );
        assert_eq!(keys(&tasks[1]), ["id", "path"]);
        assert_eq!(
            tasks[1].as_object().unwrap().get("id"),
            Some(&Value::Str("d_0".into()))
        );
        // An id column that is not a string still renders as its string form.
        let mut edge = Object::new();
        edge.insert("edge_id", Value::Number(7.0));
        let e = render_row_values(tag_row(edge, Target::Links));
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
