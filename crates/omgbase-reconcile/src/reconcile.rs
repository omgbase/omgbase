//! The document reconciler (`spec/reconcile/README.md` §5): the phases in
//! order, the bulk-rewrite check, phase 6b (resurrection) and phase 7
//! (defaults).

use std::collections::{BTreeMap, HashMap};

use crate::mint::Minter;
use crate::phase5::phase5_scored;
use crate::phase6a::phase6a_compound;
use crate::phases::{
    PhaseState, old_id, phase1_exact, phase2_normalized, phase3_anchor, phase4_propagate,
};
use crate::types::{
    Config, Detail, DetailValue, Disposition, DispositionKind, MatchBlock, PoolEntry, Reason,
    ReconcileResult,
};

/// What [`reconcile_document`] needs besides the two block lists.
pub struct Options<'a> {
    pub config: &'a Config,
    /// The resurrection pool (phase 6b); empty to skip the phase.
    pub pool: &'a [PoolEntry],
    /// Where minted ids come from.
    pub minter: &'a mut dyn Minter,
}

/// Bulk-rewrite check: at least `bulk_min_blocks` new blocks and an
/// unmatched fraction strictly above `bulk_unmatched_frac` after phase 2.
fn should_bulk_rewrite(state: &PhaseState<'_>) -> bool {
    let total = state.neu.len();
    if total < state.config.bulk_min_blocks {
        return false;
    }
    unmatched_frac(state) > state.config.bulk_unmatched_frac
}

fn unmatched_frac(state: &PhaseState<'_>) -> f64 {
    (state.neu.len() - state.used_new_len()) as f64 / state.neu.len() as f64
}

/// Phase 6b — resurrection: index the pool by `(type, raw_hash)` and
/// `(type, norm_hash)` (later entries win); each unmatched new block takes
/// the raw-hash hit if any, else the norm-hash hit, when that id is not yet
/// consumed this run. A consumed raw-hash hit does not fall back.
fn phase6b_resurrection(
    state: &mut PhaseState<'_>,
    pool: &[PoolEntry],
    consumed: &mut Vec<String>,
) {
    let mut by_raw: HashMap<(&str, &str), &PoolEntry> = HashMap::new();
    let mut by_norm: HashMap<(&str, &str), &PoolEntry> = HashMap::new();
    for c in pool {
        by_raw.insert((&c.kind, &c.raw_hash), c);
        by_norm.insert((&c.kind, &c.norm_hash), c);
    }
    for n in state.neu {
        if state.is_new_used(&n.key) {
            continue;
        }
        let hit = by_raw
            .get(&(n.kind.as_str(), n.raw_hash.as_str()))
            .or_else(|| by_norm.get(&(n.kind.as_str(), n.norm_hash.as_str())));
        if let Some(hit) = hit {
            if !consumed.contains(&hit.id) {
                consumed.push(hit.id.clone());
                state.assign(&n.key, &hit.id);
                state.push(
                    &hit.id,
                    DispositionKind::Resurrected,
                    Some(0.99),
                    Some(Reason::ExactHash),
                    Detail::new(),
                );
            }
        }
    }
}

/// Reconcile one document. `old` blocks carry ids (§1.1); `new` blocks do
/// not. Returns the assignment (new key → id), the dispositions, the deleted
/// old ids and the consumed pool ids.
///
/// # Panics
///
/// If an old block has no `id`.
pub fn reconcile_document(
    old: &[MatchBlock],
    new: &[MatchBlock],
    opts: Options<'_>,
) -> ReconcileResult {
    let Options {
        config,
        pool,
        minter,
    } = opts;
    let mut state = PhaseState::new(old, new, config);

    phase1_exact(&mut state);
    phase2_normalized(&mut state);

    if should_bulk_rewrite(&state) {
        return bulk_rewrite(&state, minter);
    }

    phase3_anchor(&mut state);
    phase4_propagate(&mut state);
    phase5_scored(&mut state);
    phase6a_compound(&mut state);
    let mut consumed = Vec::new();
    if !pool.is_empty() {
        phase6b_resurrection(&mut state, pool, &mut consumed);
    }

    finalize(state, consumed, minter)
}

