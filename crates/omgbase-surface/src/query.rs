//! The runner (`spec/surface/README.md` §1.4): parse the source, rewrite the
//! row functions to `$self` methods, run it through the engine over the
//! store context, and shape the engine's result into the surface's
//! `OqxResult` (lean `{ id, path, … }` hits, keyset paging, the consumer
//! scalars). Port of `packages/core/src/oqx-js/run.ts`.
//!
//! By default the tier-3 planner ([`crate::planner`]) pre-filters the scan in
//! SQL and the in-memory engine finishes the residual over the produced rows;
//! [`QueryOptions::in_memory`] forces the pure in-memory engine (the
//! differential gate runs every case both ways — a planner must be invisible).

use std::collections::HashMap;

use omgbase_search::{EmbeddingProvider, f32_to_blob};
use omgbase_store::Store;
use oqx::ast::{Expr, Follow, OpNode, OrderSpec, Query, SelectItem, Subquery, Where};
use oqx::{Consumer, Engine, InMemoryEngine, Value};
use serde_json::{Map, Value as Json};

use crate::context::{SemanticVec, StoreContext, render_row_values};
use crate::cursor::{decode_cursor, encode_cursor};
use crate::error::{Result, SurfaceError};
use crate::planner::SqlitePlanner;

/// The default page size.
pub const DEFAULT_LIMIT: usize = 50;

/// Row-scoped domain functions: authored as free calls that implicitly
/// reference the current row; rewritten to `$self.fn(…)`.
const ROW_FNS: [&str; 12] = [
    "text",
    "semantic",
    "under",
    "under_heading",
    "within",
    "under_kind",
    "yaml_path",
    "json_pointer",
    "has_edge",
    "has_anchor",
    "child_count",
    "parent_type",
];

const ID_KEY: &str = "__oqx_id";
const PATH_KEY: &str = "__oqx_path";
/// The reserved key a top-level `values` projection's single item is renamed
/// to, so it rides through id/path injection, paging and distinct as an
/// ordinary field and is peeled off at the end.
const VALUE_KEY: &str = "__oqx_value";

/// `query`'s options.
#[derive(Clone, Copy, Default)]
pub struct QueryOptions<'a> {
    /// The page cap (default 50).
    pub limit: Option<usize>,
    /// Resume after a truncated page's cursor.
    pub cursor: Option<&'a str>,
    /// The provider behind `semantic(...)`; `None` → `semantic_unavailable`
    /// when the query names a phrase.
    pub provider: Option<&'a dyn EmbeddingProvider>,
    /// Force the pure in-memory engine (skip the tier-3 pushdown planner).
    /// The default plans; the differential gate runs both and compares.
    pub in_memory: bool,
}

/// §1.4 `OqxResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct OqxResult {
    pub hits: Vec<Json>,
    pub truncated: bool,
    pub cursor: Option<String>,
    pub consumer: Consumer,
    pub count: Option<f64>,
    pub exists: Option<bool>,
    pub none: Option<bool>,
    /// A top-level `values` projection's bare values, in place of `hits`.
    pub values: Option<Vec<Json>>,
}

impl OqxResult {
    fn scalar(consumer: Consumer) -> Self {
        Self {
            hits: Vec::new(),
            truncated: false,
            cursor: None,
            consumer,
            count: None,
            exists: None,
            none: None,
            values: None,
        }
    }

    /// The wire shape: `{ hits, truncated, cursor, consumer, count?, exists?,
    /// none?, values? }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("hits".to_owned(), Json::Array(self.hits.clone()));
        m.insert("truncated".to_owned(), Json::Bool(self.truncated));
        m.insert(
            "cursor".to_owned(),
            self.cursor.clone().map_or(Json::Null, Json::String),
        );
        m.insert(
            "consumer".to_owned(),
            Json::String(self.consumer.as_str().to_owned()),
        );
        if let Some(n) = self.count {
            m.insert("count".to_owned(), Value::Number(n).to_canonical_json());
        }
        if let Some(b) = self.exists {
            m.insert("exists".to_owned(), Json::Bool(b));
        }
        if let Some(b) = self.none {
            m.insert("none".to_owned(), Json::Bool(b));
        }
        if let Some(v) = &self.values {
            m.insert("values".to_owned(), Json::Array(v.clone()));
        }
        Json::Object(m)
    }
}

