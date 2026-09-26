//! Reads this spec pins (`spec/store/README.md` §5.2, §6): the old tree for
//! the matcher, the pool, and byte reconstruction from the live rows or a
//! revision's Merkle root.

use std::collections::HashMap;

use omgbase_format::BlockKind;
use omgbase_format::hash::{hex, norm_hash, sha256};
use omgbase_format::text::{
    join_texts, normalize_text, normalize_visible_text, uses_children_text,
};
use omgbase_reconcile::{MatchBlock, PoolEntry};
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::Result;
use crate::tree::{from_hex, parse_tree_entries};

/// A blob's bytes as text; `""` when the hash is unknown (as the reference).
pub fn blob_text(conn: &Connection, hash: &[u8]) -> Result<String> {
    let bytes: Option<Vec<u8>> = conn
        .query_row(
            "SELECT bytes FROM blobs WHERE hash = ?1",
            params![hash],
            |r| r.get(0),
        )
        .optional()?;
    Ok(bytes.map_or_else(String::new, |b| String::from_utf8_lossy(&b).into_owned()))
}

/// §6.1: `leading_trivia`, the frontmatter blob + `frontmatter_trivia` when
/// the current revision has one, then every top-level live block's raw and
/// trivia in `order_key` order. `None` for a tombstoned or unknown doc.
pub fn reconstruct(conn: &Connection, doc_id: &str) -> Result<Option<String>> {
    let doc: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT leading_trivia, frontmatter_trivia, current_rev FROM docs
             WHERE doc_id = ?1 AND deleted_commit IS NULL",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((leading, fm_trivia, current_rev)) = doc else {
        return Ok(None);
    };
    let mut out = leading;
    if let Some(rev) = current_rev {
        let fm: Option<Option<Vec<u8>>> = conn
            .query_row(
                "SELECT frontmatter_blob FROM revisions WHERE rev_id = ?1",
                params![rev],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(Some(hash)) = fm {
            out.push_str(&blob_text(conn, &hash)?);
            out.push_str(fm_trivia.as_deref().unwrap_or(""));
        }
    }
    let mut stmt = conn.prepare(
        "SELECT raw_hash, trivia_hash FROM blocks
         WHERE doc_id = ?1 AND parent_block IS NULL AND deleted_commit IS NULL
         ORDER BY order_key",
    )?;
    let rows = stmt.query_map(params![doc_id], |r| {
        Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Option<Vec<u8>>>(1)?))
    })?;
    for row in rows {
        let (raw, trivia) = row?;
        out.push_str(&blob_text(conn, &raw)?);
        if let Some(t) = trivia {
            out.push_str(&blob_text(conn, &t)?);
        }
    }
    Ok(Some(out))
}

/// The result of [`read_at_revision`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevisionRead {
    /// The path as of that revision.
    pub path: String,
    pub content: String,
    /// `sha256(content) == revisions.rendered_hash`: byte-exact when true.
    pub rendered_hash_match: bool,
}

