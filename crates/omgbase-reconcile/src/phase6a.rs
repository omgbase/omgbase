//! Phase 6a — compound classification (`spec/reconcile/README.md` §5):
//! splits, merges and copies over the still-unmatched blocks. Split and
//! merge use dominant-fragment inheritance (`split_dominant_share`; `1.01`
//! disables it), and each pass continues through the document after a hit
//! (§10, m2.1: every split and every merge resolves in one run). Copies
//! never steal identity.

use crate::phases::{PhaseState, old_id};
use crate::similarity::{dice, shingles, token_count, tokenize};
use crate::types::{Detail, DetailValue, DispositionKind, MatchBlock, Reason};

/// `coverage(X, Y)` = `|shingles(Y) ∩ shingles(X)| / |shingles(Y)|`; 0 when
/// *Y* has no shingles.
fn coverage(concat_text: &str, o_text: &str) -> f64 {
    let os = shingles(o_text);
    if os.is_empty() {
        return 0.0;
    }
    let cs = shingles(concat_text);
    let covered = os.iter().filter(|s| cs.contains(*s)).count();
    covered as f64 / os.len() as f64
}

/// The number of tokens of `whole` (with repeats) that occur in the token
/// set of `fragment`, over `whole_token_count`.
fn shared_token_fraction(fragment: &str, whole: &str, whole_token_count: usize) -> f64 {
    let frag: std::collections::BTreeSet<String> = tokenize(fragment).into_iter().collect();
    let shared = tokenize(whole).iter().filter(|t| frag.contains(*t)).count();
    shared as f64 / whole_token_count as f64
}

fn is_contiguous(run: &[&MatchBlock]) -> bool {
    run.windows(2).all(|w| w[1].index == w[0].index + 1)
}

fn concat(run: &[&MatchBlock]) -> String {
    run.iter()
        .map(|b| b.text.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

fn keys(run: &[&MatchBlock]) -> DetailValue {
    DetailValue::List(
        run.iter()
            .map(|b| DetailValue::Str(b.key.clone()))
            .collect(),
    )
}

fn ids(run: &[&MatchBlock]) -> DetailValue {
    DetailValue::List(
        run.iter()
            .map(|b| DetailValue::Str(old_id(b).to_owned()))
            .collect(),
    )
}

/// A carry made by this phase: reason `scored`.
fn carry_to(
    state: &mut PhaseState<'_>,
    o: &MatchBlock,
    n: &MatchBlock,
    kind: DispositionKind,
    confidence: f64,
    detail: Detail,
) {
    state.carry(o, n, kind, confidence, Reason::Scored, detail);
}

/// The placeholder `block_id` of a lineage mint until phase 7 mints its id.
pub(crate) fn lineage_placeholder(new_key: &str) -> String {
    format!("NEW:{new_key}")
}

/// "Minted with lineage `kind`, counterpart `c`": mark the new block used and
/// record `{ counterpart, newKey }`; phase 7 mints the id.
fn note_lineage(
    state: &mut PhaseState<'_>,
    n: &MatchBlock,
    kind: DispositionKind,
    counterpart: &str,
) {
    state.mark_new_used(&n.key);
    let mut detail = Detail::new();
    detail.insert(
        "counterpart".to_owned(),
        DetailValue::Str(counterpart.to_owned()),
    );
    detail.insert("newKey".to_owned(), DetailValue::Str(n.key.clone()));
    state.lineage.push(state.dispositions.len());
    state.push(
        &lineage_placeholder(&n.key),
        kind,
        None,
        Some(Reason::Scored),
        detail,
    );
}

/// Same-parent, same-type blocks of `pool` as `b`, sorted by index.
fn siblings_like<'a>(pool: Vec<&'a MatchBlock>, b: &MatchBlock) -> Vec<&'a MatchBlock> {
    let mut out: Vec<&MatchBlock> = pool
        .into_iter()
        .filter(|x| x.parent_key == b.parent_key && x.kind == b.kind)
        .collect();
    out.sort_by_key(|x| x.index);
    out
}

/// Every window `[start, end)` of length ≥ 2, longest first for each start.
fn windows(len: usize) -> impl Iterator<Item = (usize, usize)> {
    (0..len).flat_map(move |start| (start + 2..=len).rev().map(move |end| (start, end)))
}

