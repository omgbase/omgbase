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
use oqx::ast::{BinaryOp, Expr, Query, SelectItem};
use oqx::walk::{Clause, Node, VisitContext, Visitor, transform, visit};
use oqx::{Consumer, Engine, InMemoryEngine, Value, build, resolve_aliases};
use serde_json::{Map, Value as Json};

use crate::context::{SemanticVec, StoreContext, Target, render_row_values, target_of};
use crate::cursor::{decode_path_cursor, encode_cursor};
use crate::dates;
use crate::error::{Result, SurfaceError};
use crate::names::{UnknownNames, VocabularyCache, check_names};
use crate::paths::reference_path;
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
/// The hit envelope's keys (§1.4, 3.0): the row's identity under the same
/// bare names the expression language reads, so a key copied from a hit is
/// valid in the next `where` with no translation; `select id, path` is simply
/// the envelope and any other projection whose output key would be one of
/// these must be aliased ([`envelope_collision`]).
pub(crate) const HIT_ID: &str = "id";
pub(crate) const HIT_PATH: &str = "path";
/// A hit is a store row (§1.4, 1.5). A bare root scan's rows are store rows by
/// construction; a `follow` destination (`follow before` over a frontmatter
/// list of paths), a `from E` re-projection or any other source can reach a
/// scalar, which the injected `id`/`path` reads would render as the junk hit
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
    /// `bare: true` (§1.4, 4.2): every hit is its projection only — the
    /// automatic `id`/`path` envelope members are stripped when the result is
    /// shaped, AFTER paging and distinct (identity is kept internally: the
    /// keyset cursor and the dedup key read the envelope). Needs a `select`
    /// (without a projection a hit is only its envelope) and is refused with
    /// `values` (already the bare-values form); a projected `id`/`path` is the
    /// row's intrinsic, kept as any projected key is.
    pub bare: bool,
    /// What a tier-3 name on an open kind does (`spec/surface` §1.5, 4.6; a
    /// tier-3 name on `links` is `filter_invalid` either way): `Hint` records
    /// it in `hints` and runs the query — the default of the source entry
    /// ([`query`], every read); `Refuse` fails with `filter_invalid` before
    /// any row is read — the default of the AST entry ([`query_ast`]), whose
    /// caller is the write selector compiler, where a name no row carries
    /// would select every row. `None` takes the entry's default.
    pub unknown_names: Option<UnknownNames>,
    /// The vocabulary cache of the store (§1.5 "Caching"), kept by the
    /// `Surface` beside its store; `None` judges with a cache of the run's own.
    pub vocabulary: Option<&'a VocabularyCache>,
    /// The instant the named points of `date()` resolve against
    /// (`spec/surface` §1.3, 4.8): the host clock, UTC, in milliseconds —
    /// the `Surface` passes the clock it stamps commits with (pinned by
    /// `OMGBASE_SPEC_CLOCK`); `None` reads the wall clock. One instant per
    /// run: the fold and the context share it.
    pub now_ms: Option<i64>,
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
    /// Unknown names (`spec/surface` §1.5, 4.6): one line per name the query
    /// reads that is neither a field of its row kind nor a property any object
    /// of that kind in the repository carries — the rows are still returned.
    /// First-reference order, deduplicated; empty = absent on the wire (never
    /// `[]`). The last member of the result.
    pub hints: Vec<String>,
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
            hints: Vec::new(),
        }
    }

    /// The wire shape: `{ hits, truncated, cursor, consumer, count?, exists?,
    /// none?, values?, hints? }` — `hints` last, only when there is one.
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
        if !self.hints.is_empty() {
            m.insert(
                "hints".to_owned(),
                Json::Array(self.hints.iter().cloned().map(Json::String).collect()),
            );
        }
        Json::Object(m)
    }
}

// ---- the `$self` rewrite -----------------------------------------------------------

/// Paths on the surface are the reference form (`spec/surface` §1 "Paths",
/// 2.0): `path` and the edge field `dst_path` read `/a/b.md`. A string
/// literal a query compares with one of them — `path == "a.md"`, `"a.md" !=
/// dst_path`,
/// `path.startsWith("lab/")` — is rooted first, so both spellings match; a
/// property or binding compared with a path is never touched (it is the
/// author's value). The planner sees the rewritten tree too, so the pushed
/// SQL and the in-memory engine agree by construction.
const PATH_ATTRIBUTES: [&str; 2] = ["path", "dst_path"];
/// The handles through which a member read reaches a ROW's `path` (`doc.path`,
/// `block.path`, a link's `dst.path`, `$it.path`); a member read through a
/// source handle (`data.path`, `frontmatter.path`) is the author's value and
/// is never rooted.
const ROW_HANDLES: [&str; 4] = ["doc", "block", "dst", "$it"];

fn is_path_read(e: &Expr) -> bool {
    match e {
        Expr::Ident { name, .. } | Expr::Outer { name, .. } => {
            PATH_ATTRIBUTES.contains(&name.as_str())
        }
        Expr::Member { recv, name, .. } if PATH_ATTRIBUTES.contains(&name.as_str()) => {
            matches!(&**recv, Expr::Ident { name, .. } | Expr::Outer { name, .. } if ROW_HANDLES.contains(&name.as_str()))
        }
        _ => false,
    }
}

/// Result projections may not overwrite the envelope (§1.4, 3.0): a projection
/// whose output key is `id` or `path` is allowed only when it IS the envelope's
/// own selection — the bare attribute of the same name, which collapses onto
/// the envelope key (`select id, path` is simply the envelope) — and is
/// otherwise a loud error asking for an alias: `select data.path` must be
/// `select p: data.path`, `select path: doc.layer` likewise. Checked over the
/// resolved items (an alias is just a name here), before the engine runs, so
/// the error never depends on the rows. A `values` projection returns no hits,
/// so the envelope — and the rule — do not apply. Same rule as the reference's
/// `envelopeCollision`.
fn envelope_collision(items: &[SelectItem]) -> Option<SurfaceError> {
    for item in items {
        let name = match item {
            SelectItem::Field { name, .. } | SelectItem::Collect { name, .. } => name.as_str(),
        };
        if name != HIT_ID && name != HIT_PATH {
            continue;
        }
        if let SelectItem::Field { expr, .. } = item
            && matches!(expr, Expr::Ident { name: n, .. } if n == name)
        {
            continue;
        }
        let hint = if name == HIT_PATH {
            "p: data.path"
        } else {
            "i: data.id"
        };
        return Some(SurfaceError::filter_invalid(
            format!("projection `{name}` collides with the hit envelope — alias it (`{hint}`)"),
            "OQX",
        ));
    }
    None
}

