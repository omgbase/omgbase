//! The tier-3 pushdown planner: reduces the row set a query scans by
//! translating its pushable top-level `where` conjuncts into ONE SQL
//! statement against the store, then handing the produced rows (plus the
//! untranslatable residual) back to the in-memory engine to finish. Port of
//! `packages/core/src/oqx-js/planner.ts` over the [`oqx`] seam
//! ([`QueryPlanner`], [`Plan`], [`oqx::partition_pushable`],
//! [`oqx::residual_query`], [`oqx::ROWS_ROOT`]).
//!
//! Correctness is guaranteed by the residual fallback — anything
//! [`crate::translate`] declines stays in-memory — and verified by the
//! differential gate (planned == in-memory over every corpus-backed query
//! case and the conformance list). Deliberately conservative: only simple
//! top-level target scans (no `follow`, no `from E` re-projection) whose
//! source is a bare `docs|blocks|nodes|edges` or `$repo.<target>`, with at
//! least one pushable scalar conjunct, are planned; everything else declines
//! to a full in-memory run.
//!
//! One shape difference from the reference, forced by ownership: the
//! reference attaches a store context to its plan (`makeStoreContext(…,
//! rowsRoot)`), but a [`crate::StoreContext`] borrows the store's connection
//! and `Plan::context` must be `'static`, so the plan carries no context and
//! the runner ([`mod@crate::query`]) builds the rows-root context itself
//! ([`crate::StoreContext::with_rows_root`]) — the same six lines
//! `oqx::PlannedEngine::run` would execute.

use oqx::Consumer;
use oqx::ast::{Expr, Follow, FollowDestination, OpNode, Query, SelectItem, Subquery, Where};
use oqx::{Plan, QueryPlanner, Value, partition_pushable, residual_query};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;

use crate::context::{Target, fetch_rows, tag_rows};
use crate::translate::{RESERVED_DOC_BASENAMES, TranslateCtx, translate_predicate};

/// The SQL aliases of the scanned row (`self`) and its owning doc (`doc`).
fn aliases(t: Target) -> (&'static str, &'static str) {
    match t {
        Target::Docs => ("d", "d"),
        Target::Blocks => ("b", "d"),
        Target::Nodes => ("n", "d"),
        Target::Edges => ("e", "d"),
    }
}

pub(crate) fn from_clause(t: Target) -> &'static str {
    match t {
        Target::Docs => "docs d",
        Target::Blocks => "blocks b JOIN docs d ON d.doc_id = b.doc_id",
        Target::Nodes => "nodes n JOIN docs d ON d.doc_id = n.doc_id",
        Target::Edges => "edges e JOIN docs d ON d.doc_id = e.src_doc",
    }
}

/// Row columns + the owning-doc path as `__path` (matches the context's
/// roots so produced rows are indistinguishable from a full scan's).
pub(crate) fn columns(t: Target) -> &'static str {
    match t {
        Target::Docs => "d.*",
        Target::Blocks => "b.*, d.path AS __path",
        Target::Nodes => "n.*, d.path AS __path",
        Target::Edges => "e.*, d.path AS __path",
    }
}

/// The root order (`spec/surface` §1.1).
pub(crate) fn order_clause(t: Target) -> &'static str {
    match t {
        Target::Docs => "d.path, d.doc_id",
        Target::Blocks => "d.path, b.block_id",
        Target::Nodes => "d.path, n.node_id",
        Target::Edges => "d.path, e.edge_id",
    }
}

/// The liveness guards of the root scan, with the repo id bound.
pub(crate) fn guards(t: Target) -> &'static str {
    match t {
        Target::Docs => "d.repo_id = ? AND d.deleted_commit IS NULL",
        Target::Blocks => "b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL",
        Target::Nodes => "n.repo_id = ? AND d.deleted_commit IS NULL",
        Target::Edges => "e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL",
    }
}

/// The joined targets driven FROM the document: the same rows and columns as
/// [`from_clause`], with the loop order fixed by `CROSS JOIN` so a predicate on
/// the document (`d.path = ?`) is the outer search and the target's rows are
/// reached through their `doc_id` / `src_doc` index (the store indexes'
/// `$path` probes). [`guards_by_doc`] goes with it; `Docs` is `from_clause`.
pub(crate) fn from_by_doc(t: Target) -> &'static str {
    match t {
        Target::Docs => from_clause(t),
        Target::Blocks => "docs d CROSS JOIN blocks b ON b.doc_id = d.doc_id",
        Target::Nodes => "docs d CROSS JOIN nodes n ON n.doc_id = d.doc_id",
        Target::Edges => "docs d CROSS JOIN edges e ON e.src_doc = d.doc_id",
    }
}

