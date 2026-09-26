//! History (`spec/surface/README.md` §3): `history_node`, the block-grain
//! `diff`, the positional `diff_unified` (§9, pinned), `docs_history`. Port
//! of `packages/core/src/graph/history.ts`; `changes_since` is the store's.

use std::collections::HashMap;

use omgbase_format::hash::hex;
use omgbase_store::tree::{from_hex, parse_tree_entries};
use omgbase_store::{Store, is_id_ref};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::error::Result;
use crate::read::find_doc_by_ref;

/// §3 `history_node`: `[{ commitId, seq, ts, origin, kind, confidence, reason }]`,
/// newest first.
pub fn history_node(store: &Store, block_id: &str, limit: Option<i64>) -> Result<Json> {
    let limit = limit.unwrap_or(100);
    let mut stmt = store.conn().prepare(
        "SELECT bc.commit_id, c.seq, c.ts, c.origin, bc.kind, d.confidence, d.reason
         FROM block_changes bc
         JOIN commits c ON c.commit_id = bc.commit_id
         LEFT JOIN dispositions d ON d.commit_id = bc.commit_id AND d.block_id = bc.block_id AND d.kind = bc.kind
         WHERE bc.block_id = ?1
         ORDER BY c.seq DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![block_id, limit], |r| {
        Ok(json!({
            "commitId": r.get::<_, String>(0)?,
            "seq": r.get::<_, i64>(1)?,
            "ts": r.get::<_, String>(2)?,
            "origin": r.get::<_, String>(3)?,
            "kind": r.get::<_, String>(4)?,
            "confidence": r.get::<_, Option<f64>>(5)?,
            "reason": r.get::<_, Option<String>>(6)?,
        }))
    })?;
    Ok(Json::Array(
        rows.collect::<std::result::Result<Vec<_>, _>>()?,
    ))
}

/// The (block id → raw) map of a document at a revision, walking the Merkle
/// tree to every depth (insertion order = tree order, roots first).
fn blocks_at_revision(
    conn: &Connection,
    doc_id: &str,
    rev_id: &str,
) -> Result<Vec<(String, String)>> {
    match blocks_at_known_revision(conn, doc_id, rev_id)? {
        Some(rows) => Ok(rows),
        None => Err(crate::error::SurfaceError::with_data(
            "target_missing",
            format!(
                "no revision {} for document {doc_id}",
                Json::String(rev_id.to_owned())
            ),
            json!({ "doc": doc_id, "rev": rev_id }),
        )),
    }
}

/// `None` when `rev_id` is not one of the doc's revisions (§9: an unknown
/// revision is `target_missing`, not an empty tree).
fn blocks_at_known_revision(
    conn: &Connection,
    doc_id: &str,
    rev_id: &str,
) -> Result<Option<Vec<(String, String)>>> {
    let root: Option<Vec<u8>> = conn
        .query_row(
            "SELECT root_tree FROM revisions WHERE rev_id = ?1 AND doc_id = ?2",
            params![rev_id, doc_id],
            |r| r.get(0),
        )
        .optional()?;
    let mut out: Vec<(String, String)> = Vec::new();
    let Some(root) = root else {
        return Ok(None);
    };
    fn walk(conn: &Connection, tree: &[u8], out: &mut Vec<(String, String)>) -> Result<()> {
        let entries: Option<String> = conn
            .query_row(
                "SELECT entries FROM tree_nodes WHERE hash = ?1",
                params![tree],
                |r| r.get(0),
            )
            .optional()?;
        let Some(text) = entries else {
            return Ok(());
        };
        for e in parse_tree_entries(&text)? {
            let raw = omgbase_store::read::blob_text(conn, &from_hex(&e.raw_hash_hex)?)?;
            match out.iter_mut().find(|(id, _)| *id == e.block_id) {
                Some(slot) => slot.1 = raw,
                None => out.push((e.block_id.clone(), raw)),
            }
            if let Some(child) = &e.child_tree_hash_hex {
                walk(conn, &from_hex(child)?, out)?;
            }
        }
        Ok(())
    }
    walk(conn, &root, &mut out)?;
    Ok(Some(out))
}

/// §3 `diff`: `removed`, `changed`, `added` entries in that order.
pub fn diff_blocks(store: &Store, doc_id: &str, from_rev: &str, to_rev: &str) -> Result<Json> {
    let before = blocks_at_revision(store.conn(), doc_id, from_rev)?;
    let after = blocks_at_revision(store.conn(), doc_id, to_rev)?;
    let after_map: HashMap<&str, &str> = after
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let before_map: HashMap<&str, &str> = before
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let mut entries = Vec::new();
    for (id, raw) in &before {
        match after_map.get(id.as_str()) {
            None => entries.push(json!({ "kind": "removed", "blockId": id, "before": raw })),
            Some(a) if *a != raw => {
                entries
                    .push(json!({ "kind": "changed", "blockId": id, "before": raw, "after": a }));
            }
            Some(_) => {}
        }
    }
    for (id, raw) in &after {
        if !before_map.contains_key(id.as_str()) {
            entries.push(json!({ "kind": "added", "blockId": id, "after": raw }));
        }
    }
    Ok(Json::Array(entries))
}