fn root_literal(e: Expr) -> Expr {
    match e {
        Expr::Lit {
            value: Value::Str(s),
            span,
        } => Expr::Lit {
            value: Value::Str(reference_path(&s)),
            span,
        },
        other => other,
    }
}

/// The literal-rooting rewrite of one expression (see [`rewrite_query`]).
#[must_use]
pub fn root_path_literals(e: Expr) -> Expr {
    match e {
        Expr::Binary {
            op: op @ (BinaryOp::Eq | BinaryOp::Ne),
            left,
            right,
            span,
        } => {
            if is_path_read(&left) {
                Expr::Binary {
                    op,
                    left,
                    right: Box::new(root_literal(*right)),
                    span,
                }
            } else if is_path_read(&right) {
                Expr::Binary {
                    op,
                    left: Box::new(root_literal(*left)),
                    right,
                    span,
                }
            } else {
                Expr::Binary {
                    op,
                    left,
                    right,
                    span,
                }
            }
        }
        Expr::Call {
            recv: Some(recv),
            name,
            mut args,
            span,
        } if name == "startsWith" && args.len() == 1 && is_path_read(&recv) => {
            let arg = root_literal(args.remove(0));
            Expr::Call {
                recv: Some(recv),
                name,
                args: vec![arg],
                span,
            }
        }
        other => other,
    }
}

/// Dates over literals fold to literals (`spec/surface` §1.3 "Dates and
/// durations", 4.8): `date("today")`, `dur("30 days")`, and a date method
/// whose receiver and arguments are literals (`date("today").minus(dur("30
/// days"))`, folded inside-out since `transform` maps children first) become
/// the string / number / null they evaluate to — by the SAME functions the
/// context runs, so nothing changes in meaning — before the planner sees the
/// tree. So `where updated_at < date("today")` is a text-vs-text comparison
/// the translator pushes down (a call is otherwise an unconditional decline),
/// and a named point is resolved ONCE per query, at `now_ms`. A call with the
/// wrong arity is left in place: it raises when evaluated, and an empty source
/// never evaluates it (`spec/oqx` §11).
#[must_use]
pub fn fold_dates(e: Expr, now_ms: i64) -> Expr {
    let Expr::Call {
        recv, name, args, ..
    } = &e
    else {
        return e;
    };
    let mut vals = Vec::with_capacity(args.len());
    for a in args {
        let Expr::Lit { value, .. } = a else { return e };
        vals.push(value.clone());
    }
    let folded = match recv {
        None => {
            if dates::date_function_arity(name) != Some(vals.len()) {
                return e;
            }
            dates::date_function(name, &vals, now_ms)
        }
        Some(r) => {
            let Expr::Lit { value, .. } = &**r else {
                return e;
            };
            if dates::date_method_arity(name) != Some(vals.len()) {
                return e;
            }
            dates::date_method(name, value, &vals)
        }
    };
    match folded {
        Some(Ok(v)) => build::lit(v),
        _ => e,
    }
}

/// Rewrite every row function in a parsed query to a `$self` method call,
/// root every string literal compared with a path intrinsic, and fold the
/// dates over literals ([`fold_dates`], at `now_ms`) — one `transform` over
/// the AST (`spec/oqx/AST.md` §5), every block included.
#[must_use]
pub fn rewrite_query(q: &Query, now_ms: i64) -> Query {
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
        other => fold_dates(root_path_literals(other), now_ms),
    })
}

// ---- the root row (spec/surface §1.1, 2.0) ----------------------------------------------

/// The `$repo` error (removed in surface 2.0): the same text in both engines.
pub const REPO_REMOVED_MESSAGE: &str = "`$repo` was removed in surface 2.0 — reach the repository's collections through the root row: `^docs` from a top-level row (one caret per enclosing block, or the absolute `0^docs`), and the repository id as `^id` / `0^id`";

/// The bare-target error. `depth` is the scope depth the name was read at when
/// known statically (the carets in the hint count it); `None` when raised at
/// read time by the context, where the hint spells out the rule instead.
#[must_use]
pub fn bare_target_message(t: Target, depth: Option<usize>) -> String {
    let name = t.as_str();
    let noun = t.noun();
    let carets = "^".repeat(depth.unwrap_or(1));
    let how = if depth.is_none() {
        format!("; one caret per enclosing block, or the absolute `0^{name}`")
    } else {
        String::new()
    };
    format!(
        "`{name}` inside a block reads a property of the current row, which has none — did you mean `{carets}{name}` (the repository's {noun}{how})?"
    )
}

/// The unknown-target error (3.0 name pass): a top-level `from <name>` whose
/// name is not one of the five collections would read an absent root and
/// return an empty result — refused instead, naming the collections (in the
/// root object's order, `revisions` the fifth since 4.7); `edges`, the links
/// target's name before 3.0, gets its new name spelled out.
#[must_use]
pub fn unknown_target_message(name: &str) -> String {
    let was = if name == "edges" {
        " (`edges` was renamed `links` in surface 3.0)"
    } else {
        ""
    };
    let roots: Vec<String> = crate::context::ALL_TARGETS
        .iter()
        .map(|t| format!("`{}`", t.as_str()))
        .collect();
    format!(
        "`{name}` is not a target — the repository's collections are {}{was}",
        roots.join(", ")
    )
}

/// The past-the-root error: `^docs` at the root scope (more carets than there
/// are enclosing scopes) would read absent and count 0 — refused, naming the
/// bare spelling. `levels` is the caret count written.
#[must_use]
pub fn past_root_message(t: Target, levels: usize) -> String {
    let name = t.as_str();
    let noun = t.noun();
    let carets = "^".repeat(levels);
    format!(
        "`{carets}{name}` reaches past the root — there is no enclosing row at this depth; at the top level the repository's {noun} are the bare `{name}` (`{name} count {{ … }}`, `from {name}`, `entries({name})`)"
    )
}