// ---- the `$self` rewrite -----------------------------------------------------------

fn self_ref() -> Expr {
    Expr::Ident {
        name: "$self".to_owned(),
    }
}

fn rewrite_expr(e: &Expr) -> Expr {
    match e {
        Expr::Member { recv, name } => Expr::Member {
            recv: Box::new(rewrite_expr(recv)),
            name: name.clone(),
        },
        Expr::Index { recv, index } => Expr::Index {
            recv: Box::new(rewrite_expr(recv)),
            index: Box::new(rewrite_expr(index)),
        },
        Expr::Unary { op, expr } => Expr::Unary {
            op: *op,
            expr: Box::new(rewrite_expr(expr)),
        },
        Expr::Binary { op, left, right } => Expr::Binary {
            op: *op,
            left: Box::new(rewrite_expr(left)),
            right: Box::new(rewrite_expr(right)),
        },
        Expr::Logical { op, left, right } => Expr::Logical {
            op: *op,
            left: Box::new(rewrite_expr(left)),
            right: Box::new(rewrite_expr(right)),
        },
        Expr::In { left, right } => Expr::In {
            left: Box::new(rewrite_expr(left)),
            right: Box::new(rewrite_expr(right)),
        },
        Expr::Range {
            lo,
            hi,
            exclusive_end,
        } => Expr::Range {
            lo: lo.as_ref().map(|x| Box::new(rewrite_expr(x))),
            hi: hi.as_ref().map(|x| Box::new(rewrite_expr(x))),
            exclusive_end: *exclusive_end,
        },
        Expr::Call { recv, name, args } => {
            let args = args.iter().map(rewrite_expr).collect();
            match recv {
                None if ROW_FNS.contains(&name.as_str()) => Expr::Call {
                    recv: Some(Box::new(self_ref())),
                    name: name.clone(),
                    args,
                },
                None => Expr::Call {
                    recv: None,
                    name: name.clone(),
                    args,
                },
                Some(r) => Expr::Call {
                    recv: Some(Box::new(rewrite_expr(r))),
                    name: name.clone(),
                    args,
                },
            }
        }
        Expr::Lit(_) | Expr::Ident { .. } | Expr::Outer { .. } | Expr::Binding { .. } => e.clone(),
    }
}

fn rewrite_where(w: &Where) -> Where {
    match w {
        Where::And { parts } => Where::And {
            parts: parts.iter().map(rewrite_where).collect(),
        },
        Where::Or { parts } => Where::Or {
            parts: parts.iter().map(rewrite_where).collect(),
        },
        Where::Not { expr } => Where::Not {
            expr: Box::new(rewrite_where(expr)),
        },
        Where::Scalar { expr } => Where::Scalar {
            expr: rewrite_expr(expr),
        },
        Where::Op(op) => Where::Op(Box::new(rewrite_op(op))),
    }
}

fn rewrite_op(op: &OpNode) -> OpNode {
    OpNode {
        receiver: rewrite_expr(&op.receiver),
        op: op.op,
        sub: rewrite_sub(&op.sub),
        count_cmp: op.count_cmp.clone(),
        distinct: op.distinct,
    }
}

fn rewrite_follow(f: &Follow) -> Follow {
    Follow {
        receiver: rewrite_expr(&f.receiver),
        distinct: f.distinct,
        r#where: f.r#where.as_ref().map(rewrite_expr),
        frontier: f.frontier.as_ref().map(rewrite_expr),
        depth: f.depth,
        by: f.by.as_ref().map(rewrite_expr),
    }
}

fn rewrite_select(items: &[SelectItem]) -> Vec<SelectItem> {
    items
        .iter()
        .map(|it| match it {
            SelectItem::Field { name, expr, lift } => SelectItem::Field {
                name: name.clone(),
                expr: rewrite_expr(expr),
                lift: *lift,
            },
            SelectItem::Collect { name, op } => SelectItem::Collect {
                name: name.clone(),
                op: Box::new(rewrite_op(op)),
            },
        })
        .collect()
}

