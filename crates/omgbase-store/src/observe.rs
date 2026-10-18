//! Observation (`spec/store/README.md` §5): bytes at a path become a commit.
//! Two passes — echo gate + reconcile without writes, the cross-document
//! phase of `spec/reconcile` §7, then one transaction per member — plus the
//! observed-deletion tombstone (§5.6). The body of a member's commit,
//! [`ingest_in`], runs §5.4 steps 1–4 and 6–13 against a transaction and a
//! commit id it is handed, so the `api` path ([`crate::effects`], store 13.7)
//! can run N of them under one commit row.
//!
//! **The gate rule** (store 14.0, §5.7). A path with a `pending_materializations`
//! row — an `api` commit whose file has not landed yet — is observed against
//! that intent before the echo gate: bytes hashing to the row's
//! `rendered_hash` are the materialized file (echo; the row goes); a member
//! gone under a `write`/`rename` row is **not** a deletion (the materializer
//! still owes the file; the row stays); foreign bytes win (ADR-004) — the
//! normal reconciling ingest, the row deleted in that member's transaction.

use std::collections::{BTreeMap, HashSet};

use omgbase_format::hash::{hex, sha256};
use omgbase_format::{Block, BlockKind, BlockTree, parse_markdown, render};
use omgbase_graph::{extract_doc_edges, project_nodes};
use omgbase_properties::{doc_properties, frontmatter_yaml, parse_frontmatter};
use omgbase_reconcile::json::detail_to_json;
use omgbase_reconcile::{
    Config, DispositionKind, FlatSource, Inserted, MatchBlock, Options, PerDocUnmatched, PoolEntry,
    ReconcileResult, apply_cross_doc_matches, cross_doc_match, flatten, reconcile_document,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::delta::TreeResolver;
use crate::derived::{
    EvictRow, fts_before_evict_rows, fts_delete_doc, fts_index_doc, rebuild_sections, sweep_pool,
};
use crate::effects::{CommitHead, Effect, Guard, Outcome};
use crate::error::{Error, Result};
use crate::graph::{
    adopt_phantoms, maintain_edges, project_section_nodes, resolve_edges, write_doc_nodes,
};
use crate::materialize::{PendingKind, delete_pending, pending_at};
use crate::mint::Mint;
use crate::order_key::key_between;
use crate::properties::{doc_blocks, write_doc_properties};
use crate::read::{load_old_match_blocks, load_pool, reconstruct};
use crate::time::pool_expiry;
use crate::tree::canonical_attrs;
use crate::writers::{
    NewCommit, NewRevision, Origin, TreeInputBlock, TreeWriteContext, assign_fresh_ids,
    assign_from_map, is_checkpoint_revision, new_commit, previous_revision, write_block_tree_in,
    write_frontmatter_blob, write_revision,
};
use crate::{FORMAT_MARKDOWN, Store};

/// One member of a batch: the bytes now at `path`, or `None` when the path
/// is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchItem {
    pub path: String,
    pub source: Option<String>,
}

impl BatchItem {
    /// The bytes at `path` are now `source`.
    #[must_use]
    pub fn observed(path: &str, source: &str) -> Self {
        Self {
            path: path.to_owned(),
            source: Some(source.to_owned()),
        }
    }

    /// `path` is gone.
    #[must_use]
    pub fn gone(path: &str) -> Self {
        Self {
            path: path.to_owned(),
            source: None,
        }
    }
}

/// The outcome of observing bytes at a path (§5.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObserveOutcome {
    pub path: String,
    pub doc_id: String,
    /// `None` on an echo.
    pub rev: Option<String>,
    /// `None` on an echo.
    pub commit_id: Option<String>,
    /// §5.4 step 13; `true` on an echo.
    pub converged: bool,
    /// The bytes already matched the stored revision: no commit.
    pub echo: bool,
    /// The bytes carry git conflict markers.
    pub conflicted: bool,
    /// Disposition kind → count over this commit (empty on an echo).
    pub dispositions: BTreeMap<String, u64>,
    /// The prior `file_hash` (hex), or `None` when the doc was new or gone.
    pub old_hash_hex: Option<String>,
    /// `sha256(source)` (hex).
    pub new_hash_hex: String,
}

/// The outcome of observing that a path is gone (§5.6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeleteOutcome {
    pub path: String,
    /// The tombstoned doc, or `None` when nothing was live (a no-op).
    pub doc_id: Option<String>,
    pub old_hash_hex: Option<String>,
}

impl DeleteOutcome {
    /// Whether a live doc was tombstoned.
    #[must_use]
    pub fn deleted(&self) -> bool {
        self.doc_id.is_some()
    }
}

/// The outcome of one batch member.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BatchOutcome {
    Observed(ObserveOutcome),
    Deleted(DeleteOutcome),
}

impl BatchOutcome {
    #[must_use]
    pub fn path(&self) -> &str {
        match self {
            BatchOutcome::Observed(o) => &o.path,
            BatchOutcome::Deleted(d) => &d.path,
        }
    }

    #[must_use]
    pub fn as_observed(&self) -> Option<&ObserveOutcome> {
        match self {
            BatchOutcome::Observed(o) => Some(o),
            BatchOutcome::Deleted(_) => None,
        }
    }

    #[must_use]
    pub fn as_deleted(&self) -> Option<&DeleteOutcome> {
        match self {
            BatchOutcome::Deleted(d) => Some(d),
            BatchOutcome::Observed(_) => None,
        }
    }
}

/// §5.4 step 14: a line starting with `<<<<<<<` **and** a line starting with
/// `>>>>>>>` (the reference's `/^<{7}/m && /^>{7}/m`; JavaScript's `^` in
/// multiline mode matches after `\n`, `\r`, U+2028 and U+2029).
#[must_use]
pub fn has_conflict_markers(source: &str) -> bool {
    let starts = |marker: &str| {
        source
            .split(['\n', '\r', '\u{2028}', '\u{2029}'])
            .any(|line| line.starts_with(marker))
    };
    starts("<<<<<<<") && starts(">>>>>>>")
}

