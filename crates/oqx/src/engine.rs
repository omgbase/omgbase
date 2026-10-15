//! The tier-1 in-memory engine: evaluates a parsed [`Query`] against a
//! [`DataContext`]. Port of `packages/oqx/src/engine.ts`.
//!
//! Optimizations over a naive walk, as in the reference: `exists` short-circuits
//! at the first match; `first` stops early when the result is unordered;
//! `count` never materializes rows. (`single` always materializes, so its error
//! reports the true row count, and `&&` evaluates strictly left to right —
//! evaluation order is observable through errors, so the engine never reorders
//! conjuncts.)
//!
//! Nested blocks additionally run through the optimizer ([`crate::optimize`]):
//! each block gets a `BlockPlan` — a correlated equality (`id == ^customer_id`)
//! over a statically stable receiver becomes a hash probe, a block that reads
//! nothing from the enclosing rows is evaluated once per run, an
//! `exists`/`count` with nothing left to check per row is answered from a
//! cardinality. Every rule carries a proof that it is unobservable (same rows,
//! lifts and errors); [`InMemoryEngine::with_rules`] with an empty slice runs
//! the naive scan everywhere, which the conformance runner uses to compare both
//! paths over every spec fixture.
//!
//! Name resolution is strictly lexical and LOCAL: a bare identifier is read from
//! the current scope only, and an enclosing scope is reached solely through an
//! explicit `^name` (exactly one scope out per caret). There is no implicit
//! fall-through from an inner scope to an outer one — see the private `Exec::resolve_in`.
//!
//! ## Rows and entries
//!
//! In the reference an `entries()` entry is a `{ key, value }` object carrying a
//! hidden symbol tag, and `enter(row)` unwraps a tagged row so the scope's row is
//! the property's value and `$key` comes from scope metadata. A [`Value`] has no
//! hidden tag, so the engine carries rows as a private `Row` — a value plus an optional
//! entry key — and produces keyed rows only where the reference produces tagged
//! ones: when a source, body-level `from`, directive receiver, or plain `follow`
//! destination is literally `entries(x)`. A data row that merely looks like
//! `{ key, value }` is therefore never unwrapped, and `entries(x)` in value
//! position (projected, or as an argument) is the plain array of `{ key, value }`
//! records the builtin returns.

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::Result;
use crate::ast::{
    AggregateName, BinaryOp, Consumer, CountCmp, Expr, Follow, FollowDestination, GroupBy,
    LogicalOp, OpNode, OrderSpec, Query, SelectItem, Subquery, TemplatePart, UnaryOp, Where,
};
use crate::context::DataContext;
use crate::errors::OqxError;
use crate::optimize::{
    BlockPlan, Correlation, DEFAULT_RULES, HashIndex, RowIndex, Rule, RuleContext,
    intersect_positions, lookup_order, optimize_block, residual_without,
};
use crate::print::print_template;
use crate::semantics::{
    arith, canonical_key, compare, compare_for_sort_dir, entries_of, equals, is_range, make_range,
    membership, relate, string_form, to_number,
};
use crate::value::{Object, Value, js_number_to_string};
use crate::walk::{Node, template_exprs};

/// A query's result, shaped by its consumer. [`OqxResult::into_value`] gives
/// the consumer-shaped plain value the tagged-template API and the spec
/// fixtures observe. A `collect` over a **single** receiver (one object,
/// SEMANTICS §3, since 0.20) is [`OqxResult::Record`]: the one record or
/// `None` rather than a list.
#[derive(Clone, Debug, PartialEq)]
pub enum OqxResult {
    Collect(Vec<Value>),
    Record(Option<Value>),
    Exists(bool),
    None(bool),
    Count(f64),
    First(Option<Value>),
    Single(Option<Value>),
}

impl OqxResult {
    pub fn consumer(&self) -> Consumer {
        match self {
            OqxResult::Collect(_) | OqxResult::Record(_) => Consumer::Collect,
            OqxResult::Exists(_) => Consumer::Exists,
            OqxResult::None(_) => Consumer::None,
            OqxResult::Count(_) => Consumer::Count,
            OqxResult::First(_) => Consumer::First,
            OqxResult::Single(_) => Consumer::Single,
        }
    }

    /// The consumer-shaped result: an array for `collect` over a collection, the
    /// record or `Null` for `collect` over one object, a boolean for
    /// `exists`/`none`, a number for `count`, the row or `Null` for
    /// `first`/`single`.
    pub fn into_value(self) -> Value {
        match self {
            OqxResult::Collect(rows) => Value::Array(rows),
            OqxResult::Record(row) => row.unwrap_or(Value::Null),
            OqxResult::Exists(b) | OqxResult::None(b) => Value::Bool(b),
            OqxResult::Count(n) => Value::Number(n),
            OqxResult::First(row) | OqxResult::Single(row) => row.unwrap_or(Value::Null),
        }
    }
}

/// Anything that can run a query with bindings: the in-memory engine, or a
/// planned engine over a store.
pub trait Engine {
    fn run(&self, query: &Query, bindings: &[Value]) -> Result<OqxResult>;
}

/// The in-memory engine over a [`DataContext`].
pub struct InMemoryEngine<C: DataContext> {
    ctx: C,
    rules: Vec<Rule>,
}

impl<C: DataContext> InMemoryEngine<C> {
    /// An engine applying the default optimizer rules ([`DEFAULT_RULES`]).
    pub fn new(ctx: C) -> Self {
        Self {
            ctx,
            rules: DEFAULT_RULES.to_vec(),
        }
    }

    /// Replace the optimizer rules; an empty slice is the naive engine (every
    /// nested block a plain scan).
    pub fn with_rules(mut self, rules: &[Rule]) -> Self {
        self.rules = rules.to_vec();
        self
    }

    pub fn context(&self) -> &C {
        &self.ctx
    }
}

impl<C: DataContext> Engine for InMemoryEngine<C> {
    fn run(&self, query: &Query, bindings: &[Value]) -> Result<OqxResult> {
        Exec {
            ctx: &self.ctx,
            bindings,
            rules: &self.rules,
            state: RunState::default(),
        }
        .run(query)
    }
}

// ---- internal machinery -----------------------------------------------------

const RECUR: &[&str] = &["$depth", "$stop", "$leaf", "$frontier", "$ordinal"];
const KEY: &str = "$key";
/// `rows` at a group scope: the group's rows (SEMANTICS §24, since 0.24).
const ROWS: &str = "rows";
const HARD_DEPTH_CAP: u32 = 8;

/// A row on its way to becoming a scope: the value, plus the entry key when the
/// row came from `entries(x)` (see the module docs).
#[derive(Clone, Debug)]
struct Row {
    value: Value,
    key: Option<Value>,
}

impl Row {
    fn plain(value: Value) -> Self {
        Row { value, key: None }
    }

    /// The row in VALUE position: a plain row is its value, an entry the
    /// `{ key, value }` record the reference's tagged entry stringifies to.
    fn into_value(self) -> Value {
        match self.key {
            None => self.value,
            Some(k) => {
                let mut o = Object::with_capacity(2);
                o.insert("key", k);
                o.insert("value", self.value);
                Value::Object(o)
            }
        }
    }
}

/// The rows of a value in row position, and whether the value was a single row
/// (one object) rather than a collection — which decides a block's result shape
/// (SEMANTICS §3).
struct Rows {
    rows: Vec<Row>,
    single: bool,
}

impl Rows {
    fn plural(rows: Vec<Row>) -> Self {
        Rows {
            rows,
            single: false,
        }
    }
}

/// A row with the identity the walk knows it by (`$key`).
struct Keyed {
    row: Row,
    key: Value,
}

/// The `$key: expr` item of a projection, if any — the identity the rows it
/// yields carry (SEMANTICS §16, since 0.20).
fn key_item(select: &[SelectItem]) -> Option<&Expr> {
    select.iter().find_map(|it| match it {
        SelectItem::Field {
            name,
            expr,
            lift: 0,
            ..
        } if name == KEY => Some(expr),
        _ => None,
    })
}

/// One query scope: the row under evaluation plus the chain of enclosing scopes
/// that `^` walks. The root scope (`parent == None`) is a row too: its row is
/// the host's root object ([`DataContext::root_object`], since 0.18 — what
/// `$it` is there and `^$it` from a top-level row), while its bare names are
/// the context's named roots. `lifts` holds values bound INTO this scope by
/// `^name:` items in nested blocks (a `RefCell` because the binding happens
/// while the scope is borrowed by the `where` being evaluated); `meta` holds
/// the scope's intrinsics: recursion metadata for a follow occurrence, and
/// `$key` for an entry scope. `entry_key` is the key the row arrived with
/// (an `entries()` row), so the group's `rows` hand back the same row.
/// `group` is set on a GROUP scope (SEMANTICS §24): the scope's row is the key
/// record, `rows` the group's rows, and the aggregates reduce `row_scopes`.
struct Scope<'p> {
    row: Value,
    parent: Option<&'p Scope<'p>>,
    lifts: RefCell<Object>,
    meta: Option<Object>,
    entry_key: Option<Value>,
    group: Option<Group<'p>>,
}

/// One group of a `group by` body: the scopes of its rows (for the aggregates,
/// which read each row as the body's `where` did — lifts and walk intrinsics
/// included) and the rows themselves (what `rows` yields).
struct Group<'p> {
    row_scopes: Vec<Scope<'p>>,
    rows: Vec<Row>,
}

impl<'p> Scope<'p> {
    /// The root scope with `row` as the host's root object.
    fn root(row: Value) -> Self {
        Scope {
            row,
            parent: None,
            lifts: RefCell::new(Object::new()),
            meta: None,
            entry_key: None,
            group: None,
        }
    }

    fn is_root(&self) -> bool {
        self.parent.is_none()
    }
}

/// An evaluated `limit`/`offset` pair. `limit == None` is unbounded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Bound {
    offset: usize,
    limit: Option<usize>,
}

const UNBOUNDED: Bound = Bound {
    offset: 0,
    limit: None,
};

/// What a scope projects to: the select list plus the `values` mode flag. Both
/// `Query` and `Subquery` carry this shape.
#[derive(Clone, Copy)]
struct Projection<'a> {
    select: &'a [SelectItem],
    values: bool,
}

impl<'a> From<&'a Query> for Projection<'a> {
    fn from(q: &'a Query) -> Self {
        Projection {
            select: &q.select,
            values: q.values,
        }
    }
}

impl<'a> From<&'a Subquery> for Projection<'a> {
    fn from(s: &'a Subquery) -> Self {
        Projection {
            select: &s.select,
            values: s.values,
        }
    }
}

/// One reached row of a `follow` walk with its recursion intrinsics.
struct Occurrence {
    row: Row,
    meta: Object,
}

/// One `follow` as the walk reads it: the clause and the body's own seed
/// frontier (0.20; `None` for a destination block's nested walk).
struct FollowWalk<'a> {
    follow: &'a Follow,
    seed_frontier: Option<&'a Expr>,
}

/// A walked occurrence before ranking: the identity (`$key`), the path of
/// identities from the seed to this occurrence (compared component-wise as
/// values by `compare_path`), and the categorical stop reason.
struct Walked {
    row: Row,
    depth: u32,
    path: Vec<Value>,
    key: Value,
    stop: &'static str,
}

/// A successor with the destination (index) that reached it.
struct Successor {
    keyed: Keyed,
    via: usize,
}

/// State that lives for exactly one run: the plans of the blocks met so far,
/// the materialized rows and indexes of statically stable receivers, and the
/// memoized values of invariant blocks — all keyed by the block's address in
/// the query AST, which the run borrows for its whole duration. Nothing here
/// outlives the run, so data that changes between runs is never served stale.
#[derive(Default)]
struct RunState<'e> {
    plans: RefCell<HashMap<usize, Rc<BlockPlan>>>,
    collections: RefCell<HashMap<usize, Rc<CollectionState<'e>>>>,
    memo: RefCell<HashMap<usize, Value>>,
}

/// A stable receiver's collection: its value (evaluated once per run), its
/// rows — materialized the first time something needs them whole, never when
/// a context index answers every probe with rows — the indexes serving each
/// local path (`None` marks a path whose index could not be built — the scan
/// serves it) and what the context answered for each path.
struct CollectionState<'e> {
    value: Value,
    rows: RefCell<Option<Rc<Rows>>>,
    indexes: RefCell<HashMap<String, Option<Rc<dyn RowIndex + 'e>>>>,
    context_indexes: RefCell<HashMap<String, Option<Rc<dyn RowIndex + 'e>>>>,
}

impl<'e> CollectionState<'e> {
    fn new(value: Value) -> Self {
        CollectionState {
            value,
            rows: RefCell::new(None),
            indexes: RefCell::new(HashMap::new()),
            context_indexes: RefCell::new(HashMap::new()),
        }
    }
}

/// Which predicate still applies to a block's accessed rows: the block's whole
/// `where` (a scan), the plan's residual (a probe selected the rows), or a
/// residual built for one probed correlation (a context's `lookup_rows`
/// answered it; the other conjuncts, remaining equalities included, stay in
/// their original order).
enum Predicate {
    Whole,
    Residual,
    Other(Option<Where>),
}

impl Predicate {
    fn resolve<'a>(&'a self, plan: &'a BlockPlan) -> Option<&'a Where> {
        match self {
            Predicate::Whole => plan.node.sub.r#where.as_ref(),
            Predicate::Residual => plan.residual.as_ref(),
            Predicate::Other(w) => w.as_ref(),
        }
    }
}

/// A block's accessed rows, which predicate still applies to each, and whether
/// the receiver was a single object (SEMANTICS §3).
struct Access {
    rows: Vec<Row>,
    predicate: Predicate,
    plan: Rc<BlockPlan>,
    single: bool,
}

impl Access {
    fn predicate(&self) -> Option<&Where> {
        self.predicate.resolve(&self.plan)
    }
}

/// `entries(x)` as a receiver: keyed rows in row position, no value of its own.
fn is_entries_call(e: &Expr) -> bool {
    matches!(e, Expr::Call { recv: None, name, .. } if name == "entries")
}

fn node_key(op: &OpNode) -> usize {
    std::ptr::from_ref(op) as usize
}

/// The row-less scope INSIDE a block under `enclosing`: a bare name is absent
/// (there is no current item yet), `^name` is the enclosing row — where a
/// block's bound and a probe's outer value are read.
fn rowless<'p>(enclosing: &'p Scope<'p>) -> Scope<'p> {
    Scope {
        row: Value::Undefined,
        parent: Some(enclosing),
        lifts: RefCell::new(Object::new()),
        meta: None,
        entry_key: None,
        group: None,
    }
}

/// `rows` as a receiver at a group scope: the group's rows in row position
/// (an entry stays an entry), never the context's property.
fn is_group_rows(e: &Expr, scope: &Scope<'_>) -> bool {
    matches!(e, Expr::Ident { name, .. } if name == ROWS) && scope.group.is_some()
}

/// How many scopes out the root is (the root itself is 0).
fn scope_depth(scope: &Scope<'_>) -> usize {
    let mut d = 0;
    let mut s = scope;
    while let Some(p) = s.parent {
        d += 1;
        s = p;
    }
    d
}

/// One run: the context, the positional bindings, the optimizer rules and the
/// run's state.
struct Exec<'e, C: DataContext> {
    ctx: &'e C,
    bindings: &'e [Value],
    rules: &'e [Rule],
    state: RunState<'e>,
}

