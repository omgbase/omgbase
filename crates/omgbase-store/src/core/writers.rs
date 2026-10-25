//! The core's half of the write vocabulary (`spec/store/README.md` §5.4):
//! the id-assigned body a commit writes ([`TreeInputBlock`], §5.4 step 3 —
//! what the `blocks` rows mirror and what the recorder encodes into its
//! tree), and the commit row's provenance ([`Origin`], [`NewCommit`], step 5
//! — what the core hands
//! [`HistoryRecorder::new_commit`](crate::core::capabilities::HistoryRecorder::new_commit)).
//! The immutable writers themselves — blobs, tree nodes, revisions, the
//! commit row — are the recorder's (`history::writers`).

use std::collections::BTreeMap;

use omgbase_format::{Attrs, Block, Span};

use crate::core::mint::Mint;
use crate::error::Result;

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
    /// The block's source span (spec/format §1): what `own_text` uses to
    /// blank a container's children when the properties and graph layers
    /// scan (spec/properties §3.2, spec/graph §1). Not stored.
    pub span: Span,
    pub children: Vec<TreeInputBlock>,
}

/// Assign ids from a reconcile assignment (new positional key → id) onto a
/// parsed body tree; a key the assignment misses mints `b` (the reference's
/// `assignFromMap`; spec §5.4 step 3 says every key is assigned).
pub fn assign_from_map(
    blocks: &[Block],
    assignment: &BTreeMap<String, String>,
    minter: &mut Mint<'_>,
) -> Result<Vec<TreeInputBlock>> {
    fn walk(
        list: &[Block],
        parent_key: Option<&str>,
        assignment: &BTreeMap<String, String>,
        minter: &mut Mint<'_>,
    ) -> Result<Vec<TreeInputBlock>> {
        list.iter()
            .enumerate()
            .map(|(index, b)| {
                let key = format!("{}/{index}", parent_key.unwrap_or(""));
                let block_id = match assignment.get(&key) {
                    Some(id) => id.clone(),
                    None => minter.mint("b")?,
                };
                Ok(TreeInputBlock {
                    block_id,
                    kind: b.kind.as_str().to_owned(),
                    raw: b.raw.clone(),
                    text: b.text.clone(),
                    trivia: b.trivia.clone(),
                    attrs: b.attrs.clone(),
                    span: b.span,
                    children: walk(&b.children, Some(&key), assignment, minter)?,
                })
            })
            .collect()
    }
    walk(blocks, None, assignment, minter)
}

/// Mint a fresh `b` id for every block (the re-mint path).
pub fn assign_fresh_ids(blocks: &[Block], minter: &mut Mint<'_>) -> Result<Vec<TreeInputBlock>> {
    assign_from_map(blocks, &BTreeMap::new(), minter)
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