/// A member parsed and reconciled but not committed (pass 1) — what an
/// [`Effect::IngestReconciled`](crate::effects::Effect) carries into the
/// transaction.
pub(crate) struct Prepared {
    pub(crate) path: String,
    pub(crate) source: String,
    /// The doc row at `path`, live or tombstoned, or `None` when the path is new.
    doc_id: Option<String>,
    tree: BlockTree,
    old_blocks: Vec<MatchBlock>,
    new_blocks: Vec<MatchBlock>,
    result: ReconcileResult,
    /// Ids carried in by the cross-document phase.
    cross_doc_ids: Vec<String>,
}

impl Prepared {
    /// §5.4 step 3 for this member — assign the matcher's ids onto the body
    /// (nothing mints: every key is assigned) — and the [`IngestPlan`] that
    /// commits it with the given provenance.
    pub(crate) fn plan<'a>(
        &'a self,
        minter: &mut Mint<'_>,
        origin: Origin,
        actor: Option<&'a str>,
        reason: Option<&'a str>,
        conflicted: Option<bool>,
    ) -> Result<IngestPlan<'a>> {
        let (_, rest) = split_frontmatter(&self.tree);
        let assigned = assign_from_map(rest, &self.result.assignment, minter)?;
        Ok(IngestPlan {
            path: &self.path,
            source: &self.source,
            tree: &self.tree,
            assigned,
            dispositions: disposition_rows(&self.result),
            deleted: self.result.deleted.clone(),
            consumed_pool: self.result.consumed_pool.clone(),
            cross_doc_ids: self.cross_doc_ids.clone(),
            origin,
            actor,
            reason,
            conflicted,
        })
    }
}

enum Pending {
    Echo(ObserveOutcome),
    Gone {
        path: String,
        doc_id: Option<String>,
        old_hash_hex: Option<String>,
        old_blocks: Vec<MatchBlock>,
    },
    Ingest {
        prepared: Box<Prepared>,
        old_hash_hex: Option<String>,
        new_hash_hex: String,
        /// The path had a pending row the file now supersedes: delete it in
        /// the member's transaction (§5.7).
        clear_pending: bool,
    },
}

/// The frontmatter block (when the first block is one) and the body.
fn split_frontmatter(tree: &BlockTree) -> (Option<&Block>, &[Block]) {
    match tree.children.first() {
        Some(b) if b.kind == BlockKind::Frontmatter => (Some(b), &tree.children[1..]),
        _ => (None, &tree.children[..]),
    }
}

/// §5.1 step 4: parse, load the old tree (regardless of tombstone), offer the
/// pool minus `consumed` when a doc row exists, reconcile, mint `b` ids.
#[allow(clippy::too_many_arguments)]
fn prepare_reconcile(
    conn: &Connection,
    minter: &mut Mint<'_>,
    repo_id: &str,
    path: &str,
    source: &str,
    config: &Config,
    pool: &[PoolEntry],
    consumed: &mut HashSet<String>,
) -> Result<Prepared> {
    let doc_id: Option<String> = conn
        .query_row(
            "SELECT doc_id FROM docs WHERE repo_id = ?1 AND path = ?2",
            params![repo_id, path],
            |r| r.get(0),
        )
        .optional()?;
    let tree = parse_markdown(source);
    let old_blocks = match &doc_id {
        Some(id) => load_old_match_blocks(conn, id)?,
        None => Vec::new(),
    };
    let new_blocks = flatten(&FlatSource::from_tree(&tree, None));
    let offered: Vec<PoolEntry> = if doc_id.is_some() {
        pool.iter()
            .filter(|c| !consumed.contains(&c.id))
            .cloned()
            .collect()
    } else {
        Vec::new()
    };
    let mut mint = minter.deferred("b");
    let result = reconcile_document(
        &old_blocks,
        &new_blocks,
        Options {
            config,
            pool: &offered,
            minter: &mut mint,
        },
    );
    mint.finish()?;
    consumed.extend(result.consumed_pool.iter().cloned());
    Ok(Prepared {
        path: path.to_owned(),
        source: source.to_owned(),
        doc_id,
        tree,
        old_blocks,
        new_blocks,
        result,
        cross_doc_ids: Vec::new(),
    })
}

/// §5.3: pool the leftovers, match across documents, apply.
fn cross_doc_phase(pending: &mut [Pending], config: &Config) {
    let mut docs: Vec<PerDocUnmatched> = Vec::new();
    let mut results: BTreeMap<String, ReconcileResult> = BTreeMap::new();
    let mut key_of: Vec<Option<String>> = vec![None; pending.len()];
    for (i, p) in pending.iter_mut().enumerate() {
        match p {
            Pending::Echo(_) | Pending::Gone { doc_id: None, .. } => {}
            Pending::Gone {
                doc_id: Some(doc_id),
                old_blocks,
                ..
            } => {
                docs.push(PerDocUnmatched {
                    doc_id: doc_id.clone(),
                    deleted: old_blocks.clone(),
                    inserted: Vec::new(),
                });
                results.insert(
                    doc_id.clone(),
                    ReconcileResult {
                        deleted: old_blocks.iter().filter_map(|b| b.id.clone()).collect(),
                        ..ReconcileResult::default()
                    },
                );
            }
            Pending::Ingest { prepared, .. } => {
                let key = prepared
                    .doc_id
                    .clone()
                    .unwrap_or_else(|| format!("new:{}", prepared.path));
                let key_of_id: BTreeMap<&str, &str> = prepared
                    .result
                    .assignment
                    .iter()
                    .map(|(k, id)| (id.as_str(), k.as_str()))
                    .collect();
                let deleted = prepared
                    .result
                    .deleted
                    .iter()
                    .filter_map(|id| {
                        prepared
                            .old_blocks
                            .iter()
                            .find(|b| b.id.as_deref() == Some(id))
                    })
                    .cloned()
                    .collect();
                let inserted = prepared
                    .result
                    .dispositions
                    .iter()
                    .filter(|d| d.kind == DispositionKind::Inserted)
                    .filter_map(|d| {
                        let k = key_of_id.get(d.block_id.as_str())?;
                        let block = prepared.new_blocks.iter().find(|b| &b.key == k)?;
                        Some(Inserted {
                            block: block.clone(),
                            minted_id: d.block_id.clone(),
                        })
                    })
                    .collect();
                docs.push(PerDocUnmatched {
                    doc_id: key.clone(),
                    deleted,
                    inserted,
                });
                results.insert(key.clone(), std::mem::take(&mut prepared.result));
                key_of[i] = Some(key);
            }
        }
    }
    let matches = if docs.len() < 2 {
        Vec::new()
    } else {
        cross_doc_match(&docs, config)
    };
    if !matches.is_empty() {
        apply_cross_doc_matches(&mut results, &matches, &config.matcher_v);
    }
    for (i, p) in pending.iter_mut().enumerate() {
        if let (Pending::Ingest { prepared, .. }, Some(key)) = (p, &key_of[i]) {
            prepared.result = results
                .remove(key)
                .expect("every prepared member was keyed");
            for m in &matches {
                if &m.to_doc == key {
                    prepared.cross_doc_ids.push(m.carried_id.clone());
                }
            }
        }
    }
}

