//! Cross-document moves (`spec/reconcile/README.md` §7). After each document
//! of a checkpoint is reconciled on its own, the checkpoint's deleted blocks
//! are pooled against its inserted blocks; a pair from different documents
//! with `text_sim ≥ theta_xdoc` is a move, and the deleted id carries.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::similarity::{text_sim, token_count};
use crate::types::{
    Config, Detail, DetailValue, Disposition, DispositionKind, MatchBlock, Reason, ReconcileResult,
};

/// A new block minted `inserted`, with the id it was minted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inserted {
    pub block: MatchBlock,
    pub minted_id: String,
}

/// One document's leftovers after its own reconciliation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PerDocUnmatched {
    pub doc_id: String,
    /// The old blocks whose ids are in the result's `deleted`, in that order.
    pub deleted: Vec<MatchBlock>,
    /// The new blocks with an `inserted` disposition, in disposition order.
    pub inserted: Vec<Inserted>,
}

/// A move: the deleted block's id carries into the destination document.
#[derive(Clone, Debug, PartialEq)]
pub struct CrossDocMatch {
    pub from_doc: String,
    pub to_doc: String,
    /// The surviving id (the deleted block's).
    pub carried_id: String,
    /// The minted id it replaces in the destination.
    pub replaced_minted_id: String,
    pub new_key: String,
    /// `moved` when the raw hashes agree, else `edited_moved`.
    pub kind: DispositionKind,
    /// The pair's `text_sim`.
    pub confidence: f64,
}

/// Pair the checkpoint's deleted and inserted blocks (§7): same type,
/// different documents, token ratio ≤ 3, `text_sim ≥ theta_xdoc`; sorted by
/// `text_sim` descending, then the deleted block's position in the pool,
/// then the inserted block's; greedily accepted while both are unused.
#[must_use]
pub fn cross_doc_match(docs: &[PerDocUnmatched], config: &Config) -> Vec<CrossDocMatch> {
    let deleted: Vec<(&str, &MatchBlock)> = docs
        .iter()
        .flat_map(|d| d.deleted.iter().map(move |b| (d.doc_id.as_str(), b)))
        .collect();
    let inserted: Vec<(&str, &Inserted)> = docs
        .iter()
        .flat_map(|d| d.inserted.iter().map(move |i| (d.doc_id.as_str(), i)))
        .collect();

    let mut pairs: Vec<(usize, usize, f64)> = Vec::new();
    for (di, (d_doc, o)) in deleted.iter().enumerate() {
        for (ii, (i_doc, ins)) in inserted.iter().enumerate() {
            let n = &ins.block;
            if o.kind != n.kind || d_doc == i_doc {
                continue;
            }
            let (oc, nc) = (token_count(&o.text), token_count(&n.text));
            let ratio = oc.max(nc) as f64 / oc.min(nc).max(1) as f64;
            if ratio > 3.0 {
                continue;
            }
            let score = text_sim(&o.text, &n.text);
            if score >= config.theta_xdoc {
                pairs.push((di, ii, score));
            }
        }
    }
    pairs.sort_by(|a, b| {
        b.2.partial_cmp(&a.2)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.cmp(&b.1))
    });

    let mut used_del = vec![false; deleted.len()];
    let mut used_ins = vec![false; inserted.len()];
    let mut matches = Vec::new();
    for (di, ii, score) in pairs {
        if used_del[di] || used_ins[ii] {
            continue;
        }
        used_del[di] = true;
        used_ins[ii] = true;
        let (from_doc, o) = deleted[di];
        let (to_doc, ins) = inserted[ii];
        let edited = o.raw_hash != ins.block.raw_hash;
        matches.push(CrossDocMatch {
            from_doc: from_doc.to_owned(),
            to_doc: to_doc.to_owned(),
            carried_id: o.id.clone().expect("a deleted block carries its id"),
            replaced_minted_id: ins.minted_id.clone(),
            new_key: ins.block.key.clone(),
            kind: if edited {
                DispositionKind::EditedMoved
            } else {
                DispositionKind::Moved
            },
            confidence: score,
        });
    }
    matches
}