fn stamped(
    config: &Config,
    block_id: String,
    kind: DispositionKind,
    reason: Option<Reason>,
    detail: Detail,
) -> Disposition {
    Disposition {
        block_id,
        kind,
        confidence: None,
        reason,
        matcher_v: config.matcher_v.clone(),
        detail,
    }
}

/// Phase 7: lineage placeholders get their minted id (the id already
/// assigned to `detail.newKey`, else a fresh mint); every unassigned new
/// block is minted `inserted`; every old block not carried and not otherwise
/// disposed is `deleted` and listed.
fn finalize(
    state: PhaseState<'_>,
    consumed_pool: Vec<String>,
    minter: &mut dyn Minter,
) -> ReconcileResult {
    let config = state.config;
    let mut assignment: BTreeMap<String, String> = state
        .matched()
        .iter()
        .map(|(k, id)| (k.clone(), id.clone()))
        .collect();
    let mut dispositions = state.dispositions.clone();

    for &i in &state.lineage {
        let d = &mut dispositions[i];
        let new_key = match d.detail.get("newKey") {
            Some(DetailValue::Str(k)) => k.clone(),
            _ => unreachable!("a lineage disposition records detail.newKey"),
        };
        let minted = assignment
            .get(&new_key)
            .cloned()
            .unwrap_or_else(|| minter.mint());
        assignment.insert(new_key, minted.clone());
        d.block_id = minted;
    }

    for n in state.neu {
        if !assignment.contains_key(&n.key) {
            let minted = minter.mint();
            assignment.insert(n.key.clone(), minted.clone());
            dispositions.push(stamped(
                config,
                minted,
                DispositionKind::Inserted,
                None,
                Detail::new(),
            ));
        }
    }

    let mut deleted = Vec::new();
    for o in state.old {
        let id = old_id(o);
        if !state.is_old_used(id) {
            deleted.push(id.to_owned());
            dispositions.push(stamped(
                config,
                id.to_owned(),
                DispositionKind::Deleted,
                Some(Reason::Tombstone),
                Detail::new(),
            ));
        }
    }

    ReconcileResult {
        assignment,
        dispositions,
        deleted,
        consumed_pool,
    }
}

