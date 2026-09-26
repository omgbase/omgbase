//! Observation (`spec/store/README.md` §5): bytes at a path become a commit.
//! Two passes — echo gate + reconcile without writes, the cross-document
//! phase of `spec/reconcile` §7, then one transaction per member — plus the
//! observed-deletion tombstone (§5.6).

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

use crate::derived::{fts_delete_doc, fts_index_doc, rebuild_sections, sweep_pool};
use crate::error::{Error, Result};
use crate::graph::{
    adopt_phantoms, maintain_edges, project_section_nodes, resolve_edges, write_doc_nodes,
};
use crate::ids::IdMinter;
use crate::order_key::key_between;
use crate::properties::{doc_blocks, write_doc_properties};
use crate::read::{load_old_match_blocks, load_pool, reconstruct};
use crate::time::pool_expiry;
use crate::tree::canonical_attrs;
use crate::writers::{
    NewCommit, NewRevision, Origin, TreeInputBlock, assign_from_map, new_commit, put_blob,
    write_block_tree, write_revision,
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

/// A member parsed and reconciled but not committed (pass 1).
struct Prepared {
    path: String,
    source: String,
    /// The doc row at `path`, live or tombstoned, or `None` when the path is new.
    doc_id: Option<String>,
    tree: BlockTree,
    old_blocks: Vec<MatchBlock>,
    new_blocks: Vec<MatchBlock>,
    result: ReconcileResult,
    /// Ids carried in by the cross-document phase.
    cross_doc_ids: Vec<String>,
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
        prepared: Prepared,
        old_hash_hex: Option<String>,
        new_hash_hex: String,
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
    minter: &mut dyn IdMinter,
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
    let mut mint = || minter.mint("b");
    let result = reconcile_document(
        &old_blocks,
        &new_blocks,
        Options {
            config,
            pool: &offered,
            minter: &mut mint,
        },
    );
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
/// entry first when live) and the id's pool row.
fn evict_foreign_block_rows(conn: &Connection, doc_id: &str, ids: &[String]) -> Result<()> {
    for id in ids {
        let row: Option<(i64, String, Option<String>)> = conn
            .query_row(
                "SELECT rowid, text, deleted_commit FROM blocks WHERE block_id = ?1 AND doc_id != ?2",
                params![id, doc_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((rowid, text, deleted_commit)) = row {
            if deleted_commit.is_none() {
                conn.execute(
                    "INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', ?1, ?2)",
                    params![rowid, text],
                )?;
            }
            conn.execute(
                "DELETE FROM blocks WHERE block_id = ?1 AND doc_id != ?2",
                params![id, doc_id],
            )?;
        }
        conn.execute(
            "DELETE FROM resurrection_pool WHERE block_id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

/// What §5.4 steps 1–13 produce.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Committed {
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
            let Some(source) = &it.source else {
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
            if let Some((doc_id, Some(stored))) = &existing {
                if stored[..] == hash[..] {
                    pending.push(Pending::Echo(ObserveOutcome {
                        path: it.path.clone(),
                        doc_id: doc_id.clone(),
                        rev: None,
                        commit_id: None,
                        converged: true,
                        echo: true,
                        conflicted: false,
                        dispositions: BTreeMap::new(),
                        old_hash_hex,
                        new_hash_hex,
                    }));
                    continue;
                }
            }
            let prepared = prepare_reconcile(
                &self.conn,
                &mut *self.minter,
                repo_id,
                &it.path,
                source,
                config,
                &pool,
                &mut consumed,
            )?;
            pending.push(Pending::Ingest {
                prepared,
                old_hash_hex,
                new_hash_hex,
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
                } => {
                    let conflicted = has_conflict_markers(&prepared.source);
                    let c = self.commit_prepared(repo_id, &prepared, ts, &expires)?;
                    self.conn.execute(
                        "UPDATE docs SET conflicted = ?1 WHERE repo_id = ?2 AND path = ?3",
                        params![i64::from(conflicted), repo_id, prepared.path],
                    )?;
                    let dispositions = {
                        let mut stmt = self.conn.prepare(
                            "SELECT kind, count(*) FROM dispositions WHERE commit_id = ?1 GROUP BY kind ORDER BY kind",
                        )?;
                        let rows = stmt.query_map(params![c.commit_id], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
                        })?;
                        rows.collect::<std::result::Result<BTreeMap<_, _>, _>>()?
                    };
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
    /// commit with the matcher's dispositions.
    fn commit_prepared(
        &mut self,
        repo_id: &str,
        prepared: &Prepared,
        ts: &str,
        expires: &str,
    ) -> Result<Committed> {
        let (_, rest) = split_frontmatter(&prepared.tree);
        // 3. Assign ids (nothing mints: the matcher assigned every key).
        let assigned = assign_from_map(rest, &prepared.result.assignment, &mut *self.minter);
        let plan = IngestPlan {
            path: &prepared.path,
            source: &prepared.source,
            tree: &prepared.tree,
            assigned,
            dispositions: disposition_rows(&prepared.result),
            deleted: prepared.result.deleted.clone(),
            consumed_pool: prepared.result.consumed_pool.clone(),
            cross_doc_ids: prepared.cross_doc_ids.clone(),
            origin: Origin::Observed,
            actor: None,
            reason: None,
        };
        self.commit_ingest(repo_id, &plan, ts, expires)
    }

    /// Parse and reconcile `source` at `path` against the stored tree (the
    /// pool offered when a doc row exists, §5.1 step 4) and commit it with
    /// the given provenance — the reference's `ingestFile` with
    /// `makeReconcilingResolver`: `docs_create`/`docs_set_meta` (`api`) and
    /// the file-CAS conflict ingest of `spec/mutate` §4 (`observed`). No echo
    /// gate, no `conflicted` update, no sweep.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn reconciling_ingest(
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
        let expires = pool_expiry(ts)?;
        let pool = load_pool(&self.conn, repo_id, ts)?;
        let mut consumed = HashSet::new();
        let prepared = prepare_reconcile(
            &self.conn,
            &mut *self.minter,
            repo_id,
            path,
            source,
            config,
            &pool,
            &mut consumed,
        )?;
        let (_, rest) = split_frontmatter(&prepared.tree);
        let assigned = assign_from_map(rest, &prepared.result.assignment, &mut *self.minter);
        let plan = IngestPlan {
            path,
            source,
            tree: &prepared.tree,
            assigned,
            dispositions: disposition_rows(&prepared.result),
            deleted: prepared.result.deleted.clone(),
            consumed_pool: prepared.result.consumed_pool.clone(),
            cross_doc_ids: Vec::new(),
            origin,
            actor,
            reason,
        };
        self.commit_ingest(repo_id, &plan, ts, &expires)
    }

    /// §5.4 steps 1–13 in one transaction (the reference's `ingestFile`).
    pub(crate) fn commit_ingest(
        &mut self,
        repo_id: &str,
        plan: &IngestPlan<'_>,
        ts: &str,
        expires: &str,
    ) -> Result<Committed> {
        let tx = self.conn.unchecked_transaction()?;
        let minter: &mut dyn IdMinter = &mut *self.minter;
        let tree = plan.tree;
        let source = plan.source;
        let (fm_block, _) = split_frontmatter(tree);

        // 2. Frontmatter blob (the reference puts it before the doc row; blobs
        //    are content-addressed, so the order is unobservable).
        let fm_blob_hex = fm_block.map(|b| put_blob(&tx, &b.raw)).transpose()?;
        let fm_trivia = fm_block.map(|b| b.trivia.as_str());

        // 1. Doc row (the path's row regardless of tombstone; a re-created
        //    path is revived — §5.6 "Re-creation").
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
                    adopt_phantoms(&tx, plan.path, &id)?;
                }
                id
            }
            None => {
                let id = minter.mint("d");
                tx.execute(
                    "INSERT INTO docs (doc_id, repo_id, path, format, leading_trivia, frontmatter_trivia) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![id, repo_id, plan.path, FORMAT_MARKDOWN, tree.leading_trivia, fm_trivia],
                )?;
                // spec/graph §3.5: a new row at this path adopts the open
                // phantom edges that pointed at it (the reference runs this
                // right after the INSERT; nothing is minted).
                adopt_phantoms(&tx, plan.path, &id)?;
                id
            }
        };

        // 4. Write the tree.
        let assigned = &plan.assigned;
        let root_tree_hex = write_block_tree(&tx, assigned)?;

        // 5–6. Commit and revision rows.
        let (commit_id, _) = new_commit(
            &tx,
            minter,
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
        let rendered_hash = sha256(source.as_bytes());
        let (rev_id, _) = write_revision(
            &tx,
            minter,
            &NewRevision {
                doc_id: &doc_id,
                root_tree_hex: &root_tree_hex,
                frontmatter_blob_hex: fm_blob_hex.as_deref(),
                rendered_hash,
                path: plan.path,
                commit_id: &commit_id,
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
            evict_foreign_block_rows(&tx, &doc_id, &incoming)?;
        }

        // 9. Refresh the blocks, sections and FTS.
        fts_delete_doc(&tx, &doc_id)?;
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
        fts_index_doc(&tx, &doc_id)?;
        rebuild_sections(&tx, &doc_id)?;

        // 9a. Nodes (spec/graph §2): the adapter's projections over the
        //     assigned body, then the `md:section` nodes from the sections just
        //     rebuilt; deleted (FTS first) and reinserted.
        let body = doc_blocks(assigned);
        let mut nodes = project_nodes(&body);
        nodes.extend(project_section_nodes(&tx, &doc_id)?);
        write_doc_nodes(&tx, repo_id, &doc_id, &nodes)?;

        // 9b. Properties (spec/properties §6): the document's rows from the
        //     frontmatter block and the assigned body, deleted then written.
        let property_rows = doc_properties(&doc_id, fm_block, &body);
        write_doc_properties(&tx, repo_id, &doc_id, &commit_id, &property_rows)?;

        // 9c. Edges (spec/graph §3): descriptors from the blocks in pre-order
        //     then the frontmatter mapping (the same parse the properties step
        //     uses; none when it fails), resolved in order (**mints `x`** per
        //     new external URI), then the intervals (**mints `e`** per new
        //     edge) and the rollup.
        let mapping = fm_block.and_then(|b| parse_frontmatter(frontmatter_yaml(&b.raw)));
        let descriptors = extract_doc_edges(&body, mapping.as_ref());
        let resolved = resolve_edges(&tx, minter, repo_id, &doc_id, plan.path, &descriptors)?;
        maintain_edges(&tx, minter, repo_id, &doc_id, &commit_id, &resolved)?;

        // 10. Dispositions and block_changes.
        {
            let mut ins = tx.prepare(
                "INSERT OR IGNORE INTO dispositions (commit_id, block_id, kind, confidence, reason, matcher_v, detail)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            let mut bc = tx.prepare(
                "INSERT OR IGNORE INTO block_changes (block_id, commit_id, kind) VALUES (?1, ?2, ?3)",
            )?;
            for d in &plan.dispositions {
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

        // 12. Pointers.
        tx.execute(
            "UPDATE docs SET current_rev = ?1, file_hash = ?2 WHERE doc_id = ?3",
            params![rev_id, &rendered_hash[..], doc_id],
        )?;

        // 13. Converged: file_hash == rendered_hash (trivially), render(tree) ==
        //     source, reconstruct(doc) == source.
        let converged =
            render(tree) == source && reconstruct(&tx, &doc_id)?.as_deref() == Some(source);

        tx.commit()?;
        Ok(Committed {
            doc_id,
            commit_id,
            rev_id,
            converged,
        })
    }

    /// §5.6: tombstone a live doc whose path is gone. Mints `c`; pools every
    /// live block; drops the FTS rows; tombstones the blocks and the doc row.
    /// Returns the commit id.
    pub(crate) fn tombstone_observed_deletion(
        &mut self,
        repo_id: &str,
        doc_id: &str,
        ts: &str,
        expires: &str,
    ) -> Result<String> {
        let tx = self.conn.unchecked_transaction()?;
        let minter: &mut dyn IdMinter = &mut *self.minter;
        let (commit_id, _) = new_commit(
            &tx,
            minter,
            &NewCommit {
                reason: Some("observed deletion"),
                ..NewCommit::observed(repo_id, ts)
            },
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO resurrection_pool (block_id, repo_id, doc_id, raw_hash, norm_hash, type, deleted_commit, expires_ts)
             SELECT block_id, repo_id, doc_id, raw_hash, norm_hash, type, ?1, ?2
               FROM blocks WHERE doc_id = ?3 AND deleted_commit IS NULL",
            params![commit_id, expires, doc_id],
        )?;
        fts_delete_doc(&tx, doc_id)?;
        tx.execute(
            "UPDATE blocks SET deleted_commit = ?1 WHERE doc_id = ?2 AND deleted_commit IS NULL",
            params![commit_id, doc_id],
        )?;
        tx.execute(
            "UPDATE docs SET deleted_commit = ?1 WHERE doc_id = ?2",
            params![commit_id, doc_id],
        )?;
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
    /// no-op (`doc_id: None`).
    pub fn observe_delete(&mut self, repo_id: &str, path: &str, ts: &str) -> Result<DeleteOutcome> {
        let expires = pool_expiry(ts)?;
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
