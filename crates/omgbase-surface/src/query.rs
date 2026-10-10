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
use oqx::ast::{Expr, Query, SelectItem};
use oqx::walk::{Clause, Node, VisitContext, Visitor, transform, visit};
use oqx::{Consumer, Engine, InMemoryEngine, Value, build, resolve_aliases};
use serde_json::{Map, Value as Json};

use crate::context::{SemanticVec, StoreContext, render_row_values, target_of};
use crate::cursor::{decode_cursor, encode_cursor};
use crate::error::{Result, SurfaceError};
use crate::planner::{SqlitePlanner, root_target};

/// The default page size.
pub const DEFAULT_LIMIT: usize = 50;

/// Row-scoped domain functions: authored as free calls that implicitly
/// reference the current row; rewritten to `$self.fn(…)`. `refs(x)` is not
/// one: it reads no row, so it stays a free function of the context. The
/// planner treats every call alike (declined by the translator, flagged by
/// `expr_may_raise`), `has_edge` and `refs` included.
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
/// A hit is a store row (§1.4, 1.5). A bare root scan's rows are store rows by
/// construction; a `follow` destination (`follow before` over a frontmatter
/// list of paths), a `from E` re-projection or any other source can reach a
/// scalar, which the injected `$id`/`$path` reads would render as the junk hit
/// `{ id: "undefined", path: "" }`. For those queries the row itself is
/// projected too (`$it`) under this key and [`to_hit`] fails the query when it
/// is not a row. Only then: the clone of every projected row is a real cost
/// here, and a root scan cannot need it. A `values` projection returns no
/// hits, so it is exempt. Same rule as the reference's `SELF_ITEM`.
const SELF_KEY: &str = "__oqx_self";
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

/// Rewrite every row function in a parsed query to a `$self` method call — one
/// `transform` over the AST (`spec/oqx/AST.md` §5), every block included.
#[must_use]
pub fn rewrite_query(q: &Query) -> Query {
    transform(q, &mut |e, _| match e {
        Expr::Call {
            recv: None,
            name,
            args,
            span,
        } if ROW_FNS.contains(&name.as_str()) => Expr::Call {
            recv: Some(Box::new(build::ident("$self"))),
            name,
            args,
            span,
        },
        other => other,
    })
}

// ---- semantic phrases -----------------------------------------------------------------

/// Collects the distinct `semantic("…")` phrases of a tree.
struct Phrases(Vec<String>);

impl Visitor for Phrases {
    fn enter(&mut self, node: Node<'_>, _ctx: &VisitContext<'_>) -> bool {
        if let Node::Expr(Expr::Call {
            recv: None,
            name,
            args,
            ..
        }) = node
            && name == "semantic"
            && let Some(Expr::Lit {
                value: Value::Str(s),
                ..
            }) = args.first()
            && !self.0.contains(s)
        {
            self.0.push(s.clone());
        }
        true
    }
}

/// The distinct phrases `semantic("…")` names (free calls in the raw parse);
/// empty when the source does not parse.
#[must_use]
pub fn collect_semantic_phrases(source: &str) -> Vec<String> {
    let Ok(q) = oqx::parse_string(source) else {
        return Vec::new();
    };
    let mut phrases = Phrases(Vec::new());
    visit(Node::Query(&q), &mut phrases);
    phrases.0
}

// ---- name mentions --------------------------------------------------------------------

/// Whether `name` is read anywhere in `q` other than as its source: a bare
/// identifier or a `^`-escaped one in the `from` steps, `where`, `select`,
/// `order by`, `follow`, `limit`/`offset`, or any nested block.
fn mentions_outside_source(q: &Query, name: &str) -> bool {
    struct Mentions<'n> {
        name: &'n str,
        found: bool,
    }
    impl Visitor for Mentions<'_> {
        fn enter(&mut self, node: Node<'_>, ctx: &VisitContext<'_>) -> bool {
            if self.found {
                return false;
            }
            // The source itself (the root's `source` slot) is not a mention.
            if ctx.clause == Some(Clause::Source) && ctx.path.len() == 1 {
                return false;
            }
            if let Node::Expr(Expr::Ident { name, .. } | Expr::Outer { name, .. }) = node
                && name == self.name
            {
                self.found = true;
            }
            !self.found
        }
    }
    let mut m = Mentions { name, found: false };
    visit(Node::Query(q), &mut m);
    m.found
}

// ---- hits ----------------------------------------------------------------------------

/// Whether the engine's top-level rows can be anything but store rows: a
/// `follow` (a destination may be a property's value), a `from E`
/// re-projection, or a source that is not a bare root scan.
fn may_reach_non_rows(q: &Query) -> bool {
    q.follow.is_some() || !q.from.is_empty() || root_target(&q.source).is_none()
}