impl<'e, C: DataContext> Exec<'e, C> {
    fn run(&self, query: &Query) -> Result<OqxResult> {
        let root = Scope::root(self.ctx.root_object());
        let src = self.coerce_rows_expr(&query.source, &root)?;
        // One object as the source yields one record (SEMANTICS §3) — unless a
        // `from` re-projection or a walk fans it out.
        let single = src.single && query.from.is_empty() && query.follow.is_none();
        let mut rows = src.rows;
        for proj in &query.from {
            rows = self.reproject(rows, proj, &root)?;
        }

        let bound = self.bound_of(query.limit.as_ref(), query.offset.as_ref(), &root)?;
        if let Some(follow) = &query.follow {
            return self.run_follow(query, follow, rows, &root, bound);
        }

        // Consumer-directed short-circuits (skipped under `distinct`, which must
        // materialize + dedup by projection before reducing, and under `group
        // by`, whose consumer counts groups). Counting never materializes rows;
        // exists/none stop as soon as the bound is known to be non-empty (the
        // (offset+1)th match — or the first, when unbounded).
        if !query.distinct
            && query.group_by.is_none()
            && matches!(
                query.consumer,
                Consumer::Exists | Consumer::None | Consumer::Count
            )
        {
            let need = if query.consumer == Consumer::Count {
                usize::MAX
            } else {
                bound.offset.saturating_add(1)
            };
            let mut n = 0usize;
            for r in rows {
                if self.matches(query.r#where.as_ref(), r, &root)? {
                    n += 1;
                    if n >= need {
                        break;
                    }
                }
            }
            let m = bounded_count(n, bound);
            return Ok(match query.consumer {
                Consumer::Count => OqxResult::Count(m as f64),
                Consumer::Exists => OqxResult::Exists(m > 0),
                _ => OqxResult::None(m == 0),
            });
        }

        // first over an unordered, non-distinct set needs only the rows up to
        // the bound (offset + 1). single materializes everything so its error
        // can report how many rows actually matched.
        let cap = if query.consumer == Consumer::First
            && query.order_by.is_none()
            && !query.distinct
            && query.group_by.is_none()
        {
            Some(bound.offset.saturating_add(1.min(bound.limit.unwrap_or(1))))
        } else {
            None
        };
        let mut kept: Vec<Scope<'_>> = Vec::new();
        for r in rows {
            let s = self.enter(r, &root, None);
            if match &query.r#where {
                None => true,
                Some(w) => self.eval_where(w, &s)?,
            } {
                kept.push(s);
                if cap.is_some_and(|c| kept.len() >= c) {
                    break;
                }
            }
        }
        if let Some(g) = &query.group_by {
            kept = self.group_scopes(kept, g, query.having.as_ref(), &root)?;
        }
        let proj = Projection::from(query);
        self.apply_key(&mut kept, proj)?;
        kept = self.sort_scopes(kept, query.order_by.as_deref())?;
        if query.distinct {
            kept = self.dedup_by_projection(kept, proj)?;
        }
        let kept = slice_bound(kept, bound);
        self.shape(query.consumer, &kept, proj, single)
    }

    // Evaluate a block's `limit`/`offset`. The bound is part of the block, so it
    // is read in a row-less scope INSIDE it: a bare name is absent (there is no
    // current item yet), `^name` is the enclosing row — exactly as in the
    // block's body — and literals/bindings are themselves. For a top-level
    // query the scope is the root scope WITHOUT its row (SEMANTICS §18): bare
    // names are still the named roots, but `$it` — reached through a bracket
    // inside the bound — is absent, not the root object. Each must be a
    // non-negative integer.
    fn bound_of(
        &self,
        limit: Option<&Expr>,
        offset: Option<&Expr>,
        enclosing: &Scope<'_>,
    ) -> Result<Bound> {
        if limit.is_none() && offset.is_none() {
            return Ok(UNBOUNDED);
        }
        let inner = if enclosing.is_root() {
            Scope::root(Value::Undefined)
        } else {
            rowless(enclosing)
        };
        let scope: &Scope<'_> = &inner;
        let read = |e: Option<&Expr>, word: &str| -> Result<Option<usize>> {
            let Some(e) = e else { return Ok(None) };
            let v = self.eval_expr(e, scope)?;
            match v {
                Value::Number(n) if n.is_finite() && n.fract() == 0.0 && n >= 0.0 => {
                    Ok(Some(n as usize))
                }
                _ => Err(OqxError::eval(format!(
                    "{word} must be a non-negative integer (got {})",
                    json_string(&v)
                ))),
            }
        };
        Ok(Bound {
            offset: read(offset, "offset")?.unwrap_or(0),
            limit: read(limit, "limit")?,
        })
    }

    // A where match that needs no lift capture (exists/count fast paths).
    fn matches(&self, w: Option<&Where>, row: Row, parent: &Scope<'_>) -> Result<bool> {
        match w {
            None => Ok(true),
            Some(w) => {
                let s = self.enter(row, parent, None);
                self.eval_where(w, &s)
            }
        }
    }

    /// The rows an expression yields in row position (a source, a body-level
    /// `from`, a directive receiver, a `follow` relation), with whether the value
    /// was a single object. `entries(x)` here yields keyed rows — the reference's
    /// tagged entries — see the module docs.
    fn coerce_rows_expr(&self, e: &Expr, scope: &Scope<'_>) -> Result<Rows> {
        // `rows` at a group scope (§24): the group's rows as they arrived.
        if is_group_rows(e, scope) {
            let g = scope.group.as_ref().expect("checked above");
            return Ok(Rows::plural(g.rows.clone()));
        }
        if let Expr::Call {
            recv: None,
            name,
            args,
            ..
        } = e
        {
            if name == "entries" {
                let mut vals = Vec::with_capacity(args.len());
                for a in args {
                    vals.push(self.eval_expr(a, scope)?);
                }
                let target = vals.into_iter().next().unwrap_or(Value::Undefined);
                return Ok(Rows::plural(
                    entries_of(&target)
                        .into_iter()
                        .map(|en| Row {
                            value: en.value,
                            key: Some(en.key),
                        })
                        .collect(),
                ));
            }
        }
        let v = self.eval_raw(e, scope)?;
        self.coerce_rows(&v, Some(e))
    }

    fn rows_of_expr(&self, e: &Expr, scope: &Scope<'_>) -> Result<Vec<Row>> {
        Ok(self.coerce_rows_expr(e, scope)?.rows)
    }

    /// The rows of a value in row position (SEMANTICS §3): absent → none; an
    /// array → its elements, a collection; an object → one row, and the value
    /// is SINGLE — a block over it yields one result rather than a list — unless
    /// the context says the object is a collection (`is_single`); a scalar (a
    /// string, a number, a boolean) or a range → an eval error.
    fn coerce_rows(&self, v: &Value, what: Option<&Expr>) -> Result<Rows> {
        match v {
            Value::Undefined | Value::Null => Ok(Rows::plural(Vec::new())),
            Value::Array(_) => Ok(Rows::plural(
                self.ctx.to_rows(v).into_iter().map(Row::plain).collect(),
            )),
            Value::Object(_) => Ok(Rows {
                rows: self.ctx.to_rows(v).into_iter().map(Row::plain).collect(),
                single: self.ctx.is_single(v),
            }),
            Value::Str(_) | Value::Number(_) | Value::Bool(_) | Value::Range(_) => {
                let kind = match v {
                    Value::Str(_) => "a string",
                    Value::Number(_) => "a number",
                    Value::Bool(_) => "a boolean",
                    _ => "a range",
                };
                let shown = if matches!(v, Value::Range(_)) {
                    String::new()
                } else {
                    format!(" ({})", json_string(v))
                };
                let subject = match what {
                    Some(e) => format!("`{}` is", describe(e)),
                    None => "the receiver is".to_owned(),
                };
                Err(OqxError::eval(format!(
                    "{subject} {kind}{shown}, not a collection or an object — rows come from a collection (a list) or one object (a record)"
                )))
            }
        }
    }

    /// The host's identity of a row (SEMANTICS §16): an entry is known by its
    /// key; any other row by the context's `identity` (structural by default).
    fn host_identity(&self, row: &Row) -> Value {
        match &row.key {
            Some(k) => k.clone(),
            None => self.ctx.identity(&row.value),
        }
    }

    /// The identity a scope's row is known by — `$key`: the identity the walk or
    /// a `$key:` projection gave it (`meta`), else the host's.
    fn scope_identity(&self, scope: &Scope<'_>) -> Value {
        if let Some(k) = scope.meta.as_ref().and_then(|m| m.get(KEY)) {
            return k.clone();
        }
        if scope.is_root() && scope.row.is_absent() {
            return Value::Undefined;
        }
        self.ctx.identity(&scope.row)
    }

    /// A projection's `$key: expr` item gives the rows it yields that identity:
    /// evaluate it on each kept scope and record it as the scope's `$key`.
    fn apply_key(&self, scopes: &mut [Scope<'_>], proj: Projection<'_>) -> Result<()> {
        let Some(expr) = key_item(proj.select) else {
            return Ok(());
        };
        for s in scopes.iter_mut() {
            let key = self.eval_expr(expr, s)?;
            let mut meta = s.meta.take().unwrap_or_default();
            meta.insert(KEY, key);
            s.meta = Some(meta);
        }
        Ok(())
    }

    /// One body-level `from E` step: every row becomes a scope under `parent`
    /// and `E` is read there; the results concatenate (flatMap).
    fn reproject(&self, rows: Vec<Row>, proj: &Expr, parent: &Scope<'_>) -> Result<Vec<Row>> {
        let mut out = Vec::new();
        for r in rows {
            let s = self.enter(r, parent, None);
            out.extend(self.rows_of_expr(proj, &s)?);
        }
        Ok(out)
    }

    // Make the scope for a row. An entry row is unwrapped here: the scope's row
    // is the property's VALUE (so `$it` and bare names read it) and the key
    // becomes the `$key` intrinsic in `meta`. Every place a row becomes a scope
    // goes through this, so entries behave the same at the top level, in nested
    // blocks, as `from` re-projections, and as follow seeds.
    fn enter<'p>(&self, row: Row, parent: &'p Scope<'p>, meta: Option<Object>) -> Scope<'p> {
        let entry_key = row.key.clone();
        let meta = match row.key {
            None => meta,
            Some(k) => {
                let mut m = meta.unwrap_or_default();
                m.insert(KEY, k);
                Some(m)
            }
        };
        Scope {
            row: row.value,
            parent: Some(parent),
            lifts: RefCell::new(Object::new()),
            meta,
            entry_key,
            group: None,
        }
    }

    // ---- grouping (SEMANTICS §24) ---------------------------------------------

    // The kept scopes of a body, one GROUP scope per distinct key tuple, in order
    // of first appearance; then `having` over each group. A group scope sits where
    // the rows did (same parent, same depth): its row is the key record — one
    // property per key, in key order, holding the first row's value — so bare
    // names read the keys, `$it` is the record and `$key` its structural identity;
    // `rows` yields the group's rows and the aggregates reduce their scopes. Key
    // values compare as identities (§16): absent ≡ null, a host row by its id,
    // anything else structurally.
    fn group_scopes<'p>(
        &self,
        scopes: Vec<Scope<'p>>,
        group_by: &GroupBy,
        having: Option<&Where>,
        parent: &'p Scope<'p>,
    ) -> Result<Vec<Scope<'p>>> {
        let mut index: HashMap<String, usize> = HashMap::new();
        let mut groups: Vec<Scope<'p>> = Vec::new();
        for s in scopes {
            let mut record = Object::with_capacity(group_by.keys.len());
            let mut id = String::new();
            for (i, k) in group_by.keys.iter().enumerate() {
                let v = self.eval_expr(&k.expr, &s)?;
                if i > 0 {
                    id.push(' ');
                }
                id.push_str(&canonical_key(&self.ctx.identity(&v)));
                record.insert(k.name.as_str(), v);
            }
            let at = match index.get(&id) {
                Some(&at) => at,
                None => {
                    index.insert(id, groups.len());
                    groups.push(Scope {
                        row: Value::Object(record),
                        parent: Some(parent),
                        lifts: RefCell::new(Object::new()),
                        meta: None,
                        entry_key: None,
                        group: Some(Group {
                            row_scopes: Vec::new(),
                            rows: Vec::new(),
                        }),
                    });
                    groups.len() - 1
                }
            };
            let g = groups[at].group.as_mut().expect("a group scope");
            g.rows.push(Row {
                value: s.row.clone(),
                key: s.entry_key.clone(),
            });
            g.row_scopes.push(s);
        }
        let Some(having) = having else {
            return Ok(groups);
        };
        let mut kept = Vec::with_capacity(groups.len());
        for g in groups {
            if self.eval_where(having, &g)? {
                kept.push(g);
            }
        }
        Ok(kept)
    }

    // An aggregate (§24) over the group of the scope it is read in. The argument
    // is read on each row's scope in group order; every value aggregate sees the
    // PRESENT values only (`count()` alone counts rows), `distinct` dedups them by
    // identity (§16), and `any`/`all` test truthiness (absent is false) and stop
    // at the first row that decides, like `||` / `&&`.
    fn aggregate(
        &self,
        e: &Expr,
        name: AggregateName,
        arg: Option<&Expr>,
        distinct: bool,
        scope: &Scope<'_>,
    ) -> Result<Value> {
        let Some(g) = &scope.group else {
            return Err(OqxError::eval(format!(
                "`{}` is an aggregate and is read on a group — it needs a `group by` in its body",
                describe(e)
            )));
        };
        let Some(arg) = arg else {
            return Ok(Value::Number(g.row_scopes.len() as f64));
        };
        match name {
            AggregateName::Any => {
                for s in &g.row_scopes {
                    if self.eval_expr(arg, s)?.truthy() {
                        return Ok(Value::Bool(true));
                    }
                }
                return Ok(Value::Bool(false));
            }
            AggregateName::All => {
                for s in &g.row_scopes {
                    if !self.eval_expr(arg, s)?.truthy() {
                        return Ok(Value::Bool(false));
                    }
                }
                return Ok(Value::Bool(true));
            }
            _ => {}
        }
        let mut values: Vec<Value> = Vec::with_capacity(g.row_scopes.len());
        for s in &g.row_scopes {
            let v = self.eval_expr(arg, s)?;
            if !v.is_absent() {
                values.push(v);
            }
        }
        if distinct {
            let mut seen: HashSet<String> = HashSet::new();
            values.retain(|v| seen.insert(canonical_key(&self.ctx.identity(v))));
        }
        Ok(match name {
            AggregateName::Count => Value::Number(values.len() as f64),
            AggregateName::Collect => Value::Array(values),
            AggregateName::First => values.into_iter().next().unwrap_or(Value::Undefined),
            AggregateName::Last => values.pop().unwrap_or(Value::Undefined),
            AggregateName::Sum | AggregateName::Avg => {
                let mut total = 0.0;
                for v in &values {
                    let Value::Number(n) = v else {
                        return Err(OqxError::eval(format!(
                            "cannot {} `{}` over the group: it is {} — `{}` takes numbers",
                            if name == AggregateName::Sum {
                                "sum"
                            } else {
                                "average"
                            },
                            describe(arg),
                            describe_value_kind(v),
                            name.as_str()
                        )));
                    };
                    total += n;
                }
                if name == AggregateName::Sum {
                    Value::Number(total)
                } else if values.is_empty() {
                    Value::Undefined
                } else {
                    Value::Number(total / values.len() as f64)
                }
            }
            AggregateName::Min | AggregateName::Max => {
                let mut iter = values.into_iter();
                let Some(mut best) = iter.next() else {
                    return Ok(Value::Undefined);
                };
                let want = if name == AggregateName::Min {
                    Ordering::Less
                } else {
                    Ordering::Greater
                };
                for v in iter {
                    if compare(&v, &best) == Some(want) {
                        best = v;
                    }
                }
                best
            }
            AggregateName::Any | AggregateName::All => unreachable!("handled above"),
        })
    }

    // ---- follow -------------------------------------------------------------

    fn run_follow(
        &self,
        query: &Query,
        follow: &Follow,
        rows: Vec<Row>,
        root: &Scope<'_>,
        bound: Bound,
    ) -> Result<OqxResult> {
        let (seed, post) = match &query.r#where {
            Some(w) => partition_recur(w),
            None => (Vec::new(), Vec::new()),
        };
        let mut seeds = Vec::new();
        for r in rows {
            if seed.is_empty() || self.eval_conjuncts(&seed, &self.enter(r.clone(), root, None))? {
                seeds.push(r);
            }
        }
        let proj = Projection::from(query);
        let occ = self.follow_walk(
            self.keyed(seeds, proj, root)?,
            follow,
            query.frontier.as_ref(),
            root,
        )?;
        let mut scopes: Vec<Scope<'_>> = Vec::with_capacity(occ.len());
        for o in occ {
            let s = self.enter(o.row, root, Some(o.meta));
            if post.is_empty() || self.eval_conjuncts(&post, &s)? {
                scopes.push(s);
            }
        }
        if let Some(g) = &query.group_by {
            scopes = self.group_scopes(scopes, g, query.having.as_ref(), root)?;
        }
        scopes = self.sort_scopes(scopes, query.order_by.as_deref())?;
        if query.distinct {
            scopes = self.dedup_by_projection(scopes, proj)?;
        }
        let scopes = slice_bound(scopes, bound);
        self.shape(query.consumer, &scopes, proj, false)
    }

    /// The seeds of a walk with their identities: the body's `$key: expr` item,
    /// read in each seed's scope, else the host's identity (SEMANTICS §20).
    fn keyed(
        &self,
        rows: Vec<Row>,
        proj: Projection<'_>,
        parent: &Scope<'_>,
    ) -> Result<Vec<Keyed>> {
        let item = key_item(proj.select);
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let key = match item {
                Some(e) => self.eval_expr(e, &self.enter(row.clone(), parent, None))?,
                None => self.host_identity(&row),
            };
            out.push(Keyed { row, key });
        }
        Ok(out)
    }

    // Dedup scopes by their PROJECTED value (`distinct`): keep the first scope
    // per distinct projection, preserving order. An empty projection dedups by
    // row identity (`$key`, so `count distinct { }` counts distinct rows). Keys
    // compare with the scalar layer's structural `equals` (absent ≡ null, key
    // order ignored), which is what the reference's stable stringify achieves.
    fn dedup_by_projection<'p>(
        &self,
        scopes: Vec<Scope<'p>>,
        proj: Projection<'_>,
    ) -> Result<Vec<Scope<'p>>> {
        let mut seen: Vec<Value> = Vec::new();
        let mut out = Vec::new();
        for s in scopes {
            let key = if proj.select.is_empty() {
                self.scope_identity(&s)
            } else {
                self.project_row(proj, &s)?
            };
            if seen.iter().any(|k| equals(k, &key)) {
                continue;
            }
            seen.push(key);
            out.push(s);
        }
        Ok(out)
    }

    // A bounded, per-path recursive walk. Each occurrence carries recursion
    // metadata: `$depth` (seed = 1), a categorical `$stop`, a deterministic
    // `$ordinal`, and `$key`, the identity it is known by. Semantics (SEMANTICS §20):
    //   • per-path — a node reached by N distinct paths yields N occurrences
    //     (unless `distinct`, which keeps the minimal (depth, path) per identity);
    //   • cycles are safe — revisiting an identity already on the current path
    //     admits ONE occurrence with `$stop == "cycle"` and does not expand it;
    //   • `$stop` ∈ interior | leaf | frontier | depth | cycle, with precedence
    //     cycle > frontier > depth > leaf > interior; only `interior` rows expand;
    //   • `$leaf` = (stop == leaf); `$frontier` = (stop ∈ {frontier, depth});
    //   • identity is `$key` (since 0.20): a seed's is the body's `$key:` item or
    //     the host's identity; a successor's is its destination block's `$key:`
    //     item, else the host's identity of the yielded row — compared
    //     structurally; `$ordinal` paths compare component-wise (`compare_path`);
    //   • a destination block's `depth n` makes it decline to expand a frontier
    //     row whose `$depth >= n`; a row with no successors some destination
    //     declined is `depth`, with none declined `leaf`; the hard cap 8 is every
    //     destination's ceiling;
    //   • a destination block's `frontier P` marks the occurrences IT reached for
    //     which `P` holds (seeds are reached by none); `P` reads the occurrence's
    //     own scope with `^` the walk's enclosing scope, as the body does;
    //   • the body's own `frontier P` (`seed_frontier`, 0.20) marks the SEEDS for
    //     which `P` holds, read in the seed's scope exactly like the body's `where`.
    fn follow_walk(
        &self,
        seeds: Vec<Keyed>,
        follow: &Follow,
        seed_frontier: Option<&Expr>,
        parent: &Scope<'_>,
    ) -> Result<Vec<Occurrence>> {
        let mut walked: Vec<Walked> = Vec::new();
        let mut ancestors: Vec<Value> = Vec::new();
        let walk = FollowWalk {
            follow,
            seed_frontier,
        };
        for k in seeds {
            self.follow_visit(&walk, parent, k, None, 1, &mut ancestors, &mut walked)?;
        }

        let mut rows = walked;
        if follow.distinct {
            // keep the minimal (depth, path) occurrence per identity key.
            let mut best: Vec<Walked> = Vec::new();
            for w in rows {
                match best.iter_mut().find(|b| equals(&b.key, &w.key)) {
                    None => best.push(w),
                    Some(prev) => {
                        if w.depth < prev.depth
                            || (w.depth == prev.depth
                                && compare_path(&w.path, &prev.path) == Ordering::Less)
                        {
                            *prev = w;
                        }
                    }
                }
            }
            rows = best;
        }
        // $ordinal: a deterministic 1..N rank over (depth, path).
        rows.sort_by(|a, b| {
            a.depth
                .cmp(&b.depth)
                .then_with(|| compare_path(&a.path, &b.path))
        });
        Ok(rows
            .into_iter()
            .enumerate()
            .map(|(i, w)| {
                let mut meta = Object::with_capacity(6);
                meta.insert(KEY, w.key);
                meta.insert("$depth", Value::Number(f64::from(w.depth)));
                meta.insert("$stop", Value::Str(w.stop.to_owned()));
                meta.insert("$leaf", Value::Bool(w.stop == "leaf"));
                meta.insert(
                    "$frontier",
                    Value::Bool(w.stop == "frontier" || w.stop == "depth"),
                );
                meta.insert("$ordinal", Value::Number((i + 1) as f64));
                Occurrence { row: w.row, meta }
            })
            .collect())
    }

    /// The scope of a walked row under the walk's enclosing scope, carrying its
    /// `$key` (the frontier row's scope for a destination block, the occurrence's
    /// for `frontier`).
    fn keyed_scope<'p>(&self, k: &Keyed, parent: &'p Scope<'p>) -> Scope<'p> {
        let mut meta = Object::with_capacity(1);
        meta.insert(KEY, k.key.clone());
        self.enter(k.row.clone(), parent, Some(meta))
    }

    // `ancestors` is the identity path of the current branch (the identities
    // from the seed down to the parent of `row`); each occurrence's path is
    // that plus its own identity. `via` is the destination that reached the row
    // (`None` for a seed).
    #[allow(clippy::too_many_arguments)]
    fn follow_visit(
        &self,
        walk: &FollowWalk<'_>,
        parent: &Scope<'_>,
        k: Keyed,
        via: Option<usize>,
        depth: u32,
        ancestors: &mut Vec<Value>,
        walked: &mut Vec<Walked>,
    ) -> Result<()> {
        let mut path = Vec::with_capacity(ancestors.len() + 1);
        path.extend(ancestors.iter().cloned());
        path.push(k.key.clone());
        let stop: &'static str;
        if ancestors.iter().any(|a| equals(a, &k.key)) {
            stop = "cycle";
        } else if self.frontier_hit(walk, &k, via, parent)? {
            stop = "frontier";
        } else if depth >= HARD_DEPTH_CAP {
            stop = "depth";
        } else {
            let (succ, declined) = self.successors_of(walk.follow, &k, depth, parent)?;
            if succ.is_empty() {
                stop = if declined { "depth" } else { "leaf" };
            } else {
                let key = k.key.clone();
                walked.push(Walked {
                    row: k.row,
                    depth,
                    path,
                    key: key.clone(),
                    stop: "interior",
                });
                ancestors.push(key);
                for s in succ {
                    self.follow_visit(
                        walk,
                        parent,
                        s.keyed,
                        Some(s.via),
                        depth + 1,
                        ancestors,
                        walked,
                    )?;
                }
                ancestors.pop();
                return Ok(());
            }
        }
        walked.push(Walked {
            row: k.row,
            depth,
            path,
            key: k.key,
            stop,
        });
        Ok(())
    }

    /// Whether `k` is a frontier: for a seed (reached by no destination) the
    /// body's own `frontier P` (0.20), read in the seed's scope like `where`;
    /// for an occurrence the destination that reached it marks it through its
    /// block's `frontier P`, read in the occurrence's scope under the walk's
    /// enclosing scope.
    fn frontier_hit(
        &self,
        walk: &FollowWalk<'_>,
        k: &Keyed,
        via: Option<usize>,
        parent: &Scope<'_>,
    ) -> Result<bool> {
        let f = match via {
            None => walk.seed_frontier,
            Some(via) => match &walk.follow.destinations[via] {
                FollowDestination::Block(op) => op.sub.frontier.as_ref(),
                FollowDestination::Relation(_) => None,
            },
        };
        let Some(f) = f else {
            return Ok(false);
        };
        Ok(self.eval_expr(f, &self.keyed_scope(k, parent))?.truthy())
    }

    // A row's successors, each with its identity and the destination that
    // reached it, and whether some destination declined by its depth cap. Per
    // destination in source order, the destination's rows are read in the
    // frontier row's own scope — a plain relation like a body-level `from`,
    // keyed by the host's identity; a destination block as the select-position
    // directive it is (its receiver `^people` resolves one scope out of the
    // frontier row and inside the block `^` IS the frontier row), its rows
    // shaped by its items other than `$key` and keyed by its `$key:` item —
    // then unioned by identity within the step: an identity that recurs is
    // kept once, at its first position.
    fn successors_of(
        &self,
        follow: &Follow,
        k: &Keyed,
        depth: u32,
        parent: &Scope<'_>,
    ) -> Result<(Vec<Successor>, bool)> {
        let frontier = self.keyed_scope(k, parent);
        let mut raw: Vec<Successor> = Vec::new();
        let mut declined = false;
        for (via, dest) in follow.destinations.iter().enumerate() {
            match dest {
                FollowDestination::Relation(e) => {
                    for row in self.rows_of_expr(e, &frontier)? {
                        let key = self.host_identity(&row);
                        raw.push(Successor {
                            keyed: Keyed { row, key },
                            via,
                        });
                    }
                }
                FollowDestination::Block(op) => {
                    if op.sub.depth.is_some_and(|cap| depth >= cap) {
                        declined = true;
                        continue;
                    }
                    for keyed in self.destination_rows(op, &frontier)? {
                        raw.push(Successor { keyed, via });
                    }
                }
            }
        }
        let mut out: Vec<Successor> = Vec::with_capacity(raw.len());
        for x in raw {
            if out.iter().any(|o| equals(&o.keyed.key, &x.keyed.key)) {
                continue;
            }
            out.push(x);
        }
        Ok((out, declined))
    }

    // A destination block's successors for one frontier row, each with its
    // identity: the block's rows (its `where`, order, `distinct`, bound and
    // consumer applied — `first`/`single` yield at most one), shaped by its items
    // other than `$key` (the raw rows when none remain), keyed by its `$key:`
    // item read in the row's scope, else by the host's identity of the row yielded.
    fn destination_rows(&self, dest: &OpNode, frontier: &Scope<'_>) -> Result<Vec<Keyed>> {
        let plan = self.plan_of(dest, frontier);
        let (scopes, _) = self.eval_collect_scopes(dest, &plan, frontier, true)?;
        let key = key_item(&dest.sub.select);
        let shaped: Vec<SelectItem>;
        let proj = match key {
            None => Projection::from(&dest.sub),
            Some(_) => {
                shaped = dest
                    .sub
                    .select
                    .iter()
                    .filter(
                        |it| !matches!(it, SelectItem::Field { name, lift: 0, .. } if name == KEY),
                    )
                    .cloned()
                    .collect();
                Projection {
                    select: &shaped,
                    values: dest.sub.values,
                }
            }
        };
        let mut out = Vec::with_capacity(scopes.len());
        for s in &scopes {
            let value = self.project_row(proj, s)?;
            let row = Row::plain(value);
            let id = match key {
                Some(e) => self.eval_expr(e, s)?,
                None if proj.select.is_empty() => self.scope_identity(s),
                None => self.host_identity(&row),
            };
            out.push(Keyed { row, key: id });
        }
        Ok(out)
    }

    // ---- consumer shaping ---------------------------------------------------

    // `single` — the receiver was one object: a `collect` yields its one record
    // (or nothing) rather than a one-element list (SEMANTICS §3, §15).
    fn shape(
        &self,
        consumer: Consumer,
        scopes: &[Scope<'_>],
        proj: Projection<'_>,
        single: bool,
    ) -> Result<OqxResult> {
        Ok(match consumer {
            Consumer::Exists => OqxResult::Exists(!scopes.is_empty()),
            Consumer::None => OqxResult::None(scopes.is_empty()),
            Consumer::Count => OqxResult::Count(scopes.len() as f64),
            Consumer::Collect if single => OqxResult::Record(match scopes.first() {
                Some(s) => Some(self.project_row(proj, s)?),
                None => None,
            }),
            Consumer::Collect => OqxResult::Collect(self.project_all(proj, scopes)?),
            Consumer::First => OqxResult::First(match scopes.first() {
                Some(s) => Some(self.project_row(proj, s)?),
                None => None,
            }),
            Consumer::Single => {
                if scopes.len() > 1 {
                    return Err(OqxError::eval(format!(
                        "single {{ … }} matched {} rows; use first {{ … }} for zero-or-one",
                        scopes.len()
                    )));
                }
                OqxResult::Single(match scopes.first() {
                    Some(s) => Some(self.project_row(proj, s)?),
                    None => None,
                })
            }
        })
    }

    fn project_all(&self, proj: Projection<'_>, scopes: &[Scope<'_>]) -> Result<Vec<Value>> {
        scopes.iter().map(|s| self.project_row(proj, s)).collect()
    }

    // The per-row result: the raw row (empty projection), the single item's
    // value itself (`values` mode), or a `{ name: value }` record. A range is
    // an evaluation-time value only and never appears in a result.
    fn project_row(&self, proj: Projection<'_>, scope: &Scope<'_>) -> Result<Value> {
        let select = proj.select;
        if select.is_empty() {
            return no_range(scope.row.clone());
        }
        if proj.values {
            return no_range(self.item_value(&select[0], scope)?);
        }
        let mut out = Object::with_capacity(select.len());
        for item in select {
            out.insert(item.name(), no_range(self.item_value(item, scope)?)?);
        }
        Ok(Value::Object(out))
    }

    fn item_value(&self, item: &SelectItem, scope: &Scope<'_>) -> Result<Value> {
        match item {
            SelectItem::Field { expr, .. } => self.eval_expr(expr, scope),
            SelectItem::Collect { op, .. } => self.eval_collect_value(op, scope),
        }
    }

    // ---- where evaluation ---------------------------------------------------

    fn eval_where(&self, w: &Where, scope: &Scope<'_>) -> Result<bool> {
        match w {
            Where::And { parts, .. } => {
                let refs: Vec<&Where> = parts.iter().collect();
                self.eval_conjuncts(&refs, scope)
            }
            Where::Or { parts, .. } => {
                for p in parts {
                    if self.eval_where(p, scope)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Where::Not { expr, .. } => Ok(!self.eval_where(expr, scope)?),
            Where::Scalar { expr, .. } => Ok(self.eval_expr(expr, scope)?.truthy()),
            Where::Op(op) => self.eval_where_op(op, scope),
        }
    }

    /// An `&&` over `parts`: strictly left to right, short-circuiting at the
    /// first false conjunct. The engine never reorders conjuncts (not even to
    /// run a cheap scalar before a consumer test) because evaluation order is
    /// observable through errors: `false && foo()` is false, `true && foo()`
    /// raises. Empty is true.
    fn eval_conjuncts(&self, parts: &[&Where], scope: &Scope<'_>) -> Result<bool> {
        for p in parts {
            if !self.eval_where(p, scope)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn eval_where_op(&self, op: &OpNode, scope: &Scope<'_>) -> Result<bool> {
        if op.sub.follow.is_some() {
            return Err(OqxError::eval(
                "`follow` is only valid on a select-position collect { … }, not a where op",
            ));
        }
        let plan = self.plan_of(op, scope);
        if !plan.invariant {
            return self.eval_where_op_planned(op, &plan, scope);
        }
        let v = self.memoized(op, || {
            self.eval_where_op_planned(op, &plan, scope)
                .map(Value::Bool)
        })?;
        Ok(v.truthy())
    }

    fn eval_where_op_planned(
        &self,
        op: &OpNode,
        plan: &Rc<BlockPlan>,
        scope: &Scope<'_>,
    ) -> Result<bool> {
        let bound = self.bound_of(op.sub.limit.as_ref(), op.sub.offset.as_ref(), scope)?;
        match op.op {
            Consumer::Exists | Consumer::None | Consumer::Count => {
                let acc = self.access(op, plan, scope)?;
                let n = if plan.from_cardinality && acc.predicate().is_none() {
                    // Nothing left to evaluate per row: the accessed rows ARE
                    // the matched rows, and the consumer only needs their count
                    // after the bound.
                    bounded_count(acc.rows.len(), bound)
                } else if op.op != Consumer::Count
                    && bound == UNBOUNDED
                    && op.sub.group_by.is_none()
                {
                    // Unbounded exists/none: stop at the first match (dedup
                    // cannot change emptiness). Bounded, or grouped (`having`
                    // may empty the groups): the offset/limit decide emptiness,
                    // so materialize the set.
                    usize::from(!self.match_rows(op, scope, Some(1), Some(acc))?.is_empty())
                } else {
                    self.op_rows(op, scope, bound, Some(acc))?.len()
                };
                Ok(match op.op {
                    Consumer::Count => match &op.count_cmp {
                        Some(cmp) => compare_count(n, cmp)?,
                        None => n > 0,
                    },
                    Consumer::Exists => n > 0,
                    _ => n == 0,
                })
            }
            Consumer::Collect => {
                let matched = self.op_rows(op, scope, bound, None)?;
                for item in &op.sub.select {
                    let SelectItem::Field {
                        name, expr, lift, ..
                    } = item
                    else {
                        continue;
                    };
                    // Bind `lift` scopes out: `^` = the collect's own scope, `^^`
                    // its parent, etc. Values flatten-append into the target
                    // scope, so repeated evaluations (a deeper lift fanning out
                    // through intermediate scopes) accumulate into one flat list
                    // rather than overwriting.
                    let mut target: &Scope<'_> = scope;
                    let mut i = 1;
                    while i < *lift {
                        match target.parent {
                            Some(p) => target = p,
                            None => break,
                        }
                        i += 1;
                    }
                    let mut vals: Vec<Value> = Vec::with_capacity(matched.len());
                    for s in &matched {
                        vals.push(self.eval_expr(expr, s)?);
                    }
                    let mut lifts = target.lifts.borrow_mut();
                    let mut prior = match lifts.get(name) {
                        Some(Value::Array(xs)) => xs.clone(),
                        _ => Vec::new(),
                    };
                    prior.extend(vals);
                    lifts.insert(name.as_str(), Value::Array(prior));
                }
                Ok(!matched.is_empty())
            }
            Consumer::First | Consumer::Single => {
                Ok(!self.op_rows(op, scope, bound, None)?.is_empty())
            }
        }
    }
    // The rows a consumer op reduces: matched → grouped → ordered → distinct → bounded.
    fn op_rows<'p>(
        &self,
        op: &OpNode,
        scope: &'p Scope<'p>,
        bound: Bound,
        acc: Option<Access>,
    ) -> Result<Vec<Scope<'p>>> {
        let mut scopes = self.match_rows(op, scope, None, acc)?;
        if let Some(g) = &op.sub.group_by {
            scopes = self.group_scopes(scopes, g, op.sub.having.as_ref(), scope)?;
        }
        self.apply_key(&mut scopes, Projection::from(&op.sub))?;
        scopes = self.sort_scopes(scopes, op.sub.order_by.as_deref())?;
        if op.distinct {
            scopes = self.dedup_by_projection(scopes, Projection::from(&op.sub))?;
        }
        Ok(slice_bound(scopes, bound))
    }

    /// The block's candidate rows (per its plan's access path), entered as
    /// scopes under `scope`, filtered by the predicate the access left to
    /// evaluate. `stop_after` caps how many matches are collected (the `exists`
    /// short-circuit — over a probe's bucket it stops at the first bucket row
    /// that passes the residual, so the semi/anti-join never materializes it).
    fn match_rows<'p>(
        &self,
        op: &OpNode,
        scope: &'p Scope<'p>,
        stop_after: Option<usize>,
        acc: Option<Access>,
    ) -> Result<Vec<Scope<'p>>> {
        let mut acc = match acc {
            Some(a) => a,
            None => self.access(op, &self.plan_of(op, scope), scope)?,
        };
        let rows = std::mem::take(&mut acc.rows);
        let mut out = Vec::new();
        for r in rows {
            let s = self.enter(r, scope, None);
            let keep = match acc.predicate() {
                None => true,
                Some(w) => self.eval_where(w, &s)?,
            };
            if keep {
                out.push(s);
                if stop_after.is_some_and(|n| out.len() >= n) {
                    break;
                }
            }
        }
        Ok(out)
    }

    // ---- planned access -----------------------------------------------------

    fn plan_of(&self, op: &OpNode, scope: &Scope<'_>) -> Rc<BlockPlan> {
        let key = node_key(op);
        if let Some(p) = self.state.plans.borrow().get(&key) {
            return Rc::clone(p);
        }
        let ctx = RuleContext {
            binding_count: self.bindings.len(),
        };
        let plan = Rc::new(optimize_block(op, scope_depth(scope), &ctx, self.rules));
        self.state.plans.borrow_mut().insert(key, Rc::clone(&plan));
        plan
    }

    // An invariant block (rule 2) is evaluated the first time it is reached and
    // its value reused for every other enclosing row.
    fn memoized(&self, op: &OpNode, compute: impl FnOnce() -> Result<Value>) -> Result<Value> {
        let key = node_key(op);
        if let Some(v) = self.state.memo.borrow().get(&key) {
            return Ok(v.clone());
        }
        let value = compute()?;
        self.state.memo.borrow_mut().insert(key, value.clone());
        Ok(value)
    }

    // A block's rows and the predicate left to evaluate over each — the one
    // path every consumer takes (where-position exists/none/count/collect,
    // select-position collect/first/single, the `follow` seeds). A correlated
    // plan is served, in order of preference, by a context index that yields
    // rows (`lookup_rows` — asked on every sight: it costs nothing and the
    // collection is never read), by a probe on the engine's own index (built
    // once for a statically stable receiver), else by the scan. A statically
    // stable receiver (rule 1b) is evaluated once per run and its rows read
    // once; a `Value` has no identity, so the engine never indexes any other
    // receiver — but when something is correlated it still offers the receiver
    // to the context's `index_for` (a store handle handed out fresh per row is
    // probed, never read). Whatever the plan asked for that cannot be served at
    // run time (no index, an outer value whose read failed) degrades to the
    // plain scan the plan started from. The receiver is read in row position
    // (`eval_raw`), so a context's lazy handle reaches `to_rows` and `index_for`
    // as it was handed out.
    fn access(&self, op: &OpNode, plan: &Rc<BlockPlan>, scope: &Scope<'_>) -> Result<Access> {
        let state = if plan.receiver_stable {
            Some(self.collection_of(op, scope)?)
        } else if !plan.correlated.is_empty()
            && !is_entries_call(&op.receiver)
            && !is_group_rows(&op.receiver, scope)
        {
            Some(Rc::new(CollectionState::new(
                self.eval_raw(&op.receiver, scope)?,
            )))
        } else {
            None
        };
        let Some(state) = state else {
            return self.scan(self.coerce_rows_expr(&op.receiver, scope)?, op, plan, scope);
        };
        if !plan.correlated.is_empty() {
            if let Some(acc) = self.lookup_rows(plan, &state, scope)? {
                return Ok(acc);
            }
            if plan.receiver_stable {
                let rows = self.materialize(&state, op, scope)?;
                if let Some(rows) = self.probe(plan, &state, &rows.rows, scope) {
                    return Ok(Access {
                        rows,
                        predicate: Predicate::Residual,
                        plan: Rc::clone(plan),
                        single: false,
                    });
                }
            }
        }
        let rows = self.materialize(&state, op, scope)?;
        let src = Rows {
            rows: rows.rows.clone(),
            single: rows.single,
        };
        self.scan(src, op, plan, scope)
    }

    /// The plain scan: the rows, re-projected by `from`, with the whole `where`.
    /// A `from` re-projection fans a single receiver out: the block is plural.
    fn scan(
        &self,
        src: Rows,
        op: &OpNode,
        plan: &Rc<BlockPlan>,
        scope: &Scope<'_>,
    ) -> Result<Access> {
        let mut rows = src.rows;
        for proj in &op.sub.from {
            rows = self.reproject(rows, proj, scope)?;
        }
        Ok(Access {
            rows,
            predicate: Predicate::Whole,
            plan: Rc::clone(plan),
            single: src.single && op.sub.from.is_empty(),
        })
    }

    /// A stable receiver's collection, evaluated the first time the block is
    /// reached in this run; its rows are not read until something needs them.
    /// An `entries(x)` receiver has no value of its own (it yields keyed rows
    /// in row position only): its rows are read through `rows_of_expr` and the
    /// collection is never offered to the context.
    fn collection_of(&self, op: &OpNode, scope: &Scope<'_>) -> Result<Rc<CollectionState<'e>>> {
        let key = node_key(op);
        if let Some(c) = self.state.collections.borrow().get(&key) {
            return Ok(Rc::clone(c));
        }
        let value = if is_entries_call(&op.receiver) {
            Value::Undefined
        } else {
            self.eval_raw(&op.receiver, scope)?
        };
        let state = Rc::new(CollectionState::new(value));
        self.state
            .collections
            .borrow_mut()
            .insert(key, Rc::clone(&state));
        Ok(state)
    }

    /// The materialized rows of a collection (read once per state) — the
    /// receiver in row position, exactly as the scan reads it.
    fn materialize(
        &self,
        state: &CollectionState<'e>,
        op: &OpNode,
        scope: &Scope<'_>,
    ) -> Result<Rc<Rows>> {
        if let Some(rows) = state.rows.borrow().as_ref() {
            return Ok(Rc::clone(rows));
        }
        let rows = Rc::new(if is_entries_call(&op.receiver) {
            self.coerce_rows_expr(&op.receiver, scope)?
        } else {
            self.coerce_rows(&state.value, Some(&op.receiver))?
        });
        *state.rows.borrow_mut() = Some(Rc::clone(&rows));
        Ok(rows)
    }

    // A probe answered by a context index that yields rows directly, before the
    // collection is materialized: one correlation is probed (`lookup_order`) and
    // every other conjunct stays in place per selected row (`residual_without`).
    fn lookup_rows(
        &self,
        plan: &Rc<BlockPlan>,
        state: &CollectionState<'e>,
        scope: &Scope<'_>,
    ) -> Result<Option<Access>> {
        for c in lookup_order(plan) {
            let Some(index) = self.context_index(state, c) else {
                continue;
            };
            let Some(value) = self.outer_value(c, scope) else {
                return Ok(None);
            };
            // A positional-only index answers `None`: the next candidate, else
            // the positional probe over the materialized rows.
            if let Some(rows) = index.lookup_rows(&value) {
                let rows = rows?.into_iter().map(Row::plain).collect();
                return Ok(Some(Access {
                    rows,
                    predicate: Predicate::Other(residual_without(plan, c)),
                    plan: Rc::clone(plan),
                    single: false,
                }));
            }
        }
        Ok(None)
    }

    // The engine's probe: one bucket per correlation, intersected smallest-first;
    // the candidates come back in receiver order. `None` (an index that could
    // not be built, an outer value whose read failed) leaves the scan in charge.
    fn probe(
        &self,
        plan: &BlockPlan,
        state: &CollectionState<'e>,
        rows: &[Row],
        scope: &Scope<'_>,
    ) -> Option<Vec<Row>> {
        let mut buckets: Vec<Vec<usize>> = Vec::with_capacity(plan.correlated.len());
        for c in &plan.correlated {
            let index = self.index_for(state, rows, c, scope)?;
            let value = self.outer_value(c, scope)?;
            buckets.push(index.lookup(&value));
        }
        buckets.sort_by_key(Vec::len);
        let mut candidates = buckets.remove(0);
        for bucket in &buckets {
            if candidates.is_empty() {
                break;
            }
            candidates = intersect_positions(&candidates, bucket);
        }
        Some(candidates.into_iter().map(|i| rows[i].clone()).collect())
    }

    // A correlation's outer side, read once in a row-less scope inside the
    // block (as a bound is). The outer side is raise-free by the rule, so a
    // failure is a context refusing a read: `None`, and the scan then raises
    // (or not) in its own order.
    fn outer_value(&self, c: &Correlation, scope: &Scope<'_>) -> Option<Value> {
        self.eval_expr(&c.outer, &rowless(scope)).ok()
    }

    // The context's pre-built index of the collection on a correlation's local
    // path, if it offers one (asked once per collection and path; a refusal is
    // cached too, so `index_for` goes on to build the engine's own).
    fn context_index(
        &self,
        state: &CollectionState<'e>,
        c: &Correlation,
    ) -> Option<Rc<dyn RowIndex + 'e>> {
        let key = c.path.join("\u{0}");
        if let Some(hit) = state.context_indexes.borrow().get(&key) {
            return hit.clone();
        }
        let index = self.ctx.index_for(&state.value, &c.path);
        state
            .context_indexes
            .borrow_mut()
            .insert(key, index.clone());
        index
    }

    // The index of the collection on a correlation's local path: the context's
    // pre-built one when it offers it, else built here by evaluating the local
    // expression in each row's scope — the same evaluation the scan performs —
    // so the keys are exactly what `==` would compare. A failure while building
    // (a context that rejects a read) leaves the path un-indexed and the scan in
    // charge.
    fn index_for(
        &self,
        state: &CollectionState<'e>,
        rows: &[Row],
        c: &Correlation,
        scope: &Scope<'_>,
    ) -> Option<Rc<dyn RowIndex + 'e>> {
        let key = c.path.join("\u{0}");
        if let Some(hit) = state.indexes.borrow().get(&key) {
            return hit.clone();
        }
        let index: Option<Rc<dyn RowIndex + 'e>> = match self.context_index(state, c) {
            Some(found) => Some(found),
            None => {
                let mut built = HashIndex::new();
                let mut ok = true;
                for (i, row) in rows.iter().enumerate() {
                    match self.eval_expr(&c.local, &self.enter(row.clone(), scope, None)) {
                        Ok(v) => built.add(&v, i),
                        Err(_) => {
                            ok = false;
                            break;
                        }
                    }
                }
                ok.then(|| Rc::new(built) as Rc<dyn RowIndex + 'e>)
            }
        };
        state.indexes.borrow_mut().insert(key, index.clone());
        index
    }

    // A select-position collect/first/single, optionally recursive via `follow`.
    fn eval_collect_value(&self, op: &OpNode, scope: &Scope<'_>) -> Result<Value> {
        let plan = self.plan_of(op, scope);
        if !plan.invariant {
            return self.eval_collect_value_planned(op, &plan, scope);
        }
        self.memoized(op, || self.eval_collect_value_planned(op, &plan, scope))
    }

    fn eval_collect_value_planned(
        &self,
        op: &OpNode,
        plan: &Rc<BlockPlan>,
        scope: &Scope<'_>,
    ) -> Result<Value> {
        let proj = Projection::from(&op.sub);
        let (scopes, single) = self.eval_collect_scopes(op, plan, scope, false)?;
        match op.op {
            // Over a single receiver (one object) a `collect` is the record or
            // absent, not a one-element list (SEMANTICS §3).
            Consumer::Collect if single => match scopes.first() {
                Some(s) => self.project_row(proj, s),
                None => Ok(Value::Undefined),
            },
            Consumer::Collect => Ok(Value::Array(self.project_all(proj, &scopes)?)),
            // `count { … }` as a value (0.24): the number of rows the block yields.
            Consumer::Count => Ok(Value::Number(scopes.len() as f64)),
            _ => match scopes.first() {
                Some(s) => self.project_row(proj, s),
                None => Ok(Value::Null),
            },
        }
    }

    /// The rows a select-position directive yields, as scopes, reduced by its
    /// consumer (`first`/`single` keep at most one; `single` raises on more),
    /// and whether its receiver was a single object.
    fn eval_collect_scopes<'p>(
        &self,
        op: &OpNode,
        plan: &Rc<BlockPlan>,
        scope: &'p Scope<'p>,
        destination: bool,
    ) -> Result<(Vec<Scope<'p>>, bool)> {
        let sub = &op.sub;
        let bound = self.bound_of(sub.limit.as_ref(), sub.offset.as_ref(), scope)?;
        let proj = Projection::from(sub);
        let mut single = false;
        let scopes: Vec<Scope<'p>> = if let Some(follow) = &sub.follow {
            // The seeds are the matched rows themselves (`follow_walk` enters
            // them); a follow block is never correlated, so the predicate left
            // by the access is the whole `where`.
            let Access {
                rows,
                predicate,
                plan: accessed,
                ..
            } = self.access(op, plan, scope)?;
            let w = predicate.resolve(&accessed);
            let mut seeds = Vec::with_capacity(rows.len());
            for r in rows {
                let keep = match w {
                    None => true,
                    Some(w) => self.eval_where(w, &self.enter(r.clone(), scope, None))?,
                };
                if keep {
                    seeds.push(r);
                }
            }
            // A destination block's `frontier` is the destination's (read by
            // the outer walk), never a seed frontier for a `follow` of its own.
            let seed_frontier = if destination {
                None
            } else {
                sub.frontier.as_ref()
            };
            let occ = self.follow_walk(
                self.keyed(seeds, proj, scope)?,
                follow,
                seed_frontier,
                scope,
            )?;
            let mut scopes: Vec<Scope<'p>> = occ
                .into_iter()
                .map(|o| self.enter(o.row, scope, Some(o.meta)))
                .collect();
            if let Some(g) = &sub.group_by {
                scopes = self.group_scopes(scopes, g, sub.having.as_ref(), scope)?;
            }
            scopes = self.sort_scopes(scopes, sub.order_by.as_deref())?;
            if op.distinct {
                scopes = self.dedup_by_projection(scopes, proj)?;
            }
            slice_bound(scopes, bound)
        } else {
            let acc = self.access(op, plan, scope)?;
            single = acc.single;
            self.op_rows(op, scope, bound, Some(acc))?
        };
        match op.op {
            Consumer::Collect | Consumer::Count => Ok((scopes, single)),
            Consumer::First => Ok((scopes.into_iter().take(1).collect(), single)),
            Consumer::Single => {
                if scopes.len() > 1 {
                    return Err(OqxError::eval(format!(
                        "single {{ … }} for '{}' matched {} rows",
                        describe_receiver(&op.receiver),
                        scopes.len()
                    )));
                }
                Ok((scopes, single))
            }
            other => Err(OqxError::eval(format!(
                "{} {{ … }} is not valid in select position",
                other.as_str()
            ))),
        }
    }

    // ---- ordering -----------------------------------------------------------

    // Stable sort by each key in turn. Absent (null/undefined) sorts LAST
    // regardless of direction: `desc` reverses the ordering of PRESENT values
    // only (`compare_for_sort_dir`), and must not hoist rows that lack the sort
    // key to the top.
    fn sort_scopes<'p>(
        &self,
        scopes: Vec<Scope<'p>>,
        order_by: Option<&[OrderSpec]>,
    ) -> Result<Vec<Scope<'p>>> {
        let Some(specs) = order_by else {
            return Ok(scopes);
        };
        if specs.is_empty() {
            return Ok(scopes);
        }
        let mut keyed: Vec<(Vec<Value>, Scope<'p>)> = Vec::with_capacity(scopes.len());
        for s in scopes {
            let mut keys = Vec::with_capacity(specs.len());
            for spec in specs {
                keys.push(self.eval_expr(&spec.expr, &s)?);
            }
            keyed.push((keys, s));
        }
        keyed.sort_by(|(ka, _), (kb, _)| {
            for (i, spec) in specs.iter().enumerate() {
                let c = compare_for_sort_dir(&ka[i], &kb[i], spec.desc);
                if c != Ordering::Equal {
                    return c;
                }
            }
            Ordering::Equal
        });
        Ok(keyed.into_iter().map(|(_, s)| s).collect())
    }

    // ---- scalar expression evaluation ---------------------------------------

    /// An expression as a VALUE: whatever `eval_raw` yields, with a context's
    /// lazy stand-in resolved (`DataContext::materialize`), so no operand,
    /// argument, key or projected item ever observes a value the context meant
    /// as a collection it had not read yet.
    fn eval_expr(&self, e: &Expr, scope: &Scope<'_>) -> Result<Value> {
        Ok(self.ctx.materialize(self.eval_raw(e, scope)?))
    }

    /// An expression as the context handed it out — for ROW POSITION only (the
    /// source, a receiver, a `from`, a `follow` destination), where the value
    /// goes straight to `to_rows` / `index_for`. Operands inside it are values
    /// (`eval_expr`).
    fn eval_raw(&self, e: &Expr, scope: &Scope<'_>) -> Result<Value> {
        match e {
            Expr::Lit { value: v, .. } => Ok(v.clone()),
            Expr::Binding { index, .. } => self.bindings.get(*index).cloned().ok_or_else(|| {
                OqxError::eval(format!(
                    "binding ${{{index}}} is out of range ({} bound)",
                    self.bindings.len()
                ))
            }),
            Expr::Ident { name, .. } => self.resolve_in(name, scope),
            Expr::Outer { levels, name, .. } => {
                // `^name` reads from EXACTLY `levels` scopes out — the target
                // scope is resolved locally, never climbed further. Past the
                // root it is absent.
                let mut s: Option<&Scope<'_>> = Some(scope);
                for _ in 0..*levels {
                    s = match s {
                        Some(sc) => sc.parent,
                        None => None,
                    };
                }
                match s {
                    Some(sc) => self.resolve_in(name, sc),
                    None => Ok(Value::Undefined),
                }
            }
            Expr::Member { recv, name, .. } => {
                let r = self.eval_expr(recv, scope)?;
                if r.is_absent() {
                    Ok(Value::Undefined)
                } else {
                    self.ctx.get(&r, name)
                }
            }
            Expr::Call {
                recv, name, args, ..
            } => self.eval_call(recv.as_deref(), name, args, scope),
            Expr::Unary { op, expr, .. } => {
                let v = self.eval_expr(expr, scope)?;
                Ok(match op {
                    UnaryOp::Not => Value::Bool(!v.truthy()),
                    // Absent propagates: `-nope` is absent, not NaN.
                    UnaryOp::Neg if v.is_absent() => Value::Undefined,
                    UnaryOp::Neg => Value::Number(-to_number(&v)),
                })
            }
            // `x!` — the value, or an eval error naming the expression (and the
            // row's identity when it has a scalar one). Never a filter, never a
            // coercion.
            Expr::Required { expr, .. } => {
                let v = self.eval_expr(expr, scope)?;
                if v.is_absent() {
                    return Err(OqxError::eval(format!(
                        "`{}!` is absent{}",
                        describe(expr),
                        self.row_identity(scope)
                    )));
                }
                Ok(v)
            }
            // A value-position directive (`jobs first { … }.pay`, the desugared `x[…]`).
            Expr::Op(op) => self.eval_collect_value(op, scope),
            // An aggregate (SEMANTICS §24) over the group of the current scope.
            Expr::Aggregate {
                name,
                arg,
                distinct,
                ..
            } => self.aggregate(e, *name, arg.as_deref(), *distinct, scope),
            Expr::Binary {
                op, left, right, ..
            } => {
                let l = self.eval_expr(left, scope)?;
                let r = self.eval_expr(right, scope)?;
                if op.is_identity() {
                    // Identity (SEMANTICS §5b): the host's identity of each
                    // side, compared structurally — the key `distinct` and
                    // `follow` use.
                    let same = canonical_key(&self.ctx.identity(&l))
                        == canonical_key(&self.ctx.identity(&r));
                    return Ok(Value::Bool(if *op == BinaryOp::Is { same } else { !same }));
                }
                if let Some((negated, flags)) = op.regex() {
                    // The regex operators (SEMANTICS §11, since 0.22) are sugar
                    // over `matches`: `a ~ b` is `a.matches(b)`, `~*` adds the
                    // `i` flag, `!~` / `!~*` negate. They go through the same
                    // method dispatch as the call would, so a host's `matches`
                    // (and its regex dialect) applies.
                    let mut args = vec![r];
                    if let Some(f) = flags {
                        args.push(Value::Str(f.to_owned()));
                    }
                    let hit = self.call_method("matches", &l, &args)?;
                    return Ok(if negated {
                        Value::Bool(!hit.truthy())
                    } else {
                        hit
                    });
                }
                if op.is_comparison() {
                    Ok(Value::Bool(relate(op.as_str(), &l, &r)?))
                } else {
                    arith(op.as_str(), &l, &r)
                }
            }
            Expr::Logical {
                op, left, right, ..
            } => {
                let l = self.eval_expr(left, scope)?;
                match op {
                    LogicalOp::And => {
                        if l.truthy() {
                            self.eval_expr(right, scope)
                        } else {
                            Ok(l)
                        }
                    }
                    LogicalOp::Or => {
                        if l.truthy() {
                            Ok(l)
                        } else {
                            self.eval_expr(right, scope)
                        }
                    }
                }
            }
            Expr::In { left, right, .. } => {
                let l = self.eval_expr(left, scope)?;
                let r = self.eval_expr(right, scope)?;
                Ok(Value::Bool(membership(&l, &r)))
            }
            Expr::Range {
                lo,
                hi,
                exclusive_end,
                ..
            } => {
                let lo = match lo {
                    Some(e) => self.eval_expr(e, scope)?,
                    None => Value::Undefined,
                };
                let hi = match hi {
                    Some(e) => self.eval_expr(e, scope)?,
                    None => Value::Undefined,
                };
                Ok(Value::from(make_range(lo, hi, *exclusive_end)))
            }
            // A tuple (SEMANTICS §3b): the elements in order, concatenated with
            // ONE level of flattening — a collection contributes its items,
            // anything else itself; an absent (`Undefined`) element contributes
            // nothing, a `Null` one `Null`; duplicates are kept.
            Expr::Tuple { items, .. } => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    match self.eval_expr(item, scope)? {
                        Value::Undefined => {}
                        Value::Array(xs) => out.extend(xs),
                        v => out.push(v),
                    }
                }
                Ok(Value::Array(out))
            }
            // A template literal (SEMANTICS §7b, since 0.21): the text parts
            // verbatim and each interpolated value's string form (§7),
            // concatenated. Every interpolation is evaluated, in order; a list,
            // a record or a range is an eval error (it has no string form the
            // language specifies); an absent value makes the whole literal
            // absent, as `+` does.
            Expr::Template { parts, .. } => {
                let mut out = String::new();
                let mut absent = false;
                for part in parts {
                    match part {
                        TemplatePart::Text(t) => out.push_str(t),
                        TemplatePart::Expr(e) => {
                            let v = self.eval_expr(e, scope)?;
                            let what = match &v {
                                Value::Range(_) => Some("a range"),
                                Value::Array(_) => Some("a list"),
                                Value::Object(_) => Some("a record"),
                                _ => None,
                            };
                            if let Some(what) = what {
                                return Err(OqxError::eval(format!(
                                    "cannot interpolate `${{{}}}` in a template literal: it is {what} — only a string, a number, a boolean or an absent value has a string form",
                                    describe(e)
                                )));
                            }
                            match string_form(&v) {
                                Some(s) => out.push_str(&s),
                                None => absent = true,
                            }
                        }
                    }
                }
                Ok(if absent {
                    Value::Undefined
                } else {
                    Value::Str(out)
                })
            }
        }
    }

    // Resolve a name against ONE scope — never its ancestors. A scope provides,
    // in order: `$it` (the scope's row itself — the current item, whatever
    // its type, so scalar collections are queryable; at the root the host's
    // root object, since 0.18; `$value`, its pre-0.15 spelling, is an ordinary
    // property); `$key` (the property key) when it is an entry scope; the
    // recursion intrinsics (`$depth`, …) when it is a follow occurrence; values
    // lifted into it by `^name:` items; then either the row's own property or,
    // for the root scope, the context's named roots (`root(name)` — never a
    // property of the root object, so a host with lazy roots is unaffected by
    // what its root object holds).
    //
    // The two metadata steps apply only where the scope CARRIES that metadata
    // (SEMANTICS §2, since 0.13). Anywhere else — `$key` on an ordinary row,
    // `$depth` outside a follow or on the plain rows of a nested block inside
    // one — the name is an ordinary property read, so a host whose rows own a
    // `$depth`/`$ordinal` exposes it. Where the metadata exists it wins over a
    // same-named row property.
    //
    // A name the scope lacks is simply absent. It does NOT fall through to an
    // enclosing scope, so a query's meaning never depends on which properties an
    // inner row happens to have. Present-but-falsy values need no special case —
    // there is no "absent, so look outward" rule. The only failure is the
    // context's own: `DataContext::get` may reject the read.
    // ` on <identity>` for a required-value error when the scope has a row with
    // a scalar identity (its `id`, through the context); empty otherwise.
    fn row_identity(&self, scope: &Scope<'_>) -> String {
        if scope.is_root() || scope.row.is_absent() {
            return String::new();
        }
        match self.scope_identity(scope) {
            Value::Str(s) => {
                let mut q = String::new();
                json_quote(&s, &mut q);
                format!(" on {q}")
            }
            Value::Number(n) => format!(" on {}", js_number_to_string(n)),
            _ => String::new(),
        }
    }

    fn resolve_in(&self, name: &str, scope: &Scope<'_>) -> Result<Value> {
        if name == "$it" {
            return Ok(scope.row.clone());
        }
        // `$key` is the row's identity on every row (SEMANTICS §16, since 0.20).
        if name == KEY {
            return Ok(self.scope_identity(scope));
        }
        // `rows` on a group scope is the group's rows (§24); elsewhere a property.
        if name == ROWS
            && let Some(g) = &scope.group
        {
            return Ok(Value::Array(
                g.rows.iter().cloned().map(Row::into_value).collect(),
            ));
        }
        if RECUR.contains(&name) {
            if let Some(v) = scope.meta.as_ref().and_then(|m| m.get(name)) {
                return Ok(v.clone());
            }
        }
        if let Some(v) = scope.lifts.borrow().get(name) {
            return Ok(v.clone());
        }
        if scope.is_root() {
            return Ok(self.ctx.root(name));
        }
        self.ctx.get(&scope.row, name)
    }

    fn eval_call(
        &self,
        recv: Option<&Expr>,
        name: &str,
        args: &[Expr],
        scope: &Scope<'_>,
    ) -> Result<Value> {
        let mut vals = Vec::with_capacity(args.len());
        for a in args {
            vals.push(self.eval_expr(a, scope)?);
        }
        match recv {
            None => match self.ctx.call_function(name, &vals) {
                Some(r) => r,
                None => Err(OqxError::eval(format!("unknown function '{name}(…)'"))),
            },
            Some(recv) => {
                let recv = self.eval_expr(recv, scope)?;
                self.call_method(name, &recv, &vals)
            }
        }
    }

    // `recv.name(args)` on evaluated values — the dispatch a method call and the
    // regex operators share.
    fn call_method(&self, name: &str, recv: &Value, args: &[Value]) -> Result<Value> {
        match self.ctx.call_method(name, recv, args) {
            Some(r) => r,
            None => Err(OqxError::eval(format!("unknown method '.{name}(…)'"))),
        }
    }
}