/// Give up on block continuity: one `DOC` `bulk_rewrite` disposition, every
/// new block minted `inserted`, every old block `deleted`.
fn bulk_rewrite(state: &PhaseState<'_>, minter: &mut dyn Minter) -> ReconcileResult {
    let config = state.config;
    let mut detail = Detail::new();
    detail.insert(
        "unmatchedFrac".to_owned(),
        DetailValue::Num(unmatched_frac(state)),
    );
    let mut dispositions = vec![stamped(
        config,
        "DOC".to_owned(),
        DispositionKind::BulkRewrite,
        None,
        detail,
    )];
    let mut assignment = BTreeMap::new();
    for n in state.neu {
        let minted = minter.mint();
        assignment.insert(n.key.clone(), minted.clone());
        dispositions.push(stamped(
            config,
            minted,
            DispositionKind::Inserted,
            None,
            Detail::new(),
        ));
    }
    let mut deleted = Vec::new();
    for o in state.old {
        let id = old_id(o).to_owned();
        deleted.push(id.clone());
        dispositions.push(stamped(
            config,
            id,
            DispositionKind::Deleted,
            Some(Reason::Tombstone),
            Detail::new(),
        ));
    }
    ReconcileResult {
        assignment,
        dispositions,
        deleted,
        consumed_pool: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use omgbase_format::BlockKind;
    use omgbase_format::hash::{hex, norm_hash, raw_hash};
    use omgbase_format::text::normalize_visible_text;

    use super::*;
    use crate::flatten::{FlatSource, flatten};
    use crate::mint::SequentialMinter;

    fn old_tree(pairs: &[(&str, &str)]) -> Vec<FlatSource> {
        pairs
            .iter()
            .map(|(id, raw)| FlatSource::new(BlockKind::Paragraph, raw).with_id(id))
            .collect()
    }

    fn new_tree(raws: &[&str]) -> Vec<FlatSource> {
        raws.iter()
            .map(|raw| FlatSource::new(BlockKind::Paragraph, raw))
            .collect()
    }

    fn run(old: &[MatchBlock], neu: &[MatchBlock], pool: &[PoolEntry]) -> ReconcileResult {
        let cfg = Config::default();
        let mut minter = SequentialMinter::new("n");
        reconcile_document(
            old,
            neu,
            Options {
                config: &cfg,
                pool,
                minter: &mut minter,
            },
        )
    }

    fn find<'a>(res: &'a ReconcileResult, id: &str) -> &'a Disposition {
        res.dispositions
            .iter()
            .find(|d| d.block_id == id)
            .expect("disposition")
    }

    #[test]
    fn brief_example_insertion_mints_and_edited_paragraph_carries() {
        let old = flatten(&[
            FlatSource::new(BlockKind::Heading, "## Risks").with_id("b_h"),
            FlatSource::new(BlockKind::Paragraph, "Stable block identity is difficult.")
                .with_id("b_p1"),
            FlatSource::new(BlockKind::Paragraph, "Another paragraph.").with_id("b_p2"),
        ]);
        let neu = flatten(&[
            FlatSource::new(BlockKind::Heading, "## Risks"),
            FlatSource::new(BlockKind::Paragraph, "A newly inserted paragraph."),
            FlatSource::new(
                BlockKind::Paragraph,
                "Stable block identity is quite difficult.",
            ),
            FlatSource::new(BlockKind::Paragraph, "Another paragraph."),
        ]);
        let res = run(&old, &neu, &[]);
        assert_eq!(res.assignment["/0"], "b_h");
        assert_eq!(res.assignment["/3"], "b_p2");
        assert_eq!(res.assignment["/2"], "b_p1");
        let inserted = &res.assignment["/1"];
        assert_eq!(inserted, "n_0");
        assert_eq!(find(&res, inserted).kind, DispositionKind::Inserted);
        assert_eq!(find(&res, "b_p2").kind, DispositionKind::Moved);
        assert_eq!(find(&res, "b_p1").kind, DispositionKind::EditedMoved);
        assert_eq!(res.dispositions.len(), 4);
        assert!(res.deleted.is_empty());
        assert!(res.consumed_pool.is_empty());
    }

    #[test]
    fn deletes_an_old_block_that_vanished() {
        let old = flatten(&old_tree(&[
            ("b_1", "keep this line"),
            ("b_2", "delete this line"),
        ]));
        let neu = flatten(&new_tree(&["keep this line"]));
        let res = run(&old, &neu, &[]);
        assert_eq!(res.assignment["/0"], "b_1");
        assert_eq!(res.deleted, ["b_2"]);
        let d = find(&res, "b_2");
        assert_eq!(d.kind, DispositionKind::Deleted);
        assert_eq!(d.reason, Some(Reason::Tombstone));
        assert_eq!(d.confidence, None);
    }

    #[test]
    fn resurrects_from_the_pool_by_hash() {
        let raw = "a resurrected paragraph from a prior checkpoint";
        let text = normalize_visible_text(raw, BlockKind::Paragraph, 0);
        let pool = [PoolEntry {
            id: "b_old".to_owned(),
            kind: "paragraph".to_owned(),
            raw_hash: hex(&raw_hash(raw)),
            norm_hash: hex(&norm_hash(&text)),
        }];
        let old = flatten(&old_tree(&[("b_1", "existing content here")]));
        let neu = flatten(&new_tree(&["existing content here", raw]));
        let res = run(&old, &neu, &pool);
        assert_eq!(res.assignment["/1"], "b_old");
        assert_eq!(res.consumed_pool, ["b_old"]);
        let d = find(&res, "b_old");
        assert_eq!(d.kind, DispositionKind::Resurrected);
        assert_eq!(d.confidence, Some(0.99));
        assert_eq!(d.reason, Some(Reason::ExactHash));

        // A norm-hash hit resurrects too (reason still exact_hash, §10); a
        // consumed raw-hash hit does not fall back to the norm entry.
        let neu2 = flatten(&new_tree(&[
            "existing content here",
            &format!("{raw}  "),
            raw,
        ]));
        let res2 = run(&old, &neu2, &pool);
        assert_eq!(res2.assignment["/1"], "b_old");
        assert_eq!(res2.consumed_pool, ["b_old"]);
        assert_ne!(res2.assignment["/2"], "b_old");
        assert_eq!(
            find(&res2, &res2.assignment["/2"]).kind,
            DispositionKind::Inserted
        );
    }

    #[test]
    fn later_pool_entry_wins_on_a_shared_key() {
        let raw = "pooled paragraph text";
        let text = normalize_visible_text(raw, BlockKind::Paragraph, 0);
        let entry = |id: &str| PoolEntry {
            id: id.to_owned(),
            kind: "paragraph".to_owned(),
            raw_hash: hex(&raw_hash(raw)),
            norm_hash: hex(&norm_hash(&text)),
        };
        let pool = [entry("b_first"), entry("b_second")];
        let old: Vec<MatchBlock> = Vec::new();
        let neu = flatten(&new_tree(&[raw]));
        let res = run(&old, &neu, &pool);
        assert_eq!(res.assignment["/0"], "b_second");
    }

    #[test]
    fn bulk_rewrite_on_a_mostly_rewritten_large_document() {
        let olds: Vec<(String, String)> = (0..120)
            .map(|i| {
                (
                    format!("b_{i}"),
                    format!("original sentence number {i} with distinct words"),
                )
            })
            .collect();
        let old_pairs: Vec<(&str, &str)> =
            olds.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let news: Vec<String> = (0..120)
            .map(|i| {
                format!("completely fresh replacement text alpha{i} beta{i} gamma{i} unrelated")
            })
            .collect();
        let new_raws: Vec<&str> = news.iter().map(String::as_str).collect();
        let res = run(
            &flatten(&old_tree(&old_pairs)),
            &flatten(&new_tree(&new_raws)),
            &[],
        );
        let doc = &res.dispositions[0];
        assert_eq!(doc.block_id, "DOC");
        assert_eq!(doc.kind, DispositionKind::BulkRewrite);
        assert_eq!(doc.detail["unmatchedFrac"], DetailValue::Num(1.0));
        assert_eq!(res.deleted.len(), 120);
        assert_eq!(res.assignment.len(), 120);
        assert_eq!(res.dispositions.len(), 241);
        assert!(res.consumed_pool.is_empty());
    }

    #[test]
    fn is_deterministic() {
        let build = || {
            run(
                &flatten(&old_tree(&[
                    ("b_1", "the first paragraph text"),
                    ("b_2", "the second paragraph text"),
                ])),
                &flatten(&new_tree(&[
                    "the first paragraph text",
                    "the second paragraph text",
                ])),
                &[],
            )
        };
        let a = build();
        let b = build();
        assert_eq!(a, b);
        assert_eq!(a.assignment["/0"], "b_1");
    }

    #[test]
    fn lineage_mints_receive_ids_in_phase_7() {
        let cfg = Config {
            split_dominant_share: 1.01,
            ..Config::default()
        };
        let old = flatten(&old_tree(&[(
            "b_1",
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
        )]));
        let neu = flatten(&new_tree(&[
            "alpha beta gamma delta epsilon zeta",
            "eta theta iota kappa lambda mu",
        ]));
        let mut minter = SequentialMinter::new("n");
        let res = reconcile_document(
            &old,
            &neu,
            Options {
                config: &cfg,
                pool: &[],
                minter: &mut minter,
            },
        );
        assert_eq!(res.assignment["/0"], "n_0");
        assert_eq!(res.assignment["/1"], "n_1");
        let d0 = find(&res, "n_0");
        assert_eq!(d0.kind, DispositionKind::SplitFrom);
        assert_eq!(d0.detail["newKey"], DetailValue::Str("/0".to_owned()));
        assert_eq!(d0.detail["counterpart"], DetailValue::Str("b_1".to_owned()));
        // The non-dominant split tombstone is a disposition but not in `deleted` (§10).
        assert_eq!(find(&res, "b_1").kind, DispositionKind::Deleted);
        assert!(res.deleted.is_empty());
    }
}
