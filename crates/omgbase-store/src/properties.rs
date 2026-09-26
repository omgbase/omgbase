//! The `properties` table (`spec/properties` §6; `spec/store` §5.4 after the
//! blocks refresh): the document's rows are computed by `omgbase-properties`
//! from the assigned body tree and the frontmatter block, deleted, then
//! written with `INSERT OR REPLACE` on `prop_id`. Current-state only: rebuilt
//! by re-ingest, never by `rebuild_index`.

use omgbase_format::BlockKind;
use omgbase_properties::{Card, DocBlock, PropertyRow, Source, ValueType};
use rusqlite::{Connection, params};

use crate::error::{Error, Result};
use crate::writers::TreeInputBlock;

/// The crate's input view of an assigned body tree. A stored kind name the
/// block model does not know is scanned as `opaque` (prose, no attrs).
#[must_use]
pub fn doc_blocks(blocks: &[TreeInputBlock]) -> Vec<DocBlock<'_>> {
    blocks
        .iter()
        .map(|b| DocBlock {
            block_id: b.block_id.as_str(),
            kind: b.kind.parse().unwrap_or(BlockKind::Opaque),
            raw: b.raw.as_str(),
            text: b.text.as_str(),
            attrs: &b.attrs,
            children: doc_blocks(&b.children),
        })
        .collect()
}

/// §6: replace the document's rows. `created_commit` is the commit;
/// `deleted_commit` stays `NULL`. A NaN `val_num` binds as `NULL` (the row
/// keeps `type = 'number'`, spec/properties §8). Returns how many rows were
/// written.
pub fn write_doc_properties(
    conn: &Connection,
    repo_id: &str,
    doc_id: &str,
    commit_id: &str,
    rows: &[PropertyRow],
) -> Result<usize> {
    conn.execute("DELETE FROM properties WHERE doc_id = ?1", params![doc_id])?;
    let mut insert = conn.prepare_cached(
        "INSERT OR REPLACE INTO properties
           (prop_id, repo_id, doc_id, block_id, source, key, card, ord,
            val_text, val_num, val_bool, val_json, type, created_commit)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
    )?;
    for r in rows {
        insert.execute(params![
            r.prop_id,
            repo_id,
            doc_id,
            r.block_id,
            r.source.as_str(),
            r.key,
            r.card.as_str(),
            i64::from(r.ord),
            r.val_text,
            r.val_num.filter(|n| !n.is_nan()),
            r.val_bool.map(i64::from),
            r.val_json,
            r.ty.as_str(),
            commit_id,
        ])?;
    }
    Ok(rows.len())
}

/// The document's live rows, in `rowid` order (the write order of §6).
pub fn read_doc_properties(conn: &Connection, doc_id: &str) -> Result<Vec<PropertyRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT prop_id, block_id, source, key, card, ord, type, val_text, val_num, val_bool, val_json
           FROM properties WHERE doc_id = ?1 AND deleted_commit IS NULL ORDER BY rowid",
    )?;
    let rows = stmt.query_map(params![doc_id], |r| {
        let source: String = r.get(2)?;
        let card: String = r.get(4)?;
        let ty: String = r.get(6)?;
        let ord: i64 = r.get(5)?;
        let val_bool: Option<i64> = r.get(9)?;
        Ok((
            PropertyRow {
                prop_id: r.get(0)?,
                block_id: r.get(1)?,
                source: Source::Frontmatter,
                key: r.get(3)?,
                card: Card::Scalar,
                ord: u32::try_from(ord).unwrap_or(u32::MAX),
                ty: ValueType::Null,
                val_text: r.get(7)?,
                val_num: r.get(8)?,
                val_bool: val_bool.map(|b| b != 0),
                val_json: r.get(10)?,
            },
            source,
            card,
            ty,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (mut p, source, card, ty) = row?;
        p.source = Source::parse(&source)
            .ok_or_else(|| Error::Other(format!("properties.source {source:?} is not a source")))?;
        p.card = Card::parse(&card)
            .ok_or_else(|| Error::Other(format!("properties.card {card:?} is not a card")))?;
        p.ty = ValueType::parse(&ty)
            .ok_or_else(|| Error::Other(format!("properties.type {ty:?} is not a type")))?;
        // A stored `number` with `val_num = NULL` is NaN (spec/properties §8).
        if p.ty == ValueType::Number && p.val_num.is_none() {
            p.val_num = Some(f64::NAN);
        }
        out.push(p);
    }
    Ok(out)
}
