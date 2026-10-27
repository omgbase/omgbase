//! The identity record (`spec/store` §5.12 "The identity record", 17.6 — the
//! design's option 3, second half): beside the content branch — a plain notes
//! repository a customer can clone — the worker keeps a PARALLEL commit chain
//! on `refs/omgbase/ids` (`config.ids_ref`) whose tree holds one blob per
//! live document at `.omgbase/ids/<doc_id>`: canonical JSON `{ doc, head,
//! blocks: [{ id, parent, ordinal, hash }] }` — the document's id and head
//! token, its blocks in pre-order with their ids, parent ids (`null` at the
//! top level), sibling ordinals and `raw_hash` (hex). Each ids commit carries
//! the same `omgbase-seq` trailer as the checkpoint it belongs to and
//! `omgbase-content: <content commit sha>` naming the content tip at that
//! moment; its tree is the previous ids tree plus the touched documents'
//! blobs (a deleted document's blob removed). Push and fetch carry the ref,
//! so a clone of BOTH refs recovers content and identities; restoration from
//! it is 6c. The chain is written AFTER the content ref moved (its own CAS),
//! and catches up on resume: an ids tip whose `omgbase-seq` is behind the
//! content tip's re-stages every live document once. Port of
//! `packages/git-adapter/src/ids.ts`.

use std::collections::BTreeSet;

use omgbase_format::hash::hex;
use omgbase_store::{Result, canonical_json};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value as Json, json};

use crate::config::GitHistoryConfig;
use crate::cursor::GitCursor;
use crate::git::{GitIdentity, GitRepo};
use crate::trailers::{CommitTrailers, parse_message, render_message};

/// Where a document's id map lives in the ids tree.
pub const IDS_PREFIX: &str = ".omgbase/ids/";

/// One block of an id map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdsBlock {
    pub id: String,
    pub parent: Option<String>,
    pub ordinal: i64,
    /// `raw_hash` as hex.
    pub hash: String,
}

/// A live document's id map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdsRecord {
    pub doc: String,
    pub head: String,
    pub blocks: Vec<IdsBlock>,
}

impl IdsRecord {
    /// `{ doc, head, blocks: [{ id, parent, ordinal, hash }] }` (the
    /// canonical printer sorts the keys).
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "doc": self.doc,
            "head": self.head,
            "blocks": self.blocks.iter().map(|b| json!({
                "id": b.id,
                "parent": b.parent,
                "ordinal": b.ordinal,
                "hash": b.hash,
            })).collect::<Vec<_>>(),
        })
    }
}

/// The id map of a live document from the rows, or `None` for a
/// deleted/unknown one.
pub fn ids_record(conn: &Connection, doc_id: &str) -> Result<Option<IdsRecord>> {
    let doc: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT head, deleted_at FROM docs WHERE doc_id = ?1",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((Some(head), None)) = doc else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(
        "SELECT block_id, parent_block, ordinal, raw_hash FROM blocks WHERE doc_id = ?1 AND deleted_at IS NULL ORDER BY order_key",
    )?;
    let rows = stmt.query_map(params![doc_id], |r| {
        let hash: Vec<u8> = r.get(3)?;
        Ok(IdsBlock {
            id: r.get(0)?,
            parent: r.get(1)?,
            ordinal: r.get(2)?,
            hash: hex(&hash),
        })
    })?;
    Ok(Some(IdsRecord {
        doc: doc_id.to_owned(),
        head,
        blocks: rows.collect::<std::result::Result<_, _>>()?,
    }))
}

/// The blob's bytes: canonical JSON (keys sorted bytewise at every level, as
/// the manifest's `config`) and a final newline.
#[must_use]
pub fn ids_blob_text(record: &IdsRecord) -> String {
    format!("{}\n", canonical_json(&record.to_json()))
}

/// `.omgbase/ids/<doc_id>`.
#[must_use]
pub fn ids_path(doc_id: &str) -> String {
    format!("{IDS_PREFIX}{doc_id}")
}

/// The ids tip's `omgbase-seq` position, or `None` without a tip or with a
/// foreign one.
pub fn ids_position(git: &GitRepo, config: &GitHistoryConfig) -> Result<Option<GitCursor>> {
    let Some(tip) = git.ref_sha(&config.ids_ref)? else {
        return Ok(None);
    };
    let Some(t) = parse_message(&git.message(&tip)?) else {
        return Ok(None);
    };
    Ok(Some(GitCursor {
        tip,
        epoch: t.epoch,
        seq: t.to,
        pushed: None,
    }))
}