/// Splits: one old block covered by a run of ≥ 2 adjacent new blocks. Visits
/// the old blocks unmatched when the pass began, in document order, skipping
/// any used by the time it is reached; the new candidates are the live
/// unmatched set, so an earlier split's run is not offered again.
fn detect_splits(state: &mut PhaseState<'_>) {
    let split_coverage = state.config.split_coverage;
    let split_dominant_share = state.config.split_dominant_share;
    for o in state.unmatched_old() {
        if state.is_old_used(old_id(o)) {
            continue;
        }
        let news = siblings_like(state.unmatched_new(), o);
        'windows: for (start, end) in windows(news.len()) {
            let run = &news[start..end];
            if !is_contiguous(run) {
                continue;
            }
            let concat = concat(run);
            let cov = coverage(&concat, &o.text);
            if cov < split_coverage {
                continue;
            }
            let leftover = 1.0 - coverage(&o.text, &concat);
            if leftover >= 0.2 {
                continue;
            }
            let o_tokens = token_count(&o.text).max(1);
            let first = run[0];
            let first_share = shared_token_fraction(&first.text, &o.text, o_tokens);
            if first_share >= split_dominant_share {
                let mut detail = Detail::new();
                detail.insert("split".to_owned(), keys(run));
                detail.insert("dominant".to_owned(), DetailValue::Str(first.key.clone()));
                carry_to(state, o, first, DispositionKind::Edited, 0.8 * cov, detail);
                for n in &run[1..] {
                    note_lineage(state, n, DispositionKind::SplitFrom, old_id(o));
                }
            } else {
                let id = old_id(o);
                state.mark_old_used(id);
                let mut detail = Detail::new();
                detail.insert("splitInto".to_owned(), keys(run));
                state.push(
                    id,
                    DispositionKind::Deleted,
                    None,
                    Some(Reason::Tombstone),
                    detail,
                );
                for n in run {
                    note_lineage(state, n, DispositionKind::SplitFrom, id);
                }
            }
            break 'windows; // the first qualifying window is the split; on to the next O
        }
    }
}

/// Merges — the mirror image: a run of ≥ 2 adjacent old blocks covered by
/// one new block. Visits the new blocks unmatched when the pass began, in
/// document order, skipping any used by the time it is reached; the old
/// candidates are the live unmatched set.
fn detect_merges(state: &mut PhaseState<'_>) {
    let split_coverage = state.config.split_coverage;
    let split_dominant_share = state.config.split_dominant_share;
    for n in state.unmatched_new() {
        if state.is_new_used(&n.key) {
            continue;
        }
        let olds = siblings_like(state.unmatched_old(), n);
        'windows: for (start, end) in windows(olds.len()) {
            let run = &olds[start..end];
            if !is_contiguous(run) {
                continue;
            }
            let concat = concat(run);
            let cov = coverage(&n.text, &concat);
            if cov < split_coverage {
                continue;
            }
            let n_tokens = token_count(&n.text).max(1);
            let first = run[0];
            let first_share = shared_token_fraction(&first.text, &n.text, n_tokens);
            if first_share >= split_dominant_share {
                let first_id = old_id(first).to_owned();
                let mut detail = Detail::new();
                detail.insert("merge".to_owned(), ids(run));
                detail.insert("dominant".to_owned(), DetailValue::Str(first_id.clone()));
                carry_to(state, first, n, DispositionKind::Edited, 0.8 * cov, detail);
                for o in &run[1..] {
                    let id = old_id(o);
                    state.mark_old_used(id);
                    let mut detail = Detail::new();
                    detail.insert("into".to_owned(), DetailValue::Str(first_id.clone()));
                    state.push(
                        id,
                        DispositionKind::MergedInto,
                        Some(0.8 * cov),
                        Some(Reason::Scored),
                        detail,
                    );
                }
            } else {
                state.mark_new_used(&n.key);
                for o in run {
                    let id = old_id(o);
                    state.mark_old_used(id);
                    let mut detail = Detail::new();
                    detail.insert("mergedKey".to_owned(), DetailValue::Str(n.key.clone()));
                    state.push(
                        id,
                        DispositionKind::MergedInto,
                        None,
                        Some(Reason::Scored),
                        detail,
                    );
                }
                note_lineage(state, n, DispositionKind::MergedInto, old_id(first));
            }
            break 'windows; // the first qualifying window is the merge; on to the next N
        }
    }
}

