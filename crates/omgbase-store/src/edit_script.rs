//! Myers' shortest edit script over two slices of strings — the ONE diff
//! algorithm both engines share, so an edit script is deterministic across
//! them (the reference's `core/edit-script.ts`). Two consumers: the unified
//! diff of `docs_diff_unified` (`spec/surface` §3; `omgbase-surface`'s
//! `history.rs` re-exports it from here) and the delta tree nodes of
//! `spec/store` §4.1 (16.0; [`crate::delta`]), whose ops are this script
//! grouped. It lives in the store crate because the surface depends on the
//! store, never the other way round.

/// One step of the edit script: `Keep` consumes a line from both sides,
/// `Delete` one from the old text, `Insert` one from the new text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditOp<'a> {
    Keep(&'a str),
    Delete(&'a str),
    Insert(&'a str),
}

/// Myers' O(ND) shortest edit script (forward, with a per-`d` trace for the
/// backtrack). `V[k]` is the furthest x on diagonal `k = x - y` reachable with
/// `d` edits. The canonical tie rule, identical in both engines: at each step
/// take the diagonal from `k+1` (moving down — an insertion of `b[y]`) when
/// `k == -d || (k != d && V[k-1] < V[k+1])`, else from `k-1` (moving right —
/// a deletion of `a[x]`). On a tie (`V[k-1] == V[k+1]`) that is the deletion.
#[must_use]
pub fn myers_script<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<EditOp<'a>> {
    let n = a.len();
    let m = b.len();
    let max = n + m;
    // V is indexed by k ∈ [-max-1, max+1]; `off` maps it onto a plain vector.
    let off = max + 1;
    let at = |k: isize| -> usize { (off as isize + k) as usize };
    let mut v = vec![0usize; 2 * max + 3];
    let mut trace: Vec<Vec<usize>> = Vec::new();
    let mut found = false;
    let mut d: isize = 0;
    while d <= max as isize && !found {
        trace.push(v.clone());
        let mut k = -d;
        while k <= d {
            let mut x = if k == -d || (k != d && v[at(k - 1)] < v[at(k + 1)]) {
                v[at(k + 1)]
            } else {
                v[at(k - 1)] + 1
            };
            let mut y = (x as isize - k) as usize;
            while x < n && y < m && a[x] == b[y] {
                x += 1;
                y += 1;
            }
            v[at(k)] = x;
            if x >= n && y >= m {
                found = true;
                break;
            }
            k += 2;
        }
        d += 1;
    }
    // Backtrack from (n, m) through the trace, emitting ops newest-first.
    let mut ops: Vec<EditOp<'a>> = Vec::new();
    let mut x = n;
    let mut y = m;
    for (d, vd) in trace.iter().enumerate().rev() {
        let d = d as isize;
        let k = x as isize - y as isize;
        let prev_k = if k == -d || (k != d && vd[at(k - 1)] < vd[at(k + 1)]) {
            k + 1
        } else {
            k - 1
        };
        let prev_x = vd[at(prev_k)];
        let prev_y = prev_x as isize - prev_k;
        while x > prev_x && y as isize > prev_y {
            x -= 1;
            y -= 1;
            ops.push(EditOp::Keep(a[x]));
        }
        if d > 0 {
            if x == prev_x {
                ops.push(EditOp::Insert(b[prev_y as usize]));
            } else {
                ops.push(EditOp::Delete(a[prev_x]));
            }
        }
        x = prev_x;
        y = prev_y as usize;
    }
    ops.reverse();
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(ops: &[EditOp<'_>]) -> String {
        ops.iter()
            .map(|op| match op {
                EditOp::Keep(l) => format!(" {l}"),
                EditOp::Delete(l) => format!("-{l}"),
                EditOp::Insert(l) => format!("+{l}"),
            })
            .collect::<Vec<_>>()
            .join("|")
    }

    /// The textbook tie case the surface pins for `docs_diff_unified`
    /// (`spec/surface` §3): the two crates must agree byte for byte, so the
    /// same vector is asserted here and in `omgbase-surface`'s `history.rs`.
    #[test]
    fn textbook_tie_case() {
        let a: Vec<&str> = "a\nb\nc\na\nb\nb\na".split('\n').collect();
        let b: Vec<&str> = "c\nb\na\nb\na\nc".split('\n').collect();
        assert_eq!(render(&myers_script(&a, &b)), "-a|-b| c|+b| a| b|-b| a|+c");
    }

    #[test]
    fn degenerate_sides() {
        assert!(myers_script(&[], &[]).is_empty());
        assert_eq!(render(&myers_script(&[], &["x"])), "+x");
        assert_eq!(render(&myers_script(&["x"], &[])), "-x");
        assert_eq!(render(&myers_script(&["x", "y"], &["x", "y"])), " x| y");
        // A replacement in the middle: the deletion comes before the insertion.
        assert_eq!(
            render(&myers_script(&["x", "y", "z"], &["x", "Y", "z"])),
            " x|-y|+Y| z"
        );
    }
}
