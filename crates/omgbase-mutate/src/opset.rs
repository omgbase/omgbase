//! The opset (`spec/mutate/README.md` §7): an inspectable plan — kernel ops
//! annotated with the identity consequence of each — pinned to the state it
//! was planned against, plus the summary.

use serde_json::{Map, Value, json};

use crate::changeset::Op;

/// The identity consequence of one planned op (the matcher's vocabulary plus
/// the synthetic `retiled`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PlanDisposition {
    Same,
    Edited,
    Moved,
    EditedMoved,
    Inserted,
    Deleted,
    SplitFrom,
    MergedInto,
    CopiedFrom,
    Resurrected,
    BulkRewrite,
    Retiled,
}

impl PlanDisposition {
    pub const ALL: [PlanDisposition; 12] = [
        PlanDisposition::Same,
        PlanDisposition::Edited,
        PlanDisposition::Moved,
        PlanDisposition::EditedMoved,
        PlanDisposition::Inserted,
        PlanDisposition::Deleted,
        PlanDisposition::SplitFrom,
        PlanDisposition::MergedInto,
        PlanDisposition::CopiedFrom,
        PlanDisposition::Resurrected,
        PlanDisposition::BulkRewrite,
        PlanDisposition::Retiled,
    ];

    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            PlanDisposition::Same => "same",
            PlanDisposition::Edited => "edited",
            PlanDisposition::Moved => "moved",
            PlanDisposition::EditedMoved => "edited_moved",
            PlanDisposition::Inserted => "inserted",
            PlanDisposition::Deleted => "deleted",
            PlanDisposition::SplitFrom => "split_from",
            PlanDisposition::MergedInto => "merged_into",
            PlanDisposition::CopiedFrom => "copied_from",
            PlanDisposition::Resurrected => "resurrected",
            PlanDisposition::BulkRewrite => "bulk_rewrite",
            PlanDisposition::Retiled => "retiled",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|d| d.as_str() == s)
    }
}

/// One kernel op plus the identity consequence the planner attributes to it.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanOp {
    pub op: Op,
    pub disposition: PlanDisposition,
    /// The carried id(s) the op acts on; empty for an insert of new structure.
    pub blocks: Vec<String>,
    pub confidence: Option<f64>,
    pub reason: Option<String>,
    pub detail: Option<Value>,
}

impl PlanOp {
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("op".to_owned(), self.op.to_json());
        m.insert("disposition".to_owned(), json!(self.disposition.as_str()));
        m.insert("blocks".to_owned(), json!(self.blocks));
        m.insert("confidence".to_owned(), json!(self.confidence));
        m.insert("reason".to_owned(), json!(self.reason));
        if let Some(d) = &self.detail {
            m.insert("detail".to_owned(), d.clone());
        }
        Value::Object(m)
    }
}

/// The identity accounting over the reconciliation (§7 `summary`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OpsetSummary {
    pub preserved: usize,
    pub updated: usize,
    pub moved: usize,
    pub created: usize,
    pub removed: usize,
    pub split: usize,
    pub merged: usize,
    pub ambiguous: usize,
}

impl OpsetSummary {
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "preserved": self.preserved, "updated": self.updated, "moved": self.moved,
            "created": self.created, "removed": self.removed, "split": self.split,
            "merged": self.merged, "ambiguous": self.ambiguous,
        })
    }
}

/// §7: the summary from the planned ops and the lowering's counts.
#[must_use]
pub fn summarize(ops: &[PlanOp], preserved: usize, ambiguous: usize) -> OpsetSummary {
    let mut s = OpsetSummary {
        preserved,
        ambiguous,
        ..OpsetSummary::default()
    };
    for p in ops {
        match p.disposition {
            PlanDisposition::Edited => s.updated += 1,
            PlanDisposition::Moved => s.moved += 1,
            PlanDisposition::EditedMoved => {
                s.updated += 1;
                s.moved += 1;
            }
            PlanDisposition::Inserted
            | PlanDisposition::CopiedFrom
            | PlanDisposition::Resurrected => {
                s.created += 1;
            }
            PlanDisposition::Deleted => s.removed += 1,
            PlanDisposition::SplitFrom => s.split += 1,
            PlanDisposition::MergedInto => s.merged += 1,
            PlanDisposition::Same | PlanDisposition::BulkRewrite | PlanDisposition::Retiled => {}
        }
    }
    s
}

