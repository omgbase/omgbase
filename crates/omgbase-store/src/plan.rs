//! The whole-document update planner (`spec/mutate/README.md` §7):
//! reconcile a proposed complete document against the stored tree (no pool),
//! lower to kernel ops, verify by a dry-run apply, fall back to a full
//! replace; and `apply_opset` with its preconditions.

use omgbase_format::hash::{hex, sha256};
use omgbase_format::{Block, BlockKind, parse_markdown};
use omgbase_mutate::{
    ErrorCode, LowerResult, MutationError, Op, Opset, OpsetPrecondition, lower_replace,
    lower_top_level, render, summarize,
};
use omgbase_reconcile::{Config, FlatSource, Options, flatten, reconcile_document};
use rusqlite::{OptionalExtension, params};
use serde_json::json;

use crate::Store;
use crate::doc_store::{DocStore, NullDocStore};
use crate::error::{Error, Result};
use crate::mutate::{
    ApplyOrigin, ApplyRequest, ApplyResult, SetFrontmatter, find_doc_by_ref, load_mut_doc,
};
use crate::read::load_old_match_blocks;

enum Verified {
    Ok,
    Diverged { actual: String },
    Threw(String),
}

/// §7 step 4: name the first differing byte and the proposed block covering it.
fn describe_divergence(v: &Verified, proposed: &[Block], expected: &str) -> String {
    match v {
        Verified::Ok => "converged".to_owned(),
        Verified::Threw(e) => format!("simulation threw {e}"),
        Verified::Diverged { actual } => {
            let a = actual.as_bytes();
            let e = expected.as_bytes();
            let n = a.len().min(e.len());
            let mut off = 0;
            while off < n && a[off] == e[off] {
                off += 1;
            }
            let idx = proposed
                .iter()
                .position(|b| off >= b.span.start && off < b.span.end + b.trivia.len());
            let where_ = match idx {
                Some(i) => format!(
                    "proposed block #{i} ({}, bytes {}-{})",
                    proposed[i].kind.as_str(),
                    proposed[i].span.start,
                    proposed[i].span.end
                ),
                None if off >= expected.len() => "past the end of the proposed content".to_owned(),
                None => "leading trivia".to_owned(),
            };
            let snippet = |s: &str| -> String {
                let mut start = off.min(s.len());
                while !s.is_char_boundary(start) {
                    start -= 1;
                }
                let piece: String = s[start..].chars().take(24).collect();
                serde_json::to_string(&piece).unwrap_or_default()
            };
            format!(
                "first divergence at byte {off} in {where_}: expected {}, rendered {}",
                snippet(expected),
                snippet(actual)
            )
        }
    }
}

