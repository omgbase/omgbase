//! Lowering (`spec/mutate/README.md` §7.1): the matcher's assignment over a
//! proposed body becomes kernel ops at top-level granularity — removes,
//! content updates with `child_ids`, LCS placement, retile — and the
//! guaranteed full-replace fallback.

use std::collections::{BTreeMap, HashMap, HashSet};

use omgbase_format::Block;
use omgbase_reconcile::json::detail_to_json;
use omgbase_reconcile::{Disposition, DispositionKind};
use serde_json::Value;

use crate::changeset::Op;
use crate::ops::{At, Expect, Parent, To};
use crate::opset::{PlanDisposition, PlanOp};
use crate::tree::{MutBlock, MutDoc, raw_hash_hex};

/// What a lowering produces: the plan ops and the counts the summary needs.
#[derive(Clone, Debug, PartialEq)]
pub struct LowerResult {
    pub ops: Vec<PlanOp>,
    pub preserved: usize,
    pub ambiguous: usize,
}

struct TargetBlock {
    id: String,
    raw: String,
    trivia: String,
    children: Vec<TargetBlock>,
    /// The id existed anywhere in the old tree.
    carried: bool,
}

fn build_target(
    blocks: &[Block],
    assignment: &BTreeMap<String, String>,
    old_ids: &HashSet<String>,
    parent_key: Option<&str>,
) -> Vec<TargetBlock> {
    blocks
        .iter()
        .enumerate()
        .map(|(index, b)| {
            let key = format!("{}/{index}", parent_key.unwrap_or(""));
            let id = assignment.get(&key).cloned().unwrap_or_else(|| key.clone());
            TargetBlock {
                carried: old_ids.contains(&id),
                raw: b.raw.clone(),
                trivia: b.trivia.clone(),
                children: build_target(&b.children, assignment, old_ids, Some(&key)),
                id,
            }
        })
        .collect()
}

fn collect_target_ids(list: &[TargetBlock], out: &mut HashSet<String>) {
    for b in list {
        out.insert(b.id.clone());
        collect_target_ids(&b.children, out);
    }
}

/// §7.1 step 3: the longest common subsequence of two id lists (standard DP;
/// ties prefer advancing the old side), as the set of kept ids.
#[must_use]
pub fn lcs(a: &[String], b: &[String]) -> HashSet<String> {
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut keep = HashSet::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            keep.insert(a[i].clone());
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    keep
}

struct Meta {
    confidence: Option<f64>,
    reason: Option<String>,
    detail: Option<Value>,
}

fn meta_of(disp: Option<&Disposition>) -> Meta {
    match disp {
        Some(d) => Meta {
            confidence: d.confidence,
            reason: d.reason.map(|r| r.as_str().to_owned()),
            detail: Some(detail_to_json(&d.detail)),
        },
        None => Meta {
            confidence: None,
            reason: None,
            detail: None,
        },
    }
}

