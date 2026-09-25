//! The tier-1 in-memory engine: evaluates a parsed [`Query`] against a
//! [`DataContext`]. Port of `packages/oqx/src/engine.ts`.
//!
//! Optimizations over a naive walk, as in the reference: `exists` short-circuits
//! at the first match; `first`/`single` stop early when the result is unordered;
//! `count` never materializes rows; and within an `&&` the cheap scalar leaves
//! are evaluated before expensive consumer-op leaves (which each drive a nested
//! traversal).
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
//! ones: when a source, body-level `from`, directive receiver, or `follow`
//! relation is literally `entries(x)`. A data row that merely looks like
//! `{ key, value }` is therefore never unwrapped, and `entries(x)` in value
//! position (projected, or as an argument) is the plain array of `{ key, value }`
//! records the builtin returns.

use std::cell::RefCell;
use std::cmp::Ordering;

use crate::Result;
use crate::ast::{
    Consumer, CountCmp, Expr, Follow, LogicalOp, OpNode, OrderSpec, Query, SelectItem, Subquery,
    UnaryOp, Where,
};
use crate::context::{DataContext, DefaultContext};
use crate::errors::OqxError;
use crate::semantics::{
    arith, compare_for_sort_dir, entries_of, equals, make_range, membership, relate, to_number,
};
use crate::value::{Object, Value, js_number_to_string};

/// A query's result, shaped by its consumer. [`OqxResult::into_value`] gives
/// the consumer-shaped plain value the tagged-template API and the spec
/// fixtures observe.
#[derive(Clone, Debug, PartialEq)]
pub enum OqxResult {
    Collect(Vec<Value>),
    Exists(bool),
    None(bool),
    Count(f64),
    First(Option<Value>),
    Single(Option<Value>),
}

impl OqxResult {
    pub fn consumer(&self) -> Consumer {
        match self {
            OqxResult::Collect(_) => Consumer::Collect,
            OqxResult::Exists(_) => Consumer::Exists,
            OqxResult::None(_) => Consumer::None,
            OqxResult::Count(_) => Consumer::Count,
            OqxResult::First(_) => Consumer::First,
            OqxResult::Single(_) => Consumer::Single,
        }
    }

    /// The consumer-shaped result: an array for `collect`, a boolean for
    /// `exists`/`none`, a number for `count`, the row or `Null` for
    /// `first`/`single`.
    pub fn into_value(self) -> Value {
        match self {
            OqxResult::Collect(rows) => Value::Array(rows),
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
}

impl<C: DataContext> InMemoryEngine<C> {
    pub fn new(ctx: C) -> Self {
        Self { ctx }
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
        }
        .run(query)
    }
}

/// Run a parsed query with bindings over plain-value named roots.
pub fn run_query(query: &Query, bindings: &[Value], roots: Object) -> Result<OqxResult> {
    InMemoryEngine::new(DefaultContext::new(roots)).run(query, bindings)
}

// ---- internal machinery -----------------------------------------------------

const RECUR: &[&str] = &["$depth", "$stop", "$leaf", "$frontier", "$ordinal"];
const KEY: &str = "$key";
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
}

/// One query scope: the row under evaluation plus the chain of enclosing scopes
/// that `^` walks. The root scope (`parent == None`) has no row; its names are
/// the context's named roots. `lifts` holds values bound INTO this scope by
/// `^name:` items in nested blocks (a `RefCell` because the binding happens
/// while the scope is borrowed by the `where` being evaluated); `meta` holds
/// the scope's intrinsics: recursion metadata for a follow occurrence, and
/// `$key` for an entry scope.
struct Scope<'p> {
    row: Value,
    parent: Option<&'p Scope<'p>>,
    lifts: RefCell<Object>,
    meta: Option<Object>,
}