/// What one ids commit covers.
pub struct IdsSyncInput<'a> {
    pub conn: &'a Connection,
    pub repo_id: &'a str,
    pub git: &'a GitRepo,
    pub config: &'a GitHistoryConfig,
    pub identity: &'a GitIdentity,
    /// The documents a checkpoint touched (deleted ones included — their
    /// blob leaves the tree); `None` = every live document (a catch-up or a
    /// snapshot).
    pub docs: Option<&'a [String]>,
    pub epoch: &'a str,
    pub from: i64,
    pub to: i64,
    pub ts: &'a str,
    /// The content commit this ids commit belongs to.
    pub content: &'a str,
    pub actor: Option<&'a str>,
}

/// Write one ids commit for a checkpoint when the ids tree changed; returns
/// the ids tip (unchanged when nothing moved). Never fails the checkpoint
/// that called it beyond a git error: the content ref already moved.
pub fn sync_ids(input: &IdsSyncInput<'_>) -> Result<Option<String>> {
    let git = input.git;
    let parent = git.ref_sha(&input.config.ids_ref)?;
    let base_tree = match &parent {
        Some(p) => Some(git.tree_of(p)?),
        None => None,
    };
    let live: BTreeSet<String> = {
        let mut stmt = input.conn.prepare(
            "SELECT doc_id FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL AND head IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![input.repo_id], |r| r.get::<_, String>(0))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let existing = match &base_tree {
        Some(t) => git.tree_entries(t)?,
        None => Default::default(),
    };
    let docs: BTreeSet<String> = match input.docs {
        Some(d) => d.iter().cloned().collect(),
        None => live.clone(),
    };
    let mut adds: Vec<(String, String)> = Vec::new();
    let mut removes: Vec<String> = Vec::new();
    for doc_id in &docs {
        let path = ids_path(doc_id);
        let record = if live.contains(doc_id) {
            ids_record(input.conn, doc_id)?
        } else {
            None
        };
        let Some(record) = record else {
            if existing.contains_key(&path) {
                removes.push(path);
            }
            continue;
        };
        let blob = git.write_blob(ids_blob_text(&record).as_bytes())?;
        if existing.get(&path) != Some(&blob) {
            adds.push((path, blob));
        }
    }
    if input.docs.is_none() {
        for path in existing.keys() {
            if let Some(doc_id) = path.strip_prefix(IDS_PREFIX)
                && !live.contains(doc_id)
            {
                removes.push(path.clone());
            }
        }
    }
    if adds.is_empty() && removes.is_empty() {
        return Ok(parent);
    }
    let tree = git.build_tree(base_tree.as_deref(), &adds, &removes)?;
    if base_tree.as_deref() == Some(tree.as_str()) {
        return Ok(parent);
    }
    let trailers = CommitTrailers {
        epoch: input.epoch.to_owned(),
        from: input.from,
        to: input.to,
        ts: input.ts.to_owned(),
        commits: Vec::new(),
        origin: None,
        actor: input.actor.map(str::to_owned),
        plan: None,
        docs: Vec::new(),
        rescan: None,
        merge: None,
        content: Some(input.content.to_owned()),
    };
    let subject = format!("ids: {} document(s)", adds.len() + removes.len());
    let author = GitIdentity {
        name: input.actor.unwrap_or(&input.identity.name).to_owned(),
        email: input.identity.email.clone(),
    };
    let sha = git.commit_tree(
        &tree,
        parent.as_deref(),
        &render_message(&subject, &trailers),
        &author,
        input.identity,
        input.ts,
    )?;
    git.update_ref_raw(&input.config.ids_ref, &sha, parent.as_deref())?;
    Ok(Some(sha))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_blob_is_canonical_json_with_a_newline() {
        let r = IdsRecord {
            doc: "d_0".into(),
            head: "r_2".into(),
            blocks: vec![
                IdsBlock {
                    id: "b_0".into(),
                    parent: None,
                    ordinal: 0,
                    hash: "aa".into(),
                },
                IdsBlock {
                    id: "b_4".into(),
                    parent: Some("b_0".into()),
                    ordinal: 1,
                    hash: "bb".into(),
                },
            ],
        };
        assert_eq!(
            ids_blob_text(&r),
            "{\"blocks\":[{\"hash\":\"aa\",\"id\":\"b_0\",\"ordinal\":0,\"parent\":null},{\"hash\":\"bb\",\"id\":\"b_4\",\"ordinal\":1,\"parent\":\"b_0\"}],\"doc\":\"d_0\",\"head\":\"r_2\"}\n"
        );
        assert_eq!(ids_path("d_0"), ".omgbase/ids/d_0");
    }
}