/// §7.1 step 2: positional-key → id for a container's carried descendants.
fn carried_child_id_map(
    container: &TargetBlock,
    old_ids: &HashSet<String>,
) -> BTreeMap<String, String> {
    fn walk(
        children: &[TargetBlock],
        parent_key: &str,
        old_ids: &HashSet<String>,
        out: &mut BTreeMap<String, String>,
    ) {
        for (i, c) in children.iter().enumerate() {
            let key = format!("{parent_key}/{i}");
            if old_ids.contains(&c.id) {
                out.insert(key.clone(), c.id.clone());
            }
            if !c.children.is_empty() {
                walk(&c.children, &key, old_ids, out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(&container.children, "", old_ids, &mut out);
    out
}

fn disposition_for_new(kind: Option<DispositionKind>) -> PlanDisposition {
    match kind {
        Some(DispositionKind::CopiedFrom) => PlanDisposition::CopiedFrom,
        Some(DispositionKind::Resurrected) => PlanDisposition::Resurrected,
        Some(DispositionKind::SplitFrom) => PlanDisposition::SplitFrom,
        _ => PlanDisposition::Inserted,
    }
}

fn top_level_to(anchor: Option<&str>) -> To {
    To {
        parent: Parent::Doc,
        at: match anchor {
            None => At::Start,
            Some(id) => At::After(id.to_owned()),
        },
    }
}

/// §7.1: lower a reconciled whole-document update to kernel ops at top-level
/// granularity.
#[must_use]
pub fn lower_top_level(
    old_doc: &MutDoc,
    rest: &[Block],
    assignment: &BTreeMap<String, String>,
    dispositions: &[Disposition],
) -> LowerResult {
    let doc_id = &old_doc.doc_id;
    let old_ids: HashSet<String> = old_doc.all_ids().into_iter().collect();
    let target = build_target(rest, assignment, &old_ids, None);
    let mut target_id_set = HashSet::new();
    collect_target_ids(&target, &mut target_id_set);
    let disp_by: HashMap<&str, &Disposition> = dispositions
        .iter()
        .map(|d| (d.block_id.as_str(), d))
        .collect();
    let old_by_id: HashMap<&str, &MutBlock> = old_doc.iter().map(|b| (b.id.as_str(), b)).collect();
    let old_top_ids: Vec<String> = old_doc.children.iter().map(|b| b.id.clone()).collect();
    let old_top_set: HashSet<&str> = old_top_ids.iter().map(String::as_str).collect();

    let mut ops: Vec<PlanOp> = Vec::new();
    let ambiguous = dispositions
        .iter()
        .filter(|d| {
            matches!(
                d.detail.get("near_misses"),
                Some(omgbase_reconcile::DetailValue::List(_))
            )
        })
        .count();
    let meta = |id: &str| meta_of(disp_by.get(id).copied());

    // 1. Removes.
    let target_top_ids: HashSet<&str> = target.iter().map(|t| t.id.as_str()).collect();
    for ob in &old_doc.children {
        if !target_top_ids.contains(ob.id.as_str()) {
            let mut expect = BTreeMap::new();
            expect.insert(ob.id.clone(), Expect::content(raw_hash_hex(&ob.raw)));
            ops.push(PlanOp {
                op: Op::Remove {
                    blocks: vec![ob.id.clone()],
                    expect: Some(expect),
                },
                disposition: PlanDisposition::Deleted,
                blocks: vec![ob.id.clone()],
                confidence: None,
                reason: Some("tombstone".to_owned()),
                detail: None,
            });
        }
    }

    // 2. Content updates.
    for t in &target {
        if !t.carried {
            continue;
        }
        let Some(ob) = old_by_id.get(t.id.as_str()) else {
            continue;
        };
        if raw_hash_hex(&ob.raw) != raw_hash_hex(&t.raw) {
            let m = meta(&t.id);
            let child_ids = if t.children.is_empty() {
                BTreeMap::new()
            } else {
                carried_child_id_map(t, &old_ids)
            };
            ops.push(PlanOp {
                op: Op::Update {
                    block: t.id.clone(),
                    markdown: Some(t.raw.clone()),
                    attrs: None,
                    expect: Some(Expect::content(raw_hash_hex(&ob.raw))),
                    trivia: None,
                    child_ids: (!child_ids.is_empty()).then_some(child_ids),
                },
                disposition: PlanDisposition::Edited,
                blocks: vec![t.id.clone()],
                confidence: m.confidence,
                reason: m.reason,
                detail: m.detail,
            });
        }
    }

    // 3. Placement.
    let kept_top: Vec<String> = target
        .iter()
        .filter(|t| t.carried && old_top_set.contains(t.id.as_str()))
        .map(|t| t.id.clone())
        .collect();
    let survivors_in_old_order: Vec<String> = old_top_ids
        .iter()
        .filter(|id| target_id_set.contains(*id) && kept_top.contains(id))
        .cloned()
        .collect();
    let stable = lcs(&survivors_in_old_order, &kept_top);

    let mut prev_ref: Option<String> = None;
    let mut ref_of: Vec<String> = Vec::with_capacity(target.len());
    let mut placed: Vec<bool> = Vec::with_capacity(target.len());
    for t in &target {
        let anchor = top_level_to(prev_ref.as_deref());
        let was_top = t.carried && old_top_set.contains(t.id.as_str());
        placed.push(!was_top || !stable.contains(&t.id));
        if !was_top {
            let op_index = ops.len();
            let d = disp_by.get(t.id.as_str()).copied();
            ops.push(PlanOp {
                op: Op::Insert {
                    doc: Some(doc_id.clone()),
                    to: anchor,
                    markdown: t.raw.clone(),
                },
                disposition: disposition_for_new(d.map(|d| d.kind)),
                blocks: Vec::new(),
                confidence: d.and_then(|d| d.confidence),
                reason: d.and_then(|d| d.reason).map(|r| r.as_str().to_owned()),
                detail: None,
            });
            prev_ref = Some(format!("${op_index}.ids[0]"));
        } else {
            if !stable.contains(&t.id) {
                let m = meta(&t.id);
                ops.push(PlanOp {
                    op: Op::Move {
                        blocks: vec![t.id.clone()],
                        to: anchor,
                    },
                    disposition: PlanDisposition::Moved,
                    blocks: vec![t.id.clone()],
                    confidence: m.confidence,
                    reason: m.reason,
                    detail: m.detail,
                });
            }
            prev_ref = Some(t.id.clone());
        }
        ref_of.push(prev_ref.clone().expect("set above"));
    }

    // 4. Retile.
    for (i, t) in target.iter().enumerate() {
        let ob = if t.carried {
            old_by_id.get(t.id.as_str()).copied()
        } else {
            None
        };
        let was_top = ob.is_some() && old_top_set.contains(t.id.as_str());
        let moved = was_top && !stable.contains(&t.id);
        let anchors_placement = placed.get(i + 1).copied().unwrap_or(false);
        let trivia_differs = ob.is_some_and(|o| o.trivia != t.trivia);
        if !(!was_top || moved || anchors_placement || trivia_differs) {
            continue;
        }
        ops.push(PlanOp {
            op: Op::Update {
                block: ref_of[i].clone(),
                markdown: None,
                attrs: None,
                expect: None,
                trivia: Some(t.trivia.clone()),
                child_ids: None,
            },
            disposition: PlanDisposition::Retiled,
            blocks: if was_top {
                vec![t.id.clone()]
            } else {
                Vec::new()
            },
            confidence: None,
            reason: None,
            detail: None,
        });
    }

    let preserved = target
        .iter()
        .filter(|t| {
            t.carried
                && old_by_id
                    .get(t.id.as_str())
                    .is_some_and(|ob| raw_hash_hex(&ob.raw) == raw_hash_hex(&t.raw))
                && stable.contains(&t.id)
        })
        .count();

    LowerResult {
        ops,
        preserved,
        ambiguous,
    }
}

/// §7 step 4 "replace": strip a leading frontmatter block and a leading blank
/// line from the proposed content for a body-only insert.
#[must_use]
pub fn body_of(content: &str) -> String {
    let Some(rest) = strip_frontmatter(content) else {
        return content.to_owned();
    };
    // `.replace(/^\s*\n/, "")`: leading whitespace up to and including the
    // first line break.
    match rest.find('\n') {
        Some(nl) if rest[..nl].chars().all(char::is_whitespace) => rest[nl + 1..].to_owned(),
        _ => rest.to_owned(),
    }
}

/// `^---\r?\n[\s\S]*?\r?\n---\r?\n?`: the content after a leading frontmatter
/// block, or `None` when there is none.
#[must_use]
pub fn strip_frontmatter(content: &str) -> Option<&str> {
    let after_open = content
        .strip_prefix("---\r\n")
        .or_else(|| content.strip_prefix("---\n"))?;
    // The lazy body ends at the first `\r?\n---` followed by `\r?\n` or the end.
    let mut search_from = 0;
    loop {
        let rel = after_open[search_from..].find("\n---")?;
        let at = search_from + rel;
        // `\r?` before the `\n`: optional, so the match is fine either way.
        let after = &after_open[at + 4..];
        let tail = if let Some(t) = after.strip_prefix("\r\n") {
            Some(t)
        } else if let Some(t) = after.strip_prefix('\n') {
            Some(t)
        } else if after.is_empty() {
            Some(after)
        } else {
            // A `\r` followed by something other than `\n` is not a match either
            // (`\r?\n?` would match `\r` alone? No: `\r?\n?` matches the empty
            // string, so the fence line may be followed by anything).
            Some(after)
        };
        if let Some(t) = tail {
            return Some(t);
        }
        search_from = at + 1;
    }
}

/// §7 step 4 "replace": remove every top-level block, insert the whole body.
#[must_use]
pub fn lower_replace(old_doc: &MutDoc, content: &str) -> LowerResult {
    let mut ops: Vec<PlanOp> = old_doc
        .children
        .iter()
        .map(|ob| PlanOp {
            op: Op::Remove {
                blocks: vec![ob.id.clone()],
                expect: None,
            },
            disposition: PlanDisposition::Deleted,
            blocks: vec![ob.id.clone()],
            confidence: None,
            reason: Some("tombstone".to_owned()),
            detail: None,
        })
        .collect();
    ops.push(PlanOp {
        op: Op::Insert {
            doc: Some(old_doc.doc_id.clone()),
            to: To {
                parent: Parent::Doc,
                at: At::End,
            },
            markdown: body_of(content),
        },
        disposition: PlanDisposition::BulkRewrite,
        blocks: Vec::new(),
        confidence: None,
        reason: None,
        detail: None,
    });
    LowerResult {
        ops,
        preserved: 0,
        ambiguous: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_format::parse_markdown;
    use omgbase_reconcile::{
        Config, FlatSource, Options, SequentialMinter, flatten, reconcile_document,
    };

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn lcs_keeps_the_longest_common_subsequence() {
        let a = ids(&["a", "b", "c", "d"]);
        let b = ids(&["b", "a", "c", "d"]);
        let keep = lcs(&a, &b);
        assert_eq!(keep.len(), 3);
        assert!(keep.contains("c") && keep.contains("d"));
        // Ties prefer advancing the old side: `a` is skipped, `b` kept.
        assert!(keep.contains("b"));
        assert!(lcs(&[], &b).is_empty());
        assert_eq!(lcs(&a, &a).len(), 4);
    }

    #[test]
    fn frontmatter_stripping() {
        assert_eq!(
            strip_frontmatter("---\na: 1\n---\n\nbody\n"),
            Some("\nbody\n")
        );
        assert_eq!(
            strip_frontmatter("---\r\na: 1\r\n---\r\nbody"),
            Some("body")
        );
        assert_eq!(strip_frontmatter("---\na: 1\n---"), Some(""));
        assert_eq!(strip_frontmatter("no fm\n"), None);
        assert_eq!(body_of("---\na: 1\n---\n\nbody\n"), "body\n");
        assert_eq!(body_of("---\na: 1\n---\nbody\n"), "body\n");
        assert_eq!(body_of("plain\n"), "plain\n");
    }

    /// A doc with `b_0…` in pre-order and the reconcile of new content
    /// against it (mirrors the store's planner inputs).
    fn plan_inputs(
        old: &str,
        new: &str,
    ) -> (
        MutDoc,
        Vec<Block>,
        BTreeMap<String, String>,
        Vec<Disposition>,
    ) {
        let mut m = SequentialMinter::new("b");
        let old_tree = parse_markdown(old);
        fn to_mut(b: &Block, m: &mut SequentialMinter) -> MutBlock {
            let id = omgbase_reconcile::Minter::mint(m);
            let mut mb = MutBlock::new(&id, b.kind.as_str(), &b.raw, &b.trivia);
            mb.children = b.children.iter().map(|c| to_mut(c, m)).collect();
            mb
        }
        let children: Vec<MutBlock> = old_tree
            .children
            .iter()
            .map(|b| to_mut(b, &mut m))
            .collect();
        let doc = MutDoc::new("d_0", "a.md", children);
        let old_flat = flatten(&FlatSource::from_tree(
            &old_tree,
            Some(&mut SequentialMinter::new("b")),
        ));
        let new_tree = parse_markdown(new);
        let new_flat = flatten(&FlatSource::from_tree(&new_tree, None));
        let mut n = SequentialMinter::new("n");
        let result = reconcile_document(
            &old_flat,
            &new_flat,
            Options {
                config: &Config::default(),
                pool: &[],
                minter: &mut n,
            },
        );
        (
            doc,
            new_tree.children,
            result.assignment,
            result.dispositions,
        )
    }

    #[test]
    fn identical_content_lowers_to_nothing() {
        let (doc, rest, assignment, disps) = plan_inputs("# T\n\nA.\n\nB.\n", "# T\n\nA.\n\nB.\n");
        let r = lower_top_level(&doc, &rest, &assignment, &disps);
        assert!(r.ops.is_empty());
        assert_eq!(r.preserved, 3);
    }

    #[test]
    fn insert_in_the_middle_anchors_after_the_previous_and_retiles() {
        let (doc, rest, assignment, disps) =
            plan_inputs("# T\n\nA.\n\nB.\n", "# T\n\nA.\n\nMid.\n\nB.\n");
        let r = lower_top_level(&doc, &rest, &assignment, &disps);
        let names: Vec<&str> = r.ops.iter().map(|p| p.op.name()).collect();
        assert_eq!(names, ["insert", "update", "update"]);
        match &r.ops[0].op {
            Op::Insert { doc, to, markdown } => {
                assert_eq!(doc.as_deref(), Some("d_0"));
                assert_eq!(to.at, At::After("b_1".into()));
                assert_eq!(markdown, "Mid.");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(r.ops[0].disposition, PlanDisposition::Inserted);
        // A. anchors the insert → retiled; the insert itself is retiled via its placeholder.
        assert!(
            matches!(&r.ops[1].op, Op::Update { block, trivia: Some(t), .. } if block == "b_1" && t == "\n\n")
        );
        assert!(
            matches!(&r.ops[2].op, Op::Update { block, trivia: Some(t), .. } if block == "$0.ids[0]" && t == "\n\n")
        );
        assert_eq!(r.ops[2].blocks, Vec::<String>::new());
        assert_eq!(r.preserved, 3);
    }

    #[test]
    fn removal_and_edit_and_reorder() {
        let (doc, rest, assignment, disps) =
            plan_inputs("# T\n\nA.\n\nB.\n\nC.\n", "# T\n\nA.\n\nC.\n");
        let r = lower_top_level(&doc, &rest, &assignment, &disps);
        assert!(
            matches!(&r.ops[0].op, Op::Remove { blocks, expect: Some(e) } if blocks == &ids(&["b_2"]) && e["b_2"].content_hash.is_some())
        );
        assert_eq!(r.ops[0].reason.as_deref(), Some("tombstone"));
        let long_a = "Alpha is a reasonably long paragraph about the first topic in this note.";
        let long_b = "Alpha is a reasonably long paragraph about the first subject in this note.";
        let (doc, rest, assignment, disps) =
            plan_inputs(&format!("# T\n\n{long_a}\n"), &format!("# T\n\n{long_b}\n"));
        let r = lower_top_level(&doc, &rest, &assignment, &disps);
        assert!(
            matches!(&r.ops[0].op, Op::Update { block, markdown: Some(md), expect: Some(_), child_ids: None, .. } if block == "b_1" && md == long_b)
        );
        assert_eq!(r.ops[0].disposition, PlanDisposition::Edited);
        assert!(r.ops[0].confidence.is_some());
        let (doc, rest, assignment, disps) = plan_inputs("# T\n\nA.\n\nB.\n", "# T\n\nB.\n\nA.\n");
        let r = lower_top_level(&doc, &rest, &assignment, &disps);
        assert!(
            r.ops
                .iter()
                .any(|p| p.disposition == PlanDisposition::Moved)
        );
    }

    #[test]
    fn container_update_threads_carried_child_ids() {
        let (doc, rest, assignment, disps) = plan_inputs(
            "# T\n\n- alpha item text here\n- bravo item text here\n- gamma item text here\n",
            "# T\n\n- alpha item text here\n- bravo item text CHANGED\n- gamma item text here\n",
        );
        let r = lower_top_level(&doc, &rest, &assignment, &disps);
        let upd = r
            .ops
            .iter()
            .find(|p| {
                p.op.name() == "update"
                    && matches!(
                        &p.op,
                        Op::Update {
                            markdown: Some(_),
                            ..
                        }
                    )
            })
            .unwrap();
        match &upd.op {
            Op::Update {
                block,
                child_ids: Some(c),
                ..
            } => {
                assert_eq!(block, "b_1");
                assert_eq!(c.get("/0").map(String::as_str), Some("b_2"));
                assert_eq!(c.get("/2").map(String::as_str), Some("b_4"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn replace_lowering_removes_everything_and_inserts_the_body() {
        let (doc, ..) = plan_inputs("# T\n\nA.\n", "x");
        let r = lower_replace(&doc, "---\nk: v\n---\n\n# N\n");
        assert_eq!(r.ops.len(), 3);
        assert!(matches!(&r.ops[0].op, Op::Remove { expect: None, .. }));
        assert!(
            matches!(&r.ops[2].op, Op::Insert { markdown, to, .. } if markdown == "# N\n" && to.at == At::End)
        );
        assert_eq!(r.ops[2].disposition, PlanDisposition::BulkRewrite);
    }
}
