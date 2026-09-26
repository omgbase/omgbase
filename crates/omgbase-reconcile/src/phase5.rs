//! Phase 5 — scored assignment (`spec/reconcile/README.md` §5). For the
//! remaining same-type candidates: prune by token-count ratio and shingle
//! overlap, score, then greedily accept the highest-scoring pairs subject to
//! R3 (accepted same-parent pairs do not cross in sibling order).

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::phases::{PhaseState, old_id};
use crate::similarity::{Shingles, dice, shingles, token_count};
use crate::types::{Detail, DetailValue, DispositionKind, MatchBlock, Reason};

struct Candidate<'a> {
    old: &'a MatchBlock,
    neu: &'a MatchBlock,
    score: f64,
}

fn sibling_at<'a>(
    blocks: &'a [MatchBlock],
    parent_key: Option<&str>,
    index: Option<usize>,
) -> Option<&'a MatchBlock> {
    let index = index?;
    blocks
        .iter()
        .find(|b| b.parent_key.as_deref() == parent_key && b.index == index)
}

fn offset(index: usize, delta: i8) -> Option<usize> {
    if delta < 0 {
        index.checked_sub(1)
    } else {
        index.checked_add(1)
    }
}

/// Over `d ∈ {−1, +1}`: count 1 toward the total when either side has a
/// sibling at `index + d`, and 1 toward matched when both exist and the new
/// sibling is assigned the old sibling's id. `matched / total`, or 0.
fn neighbor_context(o: &MatchBlock, n: &MatchBlock, state: &PhaseState<'_>) -> f64 {
    let mut matched = 0usize;
    let mut total = 0usize;
    for delta in [-1i8, 1] {
        let old_sib = sibling_at(state.old, o.parent_key.as_deref(), offset(o.index, delta));
        let new_sib = sibling_at(state.neu, n.parent_key.as_deref(), offset(n.index, delta));
        if old_sib.is_some() || new_sib.is_some() {
            total += 1;
            if let (Some(os), Some(ns)) = (old_sib, new_sib) {
                if state.matched_id(&ns.key) == Some(old_id(os)) {
                    matched += 1;
                }
            }
        }
    }
    if total == 0 {
        0.0
    } else {
        matched as f64 / total as f64
    }
}

/// 1 when both at root, or o's parent is carried to n's parent.
fn parents_matched(o: &MatchBlock, n: &MatchBlock, state: &PhaseState<'_>) -> bool {
    match (&o.parent_key, &n.parent_key) {
        (None, None) => true,
        (Some(op), Some(np)) => {
            let Some(old_parent) = state.old.iter().find(|b| &b.key == op) else {
                return false;
            };
            state.matched_id(np) == Some(old_id(old_parent))
        }
        _ => false,
    }
}

fn shared_anchor_evidence(o: &MatchBlock, n: &MatchBlock) -> f64 {
    if !o.anchors.is_empty() && n.anchors.iter().any(|a| o.anchors.contains(a)) {
        1.0
    } else {
        0.0
    }
}

/// The number of blocks under each `parent_key` of one tree (`None` for the
/// root), computed once per tree for `position_prior`.
type SiblingCounts<'a> = HashMap<Option<&'a str>, usize>;

fn sibling_counts(blocks: &[MatchBlock]) -> SiblingCounts<'_> {
    let mut counts = SiblingCounts::new();
    for b in blocks {
        *counts.entry(b.parent_key.as_deref()).or_insert(0) += 1;
    }
    counts
}

/// `rel(b) = b.index / (siblings − 1)` with `siblings` the number of blocks in
/// b's tree sharing b's `parent_key` (b included); 0 when `siblings ≤ 1`.
fn relative_position(b: &MatchBlock, siblings: &SiblingCounts<'_>) -> f64 {
    let count = siblings.get(&b.parent_key.as_deref()).copied().unwrap_or(1);
    if count > 1 {
        b.index as f64 / (count - 1) as f64
    } else {
        0.0
    }
}