/// The reference's `describeValue`: what a non-row hit was, for the error.
fn describe_value(v: &Value) -> String {
    match v {
        Value::Undefined | Value::Null => "an absent value".to_owned(),
        Value::Str(s) => format!(
            "a string ({})",
            serde_json::to_string(s).unwrap_or_default()
        ),
        Value::Number(_) => format!("a number ({v})"),
        Value::Bool(b) => format!("a boolean ({b})"),
        Value::Array(_) => "an array".to_owned(),
        Value::Range(_) => "a range".to_owned(),
        Value::Object(_) => "an object".to_owned(),
    }
}

fn not_a_store_row(v: &Value) -> SurfaceError {
    SurfaceError::filter_invalid(
        format!(
            "a hit must be a document, block, node or edge row — the query reached {}; to follow document references held in a property use refs(<field>)",
            describe_value(v)
        ),
        "OQX",
    )
}

/// A projected row as a hit: `{ id, path, ...rest }` with the injected
/// columns peeled off (JavaScript's `String()` on the id, `""` for an absent
/// path). The projection's values are rendered per §1.4 "rows as values": a
/// store row nested in the result (an empty-projection `collect { }` and
/// friends) becomes `{ id, path }`. When the row itself was projected under
/// [`SELF_KEY`] and is not a store row, the query fails (§1.4: a hit is a
/// store row).
fn to_hit(row: Value) -> Result<Value> {
    let Value::Object(mut o) = row else {
        return Ok(Value::Object(oqx::Object::new()));
    };
    if let Some(me) = o.remove(SELF_KEY) {
        if target_of(&me).is_none() {
            return Err(not_a_store_row(&me));
        }
    }
    let Value::Object(o) = render_row_values(Value::Object(o)) else {
        return Ok(Value::Object(oqx::Object::new()));
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
    Ok(Value::Object(hit))
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
        Some(Expr::Lit {
            value: Value::Number(n),
            ..
        }) if n.fract() == 0.0 && *n >= 0.0 && n.is_finite() => Ok(Some(*n as usize)),
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
            // The residual's source is its one read of the rows root unless
            // the query text itself names `__oqx_rows__` somewhere else (a
            // `^`-reach, a `limit`, a nested block…): then every read must
            // see the rows, so they are cloned out instead of moved.
            Some(plan) => {
                let once = !mentions_outside_source(&plan.residual, oqx::ROWS_ROOT);
                let ctx = if once {
                    ctx.with_rows_root_once(plan.rows)
                } else {
                    ctx.with_rows_root(plan.rows)
                };
                (ctx, Some(plan.residual))
            }
            None => (ctx, None),
        };
        let engine = InMemoryEngine::new(ctx);
        let out = engine.run(residual.as_ref().unwrap_or(q), &[]);
        // `root` has no error channel: a store failure during a root scan was
        // served as an empty scan and wins over whatever the run made of it.
        if let Some(failed) = engine.context().take_root_failure() {
            return Err(failed.into());
        }
        // A root scan projected as a VALUE (`select all: $repo.docs`) was
        // materialized into its rows by the engine (`DataContext::materialize`).
        Ok(out?)
    }
}