/// The repository is OQX's root row (`spec/oqx` 0.18): from a top-level row
/// `^docs` reaches the documents (one caret per enclosing block, or the
/// absolute `0^docs`) and `^id` the repository id. Two spellings are refused
/// before evaluation, by one walk over the parsed tree, so the error does not
/// depend on which rows the data holds and the planned and in-memory paths
/// agree trivially: `$repo` anywhere (bare, as a member head, `^$repo`,
/// `0^$repo`), and a bare `docs`/`links` at scope depth ≥ 1 — a property read
/// of a row that has none. `blocks`/`nodes` are relations of some rows
/// (`docs.blocks`, `docs.nodes`, `blocks.nodes`, `section.blocks`) and are
/// judged by the context at read time with the same message. A `^<target>`
/// with more carets than enclosing scopes (`^docs count { }` at the top level)
/// would read absent and count 0: refused too, naming the bare spelling. Port
/// of the reference's `checkRootSpellings`.
pub fn check_root_spellings(q: &Query) -> Result<()> {
    // A top-level `from <name>` that is no collection (`from edges`, the links
    // target's name before 3.0) would scan an absent root and come back empty:
    // refused, naming the five collections.
    if let Expr::Ident { name, .. } = &q.source {
        if Target::parse(name).is_none() {
            return Err(SurfaceError::filter_invalid(
                unknown_target_message(name),
                "OQX",
            ));
        }
    }
    struct Check(Option<SurfaceError>);
    impl Visitor<'_> for Check {
        fn enter(&mut self, node: Node<'_>, ctx: &VisitContext<'_>) -> bool {
            if self.0.is_some() {
                return false;
            }
            match node {
                Node::Expr(Expr::Ident { name, .. } | Expr::Outer { name, .. })
                    if name == "$repo" =>
                {
                    self.0 = Some(SurfaceError::filter_invalid(REPO_REMOVED_MESSAGE, "OQX"));
                }
                Node::Expr(Expr::Ident { name, .. })
                    if ctx.depth >= 1 && matches!(name.as_str(), "docs" | "links") =>
                {
                    let t = Target::parse(name).expect("a target name");
                    self.0 = Some(SurfaceError::filter_invalid(
                        bare_target_message(t, Some(ctx.depth)),
                        "OQX",
                    ));
                }
                Node::Expr(Expr::Outer { name, levels, .. }) if *levels > ctx.depth => {
                    if let Some(t) = Target::parse(name) {
                        self.0 = Some(SurfaceError::filter_invalid(
                            past_root_message(t, *levels),
                            "OQX",
                        ));
                    }
                }
                _ => {}
            }
            self.0.is_none()
        }
    }
    let mut check = Check(None);
    visit(Node::Query(q), &mut check);
    check.0.map_or(Ok(()), Err)
}

// ---- semantic phrases -----------------------------------------------------------------

/// Collects the distinct `semantic("…")` phrases of a tree.
struct Phrases(Vec<String>);

impl Visitor<'_> for Phrases {
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
    semantic_phrases_of(&q)
}

/// [`collect_semantic_phrases`] over a parsed tree.
#[must_use]
pub fn semantic_phrases_of(q: &Query) -> Vec<String> {
    let mut phrases = Phrases(Vec::new());
    visit(Node::Query(q), &mut phrases);
    phrases.0
}

/// Embed the query's phrases through the provider: the vectors
/// `semantic(...)` ranks by. Without a provider the phrases stay unembedded
/// and the context reports `filter_invalid` ("needs an embedding provider")
/// when one is reached — after its target check, so `semantic()` on nodes
/// names the targets (§9; the `query` tool's pre-check is what reports
/// `semantic_unavailable`).
pub fn embed_phrases(
    provider: Option<&dyn EmbeddingProvider>,
    phrases: Vec<String>,
) -> Result<HashMap<String, SemanticVec>> {
    let mut semantic: HashMap<String, SemanticVec> = HashMap::new();
    if let Some(provider) = provider.filter(|_| !phrases.is_empty()) {
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
    Ok(semantic)
}

// ---- reserved projection names ----------------------------------------------------------

/// The runner's own projection names (`__oqx_id`, `__oqx_path`,
/// `__oqx_self`, `__oqx_value`) and the selector compiler's slots
/// (`__omg_sel_<t>_<slot>`, [`crate::select`]) share two reserved prefixes.
/// A user alias under either would shadow an injected item (`select
/// __oqx_id: 1` overwrote the hit's `id` through 4.0) or collide with a
/// slot, so it is refused before anything runs (4.1) — over the query's own
/// top-level items, the only ones the runner injects beside. The reference's
/// `reservedAlias`.
pub const RESERVED_ALIAS_PREFIXES: [&str; 2] = ["__oqx_", "__omg_"];

/// Refuse a top-level `select` alias under a reserved prefix.
pub fn check_reserved_aliases(q: &Query) -> Result<()> {
    for item in &q.select {
        if let Some(prefix) = RESERVED_ALIAS_PREFIXES
            .iter()
            .find(|p| item.name().starts_with(*p))
        {
            return Err(SurfaceError::filter_invalid(
                format!(
                    "projection `{}` uses the reserved prefix `{prefix}` — choose another alias",
                    item.name()
                ),
                "OQX",
            ));
        }
    }
    Ok(())
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
    impl Visitor<'_> for Mentions<'_> {
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
/// re-projection, or a source that is not a bare root scan (one of the five
/// collections, `revisions` included — the planner's `compile` is narrower:
/// the four it can push down).
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
            "a hit must be a document, block, node, link or revision row — the query reached {}; to follow document references held in a property use refs(<field>)",
            describe_value(v)
        ),
        "OQX",
    )
}

