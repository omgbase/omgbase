//! Reads this spec pins (`spec/store/README.md` §5.2, §6.1): the old tree for
//! the matcher, the pool, and byte reconstruction from the live rows. Since
//! store 17.0 (D10, M1) every byte a current read returns comes from the
//! `docs` and `blocks` rows — nothing here reads `blobs`, a revision or the
//! delta resolver; the two blob readers below serve the recorder's §6.2
//! reads (`history::read`, the surface's history module).

use std::collections::HashMap;

use omgbase_format::BlockKind;
use omgbase_format::hash::{hex, norm_hash};
use omgbase_format::text::{
    join_texts, normalize_text, normalize_visible_text, uses_children_text,
};
use omgbase_reconcile::{MatchBlock, PoolEntry};
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::Result;

/// A blob's bytes as text; `""` when the hash is unknown (as the reference).
/// A history read (§6.2): no current-state path reads a blob since 17.0.
pub fn blob_text(conn: &Connection, hash: &[u8]) -> Result<String> {
    blob_text_at(conn, "", hash)
}

/// [`blob_text`] over `<prefix>blobs` — `""` for the store's own table,
/// `"<alias>."` for an attached archive segment's (§6.2 "Through a segment",
/// 15.0; the prefix is [`crate::archive::RevisionBody::prefix`]).
pub fn blob_text_at(conn: &Connection, prefix: &str, hash: &[u8]) -> Result<String> {
    let bytes: Option<Vec<u8>> = conn
        .prepare_cached(&format!("SELECT bytes FROM {prefix}blobs WHERE hash = ?1"))?
        .query_row(params![hash], |r| r.get(0))
        .optional()?;
    Ok(bytes.map_or_else(String::new, |b| String::from_utf8_lossy(&b).into_owned()))
}

/// A live document's CURRENT frontmatter raw (`docs.frontmatter_raw`, 17.0):
/// the fences-included raw the current-state ingest wrote, or `None` when
/// the document has none (or is not live). A plain column read — through
/// 16.x this resolved the head revision's `frontmatter_blob` delta chain
/// (inventory-rust.md §3.2, the hottest current-state read through history;
/// M1).
pub fn current_frontmatter_raw(conn: &Connection, doc_id: &str) -> Result<Option<String>> {
    let row: Option<Option<String>> = conn
        .query_row(
            "SELECT frontmatter_raw FROM docs WHERE doc_id = ?1 AND deleted_at IS NULL",
            params![doc_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(row.flatten())
}

/// §6.1: `leading_trivia`, then `frontmatter_raw` + `frontmatter_trivia`
/// when the doc has one, then every top-level live block's `raw` + `trivia`
/// in `order_key` order. Every byte comes from the current rows (17.0, D10/M1
/// — nothing resolves and no history table is read). `None` for a tombstoned
/// or unknown doc.
pub fn reconstruct(conn: &Connection, doc_id: &str) -> Result<Option<String>> {
    let doc: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT leading_trivia, frontmatter_raw, frontmatter_trivia FROM docs
             WHERE doc_id = ?1 AND deleted_at IS NULL",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((leading, fm_raw, fm_trivia)) = doc else {
        return Ok(None);
    };
    let mut out = leading;
    // The frontmatter block followed by its exact stored separator: ingest
    // always captures `frontmatter_trivia` whenever a frontmatter block
    // exists, so the `unwrap_or("")` is just a guard.
    if let Some(fm) = fm_raw {
        out.push_str(&fm);
        out.push_str(fm_trivia.as_deref().unwrap_or(""));
    }
    // Top-level blocks only: a container's `raw` already contains its nested
    // children verbatim (spec/format §1 inv. 3), so walking roots
    // reconstructs the whole body.
    let mut stmt = conn.prepare(
        "SELECT raw, trivia FROM blocks
         WHERE doc_id = ?1 AND parent_block IS NULL AND deleted_at IS NULL
         ORDER BY order_key",
    )?;
    let rows = stmt.query_map(params![doc_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    for row in rows {
        let (raw, trivia) = row?;
        out.push_str(&raw);
        if let Some(t) = trivia {
            out.push_str(&t);
        }
    }
    Ok(Some(out))
}

/// A live block's raw source bytes — its own row's `raw` (17.0, D10; through
/// 16.x a `blobs` read by `raw_hash`); `""` when the block is not live.
pub fn block_raw(conn: &Connection, block_id: &str) -> Result<String> {
    let raw: Option<String> = conn
        .prepare_cached("SELECT raw FROM blocks WHERE block_id = ?1 AND deleted_at IS NULL")?
        .query_row(params![block_id], |r| r.get(0))
        .optional()?;
    Ok(raw.unwrap_or_default())
}

struct StoredBlock {
    block_id: String,
    parent_block: Option<String>,
    ordinal: i64,
    kind: String,
    raw_hash: Vec<u8>,
    raw: String,
}

/// §5.2: the matcher's old side from the live `blocks` rows, `ORDER BY
/// parent_block, ordinal` (pinned as built, §10), positional keys
/// `(parent_key ?? "") + "/" + ordinal`, `text` recomputed by the
/// spec/format §4.1 tree rule from the rows' own `raw` (17.0), `anchors = []`.
pub fn load_old_match_blocks(conn: &Connection, doc_id: &str) -> Result<Vec<MatchBlock>> {
    let rows: Vec<StoredBlock> = {
        let mut stmt = conn.prepare(
            "SELECT block_id, parent_block, ordinal, type, raw_hash, raw
             FROM blocks WHERE doc_id = ?1 AND deleted_at IS NULL
             ORDER BY parent_block, ordinal",
        )?;
        let it = stmt.query_map(params![doc_id], |r| {
            Ok(StoredBlock {
                block_id: r.get(0)?,
                parent_block: r.get(1)?,
                ordinal: r.get(2)?,
                kind: r.get(3)?,
                raw_hash: r.get(4)?,
                raw: r.get(5)?,
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
    let raws: Vec<String> = rows.iter().map(|r| r.raw.clone()).collect();

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
