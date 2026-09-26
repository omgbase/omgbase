//! Phases 1–4 (`spec/reconcile/README.md` §5) and the shared [`PhaseState`].
//! Phases run in order of strictly decreasing certainty; each sees only the
//! blocks unmatched by earlier phases. R2 (type equality) gates every carry.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::similarity::text_sim;
use crate::types::{Config, Detail, DetailValue, Disposition, DispositionKind, MatchBlock, Reason};

/// The id of an old block. Every old block carries one (§1.1).
pub(crate) fn old_id(b: &MatchBlock) -> &str {
    b.id.as_deref()
        .unwrap_or_else(|| panic!("old block {} carries no id", b.key))
}

/// The state the phases share while one document is reconciled.
pub struct PhaseState<'a> {
    pub old: &'a [MatchBlock],
    pub neu: &'a [MatchBlock],
    pub config: &'a Config,
    /// (new key, id) in the order the pairs were made.
    matched: Vec<(String, String)>,
    matched_by_key: HashMap<String, String>,
    used_old: HashSet<String>,
    used_new: HashSet<String>,
    /// Appended in decision order. Lineage mints (phase 6a) are recorded
    /// with a placeholder `block_id` until phase 7 mints their id.
    pub dispositions: Vec<Disposition>,
    /// Indices into `dispositions` of the lineage placeholders.
    pub(crate) lineage: Vec<usize>,
}

impl<'a> PhaseState<'a> {
    #[must_use]
    pub fn new(old: &'a [MatchBlock], neu: &'a [MatchBlock], config: &'a Config) -> Self {
        Self {
            old,
            neu,
            config,
            matched: Vec::new(),
            matched_by_key: HashMap::new(),
            used_old: HashSet::new(),
            used_new: HashSet::new(),
            dispositions: Vec::new(),
            lineage: Vec::new(),
        }
    }

    /// The pairs made so far as (new key, id), in the order made.
    #[must_use]
    pub fn matched(&self) -> &[(String, String)] {
        &self.matched
    }

    /// The id assigned to `new_key`, if any.
    #[must_use]
    pub fn matched_id(&self, new_key: &str) -> Option<&str> {
        self.matched_by_key.get(new_key).map(String::as_str)
    }

    #[must_use]
    pub fn matched_len(&self) -> usize {
        self.matched.len()
    }

    #[must_use]
    pub fn is_old_used(&self, id: &str) -> bool {
        self.used_old.contains(id)
    }

    #[must_use]
    pub fn is_new_used(&self, key: &str) -> bool {
        self.used_new.contains(key)
    }

    /// How many new blocks are matched or otherwise disposed.
    #[must_use]
    pub fn used_new_len(&self) -> usize {
        self.used_new.len()
    }

    /// The old blocks not yet paired, in document order.
    #[must_use]
    pub fn unmatched_old(&self) -> Vec<&'a MatchBlock> {
        self.old
            .iter()
            .filter(|b| !self.used_old.contains(old_id(b)))
            .collect()
    }

    /// The new blocks not yet paired, in document order.
    #[must_use]
    pub fn unmatched_new(&self) -> Vec<&'a MatchBlock> {
        self.neu
            .iter()
            .filter(|b| !self.used_new.contains(&b.key))
            .collect()
    }

    /// `assignment[n.key] = id`, mark the new block used.
    pub(crate) fn assign(&mut self, new_key: &str, id: &str) {
        self.matched.push((new_key.to_owned(), id.to_owned()));
        self.matched_by_key
            .insert(new_key.to_owned(), id.to_owned());
        self.used_new.insert(new_key.to_owned());
    }

    pub(crate) fn mark_old_used(&mut self, id: &str) {
        self.used_old.insert(id.to_owned());
    }

    pub(crate) fn mark_new_used(&mut self, key: &str) {
        self.used_new.insert(key.to_owned());
    }

    pub(crate) fn push(
        &mut self,
        block_id: &str,
        kind: DispositionKind,
        confidence: Option<f64>,
        reason: Option<Reason>,
        detail: Detail,
    ) {
        self.dispositions.push(Disposition {
            block_id: block_id.to_owned(),
            kind,
            confidence,
            reason,
            matcher_v: self.config.matcher_v.clone(),
            detail,
        });
    }

    /// `carry(o, n, kind, confidence, reason, detail)` (§5): record
    /// `assignment[n.key] = o.id`, mark both used, append a disposition with
    /// `o.id`.
    pub fn carry(
        &mut self,
        o: &MatchBlock,
        n: &MatchBlock,
        kind: DispositionKind,
        confidence: f64,
        reason: Reason,
        detail: Detail,
    ) {
        let id = old_id(o).to_owned();
        self.assign(&n.key, &id);
        self.used_old.insert(id.clone());
        self.push(&id, kind, Some(confidence), Some(reason), detail);
    }
}