// ---- free helpers -----------------------------------------------------------

fn compare_count(n: usize, cmp: &CountCmp) -> Result<bool> {
    relate(
        cmp.op.as_str(),
        &Value::Number(n as f64),
        &Value::Number(cmp.value),
    )
}

// Apply a bound to an ordered row set / to a match count.
fn slice_bound<T>(rows: Vec<T>, b: Bound) -> Vec<T> {
    if b == UNBOUNDED {
        return rows;
    }
    rows.into_iter()
        .skip(b.offset)
        .take(b.limit.unwrap_or(usize::MAX))
        .collect()
}

fn bounded_count(n: usize, b: Bound) -> usize {
    let rest = n.saturating_sub(b.offset);
    match b.limit {
        None => rest,
        Some(l) => rest.min(l),
    }
}

// Guard a value bound for a result: a range (`lo..hi`) exists only during
// evaluation. Checks the value itself and, for an array, its elements — deeper
// structure is host data (which cannot hold a range) or a nested block's
// result (already guarded when it was projected).
fn no_range(v: Value) -> Result<Value> {
    let holds_range = match &v {
        Value::Range(_) => true,
        Value::Array(xs) => xs.iter().any(is_range),
        _ => false,
    };
    if holds_range {
        return Err(OqxError::eval(
            "a range (lo..hi) cannot appear in a result; test membership with `x in lo..hi` instead",
        ));
    }
    Ok(v)
}