impl Store {
    /// §7 `plan_update`: the opset for replacing `doc_ref`'s content with
    /// `content`. Never writes; mints (the reconcile's new ids, the dry-run
    /// verification's) as the reference does.
    pub fn plan_update(
        &mut self,
        repo_id: &str,
        doc_ref: &str,
        content: &str,
        config: &Config,
    ) -> Result<Opset> {
        let info = find_doc_by_ref(&self.conn, repo_id, doc_ref)?.ok_or_else(|| {
            Error::from(MutationError::with_data(
                ErrorCode::DocMissing,
                format!("doc {doc_ref} not found"),
                json!({ "doc": doc_ref }),
            ))
        })?;
        let old_doc = load_mut_doc(&self.conn, &info.doc_id)?.ok_or_else(|| {
            Error::from(MutationError::with_data(
                ErrorCode::DocMissing,
                format!("doc {doc_ref} not found"),
                json!({ "doc": doc_ref }),
            ))
        })?;
        let current_content = render(&old_doc);
        let base_content_hash = hex(&sha256(current_content.as_bytes()));

        let tree = parse_markdown(content);
        let (fm_block, rest): (Option<&Block>, &[Block]) = match tree.children.first() {
            Some(b) if b.kind == BlockKind::Frontmatter => (Some(b), &tree.children[1..]),
            _ => (None, &tree.children[..]),
        };
        let old_match = load_old_match_blocks(&self.conn, &info.doc_id)?;
        let new_match = flatten(&FlatSource::from_blocks(rest, None));
        let mut mint = || self.minter.mint("b");
        let result = reconcile_document(
            &old_match,
            &new_match,
            Options {
                config,
                pool: &[],
                minter: &mut mint,
            },
        );

        let target_fm: Option<String> = fm_block.map(|b| format!("{}{}", b.raw, b.trivia));
        let fm_changed = target_fm != old_doc.frontmatter_raw;
        let set_frontmatter: Vec<SetFrontmatter> = if fm_changed {
            vec![SetFrontmatter {
                doc: info.doc_id.clone(),
                raw: target_fm.clone(),
            }]
        } else {
            Vec::new()
        };

        let mut diagnostics: Vec<String> = Vec::new();
        let t2 = lower_top_level(&old_doc, rest, &result.assignment, &result.dispositions);
        let v2 = self.verify(
            repo_id,
            &info.path,
            &t2,
            &set_frontmatter,
            content,
            &current_content,
        );
        let (chosen, converges) = if matches!(v2, Verified::Ok) {
            (t2, true)
        } else {
            diagnostics.push(format!(
                "top-level lowering did not reproduce the proposed content byte-for-byte ({}); falling back to full replace",
                describe_divergence(&v2, &tree.children, content)
            ));
            let t3 = lower_replace(&old_doc, content);
            let v3 = self.verify(
                repo_id,
                &info.path,
                &t3,
                &set_frontmatter,
                content,
                &current_content,
            );
            if matches!(v3, Verified::Ok) {
                diagnostics
                    .push("full-replace plan converges (block identity not preserved)".to_owned());
                (t3, true)
            } else {
                diagnostics.push(format!(
                    "no lowering reproduced the proposed content exactly (full replace: {}); plan will not apply — inspect and re-plan",
                    describe_divergence(&v3, &tree.children, content)
                ));
                (t2, false)
            }
        };
        let summary = summarize(&chosen.ops, chosen.preserved, chosen.ambiguous);
        Ok(Opset {
            target_doc: info.doc_id.clone(),
            target_path: info.path.clone(),
            precondition: OpsetPrecondition {
                doc: info.doc_id,
                path: info.path,
                base_revision: info.current_rev,
                base_content_hash,
            },
            matcher_v: config.matcher_v.clone(),
            ops: chosen.ops,
            frontmatter: fm_changed.then_some(target_fm),
            summary,
            converges,
            diagnostics,
        })
    }

    /// Simulate a lowering by a dry-run apply; the rendered result must equal
    /// the proposed content exactly.
    fn verify(
        &mut self,
        repo_id: &str,
        path: &str,
        lowering: &LowerResult,
        set_frontmatter: &[SetFrontmatter],
        expected: &str,
        current_content: &str,
    ) -> Verified {
        let req = ApplyRequest {
            repo_id: repo_id.to_owned(),
            ops: lowering
                .ops
                .iter()
                .map(|p| p.op.clone())
                .collect::<Vec<Op>>(),
            origin: ApplyOrigin::new("plan:verify", None),
            dry_run: true,
            set_frontmatter: set_frontmatter.to_vec(),
        };
        let mut null = NullDocStore;
        match self.apply(&req, &mut null, "1970-01-01T00:00:00.000Z") {
            Ok(res) => {
                let after = res
                    .diffs
                    .as_ref()
                    .and_then(|d| d.iter().find(|(p, _)| p == path))
                    .map_or(current_content, |(_, diff)| diff.after.as_str());
                if after == expected {
                    Verified::Ok
                } else {
                    Verified::Diverged {
                        actual: after.to_owned(),
                    }
                }
            }
            Err(Error::Mutation(e)) => Verified::Threw(format!("{}: {}", e.code, e.message)),
            Err(e) => Verified::Threw(e.to_string()),
        }
    }