/// Classify a carry (§2): `moved` compares positional keys; content equality
/// is byte identity (`raw_hash`), so a normalized-only match is `edited`.
#[must_use]
pub fn classify_kind(o: &MatchBlock, n: &MatchBlock) -> DispositionKind {
    let moved = o.parent_key != n.parent_key || o.index != n.index;
    let content_equal = o.raw_hash == n.raw_hash;
    match (content_equal, moved) {
        (true, false) => DispositionKind::Same,
        (true, true) => DispositionKind::Moved,
        (false, true) => DispositionKind::EditedMoved,
        (false, false) => DispositionKind::Edited,
    }
}

/// Groups in order of first appearance.
struct OrderedGroups<'a> {
    groups: Vec<(String, Vec<&'a MatchBlock>)>,
    index: HashMap<String, usize>,
}

impl<'a> OrderedGroups<'a> {
    fn new() -> Self {
        Self {
            groups: Vec::new(),
            index: HashMap::new(),
        }
    }

    fn push(&mut self, key: String, b: &'a MatchBlock) {
        match self.index.get(&key) {
            Some(&i) => self.groups[i].1.push(b),
            None => {
                self.index.insert(key.clone(), self.groups.len());
                self.groups.push((key, vec![b]));
            }
        }
    }

    fn get(&self, key: &str) -> Option<&[&'a MatchBlock]> {
        self.index.get(key).map(|&i| self.groups[i].1.as_slice())
    }