// Order two `follow` paths (identity sequences) component-wise: two numbers
// numerically, two strings by code point; otherwise numbers precede strings
// precede everything else, and same-kind others order by canonical key. A
// shorter path that is a prefix of a longer one precedes it.
fn compare_path(a: &[Value], b: &[Value]) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        let c = compare_component(x, y);
        if c != Ordering::Equal {
            return c;
        }
    }
    a.len().cmp(&b.len())
}

fn compare_component(x: &Value, y: &Value) -> Ordering {
    if let Some(c) = compare(x, y) {
        return c;
    }
    component_rank(x)
        .cmp(&component_rank(y))
        .then_with(|| canonical_key(x).cmp(&canonical_key(y)))
}

fn component_rank(v: &Value) -> u8 {
    match v {
        Value::Number(_) => 0,
        Value::Str(_) => 1,
        _ => 2,
    }
}

// The canonical text of an expression for an error message; a binding shows as
// its `${n}` marker (the printer refuses to turn a bound value into source).
fn describe(e: &Expr) -> String {
    let t = print_template(Node::Expr(e));
    let mut out = String::new();
    for (i, s) in t.strings.iter().enumerate() {
        out.push_str(s);
        if i < t.count {
            out.push_str(&format!("${{{}}}", t.indices[i]));
        }
    }
    out
}

