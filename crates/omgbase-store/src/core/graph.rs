//! The graph tables (`spec/graph`; `spec/store` §5.4 after the blocks,
//! sections and properties): `nodes` + `nodes_fts` (§2), `external_nodes`
//! and the edge resolution (§3.2), the OPEN edge set (§3.3, graph 3.0 — the
//! core persists the asserted relations as the rows of `edges`, closing an
//! edge deletes its row, and hands the recorder the transition's edge list
//! so the history bundle keeps the interval record, `edge_transitions`), the
//! `doc_edges` rollup (§3.4) and phantom adoption (§3.5). Extraction itself
//! is `omgbase-graph`, pure; everything here reads or writes the database
//! inside the commit transaction. Deletion (§3.6) touches none of it. The
//! core writes no `from_commit`/`to_commit`.

use std::collections::{HashMap, HashSet};

use omgbase_graph::{
    DstKind, EdgeDescriptor, ProjectedNode, Provenance, canonical_path, doc_dir, node_rows,
    resolve_relative,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::core::capabilities::HistoryRecorder;
use crate::error::Result;
use crate::mint::Mint;

// ---- nodes (§2) -----------------------------------------------------------------

/// §2.2: one `md:section` node per `sections` row of the document, in
/// `first_ordinal` order, named by the heading block's text.
pub fn project_section_nodes(conn: &Connection, doc_id: &str) -> Result<Vec<ProjectedNode>> {
    let mut stmt = conn.prepare_cached(
        "SELECT s.heading_block, s.level, s.first_ordinal, s.last_ordinal, hb.text
           FROM sections s
           JOIN blocks hb ON hb.block_id = s.heading_block AND hb.doc_id = s.doc_id
          WHERE s.doc_id = ?1 AND hb.deleted_at IS NULL
          ORDER BY s.first_ordinal",
    )?;
    let rows = stmt.query_map(params![doc_id], |r| {
        Ok(ProjectedNode::section(
            &r.get::<_, String>(0)?,
            &r.get::<_, String>(4)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
        ))
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Delete a document's `nodes` rows and their `nodes_fts` entries
/// (external-content index: a `'delete'` with the indexed `name`/`value`,
/// `""` for null, as they were inserted).
pub fn delete_doc_nodes(conn: &Connection, doc_id: &str) -> Result<()> {
    let rows: Vec<(i64, Option<String>, Option<String>)> = {
        let mut stmt =
            conn.prepare_cached("SELECT rowid, name, value FROM nodes WHERE doc_id = ?1")?;
        let it = stmt.query_map(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut del = conn.prepare_cached(
        "INSERT INTO nodes_fts(nodes_fts, rowid, name, value) VALUES('delete', ?1, ?2, ?3)",
    )?;
    for (rowid, name, value) in rows {
        del.execute(params![
            rowid,
            name.unwrap_or_default(),
            value.unwrap_or_default()
        ])?;
    }
    conn.execute("DELETE FROM nodes WHERE doc_id = ?1", params![doc_id])?;
    Ok(())
}

/// §2.3: replace the document's `nodes` (and FTS) rows with `nodes` — the
/// adapter nodes followed by the section nodes — assigning ordinals and ids
/// in list order. Returns how many rows were written.
pub fn write_doc_nodes(
    conn: &Connection,
    repo_id: &str,
    doc_id: &str,
    nodes: &[ProjectedNode],
) -> Result<usize> {
    delete_doc_nodes(conn, doc_id)?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO nodes (node_id, repo_id, doc_id, block_id, kind, name, value, span_start, span_end, attrs)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    let mut fts =
        conn.prepare_cached("INSERT INTO nodes_fts(rowid, name, value) VALUES (?1, ?2, ?3)")?;
    for row in node_rows(doc_id, nodes) {
        let n = row.node;
        insert.execute(params![
            row.node_id,
            repo_id,
            doc_id,
            n.block_id,
            n.kind.as_str(),
            n.name,
            n.value,
            n.span.map(|(s, _)| s as i64),
            n.span.map(|(_, e)| e as i64),
            serde_json::Value::Object(n.attrs.clone()).to_string(),
        ])?;
        let rowid = conn.last_insert_rowid();
        fts.execute(params![
            rowid,
            n.name.as_deref().unwrap_or(""),
            n.value.as_deref().unwrap_or("")
        ])?;
    }
    Ok(nodes.len())
}

// ---- resolution (§3.2) ---------------------------------------------------------------

/// An edge with its target resolved to a node id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedEdge {
    pub src_block: Option<String>,
    pub src_field: Option<String>,
    pub predicate: String,
    pub dst_kind: DstKind,
    /// A doc id, an `external_nodes` id, or `phantom:<path>`.
    pub dst_node: String,
    pub anchor: Option<String>,
    pub provenance: Provenance,
}

/// An open edge as the core wrote it (every `edges` column): what the
/// recorder receives per opened edge (`spec/store` §5.4 step 15, 17.0).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdgeRow {
    pub edge_id: String,
    pub repo_id: String,
    pub src_doc: String,
    pub src_block: Option<String>,
    pub src_field: Option<String>,
    pub predicate: String,
    pub dst_kind: String,
    pub dst_node: String,
    pub anchor: Option<String>,
    pub provenance: String,
    pub via_node: Option<String>,
}

/// The transition's edge list (`spec/graph` §3.3, 17.0): the rows this
/// commit opened and the ids it closed, in write order.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EdgeTransitions {
    pub opened: Vec<EdgeRow>,
    pub closed: Vec<String>,
}

impl ResolvedEdge {
    /// §3.3 key: `src_block|src_field|predicate|dst_node|anchor`, nulls empty.
    #[must_use]
    pub fn key(&self) -> String {
        edge_key(
            self.src_block.as_deref(),
            self.src_field.as_deref(),
            &self.predicate,
            &self.dst_node,
            self.anchor.as_deref(),
        )
    }
}

fn edge_key(
    src_block: Option<&str>,
    src_field: Option<&str>,
    predicate: &str,
    dst_node: &str,
    anchor: Option<&str>,
) -> String {
    format!(
        "{}|{}|{predicate}|{dst_node}|{}",
        src_block.unwrap_or(""),
        src_field.unwrap_or(""),
        anchor.unwrap_or("")
    )
}

/// The repo's `external_nodes` row for `uri`, **minting `x`** and inserting
/// `(node_id, repo_id, uri, title = null)` when absent. The claim for a
/// minted `x` is written by [`maintain_edges`] with the edge that names it
/// (the resolver runs inside the ingest's edge extraction, same transaction).
pub fn resolve_external(
    conn: &Connection,
    minter: &mut Mint<'_>,
    repo_id: &str,
    uri: &str,
) -> Result<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT node_id FROM external_nodes WHERE repo_id = ?1 AND uri = ?2",
            params![repo_id, uri],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = minter.mint("x")?;
    conn.execute(
        "INSERT INTO external_nodes (node_id, repo_id, uri) VALUES (?1, ?2, ?3)",
        params![id, repo_id, uri],
    )?;
    Ok(id)
}

/// A repo path (one leading `/` stripped) to the live doc's id at that path,
/// else `phantom:<path>`.
pub fn resolve_doc_path(conn: &Connection, repo_id: &str, path: &str) -> Result<String> {
    let canonical = canonical_path(path);
    let doc: Option<String> = conn
        .query_row(
            "SELECT doc_id FROM docs WHERE repo_id = ?1 AND path = ?2 AND deleted_at IS NULL",
            params![repo_id, canonical],
            |r| r.get(0),
        )
        .optional()?;
    Ok(doc.unwrap_or_else(|| format!("phantom:{canonical}")))
}

/// §3.2: resolve each descriptor's target, in order — external URIs to
/// `external_nodes` (minting `x`), a pure fragment to the source document,
/// anything else through relative resolution against the document's
/// directory to a live doc or a phantom, `dst_kind` forced to `document`.
pub fn resolve_edges(
    conn: &Connection,
    minter: &mut Mint<'_>,
    repo_id: &str,
    src_doc: &str,
    doc_path: &str,
    descriptors: &[EdgeDescriptor],
) -> Result<Vec<ResolvedEdge>> {
    let dir = doc_dir(doc_path);
    let mut out = Vec::with_capacity(descriptors.len());
    for e in descriptors {
        let (dst_kind, dst_node) = if e.dst_kind == DstKind::External {
            (
                DstKind::External,
                resolve_external(conn, minter, repo_id, &e.target)?,
            )
        } else if e.target.is_empty() {
            (DstKind::Document, src_doc.to_owned())
        } else {
            (
                DstKind::Document,
                resolve_doc_path(conn, repo_id, &resolve_relative(&e.target, dir))?,
            )
        };
        out.push(ResolvedEdge {
            src_block: e.src_block.clone(),
            src_field: e.src_field.clone(),
            predicate: e.predicate.clone(),
            dst_kind,
            dst_node,
            anchor: e.anchor.clone(),
            provenance: e.provenance,
        });
    }
    Ok(out)
}

// ---- open edges (§3.3) and rollup (§3.4) -----------------------------------------------

/// §3.3 (3.0): reconcile the wanted edge set against the document's open rows
/// — **mint `e`** and insert a row for each wanted key not open (wanted
/// order), then walk the open rows in `rowid` order and DELETE every one
/// whose key is not wanted or that duplicates an earlier kept row; unchanged
/// rows are untouched (they keep their `edge_id`). The transition's edge
/// list — the rows opened, the ids closed — goes to the recorder
/// ([`HistoryRecorder::record_edge_transitions`], `spec/store` §5.4 step 15)
/// when it has anything in it. Then rebuild the rollup (§3.4). Returns the
/// transitions.
///
/// `spec/store` §2.1 (17.0): the `e` minted per newly opened edge and the `x`
/// [`resolve_external`] minted for its external target are claimed here, in
/// the commit transaction, `minted_at = ts` (an external node that already had
/// its claim adds nothing — the claim is idempotent).
#[allow(clippy::too_many_arguments)]
pub fn maintain_edges(
    conn: &Connection,
    minter: &mut Mint<'_>,
    history: &dyn HistoryRecorder,
    repo_id: &str,
    src_doc: &str,
    commit_id: &str,
    edges: &[ResolvedEdge],
    ts: &str,
) -> Result<EdgeTransitions> {
    let open: Vec<(String, String)> = {
        let mut stmt = conn.prepare_cached(
            "SELECT edge_id, src_block, src_field, predicate, dst_node, anchor FROM edges
              WHERE src_doc = ?1 ORDER BY rowid",
        )?;
        let it = stmt.query_map(params![src_doc], |r| {
            let src_block: Option<String> = r.get(1)?;
            let src_field: Option<String> = r.get(2)?;
            let predicate: String = r.get(3)?;
            let dst_node: String = r.get(4)?;
            let anchor: Option<String> = r.get(5)?;
            Ok((
                r.get::<_, String>(0)?,
                edge_key(
                    src_block.as_deref(),
                    src_field.as_deref(),
                    &predicate,
                    &dst_node,
                    anchor.as_deref(),
                ),
            ))
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let open_keys: HashSet<&str> = open.iter().map(|(_, k)| k.as_str()).collect();

    let mut wanted: HashSet<String> = HashSet::new();
    let mut opened: Vec<EdgeRow> = Vec::new();
    {
        let mut insert = conn.prepare_cached(
            "INSERT INTO edges (edge_id, repo_id, src_doc, src_block, src_field, predicate, dst_kind, dst_node, anchor, provenance, via_node)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
        )?;
        for e in edges {
            let key = e.key();
            if !wanted.insert(key.clone()) {
                continue;
            }
            if open_keys.contains(key.as_str()) {
                continue;
            }
            let edge_id = minter.mint("e")?;
            minter.claim("e", &edge_id, Some(repo_id), ts)?;
            if e.dst_kind == DstKind::External {
                minter.claim("x", &e.dst_node, Some(repo_id), ts)?;
            }
            insert.execute(params![
                edge_id,
                repo_id,
                src_doc,
                e.src_block,
                e.src_field,
                e.predicate,
                e.dst_kind.as_str(),
                e.dst_node,
                e.anchor,
                e.provenance.as_str(),
            ])?;
            opened.push(EdgeRow {
                edge_id,
                repo_id: repo_id.to_owned(),
                src_doc: src_doc.to_owned(),
                src_block: e.src_block.clone(),
                src_field: e.src_field.clone(),
                predicate: e.predicate.clone(),
                dst_kind: e.dst_kind.as_str().to_owned(),
                dst_node: e.dst_node.clone(),
                anchor: e.anchor.clone(),
                provenance: e.provenance.as_str().to_owned(),
                via_node: None,
            });
        }
    }
    // Delete every open row whose key is no longer wanted, and all but the
    // first open row of a wanted key.
    let mut closed: Vec<String> = Vec::new();
    {
        let mut del = conn.prepare_cached("DELETE FROM edges WHERE edge_id = ?1")?;
        let mut kept: HashSet<&str> = HashSet::new();
        for (edge_id, key) in &open {
            if wanted.contains(key) && kept.insert(key.as_str()) {
                continue;
            }
            del.execute(params![edge_id])?;
            closed.push(edge_id.clone());
        }
    }
    let transitions = EdgeTransitions { opened, closed };
    // `spec/store` §5.4 step 15 (17.0): the recorder's half — the interval record.
    if !transitions.opened.is_empty() || !transitions.closed.is_empty() {
        history.record_edge_transitions(conn, commit_id, &transitions)?;
    }
    rebuild_doc_edges(conn, src_doc)?;
    Ok(transitions)
}

/// Rewrite the destination of the open edges at `from_dst` to `to_dst` in
/// place (§3.5 adoption; a move's re-phantoming, `effects::move_path_in`) —
/// the rows keep their ids — and tell the recorder so the open transitions
/// follow (`edge_transitions.dst_node` reads as 16.x's `edges` did). Returns
/// the distinct source documents touched, in first-seen `rowid` order (their
/// rollups are the caller's to rebuild). `where_` narrows the rows: an extra
/// SQL predicate over `edges` spelled with unnumbered `?` placeholders, bound
/// in order from `where_params` after the destination(s).
pub fn retarget_open_edges(
    conn: &Connection,
    history: &dyn HistoryRecorder,
    from_dst: &str,
    to_dst: &str,
    where_: &str,
    where_params: &[&dyn rusqlite::ToSql],
) -> Result<Vec<String>> {
    let rows: Vec<(String, String)> = {
        let mut all: Vec<&dyn rusqlite::ToSql> = vec![&from_dst];
        all.extend_from_slice(where_params);
        let mut stmt = conn.prepare(&format!(
            "SELECT edge_id, src_doc FROM edges WHERE dst_node = ? {where_} ORDER BY rowid"
        ))?;
        let it = stmt.query_map(all.as_slice(), |r| Ok((r.get(0)?, r.get(1)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut upd: Vec<&dyn rusqlite::ToSql> = vec![&to_dst, &from_dst];
    upd.extend_from_slice(where_params);
    conn.execute(
        &format!("UPDATE edges SET dst_node = ? WHERE dst_node = ? {where_}"),
        upd.as_slice(),
    )?;
    let ids: Vec<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
    history.retarget_edges(conn, &ids, to_dst)?;
    let mut affected: Vec<String> = Vec::new();
    for (_, src) in rows {
        if !affected.contains(&src) {
            affected.push(src);
        }
    }
    Ok(affected)
}

/// §3.4: replace the document's `doc_edges` with one row per group of its
/// open edges by `(predicate, dst_node, dst_kind)`: `count` = the group
/// size, `samples` = up to three non-null `src_block`s in edge `rowid` order.
pub fn rebuild_doc_edges(conn: &Connection, src_doc: &str) -> Result<()> {
    conn.execute("DELETE FROM doc_edges WHERE src_doc = ?1", params![src_doc])?;
    let rows: Vec<(String, String, String, Option<String>)> = {
        let mut stmt = conn.prepare_cached(
            "SELECT predicate, dst_node, dst_kind, src_block FROM edges
              WHERE src_doc = ?1 ORDER BY rowid",
        )?;
        let it = stmt.query_map(params![src_doc], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut order: Vec<(String, String, String)> = Vec::new();
    let mut groups: HashMap<(String, String, String), (i64, Vec<String>)> = HashMap::new();
    for (predicate, dst_node, dst_kind, src_block) in rows {
        let key = (predicate, dst_node, dst_kind);
        let entry = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key);
            (0, Vec::new())
        });
        entry.0 += 1;
        if let Some(b) = src_block {
            entry.1.push(b);
        }
    }
    let mut insert = conn.prepare_cached(
        "INSERT INTO doc_edges (src_doc, predicate, dst_node, dst_kind, count, samples) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for key in order {
        let (count, samples) = &groups[&key];
        let samples: Vec<&str> = samples.iter().take(3).map(String::as_str).collect();
        insert.execute(params![
            src_doc,
            key.0,
            key.1,
            key.2,
            count,
            serde_json::to_string(&samples).expect("strings serialize"),
        ])?;
    }
    Ok(())
}

// ---- phantom adoption (§3.5) ---------------------------------------------------------

/// §3.5: when a document row is created at `path`, rewrite every open edge
/// with `dst_node = "phantom:" + path` to `doc_id` in place
/// ([`retarget_open_edges`]: the rows keep their ids, the recorder's open
/// transitions follow) and recompute the rollup of each affected source
/// document.
pub fn adopt_phantoms(
    conn: &Connection,
    history: &dyn HistoryRecorder,
    path: &str,
    doc_id: &str,
) -> Result<()> {
    let phantom = format!("phantom:{}", canonical_path(path));
    let affected = retarget_open_edges(conn, history, &phantom, doc_id, "", &[])?;
    for src in &affected {
        rebuild_doc_edges(conn, src)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use omgbase_graph::node_id;
    use omgbase_reconcile::Config;
    use rusqlite::types::Value as Sql;

    use crate::{SequentialMinter, Store};

    const T0: &str = "2026-09-26T10:00:00.000Z";
    const T1: &str = "2026-09-26T10:01:00.000Z";
    const T2: &str = "2026-09-26T10:02:00.000Z";

    fn fixture() -> (Store, String) {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        (store, repo)
    }

    fn observe(store: &mut Store, repo: &str, path: &str, source: &str, ts: &str) -> String {
        store
            .observe_one(repo, path, source, ts, &Config::default())
            .unwrap()
            .doc_id
    }

    fn rows(store: &Store, sql: &str) -> Vec<Vec<Sql>> {
        let mut stmt = store.conn().prepare(sql).unwrap();
        let n = stmt.column_count();
        stmt.query_map([], |r| (0..n).map(|i| r.get::<_, Sql>(i)).collect())
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    fn texts(store: &Store, sql: &str) -> Vec<String> {
        rows(store, sql)
            .into_iter()
            .map(|r| match &r[0] {
                Sql::Text(t) => t.clone(),
                Sql::Null => "null".to_owned(),
                other => format!("{other:?}"),
            })
            .collect()
    }

    #[test]
    fn nodes_are_written_with_ids_spans_and_fts() {
        let (mut store, repo) = fixture();
        let doc = observe(
            &mut store,
            &repo,
            "a.md",
            "# Tïtle\n\nSee [x](y.md) and [[w]] ^a\n\n- [ ] todo\n\n## Sub\n\nk:: v\n",
            T0,
        );
        let kinds = texts(&store, "SELECT kind FROM nodes ORDER BY rowid");
        assert_eq!(
            kinds,
            [
                "md:link",
                "md:wikilink",
                "md:anchor",
                "md:task",
                "md:inline_field",
                "md:section",
                "md:section"
            ]
        );
        let link = rows(
            &store,
            "SELECT node_id, block_id, name, value, span_start, span_end, attrs FROM nodes WHERE kind = 'md:link'",
        );
        assert_eq!(link[0][0], Sql::Text(node_id(&doc, "b_1", "md:link", 0)));
        assert_eq!(link[0][1], Sql::Text("b_1".into()));
        assert_eq!(link[0][2], Sql::Text("x".into()));
        assert_eq!(link[0][3], Sql::Text("y.md".into()));
        assert_eq!(link[0][4], Sql::Integer(4));
        assert_eq!(link[0][5], Sql::Integer(13));
        assert_eq!(link[0][6], Sql::Text("{}".into()));
        let sections = rows(
            &store,
            "SELECT block_id, name, value, span_start, attrs FROM nodes WHERE kind = 'md:section' ORDER BY rowid",
        );
        assert_eq!(sections[0][0], Sql::Text("b_0".into()));
        assert_eq!(sections[0][1], Sql::Text("Tïtle".into()));
        assert_eq!(sections[0][2], Sql::Null);
        assert_eq!(sections[0][3], Sql::Null);
        assert_eq!(
            sections[0][4],
            Sql::Text(r#"{"level":1,"first_ordinal":0,"last_ordinal":4}"#.into())
        );
        let task = rows(
            &store,
            "SELECT attrs, value FROM nodes WHERE kind = 'md:task'",
        );
        assert_eq!(task[0][0], Sql::Text(r#"{"checked":false}"#.into()));
        assert_eq!(task[0][1], Sql::Text("todo".into()));
        // FTS rows exist and follow the nodes.
        let hits = texts(
            &store,
            "SELECT n.kind FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid WHERE nodes_fts MATCH 'todo'",
        );
        assert_eq!(hits, ["md:task"]);
        // A re-ingest replaces the rows (and the FTS entries) wholesale.
        observe(&mut store, &repo, "a.md", "# Title\n\nplain\n", T1);
        assert_eq!(
            texts(&store, "SELECT kind FROM nodes ORDER BY rowid"),
            ["md:section"]
        );
        assert!(texts(
            &store,
            "SELECT n.kind FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid WHERE nodes_fts MATCH 'todo'"
        )
        .is_empty());
        let stale: i64 = store
            .conn()
            .query_row(
                "SELECT count(*) FROM nodes_fts WHERE nodes_fts MATCH 'todo'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            stale, 0,
            "the external-content delete removed the index entry"
        );
    }

    #[test]
    fn edges_open_close_and_roll_up() {
        let (mut store, repo) = fixture();
        let a = observe(
            &mut store,
            &repo,
            "a.md",
            "See [b](b.md) and [b again](./b.md)\n\n<https://x.com/> and https://x.com\n",
            T0,
        );
        // One phantom edge per (block, key) — two spellings of b.md resolve to
        // one key; two spellings of the URI to one external node.
        let edges = rows(
            &store,
            "SELECT edge_id, src_block, predicate, dst_kind, dst_node, provenance FROM edges ORDER BY rowid",
        );
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0][0], Sql::Text("e_0".into()));
        assert_eq!(edges[0][1], Sql::Text("b_0".into()));
        assert_eq!(edges[0][4], Sql::Text("phantom:b.md".into()));
        // 3.0: the interval is the recorder's — one open transition per edge,
        // `from_commit` this commit.
        let transitions = rows(
            &store,
            "SELECT edge_id, dst_node, from_commit, to_commit FROM edge_transitions ORDER BY rowid",
        );
        assert_eq!(transitions.len(), 2);
        assert_eq!(transitions[0][0], Sql::Text("e_0".into()));
        assert_eq!(transitions[0][2], Sql::Text("c_0".into()));
        assert_eq!(transitions[0][3], Sql::Null);
        assert_eq!(edges[1][1], Sql::Text("b_1".into()));
        assert_eq!(edges[1][3], Sql::Text("external".into()));
        assert_eq!(edges[1][4], Sql::Text("x_0".into()));
        assert_eq!(
            texts(&store, "SELECT uri FROM external_nodes"),
            ["https://x.com"]
        );
        let roll = rows(
            &store,
            "SELECT predicate, dst_node, dst_kind, count, samples FROM doc_edges ORDER BY dst_node",
        );
        assert_eq!(roll.len(), 2);
        assert_eq!(roll[0][1], Sql::Text("phantom:b.md".into()));
        assert_eq!(roll[0][3], Sql::Integer(1));
        assert_eq!(roll[0][4], Sql::Text(r#"["b_0"]"#.into()));

        // Creating b.md adopts the phantom in place (same edge id); the open
        // transition follows the rewrite and keeps its from_commit.
        let b = observe(&mut store, &repo, "b.md", "# B\n", T1);
        let adopted = rows(
            &store,
            "SELECT e.edge_id, e.dst_node, t.dst_node, t.from_commit, t.to_commit FROM edges e JOIN edge_transitions t ON t.edge_id = e.edge_id WHERE e.edge_id = 'e_0'",
        );
        assert_eq!(adopted[0][1], Sql::Text(b.clone()));
        assert_eq!(adopted[0][2], Sql::Text(b.clone()));
        assert_eq!(adopted[0][3], Sql::Text("c_0".into()));
        assert_eq!(adopted[0][4], Sql::Null);
        assert_eq!(
            texts(
                &store,
                "SELECT dst_node FROM doc_edges WHERE src_doc = 'd_0' ORDER BY dst_node"
            ),
            [b.as_str(), "x_0"]
        );

        // Editing a.md: the first paragraph is unchanged, so its edge to b stays
        // open untouched (same id); the URL paragraph is replaced (its edge's
        // row is DELETED and its transition closed) by a self-fragment link; a
        // new paragraph carries an inline relation to the same URI (the
        // external node is reused, and the URL value is also a bare URL — two
        // edges, different keys).
        observe(
            &mut store,
            &repo,
            "a.md",
            "See [b](b.md) and [b again](./b.md)\n\nNow [here](#Top) only\n\nrel:: https://x.com/\n",
            T2,
        );
        let edges = rows(
            &store,
            "SELECT edge_id, src_block, src_field, predicate, dst_kind, dst_node, anchor FROM edges ORDER BY rowid",
        );
        assert_eq!(edges.len(), 4, "the closed edge's row is gone");
        assert_eq!(edges[0][0], Sql::Text("e_0".into()));
        assert_eq!(edges[1][0], Sql::Text("e_2".into()));
        assert_eq!(
            edges[1][5],
            Sql::Text(a.clone()),
            "a pure fragment targets the doc itself"
        );
        assert_eq!(edges[1][6], Sql::Text("Top".into()));
        assert_eq!(edges[2][2], Sql::Text("rel".into()));
        assert_eq!(edges[2][3], Sql::Text("rel".into()));
        assert_eq!(
            edges[2][5],
            Sql::Text("x_0".into()),
            "external node reused, none minted"
        );
        assert_eq!(edges[3][3], Sql::Text("references".into()));
        assert_eq!(edges[3][5], Sql::Text("x_0".into()));
        assert_eq!(edges[3][0], Sql::Text("e_4".into()));
        // The recorder's record: five transitions, e_1 closed at c_2, the
        // three new ones opened at c_2, e_0 open since c_0.
        let transitions = rows(
            &store,
            "SELECT edge_id, from_commit, to_commit FROM edge_transitions ORDER BY rowid",
        );
        assert_eq!(transitions.len(), 5);
        assert_eq!(
            (&transitions[0][1], &transitions[0][2]),
            (&Sql::Text("c_0".into()), &Sql::Null)
        );
        assert_eq!(
            transitions[1][2],
            Sql::Text("c_2".into()),
            "the bare-URL edge closed"
        );
        assert_eq!(transitions[2][0], Sql::Text("e_2".into()));
        assert_eq!(transitions[2][1], Sql::Text("c_2".into()));
        assert_eq!(transitions[2][2], Sql::Null);
        assert_eq!(texts(&store, "SELECT node_id FROM external_nodes"), ["x_0"]);
        let roll = rows(
            &store,
            "SELECT predicate, dst_node, count FROM doc_edges WHERE src_doc = 'd_0' ORDER BY predicate, dst_node",
        );
        assert_eq!(roll.len(), 4);
        assert_eq!(roll[0][0], Sql::Text("references".into()));
        assert_eq!(roll[3][0], Sql::Text("rel".into()));
    }

    #[test]
    fn containers_count_once_and_ref_targets_are_documents() {
        let (mut store, repo) = fixture();
        observe(&mut store, &repo, "a.md", "- see [[n^blk]]\n", T0);
        let edges = rows(
            &store,
            "SELECT src_block, dst_kind, dst_node, anchor FROM edges ORDER BY rowid",
        );
        // spec/graph 1.1: the item's edge only (the list's own text is blank).
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0][0], Sql::Text("b_1".into()));
        assert_eq!(edges[0][1], Sql::Text("document".into()));
        assert_eq!(edges[0][2], Sql::Text("phantom:n".into()));
        assert_eq!(edges[0][3], Sql::Text("blk".into()));
        let roll = rows(&store, "SELECT count, samples FROM doc_edges");
        assert_eq!(roll[0][0], Sql::Integer(1));
        assert_eq!(roll[0][1], Sql::Text(r#"["b_1"]"#.into()));
    }

    #[test]
    fn frontmatter_relations_resolve_relative_to_the_root_and_carry_no_block() {
        let (mut store, repo) = fixture();
        observe(
            &mut store,
            &repo,
            "dir/a.md",
            "---\nOwner: /people/x.md\nrels: [\"[[n]]\", \"[[m]]\"]\n---\n\nSee [s](./s.md) and [u](../u.md)\n",
            T0,
        );
        let edges = rows(
            &store,
            "SELECT src_block, src_field, predicate, dst_node, provenance FROM edges ORDER BY rowid",
        );
        let view: Vec<(String, String)> = edges
            .iter()
            .map(|r| {
                let f = |v: &Sql| match v {
                    Sql::Text(t) => t.clone(),
                    _ => "null".to_owned(),
                };
                (f(&r[2]), f(&r[3]))
            })
            .collect();
        assert_eq!(
            view,
            [
                ("references".to_owned(), "phantom:dir/s.md".to_owned()),
                ("references".to_owned(), "phantom:u.md".to_owned()),
                ("Owner".to_owned(), "phantom:people/x.md".to_owned()),
                ("rels".to_owned(), "phantom:n".to_owned()),
                ("rels".to_owned(), "phantom:m".to_owned()),
            ]
        );
        assert_eq!(edges[2][0], Sql::Null);
        assert_eq!(edges[2][4], Sql::Text("frontmatter".into()));
        let samples = texts(
            &store,
            "SELECT samples FROM doc_edges WHERE predicate = 'Owner'",
        );
        assert_eq!(samples, ["[]"]);
    }

    #[test]
    fn deletion_leaves_the_graph_rows() {
        let (mut store, repo) = fixture();
        observe(&mut store, &repo, "a.md", "[b](b.md)\n", T0);
        observe(&mut store, &repo, "b.md", "# B\n\n[a](a.md)\n", T1);
        assert_eq!(
            texts(&store, "SELECT dst_node FROM edges ORDER BY rowid"),
            ["d_1", "d_0"]
        );
        store.observe_delete(&repo, "b.md", T2).unwrap();
        assert_eq!(
            texts(&store, "SELECT dst_node FROM edges ORDER BY rowid"),
            ["d_1", "d_0"],
            "edges stay open and keep the tombstoned doc's id"
        );
        let counts: Vec<i64> = ["nodes", "doc_edges"]
            .iter()
            .map(|t| {
                store
                    .conn()
                    .query_row(&format!("SELECT count(*) FROM {t} WHERE 1"), [], |r| {
                        r.get(0)
                    })
                    .unwrap()
            })
            .collect();
        assert_eq!(
            counts,
            [3, 2],
            "a's link; b's section and link; both rollups"
        );
        // While b.md is tombstoned, a new link to it resolves to a phantom.
        observe(&mut store, &repo, "c.md", "[b](b.md)\n", T2);
        assert_eq!(
            texts(&store, "SELECT dst_node FROM edges WHERE src_doc = 'd_2'"),
            ["phantom:b.md"]
        );
        // Re-creation revives the row: it becomes live, so it adopts that
        // phantom (§3.5); the edge that kept d_1 all along is untouched.
        observe(
            &mut store,
            &repo,
            "b.md",
            "# B2\n",
            "2026-09-26T10:03:00.000Z",
        );
        assert_eq!(
            texts(
                &store,
                "SELECT dst_node FROM edges WHERE dst_node LIKE 'd_%' AND src_doc != 'd_1' ORDER BY src_doc"
            ),
            ["d_1", "d_1"]
        );
        // The adopted edge's open transition followed the rewrite (M6).
        assert_eq!(
            texts(
                &store,
                "SELECT dst_node FROM edge_transitions WHERE src_doc = 'd_2' AND to_commit IS NULL"
            ),
            ["d_1"]
        );
        assert_eq!(
            texts(
                &store,
                "SELECT dst_node FROM doc_edges WHERE src_doc = 'd_2'"
            ),
            ["d_1"],
            "the affected rollup is recomputed"
        );
    }

    #[test]
    fn mint_order_is_x_during_resolution_then_e() {
        let (mut store, repo) = fixture();
        observe(
            &mut store,
            &repo,
            "a.md",
            "<https://b.com> then <https://a.com>\n",
            T0,
        );
        let ext = rows(
            &store,
            "SELECT node_id, uri FROM external_nodes ORDER BY node_id",
        );
        assert_eq!(
            ext[0],
            vec![Sql::Text("x_0".into()), Sql::Text("https://b.com".into())]
        );
        assert_eq!(
            ext[1],
            vec![Sql::Text("x_1".into()), Sql::Text("https://a.com".into())]
        );
        assert_eq!(
            texts(&store, "SELECT edge_id FROM edges ORDER BY rowid"),
            ["e_0", "e_1"]
        );
    }
}