/// `score(o, n) = 0.55 text_sim + 0.15 neighbor_ctx + 0.10 parent_match
/// + 0.10 position_prior + 0.10 anchor_evidence`, summed left to right.
fn score_pair(
    o: &MatchBlock,
    n: &MatchBlock,
    state: &PhaseState<'_>,
    old_siblings: &SiblingCounts<'_>,
    new_siblings: &SiblingCounts<'_>,
) -> f64 {
    let text_sim_val = dice(&shingles(&o.text), &shingles(&n.text));
    let neighbor_ctx = neighbor_context(o, n, state);
    let parent_match = if parents_matched(o, n, state) {
        1.0
    } else {
        0.0
    };
    let position_prior =
        1.0 - (relative_position(o, old_siblings) - relative_position(n, new_siblings)).abs();
    let anchor_evidence = shared_anchor_evidence(o, n);
    0.55 * text_sim_val
        + 0.15 * neighbor_ctx
        + 0.1 * parent_match
        + 0.1 * position_prior
        + 0.1 * anchor_evidence
}

fn desc(a: f64, b: f64) -> Ordering {
    b.partial_cmp(&a).unwrap_or(Ordering::Equal)
}

/// Candidates per new block: same type, token-count ratio ≤ 3, a shared
/// shingle unless either side has none; sorted by shingle Dice descending
/// (stable) and capped at 12.
fn prune_candidates<'a>(olds: &[&'a MatchBlock], news: &[&'a MatchBlock]) -> Vec<Candidate<'a>> {
    let old_shingles: Vec<Shingles> = olds.iter().map(|o| shingles(&o.text)).collect();
    let mut candidates = Vec::new();
    for n in news {
        let ns = shingles(&n.text);
        let n_count = token_count(&n.text);
        let mut per_block: Vec<(usize, Candidate<'a>)> = Vec::new();
        for (oi, o) in olds.iter().enumerate() {
            if o.kind != n.kind {
                continue;
            }
            let o_count = token_count(&o.text);
            let ratio = o_count.max(n_count) as f64 / o_count.min(n_count).max(1) as f64;
            if ratio > 3.0 {
                continue;
            }
            let os = &old_shingles[oi];
            let shares = ns.iter().any(|s| os.contains(s));
            if !shares && !ns.is_empty() && !os.is_empty() {
                continue;
            }
            per_block.push((
                oi,
                Candidate {
                    old: o,
                    neu: n,
                    score: 0.0,
                },
            ));
        }
        per_block
            .sort_by(|a, b| desc(dice(&old_shingles[a.0], &ns), dice(&old_shingles[b.0], &ns)));
        candidates.extend(per_block.into_iter().take(12).map(|(_, c)| c));
    }
    candidates
}

/// `round(score × 1000) / 1000`, half away from zero (scores are never
/// negative, so this equals the reference's `Math.round`).
fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Phase 5. Skips when either side has no unmatched blocks or the unmatched
/// total exceeds `2 × max_scored_blocks`. Candidates are sorted by score
/// descending, then old key, then new key (bytewise); the walk skips a
/// candidate below *its* threshold and continues (a tiny block's higher
/// `theta_small` must not end the walk for the regular candidates sorted
/// below it — §10, m2.1). Accepted pairs are `edited` or `edited_moved` with
/// the score as confidence and the near misses (within 0.1 below the
/// threshold) in `detail.near_misses`.
pub fn phase5_scored(state: &mut PhaseState<'_>) {
    let olds = state.unmatched_old();
    let news = state.unmatched_new();
    if olds.is_empty() || news.is_empty() {
        return;
    }
    if olds.len() + news.len() > state.config.max_scored_blocks * 2 {
        return;
    }
    let old_siblings = sibling_counts(state.old);
    let new_siblings = sibling_counts(state.neu);

    let mut candidates = prune_candidates(&olds, &news);
    for c in &mut candidates {
        c.score = score_pair(c.old, c.neu, state, &old_siblings, &new_siblings);
    }
    candidates.sort_by(|a, b| {
        desc(a.score, b.score)
            .then_with(|| a.old.key.as_bytes().cmp(b.old.key.as_bytes()))
            .then_with(|| a.neu.key.as_bytes().cmp(b.neu.key.as_bytes()))
    });

    // Accepted (old index, new index) per new parent, for the R3 check.
    let mut accepted_by_parent: HashMap<Option<String>, Vec<(usize, usize)>> = HashMap::new();

    for i in 0..candidates.len() {
        let c = &candidates[i];
        if state.is_old_used(old_id(c.old)) || state.is_new_used(&c.neu.key) {
            continue;
        }
        let threshold = if token_count(&c.neu.text) < state.config.small_block_tokens {
            state.config.theta_small
        } else {
            state.config.theta_accept
        };
        if c.score < threshold {
            continue; // a tiny block's theta_small must not end the walk (§10, m2.1)
        }

        if c.old.parent_key == c.neu.parent_key {
            let crosses = accepted_by_parent
                .get(&c.neu.parent_key)
                .is_some_and(|list| {
                    list.iter().any(|&(oi, ni)| {
                        (oi as i64 - c.old.index as i64) * (ni as i64 - c.neu.index as i64) < 0
                    })
                });
            if crosses {
                continue;
            }
        }

        let near_misses: Vec<DetailValue> = candidates
            .iter()
            .filter(|o| {
                o.neu.key == c.neu.key
                    && o.old.id != c.old.id
                    && o.score < threshold
                    && o.score >= threshold - 0.1
            })
            .map(|o| {
                let mut m = Detail::new();
                m.insert(
                    "blockId".to_owned(),
                    DetailValue::Str(old_id(o.old).to_owned()),
                );
                m.insert("score".to_owned(), DetailValue::Num(round3(o.score)));
                DetailValue::Map(m)
            })
            .collect();

        let moved = c.old.parent_key != c.neu.parent_key || c.old.index != c.neu.index;
        let kind = if moved {
            DispositionKind::EditedMoved
        } else {
            DispositionKind::Edited
        };
        let mut detail = Detail::new();
        if !near_misses.is_empty() {
            detail.insert("near_misses".to_owned(), DetailValue::List(near_misses));
        }
        let (o, n, score) = (c.old, c.neu, c.score);
        state.carry(o, n, kind, score, Reason::Scored, detail);
        accepted_by_parent
            .entry(n.parent_key.clone())
            .or_default()
            .push((o.index, n.index));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phases::testutil::{mb, mb_under, para};
    use crate::phases::{phase1_exact, phase2_normalized, phase3_anchor, phase4_context};
    use crate::types::Config;

    fn run_all(s: &mut PhaseState<'_>) {
        phase1_exact(s);
        phase2_normalized(s);
        phase3_anchor(s);
        phase4_context(s);
        phase5_scored(s);
    }

    #[test]
    fn carries_two_edited_paragraphs_by_score() {
        let cfg = Config::default();
        let old = [
            para(
                "the quick brown fox jumps over the lazy dog every single morning here now while birds sing softly above the field",
                0,
                Some("b_1"),
            ),
            para(
                "a separate second paragraph discussing entirely different subject matter today with many words to raise the shingle overlap count high",
                1,
                Some("b_2"),
            ),
        ];
        let neu = [
            para(
                "the quick brown fox jumps over the lazy dog every single evening here now while birds sing softly above the field",
                0,
                None,
            ),
            para(
                "a separate second paragraph discussing entirely different subject matter tomorrow with many words to raise the shingle overlap count high",
                1,
                None,
            ),
        ];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        run_all(&mut s);
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        assert_eq!(s.matched_id("/1"), Some("b_2"));
        let d = s.dispositions.iter().find(|d| d.block_id == "b_1").unwrap();
        assert_eq!(d.reason, Some(Reason::Scored));
        assert_eq!(d.kind, DispositionKind::Edited);
        assert_eq!(d.confidence, Some(d.confidence.unwrap()));
        assert!(d.confidence.unwrap() >= cfg.theta_accept);
    }

    #[test]
    fn theta_small_makes_tiny_blocks_harder() {
        let cfg = Config::default();
        let old = [para("cat dog", 0, Some("b_1"))];
        let neu = [para("cat fish", 0, None)];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        run_all(&mut s);
        assert_eq!(s.matched_id("/0"), None);
    }

    #[test]
    fn score_terms_are_summed_in_spec_order() {
        // All five terms at 1 give exactly the left-to-right double sum.
        let cfg = Config::default();
        let old = [mb(
            "alpha beta gamma delta epsilon zeta eta theta iota",
            0,
            Some("b_1"),
            "paragraph",
            &["^a"],
        )];
        let neu = [mb(
            "alpha beta gamma delta epsilon zeta eta theta iota",
            0,
            None,
            "paragraph",
            &["^a"],
        )];
        let s = PhaseState::new(&old, &neu, &cfg);
        let score = score_pair(
            &old[0],
            &neu[0],
            &s,
            &sibling_counts(&old),
            &sibling_counts(&neu),
        );
        // neighbor_ctx is 0 (no siblings on either side), the rest are 1.
        assert_eq!(score, 0.55 + 0.15 * 0.0 + 0.1 + 0.1 + 0.1);
        assert_eq!(round3(0.6785), 0.679);
        assert_eq!(round3(0.5), 0.5);
    }

    #[test]
    fn r3_rejects_crossing_pairs_under_one_parent() {
        // Two old siblings swap places with edits so nothing locks. With the
        // thresholds lowered both pairs qualify; they tie on score, the old
        // key breaks the tie, the first is accepted and the second crosses it.
        let cfg = Config {
            theta_accept: 0.3,
            theta_small: 0.3,
            ..Config::default()
        };
        let a_old = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
        let b_old = "one two three four five six seven eight nine ten";
        let old = [para(a_old, 0, Some("b_a")), para(b_old, 1, Some("b_b"))];
        let neu = [
            para(
                "one two three four five six seven eight nine ELEVEN",
                0,
                None,
            ),
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota LAMBDA",
                1,
                None,
            ),
        ];
        let mut s = PhaseState::new(&old, &neu, &cfg);
        phase5_scored(&mut s);
        let carried: Vec<&str> = s.matched().iter().map(|(_, id)| id.as_str()).collect();
        assert_eq!(carried, ["b_a"]);
        assert_eq!(s.matched_id("/1"), Some("b_a"));
        assert_eq!(s.dispositions[0].kind, DispositionKind::EditedMoved);
        // Without the crossing (same order) both carry.
        let neu2 = [
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota LAMBDA",
                0,
                None,
            ),
            para(
                "one two three four five six seven eight nine ELEVEN",
                1,
                None,
            ),
        ];
        let mut s = PhaseState::new(&old, &neu2, &cfg);
        phase5_scored(&mut s);
        assert_eq!(s.matched_len(), 2);
    }

    #[test]
    fn small_block_does_not_stop_the_walk() {
        // Phase 5 alone (no lock phases): the tiny pair's identical text
        // scores 0.55 + 0.1 (parent) + 0.1 (position) = 0.75, under
        // theta_small held at its pre-m2.2 value 0.80 (so the skip is
        // exercised) yet sorted above the regular pair at 0.695 (dice 0.9),
        // which clears theta_accept (0.62). m2.0 ended the walk at the tiny
        // candidate; m2.1 skips it and carries the regular one.
        let cfg = Config {
            theta_small: 0.8,
            ..Config::default()
        };
        let tiny = "one two three four five six seven";
        let old = [
            para(tiny, 0, Some("b_tiny")),
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
                1,
                Some("b_long"),
            ),
        ];
        let neu = [
            para(tiny, 0, None),
            para(
                "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda nu",
                1,
                None,
            ),
        ];
        assert!(token_count(tiny) < cfg.small_block_tokens);
        let mut s = PhaseState::new(&old, &neu, &cfg);
        phase5_scored(&mut s);
        assert_eq!(s.matched_id("/0"), None, "tiny pair is under theta_small");
        assert_eq!(s.matched_id("/1"), Some("b_long"));
        let d = &s.dispositions[0];
        assert_eq!(d.kind, DispositionKind::Edited);
        assert!(d.confidence.unwrap() < cfg.theta_small);
        assert!(d.confidence.unwrap() >= cfg.theta_accept);
    }

    #[test]
    fn position_prior_nested() {
        // rel(b) is over the sibling count, not the flattened list size: a
        // lone root list has rel 0 and its third of three items has rel 1.
        let cfg = Config::default();
        let item = "same item text in every slot";
        let tree = |ids: bool| -> Vec<MatchBlock> {
            let mut v = vec![mb("- a\n- b\n- c", 0, ids.then_some("b_list"), "list", &[])];
            for i in 0..3 {
                let owned = format!("b_{i}");
                v.push(mb_under(
                    item,
                    i,
                    ids.then_some(owned.as_str()),
                    "list_item",
                    &[],
                    Some("/0"),
                ));
            }
            v
        };
        let old = tree(true);
        let neu = tree(false);
        let counts = sibling_counts(&old);
        assert_eq!(counts[&None], 1);
        assert_eq!(counts[&Some("/0")], 3);
        assert_eq!(relative_position(&old[0], &counts), 0.0);
        assert_eq!(relative_position(&old[1], &counts), 0.0);
        assert_eq!(relative_position(&old[2], &counts), 0.5);
        assert_eq!(relative_position(&old[3], &counts), 1.0);

        // Identical texts, unmatched parents, unmatched neighbours: the score
        // differs between the two pairs only in position_prior (1 vs 0). The
        // m2.0 rule (index over |list| − 1 = 3) gave 1 − |0 − 2/3| = 1/3.
        let s = PhaseState::new(&old, &neu, &cfg);
        let new_counts = sibling_counts(&neu);
        let aligned = score_pair(&old[3], &neu[3], &s, &counts, &new_counts);
        let shifted = score_pair(&old[1], &neu[3], &s, &counts, &new_counts);
        assert_eq!(
            aligned,
            0.55 + 0.15 * 0.0 + 0.1 * 0.0 + 0.1 * 1.0 + 0.1 * 0.0
        );
        assert_eq!(
            shifted,
            0.55 + 0.15 * 0.0 + 0.1 * 0.0 + 0.1 * 0.0 + 0.1 * 0.0
        );
    }

    #[test]
    fn deterministic_hard_rules_over_a_small_grid() {
        // A deterministic stand-in for the reference's fast-check property:
        // R1 (id used once), R2 (type gate), R3 (no crossing among
        // non-moved same-parent carries).
        let cfg = Config::default();
        let words = ["ab", "cd", "ef", "gh", "ij", "kl", "mn", "op"];
        let kinds = ["paragraph", "heading", "code_fence"];
        let mut seed = 12345u64;
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        for _ in 0..300 {
            let generate = |next: &mut dyn FnMut() -> usize, with_ids: bool| -> Vec<MatchBlock> {
                let n = 1 + next() % 8;
                (0..n)
                    .map(|i| {
                        let len = 1 + next() % 7;
                        let text: Vec<&str> =
                            (0..len).map(|_| words[next() % words.len()]).collect();
                        let id = format!("b_o{i}");
                        mb(
                            &text.join(" "),
                            i,
                            with_ids.then_some(id.as_str()),
                            kinds[next() % 3],
                            &[],
                        )
                    })
                    .collect()
            };
            let old = generate(&mut next, true);
            let neu = generate(&mut next, false);
            let mut s = PhaseState::new(&old, &neu, &cfg);
            run_all(&mut s);
            let ids: Vec<&str> = s.matched().iter().map(|(_, id)| id.as_str()).collect();
            let unique: std::collections::HashSet<&&str> = ids.iter().collect();
            assert_eq!(unique.len(), ids.len(), "R1");
            let mut pairs: Vec<(usize, usize)> = Vec::new();
            for (new_key, id) in s.matched() {
                let o = old.iter().find(|b| b.id.as_deref() == Some(id)).unwrap();
                let n = neu.iter().find(|b| &b.key == new_key).unwrap();
                assert_eq!(o.kind, n.kind, "R2");
                let d = s.dispositions.iter().find(|d| &d.block_id == id).unwrap();
                if d.kind != DispositionKind::Moved && d.kind != DispositionKind::EditedMoved {
                    pairs.push((o.index, n.index));
                }
            }
            pairs.sort_unstable();
            for w in pairs.windows(2) {
                assert!(w[1].1 >= w[0].1, "R3");
            }
        }
    }
}