/// Copies: an unmatched new block whose shingle Dice with a carried old block
/// of its type is ≥ `copy_sim` mints with `copied_from` lineage.
fn detect_copies(state: &mut PhaseState<'_>) {
    let matched_ids: std::collections::HashSet<&str> =
        state.matched().iter().map(|(_, id)| id.as_str()).collect();
    let matched_old: Vec<&MatchBlock> = state
        .old
        .iter()
        .filter(|o| matched_ids.contains(old_id(o)))
        .collect();
    for n in state.unmatched_new() {
        let ns = shingles(&n.text);
        for o in &matched_old {
            if o.kind != n.kind {
                continue;
            }
            if dice(&shingles(&o.text), &ns) >= state.config.copy_sim {
                note_lineage(state, n, DispositionKind::CopiedFrom, old_id(o));
                break;
            }
        }
    }
}

/// Phase 6a: splits, then merges, then copies.
pub fn phase6a_compound(state: &mut PhaseState<'_>) {
    detect_splits(state);
    detect_merges(state);
    detect_copies(state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phases::phase1_exact;
    use crate::phases::testutil::para;
    use crate::types::Config;

    fn find_kind<'a>(
        s: &'a PhaseState<'_>,
        kind: DispositionKind,
    ) -> Option<&'a crate::types::Disposition> {
        s.dispositions.iter().find(|d| d.kind == kind)
    }

    #[test]
    fn split_dominant_first_fragment_carries() {
        let cfg = Config::default();
        let old = [para(
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
            0,
            Some("b_1"),
        )];
        let neu = [
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota",
                0,
                None,
            ),
            para("kappa lambda mu", 1, None),
        ];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        phase6a_compound(&mut s);
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        let d = find_kind(&s, DispositionKind::SplitFrom).expect("split_from");
        assert_eq!(d.detail["counterpart"], DetailValue::Str("b_1".to_owned()));
        assert_eq!(d.detail["newKey"], DetailValue::Str("/1".to_owned()));
        assert_eq!(d.block_id, "NEW:/1");
        assert_eq!(s.lineage, vec![1]);
        let carry = &s.dispositions[0];
        assert_eq!(carry.kind, DispositionKind::Edited);
        assert_eq!(carry.reason, Some(Reason::Scored));
        assert_eq!(carry.detail["dominant"], DetailValue::Str("/0".to_owned()));
        assert_eq!(
            carry.detail["split"],
            DetailValue::List(vec!["/0".into(), "/1".into()])
        );
    }

    #[test]
    fn split_disabled_dominance_mints_all_fragments() {
        let cfg = Config {
            split_dominant_share: 1.01,
            ..Config::default()
        };
        let old = [para(
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
            0,
            Some("b_1"),
        )];
        let neu = [
            para("alpha beta gamma delta epsilon zeta", 0, None),
            para("eta theta iota kappa lambda mu", 1, None),
        ];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        phase6a_compound(&mut s);
        assert_eq!(s.matched_id("/0"), None);
        let d = s.dispositions.iter().find(|d| d.block_id == "b_1").unwrap();
        assert_eq!(d.kind, DispositionKind::Deleted);
        assert_eq!(d.reason, Some(Reason::Tombstone));
        assert_eq!(
            d.detail["splitInto"],
            DetailValue::List(vec!["/0".into(), "/1".into()])
        );
        assert_eq!(
            s.dispositions
                .iter()
                .filter(|d| d.kind == DispositionKind::SplitFrom)
                .count(),
            2
        );
        assert!(s.is_old_used("b_1"));
    }

    #[test]
    fn merge_dominant_contributor_carries() {
        let cfg = Config::default();
        let old = [
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota",
                0,
                Some("b_1"),
            ),
            para("kappa lambda mu", 1, Some("b_2")),
        ];
        let neu = [para(
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
            0,
            None,
        )];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        phase6a_compound(&mut s);
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        let d = s.dispositions.iter().find(|d| d.block_id == "b_2").unwrap();
        assert_eq!(d.kind, DispositionKind::MergedInto);
        assert_eq!(d.detail["into"], DetailValue::Str("b_1".to_owned()));
        assert!(d.confidence.is_some());
        let carry = &s.dispositions[0];
        assert_eq!(
            carry.detail["merge"],
            DetailValue::List(vec!["b_1".into(), "b_2".into()])
        );
        assert_eq!(carry.detail["dominant"], DetailValue::Str("b_1".to_owned()));
    }

    #[test]
    fn merge_without_dominance_tombstones_the_run() {
        let cfg = Config {
            split_dominant_share: 1.01,
            ..Config::default()
        };
        let old = [
            para("alpha beta gamma delta epsilon zeta", 0, Some("b_1")),
            para("eta theta iota kappa lambda mu", 1, Some("b_2")),
        ];
        let neu = [para(
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
            0,
            None,
        )];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        phase6a_compound(&mut s);
        assert_eq!(s.matched_len(), 0);
        for id in ["b_1", "b_2"] {
            let d = s.dispositions.iter().find(|d| d.block_id == id).unwrap();
            assert_eq!(d.kind, DispositionKind::MergedInto);
            assert_eq!(d.confidence, None);
            assert_eq!(d.detail["mergedKey"], DetailValue::Str("/0".to_owned()));
        }
        let lineage = s.dispositions.last().unwrap();
        assert_eq!(lineage.kind, DispositionKind::MergedInto);
        assert_eq!(lineage.block_id, "NEW:/0");
        assert_eq!(
            lineage.detail["counterpart"],
            DetailValue::Str("b_1".to_owned())
        );
    }

    #[test]
    fn two_splits_both_resolve() {
        // m2.0 returned after the first split; m2.1 continues through the
        // document, offering only the still-unmatched new blocks to the next
        // old block.
        let cfg = Config::default();
        let old = [
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
                0,
                Some("b_1"),
            ),
            para(
                "one two three four five six seven eight nine ten eleven twelve",
                1,
                Some("b_2"),
            ),
        ];
        let neu = [
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota",
                0,
                None,
            ),
            para("kappa lambda mu", 1, None),
            para("one two three four five six seven eight nine", 2, None),
            para("ten eleven twelve", 3, None),
        ];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        phase6a_compound(&mut s);
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        assert_eq!(s.matched_id("/2"), Some("b_2"));
        let lineage: Vec<(&str, &DetailValue)> = s
            .dispositions
            .iter()
            .filter(|d| d.kind == DispositionKind::SplitFrom)
            .map(|d| (d.block_id.as_str(), &d.detail["counterpart"]))
            .collect();
        assert_eq!(
            lineage,
            [
                ("NEW:/1", &DetailValue::Str("b_1".to_owned())),
                ("NEW:/3", &DetailValue::Str("b_2".to_owned())),
            ]
        );
        assert_eq!(
            s.dispositions[2].detail["split"],
            DetailValue::List(vec!["/2".into(), "/3".into()])
        );
        assert_eq!(s.unmatched_new().len(), 0);
        assert_eq!(s.unmatched_old().len(), 0);
    }

    #[test]
    fn two_merges_both_resolve() {
        let cfg = Config::default();
        let old = [
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota",
                0,
                Some("b_1a"),
            ),
            para("kappa lambda mu", 1, Some("b_1b")),
            para(
                "one two three four five six seven eight nine",
                2,
                Some("b_2a"),
            ),
            para("ten eleven twelve", 3, Some("b_2b")),
        ];
        let neu = [
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
                0,
                None,
            ),
            para(
                "one two three four five six seven eight nine ten eleven twelve",
                1,
                None,
            ),
        ];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        phase6a_compound(&mut s);
        assert_eq!(s.matched_id("/0"), Some("b_1a"));
        assert_eq!(s.matched_id("/1"), Some("b_2a"));
        for (id, into) in [("b_1b", "b_1a"), ("b_2b", "b_2a")] {
            let d = s.dispositions.iter().find(|d| d.block_id == id).unwrap();
            assert_eq!(d.kind, DispositionKind::MergedInto);
            assert_eq!(d.detail["into"], DetailValue::Str(into.to_owned()));
        }
        assert_eq!(s.unmatched_new().len(), 0);
        assert_eq!(s.unmatched_old().len(), 0);
    }

    #[test]
    fn copy_of_a_matched_block_mints_with_lineage() {
        let cfg = Config::default();
        let dup = "shared reusable sentence that appears twice within this rather long document body spanning many tokens indeed here";
        let old = [para(dup, 0, Some("b_1"))];
        let neu = [para(dup, 0, None), para(&format!("{dup} today"), 1, None)];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        phase1_exact(&mut s);
        phase6a_compound(&mut s);
        let d = find_kind(&s, DispositionKind::CopiedFrom).expect("copied_from");
        assert_eq!(d.detail["counterpart"], DetailValue::Str("b_1".to_owned()));
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        assert!(s.is_new_used("/1"));
    }

    #[test]
    fn helpers() {
        assert_eq!(
            windows(4).collect::<Vec<_>>(),
            [(0, 4), (0, 3), (0, 2), (1, 4), (1, 3), (2, 4)]
        );
        assert_eq!(windows(1).count(), 0);
        assert_eq!(coverage("a b c d", "b c d e"), 0.5);
        assert_eq!(coverage("anything", ""), 0.0);
        assert_eq!(shared_token_fraction("a b", "a b c a", 4), 0.75);
    }
}