/// Apply the moves to the per-document results: in the destination,
/// `assignment[new_key] = carried_id`, the replaced id's `inserted`
/// disposition goes and `{ carried_id, kind, confidence, scored, { fromDoc } }`
/// is appended; in the source, the `deleted` disposition of `carried_id` goes
/// and the id leaves `deleted`. A move whose documents are not both present
/// is skipped.
pub fn apply_cross_doc_matches(
    results_by_doc: &mut BTreeMap<String, ReconcileResult>,
    matches: &[CrossDocMatch],
    matcher_v: &str,
) {
    for m in matches {
        if !results_by_doc.contains_key(&m.to_doc) || !results_by_doc.contains_key(&m.from_doc) {
            continue;
        }
        let dest = results_by_doc.get_mut(&m.to_doc).expect("checked");
        dest.assignment
            .insert(m.new_key.clone(), m.carried_id.clone());
        dest.dispositions.retain(|d| {
            !(d.block_id == m.replaced_minted_id && d.kind == DispositionKind::Inserted)
        });
        let mut detail = Detail::new();
        detail.insert("fromDoc".to_owned(), DetailValue::Str(m.from_doc.clone()));
        dest.dispositions.push(Disposition {
            block_id: m.carried_id.clone(),
            kind: m.kind,
            confidence: Some(m.confidence),
            reason: Some(Reason::Scored),
            matcher_v: matcher_v.to_owned(),
            detail,
        });

        let src = results_by_doc.get_mut(&m.from_doc).expect("checked");
        src.dispositions
            .retain(|d| !(d.block_id == m.carried_id && d.kind == DispositionKind::Deleted));
        src.deleted.retain(|id| id != &m.carried_id);
    }
}

#[cfg(test)]
mod tests {
    use omgbase_format::BlockKind;

    use super::*;
    use crate::flatten::{FlatSource, flatten};
    use crate::mint::SequentialMinter;
    use crate::reconcile::{Options, reconcile_document};

    fn tree(pairs: &[(Option<&str>, &str)]) -> Vec<FlatSource> {
        pairs
            .iter()
            .map(|(id, raw)| {
                let b = FlatSource::new(BlockKind::Paragraph, raw);
                match id {
                    Some(id) => b.with_id(id),
                    None => b,
                }
            })
            .collect()
    }

    /// The §7 leftovers of one document.
    fn unmatched(
        doc_id: &str,
        old: &[MatchBlock],
        neu: &[MatchBlock],
        res: &ReconcileResult,
    ) -> PerDocUnmatched {
        PerDocUnmatched {
            doc_id: doc_id.to_owned(),
            deleted: res
                .deleted
                .iter()
                .map(|id| {
                    old.iter()
                        .find(|b| b.id.as_deref() == Some(id))
                        .unwrap()
                        .clone()
                })
                .collect(),
            inserted: res
                .dispositions
                .iter()
                .filter(|d| d.kind == DispositionKind::Inserted)
                .map(|d| {
                    let (key, _) = res
                        .assignment
                        .iter()
                        .find(|(_, v)| **v == d.block_id)
                        .unwrap();
                    Inserted {
                        block: neu.iter().find(|b| &b.key == key).unwrap().clone(),
                        minted_id: d.block_id.clone(),
                    }
                })
                .collect(),
        }
    }

