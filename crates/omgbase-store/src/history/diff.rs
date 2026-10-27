//! The unified diff of two texts (`spec/surface` §3 `docs_diff_unified`): a
//! line-grain diff over a deterministic Myers script, so both engines (this
//! port and the reference `packages/core/src/graph/history.ts`) produce the
//! same bytes for the same two texts. Pure; the native recorder diffs two
//! revisions' reconstructed bytes with it, the git history provider two
//! blobs (Phase 6a — the one reason it lives here rather than in the
//! surface, which re-exports it). The surface's tests pin it byte for byte
//! against the reference.

pub use crate::history::edit_script::{EditOp, myers_script};

/// How a text becomes lines: `split('\n')` exactly — no trimming, no dropping
/// of a trailing empty element (a raw ending in `\n` yields one) — with a
/// single special case: the empty text has *no* lines (an empty file is zero
/// lines, not one empty line), so a diff from/to nothing is `@@ -0,0 +1,n @@`.
#[must_use]
pub fn diff_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}

const DIFF_CONTEXT: usize = 3;

/// The unified diff of two texts (`spec/surface` §3): hunks of `DIFF_CONTEXT`
/// (3) lines of context; a change group extends to include the next change
/// when fewer than `2 * DIFF_CONTEXT + 1` unchanged lines separate them (the
/// two contexts touch or overlap). Each hunk is `@@ -a,b +c,d @@` (1-based
/// start and length; a length of 1 is written as the start alone; a length of
/// 0 as `a,0` with `a` the line before the insertion point, `0` at the very
/// top) followed by its lines prefixed `-`, `+` or a space with nothing after
/// the sign; hunks joined by `\n`; no file header; identical texts → `""`.
#[must_use]
pub fn unified_diff(old_text: &str, new_text: &str) -> String {
    let ops = myers_script(&diff_lines(old_text), &diff_lines(new_text));
    // Old/new line counts consumed before each op (0-based positions).
    let mut old_pos = Vec::with_capacity(ops.len() + 1);
    let mut new_pos = Vec::with_capacity(ops.len() + 1);
    let (mut o, mut nn) = (0usize, 0usize);
    for op in &ops {
        old_pos.push(o);
        new_pos.push(nn);
        if !matches!(op, EditOp::Insert(_)) {
            o += 1;
        }
        if !matches!(op, EditOp::Delete(_)) {
            nn += 1;
        }
    }
    old_pos.push(o);
    new_pos.push(nn);

    let changes: Vec<usize> = (0..ops.len())
        .filter(|&i| !matches!(ops[i], EditOp::Keep(_)))
        .collect();
    if changes.is_empty() {
        return String::new();
    }

    let range = |pos: usize, len: usize| -> String {
        let start = if len == 0 { pos } else { pos + 1 };
        if len == 1 {
            start.to_string()
        } else {
            format!("{start},{len}")
        }
    };
    let mut hunks: Vec<String> = Vec::new();
    let mut g = 0;
    while g < changes.len() {
        let first = changes[g];
        let mut last = first;
        // Merge rule: the next change joins this hunk iff the unchanged lines
        // between them number at most 2 * DIFF_CONTEXT.
        while g + 1 < changes.len() && changes[g + 1] - last - 1 <= 2 * DIFF_CONTEXT {
            g += 1;
            last = changes[g];
        }
        g += 1;
        let start = first.saturating_sub(DIFF_CONTEXT);
        let end = (last + DIFF_CONTEXT).min(ops.len() - 1);
        let old_len = old_pos[end + 1] - old_pos[start];
        let new_len = new_pos[end + 1] - new_pos[start];
        let mut lines = vec![format!(
            "@@ -{} +{} @@",
            range(old_pos[start], old_len),
            range(new_pos[start], new_len)
        )];
        for op in &ops[start..=end] {
            lines.push(match op {
                EditOp::Keep(l) => format!(" {l}"),
                EditOp::Delete(l) => format!("-{l}"),
                EditOp::Insert(l) => format!("+{l}"),
            });
        }
        hunks.push(lines.join("\n"));
    }
    hunks.join("\n")
}