/// State the opset was planned against (§7 `precondition`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpsetPrecondition {
    pub doc: String,
    pub path: String,
    /// The current revision at plan time; `None` for a doc with no revision.
    pub base_revision: Option<String>,
    /// `hex(sha256(render(doc)))` at plan time.
    pub base_content_hash: String,
}

/// §7 `Opset`.
#[derive(Clone, Debug, PartialEq)]
pub struct Opset {
    pub target_doc: String,
    pub target_path: String,
    pub precondition: OpsetPrecondition,
    pub matcher_v: String,
    pub ops: Vec<PlanOp>,
    /// `Some(raw)` when the proposed content changes the frontmatter (`raw`
    /// `None` drops it).
    pub frontmatter: Option<Option<String>>,
    pub summary: OpsetSummary,
    pub converges: bool,
    pub diagnostics: Vec<String>,
}

impl Opset {
    /// The bare kernel ops, in order — what `apply` replays.
    #[must_use]
    pub fn kernel_ops(&self) -> Vec<Op> {
        self.ops.iter().map(|p| p.op.clone()).collect()
    }

    /// The wire form (§7).
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("version".to_owned(), json!(1));
        m.insert("kind".to_owned(), json!("doc_update"));
        m.insert(
            "target".to_owned(),
            json!({ "doc": self.target_doc, "path": self.target_path }),
        );
        m.insert(
            "precondition".to_owned(),
            json!({
                "doc": self.precondition.doc,
                "path": self.precondition.path,
                "base_revision": self.precondition.base_revision,
                "base_content_hash": self.precondition.base_content_hash,
            }),
        );
        m.insert("matcher_v".to_owned(), json!(self.matcher_v));
        m.insert(
            "ops".to_owned(),
            Value::Array(self.ops.iter().map(PlanOp::to_json).collect()),
        );
        if let Some(fm) = &self.frontmatter {
            m.insert("frontmatter".to_owned(), json!({ "raw": fm }));
        }
        m.insert("summary".to_owned(), self.summary.to_json());
        m.insert("converges".to_owned(), json!(self.converges));
        m.insert("diagnostics".to_owned(), json!(self.diagnostics));
        Value::Object(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::{At, Parent, To};

    fn plan(d: PlanDisposition) -> PlanOp {
        PlanOp {
            op: Op::Move {
                blocks: vec!["b_1".into()],
                to: To {
                    parent: Parent::Doc,
                    at: At::Start,
                },
            },
            disposition: d,
            blocks: vec!["b_1".into()],
            confidence: Some(1.0),
            reason: Some("exact_hash".into()),
            detail: None,
        }
    }

    #[test]
    fn summary_buckets() {
        let ops: Vec<PlanOp> = PlanDisposition::ALL.iter().map(|d| plan(*d)).collect();
        let s = summarize(&ops, 3, 1);
        assert_eq!(
            s,
            OpsetSummary {
                preserved: 3,
                updated: 2,
                moved: 2,
                created: 3,
                removed: 1,
                split: 1,
                merged: 1,
                ambiguous: 1,
            }
        );
        for d in PlanDisposition::ALL {
            assert_eq!(PlanDisposition::parse(d.as_str()), Some(d));
        }
    }

    #[test]
    fn opset_json_shape() {
        let opset = Opset {
            target_doc: "d_0".into(),
            target_path: "a.md".into(),
            precondition: OpsetPrecondition {
                doc: "d_0".into(),
                path: "a.md".into(),
                base_revision: Some("r_0".into()),
                base_content_hash: "ab".into(),
            },
            matcher_v: "m2.3".into(),
            ops: vec![plan(PlanDisposition::Moved)],
            frontmatter: Some(None),
            summary: OpsetSummary::default(),
            converges: true,
            diagnostics: vec![],
        };
        let v = opset.to_json();
        assert_eq!(v["version"], json!(1));
        assert_eq!(v["kind"], json!("doc_update"));
        assert_eq!(v["precondition"]["base_revision"], json!("r_0"));
        assert_eq!(v["frontmatter"], json!({ "raw": null }));
        assert_eq!(v["ops"][0]["disposition"], json!("moved"));
        assert_eq!(v["ops"][0]["blocks"], json!(["b_1"]));
        assert!(v["ops"][0].get("detail").is_none());
        assert_eq!(opset.kernel_ops().len(), 1);
    }
}