/// §6.2: the same assembly sourced from the revision's Merkle root (children
/// not walked), with `leading_trivia`/`frontmatter_trivia` from the current
/// doc row. `None` when the doc is not live or `rev_id` is not one of its
/// revisions.
pub fn read_at_revision(
    conn: &Connection,
    doc_id: &str,
    rev_id: &str,
) -> Result<Option<RevisionRead>> {
    let doc: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT leading_trivia, frontmatter_trivia FROM docs WHERE doc_id = ?1 AND deleted_commit IS NULL",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((leading, fm_trivia)) = doc else {
        return Ok(None);
    };
    type RevRow = (Vec<u8>, Option<Vec<u8>>, Vec<u8>, String);
    let rev: Option<RevRow> = conn
        .query_row(
            "SELECT root_tree, frontmatter_blob, rendered_hash, path FROM revisions WHERE rev_id = ?1 AND doc_id = ?2",
            params![rev_id, doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((root_tree, fm_blob, rendered_hash, path)) = rev else {
        return Ok(None);
    };
    let mut out = leading;
    if let Some(hash) = fm_blob {
        out.push_str(&blob_text(conn, &hash)?);
        out.push_str(fm_trivia.as_deref().unwrap_or(""));
    }
    let entries: Option<String> = conn
        .query_row(
            "SELECT entries FROM tree_nodes WHERE hash = ?1",
            params![root_tree],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(text) = entries {
        for e in parse_tree_entries(&text)? {
            out.push_str(&blob_text(conn, &from_hex(&e.raw_hash_hex)?)?);
            if let Some(t) = e.trivia_hash_hex {
                out.push_str(&blob_text(conn, &from_hex(&t)?)?);
            }
        }
    }
    let rendered_hash_match = sha256(out.as_bytes())[..] == rendered_hash[..];
    Ok(Some(RevisionRead {
        path,
        content: out,
        rendered_hash_match,
    }))
}

struct StoredBlock {
    block_id: String,
    parent_block: Option<String>,
    ordinal: i64,
    kind: String,
    raw_hash: Vec<u8>,
}

/// §5.2: the matcher's old side from the live `blocks` rows, `ORDER BY
/// parent_block, ordinal` (pinned as built, §10), positional keys
/// `(parent_key ?? "") + "/" + ordinal`, `text` recomputed by the
/// spec/format §4.1 tree rule, `anchors = []`.
pub fn load_old_match_blocks(conn: &Connection, doc_id: &str) -> Result<Vec<MatchBlock>> {
    let rows: Vec<StoredBlock> = {
        let mut stmt = conn.prepare(
            "SELECT block_id, parent_block, ordinal, type, raw_hash
             FROM blocks WHERE doc_id = ?1 AND deleted_commit IS NULL
             ORDER BY parent_block, ordinal",
        )?;
        let it = stmt.query_map(params![doc_id], |r| {
            Ok(StoredBlock {
                block_id: r.get(0)?,
                parent_block: r.get(1)?,
                ordinal: r.get(2)?,
                kind: r.get(3)?,
                raw_hash: r.get(4)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let index_of: HashMap<&str, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| (r.block_id.as_str(), i))
        .collect();
    // The effective parent: an unknown parent id counts as top level.
    let parent_of: Vec<Option<usize>> = rows
        .iter()
        .map(|r| {
            r.parent_block
                .as_deref()
                .and_then(|p| index_of.get(p).copied())
        })
        .collect();
    let mut children: HashMap<Option<usize>, Vec<usize>> = HashMap::new();
    for (i, p) in parent_of.iter().enumerate() {
        children.entry(*p).or_default().push(i);
    }
    for list in children.values_mut() {
        list.sort_by_key(|&i| rows[i].ordinal);
    }
    let raws: Vec<String> = rows
        .iter()
        .map(|r| blob_text(conn, &r.raw_hash))
        .collect::<Result<_>>()?;

    // Text top-down (quote depth) with children composed bottom-up.
    fn text_of(
        i: usize,
        quote_depth: usize,
        rows: &[StoredBlock],
        raws: &[String],
        children: &HashMap<Option<usize>, Vec<usize>>,
        texts: &mut Vec<Option<String>>,
    ) -> String {
        let kind = rows[i].kind.parse::<BlockKind>().ok();
        let kids = children.get(&Some(i)).map_or(&[][..], Vec::as_slice);
        let child_depth = quote_depth + usize::from(kind == Some(BlockKind::Blockquote));
        let child_texts: Vec<String> = kids
            .iter()
            .map(|&c| text_of(c, child_depth, rows, raws, children, texts))
            .collect();
        let text = match kind {
            Some(k) if uses_children_text(k, !kids.is_empty()) => {
                join_texts(child_texts.iter().map(String::as_str))
            }
            Some(k) => normalize_visible_text(&raws[i], k, quote_depth),
            // An unknown (non-Markdown) kind: whitespace normalization only.
            None => normalize_text(&raws[i]),
        };
        texts[i] = Some(text.clone());
        text
    }
    let mut texts: Vec<Option<String>> = vec![None; rows.len()];
    for &root in children.get(&None).map_or(&[][..], Vec::as_slice) {
        text_of(root, 0, &rows, &raws, &children, &mut texts);
    }

    fn key_of(i: usize, parent_of: &[Option<usize>], rows: &[StoredBlock]) -> String {
        let parent_key = parent_of[i].map(|p| key_of(p, parent_of, rows));
        format!("{}/{}", parent_key.unwrap_or_default(), rows[i].ordinal)
    }
    Ok(rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let text = texts[i].clone().unwrap_or_default();
            MatchBlock {
                id: Some(r.block_id.clone()),
                kind: r.kind.clone(),
                raw_hash: hex(&r.raw_hash),
                norm_hash: hex(&norm_hash(&text)),
                text,
                anchors: Vec::new(),
                parent_key: parent_of[i].map(|p| key_of(p, &parent_of, &rows)),
                index: usize::try_from(r.ordinal).unwrap_or(0),
                key: key_of(i, &parent_of, &rows),
            }
        })
        .collect())
}

/// §5.1: the repo's pool rows with `expires_ts > ts`, in row order.
pub fn load_pool(conn: &Connection, repo_id: &str, ts: &str) -> Result<Vec<PoolEntry>> {
    let mut stmt = conn.prepare(
        "SELECT block_id, raw_hash, norm_hash, type FROM resurrection_pool
         WHERE repo_id = ?1 AND expires_ts > ?2 ORDER BY rowid",
    )?;
    let rows = stmt.query_map(params![repo_id, ts], |r| {
        Ok(PoolEntry {
            id: r.get(0)?,
            raw_hash: hex(&r.get::<_, Vec<u8>>(1)?),
            norm_hash: hex(&r.get::<_, Vec<u8>>(2)?),
            kind: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}