/// [`guards`] for a [`from_by_doc`] statement: the same tests, with the
/// document's repo first and the target's repo term behind SQLite's unary `+`
/// so it stays a filter and never selects a `(repo_id, …)` index over the
/// `doc_id` one. Two repo-id binds (`Docs`: one, as `guards`).
pub(crate) fn guards_by_doc(t: Target) -> &'static str {
    match t {
        Target::Docs => guards(t),
        Target::Blocks => {
            "d.repo_id = ? AND +b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL"
        }
        Target::Nodes => "d.repo_id = ? AND +n.repo_id = ? AND d.deleted_commit IS NULL",
        Target::Edges => {
            "d.repo_id = ? AND +e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL"
        }
    }
}

/// The root collection a query scans, if it is a bare `docs|blocks|nodes|edges`
/// or `$repo.<target>` source (else `None` — not a pushable shape).
fn root_target(source: &Expr) -> Option<Target> {
    match source {
        Expr::Ident { name, .. } => Target::parse(name),
        Expr::Member { recv, name, .. } => match &**recv {
            Expr::Ident { name: r, .. } if r == "$repo" => Target::parse(name),
            _ => None,
        },
        _ => None,
    }
}

// ---- the residual-error decline (surface 1.1 patch, §1) ---------------------------------

/// Whether a residual `where` could raise an OQX eval error the pushed
/// conjuncts might hide by emptying the scan. In memory every conjunct of the
/// original `&&` is evaluated for the first row and a throwing one aborts the
/// run; planned, a pushed conjunct that matches no row means the residual
/// never runs and the error vanishes. So a residual containing any function
/// or method call (an unknown function, a bad regex, a wrong arity…), a
/// nested block with the `single` consumer (more than one row raises), a
/// `^`-escaped name (no enclosing scope at the top level) or a bare reserved
/// docs basename (`path` for `$path`…, the guard in `get`) sends the whole
/// query to the in-memory engine unplanned. Only comparisons, logical
/// operators, `in`, `!`, literals, bindings and plain reads keep the push.
///
/// The walk is generic over the whole `oqx` AST — every `Where` node, every
/// nested block (its `from`, `where`, `select`, `order by`, `follow`,
/// `limit` / `offset`) and every `Expr`. A `^name:` lift in a nested select
/// counts as a `^`-escaped name. Inside a block the rows are a different
/// scope (a relation's rows), so a bare reserved name is an ordinary read
/// there (`root` is false) — only `doc.<reserved>` still raises at any depth.
/// Same decisions as the reference's `residualMayRaise`.
fn residual_may_raise(w: &Where, target: Target) -> bool {
    where_may_raise(w, target, true)
}

fn where_may_raise(w: &Where, target: Target, root: bool) -> bool {
    match w {
        Where::And { parts, .. } | Where::Or { parts, .. } => {
            parts.iter().any(|p| where_may_raise(p, target, root))
        }
        Where::Not { expr, .. } => where_may_raise(expr, target, root),
        Where::Scalar { expr, .. } => expr_may_raise(expr, target, root),
        Where::Op(op) => op_may_raise(op, target, root),
    }
}

fn op_may_raise(op: &OpNode, target: Target, root: bool) -> bool {
    op.op == Consumer::Single
        || expr_may_raise(&op.receiver, target, root)
        || subquery_may_raise(&op.sub, target)
}

fn subquery_may_raise(sub: &Subquery, target: Target) -> bool {
    let inner = |e: &Expr| expr_may_raise(e, target, false);
    sub.from.iter().any(inner)
        || sub
            .r#where
            .as_ref()
            .is_some_and(|w| where_may_raise(w, target, false))
        || sub.select.iter().any(|item| match item {
            SelectItem::Field { expr, lift, .. } => *lift > 0 || inner(expr),
            SelectItem::Collect { op, .. } => op_may_raise(op, target, false),
        })
        || sub.order_by.iter().flatten().any(|o| inner(&o.expr))
        || sub
            .follow
            .as_ref()
            .is_some_and(|f| follow_may_raise(f, target))
        || sub.limit.as_ref().is_some_and(inner)
        || sub.offset.as_ref().is_some_and(inner)
}

fn follow_may_raise(f: &Follow, target: Target) -> bool {
    let inner = |e: &Expr| expr_may_raise(e, target, false);
    f.destinations.iter().any(|d| match d {
        FollowDestination::Relation(e) => inner(e),
        FollowDestination::Block(op) => op_may_raise(op, target, false),
    }) || f.r#where.as_ref().is_some_and(inner)
        || f.frontier.as_ref().is_some_and(inner)
        || f.by.as_ref().is_some_and(inner)
}