/// A shaped row (the reference's `Shaped`, 4.2): the identity the runner
/// injected, kept APART from the user projection until the very end, so
/// `distinct`, the keyset page and the cursor run on identity whether or not
/// the hits carry it (`bare`). `id` is JavaScript's `String()` on the injected
/// id, `path` `""` for an absent path; `proj` is the user projection with its
/// values rendered per §1.4 "rows as values" (a store row nested in the result
/// — an empty-projection `collect { }` and friends — becomes `{ id, path }`).
/// When the row itself was projected under [`SELF_KEY`] and is not a store
/// row, the query fails (§1.4: a hit is a store row).
#[derive(Debug)]
struct Shaped {
    id: String,
    path: String,
    proj: oqx::Object,
}

fn path_string(path: &Value) -> String {
    if path.is_absent() {
        String::new()
    } else {
        path.to_string()
    }
}

fn shape_row(row: Value) -> Result<Shaped> {
    let mut shaped = Shaped {
        id: Value::Undefined.to_string(),
        path: String::new(),
        proj: oqx::Object::new(),
    };
    let Value::Object(mut o) = row else {
        return Ok(shaped);
    };
    if let Some(me) = o.remove(SELF_KEY)
        && target_of(&me).is_none()
    {
        return Err(not_a_store_row(&me));
    }
    let Value::Object(o) = render_row_values(Value::Object(o)) else {
        return Ok(shaped);
    };
    for (k, v) in o {
        match k.as_str() {
            ID_KEY => shaped.id = v.to_string(),
            PATH_KEY => shaped.path = path_string(&v),
            _ => {
                shaped.proj.insert(k, v);
            }
        }
    }
    Ok(shaped)
}

/// The identity of a row the engine produced, read off the injected columns
/// without shaping it — exactly the strings [`shape_row`] would carry — so an
/// unshaped page can be cut by the keyset cursor before shaping (a scan that
/// projects thousands of rows shapes fifty).
fn raw_identity(row: &Value) -> (String, String) {
    let get = |k: &str| {
        row.as_object()
            .and_then(|o| o.get(k))
            .cloned()
            .unwrap_or(Value::Undefined)
    };
    (path_string(&get(PATH_KEY)), get(ID_KEY).to_string())
}

/// A hit: `{ id, path, ...proj }` (§1.4, 3.0: the envelope keys are the
/// attributes that read them). The envelope keys lead; a user projection of
/// `id`/`path` collapses onto them in place (the same value, read by the
/// same attribute).
fn to_hit(s: Shaped) -> Value {
    let mut hit = oqx::Object::with_capacity(s.proj.len() + 2);
    hit.insert(HIT_ID, Value::Str(s.id));
    hit.insert(HIT_PATH, Value::Str(s.path));
    for (k, v) in s.proj {
        hit.insert(k, v);
    }
    Value::Object(hit)
}

/// `bare` (§1.4, 4.2): the projection alone, in the query's own order. A
/// projected `id`/`path` is an ordinary column here — the intrinsic the
/// attribute reads, under the key the query gave it — and nothing is injected
/// beside it.
fn to_bare_hit(s: Shaped) -> Value {
    Value::Object(s.proj)
}

/// The wire shape of one shaped row: the hit, or the bare hit.
fn render_hit(s: Shaped, bare: bool) -> Json {
    if bare {
        to_bare_hit(s).to_canonical_json()
    } else {
        to_hit(s).to_canonical_json()
    }
}

/// Top-level `select distinct`: dedup by the USER projection — every field but
/// the envelope's `id`/`path`, which a projection of the attribute collapses
/// onto (so `select distinct id` dedups on nothing but the empty projection,
/// as it always has); under `bare` there is no envelope, so a projected
/// `id`/`path` IS part of the projection and counts. Keeps the first (so the
/// retained row carries a real identity), order-preserving. The key is the
/// canonical JSON of the sorted `[key, value]` pairs (`JSON.stringify` in the
/// reference).
fn dedup_by_projection(rows: Vec<Shaped>, bare: bool) -> Vec<Shaped> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for s in rows {
        let mut pairs: Vec<(String, Value)> = s
            .proj
            .iter()
            .filter(|(k, _)| bare || (*k != HIT_ID && *k != HIT_PATH))
            .map(|(k, v)| (k.to_owned(), v.clone()))
            .collect();
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
        out.push(s);
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

/// The collect page over `rows`, whatever their representation — `ident`
/// yields a row's `(path, id)`: the query's own `offset`/`limit` define the
/// result SET, the keyset `cursor` (when given) cuts it, `cap` pages it.
/// Returns the page, whether more rows followed, and the next cursor (none
/// under a custom order, §1.4).
fn page_rows<T>(
    mut rows: Vec<T>,
    ident: impl Fn(&T) -> (String, String),
    offset: usize,
    limit: Option<usize>,
    cursor: Option<&str>,
    cap: usize,
    custom: bool,
) -> Result<(Vec<T>, bool, Option<String>)> {
    if offset > 0 || limit.is_some() {
        let end = limit.map_or(rows.len(), |l| (offset + l).min(rows.len()));
        if offset >= rows.len() {
            rows.clear();
        } else {
            rows.truncate(end);
            rows.drain(..offset);
        }
    }
    if let Some(cursor) = cursor {
        // The cursor carries the hit's (rooted) path; a 1.x cursor is refused (§1.4).
        let parts = decode_path_cursor(cursor, "query", 2)?;
        let (path, id) = (&parts[0], &parts[1]);
        rows.retain(|r| {
            let (rp, ri) = ident(r);
            rp > *path || (rp == *path && ri > *id)
        });
    }
    let truncated = rows.len() > cap;
    rows.truncate(cap);
    let next = if truncated && !custom {
        rows.last().map(|last| {
            let (p, i) = ident(last);
            encode_cursor(&[&p, &i])
        })
    } else {
        None
    };
    Ok((rows, truncated, next))
}

fn value_of(s: &Shaped) -> Json {
    s.proj
        .get(VALUE_KEY)
        .cloned()
        .unwrap_or(Value::Undefined)
        .to_canonical_json()
}

/// `bare: true` needs a projection and is not the `values` form (§1.4, 4.2):
/// without a projection a hit is only its envelope, and `values` is already
/// the bare-values form. Checked over the resolved query where hits are built
/// (the scalar consumers have no hits and ignore `bare`), before the engine
/// runs, so the error never depends on the rows and the planned and in-memory
/// paths agree trivially. The reference's `bareMisuse`.
pub fn check_bare(q: &Query) -> Result<()> {
    if q.values {
        return Err(SurfaceError::filter_invalid(
            BARE_WITH_VALUES_MESSAGE,
            "OQX",
        ));
    }
    if q.select.is_empty() {
        return Err(SurfaceError::filter_invalid(
            BARE_NEEDS_SELECT_MESSAGE,
            "OQX",
        ));
    }
    Ok(())
}

/// The `bare` refusals (4.2): the same text in both engines.
pub const BARE_NEEDS_SELECT_MESSAGE: &str =
    "`bare` needs a `select` — without a projection a hit is only its envelope";
pub const BARE_WITH_VALUES_MESSAGE: &str =
    "`bare` is redundant with `values` — `values` is already the bare-values form; drop one";

// ---- the run --------------------------------------------------------------------------

/// Run an OQX query against `repo_id` (§1.4).
pub fn query(
    store: &Store,
    repo_id: &str,
    source: &str,
    opts: QueryOptions<'_>,
) -> Result<OqxResult> {
    let semantic = embed_phrases(opts.provider, collect_semantic_phrases(source))?;
    let runner = Runner {
        store,
        repo_id,
        semantic,
        planned: !opts.in_memory,
        now_ms: opts.now_ms.unwrap_or_else(dates::wall_clock_ms),
    };
    let raw = oqx::parse_string(source)?;
    check_reserved_aliases(&raw)?;
    // The source entry is every read: a tier-3 name on an open kind is a hint.
    run_parsed(
        &runner,
        &raw,
        opts,
        opts.unknown_names.unwrap_or(UnknownNames::Hint),
    )
}

/// Run an already-parsed query (§1.4) — the AST entry the selector compile
/// uses (`spec/mutate` §11.8: the selector's tree with the templates' slot
/// projections appended runs as any query does; the reserved-alias check is
/// the source entry's, so the appended `__omg_sel_*` items pass). `semantic`
/// holds the embedded phrases ([`embed_phrases`]); `opts.provider` is not
/// read here. Unknown names (4.6) default to [`UnknownNames::Refuse`] here:
/// this entry's caller is the write selector, where a name no row carries
/// would select every row; the source entry passes `Hint`.
pub fn query_ast(
    store: &Store,
    repo_id: &str,
    raw: &Query,
    opts: QueryOptions<'_>,
    semantic: HashMap<String, SemanticVec>,
) -> Result<OqxResult> {
    let runner = Runner {
        store,
        repo_id,
        semantic,
        planned: !opts.in_memory,
        now_ms: opts.now_ms.unwrap_or_else(dates::wall_clock_ms),
    };
    run_parsed(
        &runner,
        raw,
        opts,
        opts.unknown_names.unwrap_or(UnknownNames::Refuse),
    )
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
    /// The one instant of this run (§1.3): the fold and the context share it.
    now_ms: i64,
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
        let ctx =
            StoreContext::new(conn, self.repo_id, self.semantic.clone()).with_now_ms(self.now_ms);
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
        // A root scan projected as a VALUE (`select all: ^docs`) was
        // materialized into its rows by the engine (`DataContext::materialize`).
        Ok(out?)
    }
}