    #[test]
    fn cut_paste_across_files_carries_identity_as_moved() {
        let cfg = Config::default();
        let mut minter = SequentialMinter::new("n");
        let moved_text = "this whole paragraph gets cut from file a and pasted into file b intact";

        let a_old = flatten(&tree(&[
            (Some("b_keep"), "file a keeps this"),
            (Some("b_move"), moved_text),
        ]));
        let a_new = flatten(&tree(&[(None, "file a keeps this")]));
        let a_res = reconcile_document(
            &a_old,
            &a_new,
            Options {
                config: &cfg,
                pool: &[],
                minter: &mut minter,
            },
        );

        let b_old = flatten(&tree(&[(Some("b_bkeep"), "file b original line")]));
        let b_new = flatten(&tree(&[(None, "file b original line"), (None, moved_text)]));
        let b_res = reconcile_document(
            &b_old,
            &b_new,
            Options {
                config: &cfg,
                pool: &[],
                minter: &mut minter,
            },
        );

        assert_eq!(a_res.deleted, ["b_move"]);
        let per_doc = [
            unmatched("A", &a_old, &a_new, &a_res),
            unmatched("B", &b_old, &b_new, &b_res),
        ];
        let matches = cross_doc_match(&per_doc, &cfg);
        assert_eq!(matches.len(), 1);
        let m = &matches[0];
        assert_eq!(m.carried_id, "b_move");
        assert_eq!(m.kind, DispositionKind::Moved);
        assert_eq!(m.confidence, 1.0);
        assert_eq!(
            (m.from_doc.as_str(), m.to_doc.as_str(), m.new_key.as_str()),
            ("A", "B", "/1")
        );
        assert_eq!(m.replaced_minted_id, "n_0");

        let mut by_doc = BTreeMap::new();
        by_doc.insert("A".to_owned(), a_res);
        by_doc.insert("B".to_owned(), b_res);
        apply_cross_doc_matches(&mut by_doc, &matches, &cfg.matcher_v);
        let (a, b) = (&by_doc["A"], &by_doc["B"]);
        assert_eq!(b.assignment["/1"], "b_move");
        assert!(a.deleted.is_empty());
        assert!(!a.dispositions.iter().any(|d| d.block_id == "b_move"));
        assert!(!b.dispositions.iter().any(|d| d.block_id == "n_0"));
        let d = b
            .dispositions
            .iter()
            .find(|d| d.block_id == "b_move")
            .unwrap();
        assert_eq!(d.kind, DispositionKind::Moved);
        assert_eq!(d.reason, Some(Reason::Scored));
        assert_eq!(d.detail["fromDoc"], DetailValue::Str("A".to_owned()));
        assert_eq!(d.matcher_v, "m2.1");
    }

    #[test]
    fn does_not_match_within_the_same_document() {
        let cfg = Config::default();
        let per_doc = [PerDocUnmatched {
            doc_id: "A".to_owned(),
            deleted: flatten(&tree(&[(Some("b_1"), "some paragraph text here to match")])),
            inserted: vec![Inserted {
                block: flatten(&tree(&[(None, "some paragraph text here to match")]))[0].clone(),
                minted_id: "b_new".to_owned(),
            }],
        }];
        assert!(cross_doc_match(&per_doc, &cfg).is_empty());
    }

    #[test]
    fn edited_moves_and_the_threshold() {
        let cfg = Config::default();
        let a = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
        let docs = [
            PerDocUnmatched {
                doc_id: "A".to_owned(),
                deleted: flatten(&tree(&[(Some("b_1"), a)])),
                inserted: vec![],
            },
            PerDocUnmatched {
                doc_id: "B".to_owned(),
                deleted: vec![],
                inserted: vec![
                    Inserted {
                        block: flatten(&tree(&[(
                            None,
                            "alpha beta gamma delta epsilon zeta eta theta iota LAMBDA",
                        )]))[0]
                            .clone(),
                        minted_id: "n_0".to_owned(),
                    },
                    Inserted {
                        block: flatten(&tree(&[(None, "unrelated words entirely")]))[0].clone(),
                        minted_id: "n_1".to_owned(),
                    },
                ],
            },
        ];
        let matches = cross_doc_match(&docs, &cfg);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].kind, DispositionKind::EditedMoved);
        assert_eq!(matches[0].replaced_minted_id, "n_0");
        assert!(matches[0].confidence >= cfg.theta_xdoc && matches[0].confidence < 1.0);
    }
}