impl<'p> Scope<'p> {
    fn root() -> Self {
        Scope {
            row: Value::Undefined,
            parent: None,
            lifts: RefCell::new(Object::new()),
            meta: None,
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

/// A walked occurrence before ranking: the identity key, the `/`-joined path of
/// identity string forms, and the categorical stop reason.
struct Walked {
    row: Row,
    depth: u32,
    path: String,
    key: Value,
    stop: &'static str,
}

/// One run: the context plus the positional bindings.
struct Exec<'e, C: DataContext> {
    ctx: &'e C,
    bindings: &'e [Value],
}

impl<C: DataContext> Exec<'_, C> {
    fn run(&self, query: &Query) -> Result<OqxResult> {
        let root = Scope::root();
        let mut rows = self.rows_of_expr(&query.source, &root)?;
        for proj in &query.from {
            rows = self.reproject(rows, proj, &root)?;
        }

        let bound = self.bound_of(query.limit.as_ref(), query.offset.as_ref(), &root)?;
        if let Some(follow) = &query.follow {
            return self.run_follow(query, follow, rows, &root, bound);
        }

        // Consumer-directed short-circuits (skipped under `distinct`, which must
        // materialize + dedup by projection before reducing). Counting never
        // materializes rows; exists/none stop as soon as the bound is known to be
        // non-empty (the (offset+1)th match — or the first, when unbounded).
        if !query.distinct
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

        // first/single over an unordered, non-distinct set need only the rows up
        // to the bound: offset + 1 (first) / offset + 2 (single, to detect a second).
        let want = match query.consumer {
            Consumer::First => Some(1usize),
            Consumer::Single => Some(2usize),
            _ => None,
        };
        let cap = match want {
            Some(w) if query.order_by.is_none() && !query.distinct => {
                Some(bound.offset.saturating_add(w.min(bound.limit.unwrap_or(w))))
            }
            _ => None,
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
        let proj = Projection::from(query);
        kept = self.sort_scopes(kept, query.order_by.as_deref())?;
        if query.distinct {
            kept = self.dedup_by_projection(kept, proj)?;
        }
        let kept = slice_bound(kept, bound);
        self.shape(query.consumer, &kept, proj)
    }

    // Evaluate a block's `limit`/`offset`. The bound is part of the block, so it
    // is read in a row-less scope INSIDE it: a bare name is absent (there is no
    // current item yet), `^name` is the enclosing row — exactly as in the
    // block's body — and literals/bindings are themselves. For a top-level
    // query `enclosing` is the root, which is used as-is. Each must be a
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
        let inner;
        let scope: &Scope<'_> = if enclosing.is_root() {
            enclosing
        } else {
            inner = Scope {
                row: Value::Undefined,
                parent: Some(enclosing),
                lifts: RefCell::new(Object::new()),
                meta: None,
            };
            &inner
        };
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
    /// `from`, a directive receiver, a `follow` relation). `entries(x)` here
    /// yields keyed rows — the reference's tagged entries — see the module docs.
    fn rows_of_expr(&self, e: &Expr, scope: &Scope<'_>) -> Result<Vec<Row>> {
        if let Expr::Call {
            recv: None,
            name,
            args,
        } = e
        {
            if name == "entries" {
                let mut vals = Vec::with_capacity(args.len());
                for a in args {
                    vals.push(self.eval_expr(a, scope)?);
                }
                let target = vals.into_iter().next().unwrap_or(Value::Undefined);
                return Ok(entries_of(&target)
                    .into_iter()
                    .map(|en| Row {
                        value: en.value,
                        key: Some(en.key),
                    })
                    .collect());
            }
        }
        let v = self.eval_expr(e, scope)?;
        Ok(self.ctx.to_rows(&v).into_iter().map(Row::plain).collect())
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
    // is the property's VALUE (so `$value` and bare names read it) and the key
    // becomes the `$key` intrinsic in `meta`. Every place a row becomes a scope
    // goes through this, so entries behave the same at the top level, in nested
    // blocks, as `from` re-projections, and as follow seeds.
    fn enter<'p>(&self, row: Row, parent: &'p Scope<'p>, meta: Option<Object>) -> Scope<'p> {
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
        }
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
        let occ = self.follow_walk(seeds, follow, root)?;
        let mut scopes: Vec<Scope<'_>> = Vec::with_capacity(occ.len());
        for o in occ {
            let s = self.enter(o.row, root, Some(o.meta));
            if post.is_empty() || self.eval_conjuncts(&post, &s)? {
                scopes.push(s);
            }
        }
        let proj = Projection::from(query);
        scopes = self.sort_scopes(scopes, query.order_by.as_deref())?;
        if query.distinct {
            scopes = self.dedup_by_projection(scopes, proj)?;
        }
        let scopes = slice_bound(scopes, bound);
        self.shape(query.consumer, &scopes, proj)
    }

    // Dedup scopes by their PROJECTED value (`distinct`): keep the first scope
    // per distinct projection, preserving order. An empty projection dedups by
    // row identity (so `count distinct { }` counts distinct rows). Keys compare
    // with the scalar layer's structural `equals` (absent ≡ null, key order
    // ignored), which is what the reference's stable stringify achieves.
    fn dedup_by_projection<'p>(
        &self,
        scopes: Vec<Scope<'p>>,
        proj: Projection<'_>,
    ) -> Result<Vec<Scope<'p>>> {
        let mut seen: Vec<Value> = Vec::new();
        let mut out = Vec::new();
        for s in scopes {
            let key = if proj.select.is_empty() {
                self.ctx.identity(&s.row)
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
    // metadata: `$depth` (seed = 1), a categorical `$stop`, and a deterministic
    // `$ordinal`. Semantics:
    //   • per-path — a node reached by N distinct paths yields N occurrences
    //     (unless `distinct`, which keeps the minimal (depth, path) per identity);
    //   • cycles are safe — revisiting a key already on the current path admits
    //     ONE occurrence with `$stop == "cycle"` and does not expand it;
    //   • `$stop` ∈ interior | leaf | frontier | depth | cycle, with precedence
    //     cycle > frontier > depth > leaf > interior; only `interior` rows expand;
    //   • `$leaf` = (stop == leaf); `$frontier` = (stop ∈ {frontier, depth});
    //   • identity for cycle detection + `distinct` is `by <expr>` when given,
    //     else `ctx.identity(row)` — compared structurally, not by string form.
    fn follow_walk(
        &self,
        seeds: Vec<Row>,
        follow: &Follow,
        parent: &Scope<'_>,
    ) -> Result<Vec<Occurrence>> {
        let cap = follow.depth.unwrap_or(HARD_DEPTH_CAP);
        let mut walked: Vec<Walked> = Vec::new();
        let mut ancestors: Vec<Value> = Vec::new();
        let mut path_parts: Vec<String> = Vec::new();
        for r in seeds {
            self.follow_visit(
                follow,
                parent,
                cap,
                r,
                1,
                &mut ancestors,
                &mut path_parts,
                &mut walked,
            )?;
        }

        let mut rows = walked;
        if follow.distinct {
            // keep the minimal (depth, path) occurrence per identity key.
            let mut best: Vec<Walked> = Vec::new();
            for w in rows {
                match best.iter_mut().find(|b| equals(&b.key, &w.key)) {
                    None => best.push(w),
                    Some(prev) => {
                        if w.depth < prev.depth || (w.depth == prev.depth && w.path < prev.path) {
                            *prev = w;
                        }
                    }
                }
            }
            rows = best;
        }
        // $ordinal: a deterministic 1..N rank over (depth, path). Paths compare
        // as text (code-point order), which a fixture pins.
        rows.sort_by(|a, b| a.depth.cmp(&b.depth).then_with(|| a.path.cmp(&b.path)));
        Ok(rows
            .into_iter()
            .enumerate()
            .map(|(i, w)| {
                let mut meta = Object::with_capacity(5);
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

    #[allow(clippy::too_many_arguments)]
    fn follow_visit(
        &self,
        follow: &Follow,
        parent: &Scope<'_>,
        cap: u32,
        row: Row,
        depth: u32,
        ancestors: &mut Vec<Value>,
        path_parts: &mut Vec<String>,
        walked: &mut Vec<Walked>,
    ) -> Result<()> {
        let key = match &follow.by {
            Some(by) => self.eval_expr(by, &self.enter(row.clone(), parent, None))?,
            None => self.ctx.identity(&row.value),
        };
        let key_text = path_component(&key);
        let path = {
            let mut p = String::from("/");
            for part in path_parts.iter() {
                p.push_str(part);
                p.push('/');
            }
            p.push_str(&key_text);
            p.push('/');
            p
        };
        let stop: &'static str;
        if ancestors.iter().any(|a| equals(a, &key)) {
            stop = "cycle";
        } else if self.frontier_hit(follow, &row, parent)? {
            stop = "frontier";
        } else if depth >= cap {
            stop = "depth";
        } else {
            let succ = self.successors_of(follow, &row, parent)?;
            if succ.is_empty() {
                stop = "leaf";
            } else {
                walked.push(Walked {
                    row,
                    depth,
                    path,
                    key: key.clone(),
                    stop: "interior",
                });
                ancestors.push(key);
                path_parts.push(key_text);
                for s in succ {
                    self.follow_visit(
                        follow,
                        parent,
                        cap,
                        s,
                        depth + 1,
                        ancestors,
                        path_parts,
                        walked,
                    )?;
                }
                ancestors.pop();
                path_parts.pop();
                return Ok(());
            }
        }
        walked.push(Walked {
            row,
            depth,
            path,
            key,
            stop,
        });
        Ok(())
    }

    fn frontier_hit(&self, follow: &Follow, row: &Row, parent: &Scope<'_>) -> Result<bool> {
        match &follow.frontier {
            None => Ok(false),
            Some(f) => Ok(self
                .eval_expr(f, &self.enter(row.clone(), parent, None))?
                .truthy()),
        }
    }

    fn successors_of(&self, follow: &Follow, row: &Row, parent: &Scope<'_>) -> Result<Vec<Row>> {
        let raw = self.rows_of_expr(&follow.receiver, &self.enter(row.clone(), parent, None))?;
        let Some(w) = &follow.r#where else {
            return Ok(raw);
        };
        let mut out = Vec::with_capacity(raw.len());
        for x in raw {
            if self
                .eval_expr(w, &self.enter(x.clone(), parent, None))?
                .truthy()
            {
                out.push(x);
            }
        }
        Ok(out)
    }

    // ---- consumer shaping ---------------------------------------------------

    fn shape(
        &self,
        consumer: Consumer,
        scopes: &[Scope<'_>],
        proj: Projection<'_>,
    ) -> Result<OqxResult> {
        Ok(match consumer {
            Consumer::Exists => OqxResult::Exists(!scopes.is_empty()),
            Consumer::None => OqxResult::None(scopes.is_empty()),
            Consumer::Count => OqxResult::Count(scopes.len() as f64),
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
    // value itself (`values` mode), or a `{ name: value }` record.
    fn project_row(&self, proj: Projection<'_>, scope: &Scope<'_>) -> Result<Value> {
        let select = proj.select;
        if select.is_empty() {
            return Ok(scope.row.clone());
        }
        if proj.values {
            return self.item_value(&select[0], scope);
        }
        let mut out = Object::with_capacity(select.len());
        for item in select {
            out.insert(item.name(), self.item_value(item, scope)?);
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
            Where::And { parts } => {
                let refs: Vec<&Where> = parts.iter().collect();
                self.eval_conjuncts(&refs, scope)
            }
            Where::Or { parts } => {
                for p in parts {
                    if self.eval_where(p, scope)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Where::Not { expr } => Ok(!self.eval_where(expr, scope)?),
            Where::Scalar { expr } => Ok(self.eval_expr(expr, scope)?.truthy()),
            Where::Op(op) => self.eval_where_op(op, scope),
        }
    }

    /// An `&&` over `parts`: cheap scalar leaves run before consumer-op leaves
    /// (a stable sort by cost, as the reference's `orderByCost`), and the first
    /// false conjunct short-circuits. Empty is true.
    fn eval_conjuncts(&self, parts: &[&Where], scope: &Scope<'_>) -> Result<bool> {
        let mut ordered: Vec<&Where> = parts.to_vec();
        ordered.sort_by_key(|w| where_cost(w));
        for p in ordered {
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
        let bound = self.bound_of(op.sub.limit.as_ref(), op.sub.offset.as_ref(), scope)?;
        match op.op {
            Consumer::Exists | Consumer::None => {
                // Unbounded: stop at the first match (dedup cannot change
                // emptiness). Bounded: the offset/limit decide emptiness, so
                // materialize the set.
                let any = if bound == UNBOUNDED {
                    !self.match_rows(op, scope, Some(1))?.is_empty()
                } else {
                    !self.op_rows(op, scope, bound)?.is_empty()
                };
                Ok(if op.op == Consumer::Exists { any } else { !any })
            }
            Consumer::Collect => {
                let matched = self.op_rows(op, scope, bound)?;
                for item in &op.sub.select {
                    let SelectItem::Field { name, expr, lift } = item else {
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
            Consumer::Count => {
                let n = self.op_rows(op, scope, bound)?.len();
                match &op.count_cmp {
                    Some(cmp) => compare_count(n, cmp),
                    None => Ok(n > 0),
                }
            }
            Consumer::First | Consumer::Single => Ok(!self.op_rows(op, scope, bound)?.is_empty()),
        }
    }

    // The rows a consumer op reduces: matched → ordered → distinct → bounded.
    fn op_rows<'p>(
        &self,
        op: &OpNode,
        scope: &'p Scope<'p>,
        bound: Bound,
    ) -> Result<Vec<Scope<'p>>> {
        let mut scopes = self.match_rows(op, scope, None)?;
        scopes = self.sort_scopes(scopes, op.sub.order_by.as_deref())?;
        if op.distinct {
            scopes = self.dedup_by_projection(scopes, Projection::from(&op.sub))?;
        }
        Ok(slice_bound(scopes, bound))
    }

    /// The receiver's rows, re-projected by the block's `from` chain, entered
    /// as scopes under `scope`, filtered by the block's `where`. `stop_after`
    /// caps how many matches are collected (the `exists` short-circuit).
    fn match_rows<'p>(
        &self,
        op: &OpNode,
        scope: &'p Scope<'p>,
        stop_after: Option<usize>,
    ) -> Result<Vec<Scope<'p>>> {
        let mut rows = self.rows_of_expr(&op.receiver, scope)?;
        for proj in &op.sub.from {
            rows = self.reproject(rows, proj, scope)?;
        }
        let mut out = Vec::new();
        for r in rows {
            let s = self.enter(r, scope, None);
            let keep = match &op.sub.r#where {
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

    // A select-position collect/first/single, optionally recursive via `follow`.
    fn eval_collect_value(&self, op: &OpNode, scope: &Scope<'_>) -> Result<Value> {
        let sub = &op.sub;
        let bound = self.bound_of(sub.limit.as_ref(), sub.offset.as_ref(), scope)?;
        let proj = Projection::from(sub);
        let scopes: Vec<Scope<'_>> = if let Some(follow) = &sub.follow {
            let mut rows = self.rows_of_expr(&op.receiver, scope)?;
            for p in &sub.from {
                rows = self.reproject(rows, p, scope)?;
            }
            let mut seeds = Vec::new();
            for r in rows {
                let keep = match &sub.r#where {
                    None => true,
                    Some(w) => self.eval_where(w, &self.enter(r.clone(), scope, None))?,
                };
                if keep {
                    seeds.push(r);
                }
            }
            let occ = self.follow_walk(seeds, follow, scope)?;
            let mut scopes: Vec<Scope<'_>> = occ
                .into_iter()
                .map(|o| self.enter(o.row, scope, Some(o.meta)))
                .collect();
            scopes = self.sort_scopes(scopes, sub.order_by.as_deref())?;
            if op.distinct {
                scopes = self.dedup_by_projection(scopes, proj)?;
            }
            slice_bound(scopes, bound)
        } else {
            self.op_rows(op, scope, bound)?
        };
        match op.op {
            Consumer::Collect => Ok(Value::Array(self.project_all(proj, &scopes)?)),
            Consumer::First => match scopes.first() {
                Some(s) => self.project_row(proj, s),
                None => Ok(Value::Null),
            },
            Consumer::Single => {
                if scopes.len() > 1 {
                    return Err(OqxError::eval(format!(
                        "single {{ … }} for '{}' matched {} rows",
                        describe_receiver(&op.receiver),
                        scopes.len()
                    )));
                }
                match scopes.first() {
                    Some(s) => self.project_row(proj, s),
                    None => Ok(Value::Null),
                }
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

    fn eval_expr(&self, e: &Expr, scope: &Scope<'_>) -> Result<Value> {
        match e {
            Expr::Lit(v) => Ok(v.clone()),
            Expr::Binding { index } => self.bindings.get(*index).cloned().ok_or_else(|| {
                OqxError::eval(format!(
                    "binding ${{{index}}} is out of range ({} bound)",
                    self.bindings.len()
                ))
            }),
            Expr::Ident { name } => Ok(self.resolve_in(name, scope)),
            Expr::Outer { levels, name } => {
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
                Ok(match s {
                    Some(sc) => self.resolve_in(name, sc),
                    None => Value::Undefined,
                })
            }
            Expr::Member { recv, name } => {
                let r = self.eval_expr(recv, scope)?;
                Ok(if r.is_absent() {
                    Value::Undefined
                } else {
                    self.ctx.get(&r, name)
                })
            }
            Expr::Index { recv, index } => {
                let r = self.eval_expr(recv, scope)?;
                let i = self.eval_expr(index, scope)?;
                Ok(if r.is_absent() {
                    Value::Undefined
                } else {
                    self.ctx.get(&r, &i.to_string())
                })
            }
            Expr::Call { recv, name, args } => self.eval_call(recv.as_deref(), name, args, scope),
            Expr::Unary { op, expr } => {
                let v = self.eval_expr(expr, scope)?;
                Ok(match op {
                    UnaryOp::Not => Value::Bool(!v.truthy()),
                    UnaryOp::Neg => Value::Number(-to_number(&v)),
                })
            }
            Expr::Binary { op, left, right } => {
                let l = self.eval_expr(left, scope)?;
                let r = self.eval_expr(right, scope)?;
                if op.is_comparison() {
                    Ok(Value::Bool(relate(op.as_str(), &l, &r)?))
                } else {
                    arith(op.as_str(), &l, &r)
                }
            }
            Expr::Logical { op, left, right } => {
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
            Expr::In { left, right } => {
                let l = self.eval_expr(left, scope)?;
                let r = self.eval_expr(right, scope)?;
                Ok(Value::Bool(membership(&l, &r)))
            }
            Expr::Range {
                lo,
                hi,
                exclusive_end,
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
        }
    }

    // Resolve a name against ONE scope — never its ancestors. A scope provides,
    // in order: `$value` (the scope's row itself — the current item, whatever
    // its type, so scalar collections are queryable; absent at the root, which
    // has no row); `$key` (the property key, for an entry scope only); the
    // recursion intrinsics (`$depth`, …) when it is a follow occurrence; values
    // lifted into it by `^name:` items; then either the row's own property or,
    // for the root scope (no row), the context's named roots.
    //
    // A name the scope lacks is simply absent. It does NOT fall through to an
    // enclosing scope, so a query's meaning never depends on which properties an
    // inner row happens to have. Present-but-falsy values need no special case —
    // there is no "absent, so look outward" rule.
    fn resolve_in(&self, name: &str, scope: &Scope<'_>) -> Value {
        if name == "$value" {
            return if scope.is_root() {
                Value::Undefined
            } else {
                scope.row.clone()
            };
        }
        if name == KEY || RECUR.contains(&name) {
            return scope
                .meta
                .as_ref()
                .and_then(|m| m.get(name).cloned())
                .unwrap_or(Value::Undefined);
        }
        if let Some(v) = scope.lifts.borrow().get(name) {
            return v.clone();
        }
        if scope.is_root() {
            return self.ctx.root(name);
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
                match self.ctx.call_method(name, &recv, &vals) {
                    Some(r) => r,
                    None => Err(OqxError::eval(format!("unknown method '.{name}(…)'"))),
                }
            }
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

// Cost of a where node, so `&&` conjuncts run cheap scalar leaves first.
fn where_cost(w: &Where) -> u8 {
    match w {
        Where::Op(_) => 2,
        Where::And { parts } | Where::Or { parts } => {
            parts.iter().map(where_cost).max().unwrap_or(0)
        }
        Where::Not { expr } => where_cost(expr),
        Where::Scalar { .. } => 0,
    }
}

fn describe_receiver(e: &Expr) -> String {
    match e {
        Expr::Ident { name } => name.clone(),
        Expr::Member { recv, name } => format!("{}.{name}", describe_receiver(recv)),
        Expr::Binding { index } => format!("${{{index}}}"),
        _ => "receiver".to_owned(),
    }
}

/// Split a `follow` query's `where` into the conjuncts that select seeds (no
/// recursion intrinsic mentioned) and those applied to the walked occurrences.
fn partition_recur(w: &Where) -> (Vec<&Where>, Vec<&Where>) {
    let parts: Vec<&Where> = match w {
        Where::And { parts } => parts.iter().collect(),
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
        Where::And { parts } | Where::Or { parts } => parts.iter().any(where_has_recur),
        Where::Not { expr } => where_has_recur(expr),
        Where::Scalar { expr } => expr_has_recur(expr),
        Where::Op(_) => false,
    }
}

fn expr_has_recur(e: &Expr) -> bool {
    match e {
        Expr::Ident { name } => RECUR.contains(&name.as_str()),
        Expr::Member { recv, .. } => expr_has_recur(recv),
        Expr::Index { recv, index } => expr_has_recur(recv) || expr_has_recur(index),
        Expr::Call { recv, args, .. } => {
            recv.as_deref().is_some_and(expr_has_recur) || args.iter().any(expr_has_recur)
        }
        Expr::Unary { expr, .. } => expr_has_recur(expr),
        Expr::Binary { left, right, .. }
        | Expr::Logical { left, right, .. }
        | Expr::In { left, right } => expr_has_recur(left) || expr_has_recur(right),
        Expr::Range { lo, hi, .. } => {
            lo.as_deref().is_some_and(expr_has_recur) || hi.as_deref().is_some_and(expr_has_recur)
        }
        Expr::Lit(_) | Expr::Binding { .. } | Expr::Outer { .. } => false,
    }
}

/// The string form of an identity as a `follow` path component. Scalars use
/// `String(v)` as the reference does; structural (object/array) identities,
/// which the reference collapses to `[object Object]`, use their canonical JSON
/// so distinct identities stay distinct in the path.
fn path_component(v: &Value) -> String {
    match v {
        Value::Object(_) | Value::Array(_) => json_string(v),
        other => other.to_string(),
    }
}

/// `JSON.stringify` of a value: an `Undefined` property is dropped, an
/// `Undefined` element or top-level value is `null`, non-finite numbers are
/// `null`, and keys are in insertion order. Used for error messages and path
/// components.
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
    use crate::parser::{parse_string, parse_template};
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
            "$value values from scores where $value > 50",
            scores.clone(),
            json!([60, 70]),
        );
        check(
            "$value values from scores order by $value desc",
            scores,
            json!([70, 60, 45, 10]),
        );
        check(
            "name, big: scores collect { $value values where $value > 50 } from players",
            json!({ "players": [{ "name": "Ann", "scores": [10, 60, 70] }, { "name": "Ben", "scores": [45] }] }),
            json!([{ "name": "Ann", "big": [60, 70] }, { "name": "Ben", "big": [] }]),
        );
        check(
            r#"employee: $value from people where name == "Carol""#,
            people(),
            json!([{ "employee": { "name": "Carol", "id": 55, "title": "Analyst", "active": false, "age": 29, "city": "NYC",
                                   "jobs": [{ "employer": "Globocorp", "start": "2020" }] } }]),
        );
    }

    #[test]
    fn tutorial_entries_and_key() {
        let settings = json!({ "settings": { "theme": "dark", "fontSize": 14, "autosave": true } });
        check(
            "key: $key, value: $value from entries(settings)",
            settings.clone(),
            json!([{ "key": "theme", "value": "dark" }, { "key": "fontSize", "value": 14 }, { "key": "autosave", "value": true }]),
        );
        check(
            r#"$key values from entries(settings) where $value != "dark""#,
            settings.clone(),
            json!(["fontSize", "autosave"]),
        );
        check(
            "from entries(settings)",
            settings.clone(),
            json!(["dark", 14, true]),
        );
        check(
            "from settings",
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
            "name, on: entries(prefs) collect { $key values where $value } from users",
            users.clone(),
            json!([{ "name": "Ann", "on": ["dark"] }, { "name": "Ben", "on": [] }, { "name": "Cid", "on": [] }]),
        );
        check(
            r#"name values from users where entries(prefs) exists { where $key == "dark" && $value }"#,
            users.clone(),
            json!(["Ann"]),
        );
        check(
            "name values from users where entries(prefs) none { }",
            users,
            json!(["Cid"]),
        );
        check(
            "k: $key, v: $value from entries(xs)",
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
        // A data row that merely LOOKS like an entry is not unwrapped.
        check(
            "k: $key, key, value from r",
            json!({ "r": [{ "key": "k1", "value": 9 }] }),
            json!([{ "key": "k1", "value": 9 }]),
        );
        check(
            "r collect { $key values from entries(o) }",
            json!({ "r": [{ "o": { "a": 1, "b": 2 } }] }),
            json!(["a", "b"]),
        );
        check(
            r#"$key values from entries(groups) where $value exists { where $value > 4 && ^$key == "b" }"#,
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
        // ^ past the root is absent; ^$value is the enclosing row; $value at root is absent.
        // `^$value` from a top-level row names the root scope, which has no row.
        check(
            "x: ^^^nope, y: ^$value, z: ^r from r",
            json!({ "r": [1] }),
            json!([{ "z": [1] }]),
        );
        check(
            "r collect { a: $value, b: ^$value, c: ^^r }",
            json!({ "r": [1] }),
            json!([{ "a": 1 }]),
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
        // The unordered early stop caps at offset + 2 rows, so the count reported
        // is 2 even over three people — exactly as the reference does.
        check_err(
            "people single { }",
            people(),
            &["single { … } matched 2 rows"],
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
            "name, top: xs collect { $value values limit ^n } from r",
            json!({ "r": [{ "name": "a", "n": 1, "xs": [1, 2, 3] }, { "name": "b", "n": 2, "xs": [1, 2, 3] }] }),
            json!([{ "name": "a", "top": [1] }, { "name": "b", "top": [1, 2] }]),
        );
        check_err(
            "from xs limit 1.5",
            json!({ "xs": [] }),
            &["limit must be a non-negative integer", "1.5"],
        );
        // A top-level bound is read at the root scope: `^n` is one past it, absent.
        check_err(
            "from xs offset ^n",
            json!({ "xs": [], "n": 1 }),
            &["offset must be a non-negative integer", "null"],
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
        check(
            "id, leaf: $leaf, frontier: $frontier, stop: $stop from tree follow children order by $ordinal",
            tree.clone(),
            json!([{ "id": "root", "leaf": false, "frontier": false, "stop": "interior" },
                   { "id": "a", "leaf": false, "frontier": false, "stop": "interior" },
                   { "id": "b", "leaf": true, "frontier": false, "stop": "leaf" },
                   { "id": "a1", "leaf": true, "frontier": false, "stop": "leaf" }]),
        );
        check(
            "id, o: $ordinal from tree follow children order by $ordinal",
            tree.clone(),
            json!([{ "id": "root", "o": 1 }, { "id": "a", "o": 2 }, { "id": "b", "o": 3 }, { "id": "a1", "o": 4 }]),
        );
        check(
            r#"id, s: $stop, f: $frontier, l: $leaf from tree follow children { frontier id == "a" } order by $ordinal"#,
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
            "id values from tree where $depth > 1 follow children order by $ordinal",
            tree.clone(),
            json!(["a", "b", "a1"]),
        );
        check(
            r#"id values from tree where id != "b" && $depth <= 2 follow children order by $ordinal"#,
            tree.clone(),
            json!(["root", "a", "b"]),
        );
        check(
            "id, kids: children collect { id, own: $depth, parentDepth: ^$depth } from tree follow children { depth 2 } order by $ordinal",
            tree.clone(),
            json!([{ "id": "root", "kids": [{ "id": "a", "parentDepth": 1 }, { "id": "b", "parentDepth": 1 }] },
                   { "id": "a", "kids": [{ "id": "a1", "parentDepth": 2 }] },
                   { "id": "b", "kids": [] }]),
        );
        check(
            r#"id, desc: children collect { id values follow children order by $ordinal } from tree where id == "root""#,
            tree.clone(),
            json!([{ "id": "root", "desc": ["a", "b", "a1"] }]),
        );
        check(
            "label, stop: $stop from t follow children { by label } order by $ordinal",
            json!({ "t": [{ "label": "root", "children": [{ "label": "a" }, { "label": "b" }] }] }),
            json!([{ "label": "root", "stop": "interior" }, { "label": "a", "stop": "leaf" }, { "label": "b", "stop": "leaf" }]),
        );
        check_err(
            "id from tree where children exists { follow children }",
            tree,
            &["follow"],
        );
        // Path components compare as text: "10" < "9".
        check(
            "id values from tree follow children order by $ordinal",
            json!({ "tree": [{ "id": 1, "children": [{ "id": 9 }, { "id": 10 }] }] }),
            json!([1, 10, 9]),
        );
        // Cycles: a revisit is admitted once as `cycle`.
        let g = json!({ "n1": { "id": 1 } });
        let _ = g;
        let cyc = {
            // 1 -> 2 -> 1, expressed with nested duplicates (plain data has no references).
            json!({ "g": [{ "id": 1, "next": [{ "id": 2, "next": [{ "id": 1, "next": [{ "id": 2 }] }] }] }] })
        };
        check(
            "id, stop: $stop from g follow next order by $ordinal",
            cyc.clone(),
            json!([{ "id": 1, "stop": "interior" }, { "id": 2, "stop": "interior" }, { "id": 1, "stop": "cycle" }]),
        );
        check(
            "id from g follow distinct next order by id",
            cyc.clone(),
            json!([{ "id": 1 }, { "id": 2 }]),
        );
        check(
            "select distinct id from g follow next order by id",
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
            "id, root: $key from entries(forest) follow children order by $ordinal",
            json!({ "forest": { "left": { "id": "L", "children": [{ "id": "L1" }] }, "right": { "id": "R" } } }),
            json!([{ "id": "L", "root": "left" }, { "id": "R", "root": "right" }, { "id": "L1" }]),
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
            "name, n: $value collect { from jobs } from people where name == \"Bob\"",
            people(),
            json!([{ "name": "Bob", "n": [
                { "employer": "Globocorp", "start": "1984", "end": "1990" },
                { "employer": "Globocorp", "start": "2001" }
            ] }]),
        );
        // A free-function call may be a source.
        check("$value values from list(x)", json!({ "x": 5 }), json!([5]));
        check(
            "g: $key, big: $value collect { $value values where $value > 1 } from entries(groups)",
            json!({ "groups": { "a": [1, 2, 3], "b": [5] } }),
            json!([{ "g": "a", "big": [2, 3] }, { "g": "b", "big": [5] }]),
        );
    }

    #[test]
    fn where_trees_and_logical_values() {
        let r = json!({ "r": [{ "a": 1, "b": 0, "s": "" }, { "a": 0, "b": 2, "s": "x" }, {}] });
        check("a values from r where a || b", r.clone(), json!([1, 0]));
        check(
            "$value from r where !(a > 0) && !(b > 0)",
            r.clone(),
            json!([{ "$value": {} }]),
        );
        check(
            "$value values from r where !(a > 0) && !(b > 0)",
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
        // Short-circuit order: cheap scalar leaves before ops, so the op never runs.
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
            &["", " first { $value values }"],
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
}
