//! Link health (`spec/graph` §6, `spec/surface` §4 `links_stale`): dangling
//! internal links are the open edges whose `dst_node` is a `phantom:`;
//! external edges are counted, never verified. Port of
//! `packages/core/src/graph/link-health.ts`.

use omgbase_store::Store;
use omgbase_store::links::{canonical_link_path, doc_dir_of, split_destination};
use rusqlite::types::Value as Sql;
use rusqlite::{Connection, params_from_iter};
use serde_json::{Value as Json, json};

use crate::context::glob_to_like;
use crate::error::Result;
use crate::paths::{reference_path, storage_path};

const PHANTOM: &str = "phantom:";

/// `(clause, param)` for a path glob: `LIKE` with `*` → `%` when it has a
/// `*`, else an exact match. Either path form is accepted; the column holds
/// the storage form.
fn glob_clause(column: &str, glob: &str) -> (String, String) {
    let glob = storage_path(glob);
    if glob.contains('*') {
        (
            format!("{column} LIKE ? ESCAPE '\\'"),
            glob_to_like(glob, false),
        )
    } else {
        (format!("{column} = ?"), glob.to_owned())
    }
}

fn totals(conn: &Connection, repo_id: &str, glob_sql: &str, params: &[Sql]) -> Result<(i64, i64)> {
    let sql = format!(
        "SELECT count(*), COALESCE(sum(CASE WHEN e.dst_kind = 'external' THEN 1 ELSE 0 END), 0)
         FROM edges e JOIN docs d ON d.doc_id = e.src_doc
         WHERE e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL {glob_sql}"
    );
    let mut all: Vec<Sql> = vec![Sql::Text(repo_id.to_owned())];
    all.extend(params.iter().cloned());
    Ok(conn.query_row(&sql, params_from_iter(all.iter()), |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    })?)
}

/// The destination AS AUTHORED for a phantom edge, recovered from the source
/// block's link nodes: the node whose canonical `(path, fragment)` equals the
/// edge's `(target, anchor)`.
fn authored_for(
    conn: &Connection,
    src_block: Option<&str>,
    src_path: &str,
    target: &str,
    anchor: Option<&str>,
) -> Result<Option<String>> {
    let Some(block) = src_block else {
        return Ok(None);
    };
    let doc_dir = doc_dir_of(src_path);
    let mut stmt = conn.prepare_cached(
        "SELECT kind, value FROM nodes WHERE block_id = ?1 AND kind IN ('md:link','md:wikilink','md:inline_field') AND value IS NOT NULL",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map(rusqlite::params![block], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    for (kind, value) in rows {
        let mut dest = value.as_str();
        if kind == "md:inline_field" {
            if let Some(inner) = dest.strip_prefix("[[").and_then(|s| s.strip_suffix("]]")) {
                if !inner.contains(']') {
                    dest = inner;
                } else if !dest.starts_with('/') {
                    continue;
                }
            } else if !dest.starts_with('/') {
                continue;
            }
        }
        if kind == "md:wikilink" {
            dest = dest.split('|').next().unwrap_or(dest);
        }
        let (path, fragment) = split_destination(dest);
        if canonical_link_path(path, doc_dir) != target {
            continue;
        }
        let frag = if fragment.is_empty() {
            None
        } else {
            Some(&fragment[1..])
        };
        if frag != anchor {
            continue;
        }
        return Ok(Some(dest.to_owned()));
    }
    Ok(None)
}

/// `links_stale`: `{ stale, externalCount, totalOpenEdges, truncated }`.
pub fn links_stale(
    store: &Store,
    repo_id: &str,
    path_glob: Option<&str>,
    limit: Option<i64>,
) -> Result<Json> {
    let conn = store.conn();
    let limit = usize::try_from(limit.unwrap_or(500).max(0)).unwrap_or(0);
    let (glob_sql, glob_params) = match path_glob {
        Some(g) => {
            let (clause, param) = glob_clause("d.path", g);
            (format!("AND {clause}"), vec![Sql::Text(param)])
        }
        None => (String::new(), Vec::new()),
    };
    let (total, external) = totals(conn, repo_id, &glob_sql, &glob_params)?;
    let sql = format!(
        "SELECT e.src_doc, d.path, e.src_block, e.predicate, e.provenance, e.dst_kind, e.dst_node, e.anchor
         FROM edges e JOIN docs d ON d.doc_id = e.src_doc
         WHERE e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL
           AND e.dst_node LIKE 'phantom:%' {glob_sql}
         ORDER BY d.path, e.dst_node, e.src_block
         LIMIT ?"
    );
    let mut all: Vec<Sql> = vec![Sql::Text(repo_id.to_owned())];
    all.extend(glob_params.iter().cloned());
    all.push(Sql::Integer(
        i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1),
    ));
    type Row = (
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        Option<String>,
    );
    let mut rows: Vec<Row> = {
        let mut stmt = conn.prepare(&sql)?;
        let it = stmt.query_map(params_from_iter(all.iter()), |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
            ))
        })?;
        it.collect::<std::result::Result<_, _>>()?
    };
    let truncated = rows.len() > limit;
    rows.truncate(limit);
    let mut stale = Vec::with_capacity(rows.len());
    for (src_doc, src_path, src_block, predicate, provenance, dst_kind, dst_node, anchor) in rows {
        let target = dst_node[PHANTOM.len()..].to_owned();
        let authored = authored_for(
            conn,
            src_block.as_deref(),
            &src_path,
            &target,
            anchor.as_deref(),
        )?;
        // The surface speaks the reference form: `srcPath` and `target` rooted;
        // `authored` stays exactly as written in the source.
        stale.push(json!({
            "srcDoc": src_doc,
            "srcPath": reference_path(&src_path),
            "srcBlock": src_block,
            "predicate": predicate,
            "provenance": provenance,
            "dstKind": dst_kind,
            "target": reference_path(&target),
            "authored": authored,
            "anchor": anchor,
            "reason": "dangling_doc",
        }));
    }
    Ok(json!({
        "stale": stale,
        "externalCount": external,
        "totalOpenEdges": total,
        "truncated": truncated,
    }))
}