// The kind of a value, for an aggregate's error: `a string ("abc")`, `a list`, …
fn describe_value_kind(v: &Value) -> String {
    match v {
        Value::Str(_) => format!("a string ({})", json_string(v)),
        Value::Number(_) => format!("a number ({})", json_string(v)),
        Value::Bool(_) => format!("a boolean ({})", json_string(v)),
        Value::Range(_) => "a range".to_owned(),
        Value::Array(_) => "a list".to_owned(),
        Value::Undefined | Value::Null | Value::Object(_) => "a record".to_owned(),
    }
}

fn describe_receiver(e: &Expr) -> String {
    match e {
        Expr::Ident { name, .. } => name.clone(),
        Expr::Member { recv, name, .. } => format!("{}.{name}", describe_receiver(recv)),
        Expr::Binding { index, .. } => format!("${{{index}}}"),
        _ => "receiver".to_owned(),
    }
}

/// Split a `follow` query's `where` into the conjuncts that select seeds (no
/// recursion intrinsic mentioned) and those applied to the walked occurrences.
/// The test is syntactic — a bare `$depth` in the body of a follow always names
/// the occurrence's metadata, so no property read can be mistaken for it here;
/// without a `follow` this split is never consulted and `$depth` is an ordinary
/// predicate over the row.
fn partition_recur(w: &Where) -> (Vec<&Where>, Vec<&Where>) {
    let parts: Vec<&Where> = match w {
        Where::And { parts, .. } => parts.iter().collect(),
        other => vec![other],
    };
    let mut seed = Vec::new();
    let mut post = Vec::new();
    for p in parts {
        if where_has_recur(p) {
            post.push(p);
        } else {
            seed.push(p);
        }
    }
    (seed, post)
}

fn where_has_recur(w: &Where) -> bool {
    match w {
        Where::And { parts, .. } | Where::Or { parts, .. } => parts.iter().any(where_has_recur),
        Where::Not { expr, .. } => where_has_recur(expr),
        Where::Scalar { expr, .. } => expr_has_recur(expr),
        Where::Op(_) => false,
    }
}

fn expr_has_recur(e: &Expr) -> bool {
    match e {
        Expr::Ident { name, .. } => RECUR.contains(&name.as_str()),
        Expr::Member { recv, .. } => expr_has_recur(recv),
        Expr::Call { recv, args, .. } => {
            recv.as_deref().is_some_and(expr_has_recur) || args.iter().any(expr_has_recur)
        }
        Expr::Unary { expr, .. } | Expr::Required { expr, .. } => expr_has_recur(expr),
        Expr::Op(_) => false,
        Expr::Binary { left, right, .. }
        | Expr::Logical { left, right, .. }
        | Expr::In { left, right, .. } => expr_has_recur(left) || expr_has_recur(right),
        Expr::Range { lo, hi, .. } => {
            lo.as_deref().is_some_and(expr_has_recur) || hi.as_deref().is_some_and(expr_has_recur)
        }
        Expr::Tuple { items, .. } => items.iter().any(expr_has_recur),
        Expr::Template { parts, .. } => template_exprs(parts).any(expr_has_recur),
        Expr::Aggregate { arg, .. } => arg.as_deref().is_some_and(expr_has_recur),
        Expr::Lit { .. } | Expr::Binding { .. } | Expr::Outer { .. } => false,
    }
}

/// `JSON.stringify` of a value: an `Undefined` property is dropped, an
/// `Undefined` element or top-level value is `null`, non-finite numbers are
/// `null`, and keys are in insertion order. Used for error messages.
fn json_string(v: &Value) -> String {
    let mut out = String::new();
    json_write(v, &mut out);
    out
}

fn json_write(v: &Value, out: &mut String) {
    match v {
        Value::Undefined | Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if n.is_finite() {
                out.push_str(&js_number_to_string(*n));
            } else {
                out.push_str("null");
            }
        }
        Value::Str(s) => json_quote(s, out),
        Value::Array(xs) => {
            out.push('[');
            for (i, x) in xs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_write(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            let mut first = true;
            for (k, x) in o.iter() {
                if matches!(x, Value::Undefined) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                json_quote(k, out);
                out.push(':');
                json_write(x, out);
            }
            out.push('}');
        }
        Value::Range(r) => {
            // The reference leaks its internal record shape here; mirror it.
            out.push_str("{\"__oqxRange\":true,\"lo\":");
            json_write(r.lo.as_ref().unwrap_or(&Value::Null), out);
            out.push_str(",\"hi\":");
            json_write(r.hi.as_ref().unwrap_or(&Value::Null), out);
            out.push_str(",\"exclusiveEnd\":");
            out.push_str(if r.exclusive_end { "true" } else { "false" });
            out.push('}');
        }
    }
}

