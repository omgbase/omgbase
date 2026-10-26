//! The recorder's immutable writers (`spec/store/README.md` §4.1, §4.4, §5.4
//! steps 0–6): blobs and tree nodes are content-addressed (`INSERT OR IGNORE`
//! gives structural sharing); since 16.0 a list or a frontmatter is written as
//! a delta over the previous revision's where that is smaller
//! ([`TreeWriteContext`]); revisions take the next per-document sequence
//! number, and the commit row (17.0, 3d) is the log's copy of the feed row
//! the core appended — the same id, epoch and seq. The core's half of the old
//! `writers` module — the id-assigned body ([`TreeInputBlock`]), `Origin`,
//! [`CommitRecord`] — is `core::writers`; this is what the
//! [`HistoryRecorder`] calls.
//!
//! [`HistoryRecorder`]: crate::core::capabilities::HistoryRecorder

use std::rc::Rc;

use omgbase_format::hash::{hex, sha256};
use omgbase_format::json::attrs_to_json;
use rusqlite::{Connection, OptionalExtension, params};

use crate::core::codec::from_hex;
use crate::core::writers::{CommitRecord, TreeInputBlock};
use crate::error::Result;
use crate::history::delta::{
    ResolvedList, ResolvedTree, encode_body_delta, encode_frontmatter_delta, entry_text,
    full_node_text, is_checkpoint_seq,
};
use crate::history::tree::{TreeEntry, serialize_tree_entries};

/// Content-address `text`'s UTF-8 bytes into `blobs`; returns the hex hash.
pub fn put_blob(conn: &Connection, text: &str) -> Result<String> {
    let bytes = text.as_bytes();
    let hash = sha256(bytes);
    conn.execute(
        "INSERT OR IGNORE INTO blobs (hash, bytes, size) VALUES (?1, ?2, ?3)",
        params![&hash[..], bytes, bytes.len() as i64],
    )?;
    Ok(hex(&hash))
}

/// Content-address a node's text (a `[`-form or a `{"d":…}` delta, §4.1)
/// into `tree_nodes`; returns the hex hash.
pub fn put_node_text(conn: &Connection, text: &str) -> Result<String> {
    let hash = sha256(text.as_bytes());
    conn.execute(
        "INSERT OR IGNORE INTO tree_nodes (hash, entries) VALUES (?1, ?2)",
        params![&hash[..], text],
    )?;
    Ok(hex(&hash))
}

/// Content-address a node's entries (full form) into `tree_nodes`; returns
/// the hex hash.
pub fn put_tree_node(conn: &Connection, entries: &[TreeEntry]) -> Result<String> {
    put_node_text(conn, &serialize_tree_entries(entries))
}

/// The revision context a tree is written in (§4.4, 16.0): the previous
/// revision's resolved tree (`None` when there is none, or it is archived —
/// then every node is full), and whether this revision is a checkpoint.
/// Without a context ([`write_block_tree`]) the writer is the 15.x one: every
/// node full.
#[derive(Clone, Debug)]
pub struct TreeWriteContext {
    pub base: Option<Rc<ResolvedTree>>,
    pub checkpoint: bool,
}

impl TreeWriteContext {
    /// No base, a checkpoint: the 15.x writer exactly.
    #[must_use]
    pub fn checkpoint() -> Self {
        Self {
            base: None,
            checkpoint: true,
        }
    }
}

/// A document's previous revision (its greatest `seq`) — the base a delta is
/// written against (§5.4 step 0).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviousRevision {
    pub rev_id: String,
    pub seq: i64,
    pub root_tree: Option<Vec<u8>>,
    pub frontmatter_blob: Option<Vec<u8>>,
    pub archive: Option<String>,
}

/// The previous revision of a document, or `None` for a new path.
pub fn previous_revision(conn: &Connection, doc_id: &str) -> Result<Option<PreviousRevision>> {
    Ok(conn
        .query_row(
            "SELECT rev_id, seq, root_tree, frontmatter_blob, archive FROM revisions WHERE doc_id = ?1 ORDER BY seq DESC LIMIT 1",
            params![doc_id],
            |r| {
                Ok(PreviousRevision {
                    rev_id: r.get(0)?,
                    seq: r.get(1)?,
                    root_tree: r.get(2)?,
                    frontmatter_blob: r.get(3)?,
                    archive: r.get(4)?,
                })
            },
        )
        .optional()?)
}

/// §4.4 rules 1–2: a revision is a checkpoint by cadence, or when it has no
/// live predecessor.
#[must_use]
pub fn is_checkpoint_revision(seq: i64, previous: Option<&PreviousRevision>) -> bool {
    is_checkpoint_seq(seq) || previous.is_none_or(|p| p.archive.is_some())
}

/// Write a sibling list bottom-up (§4.1 "Writing a tree") with every node in
/// full form — the 15.x writer, a valid 16.0 writer. Returns the root's hex
/// hash. The commit path uses [`write_block_tree_in`].
pub fn write_block_tree(conn: &Connection, blocks: &[TreeInputBlock]) -> Result<String> {
    write_block_tree_in(conn, blocks, &TreeWriteContext::checkpoint())
}