/// §3 `diff_unified`'s text: the two revisions' raws joined by `\n`,
/// compared line by line at equal indices (positional; §9).
pub fn diff_unified_text(
    store: &Store,
    doc_id: &str,
    from_rev: &str,
    to_rev: &str,
) -> Result<String> {
    let rendered = |rev: &str| -> Result<Vec<String>> {
        let raws: Vec<String> = blocks_at_revision(store.conn(), doc_id, rev)?
            .into_iter()
            .map(|(_, raw)| raw)
            .collect();
        Ok(raws.join("\n").split('\n').map(str::to_owned).collect())
    };
    let a = rendered(from_rev)?;
    let b = rendered(to_rev)?;
    let mut out = Vec::new();
    for i in 0..a.len().max(b.len()) {
        if a.get(i) == b.get(i) {
            continue;
        }
        if let Some(l) = a.get(i) {
            out.push(format!("- {l}"));
        }
        if let Some(l) = b.get(i) {
            out.push(format!("+ {l}"));
        }
    }
    Ok(out.join("\n"))
}

/// The two most recent revisions of a doc, newest first.
pub fn recent_revs(conn: &Connection, doc_id: &str) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT rev_id FROM revisions WHERE doc_id = ?1 ORDER BY seq DESC LIMIT 2")?;
    let rows = stmt.query_map(params![doc_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// A `docs` row: `(doc_id, path, current_rev, deleted_commit)`.
pub type DocRow = (String, String, Option<String>, Option<String>);

/// The `docs` row of a ref, looking through a tombstone when `include_deleted`.
pub fn resolve_doc_row(
    conn: &Connection,
    repo_id: &str,
    r: &str,
    include_deleted: bool,
) -> Result<Option<DocRow>> {
    type Row = DocRow;
    let by_id = |id: &str| -> Result<Option<Row>> {
        Ok(conn
            .query_row(
                "SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE doc_id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?)
    };
    if let Some(info) = find_doc_by_ref(conn, repo_id, r)? {
        return by_id(&info.doc_id);
    }
    if !include_deleted {
        return Ok(None);
    }
    if is_id_ref(r, "d") {
        return by_id(r);
    }
    Ok(conn
        .query_row(
            "SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE repo_id = ?1 AND path = ?2",
            params![repo_id, r],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?)
}

/// §3 `docs_history`: `{ docs: [{ docId, path, deleted, currentRev, versions }], truncated }`.
pub fn docs_history(
    store: &Store,
    repo_id: &str,
    path_glob: Option<&str>,
    doc: Option<&str>,
    include_deleted: bool,
    limit: Option<i64>,
) -> Result<Json> {
    let conn = store.conn();
    let limit = usize::try_from(limit.unwrap_or(50).max(0)).unwrap_or(0);
    type Row = (String, String, Option<String>, Option<String>);
    let mut doc_rows: Vec<Row> = if let Some(d) = doc {
        resolve_doc_row(conn, repo_id, d, include_deleted)?
            .into_iter()
            .collect()
    } else if let Some(glob) = path_glob {
        let deleted_clause = if include_deleted {
            ""
        } else {
            "AND deleted_commit IS NULL"
        };
        let (path_clause, param) = if glob.contains('*') {
            (
                "path LIKE ?2 ESCAPE '\\'",
                crate::context::glob_to_like(glob, false),
            )
        } else {
            ("path = ?2", glob.to_owned())
        };
        let sql = format!(
            "SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE repo_id = ?1 AND {path_clause} {deleted_clause} ORDER BY path LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![
                repo_id,
                param,
                i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1)
            ],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        return Err(crate::error::SurfaceError::other(
            "docHistory requires one of { doc, pathGlob }",
        ));
    };
    let truncated = doc_rows.len() > limit;
    doc_rows.truncate(limit);
    let mut rev_stmt = conn.prepare(
        "SELECT r.rev_id, r.seq, r.commit_id, r.rendered_hash, c.ts, c.origin, c.actor
         FROM revisions r JOIN commits c ON c.commit_id = r.commit_id
         WHERE r.doc_id = ?1 ORDER BY r.seq ASC",
    )?;
    let mut docs = Vec::new();
    for (doc_id, path, current_rev, deleted_commit) in doc_rows {
        let versions: Vec<Json> = rev_stmt
            .query_map(params![doc_id], |r| {
                let rev: String = r.get(0)?;
                let hash: Vec<u8> = r.get(3)?;
                Ok(json!({
                    "rev": rev,
                    "seq": r.get::<_, i64>(1)?,
                    "commit": r.get::<_, String>(2)?,
                    "ts": r.get::<_, String>(4)?,
                    "origin": r.get::<_, String>(5)?,
                    "actor": r.get::<_, Option<String>>(6)?,
                    "contentHash": hex(&hash),
                    "isCurrent": current_rev.as_deref() == Some(rev.as_str()),
                }))
            })?
            .collect::<std::result::Result<_, _>>()?;
        let mut m = Map::new();
        m.insert("docId".to_owned(), json!(doc_id));
        m.insert("path".to_owned(), json!(path));
        m.insert("deleted".to_owned(), json!(deleted_commit.is_some()));
        m.insert("currentRev".to_owned(), json!(current_rev));
        m.insert("versions".to_owned(), Json::Array(versions));
        docs.push(Json::Object(m));
    }
    Ok(json!({ "docs": docs, "truncated": truncated }))
}
