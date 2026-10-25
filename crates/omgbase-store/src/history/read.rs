//! `spec/store/README.md` §6.2: a document's bytes at a revision, from the
//! revision's Merkle root — through its archive segment when archived (15.0)
//! and through the previous revisions when it is a delta (16.0). The current
//! reads (`reconstruct`, the matcher's old side, the pool) are `core::read`.

use omgbase_format::hash::{hex, sha256};
use rusqlite::{Connection, OptionalExtension, params};

pub use crate::core::capabilities::RevisionRead;
use crate::core::codec::from_hex;
use crate::core::read::blob_text_at;
use crate::error::Result;
use crate::history::delta::TreeResolver;

/// §6.2: the same assembly sourced from the revision's Merkle root (children
/// not walked), with `leading_trivia`/`frontmatter_trivia` from the current
/// doc row. `None` when the doc is not live or `rev_id` is not one of its
/// revisions. An archived revision (15.0) reads **through its segment**,
/// attached on demand ([`crate::archive::revision_body`]); a segment that is
/// not recorded or not on disk is [`crate::Error::RevisionArchived`]. A
/// `{`-form root or frontmatter (16.0) resolves through the previous
/// revisions of the document ([`TreeResolver`]); a segment holds checkpoint
/// forms only.
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
    let Some(rev) = crate::history::archive::revision_body(conn, rev_id, Some(doc_id))? else {
        return Ok(None);
    };
    let prefix = rev.prefix.as_str();
    let mut resolver = TreeResolver::with_prefix(conn, prefix);
    let mut out = leading;
    if let Some(hash) = &rev.frontmatter_blob {
        out.push_str(&resolver.frontmatter(&rev.doc_id, rev.seq, &hex(hash))?);
        out.push_str(fm_trivia.as_deref().unwrap_or(""));
    }
    let root = resolver.list(&rev.doc_id, rev.seq, &hex(&rev.root_tree), None)?;
    for e in &root.entries {
        out.push_str(&blob_text_at(conn, prefix, &from_hex(&e.raw_hash_hex)?)?);
        if let Some(t) = &e.trivia_hash_hex {
            out.push_str(&blob_text_at(conn, prefix, &from_hex(t)?)?);
        }
    }
    let rendered_hash_match = sha256(out.as_bytes())[..] == rev.rendered_hash[..];
    Ok(Some(RevisionRead {
        path: rev.path,
        content: out,
        rendered_hash_match,
    }))
}