/// Write a sibling list bottom-up in a revision context (§4.1, §4.4, §5.4
/// step 4, 16.0): for each block its raw blob, its trivia blob when
/// non-empty, its children's node, then the entry; then this list — reused
/// (nothing written) when its texts equal the base list's and the base's node
/// is self-contained; full at a checkpoint or without a base list; else the
/// smaller in UTF-8 bytes of the delta against the base list and the full
/// node (the full node on a tie). Returns the node's hex hash.
pub fn write_block_tree_in(
    conn: &Connection,
    blocks: &[TreeInputBlock],
    ctx: &TreeWriteContext,
) -> Result<String> {
    write_list(conn, blocks, None, ctx)
}

fn write_list(
    conn: &Connection,
    blocks: &[TreeInputBlock],
    parent: Option<&str>,
    ctx: &TreeWriteContext,
) -> Result<String> {
    let mut texts = Vec::with_capacity(blocks.len());
    for b in blocks {
        let raw_hash_hex = put_blob(conn, &b.raw)?;
        let trivia_hash_hex = if b.trivia.is_empty() {
            None
        } else {
            Some(put_blob(conn, &b.trivia)?)
        };
        let child_tree_hash_hex = if b.children.is_empty() {
            None
        } else {
            Some(write_list(conn, &b.children, Some(&b.block_id), ctx)?)
        };
        texts.push(entry_text(&TreeEntry {
            block_id: b.block_id.clone(),
            raw_hash_hex,
            child_tree_hash_hex,
            kind: b.kind.clone(),
            attrs: attrs_to_json(&b.attrs),
            trivia_hash_hex,
        }));
    }
    let full = full_node_text(&texts);
    let base: Option<&Rc<ResolvedList>> = ctx.base.as_ref().and_then(|tree| match parent {
        None => Some(&tree.root),
        Some(p) => tree.by_block.get(p),
    });
    // An unchanged list reuses the base's node only when that node is context-free.
    if let Some(base) = base
        && base.self_contained
        && base.texts == texts
    {
        return Ok(base.hash.clone());
    }
    let Some(base) = base.filter(|_| !ctx.checkpoint) else {
        return put_node_text(conn, &full);
    };
    let delta = encode_body_delta(&base.texts, &texts);
    put_node_text(
        conn,
        if delta.len() < full.len() {
            &delta
        } else {
            &full
        },
    )
}

/// The frontmatter blob of a revision (§5.4 step 1, 16.0): the raw itself at
/// a checkpoint or when the previous revision had none; else the smaller in
/// UTF-8 bytes of the line delta against the previous raw and the raw (the
/// raw on a tie). Returns the blob's hex hash.
pub fn write_frontmatter_blob(
    conn: &Connection,
    raw: &str,
    base_raw: Option<&str>,
    checkpoint: bool,
) -> Result<String> {
    let Some(base_raw) = base_raw.filter(|_| !checkpoint) else {
        return put_blob(conn, raw);
    };
    let delta = encode_frontmatter_delta(base_raw, raw);
    put_blob(conn, if delta.len() < raw.len() { &delta } else { raw })
}

/// The recorder's `commits` row (`spec/store` §3.1, 17.0 — 3d): the log's
/// copy of a feed row the core appended (`core::feed::append_feed_row`),
/// under the same `commit_id`, `epoch` and `seq`, plus `ops` — the ADR-003
/// intent record of an effect-driven api commit, which only the recorder
/// keeps (M5).
pub fn record_commit(conn: &Connection, c: &CommitRecord<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO commits (commit_id, repo_id, epoch, seq, ts, origin, actor, reason, batch_id, ops)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            c.commit_id,
            c.repo_id,
            c.epoch,
            c.seq,
            c.ts,
            c.origin.as_str(),
            c.actor,
            c.reason,
            c.batch_id,
            c.ops,
        ],
    )?;
    Ok(())
}

/// What a revision row records besides its sequence number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewRevision<'a> {
    /// The head token the core minted for this transition (`spec/store` §5.4
    /// step 6, 17.0 D1) — the row's `rev_id`.
    pub rev_id: &'a str,
    pub doc_id: &'a str,
    pub root_tree_hex: &'a str,
    pub frontmatter_blob_hex: Option<&'a str>,
    pub rendered_hash: [u8; 32],
    pub path: &'a str,
    pub commit_id: &'a str,
    /// The per-document seq when the caller computed it already (§5.4 step 0:
    /// the commit needs it before the tree is written); `1 + max(seq)` otherwise.
    pub seq: Option<i64>,
}

/// Append a revision under the core's head token (§5.4 step 15; 17.0 — the
/// `r` mint is the core's, step 6): `seq = 1 + max(seq)` over the document
/// (or the caller's). Returns `(rev_id, seq)`.
pub fn write_revision(conn: &Connection, input: &NewRevision<'_>) -> Result<(String, i64)> {
    let rev_id = input.rev_id.to_owned();
    let seq: i64 = match input.seq {
        Some(seq) => seq,
        None => conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM revisions WHERE doc_id = ?1",
            params![input.doc_id],
            |r| r.get(0),
        )?,
    };
    let root_tree = from_hex(input.root_tree_hex)?;
    let frontmatter_blob = input.frontmatter_blob_hex.map(from_hex).transpose()?;
    conn.execute(
        "INSERT INTO revisions (rev_id, doc_id, seq, root_tree, frontmatter_blob, rendered_hash, path, commit_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            rev_id,
            input.doc_id,
            seq,
            root_tree,
            frontmatter_blob,
            &input.rendered_hash[..],
            input.path,
            input.commit_id,
        ],
    )?;
    Ok((rev_id, seq))
}