fn is_reserved(name: &str) -> bool {
    RESERVED_DOC_BASENAMES.contains(&name)
}

fn expr_may_raise(e: &Expr, target: Target, root: bool) -> bool {
    let again = |e: &Expr| expr_may_raise(e, target, root);
    match e {
        Expr::Lit { .. } | Expr::Binding { .. } => false,
        Expr::Ident { name, .. } => root && target == Target::Docs && is_reserved(name),
        Expr::Outer { .. } | Expr::Call { .. } => true,
        // `doc.<reserved>`: the reach-through row is a doc (the row itself on
        // docs), so the guard fires on any target at any depth.
        Expr::Member { recv, name, .. } => {
            (is_reserved(name) && matches!(&**recv, Expr::Ident { name, .. } if name == "doc"))
                || again(recv)
        }
        Expr::Unary { expr, .. } => again(expr),
        Expr::Binary { left, right, .. }
        | Expr::Logical { left, right, .. }
        | Expr::In { left, right, .. } => again(left) || again(right),
        Expr::Range { lo, hi, .. } => {
            lo.as_deref().is_some_and(again) || hi.as_deref().is_some_and(again)
        }
    }
}

/// A compiled plan before execution: the statement, its params and the
/// residual query. Pure — what the planner would run, for inspection.
#[derive(Clone, Debug, PartialEq)]
pub struct Compiled {
    pub target: Target,
    pub sql: String,
    pub params: Vec<SqlValue>,
    pub residual: Query,
}

/// Compile `query` against `repo_id`, or `None` when the shape declines: a
/// `follow`, a `from E` re-projection, a source that is not a root scan, or
/// no pushable conjunct at all (the engine then does everything).
#[must_use]
pub fn compile(query: &Query, params: &[Value], repo_id: &str) -> Option<Compiled> {
    if query.follow.is_some() || !query.from.is_empty() {
        return None;
    }
    let target = root_target(&query.source)?;
    let (self_alias, doc_alias) = aliases(target);
    let ctx = TranslateCtx {
        target,
        self_alias,
        doc_alias,
        params,
    };
    let (pushed, residual) = partition_pushable(query.r#where.as_ref(), |e| {
        translate_predicate(e, &ctx).is_some()
    });
    if pushed.is_empty() {
        return None;
    }
    // Decline (c): a residual that could raise must not be hidden behind an
    // emptied scan — the whole query runs in memory.
    if residual
        .as_ref()
        .is_some_and(|w| residual_may_raise(w, target))
    {
        return None;
    }
    let mut where_sql = guards(target).to_owned();
    let mut sql_params = vec![SqlValue::Text(repo_id.to_owned())];
    for e in &pushed {
        let frag = translate_predicate(e, &ctx).expect("accepted by partition_pushable");
        where_sql.push_str(" AND (");
        where_sql.push_str(&frag.sql);
        where_sql.push(')');
        sql_params.extend(frag.params);
    }
    let sql = format!(
        "SELECT {} FROM {} WHERE {where_sql} ORDER BY {}",
        columns(target),
        from_clause(target),
        order_clause(target)
    );
    Some(Compiled {
        target,
        sql,
        params: sql_params,
        residual: residual_query(query, residual),
    })
}

/// The SQLite planner over one repo of the store.
pub struct SqlitePlanner<'a> {
    conn: &'a Connection,
    repo_id: String,
}

impl<'a> SqlitePlanner<'a> {
    #[must_use]
    pub fn new(conn: &'a Connection, repo_id: &str) -> Self {
        Self {
            conn,
            repo_id: repo_id.to_owned(),
        }
    }

    /// Plan `query`: `Ok(None)` when the shape declines, `Ok(Some(plan))`
    /// with the produced rows (tagged like the context's root rows) and the
    /// residual, `Err` when the statement itself failed (a store error, not
    /// a decline — the runner reports it rather than silently rescanning).
    pub fn try_plan(&self, query: &Query, params: &[Value]) -> rusqlite::Result<Option<Plan>> {
        let Some(compiled) = compile(query, params, &self.repo_id) else {
            return Ok(None);
        };
        let rows = fetch_rows(self.conn, &compiled.sql, &compiled.params)?;
        Ok(Some(Plan::new(
            tag_rows(rows, compiled.target),
            compiled.residual,
        )))
    }
}