fn json_quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---- tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::DefaultContext;
    use crate::parser::{parse_string, parse_template};
    use crate::run_query;
    use serde_json::json;

    /// Build a `Value` from a `serde_json::Value` (independent of the `json`
    /// feature so these tests do not depend on it).
    fn v(j: serde_json::Value) -> Value {
        match j {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Bool(b),
            serde_json::Value::Number(n) => Value::Number(n.as_f64().unwrap()),
            serde_json::Value::String(s) => Value::Str(s),
            serde_json::Value::Array(xs) => Value::Array(xs.into_iter().map(v).collect()),
            serde_json::Value::Object(o) => {
                Value::Object(o.into_iter().map(|(k, x)| (k, v(x))).collect())
            }
        }
    }

    /// The spec's result canonicalization: an `Undefined` property is dropped;
    /// an `Undefined` element or top-level value becomes `Null`.
    fn canon(x: Value) -> Value {
        match x {
            Value::Undefined => Value::Null,
            Value::Array(xs) => Value::Array(xs.into_iter().map(canon).collect()),
            Value::Object(o) => Value::Object(
                o.into_iter()
                    .filter(|(_, x)| !matches!(x, Value::Undefined))
                    .map(|(k, x)| (k, canon(x)))
                    .collect(),
            ),
            other => other,
        }
    }

    fn roots(j: serde_json::Value) -> Object {
        match v(j) {
            Value::Object(o) => o,
            _ => panic!("roots must be an object"),
        }
    }

    fn run(q: &str, r: serde_json::Value) -> Result<Value> {
        let query = parse_string(q)?;
        Ok(canon(run_query(&query, &[], roots(r))?.into_value()))
    }

    fn run_t(
        fragments: &[&str],
        values: Vec<serde_json::Value>,
        r: serde_json::Value,
    ) -> Result<Value> {
        let query = parse_template(fragments, values.len())?;
        let bindings: Vec<Value> = values.into_iter().map(v).collect();
        Ok(canon(run_query(&query, &bindings, roots(r))?.into_value()))
    }

    fn check(q: &str, r: serde_json::Value, expect: serde_json::Value) {
        let got = run(q, r).unwrap_or_else(|e| panic!("{q}: {e}"));
        let want = v(expect);
        assert!(
            equals(&got, &want),
            "{q}\n   got: {got:?}\n  want: {want:?}"
        );
    }

    fn check_err(q: &str, r: serde_json::Value, includes: &[&str]) {
        match run(q, r) {
            Ok(got) => panic!("{q}: expected an eval error, got {got:?}"),
            Err(e) => {
                assert_eq!(e.stage, crate::Stage::Eval, "{q}: {e}");
                for frag in includes {
                    assert!(e.message.contains(frag), "{q}: {e} lacks {frag:?}");
                }
            }
        }
    }

    fn people() -> serde_json::Value {
        json!({ "people": [
            { "name": "Bob",   "id": 124, "title": "Engineer", "active": true,  "age": 41, "city": "NYC",
              "jobs": [{ "employer": "Globocorp", "start": "1984", "end": "1990" },
                       { "employer": "Globocorp", "start": "2001" }] },
            { "name": "Alice", "id": 7,   "title": "Director", "active": true,  "age": 52, "city": "SF",
              "jobs": [{ "employer": "Initech",   "start": "1999", "end": "2005" },
                       { "employer": "Globocorp", "start": "2010", "end": "2015" }] },
            { "name": "Carol", "id": 55,  "title": "Analyst",  "active": false, "age": 29, "city": "NYC",
              "jobs": [{ "employer": "Globocorp", "start": "2020" }] }
        ]})
    }

    // ---- tutorial -----------------------------------------------------------

    #[test]
    fn tutorial_source_and_projection() {
        check(
            "name from people",
            people(),
            json!([{ "name": "Bob" }, { "name": "Alice" }, { "name": "Carol" }]),
        );
        check(
            "name, id from people",
            people(),
            json!([{ "name": "Bob", "id": 124 }, { "name": "Alice", "id": 7 }, { "name": "Carol", "id": 55 }]),
        );
        check(
            "name values from people where active",
            people(),
            json!(["Bob", "Alice"]),
        );
        check(
            r#"label: name, decade: age / 10 from people where name == "Bob""#,
            people(),
            json!([{ "label": "Bob", "decade": 4.1 }]),
        );
        check(
            "meta.slug from r",
            json!({ "r": [{ "meta": { "slug": "x" } }, {}] }),
            json!([{ "slug": "x" }, {}]),
        );
    }

    #[test]
    fn tutorial_values_and_dollar_value() {
        check(
            "name values from people",
            people(),
            json!(["Bob", "Alice", "Carol"]),
        );
        check(
            "name.upper() values from people where age < 30",
            people(),
            json!(["CAROL"]),
        );
        check(
            "people first { name values where age > 50 }",
            people(),
            json!("Alice"),
        );
        let scores = json!({ "scores": [10, 60, 70, 45] });
        check(
            "$it values from scores where $it > 50",
            scores.clone(),
            json!([60, 70]),
        );
        check(
            "$it values from scores order by $it desc",
            scores,
            json!([70, 60, 45, 10]),
        );
        check(
            "name, big: scores collect { $it values where $it > 50 } from players",
            json!({ "players": [{ "name": "Ann", "scores": [10, 60, 70] }, { "name": "Ben", "scores": [45] }] }),
            json!([{ "name": "Ann", "big": [60, 70] }, { "name": "Ben", "big": [] }]),
        );
        check(
            r#"employee: $it from people where name == "Carol""#,
            people(),
            json!([{ "employee": { "name": "Carol", "id": 55, "title": "Analyst", "active": false, "age": 29, "city": "NYC",
                                   "jobs": [{ "employer": "Globocorp", "start": "2020" }] } }]),
        );
    }

    #[test]
    fn tutorial_entries_and_key() {
        let settings = json!({ "settings": { "theme": "dark", "fontSize": 14, "autosave": true } });
        check(
            "key: $key, value: $it from entries(settings)",
            settings.clone(),
            json!([{ "key": "theme", "value": "dark" }, { "key": "fontSize", "value": 14 }, { "key": "autosave", "value": true }]),
        );
        check(
            r#"$key values from entries(settings) where $it != "dark""#,
            settings.clone(),
            json!(["fontSize", "autosave"]),
        );
        check(
            "from entries(settings)",
            settings.clone(),
            json!(["dark", 14, true]),
        );
        // one object in row position is one record, not a one-element list (0.20)
        check(
            "from settings",
            settings.clone(),
            json!({ "theme": "dark", "fontSize": 14, "autosave": true }),
        );
        check(
            "settings { theme }",
            settings.clone(),
            json!({ "theme": "dark" }),
        );
        check(
            "from list(settings)",
            settings.clone(),
            json!([{ "theme": "dark", "fontSize": 14, "autosave": true }]),
        );
        check("settings count { }", settings.clone(), json!(1));
        check("entries(settings) count { }", settings, json!(3));
        check(
            "$key values from entries(flags) where on",
            json!({ "flags": { "beta": { "on": true }, "legacy": { "on": false } } }),
            json!(["beta"]),
        );
        let users = json!({ "users": [
            { "name": "Ann", "prefs": { "dark": true, "beta": false } },
            { "name": "Ben", "prefs": { "dark": false } },
            { "name": "Cid" }
        ]});
        check(
            "name, on: entries(prefs) collect { $key values where $it } from users",
            users.clone(),
            json!([{ "name": "Ann", "on": ["dark"] }, { "name": "Ben", "on": [] }, { "name": "Cid", "on": [] }]),
        );
        check(
            r#"name values from users where entries(prefs) exists { where $key == "dark" && $it }"#,
            users.clone(),
            json!(["Ann"]),
        );
        check(
            "name values from users where entries(prefs) none { }",
            users,
            json!(["Cid"]),
        );
        check(
            "k: $key, v: $it from entries(xs)",
            json!({ "xs": ["x", "y"] }),
            json!([{ "k": 0, "v": "x" }, { "k": 1, "v": "y" }]),
        );
        check("from entries(z)", json!({ "z": null }), json!([]));
        check("from entries(n)", json!({ "n": 5 }), json!([]));
        check("from entries(nope)", json!({}), json!([]));
        // Entries in value position are plain records.
        check(
            "e: entries(s) values from xs",
            json!({ "xs": [{ "s": { "a": 1, "b": 2 } }] }),
            json!([[{ "key": "a", "value": 1 }, { "key": "b", "value": 2 }]]),
        );
        // A data row that merely LOOKS like an entry is not unwrapped: its
        // `$key` is its identity — the whole row under the structural default.
        check(
            "k: $key, key, value from r",
            json!({ "r": [{ "key": "k1", "value": 9 }] }),
            json!([{ "k": { "key": "k1", "value": 9 }, "key": "k1", "value": 9 }]),
        );
        check(
            "r collect { $key values from entries(o) }",
            json!({ "r": [{ "o": { "a": 1, "b": 2 } }] }),
            json!(["a", "b"]),
        );
        check(
            r#"$key values from entries(groups) where $it exists { where $it > 4 && ^$key == "b" }"#,
            json!({ "groups": { "a": [1, 2, 3], "b": [4, 5] } }),
            json!(["b"]),
        );
    }

    #[test]
    fn tutorial_predicates_and_builtins() {
        check(
            "name values from people where age >= 40",
            people(),
            json!(["Bob", "Alice"]),
        );
        check(
            "name values from people where !active",
            people(),
            json!(["Carol"]),
        );
        check(
            "name values from people where age in 40..50",
            people(),
            json!(["Bob"]),
        );
        check(
            "name values from people where age in 40...41",
            people(),
            json!([]),
        );
        check(
            "name values from people where age in 50..",
            people(),
            json!(["Alice"]),
        );
        check(
            "name values from people where age in ..29",
            people(),
            json!(["Carol"]),
        );
        check(
            r#"name values from people where title.startsWith("Eng")"#,
            people(),
            json!(["Bob"]),
        );
        check(
            r#"name values from people where title.lower() == "director""#,
            people(),
            json!(["Alice"]),
        );
        check(
            "name values from people where has(age) && !has(nickname)",
            people(),
            json!(["Bob", "Alice", "Carol"]),
        );
        check(
            r#"name values from t where tags.contains("admin")"#,
            json!({ "t": [{ "name": "a", "tags": ["admin"] }, { "name": "b", "tags": [] }, { "name": "c" }] }),
            json!(["a"]),
        );
        check(
            r#"label values from events where on in "2026-01-01".."2026-03-31""#,
            json!({ "events": [{ "label": "q1", "on": "2026-02-14" }, { "label": "q2", "on": "2026-04-01" }] }),
            json!(["q1"]),
        );
        check(
            r#"label values from w where "2026-02-14" in range(window)"#,
            json!({ "w": [{ "label": "in", "window": "2026-01-01..2026-03-31" }, { "label": "bad", "window": "hello" }] }),
            json!(["in"]),
        );
    }

    #[test]
    fn tutorial_aliases_in_where() {
        check(
            "select name, adult: age >= 30 from people where adult",
            people(),
            json!([{ "name": "Bob", "adult": true }, { "name": "Alice", "adult": true }]),
        );
        check(
            "select name, active: age > 50 from people where active",
            people(),
            json!([{ "name": "Alice", "active": true }]),
        );
        check(
            "select name, current: jobs collect { employer where !end } from people where current",
            people(),
            json!([{ "name": "Bob", "current": [{ "employer": "Globocorp" }] },
                   { "name": "Carol", "current": [{ "employer": "Globocorp" }] }]),
        );
    }

    #[test]
    fn tutorial_scoping_and_outer_refs() {
        let accounts = json!({ "accounts": [
            { "owner": "x", "budget": 100, "orders": [{ "amount": 50 }, { "amount": 150 }] },
            { "owner": "y", "budget": 200, "orders": [{ "amount": 250 }] }
        ]});
        check(
            "owner from accounts where orders exists { where amount > ^budget }",
            accounts.clone(),
            json!([{ "owner": "x" }, { "owner": "y" }]),
        );
        check(
            "owner from accounts where orders exists { where amount > budget }",
            accounts,
            json!([]),
        );
        let family = json!({ "family": [
            { "name": "Ada", "parent": "Pat" }, { "name": "Ben", "parent": "Pat" }, { "name": "Cy", "parent": "Sam" }
        ]});
        check(
            "name, siblings: ^family collect { name where parent == ^parent && name != ^name } from family",
            family,
            json!([{ "name": "Ada", "siblings": [{ "name": "Ben" }] },
                   { "name": "Ben", "siblings": [{ "name": "Ada" }] },
                   { "name": "Cy", "siblings": [] }]),
        );
        check(
            "name, peers: ^people collect { name where city == ^city && name != ^name } from people",
            people(),
            json!([{ "name": "Bob", "peers": [{ "name": "Carol" }] },
                   { "name": "Alice", "peers": [] },
                   { "name": "Carol", "peers": [{ "name": "Bob" }] }]),
        );
        // ^ past the root is absent; ^$it is the enclosing row; at the root `$it`
        // is the host's root object (0.18): `^$it` from a top-level row names the
        // root scope, whose row is DefaultContext's roots record.
        check(
            "x: ^^^nope, y: ^$it, z: ^r from r",
            json!({ "r": [1] }),
            json!([{ "y": { "r": [1] }, "z": [1] }]),
        );
        check(
            "r collect { a: $it, b: ^$it, c: ^^r }",
            json!({ "r": [1] }),
            json!([{ "a": 1, "b": { "r": [1] } }]),
        );
        check(
            "n: jobs collect { e: employer, who: ^name, root: ^^people } from people where name == \"Carol\"",
            people(),
            json!([{ "n": [{ "e": "Globocorp", "who": "Carol", "root": [
                { "name": "Bob",   "id": 124, "title": "Engineer", "active": true,  "age": 41, "city": "NYC",
                  "jobs": [{ "employer": "Globocorp", "start": "1984", "end": "1990" }, { "employer": "Globocorp", "start": "2001" }] },
                { "name": "Alice", "id": 7,   "title": "Director", "active": true,  "age": 52, "city": "SF",
                  "jobs": [{ "employer": "Initech",   "start": "1999", "end": "2005" }, { "employer": "Globocorp", "start": "2010", "end": "2015" }] },
                { "name": "Carol", "id": 55,  "title": "Analyst",  "active": false, "age": 29, "city": "NYC",
                  "jobs": [{ "employer": "Globocorp", "start": "2020" }] }
            ] }] }]),
        );
    }

    #[test]
    fn tutorial_consumers() {
        check("people exists { where active }", people(), json!(true));
        check("people count { where active }", people(), json!(2));
        check(
            "people first { name where age > 50 }",
            people(),
            json!({ "name": "Alice" }),
        );
        check(
            "people first { name where age > 90 }",
            people(),
            json!(null),
        );
        check(
            "people single { name where age > 50 }",
            people(),
            json!({ "name": "Alice" }),
        );
        check("people none { where age > 90 }", people(), json!(true));
        check("people none { where active }", people(), json!(false));
        // `single` always materializes, so the error reports the true count.
        check_err(
            "people single { }",
            people(),
            &["single { … } matched 3 rows"],
        );
        check_err(
            "people single { offset 1 }",
            people(),
            &["single { … } matched 2 rows"],
        );
        check(
            "people single { name values limit 1 }",
            people(),
            json!("Bob"),
        );
        check_err(
            "people single { order by name }",
            people(),
            &["single { … } matched 3 rows"],
        );
        check_err(
            "n: jobs single { employer } from people where name == \"Bob\"",
            people(),
            &["single { … } for 'jobs' matched 2 rows"],
        );
        check(
            "name values from people where jobs exists { where !end }",
            people(),
            json!(["Bob", "Carol"]),
        );
        check(
            "name values from people where jobs count {} >= 2",
            people(),
            json!(["Bob", "Alice"]),
        );
        check(
            "name values from people where jobs none { where end }",
            people(),
            json!(["Carol"]),
        );
        check(
            "name values from people where jobs count { where end }",
            people(),
            json!(["Bob", "Alice"]),
        );
        check(
            r#"name, current: jobs collect { employer where !end } from people where name == "Bob""#,
            people(),
            json!([{ "name": "Bob", "current": [{ "employer": "Globocorp" }] }]),
        );
        check(
            r#"name, firstJob: jobs first { employer } from people where name == "Alice""#,
            people(),
            json!([{ "name": "Alice", "firstJob": { "employer": "Initech" } }]),
        );
        check(
            r#"name, none: jobs first { employer where end == "never" } from people where name == "Alice""#,
            people(),
            json!([{ "name": "Alice", "none": null }]),
        );
    }

    #[test]
    fn tutorial_distinct() {
        check(
            "select distinct employer from jobs",
            json!({ "jobs": [{ "employer": "G" }, { "employer": "I" }, { "employer": "G" }] }),
            json!([{ "employer": "G" }, { "employer": "I" }]),
        );
        check(
            "n: jobs collect distinct { select employer } from people",
            people(),
            json!([{ "n": [{ "employer": "Globocorp" }] },
                   { "n": [{ "employer": "Initech" }, { "employer": "Globocorp" }] },
                   { "n": [{ "employer": "Globocorp" }] }]),
        );
        check(
            "name values from people where jobs count distinct { select employer } == 1",
            people(),
            json!(["Bob", "Carol"]),
        );
        check(
            "select distinct employer values from jobs",
            json!({ "jobs": [{ "employer": "G" }, { "employer": "I" }, { "employer": "G" }] }),
            json!(["G", "I"]),
        );
        // Empty projection: identity (id, else structural — NOT `[object Object]`).
        check(
            "xs count distinct { }",
            json!({ "xs": [{ "id": 1 }, { "id": 1 }, { "id": 2 }] }),
            json!(2),
        );
        check(
            "xs count distinct { }",
            json!({ "xs": [{ "a": 1 }, { "a": 2 }, { "a": 1 }] }),
            json!(2),
        );
        check(
            "xs count distinct { }",
            json!({ "xs": [1, "1", 1] }),
            json!(2),
        );
        check(
            "select distinct a from xs",
            json!({ "xs": [{ "a": null }, {}] }),
            json!([{ "a": null }]),
        );
        check(
            "select distinct a, b from xs",
            json!({ "xs": [{ "a": 1, "b": 1 }, { "b": 1, "a": 1 }, { "a": 1, "b": 2 }] }),
            json!([{ "a": 1, "b": 1 }, { "a": 1, "b": 2 }]),
        );
        check(
            "xs single { select distinct a }",
            json!({ "xs": [{ "a": 1 }, { "a": 1 }] }),
            json!({ "a": 1 }),
        );
        check(
            "xs count distinct { }",
            json!({ "xs": [1, 1, 2] }),
            json!(2),
        );
    }

    #[test]
    fn grouping_and_aggregates() {
        // The default projection: the keys and `count: count()`, groups in
        // first-appearance order; `where` runs per row before the grouping.
        check(
            "from people group by city",
            people(),
            json!([{ "city": "NYC", "count": 2 }, { "city": "SF", "count": 1 }]),
        );
        check(
            "select city, n: count() from people where active group by city",
            people(),
            json!([{ "city": "NYC", "n": 1 }, { "city": "SF", "n": 1 }]),
        );
        // Every aggregate; absent values are skipped (sum of none is 0, avg of none absent).
        check(
            "select city, s: sum(age), a: avg(age), lo: min(age), hi: max(age), names: collect(name), f: first(name), l: last(name), some: any(active), every: all(active), d: count(distinct active) from people group by city",
            people(),
            json!([
                { "city": "NYC", "s": 70, "a": 35, "lo": 29, "hi": 41, "names": ["Bob", "Carol"], "f": "Bob", "l": "Carol", "some": true, "every": false, "d": 2 },
                { "city": "SF", "s": 52, "a": 52, "lo": 52, "hi": 52, "names": ["Alice"], "f": "Alice", "l": "Alice", "some": true, "every": true, "d": 1 }
            ]),
        );
        check(
            "select g, s: sum(v), a: avg(v) from xs group by g",
            json!({ "xs": [{ "g": 1 }, { "g": 1, "v": null }] }),
            json!([{ "g": 1, "s": 0 }]),
        );
        check_err(
            "select city, s: sum(name) from people group by city",
            people(),
            &["cannot sum `name` over the group: it is a string (\"Bob\") — `sum` takes numbers"],
        );
        // `rows`: the group's rows as a receiver (`^` inside reads the keys) in a
        // select item and in `having`; `order by` reads the group scope.
        check(
            "select city, n: rows count { where age > 30 && city == ^city }, youngest: rows first { name values order by age } from people group by city having rows exists { where age > 30 } order by count() desc, city",
            people(),
            json!([{ "city": "NYC", "n": 1, "youngest": "Carol" }, { "city": "SF", "n": 1, "youngest": "Alice" }]),
        );
        check(
            "select city, ages: rows collect { age values } from people group by city",
            people(),
            json!([{ "city": "NYC", "ages": [41, 29] }, { "city": "SF", "ages": [52] }]),
        );
        // An entry row stays an entry through `rows`: `$key` is readable inside the block.
        check(
            "select k, ks: rows collect { $key values } from entries(o) group by k: $it.k",
            json!({ "o": { "a": { "k": 1 }, "b": { "k": 2 }, "c": { "k": 1 } } }),
            json!([{ "k": 1, "ks": ["a", "c"] }, { "k": 2, "ks": ["b"] }]),
        );
        // A nested grouped block, a count of groups, a where-position test over groups.
        check(
            "name, by: jobs collect { employer, n: count() group by employer }, g: jobs count { group by employer } from people where jobs exists { group by employer having count() > 1 }",
            people(),
            json!([{ "name": "Bob", "by": [{ "employer": "Globocorp", "n": 2 }], "g": 1 }]),
        );
        // `count { … }` is a value outside grouping too (0.24).
        check(
            "name, n: jobs count { where end } from people",
            people(),
            json!([{ "name": "Bob", "n": 1 }, { "name": "Alice", "n": 2 }, { "name": "Carol", "n": 0 }]),
        );
        // Grouping a walk groups the occurrences; a single receiver grouped is one record.
        check(
            "select d, n: count() from tree follow kids group by d: $depth",
            json!({ "tree": [{ "kids": [{ "kids": [{}] }, {}] }] }),
            json!([{ "d": 1, "n": 1 }, { "d": 2, "n": 2 }, { "d": 3, "n": 1 }]),
        );
        check(
            "p { group by city }",
            json!({ "p": { "city": "NYC" } }),
            json!({ "city": "NYC", "count": 1 }),
        );
        // Top-level consumers reduce the groups.
        check("people count { group by city }", people(), json!(2));
        check(
            "people first { group by city }",
            people(),
            json!({ "city": "NYC", "count": 2 }),
        );
        check(
            "people exists { group by city having count() > 2 }",
            people(),
            json!(false),
        );
    }

    #[test]
    fn tutorial_lifts() {
        check(
            "name, currentEmployers from people where jobs collect { ^currentEmployers: employer where !end }",
            people(),
            json!([{ "name": "Bob", "currentEmployers": ["Globocorp"] },
                   { "name": "Carol", "currentEmployers": ["Globocorp"] }]),
        );
        let departments = json!({ "departments": [
            { "name": "Eng",   "teams": [{ "id": "t1", "members": [{ "name": "Ada" }, { "name": "Ben" }] },
                                         { "id": "t2", "members": [{ "name": "Cy" }] }] },
            { "name": "Sales", "teams": [{ "id": "t3", "members": [{ "name": "Dee" }] }] }
        ]});
        check(
            "name, teamIds, allMembers from departments where teams collect { ^teamIds: id where members collect { ^^allMembers: name } }",
            departments,
            json!([{ "name": "Eng",   "teamIds": ["t1", "t2"], "allMembers": ["Ada", "Ben", "Cy"] },
                   { "name": "Sales", "teamIds": ["t3"],       "allMembers": ["Dee"] }]),
        );
        check(
            "v, l from r where mid collect { ^l }",
            json!({ "r": [{ "v": 1, "mid": [{ "l": "a" }, { "l": "b" }] }, { "v": 2, "mid": [] }] }),
            json!([{ "v": 1, "l": ["a", "b"] }]),
        );
    }

    #[test]
    fn tutorial_ordering_and_bounds() {
        check(
            r#"name from people where city == "NYC" order by age desc"#,
            people(),
            json!([{ "name": "Bob" }, { "name": "Carol" }]),
        );
        check(
            "name values from people order by age desc limit 2",
            people(),
            json!(["Alice", "Bob"]),
        );
        check(
            "name values from people order by age desc limit 1 offset 1",
            people(),
            json!(["Bob"]),
        );
        check(
            "name, latest: jobs collect { employer values order by start desc limit 1 } from people",
            people(),
            json!([{ "name": "Bob", "latest": ["Globocorp"] }, { "name": "Alice", "latest": ["Globocorp"] },
                   { "name": "Carol", "latest": ["Globocorp"] }]),
        );
        check(
            "name values from people where jobs exists { offset 1 }",
            people(),
            json!(["Bob", "Alice"]),
        );
        // Absent sorts last in both directions; stable ties.
        let docs = json!({ "docs": [{ "name": "a", "rank": 2 }, { "name": "b" }, { "name": "c", "rank": 1 }, { "name": "d", "rank": 2 }] });
        check(
            "name values from docs order by rank desc",
            docs.clone(),
            json!(["a", "d", "c", "b"]),
        );
        check(
            "name values from docs order by rank",
            docs.clone(),
            json!(["c", "a", "d", "b"]),
        );
        check(
            "name values from docs order by rank desc, name desc",
            docs,
            json!(["d", "a", "c", "b"]),
        );
        // Bounds under consumers.
        check("xs count { limit 2 }", json!({ "xs": [1, 2, 3] }), json!(2));
        check(
            "xs first { offset 1 }",
            json!({ "xs": [1, 2, 3] }),
            json!(2),
        );
        check(
            "xs exists { offset 2 }",
            json!({ "xs": [1, 2, 3] }),
            json!(true),
        );
        check(
            "xs exists { offset 3 }",
            json!({ "xs": [1, 2, 3] }),
            json!(false),
        );
        check(
            "xs none { limit 0 }",
            json!({ "xs": [1, 2, 3] }),
            json!(true),
        );
        check("xs count { }", json!({ "xs": [1, 2, 3] }), json!(3));
        check(
            "from xs limit 1 offset 1",
            json!({ "xs": [1, 2, 3] }),
            json!([2]),
        );
        check(
            "xs single { offset 2 }",
            json!({ "xs": [1, 2, 3] }),
            json!(3),
        );
        // `^n` inside a block reads the enclosing row.
        check(
            "name, top: xs collect { $it values limit ^n } from r",
            json!({ "r": [{ "name": "a", "n": 1, "xs": [1, 2, 3] }, { "name": "b", "n": 2, "xs": [1, 2, 3] }] }),
            json!([{ "name": "a", "top": [1] }, { "name": "b", "top": [1, 2] }]),
        );
        check_err(
            "from xs limit 1.5",
            json!({ "xs": [] }),
            &["limit must be a non-negative integer", "1.5"],
        );
        // (A top-level `offset ^n` is a parse error — GRAMMAR — so a bound that
        // evaluates to absent is only reachable through a binding.)
        let q = parse_template(&["from xs offset ", ""], 1).unwrap();
        let err = run_query(&q, &[Value::Null], roots(json!({ "xs": [] }))).unwrap_err();
        assert!(
            err.message
                .contains("offset must be a non-negative integer (got null)"),
            "{err}"
        );
        let q = parse_template(&["from xs offset ", ""], 1).unwrap();
        let err = run_query(&q, &[Value::from(-1)], roots(json!({ "xs": [] }))).unwrap_err();
        assert!(
            err.message
                .contains("offset must be a non-negative integer (got -1)"),
            "{err}"
        );
        let q = parse_template(&["from xs limit ", ""], 1).unwrap();
        let err = run_query(&q, &[Value::Bool(true)], roots(json!({ "xs": [] }))).unwrap_err();
        assert!(
            err.message
                .contains("limit must be a non-negative integer (got true)"),
            "{err}"
        );
        let q = parse_template(&["from xs limit ", ""], 1).unwrap();
        let err = run_query(&q, &[Value::from("2")], roots(json!({ "xs": [] }))).unwrap_err();
        assert!(
            err.message
                .contains("limit must be a non-negative integer (got \"2\")"),
            "{err}"
        );
        check_err(
            "xs count { limit 1.5 }",
            json!({ "xs": [] }),
            &["limit must be a non-negative integer"],
        );
    }

    #[test]
    fn follow_destinations_and_correlated_where() {
        // the follow `where` reads the frontier row through `^` (0.14)
        check(
            "id values from g follow next { where prev == ^id } order by $ordinal",
            json!({ "g": [{ "id": "a", "next": [
                { "id": "b", "prev": "a", "next": [{ "id": "c", "prev": "b", "next": [] }] },
                { "id": "d", "prev": "z", "next": [] }] }] }),
            json!(["a", "b", "c"]),
        );
        // two destinations walk their union, unioned by identity within a step
        check(
            "id, d: $depth from g follow before, after order by $ordinal",
            json!({ "g": [{ "id": 1,
                "before": [{ "id": 2, "before": [], "after": [] }],
                "after": [{ "id": 2, "before": [], "after": [] }, { "id": 3 }] }] }),
            json!([{ "id": 1, "d": 1 }, { "id": 2, "d": 2 }, { "id": 3, "d": 2 }]),
        );
        // a destination block computes successors per frontier row: `^people` is
        // the root one scope out of the frontier row, `^id` the frontier row's id
        check(
            "id values from people where id == 1 follow ^people collect { where manager == ^id } order by $ordinal",
            json!({ "people": [
                { "id": 1, "manager": null }, { "id": 2, "manager": 1 },
                { "id": 3, "manager": 1 }, { "id": 4, "manager": 2 }] }),
            json!([1, 2, 3, 4]),
        );
        // `first` yields at most one successor; `null` (no match) yields none
        check(
            "id values from people where id == 1 follow ^people first { where manager == ^id order by id desc } order by $ordinal",
            json!({ "people": [
                { "id": 1, "manager": null }, { "id": 2, "manager": 1 },
                { "id": 3, "manager": 1 }, { "id": 4, "manager": 2 }] }),
            json!([1, 3]),
        );
    }

    #[test]
    fn tutorial_follow() {
        let tree = json!({ "tree": [{ "id": "root", "children": [
            { "id": "a", "children": [{ "id": "a1", "children": [] }] },
            { "id": "b", "children": [] }
        ]}]});
        check(
            "id, depth: $depth from tree follow children order by $depth, id",
            tree.clone(),
            json!([{ "id": "root", "depth": 1 }, { "id": "a", "depth": 2 }, { "id": "b", "depth": 2 }, { "id": "a1", "depth": 3 }]),
        );
        check(
            "id, stop: $stop from tree follow children { depth 2 } order by id",
            tree.clone(),
            json!([{ "id": "a", "stop": "depth" }, { "id": "b", "stop": "depth" }, { "id": "root", "stop": "interior" }]),
        );
        // The in-memory context names no identity: a plain object's `$key` is
        // its structural value, so the ordinal-sensitive walks project `$key: id`
        // in the destination block to rank paths by id (SEMANTICS §16, §20).
        check(
            "id, leaf: $leaf, frontier: $frontier, stop: $stop from tree follow children { $key: id } order by $ordinal",
            tree.clone(),
            json!([{ "id": "root", "leaf": false, "frontier": false, "stop": "interior" },
                   { "id": "a", "leaf": false, "frontier": false, "stop": "interior" },
                   { "id": "b", "leaf": true, "frontier": false, "stop": "leaf" },
                   { "id": "a1", "leaf": true, "frontier": false, "stop": "leaf" }]),
        );
        check(
            "id, o: $ordinal from tree follow children { $key: id } order by $ordinal",
            tree.clone(),
            json!([{ "id": "root", "o": 1 }, { "id": "a", "o": 2 }, { "id": "b", "o": 3 }, { "id": "a1", "o": 4 }]),
        );
        check(
            r#"id, s: $stop, f: $frontier, l: $leaf from tree follow children { $key: id frontier id == "a" } order by $ordinal"#,
            tree.clone(),
            json!([{ "id": "root", "s": "interior", "f": false, "l": false },
                   { "id": "a", "s": "frontier", "f": true, "l": false },
                   { "id": "b", "s": "leaf", "f": false, "l": true }]),
        );
        check(
            r#"id values from tree follow children { where id != "a" } order by $ordinal"#,
            tree.clone(),
            json!(["root", "b"]),
        );
        check(
            r#"id values from tree where id == "a" follow children order by $ordinal"#,
            tree.clone(),
            json!([]),
        );
        check(
            "id values from tree where $depth > 1 follow children { $key: id } order by $ordinal",
            tree.clone(),
            json!(["a", "b", "a1"]),
        );
        check(
            r#"id values from tree where id != "b" && $depth <= 2 follow children { $key: id } order by $ordinal"#,
            tree.clone(),
            json!(["root", "a", "b"]),
        );
        check(
            "id, kids: children collect { id, own: $depth, parentDepth: ^$depth } from tree follow children { $key: id depth 2 } order by $ordinal",
            tree.clone(),
            json!([{ "id": "root", "kids": [{ "id": "a", "parentDepth": 1 }, { "id": "b", "parentDepth": 1 }] },
                   { "id": "a", "kids": [{ "id": "a1", "parentDepth": 2 }] },
                   { "id": "b", "kids": [] }]),
        );
        check(
            r#"id, desc: children collect { $key: id values follow children { $key: id } order by $ordinal } from tree where id == "root""#,
            tree.clone(),
            json!([{ "id": "root", "desc": ["a", "b", "a1"] }]),
        );
        check(
            "label, stop: $stop from t follow children { $key: label } order by $ordinal",
            json!({ "t": [{ "label": "root", "children": [{ "label": "a" }, { "label": "b" }] }] }),
            json!([{ "label": "root", "stop": "interior" }, { "label": "a", "stop": "leaf" }, { "label": "b", "stop": "leaf" }]),
        );
        check_err(
            "id from tree where children exists { follow children }",
            tree,
            &["follow"],
        );
        // Path components compare as values: 9 < 10, numbers before strings,
        // strings by code point ("10" < "9"), then other kinds by canonical key.
        check(
            "id values from tree follow children { $key: id } order by $ordinal",
            json!({ "tree": [{ "id": 1, "children": [{ "id": 9 }, { "id": 10 }] }] }),
            json!([1, 9, 10]),
        );
        check(
            "id values from tree follow children { $key: id } order by $ordinal",
            json!({ "tree": [{ "id": 1, "children": [{ "id": "9" }, { "id": "10" }, { "id": 2 }] }] }),
            json!([1, 2, "10", "9"]),
        );
        check(
            "n values from tree follow children { $key: n } order by $ordinal",
            json!({ "tree": [{ "n": 1, "children": [{ "n": "s" }, { "n": true }, { "n": 2 }, { "n": false }] }] }),
            json!([1, 2, "s", false, true]),
        );
        // Id-less nodes have structural identity, so their components are the
        // rows themselves: all one kind, ordered by canonical key.
        check(
            "n values from tree follow children order by $ordinal",
            json!({ "tree": [{ "n": 1, "children": [{ "n": "s" }, { "n": true }, { "n": 2 }, { "n": false }] }] }),
            json!([1, 2, false, "s", true]),
        );
        // Cycles: a revisit is admitted once as `cycle`.
        let g = json!({ "n1": { "id": 1 } });
        let _ = g;
        let cyc = {
            // 1 -> 2 -> 1, expressed with nested duplicates (plain data has no references).
            json!({ "g": [{ "id": 1, "next": [{ "id": 2, "next": [{ "id": 1, "next": [{ "id": 2 }] }] }] }] })
        };
        // Keyed by `$key: id` in the body (seeds) and the destination block
        // (successors), the id-1 objects are one node.
        check(
            "id, stop: $stop, $key: id from g follow next { $key: id } order by $ordinal",
            cyc.clone(),
            json!([{ "id": 1, "stop": "interior", "$key": 1 }, { "id": 2, "stop": "interior", "$key": 2 }, { "id": 1, "stop": "cycle", "$key": 1 }]),
        );
        check(
            "id, $key: id from g follow distinct next { $key: id } order by id",
            cyc.clone(),
            json!([{ "id": 1, "$key": 1 }, { "id": 2, "$key": 2 }]),
        );
        check(
            "select distinct id from g follow next { $key: id } order by id",
            cyc,
            json!([{ "id": 1 }, { "id": 2 }]),
        );
        // Two paths → two occurrences; distinct keeps one.
        let diamond = json!({ "g": [{ "id": "root", "children": [
            { "id": "a", "children": [{ "id": "c" }] }, { "id": "b", "children": [{ "id": "c" }] }
        ]}]});
        check(
            "id, d: $depth from g follow children order by $ordinal",
            diamond.clone(),
            json!([{ "id": "root", "d": 1 }, { "id": "a", "d": 2 }, { "id": "b", "d": 2 }, { "id": "c", "d": 3 }, { "id": "c", "d": 3 }]),
        );
        check(
            "id, d: $depth from g follow distinct children order by $ordinal",
            diamond,
            json!([{ "id": "root", "d": 1 }, { "id": "a", "d": 2 }, { "id": "b", "d": 2 }, { "id": "c", "d": 3 }]),
        );
        // Hard cap 8.
        let mut chain = json!({ "id": 10 });
        for i in (1..10).rev() {
            chain = json!({ "id": i, "next": [chain] });
        }
        let c = json!({ "c": [chain] });
        check(
            "id values from c follow next",
            c.clone(),
            json!([1, 2, 3, 4, 5, 6, 7, 8]),
        );
        check(
            "id, s: $stop, f: $frontier from c follow next order by $ordinal offset 6",
            c,
            json!([{ "id": 7, "s": "interior", "f": false }, { "id": 8, "s": "depth", "f": true }]),
        );
        // A row without the relation is a leaf.
        check(
            "id, stop: $stop from xs follow next order by $ordinal",
            json!({ "xs": [{ "id": 1, "next": { "id": 2 } }] }),
            json!([{ "id": 1, "stop": "interior" }, { "id": 2, "stop": "leaf" }]),
        );
        // A follow seed keeps its $key.
        check(
            "id, root: $key from entries(forest) follow children { $key: id } order by $ordinal",
            json!({ "forest": { "left": { "id": "L", "children": [{ "id": "L1" }] }, "right": { "id": "R" } } }),
            json!([{ "id": "L", "root": "left" }, { "id": "R", "root": "right" }, { "id": "L1", "root": "L1" }]),
        );
        // Id-less nodes have structural identity: siblings are not "cycles".
        check(
            "n values from t follow kids order by $ordinal",
            json!({ "t": [{ "n": 1, "kids": [{ "n": 2 }, { "n": 3 }] }] }),
            json!([1, 2, 3]),
        );
    }

    #[test]
    fn body_from_chains_and_receivers() {
        check(
            "people collect { employer values from jobs where !end }",
            people(),
            json!(["Globocorp", "Globocorp"]),
        );
        check("people count { from jobs where end }", people(), json!(3));
        check(
            "name, n: $it collect { from jobs } from people where name == \"Bob\"",
            people(),
            json!([{ "name": "Bob", "n": [
                { "employer": "Globocorp", "start": "1984", "end": "1990" },
                { "employer": "Globocorp", "start": "2001" }
            ] }]),
        );
        // A free-function call may be a source.
        check("$it values from list(x)", json!({ "x": 5 }), json!([5]));
        check(
            "g: $key, big: $it collect { $it values where $it > 1 } from entries(groups)",
            json!({ "groups": { "a": [1, 2, 3], "b": [5] } }),
            json!([{ "g": "a", "big": [2, 3] }, { "g": "b", "big": [5] }]),
        );
    }

    #[test]
    fn where_trees_and_logical_values() {
        let r = json!({ "r": [{ "a": 1, "b": 0, "s": "" }, { "a": 0, "b": 2, "s": "x" }, {}] });
        check("a values from r where a || b", r.clone(), json!([1, 0]));
        check(
            "$it from r where !(a > 0) && !(b > 0)",
            r.clone(),
            json!([{ "$it": {} }]),
        );
        check(
            "$it values from r where !(a > 0) && !(b > 0)",
            r.clone(),
            json!([{}]),
        );
        check(
            "x: a && b, y: a || b, z: !a from r",
            r.clone(),
            json!([{ "x": 0, "y": 1, "z": false }, { "x": 0, "y": 2, "z": true }, { "z": true }]),
        );
        check("r count { where s }", r.clone(), json!(1));
        check("r count { where has(s) }", r, json!(2));
        // `&&` is strictly left to right and short-circuits — never reordered
        // around consumer tests, so a query can guard an operand by position.
        check(
            "r count { where false && bogus exists { where nope() } }",
            json!({ "r": [1] }),
            json!(0),
        );
        check_err(
            "r count { where true && ^bogus exists { where nope() } }",
            json!({ "r": [1], "bogus": [1] }),
            &["unknown function 'nope(…)'"],
        );
        check(
            "r count { where false && ^bogus exists { where nope() } }",
            json!({ "r": [1], "bogus": [1] }),
            json!(0),
        );
        check(
            "r exists { where xs none { } && foo(1) }",
            json!({ "r": [{ "xs": [1] }] }),
            json!(false),
        );
        check_err(
            "r exists { where xs exists { } && foo(1) }",
            json!({ "r": [{ "xs": [1] }] }),
            &["unknown function 'foo(…)'"],
        );
        check(
            "r exists { where has(s) && s.matches(\"(\") }",
            json!({ "r": [{}] }),
            json!(false),
        );
        check(
            "r exists { where xs exists { } || foo(1) }",
            json!({ "r": [{ "xs": [1] }] }),
            json!(true),
        );
        check_err(
            "from r where a.foo()",
            json!({ "r": [{ "a": 1 }] }),
            &["unknown method '.foo(…)'"],
        );
        // An empty source never evaluates the call.
        check("from r where foo(1)", json!({ "r": [] }), json!([]));
    }

    #[test]
    fn scalar_semantics_through_engine() {
        let r = json!({ "r": [1] });
        check(
            r#"x: 5 == "5", y: 0 == false, z: nope == null, w: nope != 5 from r"#,
            r.clone(),
            json!([{ "x": false, "y": false, "z": true, "w": true }]),
        );
        check(
            r#"x: "B" < "a", y: "10" < "9", z: 1 < "2", w: nope > 0 from r"#,
            r.clone(),
            json!([{ "x": true, "y": true, "z": false, "w": false }]),
        );
        check(
            r#"x: "n:" + 1 + 2, y: -7 % 3, z: 2.5 + 1, w: -(3) from r"#,
            r.clone(),
            json!([{ "x": "n:12", "y": -1, "z": 3.5, "w": -3 }]),
        );
        check(
            r#"x: 2 in xs, y: "b" in "abc", z: "k" in o, w: 3 in 1..5, v: 5 in 1...5 from r"#,
            json!({ "r": [{ "o": { "k": null }, "xs": [1, 2] }] }),
            json!([{ "x": true, "y": true, "z": true, "w": true, "v": false }]),
        );
        // Absent propagates through arithmetic and lower()/upper(); an absent
        // needle is never a substring or a key; an absent x is covered by no range.
        check(
            r#"a: nope + 1, b: "a" + nope, c: -nope, d: 1 + nope * 2, e: n + 1, f: nope.lower(), g: n.upper() from r"#,
            json!({ "r": [{ "n": null }] }),
            json!([{}]),
        );
        check(
            r#"a: nope + 1 == null, b: nope + 1 < 5, c: nope in "undefined null", d: nope in o, e: nope in ..5, f: true in 1.. from r"#,
            json!({ "r": [{ "o": { "undefined": 1, "null": 2 } }] }),
            json!([{ "a": true, "b": false, "c": false, "d": false, "e": false, "f": false }]),
        );
    }

    #[test]
    fn a_range_cannot_appear_in_a_result() {
        let r = json!({ "r": [{ "xs": [1] }] });
        for q in [
            "x: 1..5 from r",
            "1..5 values from r",
            "x: range(\"1..5\") from r",
            "x: list(1..5) from r",
            "n: xs collect { 1..2 values } from r",
            "r first { x: 1.. }",
            "from list(1..5)",
        ] {
            check_err(q, r.clone(), &["range", "cannot appear in a result"]);
        }
        // Ranges are fine everywhere else: as an `in` haystack, as an argument.
        check(
            "x: 3 in 1..5, y: 3 in range(\"1..5\") from r",
            r.clone(),
            json!([{ "x": true, "y": true }]),
        );
        check("r count { where 1..5 }", r, json!(1));
    }

    #[test]
    fn matches_dialect_errors_surface_through_the_engine() {
        check_err(
            r#"r exists { where "ab".matches("a(?=b)") }"#,
            json!({ "r": [{}] }),
            &["not supported in OQX", "lookahead"],
        );
        check_err(
            r#"r exists { where "a".matches("(") }"#,
            json!({ "r": [{}] }),
            &["invalid regular expression"],
        );
        // An empty source never evaluates the pattern.
        check(
            r#"r exists { where "ab".matches("a(?=b)") }"#,
            json!({ "r": [] }),
            json!(false),
        );
        check(
            r#"r exists { where "(?=".matches("\\(\\?=") }"#,
            json!({ "r": [{}] }),
            json!(true),
        );
    }

    #[test]
    fn bindings() {
        check_eq_t(
            &["name values from ", " where employer == ", ""],
            vec![
                json!([{ "name": "a", "employer": "G" }, { "name": "b", "employer": "I" }]),
                json!("G"),
            ],
            json!(["a"]),
        );
        check_eq_t(
            &["name values from people where city in ", ""],
            vec![json!(["SF", "LA"])],
            json!(["Alice"]),
        );
        check_eq_t(
            &["name values from people limit ", ""],
            vec![json!(1)],
            json!(["Bob"]),
        );
        check_eq_t(
            &["name values from people where age in ", "..", ""],
            vec![json!(40), json!(50)],
            json!(["Bob"]),
        );
        check_eq_t(
            &["name values from people where nick == ", ""],
            vec![json!(null)],
            json!(["Bob", "Alice", "Carol"]),
        );
        check_eq_t(&["", " count { }"], vec![json!({ "a": 1 })], json!(1));
        check_eq_t(
            &["", " first { $it values }"],
            vec![json!([7, 8])],
            json!(7),
        );
        // Out-of-range binding index is an eval error (only reachable with a hand-built AST).
        let q = parse_template(&["from ", ""], 1).unwrap();
        let err = run_query(&q, &[], Object::new()).unwrap_err();
        assert_eq!(err.stage, crate::Stage::Eval);
        assert!(err.message.contains("out of range"), "{err}");
    }

    fn check_eq_t(fragments: &[&str], values: Vec<serde_json::Value>, expect: serde_json::Value) {
        let got =
            run_t(fragments, values, people()).unwrap_or_else(|e| panic!("{fragments:?}: {e}"));
        let want = v(expect);
        assert!(
            equals(&got, &want),
            "{fragments:?}\n   got: {got:?}\n  want: {want:?}"
        );
    }

    #[test]
    fn engine_trait_and_result_shapes() {
        let q = parse_string("people count { where active }").unwrap();
        let eng = InMemoryEngine::new(DefaultContext::new(roots(people())));
        assert_eq!(eng.run(&q, &[]).unwrap(), OqxResult::Count(2.0));
        assert_eq!(eng.context().roots().len(), 1);
        let q = parse_string("people exists { where age > 90 }").unwrap();
        assert_eq!(eng.run(&q, &[]).unwrap(), OqxResult::Exists(false));
        let q = parse_string("people none { where age > 90 }").unwrap();
        assert_eq!(eng.run(&q, &[]).unwrap(), OqxResult::None(true));
        let q = parse_string("people first { where age > 90 }").unwrap();
        assert_eq!(eng.run(&q, &[]).unwrap(), OqxResult::First(None));
        let q = parse_string("people single { name values where age > 50 }").unwrap();
        assert_eq!(
            eng.run(&q, &[]).unwrap(),
            OqxResult::Single(Some(Value::from("Alice")))
        );
        // Projected absent property is `Undefined` (dropped by canonicalization).
        let q = parse_string("nope from r").unwrap();
        let got = run_query(&q, &[], roots(json!({ "r": [1] }))).unwrap();
        let mut o = Object::new();
        o.insert("nope", Value::Undefined);
        assert_eq!(got, OqxResult::Collect(vec![Value::Object(o)]));
    }

    #[test]
    fn json_string_matches_json_stringify() {
        assert_eq!(json_string(&Value::Undefined), "null");
        assert_eq!(json_string(&Value::Number(1.5)), "1.5");
        assert_eq!(json_string(&Value::Number(-0.0)), "0");
        assert_eq!(json_string(&Value::Str("a\"b\n".into())), "\"a\\\"b\\n\"");
        let mut o = Object::new();
        o.insert("a", Value::Undefined);
        o.insert("b", Value::Array(vec![Value::Undefined, Value::Bool(true)]));
        assert_eq!(json_string(&Value::Object(o)), "{\"b\":[null,true]}");
    }

    #[test]
    fn template_literals_concatenate_string_forms() {
        let r = json!({ "p": [
            { "title": "Ars Magna", "era": 1545, "ok": true, "ratio": 2.5, "neg": -0.0, "big": 1e21,
              "none": null, "tags": ["a", "b"], "meta": { "k": 1 }, "n": 3 }
        ] });
        check(
            "select s: `${title} (${era})` from p",
            r.clone(),
            json!([{ "s": "Ars Magna (1545)" }]),
        );
        // Numbers and booleans take their `+` string form (an integer-valued
        // double without a fraction, `-0` as `0`, JS exponent form).
        check(
            "`${ok}|${ratio}|${neg}|${big}|${n * 2}` values from p",
            r.clone(),
            json!(["true|2.5|0|1e+21|6"]),
        );
        // Text only, empty, adjacent interpolations, a nested template, a block.
        check("`plain` values from p", r.clone(), json!(["plain"]));
        check("`` values from p", r.clone(), json!([""]));
        check(
            "`${title}${era}` values from p",
            r.clone(),
            json!(["Ars Magna1545"]),
        );
        check(
            "`<${`${title}!`}>` values from p",
            r.clone(),
            json!(["<Ars Magna!>"]),
        );
        check(
            "`${size(tags)} tags: ${tags first { }}` values from p",
            r.clone(),
            json!(["2 tags: a"]),
        );
        // Escapes decode; a newline stands verbatim.
        check(
            "`\\`${title}\\` \\${x} \\\\\nend` values from p",
            r.clone(),
            json!(["`Ars Magna` ${x} \\\nend"]),
        );
        // The same text as the `+` rule produces.
        check(
            "p exists { `${title} (${era})` == title + \" (\" + era + \")\" }",
            r.clone(),
            json!(true),
        );
        // A template is a value everywhere: where, order by, a call argument, in.
        check(
            "select n: size(`${title}`) from p where `${era}` == \"1545\" order by `${title}`",
            r.clone(),
            json!([{ "n": 9 }]),
        );
        check(
            "p exists { \"Magna\" in `${title}` }",
            r.clone(),
            json!(true),
        );
        check(
            "`${title}`.lower() values from p",
            r.clone(),
            json!(["ars magna"]),
        );
        // A binding is a value, never source text: it cannot stand inside the
        // literal (the fragment ends inside it), but a bound string compares
        // equal to the template's result.
        let e = run_t(&["`${", "}` values from p"], vec![json!("x")], r.clone()).unwrap_err();
        assert_eq!(e.stage, crate::Stage::Lex);
        let e = run_t(&["`", "` values from p"], vec![json!("x")], r.clone()).unwrap_err();
        assert!(
            e.message.contains("binding cannot stand inside"),
            "{}",
            e.message
        );
        assert_eq!(
            run_t(
                &["`${title}` == ", " values from p"],
                vec![json!("Ars Magna")],
                r.clone()
            )
            .unwrap(),
            v(json!([true]))
        );
    }

    #[test]
    fn template_literals_are_absent_on_an_absent_interpolation_and_refuse_collections() {
        let r = json!({ "p": [
            { "title": "T", "none": null, "tags": ["a", "b"], "meta": { "k": 1 } }
        ] });
        // Absent anywhere → absent (the `+` string rule): null and a missing field.
        check("`${title}${none}` values from p", r.clone(), json!([null]));
        check("`a${missing}b` values from p", r.clone(), json!([null]));
        check("select s: `${missing}` from p", r.clone(), json!([{}]));
        check("p exists { `${missing}` == null }", r.clone(), json!(true));
        // A list, a record or a range is an eval error, not a stringification.
        check_err(
            "`${tags}` values from p",
            r.clone(),
            &[
                "cannot interpolate `${tags}` in a template literal: it is a list — only a string, a number, a boolean or an absent value has a string form",
            ],
        );
        check_err(
            "`${meta}` values from p",
            r.clone(),
            &["cannot interpolate `${meta}` in a template literal: it is a record"],
        );
        check_err(
            "`${1..5}` values from p",
            r.clone(),
            &["cannot interpolate `${1..5}` in a template literal: it is a range"],
        );
        check_err(
            "`${tags collect { }}` values from p",
            r.clone(),
            &["it is a list"],
        );
        // Every interpolation is evaluated, so the error surfaces after an
        // absent piece too; a later eval error does as well.
        check_err(
            "`${none}${tags}` values from p",
            r.clone(),
            &["it is a list"],
        );
        check_err(
            "`${none}${title.nope()}` values from p",
            r.clone(),
            &["nope"],
        );
    }
}