/// `links_stale` with `summary: true`: counts by target and by source.
pub fn links_stale_summary(store: &Store, repo_id: &str, path_glob: Option<&str>) -> Result<Json> {
    let conn = store.conn();
    let (glob_sql, glob_params) = match path_glob {
        Some(g) => {
            let (clause, param) = glob_clause("d.path", g);
            (format!("AND {clause}"), vec![Sql::Text(param)])
        }
        None => (String::new(), Vec::new()),
    };
    let (total, external) = totals(conn, repo_id, &glob_sql, &glob_params)?;
    let base = format!(
        "FROM edges e JOIN docs d ON d.doc_id = e.src_doc
         WHERE e.repo_id = ? AND e.to_commit IS NULL AND d.deleted_commit IS NULL {glob_sql} AND e.dst_node LIKE 'phantom:%'"
    );
    let mut all: Vec<Sql> = vec![Sql::Text(repo_id.to_owned())];
    all.extend(glob_params.iter().cloned());
    let by_target: Vec<(String, i64)> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT e.dst_node, count(*) AS n {base} GROUP BY e.dst_node ORDER BY n DESC, e.dst_node"
        ))?;
        let it = stmt.query_map(params_from_iter(all.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<_, _>>()?
    };
    let by_source: Vec<(String, i64)> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT d.path, count(*) AS n {base} GROUP BY d.path ORDER BY n DESC, d.path"
        ))?;
        let it = stmt.query_map(params_from_iter(all.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<_, _>>()?
    };
    let stale_count: i64 = by_target.iter().map(|(_, n)| n).sum();
    Ok(json!({
        "staleCount": stale_count,
        "byTarget": by_target.iter().map(|(t, n)| json!({ "target": reference_path(&t[PHANTOM.len()..]), "count": n })).collect::<Vec<_>>(),
        "bySource": by_source.iter().map(|(p, n)| json!({ "srcPath": reference_path(p), "count": n })).collect::<Vec<_>>(),
        "externalCount": external,
        "totalOpenEdges": total,
    }))
}