    fn iter(&self) -> impl Iterator<Item = (&str, &[&'a MatchBlock])> {
        self.groups.iter().map(|(k, v)| (k.as_str(), v.as_slice()))
    }
}

/// Phases 1 and 2: group both sides by `(type, hash)`; for each old group in
/// order of first appearance, a new group of the same key **and size** pairs
/// positionally. Groups of unequal size pair nothing.
fn lock_by_hash(
    state: &mut PhaseState<'_>,
    hash_of: fn(&MatchBlock) -> &str,
    confidence: f64,
    reason: Reason,
) {
    let key_of = |b: &MatchBlock| format!("{}\0{}", b.kind, hash_of(b));
    let mut old_groups = OrderedGroups::new();
    for b in state.unmatched_old() {
        old_groups.push(key_of(b), b);
    }
    let mut new_groups = OrderedGroups::new();
    for b in state.unmatched_new() {
        new_groups.push(key_of(b), b);
    }
    for (key, olds) in old_groups.iter() {
        let Some(news) = new_groups.get(key) else {
            continue;
        };
        if olds.len() == news.len() {
            for (o, n) in olds.iter().zip(news) {
                state.carry(o, n, classify_kind(o, n), confidence, reason, Detail::new());
            }
        }
    }
}

/// Phase 1 — exact lock (`exact_hash`, 1.0) over `(type, raw_hash)`.
pub fn phase1_exact(state: &mut PhaseState<'_>) {
    lock_by_hash(state, |b| &b.raw_hash, 1.0, Reason::ExactHash);
}

/// Phase 2 — normalized lock (`normalized_hash`, 0.99) over `(type, norm_hash)`.
pub fn phase2_normalized(state: &mut PhaseState<'_>) {
    lock_by_hash(state, |b| &b.norm_hash, 0.99, Reason::NormalizedHash);
}

/// Phase 3 — anchor lock (`anchor`, 0.99): for each anchor whose old and new
/// groups both have exactly one member of the same type, carry the pair. A
/// block already carried by an earlier anchor of this phase is skipped (§10
/// "phase 3 double carry": a group is stale once its member is used, R1).
pub fn phase3_anchor(state: &mut PhaseState<'_>) {
    let mut old_groups = OrderedGroups::new();
    for b in state.unmatched_old() {
        for a in &b.anchors {
            old_groups.push(a.clone(), b);
        }
    }
    let mut new_groups = OrderedGroups::new();
    for b in state.unmatched_new() {
        for a in &b.anchors {
            new_groups.push(a.clone(), b);
        }
    }
    for (anchor, olds) in old_groups.iter() {
        let Some(news) = new_groups.get(anchor) else {
            continue;
        };
        if olds.len() == 1 && news.len() == 1 && olds[0].kind == news[0].kind {
            let (o, n) = (olds[0], news[0]);
            if state.is_old_used(old_id(o)) || state.is_new_used(&n.key) {
                continue;
            }
            state.carry(
                o,
                n,
                classify_kind(o, n),
                0.99,
                Reason::Anchor,
                Detail::new(),
            );
        }
    }
}

/// The parent pairs of phase 4a: `(root, root)`, then `(o.key, n.key)` for
/// every pair in the assignment in the order made.
fn matched_parent_pairs(state: &PhaseState<'_>) -> Vec<(Option<String>, Option<String>)> {
    let old_by_id: HashMap<&str, &MatchBlock> = state.old.iter().map(|b| (old_id(b), b)).collect();
    let mut pairs = vec![(None, None)];
    for (new_key, id) in state.matched() {
        if let Some(o) = old_by_id.get(id.as_str()) {
            pairs.push((Some(o.key.clone()), Some(new_key.clone())));
        }
    }
    pairs
}

/// Phase 4a — context (`context_unique`, `0.75 + 0.2 × text_sim`). For each
/// parent pair `(P, Q)`: when exactly one unmatched old block has
/// `parent_key = P`, its candidates are the unmatched new blocks with
/// `parent_key = Q` and the same type; the strictly best `text_sim` at or
/// above `context_sim_floor` carries. A tie for best is no best.
pub fn phase4_context(state: &mut PhaseState<'_>) {
    for (old_parent, new_parent) in matched_parent_pairs(state) {
        let old_kids: Vec<&MatchBlock> = state
            .unmatched_old()
            .into_iter()
            .filter(|b| b.parent_key == old_parent)
            .collect();
        if old_kids.len() != 1 {
            continue;
        }
        let o = old_kids[0];
        let candidates: Vec<&MatchBlock> = state
            .unmatched_new()
            .into_iter()
            .filter(|n| n.parent_key == new_parent && n.kind == o.kind)
            .collect();
        if candidates.is_empty() {
            continue;
        }
        let mut best: Option<&MatchBlock> = None;
        let mut best_sim = -1.0;
        let mut tie = false;
        for n in candidates {
            let sim = text_sim(&o.text, &n.text);
            if sim > best_sim {
                best_sim = sim;
                best = Some(n);
                tie = false;
            } else if sim == best_sim {
                tie = true;
            }
        }
        if let Some(best) = best {
            if !tie && best_sim >= state.config.context_sim_floor {
                state.carry(
                    o,
                    best,
                    classify_kind(o, best),
                    0.75 + 0.2 * best_sim,
                    Reason::ContextUnique,
                    Detail::new(),
                );
            }
        }
    }
}

type Tally = BTreeMap<String, BTreeMap<String, usize>>;

fn bump(m: &mut Tally, a: &str, b: &str) {
    *m.entry(a.to_owned())
        .or_default()
        .entry(b.to_owned())
        .or_default() += 1;
}

/// The entry with the strictly greatest count, or `None` on a tie.
fn unique_max(counts: &BTreeMap<String, usize>) -> Option<(&str, usize)> {
    let mut best: Option<(&str, usize)> = None;
    let mut tie = false;
    for (key, &count) in counts {
        match best {
            Some((_, c)) if count == c => tie = true,
            Some((_, c)) if count < c => {}
            _ => {
                best = Some((key, count));
                tie = false;
            }
        }
    }
    if tie { None } else { best }
}

/// The containers' own parents must not contradict the pairing: both at
/// root; or *o*'s parent already carried to *n*'s parent; or both parents
/// still unmatched. One at root and one nested, or either parent matched
/// elsewhere, rejects.
fn parents_compatible(
    o: &MatchBlock,
    n: &MatchBlock,
    state: &PhaseState<'_>,
    old_by_key: &HashMap<&str, &MatchBlock>,
) -> bool {
    match (&o.parent_key, &n.parent_key) {
        (None, None) => true,
        (Some(op), Some(np)) => {
            let Some(old_parent) = old_by_key.get(op.as_str()) else {
                return false;
            };
            let pid = old_id(old_parent);
            if state.is_old_used(pid) {
                state.matched_id(np) == Some(pid)
            } else {
                !state.is_new_used(np)
            }
        }
        _ => false,
    }
}

/// Phase 4b — children vouch for their parent (`context_children`,
/// `0.75 + 0.2 × fraction`). Tallies where each old container's carried
/// children landed (computed once, at the start); an unmatched old
/// container whose children went, by a strict majority of at least
/// `children_vouch_frac` of all its children, to one unmatched new block of
/// the same type that they are in turn the unique source of, and whose
/// parents do not contradict the pairing, carries. Text is not consulted.
/// Returns whether any pair was made.
pub fn phase4b_children(state: &mut PhaseState<'_>) -> bool {
    let old = state.old;
    let old_by_key: HashMap<&str, &MatchBlock> = old.iter().map(|b| (b.key.as_str(), b)).collect();
    let new_by_key: HashMap<&str, &MatchBlock> =
        state.neu.iter().map(|b| (b.key.as_str(), b)).collect();
    let old_by_id: HashMap<&str, &MatchBlock> = old.iter().map(|b| (old_id(b), b)).collect();

    let mut child_total: HashMap<&str, usize> = HashMap::new();
    for b in old {
        if let Some(p) = &b.parent_key {
            *child_total.entry(p.as_str()).or_default() += 1;
        }
    }

    let mut landed = Tally::new();
    let mut sourced = Tally::new();
    for (new_key, id) in state.matched() {
        let (Some(o), Some(n)) = (old_by_id.get(id.as_str()), new_by_key.get(new_key.as_str()))
        else {
            continue;
        };
        let (Some(op), Some(np)) = (&o.parent_key, &n.parent_key) else {
            continue;
        };
        bump(&mut landed, op, np);
        bump(&mut sourced, np, op);
    }

    let mut paired = false;
    for o in old {
        if state.is_old_used(old_id(o)) {
            continue;
        }
        let Some(&total) = child_total.get(o.key.as_str()) else {
            continue;
        };
        let Some(dests) = landed.get(&o.key) else {
            continue;
        };
        let Some((dest, count)) = unique_max(dests) else {
            continue;
        };
        let fraction = count as f64 / total as f64;
        if fraction < state.config.children_vouch_frac {
            continue;
        }
        let Some(&n) = new_by_key.get(dest) else {
            continue;
        };
        if state.is_new_used(&n.key) || n.kind != o.kind {
            continue;
        }
        let Some(source) = sourced.get(&n.key).and_then(unique_max) else {
            continue;
        };
        if source.0 != o.key {
            continue;
        }
        if !parents_compatible(o, n, state, &old_by_key) {
            continue;
        }
        let mut detail = Detail::new();
        detail.insert(
            "children_carried".to_owned(),
            DetailValue::Int(count as i64),
        );
        detail.insert("children_total".to_owned(), DetailValue::Int(total as i64));
        state.carry(
            o,
            n,
            classify_kind(o, n),
            0.75 + 0.2 * fraction,
            Reason::ContextChildren,
            detail,
        );
        paired = true;
    }
    paired
}

/// Phase 4 to a fixed point: `{ 4a; 4b }` until a round adds no pair.
pub fn phase4_propagate(state: &mut PhaseState<'_>) {
    loop {
        let before = state.matched_len();
        phase4_context(state);
        phase4b_children(state);
        if state.matched_len() == before {
            return;
        }
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use omgbase_format::BlockKind;
    use omgbase_format::hash::{hex, norm_hash, raw_hash};
    use omgbase_format::text::normalize_visible_text;

    use crate::types::MatchBlock;

    /// A top-level match block from raw text (the reference tests' `mb`).
    pub fn mb(
        raw: &str,
        index: usize,
        id: Option<&str>,
        kind: &str,
        anchors: &[&str],
    ) -> MatchBlock {
        mb_under(raw, index, id, kind, anchors, None)
    }

    pub fn mb_under(
        raw: &str,
        index: usize,
        id: Option<&str>,
        kind: &str,
        anchors: &[&str],
        parent_key: Option<&str>,
    ) -> MatchBlock {
        let k: BlockKind = kind.parse().expect("kind");
        let text = normalize_visible_text(raw, k, 0);
        MatchBlock {
            id: id.map(str::to_owned),
            kind: kind.to_owned(),
            raw_hash: hex(&raw_hash(raw)),
            norm_hash: hex(&norm_hash(&text)),
            text,
            anchors: anchors.iter().map(|a| (*a).to_owned()).collect(),
            parent_key: parent_key.map(str::to_owned),
            index,
            key: MatchBlock::positional_key(parent_key, index),
        }
    }

    pub fn para(raw: &str, index: usize, id: Option<&str>) -> MatchBlock {
        mb(raw, index, id, "paragraph", &[])
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::{mb, para};
    use super::*;

    fn state<'a>(
        old: &'a [MatchBlock],
        neu: &'a [MatchBlock],
        config: &'a Config,
    ) -> PhaseState<'a> {
        PhaseState::new(old, neu, config)
    }

    fn find<'a>(s: &'a PhaseState<'_>, id: &str) -> &'a Disposition {
        s.dispositions
            .iter()
            .find(|d| d.block_id == id)
            .expect("disposition")
    }

    #[test]
    fn phase1_carries_identical_blocks_with_confidence_1() {
        let cfg = Config::default();
        let old = [
            para("Hello world.", 0, Some("b_1")),
            para("Second.", 1, Some("b_2")),
        ];
        let neu = [para("Hello world.", 0, None), para("Second.", 1, None)];
        let mut s = state(&old, &neu, &cfg);
        phase1_exact(&mut s);
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        assert_eq!(s.matched_id("/1"), Some("b_2"));
        assert!(s.dispositions.iter().all(|d| {
            d.reason == Some(Reason::ExactHash)
                && d.confidence == Some(1.0)
                && d.kind == DispositionKind::Same
                && d.matcher_v == "m2.0"
        }));
    }

    #[test]
    fn phase1_does_not_carry_across_a_type_change() {
        let cfg = Config::default();
        let old = [mb("Text", 0, Some("b_1"), "paragraph", &[])];
        let neu = [mb("Text", 0, None, "heading", &[])];
        let mut s = state(&old, &neu, &cfg);
        phase1_exact(&mut s);
        assert_eq!(s.matched_len(), 0);
    }

    #[test]
    fn phase1_marks_a_moved_block() {
        let cfg = Config::default();
        let old = [para("A", 0, Some("b_1")), para("B", 1, Some("b_2"))];
        let neu = [para("B", 0, None), para("A", 1, None)];
        let mut s = state(&old, &neu, &cfg);
        phase1_exact(&mut s);
        assert_eq!(find(&s, "b_1").kind, DispositionKind::Moved);
        assert_eq!(find(&s, "b_2").kind, DispositionKind::Moved);
    }

    #[test]
    fn phase1_groups_of_unequal_size_pair_nothing() {
        let cfg = Config::default();
        let old = [para("dup", 0, Some("b_1")), para("dup", 1, Some("b_2"))];
        let neu = [para("dup", 0, None)];
        let mut s = state(&old, &neu, &cfg);
        phase1_exact(&mut s);
        assert_eq!(s.matched_len(), 0);
        // Equal-size groups pair positionally.
        let neu2 = [
            para("x", 0, None),
            para("dup", 1, None),
            para("dup", 2, None),
        ];
        let mut s = state(&old, &neu2, &cfg);
        phase1_exact(&mut s);
        assert_eq!(s.matched_id("/1"), Some("b_1"));
        assert_eq!(s.matched_id("/2"), Some("b_2"));
    }

    #[test]
    fn phase2_normalized_lock_is_edited_at_0_99() {
        let cfg = Config::default();
        let old = [para("Hello   world.", 0, Some("b_1"))];
        let neu = [para("Hello world.", 0, None)];
        let mut s = state(&old, &neu, &cfg);
        phase2_normalized(&mut s);
        let d = &s.dispositions[0];
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        assert_eq!(d.reason, Some(Reason::NormalizedHash));
        assert_eq!(d.confidence, Some(0.99));
        assert_eq!(d.kind, DispositionKind::Edited);
    }

    #[test]
    fn phase3_pairs_a_unique_anchor_despite_text_change() {
        let cfg = Config::default();
        let old = [mb(
            "Old text about risks",
            0,
            Some("b_1"),
            "paragraph",
            &["^risk-1"],
        )];
        let neu = [mb(
            "Completely rewritten risk statement",
            0,
            None,
            "paragraph",
            &["^risk-1"],
        )];
        let mut s = state(&old, &neu, &cfg);
        phase3_anchor(&mut s);
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        assert_eq!(s.dispositions[0].reason, Some(Reason::Anchor));
        assert_eq!(s.dispositions[0].confidence, Some(0.99));
    }

    #[test]
    fn phase3_carries_a_two_anchor_block_once() {
        let cfg = Config::default();
        let old = [mb(
            "Shared block with two anchors",
            0,
            Some("b_1"),
            "paragraph",
            &["^a", "^b"],
        )];
        let neu = [
            mb("First rewrite", 0, None, "paragraph", &["^a"]),
            mb("Second rewrite", 1, None, "paragraph", &["^b"]),
        ];
        let mut s = state(&old, &neu, &cfg);
        phase3_anchor(&mut s);
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        assert_eq!(s.matched_id("/1"), None);
        assert_eq!(s.dispositions.len(), 1);
        assert!(s.is_old_used("b_1"));
        // Mirror image: a new block with two anchors takes only the first.
        let old2 = [
            mb("First", 0, Some("b_1"), "paragraph", &["^a"]),
            mb("Second", 1, Some("b_2"), "paragraph", &["^b"]),
        ];
        let neu2 = [mb("Merged", 0, None, "paragraph", &["^a", "^b"])];
        let mut s = state(&old2, &neu2, &cfg);
        phase3_anchor(&mut s);
        assert_eq!(s.matched_id("/0"), Some("b_1"));
        assert_eq!(s.dispositions.len(), 1);
    }

    #[test]
    fn phase3_requires_same_type_and_unique_groups() {
        let cfg = Config::default();
        let old = [mb("x", 0, Some("b_1"), "paragraph", &["^a"])];
        let neu = [mb("x", 0, None, "heading", &["^a"])];
        let mut s = state(&old, &neu, &cfg);
        phase3_anchor(&mut s);
        assert_eq!(s.matched_len(), 0);
        let neu2 = [
            mb("x", 0, None, "paragraph", &["^a"]),
            mb("y", 1, None, "paragraph", &["^a"]),
        ];
        let mut s = state(&old, &neu2, &cfg);
        phase3_anchor(&mut s);
        assert_eq!(s.matched_len(), 0);
    }

    #[test]
    fn phase4_pairs_the_lone_unmatched_child() {
        let cfg = Config::default();
        let old = [
            mb("Heading", 0, Some("b_1"), "heading", &[]),
            para("Stable block identity is difficult.", 1, Some("b_2")),
            para("Tail.", 2, Some("b_3")),
        ];
        let neu = [
            mb("Heading", 0, None, "heading", &[]),
            para("Stable block identity is quite difficult.", 1, None),
            para("Tail.", 2, None),
        ];
        let mut s = state(&old, &neu, &cfg);
        phase1_exact(&mut s);
        assert_eq!(s.matched_id("/1"), None);
        phase4_context(&mut s);
        assert_eq!(s.matched_id("/1"), Some("b_2"));
        let d = find(&s, "b_2");
        assert_eq!(d.reason, Some(Reason::ContextUnique));
        assert_eq!(d.kind, DispositionKind::Edited);
        assert_eq!(d.confidence, Some(0.75 + 0.2 * (4.0 / 7.0)));
    }

    #[test]
    fn phase4_respects_the_floor_and_ties() {
        let cfg = Config::default();
        let old = [
            mb("Heading", 0, Some("b_1"), "heading", &[]),
            para("apple banana cherry date", 1, Some("b_2")),
            para("Tail.", 2, Some("b_3")),
        ];
        let neu = [
            mb("Heading", 0, None, "heading", &[]),
            para("xylophone quartz nebula fjord", 1, None),
            para("Tail.", 2, None),
        ];
        let mut s = state(&old, &neu, &cfg);
        phase1_exact(&mut s);
        phase4_context(&mut s);
        assert_eq!(s.matched_id("/1"), None);

        // Two candidates tie exactly: no best (R4).
        let old = [para("alpha beta gamma delta", 0, Some("b_1"))];
        let neu = [
            para("alpha beta gamma X", 0, None),
            para("alpha beta gamma Y", 1, None),
        ];
        let mut s = state(&old, &neu, &cfg);
        phase4_context(&mut s);
        assert_eq!(s.matched_len(), 0);
    }

    #[test]
    fn unique_max_detects_ties_in_any_order() {
        let counts = |v: &[(&str, usize)]| -> BTreeMap<String, usize> {
            v.iter().map(|(k, n)| ((*k).to_owned(), *n)).collect()
        };
        assert_eq!(unique_max(&counts(&[("a", 2), ("b", 3), ("c", 3)])), None);
        assert_eq!(unique_max(&counts(&[("a", 3), ("b", 3), ("c", 2)])), None);
        assert_eq!(unique_max(&counts(&[("a", 3), ("b", 2), ("c", 3)])), None);
        assert_eq!(
            unique_max(&counts(&[("a", 1), ("b", 3), ("c", 2)])),
            Some(("b", 3))
        );
        assert_eq!(unique_max(&counts(&[])), None);
    }
}
