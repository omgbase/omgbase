//! Immutable writers (`spec/store/README.md` §4.1, §5.4 steps 4–6): blobs
//! and tree nodes are content-addressed (`INSERT OR IGNORE` gives structural
//! sharing); commits and revisions take the next per-repo / per-document
//! sequence number.

use std::collections::BTreeMap;

use omgbase_format::hash::{hex, sha256};
use omgbase_format::json::attrs_to_json;
use omgbase_format::{Attrs, Block};
use rusqlite::{Connection, params};

use crate::error::Result;
use crate::ids::IdMinter;
use crate::tree::{TreeEntry, from_hex, serialize_tree_entries};

/// A block with its id, ready to encode into the tree and the `blocks` rows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeInputBlock {
    pub block_id: String,
    /// The spec/format §3 kind name (`blocks.type`).
    pub kind: String,
    pub raw: String,
    /// Visible text (spec/format §4.1), computed in tree context.
    pub text: String,
    /// Trailing trivia (top level only; `""` below).
    pub trivia: String,
    pub attrs: Attrs,
    pub children: Vec<TreeInputBlock>,
}

/// Assign ids from a reconcile assignment (new positional key → id) onto a
/// parsed body tree; a key the assignment misses mints `b` (the reference's
/// `assignFromMap`; spec §5.4 step 3 says every key is assigned).
#[must_use]
pub fn assign_from_map(
    blocks: &[Block],
    assignment: &BTreeMap<String, String>,
    minter: &mut dyn IdMinter,
) -> Vec<TreeInputBlock> {
    fn walk(
        list: &[Block],
        parent_key: Option<&str>,
        assignment: &BTreeMap<String, String>,
        minter: &mut dyn IdMinter,
    ) -> Vec<TreeInputBlock> {
        list.iter()
            .enumerate()
            .map(|(index, b)| {
                let key = format!("{}/{index}", parent_key.unwrap_or(""));
                let block_id = assignment
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| minter.mint("b"));
                TreeInputBlock {
                    block_id,
                    kind: b.kind.as_str().to_owned(),
                    raw: b.raw.clone(),
                    text: b.text.clone(),
                    trivia: b.trivia.clone(),
                    attrs: b.attrs.clone(),
                    children: walk(&b.children, Some(&key), assignment, minter),
                }
            })
            .collect()
    }
    walk(blocks, None, assignment, minter)
}

/// Mint a fresh `b` id for every block (the re-mint path).
#[must_use]
pub fn assign_fresh_ids(blocks: &[Block], minter: &mut dyn IdMinter) -> Vec<TreeInputBlock> {
    assign_from_map(blocks, &BTreeMap::new(), minter)
}

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

/// Content-address a node's entries into `tree_nodes`; returns the hex hash.
pub fn put_tree_node(conn: &Connection, entries: &[TreeEntry]) -> Result<String> {
    let serialized = serialize_tree_entries(entries);
    let hash = sha256(serialized.as_bytes());
    conn.execute(
        "INSERT OR IGNORE INTO tree_nodes (hash, entries) VALUES (?1, ?2)",
        params![&hash[..], serialized],
    )?;
    Ok(hex(&hash))
}

/// Write a sibling list bottom-up (§4.1 "Writing a tree"): for each block
/// its raw blob, its trivia blob when non-empty, its children's node, then
/// the entry; finally this node. Returns the node's hex hash.
pub fn write_block_tree(conn: &Connection, blocks: &[TreeInputBlock]) -> Result<String> {
    let mut entries = Vec::with_capacity(blocks.len());
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
            Some(write_block_tree(conn, &b.children)?)
        };
        entries.push(TreeEntry {
            block_id: b.block_id.clone(),
            raw_hash_hex,
            child_tree_hash_hex,
            kind: b.kind.clone(),
            attrs: attrs_to_json(&b.attrs),
            trivia_hash_hex,
        });
    }
    put_tree_node(conn, &entries)
}

/// `commits.origin`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Api,
    Observed,
    Import,
    Projection,
}

impl Origin {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Origin::Api => "api",
            Origin::Observed => "observed",
            Origin::Import => "import",
            Origin::Projection => "projection",
        }
    }
}

/// What a commit row records besides its minted id and sequence number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewCommit<'a> {
    pub repo_id: &'a str,
    pub ts: &'a str,
    pub origin: Origin,
    pub actor: Option<&'a str>,
    pub reason: Option<&'a str>,
    pub checkpoint_id: Option<&'a str>,
    pub ops: Option<&'a str>,
}

impl<'a> NewCommit<'a> {
    /// An `observed` commit with every optional column `NULL`.
    #[must_use]
    pub fn observed(repo_id: &'a str, ts: &'a str) -> Self {
        Self {
            repo_id,
            ts,
            origin: Origin::Observed,
            actor: None,
            reason: None,
            checkpoint_id: None,
            ops: None,
        }
    }
}

/// Append a commit (§5.4 step 5): **mints `c`**, `seq = 1 + max(seq)` over
/// the repo. Returns `(commit_id, seq)`.
pub fn new_commit(
    conn: &Connection,
    minter: &mut dyn IdMinter,
    input: &NewCommit<'_>,
) -> Result<(String, i64)> {
    let commit_id = minter.mint("c");
    let seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM commits WHERE repo_id = ?1",
        params![input.repo_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO commits (commit_id, repo_id, seq, ts, origin, actor, reason, checkpoint_id, ops)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            commit_id,
            input.repo_id,
            seq,
            input.ts,
            input.origin.as_str(),
            input.actor,
            input.reason,
            input.checkpoint_id,
            input.ops,
        ],
    )?;
    Ok((commit_id, seq))
}

/// What a revision row records besides its minted id and sequence number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewRevision<'a> {
    pub doc_id: &'a str,
    pub root_tree_hex: &'a str,
    pub frontmatter_blob_hex: Option<&'a str>,
    pub rendered_hash: [u8; 32],
    pub path: &'a str,
    pub commit_id: &'a str,
}

/// Append a revision (§5.4 step 6): **mints `r`**, `seq = 1 + max(seq)` over
/// the document. Returns `(rev_id, seq)`.
pub fn write_revision(
    conn: &Connection,
    minter: &mut dyn IdMinter,
    input: &NewRevision<'_>,
) -> Result<(String, i64)> {
    let rev_id = minter.mint("r");
    let seq: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM revisions WHERE doc_id = ?1",
        params![input.doc_id],
        |r| r.get(0),
    )?;
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