fn run_inner(engine: &Runner<'_>, source: &str, opts: QueryOptions<'_>) -> Result<OqxResult> {
    // The query's `select` aliases are resolved HERE, once, before the runner
    // renames/injects items (an engine evaluates the query it is given).
    let parsed = rewrite_query(&resolve_aliases(&oqx::parse_string(source)?)?);
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
                SelectItem::Field {
                    expr, lift, span, ..
                } => SelectItem::Field {
                    name: VALUE_KEY.to_owned(),
                    expr: expr.clone(),
                    lift: *lift,
                    span: *span,
                },
                SelectItem::Collect { op, span, .. } => SelectItem::Collect {
                    name: VALUE_KEY.to_owned(),
                    op: op.clone(),
                    span: *span,
                },
            })
            .into_iter()
            .collect()
    } else {
        parsed.select.clone()
    };
    let id_item = build::field(ID_KEY, build::ident("$id"));
    let path_item = build::field(PATH_KEY, build::ident("$path"));
    let mut select = vec![id_item, path_item];
    if !top_values && may_reach_non_rows(&parsed) {
        select.push(build::field(SELF_KEY, build::ident("$it")));
    }
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
                let hit = to_hit(r)?;
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
        oqx::OqxResult::Collect(rows) => rows,
        _ => Vec::new(),
    };
    let custom = parsed.order_by.as_ref().is_some_and(|o| !o.is_empty());
    let cursor = opts.cursor.filter(|c| !c.is_empty() && !custom);
    // Rows become hits ({ id, path, … }) before anything inspects them — the
    // distinct key and the cursor's (path, id) read the HIT — else only the
    // page does (the offset/limit slice and the cap see plain rows), so a
    // scan that projects thousands of rows shapes fifty.
    let eager = top_distinct || cursor.is_some();
    if eager {
        rows = rows.into_iter().map(to_hit).collect::<Result<_>>()?;
    }
    if top_distinct {
        rows = dedup_hits_by_projection(rows);
    }
    let offset = const_bound(top_offset.as_ref(), "offset")?.unwrap_or(0);
    let limit = const_bound(top_limit.as_ref(), "limit")?;
    if offset > 0 || limit.is_some() {
        let end = limit.map_or(rows.len(), |l| (offset + l).min(rows.len()));
        if offset >= rows.len() {
            rows.clear();
        } else {
            rows.truncate(end);
            rows.drain(..offset);
        }
    }
    let cap = opts.limit.unwrap_or(DEFAULT_LIMIT);
    let mut page = rows;
    if let Some(cursor) = cursor {
        let parts = decode_cursor(cursor, "query", 2)?;
        let (path, id) = (&parts[0], &parts[1]);
        page.retain(|h| {
            let hp = hit_str(h, "path");
            let hi = hit_str(h, "id");
            hp > *path || (hp == *path && hi > *id)
        });
    }
    let truncated = page.len() > cap;
    page.truncate(cap);
    if !eager {
        page = page.into_iter().map(to_hit).collect::<Result<_>>()?;
    }
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
    use oqx::ast::Where;

    #[test]
    fn row_functions_become_self_methods() {
        let q = oqx::parse_string(
            "from blocks where text(\"x\") && under_heading(\"h\") && size(attrs) > 0 && doc.$path.startsWith(\"a\")",
        )
        .unwrap();
        let r = rewrite_query(&q);
        let Some(Where::And { parts, .. }) = &r.r#where else {
            panic!("and")
        };
        let Where::Scalar { expr, .. } = &parts[0] else {
            panic!("scalar")
        };
        assert!(
            matches!(expr, Expr::Call { recv: Some(r), name, .. } if name == "text" && **r == build::ident("$self"))
        );
        let Where::Scalar { expr, .. } = &parts[2] else {
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
        let hit = to_hit(Value::Object(o)).unwrap();
        let ho = hit.as_object().unwrap();
        assert_eq!(ho.keys().collect::<Vec<_>>(), ["id", "path", "layer"]);
        assert_eq!(ho.get("path"), Some(&Value::Str(String::new())));
        // A user field named `id` overrides the injected one in place.
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Str("d_1".into()));
        o.insert(PATH_KEY, Value::Str("a.md".into()));
        o.insert("id", Value::Number(7.0));
        let hit = to_hit(Value::Object(o)).unwrap();
        let ho = hit.as_object().unwrap();
        assert_eq!(ho.keys().collect::<Vec<_>>(), ["id", "path"]);
        assert_eq!(ho.get("id"), Some(&Value::Number(7.0)));
    }

    #[test]
    fn a_hit_that_is_not_a_store_row_fails_the_query() {
        // The row itself rides under SELF_KEY when the query can reach a
        // non-row; a string there is the `follow before` shape (§1.4, 1.5).
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Undefined);
        o.insert(PATH_KEY, Value::Undefined);
        o.insert(SELF_KEY, Value::Str("/timeline/kickoff.md".into()));
        let e = to_hit(Value::Object(o)).unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(
            e.message,
            "a hit must be a document, block, node or edge row — the query reached a string (\"/timeline/kickoff.md\"); to follow document references held in a property use refs(<field>)"
        );
        // A tagged row under SELF_KEY passes and the key is peeled off.
        let mut row = oqx::Object::new();
        row.insert("doc_id", Value::Str("d_1".into()));
        row.insert("path", Value::Str("a.md".into()));
        let row = crate::context::tag_row(row, crate::context::Target::Docs);
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Str("d_1".into()));
        o.insert(PATH_KEY, Value::Str("a.md".into()));
        o.insert(SELF_KEY, row);
        let hit = to_hit(Value::Object(o)).unwrap();
        assert_eq!(
            hit.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["id", "path"]
        );
        // Only queries that can reach a non-row project the row itself.
        let parse = |s: &str| oqx::parse_string(s).unwrap();
        assert!(!may_reach_non_rows(&parse(
            "from docs where layer == \"canon\""
        )));
        assert!(may_reach_non_rows(&parse("from docs follow before")));
        assert!(may_reach_non_rows(&parse("refs(\"/index.md\") first { }")));
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
            const_bound(
                Some(&Expr::Lit {
                    value: Value::Number(3.0),
                    span: oqx::Span::EMPTY
                }),
                "limit"
            )
            .unwrap(),
            Some(3)
        );
        let e = const_bound(
            Some(&Expr::Lit {
                value: Value::Number(-1.0),
                span: oqx::Span::EMPTY,
            }),
            "offset",
        )
        .unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert!(e.message.contains("top-level offset"));
    }
}
