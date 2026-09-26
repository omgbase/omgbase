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

use oqx::ast::{Expr, Query};
use oqx::{Plan, QueryPlanner, Value, partition_pushable, residual_query};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;

use crate::context::{Target, fetch_rows, tag_rows};
use crate::translate::{TranslateCtx, translate_predicate};

/// The SQL aliases of the scanned row (`self`) and its owning doc (`doc`).
fn aliases(t: Target) -> (&'static str, &'static str) {
    match t {
        Target::Docs => ("d", "d"),
        Target::Blocks => ("b", "d"),
        Target::Nodes => ("n", "d"),
        Target::Edges => ("e", "d"),
    }
}

fn from_clause(t: Target) -> &'static str {
    match t {
        Target::Docs => "docs d",
        Target::Blocks => "blocks b JOIN docs d ON d.doc_id = b.doc_id",
        Target::Nodes => "nodes n JOIN docs d ON d.doc_id = n.doc_id",
        Target::Edges => "edges e JOIN docs d ON d.doc_id = e.src_doc",
    }
}

/// Row columns + the owning-doc path as `__path` (matches the context's
/// roots so produced rows are indistinguishable from a full scan's).
fn columns(t: Target) -> &'static str {
    match t {
        Target::Docs => "d.*",
        Target::Blocks => "b.*, d.path AS __path",
        Target::Nodes => "n.*, d.path AS __path",
        Target::Edges => "e.*, d.path AS __path",
    }
}

/// The root order (`spec/surface` §1.1).
fn order_clause(t: Target) -> &'static str {
    match t {
        Target::Docs => "d.path, d.doc_id",
        Target::Blocks => "d.path, b.block_id",
        Target::Nodes => "d.path, n.node_id",
        Target::Edges => "d.path, e.edge_id",
    }
}

/// The liveness guards of the root scan, with the repo id bound.
fn guards(t: Target) -> &'static str {
    match t {
        Target::Docs => "d.repo_id = ? AND d.deleted_commit IS NULL",
        Target::Blocks => "b.repo_id = ? AND b.deleted_commit IS NULL AND d.deleted_commit IS NULL",
        Target::Nodes => "n.repo_id = ? AND d.deleted_commit IS NULL",
        Target::Edges => "e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL",
    }
}

/// The root collection a query scans, if it is a bare `docs|blocks|nodes|edges`
/// or `$repo.<target>` source (else `None` — not a pushable shape).
fn root_target(source: &Expr) -> Option<Target> {
    match source {
        Expr::Ident { name } => Target::parse(name),
        Expr::Member { recv, name } => match &**recv {
            Expr::Ident { name: r } if r == "$repo" => Target::parse(name),
            _ => None,
        },
        _ => None,
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
                name: ROWS_ROOT.to_owned()
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
        // not a root scan
        assert!(compile(&parse("from things where $path == \"a.md\""), &[], "r").is_none());
        assert!(compile(&parse("from $repo where $path == \"a.md\""), &[], "r").is_none());
        assert!(compile(&parse("from docs.nodes where kind == \"x\""), &[], "r").is_none());
        // a `from E` re-projection (an AST-level shape)
        let mut q = parse("from docs where $path == \"a.md\"");
        q.from.push(Expr::Ident {
            name: "nodes".to_owned(),
        });
        assert!(compile(&q, &[], "r").is_none());
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