struct BlockRow {
    block_id: String,
    parent_block: Option<String>,
    order_key: String,
    ordinal: i64,
    depth: i64,
    ancestor_path: String,
    kind: String,
    attrs: String,
    text: String,
    raw_hash: [u8; 32],
    norm_hash: [u8; 32],
    trivia_hash: Option<[u8; 32]>,
}

/// The `blocks` rows of a body tree in pre-order (§4.3, §5.4 step 9).
fn flatten_rows(
    blocks: &[TreeInputBlock],
    parent: Option<&str>,
    depth: i64,
    ancestor_path: &str,
    out: &mut Vec<BlockRow>,
) {
    let mut prev_key: Option<String> = None;
    for (ordinal, b) in blocks.iter().enumerate() {
        let order_key = key_between(prev_key.as_deref(), None);
        prev_key = Some(order_key.clone());
        out.push(BlockRow {
            block_id: b.block_id.clone(),
            parent_block: parent.map(str::to_owned),
            order_key,
            ordinal: ordinal as i64,
            depth,
            ancestor_path: ancestor_path.to_owned(),
            kind: b.kind.clone(),
            attrs: canonical_attrs(&b.attrs),
            text: b.text.clone(),
            raw_hash: sha256(b.raw.as_bytes()),
            norm_hash: sha256(b.text.as_bytes()),
            trivia_hash: (!b.trivia.is_empty()).then(|| sha256(b.trivia.as_bytes())),
        });
        if !b.children.is_empty() {
            flatten_rows(
                &b.children,
                Some(&b.block_id),
                depth + 1,
                &format!("{ancestor_path}{}/", b.block_id),
                out,
            );
        }
    }
}

/// §5.4 step 8: delete another document's `blocks` row for each id (its FTS
/// entry first when it is a live leaf, `spec/search` §1.1 — leaf-ness decided
/// over the table before any row goes, a parent left childless re-indexed)
/// and the id's pool row.
fn evict_foreign_block_rows(conn: &Connection, doc_id: &str, ids: &[String]) -> Result<()> {
    let mut rows = Vec::new();
    for id in ids {
        let row: Option<EvictRow> = conn
            .query_row(
                "SELECT rowid, block_id, doc_id, parent_block, text, deleted_commit IS NULL
                 FROM blocks WHERE block_id = ?1 AND doc_id != ?2",
                params![id, doc_id],
                |r| {
                    Ok(EvictRow {
                        rowid: r.get(0)?,
                        block_id: r.get(1)?,
                        doc_id: r.get(2)?,
                        parent_block: r.get(3)?,
                        text: r.get(4)?,
                        live: r.get(5)?,
                    })
                },
            )
            .optional()?;
        if let Some(row) = row {
            rows.push(row);
        }
    }
    fts_before_evict_rows(conn, &rows)?;
    for r in &rows {
        conn.execute(
            "DELETE FROM blocks WHERE block_id = ?1 AND doc_id != ?2",
            params![r.block_id, doc_id],
        )?;
    }
    for id in ids {
        conn.execute(
            "DELETE FROM resurrection_pool WHERE block_id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

/// What §5.4 steps 1–13 produce: the committed document, commit and
/// revision, and whether the bytes converged (step 13).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Committed {
    pub doc_id: String,
    pub commit_id: String,
    pub rev_id: String,
    pub converged: bool,
}

/// A disposition to persist (§5.4 step 10): the matcher's, or the `api`
/// intent rows of `spec/mutate` §4 (`matcher_v` null, `detail` `{}`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DispositionRow {
    pub block_id: String,
    pub kind: String,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    pub matcher_v: Option<String>,
    /// JSON text.
    pub detail: String,
}

/// Everything §5.4 needs to commit one document: the parsed tree and the
/// id-assigned body, the identity decisions, and the commit row's provenance.
pub(crate) struct IngestPlan<'a> {
    pub path: &'a str,
    pub source: &'a str,
    pub tree: &'a BlockTree,
    pub assigned: Vec<TreeInputBlock>,
    pub dispositions: Vec<DispositionRow>,
    /// Pooled (step 7).
    pub deleted: Vec<String>,
    pub consumed_pool: Vec<String>,
    pub cross_doc_ids: Vec<String>,
    pub origin: Origin,
    pub actor: Option<&'a str>,
    pub reason: Option<&'a str>,
    /// `docs.conflicted` for this commit: `Some` on the observed path (§5.4
    /// step 12 writes it with the pointers, in the same transaction — the
    /// reference's `observeFile` sets it from the conflict-marker scan),
    /// `None` leaves the column as it is (`api` ingests, the reconciling and
    /// fresh ingests of the sync layer).
    pub conflicted: Option<bool>,
}