    /// §7.2 `apply_opset`: refuse a non-convergent plan, check the
    /// preconditions (`stale_plan` with the current revision and hash), then
    /// apply the plan's kernel ops with its frontmatter override.
    pub fn apply_opset(
        &mut self,
        repo_id: &str,
        opset: &Opset,
        origin: &ApplyOrigin,
        dry_run: bool,
        doc_store: &mut dyn DocStore,
        ts: &str,
    ) -> Result<ApplyResult> {
        if !opset.converges {
            let why = opset
                .diagnostics
                .last()
                .map_or(String::new(), |d| format!(" — {d}"));
            return Err(MutationError::with_data(
                ErrorCode::PlanNotConvergent,
                format!("opset does not reproduce the proposed content; re-plan{why}"),
                json!({ "diagnostics": opset.diagnostics }),
            )
            .into());
        }
        let row: Option<(Option<String>, Option<Vec<u8>>)> = self
            .conn
            .query_row(
                "SELECT current_rev, file_hash FROM docs WHERE doc_id = ?1 AND deleted_commit IS NULL",
                params![opset.precondition.doc],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((current_rev, file_hash)) = row else {
            return Err(MutationError::with_data(
                ErrorCode::DocMissing,
                format!("doc {} not found", opset.precondition.doc),
                json!({ "doc": opset.precondition.doc }),
            )
            .into());
        };
        let fh = file_hash.map(|h| hex(&h));
        let stale = (opset.precondition.base_revision.is_some()
            && current_rev != opset.precondition.base_revision)
            || fh
                .as_deref()
                .is_some_and(|h| h != opset.precondition.base_content_hash);
        if stale {
            return Err(MutationError::with_data(
                ErrorCode::StalePlan,
                "document changed since the plan was computed; re-plan",
                json!({
                    "doc": opset.precondition.doc,
                    "expected_revision": opset.precondition.base_revision,
                    "current": { "revision": current_rev, "content_hash": fh },
                    "retriable": true,
                }),
            )
            .into());
        }
        let req = ApplyRequest {
            repo_id: repo_id.to_owned(),
            ops: opset.kernel_ops(),
            origin: origin.clone(),
            dry_run,
            set_frontmatter: match &opset.frontmatter {
                Some(raw) => vec![SetFrontmatter {
                    doc: opset.precondition.doc.clone(),
                    raw: raw.clone(),
                }],
                None => Vec::new(),
            },
        };
        self.apply(&req, doc_store, ts)
    }

    /// `docs_update`: plan then apply (`None` result on a dry run).
    #[allow(clippy::too_many_arguments)]
    pub fn docs_update(
        &mut self,
        repo_id: &str,
        doc_ref: &str,
        content: &str,
        config: &Config,
        origin: &ApplyOrigin,
        dry_run: bool,
        doc_store: &mut dyn DocStore,
        ts: &str,
    ) -> Result<(Opset, Option<ApplyResult>)> {
        let opset = self.plan_update(repo_id, doc_ref, content, config)?;
        if dry_run {
            return Ok((opset, None));
        }
        let result = self.apply_opset(repo_id, &opset, origin, false, doc_store, ts)?;
        Ok((opset, Some(result)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn divergence_descriptions() {
        let tree = parse_markdown("# Title\n\nAlpha.\n");
        let v = Verified::Diverged {
            actual: "# Title\n\nAlphb.\n".to_owned(),
        };
        assert_eq!(
            describe_divergence(&v, &tree.children, "# Title\n\nAlpha.\n"),
            "first divergence at byte 13 in proposed block #1 (paragraph, bytes 9-15): expected \"a.\\n\", rendered \"b.\\n\""
        );
        let lead = parse_markdown("\n\n# Title\n");
        let v = Verified::Diverged {
            actual: "# Title\n".to_owned(),
        };
        assert_eq!(
            describe_divergence(&v, &lead.children, "\n\n# Title\n"),
            "first divergence at byte 0 in leading trivia: expected \"\\n\\n# Title\\n\", rendered \"# Title\\n\""
        );
        let v = Verified::Diverged {
            actual: "# Title\n\nAlpha.\n\nmore".to_owned(),
        };
        assert!(
            describe_divergence(&v, &tree.children, "# Title\n\nAlpha.\n").contains("past the end")
        );
        assert_eq!(
            describe_divergence(
                &Verified::Threw("doc_missing: doc d_0 not found".into()),
                &[],
                ""
            ),
            "simulation threw doc_missing: doc d_0 not found"
        );
        assert_eq!(describe_divergence(&Verified::Ok, &[], ""), "converged");
    }
}