fn run_parsed(
    engine: &Runner<'_>,
    raw: &Query,
    opts: QueryOptions<'_>,
    mode: UnknownNames,
) -> Result<OqxResult> {
    check_root_spellings(raw)?;
    // Unknown names (spec/surface §1.5): judged over the RAW tree — before
    // alias resolution and the runner's own items — so an alias is never
    // mistaken for a row property and the verdict never depends on the rows.
    // The selector compiler's slot items (`__omg_sel_*`, the templates'
    // expressions) are not the selector: an expression reading an absent
    // property there is spec/mutate's `target_missing` / absent value, not an
    // unknown name.
    let own = Query {
        select: raw
            .select
            .iter()
            .filter(|it| {
                !RESERVED_ALIAS_PREFIXES
                    .iter()
                    .any(|p| it.name().starts_with(p))
            })
            .cloned()
            .collect(),
        ..raw.clone()
    };
    let local = VocabularyCache::default();
    let cache = opts.vocabulary.unwrap_or(&local);
    let hints = check_names(engine.store, engine.repo_id, &own, mode, cache)?;
    let mut result = run_resolved(engine, raw, opts)?;
    // `hints` is the last member, present only when there is something to say.
    result.hints = hints;
    Ok(result)
}

fn run_resolved(engine: &Runner<'_>, raw: &Query, opts: QueryOptions<'_>) -> Result<OqxResult> {
    // The query's `select` aliases are resolved HERE, once, before the runner
    // renames/injects items (an engine evaluates the query it is given).
    let parsed = rewrite_query(&resolve_aliases(raw)?, engine.now_ms);
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
    // `bare` (4.2): the hits are the projection alone — refused without one
    // and with `values`; with no envelope there is no collision to refuse
    // either, a projected `id`/`path` is simply a column.
    let bare = opts.bare;
    if bare {
        check_bare(&parsed)?;
    } else if !top_values && let Some(e) = envelope_collision(&user_select) {
        return Err(e);
    }
    let id_item = build::field(ID_KEY, build::ident("id"));
    let path_item = build::field(PATH_KEY, build::ident("path"));
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
                let shaped = shape_row(r)?;
                if top_values {
                    out.values = Some(vec![value_of(&shaped)]);
                } else {
                    out.hits = vec![render_hit(shaped, bare)];
                }
            }
        }
        return Ok(out);
    }

    // collect: keyset pagination on (path, id) when the order is the default.
    let rows: Vec<Value> = match res {
        oqx::OqxResult::Collect(rows) => rows,
        _ => Vec::new(),
    };
    let custom = parsed.order_by.as_ref().is_some_and(|o| !o.is_empty());
    let cursor = opts.cursor.filter(|c| !c.is_empty() && !custom);
    let offset = const_bound(top_offset.as_ref(), "offset")?.unwrap_or(0);
    let limit = const_bound(top_limit.as_ref(), "limit")?;
    let cap = opts.limit.unwrap_or(DEFAULT_LIMIT);
    // The page runs on IDENTITY, never on the hit: a `distinct` needs every
    // row shaped first (its key is the projection), else the plain rows are
    // paged by their injected columns and only the page is shaped. The
    // envelope is stripped LAST (`bare`), so a bare result pages exactly like
    // the enveloped one.
    let (page, truncated, next) = if top_distinct {
        let shaped = rows
            .into_iter()
            .map(shape_row)
            .collect::<Result<Vec<_>>>()?;
        let shaped = dedup_by_projection(shaped, bare);
        page_rows(
            shaped,
            |s| (s.path.clone(), s.id.clone()),
            offset,
            limit,
            cursor,
            cap,
            custom,
        )?
    } else {
        let (page, truncated, next) =
            page_rows(rows, raw_identity, offset, limit, cursor, cap, custom)?;
        let page = page
            .into_iter()
            .map(shape_row)
            .collect::<Result<Vec<_>>>()?;
        (page, truncated, next)
    };
    let mut out = OqxResult::scalar(Consumer::Collect);
    out.truncated = truncated;
    out.cursor = next;
    if top_values {
        out.values = Some(page.iter().map(value_of).collect());
    } else {
        out.hits = page.into_iter().map(|s| render_hit(s, bare)).collect();
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
            "from blocks where text(\"x\") && under_heading(\"h\") && size(attrs) > 0 && doc.path.startsWith(\"a\")",
        )
        .unwrap();
        let r = rewrite_query(&q, 0);
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

    // ---- the constant fold (spec/surface §1.3, 4.8; the reference's dates.test.ts) ----

    /// 2026-09-27T00:00:00.000Z — the corpus clock.
    const NOW: i64 = 1_790_467_200_000;

    fn where_expr(src: &str) -> Expr {
        let q = oqx::parse_string(&format!("from docs where {src}")).unwrap();
        let Some(Where::Scalar { expr, .. }) = q.r#where else {
            panic!("not a scalar where")
        };
        expr
    }

    /// Fold inside-out as `transform` does: children first.
    fn fold(src: &str) -> Expr {
        fn go(e: Expr) -> Expr {
            match e {
                Expr::Call {
                    recv,
                    name,
                    args,
                    span,
                } => fold_dates(
                    Expr::Call {
                        recv: recv.map(|r| Box::new(go(*r))),
                        name,
                        args: args.into_iter().map(go).collect(),
                        span,
                    },
                    NOW,
                ),
                other => other,
            }
        }
        go(where_expr(src))
    }

    fn lit(e: &Expr) -> Option<&Value> {
        match e {
            Expr::Lit { value, .. } => Some(value),
            _ => None,
        }
    }

    #[test]
    fn folds_date_dur_over_literals_and_date_methods_over_literal_receivers_and_arguments() {
        assert_eq!(
            lit(&fold("date(\"2026-01-05\")")),
            Some(&Value::from("2026-01-05"))
        );
        assert_eq!(
            lit(&fold("date(\"today\")")),
            Some(&Value::from("2026-09-27"))
        );
        assert_eq!(
            lit(&fold("dur(\"30 days\")")),
            Some(&Value::from(30.0 * 86400.0))
        );
        assert_eq!(
            lit(&fold("date(\"today\").minus(dur(\"30 days\"))")),
            Some(&Value::from("2026-08-28"))
        );
        assert_eq!(lit(&fold("date(\"x\")")), Some(&Value::Null));
        assert_eq!(lit(&fold("date(5)")), Some(&Value::Null));
        assert_eq!(lit(&fold("dur(60).dur_text()")), Some(&Value::from("1m")));
    }

    #[test]
    fn leaves_a_non_literal_argument_an_unknown_name_and_a_wrong_arity_in_place() {
        for src in [
            "date(when)",
            "date(\"today\").until(when)",
            "size(\"x\")",
            "date()",
            "date(\"2026-01-01\").plus()",
            "\"x\".lower()",
        ] {
            assert!(matches!(fold(src), Expr::Call { .. }), "{src}");
        }
    }

    #[test]
    fn the_runner_folds_at_its_clock_so_a_named_point_pushes_down() {
        let q = oqx::parse_string("from docs where updated_at < date(\"today\") && date(when) < date(\"today\").minus(dur(\"30 days\"))").unwrap();
        let printed = oqx::print_query(&rewrite_query(&q, NOW)).unwrap();
        assert!(printed.contains("updated_at < \"2026-09-27\""), "{printed}");
        assert!(printed.contains("date(when) < \"2026-08-28\""), "{printed}");
    }

    #[test]
    fn path_literals_are_rooted_only_against_path_reads() {
        let q = oqx::parse_string(
            "select n: ^docs collect { path where path == ^after || \"x.md\" != dst_path } from docs where path.startsWith(\"lab/\") && doc.path == \"a.md\" && type == \"a.md\" && ^path == \"b.md\"",
        )
        .unwrap();
        let printed = oqx::print_query(&rewrite_query(&q, 0)).unwrap();
        assert!(printed.contains("path.startsWith(\"/lab/\")"), "{printed}");
        assert!(printed.contains("doc.path == \"/a.md\""), "{printed}");
        assert!(printed.contains("type == \"a.md\""), "{printed}");
        assert!(printed.contains("^path == \"/b.md\""), "{printed}");
        assert!(printed.contains("\"/x.md\" != dst_path"), "{printed}");
        // a property compared with a path is the author's value: untouched
        assert!(printed.contains("path == ^after"), "{printed}");
        // `contains`/`endsWith`/`matches` and the empty string are literal
        let q = oqx::parse_string(
            "from docs where path.contains(\"a/\") && path.endsWith(\".md\") && path == \"\"",
        )
        .unwrap();
        let printed = oqx::print_query(&rewrite_query(&q, 0)).unwrap();
        assert!(printed.contains("path.contains(\"a/\")"), "{printed}");
        assert!(printed.contains("path.endsWith(\".md\")"), "{printed}");
        assert!(printed.contains("path == \"/\""), "{printed}");
    }

    #[test]
    fn repo_and_bare_targets_are_refused_statically() {
        let parse = |s: &str| oqx::parse_string(s).unwrap();
        for q in [
            "from docs where $repo",
            "select r: size($repo.docs) from docs",
            "select r: $repo.id from docs",
            "select r: nodes first { select x: ^$repo.id values } from docs",
            "select r: nodes first { select x: 0^$repo values } from docs",
            "$repo.docs count { }",
        ] {
            let e = check_root_spellings(&parse(q)).unwrap_err();
            assert_eq!(e.code, "filter_invalid", "{q}");
            assert_eq!(e.message, REPO_REMOVED_MESSAGE, "{q}");
        }
        // a bare `docs`/`links` at depth ≥ 1; the hint counts the carets
        let e = check_root_spellings(&parse("select x: docs collect { } from docs")).unwrap_err();
        assert_eq!(e.message, bare_target_message(Target::Docs, Some(1)));
        assert!(
            e.message
                .contains("did you mean `^docs` (the repository's documents)?")
        );
        let e = check_root_spellings(&parse(
            "select x: nodes collect { select y: size(links) } from docs",
        ))
        .unwrap_err();
        assert!(
            e.message
                .contains("did you mean `^^links` (the repository's links)?")
        );
        let e = check_root_spellings(&parse("docs collect { from docs }")).unwrap_err();
        assert!(e.message.contains("`^docs`"));
        // the root scope is depth 0: a bare target there is the scan
        for q in [
            "docs count { }",
            "from docs where nodes exists { }",
            "entries(docs) first { }",
            "select n: size(^docs), id: ^id, k: size(0^links) from docs",
            "from blocks where blocks exists { }", // judged by the context at read time
        ] {
            check_root_spellings(&parse(q)).unwrap_or_else(|e| panic!("{q}: {e}"));
        }
        // a `^target` reaching past the root
        let e = check_root_spellings(&parse("^docs count { }")).unwrap_err();
        assert_eq!(e.message, past_root_message(Target::Docs, 1));
        assert_eq!(
            e.message,
            "`^docs` reaches past the root — there is no enclosing row at this depth; at the top level the repository's documents are the bare `docs` (`docs count { … }`, `from docs`, `entries(docs)`)"
        );
        let e = check_root_spellings(&parse("select path from docs where ^^links exists { }"))
            .unwrap_err();
        assert!(
            e.message.contains("`^^links` reaches past the root"),
            "{}",
            e.message
        );
        // the read-time message spells out the rule
        let m = bare_target_message(Target::Blocks, None);
        assert!(m.contains("did you mean `^blocks` (the repository's blocks; one caret per enclosing block, or the absolute `0^blocks`)?"), "{m}");
    }

    #[test]
    fn reserved_projection_names_are_refused() {
        let parse = |s: &str| oqx::parse_string(s).unwrap();
        let e = check_reserved_aliases(&parse("select __oqx_id: 1 from docs")).unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(
            e.message,
            "projection `__oqx_id` uses the reserved prefix `__oqx_` — choose another alias"
        );
        assert_eq!(e.data.as_ref().unwrap()["hint"], "OQX");
        let e = check_reserved_aliases(&parse("select __omg_sel_0_x: 1 from docs")).unwrap_err();
        assert!(
            e.message.contains("reserved prefix `__omg_`"),
            "{}",
            e.message
        );
        // only the top level: the runner injects beside those items alone
        assert!(
            check_reserved_aliases(&parse(
                "select __oqx: 1, x: nodes collect { select __oqx_y: 1 } from docs"
            ))
            .is_ok()
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
        let shaped = shape_row(Value::Object(o)).unwrap();
        assert_eq!((shaped.id.as_str(), shaped.path.as_str()), ("d_1", ""));
        let hit = to_hit(shaped);
        let ho = hit.as_object().unwrap();
        assert_eq!(ho.keys().collect::<Vec<_>>(), ["id", "path", "layer"]);
        assert_eq!(ho.get("path"), Some(&Value::Str(String::new())));
        // A user projection of `id` collapses onto the envelope key in place
        // (3.0): same position, the projected value.
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Str("d_1".into()));
        o.insert(PATH_KEY, Value::Str("a.md".into()));
        o.insert("id", Value::Number(7.0));
        let hit = to_hit(shape_row(Value::Object(o)).unwrap());
        let ho = hit.as_object().unwrap();
        assert_eq!(ho.keys().collect::<Vec<_>>(), ["id", "path"]);
        assert_eq!(ho.get("id"), Some(&Value::Number(7.0)));
        // The unshaped row's identity reads the same strings.
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Str("d_1".into()));
        o.insert(PATH_KEY, Value::Undefined);
        let row = Value::Object(o);
        assert_eq!(raw_identity(&row), (String::new(), "d_1".to_owned()));
        let shaped = shape_row(row).unwrap();
        assert_eq!((shaped.path, shaped.id), (String::new(), "d_1".to_owned()));
    }

    #[test]
    fn bare_hits_are_the_projection_in_its_own_order() {
        // `select title, id`: the projected intrinsic under the query's key, in
        // the query's order — nothing injected beside it.
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Str("d_1".into()));
        o.insert(PATH_KEY, Value::Str("/a.md".into()));
        o.insert("title", Value::Str("T".into()));
        o.insert("id", Value::Str("d_1".into()));
        let shaped = shape_row(Value::Object(o)).unwrap();
        let bare = to_bare_hit(shaped);
        let bo = bare.as_object().unwrap();
        assert_eq!(bo.keys().collect::<Vec<_>>(), ["title", "id"]);
        // `select path: layer` is fine bare (no envelope to collide with) and
        // the identity the page runs on is still the row's own path.
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Str("d_1".into()));
        o.insert(PATH_KEY, Value::Str("/a.md".into()));
        o.insert("path", Value::Str("canon".into()));
        let shaped = shape_row(Value::Object(o)).unwrap();
        assert_eq!(shaped.path, "/a.md");
        assert_eq!(
            render_hit(shaped, true),
            serde_json::json!({ "path": "canon" })
        );
        // the same row, enveloped: the user's value collapses onto the key
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Str("d_1".into()));
        o.insert(PATH_KEY, Value::Str("/a.md".into()));
        o.insert("path", Value::Str("/a.md".into()));
        assert_eq!(
            render_hit(shape_row(Value::Object(o)).unwrap(), false),
            serde_json::json!({ "id": "d_1", "path": "/a.md" })
        );
    }

    #[test]
    fn bare_needs_a_select_and_is_not_the_values_form() {
        let parse = |s: &str| oqx::parse_string(s).unwrap();
        for q in ["from docs", "from docs where layer == \"canon\""] {
            let e = check_bare(&parse(q)).unwrap_err();
            assert_eq!(e.code, "filter_invalid", "{q}");
            assert_eq!(e.message, BARE_NEEDS_SELECT_MESSAGE, "{q}");
            assert_eq!(e.data.as_ref().unwrap()["hint"], "OQX");
        }
        let e = check_bare(&parse("select path values from docs")).unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(e.message, BARE_WITH_VALUES_MESSAGE);
        for q in [
            "select path from docs",
            "select id, title from docs",
            "docs first { select t: title }",
        ] {
            check_bare(&parse(q)).unwrap_or_else(|e| panic!("{q}: {e}"));
        }
    }

    #[test]
    fn a_projection_onto_the_envelope_must_be_aliased() {
        let items = |src: &str| oqx::parse_string(src).unwrap().select;
        // the attribute itself collapses (allowed)
        assert!(envelope_collision(&items("select id, path from docs")).is_none());
        assert!(
            envelope_collision(&items("select id: id, path: path, p: path from docs")).is_none()
        );
        // anything else landing on `id`/`path` is the error, first offender first
        let e = envelope_collision(&items("select data.path from docs")).unwrap();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(
            e.message,
            "projection `path` collides with the hit envelope — alias it (`p: data.path`)"
        );
        let e = envelope_collision(&items("select id: layer from docs")).unwrap();
        assert_eq!(
            e.message,
            "projection `id` collides with the hit envelope — alias it (`i: data.id`)"
        );
        assert!(envelope_collision(&items("select path: doc.path from blocks")).is_some());
        assert!(envelope_collision(&items("select path: nodes collect { } from docs")).is_some());
    }

    #[test]
    fn a_path_read_is_the_attribute_or_a_row_handle_never_a_source_handle() {
        let pred = |src: &str| match oqx::parse_string(src).unwrap().r#where.unwrap() {
            oqx::ast::Where::Scalar { expr, .. } => expr,
            other => panic!("{other:?}"),
        };
        let left = |e: Expr| match e {
            Expr::Binary { left, .. } => *left,
            other => panic!("{other:?}"),
        };
        assert!(is_path_read(&left(pred("from docs where path == \"x\""))));
        assert!(is_path_read(&left(pred(
            "from blocks where doc.path == \"x\""
        ))));
        assert!(is_path_read(&left(pred("from docs where ^path == \"x\""))));
        assert!(is_path_read(&left(pred(
            "from links where dst_path == \"x\""
        ))));
        assert!(!is_path_read(&left(pred(
            "from docs where data.path == \"x\""
        ))));
        assert!(!is_path_read(&left(pred(
            "from docs where frontmatter.path == \"x\""
        ))));
    }

    #[test]
    fn a_hit_that_is_not_a_store_row_fails_the_query() {
        // The row itself rides under SELF_KEY when the query can reach a
        // non-row; a string there is the `follow before` shape (§1.4, 1.5).
        let mut o = oqx::Object::new();
        o.insert(ID_KEY, Value::Undefined);
        o.insert(PATH_KEY, Value::Undefined);
        o.insert(SELF_KEY, Value::Str("/timeline/kickoff.md".into()));
        let e = shape_row(Value::Object(o)).unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(
            e.message,
            "a hit must be a document, block, node, link or revision row — the query reached a string (\"/timeline/kickoff.md\"); to follow document references held in a property use refs(<field>)"
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
        let hit = to_hit(shape_row(Value::Object(o)).unwrap());
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
            let mut proj = oqx::Object::new();
            proj.insert("type", Value::Str(t.into()));
            Shaped {
                id: id.to_owned(),
                path: "p".to_owned(),
                proj,
            }
        };
        let out = dedup_by_projection(vec![mk("1", "a"), mk("2", "b"), mk("3", "a")], false);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "1");
        assert_eq!(out[1].id, "2");
        // A projected `id` is the envelope's own selection: not part of the key
        // enveloped (`select distinct id` dedups on the empty projection), part
        // of it bare (there is no envelope — it is the projection).
        let with_id = |id: &str| {
            let mut proj = oqx::Object::new();
            proj.insert("id", Value::Str(id.into()));
            Shaped {
                id: id.to_owned(),
                path: "p".to_owned(),
                proj,
            }
        };
        assert_eq!(
            dedup_by_projection(vec![with_id("1"), with_id("2")], false).len(),
            1
        );
        assert_eq!(
            dedup_by_projection(vec![with_id("1"), with_id("2")], true).len(),
            2
        );
    }

    #[test]
    fn the_page_runs_on_identity() {
        let rows: Vec<(String, String)> = [("/a.md", "d_1"), ("/a.md", "d_2"), ("/b.md", "d_3")]
            .iter()
            .map(|(p, i)| ((*p).to_owned(), (*i).to_owned()))
            .collect();
        let ident = |r: &(String, String)| (r.0.clone(), r.1.clone());
        // cap 2: truncated, the cursor is the last row's (path, id)
        let (page, truncated, next) =
            page_rows(rows.clone(), ident, 0, None, None, 2, false).unwrap();
        assert_eq!(page.len(), 2);
        assert!(truncated);
        let next = next.expect("a cursor");
        assert_eq!(next, encode_cursor(&["/a.md", "d_2"]));
        // the cursor resumes after it
        let (page, truncated, next) =
            page_rows(rows.clone(), ident, 0, None, Some(&next), 2, false).unwrap();
        assert_eq!(page, vec![("/b.md".to_owned(), "d_3".to_owned())]);
        assert!(!truncated && next.is_none());
        // the query's own offset/limit define the set; a custom order has no cursor
        let (page, truncated, next) =
            page_rows(rows.clone(), ident, 1, Some(1), None, 50, true).unwrap();
        assert_eq!(page, vec![("/a.md".to_owned(), "d_2".to_owned())]);
        assert!(!truncated && next.is_none());
        let (page, truncated, next) = page_rows(rows, ident, 0, None, None, 1, true).unwrap();
        assert_eq!(page.len(), 1);
        assert!(truncated && next.is_none());
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