impl QueryPlanner for SqlitePlanner<'_> {
    /// The seam's shape: a failed statement declines (the engine falls back
    /// to a full scan). The runner uses [`Self::try_plan`] to surface it.
    fn plan(&self, query: &Query, params: &[Value]) -> Option<Plan> {
        self.try_plan(query, params).ok().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oqx::ROWS_ROOT;
    use oqx::ast::Where;

    fn parse(src: &str) -> Query {
        oqx::parse_string(src).expect("parses")
    }

    fn text(s: &str) -> SqlValue {
        SqlValue::Text(s.to_owned())
    }

    #[test]
    fn a_pushable_scan_compiles_to_one_statement_in_root_order() {
        let c =
            compile(&parse("from docs where $path == \"index.md\""), &[], "r_1").expect("planned");
        assert_eq!(c.target, Target::Docs);
        assert_eq!(
            c.sql,
            "SELECT d.* FROM docs d WHERE d.repo_id = ? AND d.deleted_commit IS NULL AND ((d.path IS ?)) ORDER BY d.path, d.doc_id"
        );
        assert_eq!(c.params, vec![text("r_1"), text("index.md")]);
        assert_eq!(
            c.residual.source,
            Expr::Ident {
                name: ROWS_ROOT.to_owned(),
                span: oqx::Span::EMPTY,
            }
        );
        assert_eq!(c.residual.r#where, None);
    }

    #[test]
    fn every_target_has_its_join_columns_guards_and_order() {
        let b = compile(
            &parse("from blocks where $path.startsWith(\"lab/\")"),
            &[],
            "r",
        )
        .unwrap();
        assert_eq!(
            b.sql,
            "SELECT b.*, d.path AS __path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id \
             WHERE b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL \
             AND ((substr(d.path, 1, length(?)) = ?)) ORDER BY d.path, b.block_id"
        );
        assert_eq!(b.params, vec![text("r"), text("lab/"), text("lab/")]);
        let n = compile(
            &parse("$repo.nodes count { where kind == \"md:task\" }"),
            &[],
            "r",
        )
        .unwrap();
        assert_eq!(n.target, Target::Nodes);
        assert!(n.sql.starts_with(
            "SELECT n.*, d.path AS __path FROM nodes n JOIN docs d ON d.doc_id = n.doc_id WHERE n.repo_id = ? AND d.deleted_commit IS NULL AND ((n.kind IS ?))"
        ));
        assert!(n.sql.ends_with("ORDER BY d.path, n.node_id"));
        let e = compile(
            &parse("from edges where predicate == \"references\""),
            &[],
            "r",
        )
        .unwrap();
        assert!(e.sql.starts_with(
            "SELECT e.*, d.path AS __path FROM edges e JOIN docs d ON d.doc_id = e.src_doc WHERE e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL AND ((e.predicate IS ?))"
        ));
        assert!(e.sql.ends_with("ORDER BY d.path, e.edge_id"));
    }

    #[test]
    fn mixed_conjunctions_push_the_translatable_parts_and_keep_the_rest() {
        let q = parse(
            "from docs where $path.startsWith(\"processes/\") && nodes exists { where kind == \"md:task\" } && layer == \"canon\"",
        );
        let c = compile(&q, &[], "r").expect("planned");
        assert!(
            c.sql.contains("(substr(d.path, 1, length(?)) = ?)"),
            "{}",
            c.sql
        );
        assert!(c.sql.contains("p.key = 'layer'"), "{}", c.sql);
        // Guards first, then the fragments' params in statement order.
        assert_eq!(
            c.params,
            vec![
                text("r"),
                text("processes/"),
                text("processes/"),
                text("canon")
            ]
        );
        // One conjunct left → it stands alone, not wrapped in an `and`.
        assert!(
            matches!(c.residual.r#where, Some(Where::Op(_))),
            "{:?}",
            c.residual.r#where
        );
        assert!(c.residual.from.is_empty());
        assert_eq!(c.residual.select, q.select);
        assert_eq!(c.residual.consumer, q.consumer);
    }

    #[test]
    fn declined_shapes_return_none() {
        // nothing pushable → let the engine do it all
        assert!(compile(&parse("from docs"), &[], "r").is_none());
        assert!(compile(&parse("from docs where era in 800..1680"), &[], "r").is_none());
        assert!(compile(&parse("from docs where !verified"), &[], "r").is_none());
        assert!(
            compile(
                &parse("from docs where $path == \"a\" || $path == \"b\""),
                &[],
                "r"
            )
            .is_none()
        );
        assert!(
            compile(
                &parse("from docs where nodes exists { where kind == \"md:task\" }"),
                &[],
                "r"
            )
            .is_none()
        );
        // follow
        assert!(
            compile(
                &parse("from docs where $path == \"a.md\" follow distinct doc.out"),
                &[],
                "r"
            )
            .is_none()
        );
        // follow with several destinations: relations and a destination block
        // decline exactly like a single relation (0.14)
        assert!(
            compile(
                &parse("from docs where $path == \"a.md\" follow doc.out, doc.in"),
                &[],
                "r"
            )
            .is_none()
        );
        assert!(
            compile(
                &parse(
                    "from docs where $path == \"a.md\" follow $repo.docs collect { where after.contains(^$path) }"
                ),
                &[],
                "r"
            )
            .is_none()
        );
        // not a root scan
        assert!(compile(&parse("from things where $path == \"a.md\""), &[], "r").is_none());
        assert!(compile(&parse("from $repo where $path == \"a.md\""), &[], "r").is_none());
        assert!(compile(&parse("from docs.nodes where kind == \"x\""), &[], "r").is_none());
        // a `from E` re-projection (an AST-level shape)
        let mut q = parse("from docs where $path == \"a.md\"");
        q.from.push(Expr::Ident {
            name: "nodes".to_owned(),
            span: oqx::Span::EMPTY,
        });
        assert!(compile(&q, &[], "r").is_none());
    }

    // -- decline (c): a residual that could raise sends the whole query in memory --

    #[test]
    fn a_residual_that_could_raise_declines_the_whole_query() {
        let declined = |src: &str| {
            assert!(
                compile(&parse(src), &[], "r").is_none(),
                "should decline: {src}"
            );
        };
        let planned = |src: &str| {
            assert!(
                compile(&parse(src), &[], "r").is_some(),
                "should plan: {src}"
            );
        };
        // a bare reserved docs basename (the guard in `get`)
        declined("from docs where path == \"x\" && $path == \"nope.md\"");
        declined("from docs where $path == \"nope.md\" && !body");
        // `doc.<reserved>` on any target, at any depth
        declined("from blocks where $path == \"x\" && doc.path == \"y\"");
        declined("from blocks where $path == \"x\" && nodes exists { where doc.path == \"y\" }");
        // a function or method call
        declined("from docs where $path.matches(\"[\") && $path == \"nope.md\"");
        declined("from docs where nope(\"x\") && $path == \"nope.md\"");
        declined("from docs where $path == \"x\" && size(tags) > 1");
        declined("from docs where $path == \"x\" && nodes exists { where name.lower() == \"a\" }");
        declined(
            "from docs where $path == \"x\" && nodes count { where kind == \"a\" order by size(name) } > 1",
        );
        // a `^`-escaped name: an outer reference or a lift
        declined("from docs where $path == \"x\" && ^slug == \"y\"");
        declined("from docs where $path == \"x\" && nodes exists { where name == ^title }");
        declined("from docs where $path == \"x\" && nodes collect { ^first_task: name }");
        // a nested block with the `single` consumer
        declined(
            "from docs where $path == \"x\" && blocks exists { select t: nodes single { where kind == \"md:task\" } }",
        );
        // the pushed side raising is impossible; only the residual matters
        planned("from docs where $path.startsWith(\"lab/\") && $path == \"x\"");
        // plain reads, comparisons, `in`, `!`, literals and bindings keep the push
        planned("from docs where $path == \"x\" && era in 800..1680");
        planned("from docs where $path == \"x\" && !verified");
        planned("from docs where $path == \"x\" && (layer == \"a\" || layer == \"b\")");
        planned("from docs where $path == \"x\" && verified == true");
        planned("from docs where $path == \"x\" && nodes exists { where kind == \"md:task\" }");
        planned(
            "from docs where $path == \"x\" && nodes count { where kind == \"md:task\" limit 5 } > 1",
        );
        // on blocks a bare `path` is an attribute, and inside a block the rows
        // are another scope — an ordinary read, not the guard
        planned("from blocks where $path == \"x\" && !path");
        planned("from docs where $path == \"x\" && nodes exists { where path == \"y\" }");
        planned("from docs where $path == \"x\" && frontmatter.path == \"y\"");
    }

    #[test]
    fn a_top_level_not_or_or_is_the_whole_residual_and_declines() {
        // `!(…)` and `||` at the top are `Where::Not` / `Where::Or`, never scalar
        // parts, so nothing is pushed even when their leaves would be.
        assert!(compile(&parse("from docs where !($path == \"a\")"), &[], "r").is_none());
        assert!(
            compile(
                &parse("from docs where ($path == \"a\" || $path == \"b\") && layer == \"canon\""),
                &[],
                "r"
            )
            .is_some()
        );
    }
}