fn rewrite_order(o: Option<&Vec<OrderSpec>>) -> Option<Vec<OrderSpec>> {
    o.map(|specs| {
        specs
            .iter()
            .map(|s| OrderSpec {
                expr: rewrite_expr(&s.expr),
                desc: s.desc,
            })
            .collect()
    })
}

fn rewrite_sub(s: &Subquery) -> Subquery {
    Subquery {
        from: s.from.iter().map(rewrite_expr).collect(),
        r#where: s.r#where.as_ref().map(rewrite_where),
        select: rewrite_select(&s.select),
        order_by: rewrite_order(s.order_by.as_ref()),
        follow: s.follow.as_ref().map(rewrite_follow),
        values: s.values,
        limit: s.limit.as_ref().map(rewrite_expr),
        offset: s.offset.as_ref().map(rewrite_expr),
    }
}

/// Rewrite every row function in a parsed query to a `$self` method call.
#[must_use]
pub fn rewrite_query(q: &Query) -> Query {
    Query {
        source: rewrite_expr(&q.source),
        from: q.from.iter().map(rewrite_expr).collect(),
        r#where: q.r#where.as_ref().map(rewrite_where),
        select: rewrite_select(&q.select),
        order_by: rewrite_order(q.order_by.as_ref()),
        consumer: q.consumer,
        follow: q.follow.as_ref().map(rewrite_follow),
        distinct: q.distinct,
        values: q.values,
        limit: q.limit.as_ref().map(rewrite_expr),
        offset: q.offset.as_ref().map(rewrite_expr),
    }
}

// ---- semantic phrases -----------------------------------------------------------------

fn visit_expr(e: &Expr, out: &mut Vec<String>) {
    match e {
        Expr::Call { recv, name, args } => {
            if recv.is_none() && name == "semantic" {
                if let Some(Expr::Lit(Value::Str(s))) = args.first() {
                    if !out.contains(s) {
                        out.push(s.clone());
                    }
                }
            }
            if let Some(r) = recv {
                visit_expr(r, out);
            }
            for a in args {
                visit_expr(a, out);
            }
        }
        Expr::Member { recv, .. } => visit_expr(recv, out),
        Expr::Index { recv, index } => {
            visit_expr(recv, out);
            visit_expr(index, out);
        }
        Expr::Unary { expr, .. } => visit_expr(expr, out),
        Expr::Binary { left, right, .. }
        | Expr::Logical { left, right, .. }
        | Expr::In { left, right } => {
            visit_expr(left, out);
            visit_expr(right, out);
        }
        Expr::Range { lo, hi, .. } => {
            if let Some(l) = lo {
                visit_expr(l, out);
            }
            if let Some(h) = hi {
                visit_expr(h, out);
            }
        }
        Expr::Lit(_) | Expr::Ident { .. } | Expr::Outer { .. } | Expr::Binding { .. } => {}
    }
}

fn visit_where(w: &Where, out: &mut Vec<String>) {
    match w {
        Where::And { parts } | Where::Or { parts } => {
            parts.iter().for_each(|p| visit_where(p, out))
        }
        Where::Not { expr } => visit_where(expr, out),
        Where::Scalar { expr } => visit_expr(expr, out),
        Where::Op(op) => visit_op(op, out),
    }
}

fn visit_op(op: &OpNode, out: &mut Vec<String>) {
    visit_expr(&op.receiver, out);
    visit_sub(&op.sub, out);
}

fn visit_select(items: &[SelectItem], out: &mut Vec<String>) {
    for it in items {
        match it {
            SelectItem::Field { expr, .. } => visit_expr(expr, out),
            SelectItem::Collect { op, .. } => visit_op(op, out),
        }
    }
}

fn visit_follow(f: &Follow, out: &mut Vec<String>) {
    visit_expr(&f.receiver, out);
    for x in [&f.r#where, &f.frontier, &f.by].into_iter().flatten() {
        visit_expr(x, out);
    }
}