/// §5.4 step 10 (14.2): which verdicts the store persists — every kind but
/// `same`.
#[must_use]
pub fn persists_disposition(kind: &str) -> bool {
    kind != "same"
}

/// §5.4 (14.2): kind → count over every verdict of a reconcile result, `same`
/// included — what the observe outcome reports. A `BTreeMap` orders the kinds
/// bytewise, as `ORDER BY kind` did through 14.1.
fn count_kinds(result: &ReconcileResult) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for d in &result.dispositions {
        *counts.entry(d.kind.as_str().to_owned()).or_insert(0) += 1;
    }
    counts
}

fn disposition_rows(result: &ReconcileResult) -> Vec<DispositionRow> {
    result
        .dispositions
        .iter()
        .map(|d| DispositionRow {
            block_id: d.block_id.clone(),
            kind: d.kind.as_str().to_owned(),
            confidence: d.confidence,
            reason: d.reason.map(|r| r.as_str().to_owned()),
            matcher_v: Some(d.matcher_v.clone()),
            detail: detail_to_json(&d.detail).to_string(),
        })
        .collect()
}

/// §5.4 steps 0–4 and 6–13 for one document against an open transaction
/// `tx` and the commit row `commit_id` already written in it (step 5 is the
/// caller's: [`Store::commit_ingest`] writes one row per document, the `api`
/// path of [`crate::effects`] one row per request — store 13.7). Mints `d`
/// for a new path, `r`, then `x`/`e` through `mint`, which must be the
/// store's minter over `tx`. Nothing here opens a transaction of its own.
pub(crate) fn ingest_in(
    tx: &Connection,
    mint: &mut Mint<'_>,
    repo_id: &str,
    plan: &IngestPlan<'_>,
    expires: &str,
    commit_id: &str,
) -> Result<Committed> {
    let minter = mint;
    let tree = plan.tree;
    let source = plan.source;
    let (fm_block, _) = split_frontmatter(tree);

    let fm_trivia = fm_block.map(|b| b.trivia.as_str());

    // 2. Doc row (the path's row regardless of tombstone; a re-created
    //    path is revived — §5.6 "Re-creation"). Steps 0 and 1 follow: they
    //    need the doc id to find the previous revision.
    let existing: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT doc_id, deleted_commit FROM docs WHERE repo_id = ?1 AND path = ?2",
            params![repo_id, plan.path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let doc_id = match existing {
        Some((id, deleted_commit)) => {
            tx.execute(
                "UPDATE docs SET format = ?1, leading_trivia = ?2, frontmatter_trivia = ?3, deleted_commit = NULL WHERE doc_id = ?4",
                params![FORMAT_MARKDOWN, tree.leading_trivia, fm_trivia, id],
            )?;
            // spec/graph §3.5: a revived row becomes live again, so the
            // phantom edges that accrued at its path while it was
            // tombstoned re-point to it.
            if deleted_commit.is_some() {
                adopt_phantoms(tx, plan.path, &id)?;
            }
            id
        }
        None => {
            let id = minter.mint("d")?;
            tx.execute(
                "INSERT INTO docs (doc_id, repo_id, path, format, leading_trivia, frontmatter_trivia) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, repo_id, plan.path, FORMAT_MARKDOWN, tree.leading_trivia, fm_trivia],
            )?;
            // spec/graph §3.5: a new row at this path adopts the open
            // phantom edges that pointed at it (the reference runs this
            // right after the INSERT; nothing is minted).
            adopt_phantoms(tx, plan.path, &id)?;
            id
        }
    };

    // 0. The revision's place (§4.4, 16.0): its seq decides whether it is a
    //    checkpoint; a non-checkpoint revision writes its tree and frontmatter
    //    as deltas against the previous revision's RESOLVED tree and raw where
    //    that is smaller. The previous revision is the document's greatest seq
    //    — on every path the current revision, never archived (retention rule
    //    1) — but the rule is stated for the general case: no live predecessor
    //    ⇒ a checkpoint.
    let previous = previous_revision(tx, &doc_id)?;
    let seq = previous.as_ref().map_or(1, |p| p.seq + 1);
    let checkpoint = is_checkpoint_revision(seq, previous.as_ref());
    let mut resolver = TreeResolver::new(tx);
    let base = match &previous {
        Some(p) if !checkpoint => match &p.root_tree {
            Some(root) => Some(resolver.tree(&doc_id, p.seq, &hex(root))?),
            None => None,
        },
        _ => None,
    };
    let tree_ctx = TreeWriteContext { base, checkpoint };

    // 1. Frontmatter blob: the raw at a checkpoint, else the smaller of a line
    //    delta over the previous revision's frontmatter and the raw (§5.4 step 1).
    let fm_blob_hex = match fm_block {
        Some(b) => {
            let base_raw = match &previous {
                Some(p) if !checkpoint => match &p.frontmatter_blob {
                    Some(fm) => Some(resolver.frontmatter(&doc_id, p.seq, &hex(fm))?),
                    None => None,
                },
                _ => None,
            };
            Some(write_frontmatter_blob(
                tx,
                &b.raw,
                base_raw.as_deref(),
                checkpoint,
            )?)
        }
        None => None,
    };

    // 4. Write the tree.
    let assigned = &plan.assigned;
    let root_tree_hex = write_block_tree_in(tx, assigned, &tree_ctx)?;

    // 6. The revision row (the commit row, step 5, is the caller's).
    let rendered_hash = sha256(source.as_bytes());
    let (rev_id, _) = write_revision(
        tx,
        minter,
        &NewRevision {
            doc_id: &doc_id,
            root_tree_hex: &root_tree_hex,
            frontmatter_blob_hex: fm_blob_hex.as_deref(),
            rendered_hash,
            path: plan.path,
            commit_id,
            seq: Some(seq),
        },
    )?;

    // 7. Pool the deleted.
    {
        let mut pool = tx.prepare(
            "INSERT OR REPLACE INTO resurrection_pool (block_id, repo_id, doc_id, raw_hash, norm_hash, type, deleted_commit, expires_ts)
             SELECT block_id, repo_id, doc_id, raw_hash, norm_hash, type, ?1, ?2 FROM blocks WHERE block_id = ?3 AND doc_id = ?4",
        )?;
        for id in &plan.deleted {
            pool.execute(params![commit_id, expires, id, doc_id])?;
        }
    }

    // 8. Evict foreign rows.
    let incoming: Vec<String> = plan
        .cross_doc_ids
        .iter()
        .chain(plan.consumed_pool.iter())
        .cloned()
        .collect();
    if !incoming.is_empty() {
        evict_foreign_block_rows(tx, &doc_id, &incoming)?;
    }

    // 9. Refresh the blocks, sections and FTS.
    fts_delete_doc(tx, &doc_id)?;
    tx.execute("DELETE FROM blocks WHERE doc_id = ?1", params![doc_id])?;
    let mut rows = Vec::new();
    flatten_rows(assigned, None, 0, "/", &mut rows);
    {
        let mut insert = tx.prepare(
            "INSERT INTO blocks
               (block_id, repo_id, doc_id, parent_block, order_key, ordinal, depth,
                ancestor_path, type, attrs, text, raw_hash, norm_hash, trivia_hash, created_commit)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )?;
        for r in &rows {
            insert.execute(params![
                r.block_id,
                repo_id,
                doc_id,
                r.parent_block,
                r.order_key,
                r.ordinal,
                r.depth,
                r.ancestor_path,
                r.kind,
                r.attrs,
                r.text,
                &r.raw_hash[..],
                &r.norm_hash[..],
                r.trivia_hash.as_ref().map(|h| &h[..]),
                commit_id,
            ])?;
        }
    }
    fts_index_doc(tx, &doc_id)?;
    rebuild_sections(tx, &doc_id)?;

    // 9a. Nodes (spec/graph §2): the adapter's projections over the
    //     assigned body, then the `md:section` nodes from the sections just
    //     rebuilt; deleted (FTS first) and reinserted.
    let body = doc_blocks(assigned);
    let mut nodes = project_nodes(&body);
    nodes.extend(project_section_nodes(tx, &doc_id)?);
    write_doc_nodes(tx, repo_id, &doc_id, &nodes)?;

    // 9b. Properties (spec/properties §6): the document's rows from the
    //     frontmatter block and the assigned body, deleted then written.
    let property_rows = doc_properties(&doc_id, fm_block, &body);
    write_doc_properties(tx, repo_id, &doc_id, commit_id, &property_rows)?;

    // 9c. Edges (spec/graph §3): descriptors from the blocks in pre-order
    //     then the frontmatter mapping (the same parse the properties step
    //     uses; none when it fails), resolved in order (**mints `x`** per
    //     new external URI), then the intervals (**mints `e`** per new
    //     edge) and the rollup.
    let mapping = fm_block.and_then(|b| parse_frontmatter(frontmatter_yaml(&b.raw)));
    let descriptors = extract_doc_edges(&body, mapping.as_ref());
    let resolved = resolve_edges(tx, minter, repo_id, &doc_id, plan.path, &descriptors)?;
    maintain_edges(tx, minter, repo_id, &doc_id, commit_id, &resolved)?;

    // 10. Dispositions and block_changes — every verdict but `same` (14.2).
    //     The matcher (and the known-id resolver) still produce one per
    //     untouched block, and the outcome counts them, but the two tables
    //     record what CHANGED: a block's rows are its own history, so
    //     `MAX(commits.ts)` over its `block_changes` and `blocks_history`
    //     are the block's changes, not its siblings'. Every other kind — the
    //     first revision's `inserted` rows the mint oracle (§2.1) depends on
    //     included — is written as before.
    {
        let mut ins = tx.prepare(
            "INSERT OR IGNORE INTO dispositions (commit_id, block_id, kind, confidence, reason, matcher_v, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        let mut bc = tx.prepare(
            "INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind) VALUES (?1, ?2, ?3)",
        )?;
        for d in plan
            .dispositions
            .iter()
            .filter(|d| persists_disposition(&d.kind))
        {
            ins.execute(params![
                commit_id,
                d.block_id,
                d.kind,
                d.confidence,
                d.reason,
                d.matcher_v,
                d.detail,
            ])?;
            bc.execute(params![d.block_id, commit_id, d.kind])?;
        }
    }

    // 11. Consume the pool.
    for id in &plan.consumed_pool {
        tx.execute(
            "DELETE FROM resurrection_pool WHERE block_id = ?1",
            params![id],
        )?;
    }

    // 12. Pointers — and, on the observed path, the conflict flag, so
    //     the row the commit leaves behind is consistent as a whole (an
    //     `api` plan leaves `conflicted` as it is).
    match plan.conflicted {
        Some(conflicted) => tx.execute(
            "UPDATE docs SET current_rev = ?1, file_hash = ?2, conflicted = ?3 WHERE doc_id = ?4",
            params![rev_id, &rendered_hash[..], i64::from(conflicted), doc_id],
        )?,
        None => tx.execute(
            "UPDATE docs SET current_rev = ?1, file_hash = ?2 WHERE doc_id = ?3",
            params![rev_id, &rendered_hash[..], doc_id],
        )?,
    };

    // 13. Converged: file_hash == rendered_hash (trivially), render(tree) ==
    //     source, reconstruct(doc) == source.
    let converged = render(tree) == source && reconstruct(tx, &doc_id)?.as_deref() == Some(source);

    Ok(Committed {
        doc_id,
        commit_id: commit_id.to_owned(),
        rev_id,
        converged,
    })
}

/// §5.6's tombstone against an open transaction and its commit row: with
/// `expires`, every live block is pooled first (the observed deletion);
/// without, nothing is (`docs_delete`, `spec/mutate` §6). Then the FTS rows
/// go, the live blocks and the doc row take `deleted_commit`.
pub(crate) fn tombstone_in(
    tx: &Connection,
    doc_id: &str,
    commit_id: &str,
    expires: Option<&str>,
) -> Result<()> {
    if let Some(expires) = expires {
        tx.execute(
            "INSERT OR REPLACE INTO resurrection_pool (block_id, repo_id, doc_id, raw_hash, norm_hash, type, deleted_commit, expires_ts)
             SELECT block_id, repo_id, doc_id, raw_hash, norm_hash, type, ?1, ?2
               FROM blocks WHERE doc_id = ?3 AND deleted_commit IS NULL",
            params![commit_id, expires, doc_id],
        )?;
    }
    fts_delete_doc(tx, doc_id)?;
    tx.execute(
        "UPDATE blocks SET deleted_commit = ?1 WHERE doc_id = ?2 AND deleted_commit IS NULL",
        params![commit_id, doc_id],
    )?;
    tx.execute(
        "UPDATE docs SET deleted_commit = ?1 WHERE doc_id = ?2",
        params![commit_id, doc_id],
    )?;
    Ok(())
}

impl Store {
    /// §5: observe a batch of members at `ts` (RFC 3339 UTC, §2.4) with the
    /// `spec/reconcile` thresholds in `config`. Does **not** sweep the pool
    /// (§5.5: the caller does, once per batch).
    pub fn observe_batch(
        &mut self,
        repo_id: &str,
        items: &[BatchItem],
        ts: &str,
        config: &Config,
    ) -> Result<Vec<BatchOutcome>> {
        let expires = pool_expiry(ts)?;

        // ---- pass 1: echo gate + reconcile, no writes ------------------------------
        let pool = load_pool(&self.conn, repo_id, ts)?;
        let mut consumed: HashSet<String> = HashSet::new();
        let mut pending: Vec<Pending> = Vec::with_capacity(items.len());
        for it in items {
            let existing: Option<(String, Option<Vec<u8>>)> = self
                .conn
                .query_row(
                    "SELECT doc_id, file_hash FROM docs WHERE repo_id = ?1 AND path = ?2 AND deleted_commit IS NULL",
                    params![repo_id, it.path],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let old_hash_hex = existing.as_ref().and_then(|(_, h)| h.as_deref()).map(hex);
            // §5.7: the intent an `api` commit still owes this path, if any.
            let intent = pending_at(&self.conn, repo_id, &it.path)?;
            let Some(source) = &it.source else {
                match &intent {
                    // The file the materializer owes is not here yet: not a
                    // deletion; the row stays for it.
                    Some(row) if row.kind != PendingKind::Remove => {
                        pending.push(Pending::Gone {
                            path: it.path.clone(),
                            doc_id: None,
                            old_hash_hex: None,
                            old_blocks: Vec::new(),
                        });
                        continue;
                    }
                    // A `remove` whose file is gone: fulfilled.
                    Some(_) => delete_pending(&self.conn, repo_id, &it.path)?,
                    None => {}
                }
                let (doc_id, old_blocks) = match &existing {
                    Some((id, _)) => (Some(id.clone()), load_old_match_blocks(&self.conn, id)?),
                    None => (None, Vec::new()),
                };
                pending.push(Pending::Gone {
                    path: it.path.clone(),
                    doc_id,
                    old_hash_hex,
                    old_blocks,
                });
                continue;
            };
            let hash = sha256(source.as_bytes());
            let new_hash_hex = hex(&hash);
            let echo = |doc_id: &str| {
                Pending::Echo(ObserveOutcome {
                    path: it.path.clone(),
                    doc_id: doc_id.to_owned(),
                    rev: None,
                    commit_id: None,
                    converged: true,
                    echo: true,
                    conflicted: false,
                    dispositions: BTreeMap::new(),
                    old_hash_hex: old_hash_hex.clone(),
                    new_hash_hex: new_hash_hex.clone(),
                })
            };
            if let Some(row) = &intent {
                if row.rendered_hash[..] == hash[..] {
                    // The bytes the commit meant: the observation confirms
                    // the write (the row goes) — or, for a `remove`, finds
                    // the very file the materializer will unlink (the row
                    // stays; nothing to ingest).
                    if row.kind != PendingKind::Remove {
                        delete_pending(&self.conn, repo_id, &it.path)?;
                    }
                    let doc_id = existing
                        .as_ref()
                        .map_or(row.doc_id.as_str(), |(id, _)| id.as_str());
                    pending.push(echo(doc_id));
                    continue;
                }
                // Foreign bytes: the file wins; the normal ingest below
                // clears the row in its transaction — unless the database
                // already agrees with the file (a row naming other bytes is
                // stale either way; the observation settles it).
                if let Some((doc_id, Some(stored))) = &existing {
                    if stored[..] == hash[..] {
                        delete_pending(&self.conn, repo_id, &it.path)?;
                        pending.push(echo(doc_id));
                        continue;
                    }
                }
            } else if let Some((doc_id, Some(stored))) = &existing {
                if stored[..] == hash[..] {
                    pending.push(echo(doc_id));
                    continue;
                }
            }
            let clear_pending = intent.is_some();
            let prepared = prepare_reconcile(
                &self.conn,
                &mut self.ids.at(&self.conn),
                repo_id,
                &it.path,
                source,
                config,
                &pool,
                &mut consumed,
            )?;
            pending.push(Pending::Ingest {
                prepared: Box::new(prepared),
                old_hash_hex,
                new_hash_hex,
                clear_pending,
            });
        }

        // ---- cross-document phase (spec/reconcile §7) --------------------------------
        if pending.len() > 1 {
            cross_doc_phase(&mut pending, config);
        }

        // ---- pass 2: commit, in batch order -------------------------------------------
        let mut out = Vec::with_capacity(pending.len());
        for p in pending {
            match p {
                Pending::Echo(outcome) => out.push(BatchOutcome::Observed(outcome)),
                Pending::Gone {
                    path,
                    doc_id,
                    old_hash_hex,
                    ..
                } => {
                    if let Some(id) = &doc_id {
                        self.tombstone_observed_deletion(repo_id, id, ts, &expires)?;
                    }
                    out.push(BatchOutcome::Deleted(DeleteOutcome {
                        path,
                        doc_id,
                        old_hash_hex,
                    }));
                }
                Pending::Ingest {
                    prepared,
                    old_hash_hex,
                    new_hash_hex,
                    clear_pending,
                } => {
                    // The flag rides the commit's transaction (step 12), not
                    // an autocommit after it; so does the pending row's end.
                    let conflicted = has_conflict_markers(&prepared.source);
                    let c = self.commit_prepared(
                        repo_id,
                        &prepared,
                        ts,
                        &expires,
                        conflicted,
                        clear_pending,
                    )?;
                    // §5.4 (14.2): the outcome counts every verdict the
                    // matcher produced, `same` included — it describes what
                    // the matcher saw; the table describes what changed
                    // (step 10 drops `same`) — so the counts come from the
                    // in-memory result, never the rows. Kinds in bytewise
                    // order, as the table query listed them through 14.1.
                    let dispositions = count_kinds(&prepared.result);
                    out.push(BatchOutcome::Observed(ObserveOutcome {
                        path: prepared.path,
                        doc_id: c.doc_id,
                        rev: Some(c.rev_id),
                        commit_id: Some(c.commit_id),
                        converged: c.converged,
                        echo: false,
                        conflicted,
                        dispositions,
                        old_hash_hex,
                        new_hash_hex,
                    }));
                }
            }
        }
        Ok(out)
    }

    /// §5.4 steps 1–13 for a prepared (reconciled) member: an `observed`
    /// commit with the matcher's dispositions, `docs.conflicted` set to
    /// `conflicted` in the same transaction — and, with `clear_pending`,
    /// the path's pending row deleted in it too (§5.7: the file won).
    fn commit_prepared(
        &mut self,
        repo_id: &str,
        prepared: &Prepared,
        ts: &str,
        expires: &str,
        conflicted: bool,
        clear_pending: bool,
    ) -> Result<Committed> {
        let plan = prepared.plan(
            &mut self.ids.at(&self.conn),
            Origin::Observed,
            None,
            None,
            Some(conflicted),
        )?;
        self.commit_ingest(
            repo_id,
            &plan,
            ts,
            expires,
            clear_pending.then_some(prepared.path.as_str()),
        )
    }

    /// §5.1 step 4 for one path outside a batch: the repo's pool at `ts`
    /// offered, the member parsed and reconciled, `b` ids minted — nothing
    /// written. What [`Store::reconciling_ingest`] commits, and what a
    /// document operation hands to [`Store::commit_effects`].
    pub(crate) fn prepare_single(
        &mut self,
        repo_id: &str,
        path: &str,
        source: &str,
        ts: &str,
        config: &Config,
    ) -> Result<Prepared> {
        let pool = load_pool(&self.conn, repo_id, ts)?;
        let mut consumed = HashSet::new();
        prepare_reconcile(
            &self.conn,
            &mut self.ids.at(&self.conn),
            repo_id,
            path,
            source,
            config,
            &pool,
            &mut consumed,
        )
    }

    /// Parse and reconcile `source` at `path` against the stored tree (the
    /// pool offered when a doc row exists, §5.1 step 4) and commit it with
    /// the given provenance — the reference's `ingestFile` with
    /// `makeReconcilingResolver`: `docs_create`/`docs_set_meta` (`api`) and
    /// the file-CAS conflict ingest of `spec/mutate` §4 (`observed`). No echo
    /// gate, no `conflicted` update, no sweep. The sync layer's recovery and
    /// `attach_source` (`spec/sync` §4.3, §6) ingest through this too, with
    /// `Origin::Observed`.
    #[allow(clippy::too_many_arguments)]
    pub fn reconciling_ingest(
        &mut self,
        repo_id: &str,
        path: &str,
        source: &str,
        ts: &str,
        origin: Origin,
        actor: Option<&str>,
        reason: Option<&str>,
        config: &Config,
    ) -> Result<Committed> {
        let head = CommitHead {
            origin,
            actor,
            reason,
            clear_pending: false,
            ops: None,
        };
        self.reconciling_commit(repo_id, path, source, ts, &head, config, Guard::None)?
            .committed()?
            .pop()
            .ok_or_else(|| {
                Error::Other(format!("reconciling_ingest: nothing committed for {path}"))
            })
    }

    /// [`Store::reconciling_ingest`] with a precondition the transaction
    /// re-validates (`spec/mutate` §6, 2.2): `docs_create` guards "no live
    /// document at the path", `docs_set_meta` the document's triple and the
    /// bytes it patched. Returns the commit's [`Outcome`] — a disk conflict
    /// is the caller's to ingest as `observed`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn reconciling_commit(
        &mut self,
        repo_id: &str,
        path: &str,
        source: &str,
        ts: &str,
        head: &CommitHead<'_>,
        config: &Config,
        guard: Guard,
    ) -> Result<Outcome> {
        let prepared = self.prepare_single(repo_id, path, source, ts, config)?;
        self.commit_effects(
            repo_id,
            head,
            &[Effect::IngestReconciled {
                prepared: Box::new(prepared),
                guard,
            }],
            ts,
        )
    }

    /// Parse `source` at `path` and commit it with a **fresh `b` id for every
    /// block** — the reference's `ingestFile` without a resolver (no
    /// dispositions, nothing pooled): the re-mint path `spec/sync` §6 pins for
    /// a `borne` source's `attach_source` (§9). No echo gate, no sweep.
    pub fn fresh_ingest(
        &mut self,
        repo_id: &str,
        path: &str,
        source: &str,
        ts: &str,
        origin: Origin,
    ) -> Result<Committed> {
        let expires = pool_expiry(ts)?;
        let tree = parse_markdown(source);
        let (_, rest) = split_frontmatter(&tree);
        let assigned = assign_fresh_ids(rest, &mut self.ids.at(&self.conn))?;
        let plan = IngestPlan {
            path,
            source,
            tree: &tree,
            assigned,
            dispositions: Vec::new(),
            deleted: Vec::new(),
            consumed_pool: Vec::new(),
            cross_doc_ids: Vec::new(),
            origin,
            actor: None,
            reason: None,
            conflicted: None,
        };
        self.commit_ingest(repo_id, &plan, ts, &expires, None)
    }

    /// §5.4 steps 1–13 in one transaction of their own, under a commit row
    /// of their own (the reference's `ingestFile`): BEGIN, step 5, then
    /// [`ingest_in`], the pending row at `clear_pending_at` deleted (§5.7),
    /// COMMIT. The observed path and the fresh ingest commit through this;
    /// the `api` path runs N [`ingest_in`]s under one row via
    /// [`Store::commit_effects`](crate::effects).
    pub(crate) fn commit_ingest(
        &mut self,
        repo_id: &str,
        plan: &IngestPlan<'_>,
        ts: &str,
        expires: &str,
        clear_pending_at: Option<&str>,
    ) -> Result<Committed> {
        let tx = self.conn.unchecked_transaction()?;
        let committed = {
            let mut mint = self.ids.at(&tx);
            // 5. The commit row.
            let (commit_id, _) = new_commit(
                &tx,
                &mut mint,
                &NewCommit {
                    repo_id,
                    ts,
                    origin: plan.origin,
                    actor: plan.actor,
                    reason: plan.reason,
                    checkpoint_id: None,
                    ops: None,
                },
            )?;
            let committed = ingest_in(&tx, &mut mint, repo_id, plan, expires, &commit_id)?;
            if let Some(path) = clear_pending_at {
                delete_pending(&tx, repo_id, path)?;
            }
            committed
        };
        tx.commit()?;
        Ok(committed)
    }

    /// §5.6: tombstone a live doc whose path is gone, in one transaction of
    /// its own: an `observed deletion` commit (mints `c`), then
    /// [`tombstone_in`] with the pool. Returns the commit id.
    pub(crate) fn tombstone_observed_deletion(
        &mut self,
        repo_id: &str,
        doc_id: &str,
        ts: &str,
        expires: &str,
    ) -> Result<String> {
        let tx = self.conn.unchecked_transaction()?;
        let commit_id = {
            let mut mint = self.ids.at(&tx);
            let (commit_id, _) = new_commit(
                &tx,
                &mut mint,
                &NewCommit {
                    reason: Some("observed deletion"),
                    ..NewCommit::observed(repo_id, ts)
                },
            )?;
            tombstone_in(&tx, doc_id, &commit_id, Some(expires))?;
            commit_id
        };
        tx.commit()?;
        Ok(commit_id)
    }

    /// A batch of one (§5: "the same procedure without the middle"). Does not
    /// sweep the pool.
    pub fn observe_one(
        &mut self,
        repo_id: &str,
        path: &str,
        source: &str,
        ts: &str,
        config: &Config,
    ) -> Result<ObserveOutcome> {
        let mut out =
            self.observe_batch(repo_id, &[BatchItem::observed(path, source)], ts, config)?;
        match out.pop() {
            Some(BatchOutcome::Observed(o)) => Ok(o),
            _ => Err(Error::Other(format!(
                "observe_one: unexpected outcome for {path}"
            ))),
        }
    }

    /// Observe that `path` is gone (§5.6) and sweep the pool at `ts` (§5.5),
    /// as the reference's `observeDelete` does. A path with no live doc is a
    /// no-op (`doc_id: None`); so is a path whose file an `api` commit still
    /// owes (§5.7: a `write`/`rename` row — the materializer, not a
    /// tombstone, answers for it).
    pub fn observe_delete(&mut self, repo_id: &str, path: &str, ts: &str) -> Result<DeleteOutcome> {
        let expires = pool_expiry(ts)?;
        match pending_at(&self.conn, repo_id, path)? {
            Some(row) if row.kind != PendingKind::Remove => {
                return Ok(DeleteOutcome {
                    path: path.to_owned(),
                    doc_id: None,
                    old_hash_hex: None,
                });
            }
            Some(_) => delete_pending(&self.conn, repo_id, path)?,
            None => {}
        }
        let existing: Option<(String, Option<Vec<u8>>)> = self
            .conn
            .query_row(
                "SELECT doc_id, file_hash FROM docs WHERE repo_id = ?1 AND path = ?2 AND deleted_commit IS NULL",
                params![repo_id, path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((doc_id, file_hash)) = existing else {
            return Ok(DeleteOutcome {
                path: path.to_owned(),
                doc_id: None,
                old_hash_hex: None,
            });
        };
        self.tombstone_observed_deletion(repo_id, &doc_id, ts, &expires)?;
        sweep_pool(&self.conn, ts)?;
        Ok(DeleteOutcome {
            path: path.to_owned(),
            doc_id: Some(doc_id),
            old_hash_hex: file_hash.as_deref().map(hex),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_markers_need_both_sides_at_line_starts() {
        assert!(has_conflict_markers(
            "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n"
        ));
        assert!(!has_conflict_markers("<<<<<<< HEAD\na\n=======\nb\n"));
        assert!(!has_conflict_markers("a <<<<<<< b\n>>>>>>> c\n"));
        assert!(has_conflict_markers(">>>>>>> c\r<<<<<<< b"));
        assert!(has_conflict_markers("x\u{2028}<<<<<<< a\u{2029}>>>>>>> b"));
        assert!(!has_conflict_markers(""));
    }

    #[test]
    fn frontmatter_is_split_only_when_first() {
        let tree = parse_markdown("---\na: 1\n---\n\n# H\n");
        let (fm, rest) = split_frontmatter(&tree);
        assert_eq!(fm.map(|b| b.kind), Some(BlockKind::Frontmatter));
        assert_eq!(rest.len(), 1);
        let tree = parse_markdown("# H\n");
        let (fm, rest) = split_frontmatter(&tree);
        assert!(fm.is_none());
        assert_eq!(rest.len(), 1);
    }
}