fn visit_sub(s: &Subquery, out: &mut Vec<String>) {
    s.from.iter().for_each(|e| visit_expr(e, out));
    if let Some(w) = &s.r#where {
        visit_where(w, out);
    }
    visit_select(&s.select, out);
    if let Some(o) = &s.order_by {
        o.iter().for_each(|spec| visit_expr(&spec.expr, out));
    }
    if let Some(f) = &s.follow {
        visit_follow(f, out);
    }
}

/// The distinct phrases `semantic("…")` names (free calls in the raw parse);
/// empty when the source does not parse.
#[must_use]
pub fn collect_semantic_phrases(source: &str) -> Vec<String> {
    let Ok(q) = oqx::parse_string(source) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    visit_expr(&q.source, &mut out);
    q.from.iter().for_each(|e| visit_expr(e, &mut out));
    if let Some(w) = &q.r#where {
        visit_where(w, &mut out);
    }
    visit_select(&q.select, &mut out);
    if let Some(o) = &q.order_by {
        o.iter().for_each(|spec| visit_expr(&spec.expr, &mut out));
    }
    if let Some(f) = &q.follow {
        visit_follow(f, &mut out);
    }
    out
}

// ---- hits ----------------------------------------------------------------------------

/// A projected row as a hit: `{ id, path, ...rest }` with the injected
/// columns peeled off (JavaScript's `String()` on the id, `""` for an absent
/// path). The projection's values are rendered per §1.4 "rows as values": a
/// store row nested in the result (an empty-projection `collect { }` and
/// friends) becomes `{ id, path }`.
fn to_hit(row: Value) -> Value {
    let Value::Object(o) = render_row_values(row) else {
        return Value::Object(oqx::Object::new());
    };
    let mut id = Value::Undefined;
    let mut path = Value::Undefined;
    let mut rest = Vec::new();
    for (k, v) in o {
        match k.as_str() {
            ID_KEY => id = v,
            PATH_KEY => path = v,
            _ => rest.push((k, v)),
        }
    }
    let mut hit = oqx::Object::with_capacity(rest.len() + 2);
    hit.insert("id", Value::Str(id.to_string()));
    hit.insert(
        "path",
        Value::Str(if path.is_absent() {
            String::new()
        } else {
            path.to_string()
        }),
    );
    for (k, v) in rest {
        hit.insert(k, v);
    }
    Value::Object(hit)
}

fn hit_str(hit: &Value, key: &str) -> String {
    hit.as_object()
        .and_then(|o| o.get(key))
        .map(|v| v.to_string())
        .unwrap_or_default()
}

/// Top-level `select distinct`: dedup hits by their USER projection (every
/// field but `id`/`path`), keeping the first. The key is the canonical JSON
/// of the sorted `[key, value]` pairs (`JSON.stringify` in the reference).
fn dedup_hits_by_projection(hits: Vec<Value>) -> Vec<Value> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for h in hits {
        let mut pairs: Vec<(String, Value)> = h
            .as_object()
            .map(|o| {
                o.iter()
                    .filter(|(k, _)| *k != "id" && *k != "path")
                    .map(|(k, v)| (k.to_owned(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        let key = Value::Array(
            pairs
                .into_iter()
                .map(|(k, v)| Value::Array(vec![Value::Str(k), v]))
                .collect(),
        )
        .to_canonical_json()
        .to_string();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(h);
    }
    out
}

/// A top-level `limit`/`offset` on the collect path is applied by the runner,
/// so it must be a plain non-negative integer literal.
fn const_bound(e: Option<&Expr>, word: &str) -> Result<Option<usize>> {
    match e {
        None => Ok(None),
        Some(Expr::Lit(Value::Number(n))) if n.fract() == 0.0 && *n >= 0.0 && n.is_finite() => {
            Ok(Some(*n as usize))
        }
        Some(_) => Err(SurfaceError::filter_invalid(
            format!("top-level {word} must be a non-negative integer literal"),
            "OQX",
        )),
    }
}

fn value_of(hit: &Value) -> Value {
    hit.as_object()
        .and_then(|o| o.get(VALUE_KEY))
        .cloned()
        .unwrap_or(Value::Undefined)
}

fn without_value_key(hit: Value) -> Json {
    hit.to_canonical_json()
}

// ---- the run --------------------------------------------------------------------------

/// Run an OQX query against `repo_id` (§1.4).
pub fn query(
    store: &Store,
    repo_id: &str,
    source: &str,
    opts: QueryOptions<'_>,
) -> Result<OqxResult> {
    // Without a provider the phrases stay unembedded and the context reports
    // `filter_invalid` ("needs an embedding provider") when one is reached —
    // after its target check, so `semantic()` on nodes names the targets
    // (§9; the `query` tool's pre-check is what reports `semantic_unavailable`).
    let phrases = collect_semantic_phrases(source);
    let mut semantic: HashMap<String, SemanticVec> = HashMap::new();
    if let Some(provider) = opts.provider.filter(|_| !phrases.is_empty()) {
        for phrase in phrases {
            let vec = provider
                .embed_query(&phrase)
                .map_err(|e| SurfaceError::new(e.code(), e.to_string()))?;
            semantic.insert(
                phrase,
                SemanticVec {
                    model: provider.model().to_owned(),
                    vec: f32_to_blob(&vec),
                },
            );
        }
    }
    let runner = Runner {
        store,
        repo_id,
        semantic,
        planned: !opts.in_memory,
    };
    run_inner(&runner, source, opts)
}

/// One query's engine: a fresh store context per run (the planned path gives
/// the residual a context serving the produced rows as its root). A failure
/// inside a property read or row function is the engine's own error (the
/// context's `get` / `call_method` return `Err`); only a failed root scan,
/// which the `root` seam cannot raise, is read back after the run.
struct Runner<'a> {
    store: &'a Store,
    repo_id: &'a str,
    semantic: HashMap<String, SemanticVec>,
    planned: bool,
}

impl Runner<'_> {
    /// Tier-3 pushdown reduces the scan in SQL and the in-memory engine
    /// finishes the residual over the produced rows (a declined plan, or
    /// `in_memory`, runs the whole query in memory over a full scan), so
    /// results match a pure scan. This is `oqx::PlannedEngine::run` inlined:
    /// the store context borrows the connection, so it cannot be the
    /// `'static` context a `Plan` carries.
    fn run(&self, q: &Query) -> Result<oqx::OqxResult> {
        let conn = self.store.conn();
        let ctx = StoreContext::new(conn, self.repo_id, self.semantic.clone());
        let plan = if self.planned {
            SqlitePlanner::new(conn, self.repo_id)
                .try_plan(q, &[])
                .map_err(|e| SurfaceError::other(format!("sqlite: {e}")))?
        } else {
            None
        };
        let (ctx, residual) = match plan {
            Some(plan) => (ctx.with_rows_root(plan.rows), Some(plan.residual)),
            None => (ctx, None),
        };
        let engine = InMemoryEngine::new(ctx);
        let out = engine.run(residual.as_ref().unwrap_or(q), &[]);
        // `root` has no error channel: a store failure during a root scan was
        // served as an empty scan and wins over whatever the run made of it.
        if let Some(failed) = engine.context().take_root_failure() {
            return Err(failed.into());
        }
        Ok(out?)
    }
}

fn run_inner(engine: &Runner<'_>, source: &str, opts: QueryOptions<'_>) -> Result<OqxResult> {
    let parsed = rewrite_query(&oqx::parse_string(source)?);
    let consumer = parsed.consumer;

    match consumer {
        Consumer::Exists => {
            let res = engine.run(&parsed)?;
            let mut r = OqxResult::scalar(consumer);
            r.exists = Some(matches!(res, oqx::OqxResult::Exists(true)));
            return Ok(r);
        }
        Consumer::Count => {
            let res = engine.run(&parsed)?;
            let mut r = OqxResult::scalar(consumer);
            r.count = Some(match res {
                oqx::OqxResult::Count(n) => n,
                _ => 0.0,
            });
            return Ok(r);
        }
        Consumer::None => {
            let res = engine.run(&parsed)?;
            let mut r = OqxResult::scalar(consumer);
            r.none = Some(match res {
                oqx::OqxResult::None(b) => b,
                _ => true,
            });
            return Ok(r);
        }
        Consumer::Collect | Consumer::First | Consumer::Single => {}
    }

    // collect / first / single: inject id + path so every hit carries them. A
    // top-level `select distinct` is applied HERE, not in the engine (the
    // injected id/path are unique per row and would defeat the engine's
    // projection dedup). A top-level `values` projection runs as a RECORD
    // projection whose single item is renamed to VALUE_KEY.
    let top_distinct = parsed.distinct;
    let top_values = parsed.values;
    let user_select: Vec<SelectItem> = if top_values {
        parsed
            .select
            .first()
            .map(|it| match it {
                SelectItem::Field { expr, lift, .. } => SelectItem::Field {
                    name: VALUE_KEY.to_owned(),
                    expr: expr.clone(),
                    lift: *lift,
                },
                SelectItem::Collect { op, .. } => SelectItem::Collect {
                    name: VALUE_KEY.to_owned(),
                    op: op.clone(),
                },
            })
            .into_iter()
            .collect()
    } else {
        parsed.select.clone()
    };
    let id_item = SelectItem::Field {
        name: ID_KEY.to_owned(),
        expr: Expr::Ident {
            name: "$id".to_owned(),
        },
        lift: 0,
    };
    let path_item = SelectItem::Field {
        name: PATH_KEY.to_owned(),
        expr: Expr::Ident {
            name: "$path".to_owned(),
        },
        lift: 0,
    };
    let mut select = vec![id_item, path_item];
    select.extend(user_select);
    // On the collect path the query's own limit/offset is taken out of the
    // engine query and applied after the runner's distinct; first/single keep
    // theirs (the engine's offset-aware cap is exactly right for them).
    let (top_limit, top_offset) = (parsed.limit.clone(), parsed.offset.clone());
    let q = Query {
        distinct: false,
        values: false,
        select,
        limit: if consumer == Consumer::Collect {
            None
        } else {
            parsed.limit.clone()
        },
        offset: if consumer == Consumer::Collect {
            None
        } else {
            parsed.offset.clone()
        },
        ..parsed.clone()
    };
    let res = engine.run(&q)?;

    if matches!(consumer, Consumer::First | Consumer::Single) {
        let row = match res {
            oqx::OqxResult::First(r) | oqx::OqxResult::Single(r) => r,
            _ => None,
        };
        let mut out = OqxResult::scalar(consumer);
        match row {
            None => {
                if top_values {
                    out.values = Some(Vec::new());
                }
            }
            Some(r) => {
                let hit = to_hit(r);
                if top_values {
                    out.values = Some(vec![value_of(&hit).to_canonical_json()]);
                } else {
                    out.hits = vec![without_value_key(hit)];
                }
            }
        }
        return Ok(out);
    }

    // collect: keyset pagination on (path, id) when the order is the default.
    let mut rows: Vec<Value> = match res {
        oqx::OqxResult::Collect(rows) => rows.into_iter().map(to_hit).collect(),
        _ => Vec::new(),
    };
    if top_distinct {
        rows = dedup_hits_by_projection(rows);
    }
    let offset = const_bound(top_offset.as_ref(), "offset")?.unwrap_or(0);
    let limit = const_bound(top_limit.as_ref(), "limit")?;
    if offset > 0 || limit.is_some() {
        let end = limit.map_or(rows.len(), |l| (offset + l).min(rows.len()));
        rows = if offset >= rows.len() {
            Vec::new()
        } else {
            rows[offset..end].to_vec()
        };
    }
    let custom = parsed.order_by.as_ref().is_some_and(|o| !o.is_empty());
    let cap = opts.limit.unwrap_or(DEFAULT_LIMIT);
    let mut page = rows;
    if !custom {
        if let Some(cursor) = opts.cursor.filter(|c| !c.is_empty()) {
            let parts = decode_cursor(cursor, "query", 2)?;
            let (path, id) = (&parts[0], &parts[1]);
            page.retain(|h| {
                let hp = hit_str(h, "path");
                let hi = hit_str(h, "id");
                hp > *path || (hp == *path && hi > *id)
            });
        }
    }
    let truncated = page.len() > cap;
    page.truncate(cap);
    let cursor = if truncated && !custom {
        page.last()
            .map(|last| encode_cursor(&[&hit_str(last, "path"), &hit_str(last, "id")]))
    } else {
        None
    };
    let mut out = OqxResult::scalar(Consumer::Collect);
    out.truncated = truncated;
    out.cursor = cursor;
    if top_values {
        out.values = Some(
            page.iter()
                .map(|h| value_of(h).to_canonical_json())
                .collect(),
        );
    } else {
        out.hits = page.into_iter().map(without_value_key).collect();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_functions_become_self_methods() {
        let q = oqx::parse_string(
            "from blocks where text(\"x\") && under_heading(\"h\") && size(attrs) > 0 && doc.$path.startsWith(\"a\")",
        )
        .unwrap();
        let r = rewrite_query(&q);
        let Some(Where::And { parts }) = &r.r#where else {
            panic!("and")
        };
        let Where::Scalar { expr } = &parts[0] else {
            panic!("scalar")
        };
        assert!(
            matches!(expr, Expr::Call { recv: Some(r), name, .. } if name == "text" && **r == self_ref())
        );
        let Where::Scalar { expr } = &parts[2] else {
            panic!("scalar")
        };
        assert!(
            matches!(expr, Expr::Binary { left, .. } if matches!(&**left, Expr::Call { recv: None, name, .. } if name == "size"))
        );
    }

    #[test]
    fn semantic_phrases_are_collected_distinct() {
        let phrases = collect_semantic_phrases(
            "select s: semantic(\"alpha\") from docs where semantic(\"alpha\") > 0.5 || nodes exists { where semantic(\"beta\") > 0 } order by semantic(\"gamma\") desc",
        );
        assert_eq!(phrases, ["alpha", "beta", "gamma"]);
        assert!(collect_semantic_phrases("not a query {{").is_empty());
        assert!(collect_semantic_phrases("from docs").is_empty());
    }

    #[test]
    fn hits_peel_the_injected_columns() {
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Str("d_1".into()));
        o.insert(PATH_KEY, Value::Null);
        o.insert("layer", Value::Str("canon".into()));
        let hit = to_hit(Value::Object(o));
        let ho = hit.as_object().unwrap();
        assert_eq!(ho.keys().collect::<Vec<_>>(), ["id", "path", "layer"]);
        assert_eq!(ho.get("path"), Some(&Value::Str(String::new())));
        // A user field named `id` overrides the injected one in place.
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Str("d_1".into()));
        o.insert(PATH_KEY, Value::Str("a.md".into()));
        o.insert("id", Value::Number(7.0));
        let hit = to_hit(Value::Object(o));
        let ho = hit.as_object().unwrap();
        assert_eq!(ho.keys().collect::<Vec<_>>(), ["id", "path"]);
        assert_eq!(ho.get("id"), Some(&Value::Number(7.0)));
    }

    #[test]
    fn distinct_dedups_by_user_projection_first_wins() {
        let mk = |id: &str, t: &str| {
            let mut o = oqx::Object::new();
            o.insert("id", Value::Str(id.into()));
            o.insert("path", Value::Str("p".into()));
            o.insert("type", Value::Str(t.into()));
            Value::Object(o)
        };
        let out = dedup_hits_by_projection(vec![mk("1", "a"), mk("2", "b"), mk("3", "a")]);
        assert_eq!(out.len(), 2);
        assert_eq!(hit_str(&out[0], "id"), "1");
        assert_eq!(hit_str(&out[1], "id"), "2");
    }

    #[test]
    fn top_level_bounds_must_be_literals() {
        assert_eq!(const_bound(None, "limit").unwrap(), None);
        assert_eq!(
            const_bound(Some(&Expr::Lit(Value::Number(3.0))), "limit").unwrap(),
            Some(3)
        );
        let e = const_bound(Some(&Expr::Lit(Value::Number(-1.0))), "offset").unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert!(e.message.contains("top-level offset"));
    }
}
