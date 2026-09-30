//! History (`spec/surface/README.md` §3): `history_node`, the block-grain
//! `diff`, the Myers unified `diff_unified` over the two revisions'
//! reconstructed files (§3; positional before 1.1, §9), `docs_history`. Port
//! of `packages/core/src/graph/history.ts`; `changes_since` is the store's.

use std::collections::HashMap;

use omgbase_format::hash::hex;
use omgbase_store::tree::{from_hex, parse_tree_entries};
use omgbase_store::{Store, is_id_ref};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::error::Result;
use crate::read::find_doc_by_ref;

/// §3 `history_node`: `[{ commitId, seq, ts, origin, kind, confidence, reason }]`,
/// newest first.
pub fn history_node(store: &Store, block_id: &str, limit: Option<i64>) -> Result<Json> {
    let limit = limit.unwrap_or(100);
    let mut stmt = store.conn().prepare(
        "SELECT bc.commit_id, c.seq, c.ts, c.origin, bc.kind, d.confidence, d.reason
         FROM block_changes bc
         JOIN commits c ON c.commit_id = bc.commit_id
         LEFT JOIN dispositions d ON d.commit_id = bc.commit_id AND d.block_id = bc.block_id AND d.kind = bc.kind
         WHERE bc.block_id = ?1
         ORDER BY c.seq DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![block_id, limit], |r| {
        Ok(json!({
            "commitId": r.get::<_, String>(0)?,
            "seq": r.get::<_, i64>(1)?,
            "ts": r.get::<_, String>(2)?,
            "origin": r.get::<_, String>(3)?,
            "kind": r.get::<_, String>(4)?,
            "confidence": r.get::<_, Option<f64>>(5)?,
            "reason": r.get::<_, Option<String>>(6)?,
        }))
    })?;
    Ok(Json::Array(
        rows.collect::<std::result::Result<Vec<_>, _>>()?,
    ))
}

/// §9: an unknown revision is `target_missing` (never an empty tree or an
/// empty file). One constructor so `diff` and `diff_unified` report it with
/// the same message and `data`.
fn unknown_revision(doc_id: &str, rev_id: &str) -> crate::error::SurfaceError {
    crate::error::SurfaceError::with_data(
        "target_missing",
        format!(
            "no revision {} for document {doc_id}",
            Json::String(rev_id.to_owned())
        ),
        json!({ "doc": doc_id, "rev": rev_id }),
    )
}

/// The (block id → raw) map of a document at a revision, walking the Merkle
/// tree to every depth (insertion order = tree order, roots first). The
/// block grain of `diff`; not a rendering of the file (a container's raw
/// already holds its children's).
fn blocks_at_revision(
    conn: &Connection,
    doc_id: &str,
    rev_id: &str,
) -> Result<Vec<(String, String)>> {
    match blocks_at_known_revision(conn, doc_id, rev_id)? {
        Some(rows) => Ok(rows),
        None => Err(unknown_revision(doc_id, rev_id)),
    }
}

/// `None` when `rev_id` is not one of the doc's revisions (§9: an unknown
/// revision is `target_missing`, not an empty tree).
fn blocks_at_known_revision(
    conn: &Connection,
    doc_id: &str,
    rev_id: &str,
) -> Result<Option<Vec<(String, String)>>> {
    let root: Option<Vec<u8>> = conn
        .query_row(
            "SELECT root_tree FROM revisions WHERE rev_id = ?1 AND doc_id = ?2",
            params![rev_id, doc_id],
            |r| r.get(0),
        )
        .optional()?;
    let mut out: Vec<(String, String)> = Vec::new();
    let Some(root) = root else {
        return Ok(None);
    };
    fn walk(conn: &Connection, tree: &[u8], out: &mut Vec<(String, String)>) -> Result<()> {
        let entries: Option<String> = conn
            .query_row(
                "SELECT entries FROM tree_nodes WHERE hash = ?1",
                params![tree],
                |r| r.get(0),
            )
            .optional()?;
        let Some(text) = entries else {
            return Ok(());
        };
        for e in parse_tree_entries(&text)? {
            let raw = omgbase_store::read::blob_text(conn, &from_hex(&e.raw_hash_hex)?)?;
            match out.iter_mut().find(|(id, _)| *id == e.block_id) {
                Some(slot) => slot.1 = raw,
                None => out.push((e.block_id.clone(), raw)),
            }
            if let Some(child) = &e.child_tree_hash_hex {
                walk(conn, &from_hex(child)?, out)?;
            }
        }
        Ok(())
    }
    walk(conn, &root, &mut out)?;
    Ok(Some(out))
}

/// §3 `diff`: `removed`, `changed`, `added` entries in that order.
pub fn diff_blocks(store: &Store, doc_id: &str, from_rev: &str, to_rev: &str) -> Result<Json> {
    let before = blocks_at_revision(store.conn(), doc_id, from_rev)?;
    let after = blocks_at_revision(store.conn(), doc_id, to_rev)?;
    let after_map: HashMap<&str, &str> = after
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let before_map: HashMap<&str, &str> = before
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let mut entries = Vec::new();
    for (id, raw) in &before {
        match after_map.get(id.as_str()) {
            None => entries.push(json!({ "kind": "removed", "blockId": id, "before": raw })),
            Some(a) if *a != raw => {
                entries
                    .push(json!({ "kind": "changed", "blockId": id, "before": raw, "after": a }));
            }
            Some(_) => {}
        }
    }
    for (id, raw) in &after {
        if !before_map.contains_key(id.as_str()) {
            entries.push(json!({ "kind": "added", "blockId": id, "after": raw }));
        }
    }
    Ok(Json::Array(entries))
}

/// §3 `diff_unified`: a unified diff of the two revisions' reconstructed
/// files — what `docs_read_at` returns (`spec/store` §6.2: leading trivia,
/// the revision's frontmatter, then each top-level block's raw and trivia,
/// children not walked since a container's raw already holds them) — via
/// [`unified_diff`]. Diffing the block map instead (the rendering this
/// replaced: every live raw at every depth joined by `\n`) repeated each
/// list item once inside its container's raw and once as its own block, so
/// an appended bullet showed up twice, in two hunks. An unknown revision is
/// `target_missing` (§9), exactly as `diff` reports it.
pub fn diff_unified_text(
    store: &Store,
    doc_id: &str,
    from_rev: &str,
    to_rev: &str,
) -> Result<String> {
    let file_at = |rev: &str| -> Result<String> {
        store
            .read_at_revision(doc_id, rev)?
            .map(|r| r.content)
            .ok_or_else(|| unknown_revision(doc_id, rev))
    };
    Ok(unified_diff(&file_at(from_rev)?, &file_at(to_rev)?))
}

// ---- unified diff (spec/surface §3) ------------------------------------------
// A line-grain unified diff with a deterministic Myers script, so both engines
// (this port and the reference `packages/core/src/graph/history.ts`) produce
// the same bytes for the same two texts. Pure, so the unit tests pin it.

/// How a text becomes lines: `split('\n')` exactly — no trimming, no dropping
/// of a trailing empty element (a raw ending in `\n` yields one) — with a single
/// special case: the empty text has *no* lines (an empty file is zero lines,
/// not one empty line), so a diff from/to nothing is `@@ -0,0 +1,n @@`.
pub fn diff_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split('\n').collect()
    }
}

const DIFF_CONTEXT: usize = 3;

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

/// The unified diff of two texts (spec/surface §3): hunks of `DIFF_CONTEXT`
/// (3) lines of context; a change group extends to include the next change
/// when fewer than `2 * DIFF_CONTEXT + 1` unchanged lines separate them (the
/// two contexts touch or overlap). Each hunk is `@@ -a,b +c,d @@` (1-based
/// start and length; a length of 1 is written as the start alone; a length of
/// 0 as `a,0` with `a` the line before the insertion point, `0` at the very
/// top) followed by its lines prefixed `-`, `+` or a space with nothing after
/// the sign; hunks joined by `\n`; no file header; identical texts → `""`.
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

/// The two most recent revisions of a doc, newest first.
pub fn recent_revs(conn: &Connection, doc_id: &str) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT rev_id FROM revisions WHERE doc_id = ?1 ORDER BY seq DESC LIMIT 2")?;
    let rows = stmt.query_map(params![doc_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// A `docs` row: `(doc_id, path, current_rev, deleted_commit)`.
pub type DocRow = (String, String, Option<String>, Option<String>);

/// The `docs` row of a ref, looking through a tombstone when `include_deleted`.
pub fn resolve_doc_row(
    conn: &Connection,
    repo_id: &str,
    r: &str,
    include_deleted: bool,
) -> Result<Option<DocRow>> {
    type Row = DocRow;
    let by_id = |id: &str| -> Result<Option<Row>> {
        Ok(conn
            .query_row(
                "SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE doc_id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?)
    };
    if let Some(info) = find_doc_by_ref(conn, repo_id, r)? {
        return by_id(&info.doc_id);
    }
    if !include_deleted {
        return Ok(None);
    }
    if is_id_ref(r, "d") {
        return by_id(r);
    }
    Ok(conn
        .query_row(
            "SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE repo_id = ?1 AND path = ?2",
            params![repo_id, r],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?)
}

/// §3 `docs_history`: `{ docs: [{ docId, path, deleted, currentRev, versions }], truncated }`.
pub fn docs_history(
    store: &Store,
    repo_id: &str,
    path_glob: Option<&str>,
    doc: Option<&str>,
    include_deleted: bool,
    limit: Option<i64>,
) -> Result<Json> {
    let conn = store.conn();
    let limit = usize::try_from(limit.unwrap_or(50).max(0)).unwrap_or(0);
    type Row = (String, String, Option<String>, Option<String>);
    let mut doc_rows: Vec<Row> = if let Some(d) = doc {
        resolve_doc_row(conn, repo_id, d, include_deleted)?
            .into_iter()
            .collect()
    } else if let Some(glob) = path_glob {
        let deleted_clause = if include_deleted {
            ""
        } else {
            "AND deleted_commit IS NULL"
        };
        let (path_clause, param) = if glob.contains('*') {
            (
                "path LIKE ?2 ESCAPE '\\'",
                crate::context::glob_to_like(glob, false),
            )
        } else {
            ("path = ?2", glob.to_owned())
        };
        let sql = format!(
            "SELECT doc_id, path, current_rev, deleted_commit FROM docs WHERE repo_id = ?1 AND {path_clause} {deleted_clause} ORDER BY path LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![
                repo_id,
                param,
                i64::try_from(limit).unwrap_or(i64::MAX).saturating_add(1)
            ],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        return Err(crate::error::SurfaceError::other(
            "docHistory requires one of { doc, pathGlob }",
        ));
    };
    let truncated = doc_rows.len() > limit;
    doc_rows.truncate(limit);
    let mut rev_stmt = conn.prepare(
        "SELECT r.rev_id, r.seq, r.commit_id, r.rendered_hash, c.ts, c.origin, c.actor
         FROM revisions r JOIN commits c ON c.commit_id = r.commit_id
         WHERE r.doc_id = ?1 ORDER BY r.seq ASC",
    )?;
    let mut docs = Vec::new();
    for (doc_id, path, current_rev, deleted_commit) in doc_rows {
        let versions: Vec<Json> = rev_stmt
            .query_map(params![doc_id], |r| {
                let rev: String = r.get(0)?;
                let hash: Vec<u8> = r.get(3)?;
                Ok(json!({
                    "rev": rev,
                    "seq": r.get::<_, i64>(1)?,
                    "commit": r.get::<_, String>(2)?,
                    "ts": r.get::<_, String>(4)?,
                    "origin": r.get::<_, String>(5)?,
                    "actor": r.get::<_, Option<String>>(6)?,
                    "contentHash": hex(&hash),
                    "isCurrent": current_rev.as_deref() == Some(rev.as_str()),
                }))
            })?
            .collect::<std::result::Result<_, _>>()?;
        let mut m = Map::new();
        m.insert("docId".to_owned(), json!(doc_id));
        m.insert("path".to_owned(), json!(path));
        m.insert("deleted".to_owned(), json!(deleted_commit.is_some()));
        m.insert("currentRev".to_owned(), json!(current_rev));
        m.insert("versions".to_owned(), Json::Array(versions));
        docs.push(Json::Object(m));
    }
    Ok(json!({ "docs": docs, "truncated": truncated }))
}

// spec/surface §3 `diff_unified`. The expected strings below are copied
// verbatim from packages/core/src/graph/history.test.ts so the two engines pin
// each other byte for byte.
#[cfg(test)]
mod tests {
    use super::*;

    const EIGHT: &str = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8";
    const TWELVE: &str = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12";

    #[test]
    fn splits_on_newline_exactly_and_the_empty_text_has_no_lines() {
        assert_eq!(diff_lines("a\nb"), vec!["a", "b"]);
        assert_eq!(diff_lines("a\nb\n"), vec!["a", "b", ""]);
        assert_eq!(diff_lines(" a \n\n b "), vec![" a ", "", " b "]);
        assert_eq!(diff_lines(""), Vec::<&str>::new());
    }

    #[test]
    fn identical_texts_are_empty() {
        assert_eq!(unified_diff("a\nb\nc", "a\nb\nc"), "");
        assert_eq!(unified_diff("", ""), "");
    }

    #[test]
    fn insertion_in_the_middle_is_one_plus_line() {
        assert_eq!(
            unified_diff(EIGHT, "l1\nl2\nl3\nl4\nNEW\nl5\nl6\nl7\nl8"),
            "@@ -2,6 +2,7 @@\n l2\n l3\n l4\n+NEW\n l5\n l6\n l7"
        );
    }

    #[test]
    fn deletion() {
        assert_eq!(
            unified_diff(EIGHT, "l1\nl2\nl3\nl4\nl6\nl7\nl8"),
            "@@ -2,7 +2,6 @@\n l2\n l3\n l4\n-l5\n l6\n l7\n l8"
        );
    }

    #[test]
    fn replacement() {
        assert_eq!(
            unified_diff(EIGHT, "l1\nl2\nl3\nl4\nX5\nl6\nl7\nl8"),
            "@@ -2,7 +2,7 @@\n l2\n l3\n l4\n-l5\n+X5\n l6\n l7\n l8"
        );
    }

    #[test]
    fn change_at_top_and_bottom_truncates_context() {
        assert_eq!(
            unified_diff("l1\nl2\nl3\nl4\nl5", "L1\nl2\nl3\nl4\nl5"),
            "@@ -1,4 +1,4 @@\n-l1\n+L1\n l2\n l3\n l4"
        );
        assert_eq!(
            unified_diff("l1\nl2\nl3\nl4\nl5", "l1\nl2\nl3\nl4\nL5"),
            "@@ -2,4 +2,4 @@\n l2\n l3\n l4\n-l5\n+L5"
        );
    }

    #[test]
    fn far_changes_are_two_hunks_near_changes_share_one() {
        assert_eq!(
            unified_diff(TWELVE, "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nL12"),
            "@@ -1,4 +1,4 @@\n-l1\n+L1\n l2\n l3\n l4\n@@ -9,4 +9,4 @@\n l9\n l10\n l11\n-l12\n+L12"
        );
        assert_eq!(
            unified_diff(TWELVE, "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nL9\nl10\nl11\nl12"),
            "@@ -1,4 +1,4 @@\n-l1\n+L1\n l2\n l3\n l4\n@@ -6,7 +6,7 @@\n l6\n l7\n l8\n-l9\n+L9\n l10\n l11\n l12"
        );
    }

    #[test]
    fn hunk_merge_boundary_six_between_merges_seven_splits() {
        assert_eq!(
            unified_diff(
                "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10",
                "L1\nl2\nl3\nl4\nl5\nl6\nl7\nL8\nl9\nl10"
            ),
            "@@ -1,10 +1,10 @@\n-l1\n+L1\n l2\n l3\n l4\n l5\n l6\n l7\n-l8\n+L8\n l9\n l10"
        );
        assert_eq!(
            unified_diff(
                "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11",
                "L1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nL9\nl10\nl11"
            ),
            "@@ -1,4 +1,4 @@\n-l1\n+L1\n l2\n l3\n l4\n@@ -6,6 +6,6 @@\n l6\n l7\n l8\n-l9\n+L9\n l10\n l11"
        );
    }

    #[test]
    fn empty_old_and_empty_new_texts() {
        assert_eq!(unified_diff("", "a\nb\nc"), "@@ -0,0 +1,3 @@\n+a\n+b\n+c");
        assert_eq!(unified_diff("a\nb\nc", ""), "@@ -1,3 +0,0 @@\n-a\n-b\n-c");
    }

    #[test]
    fn insertion_at_the_very_top() {
        assert_eq!(
            unified_diff("a\nb", "z\na\nb"),
            "@@ -1,2 +1,3 @@\n+z\n a\n b"
        );
    }

    #[test]
    fn trailing_newline_and_empty_lines_are_lines() {
        assert_eq!(unified_diff("a\nb\n", "a\nb"), "@@ -1,3 +1,2 @@\n a\n b\n-");
        assert_eq!(
            unified_diff("a\n\nb", "a\n\n\nb"),
            "@@ -1,3 +1,4 @@\n a\n \n+\n b"
        );
    }

    // ---- diff_unified over a store --------------------------------------------
    // The bug this pins: a list container's raw already carries every item, so
    // diffing "every live raw at every depth" showed an appended bullet twice
    // (at the end of the container's raw, reading as an insertion before the
    // first item, then again after the last item block). The diff must be over
    // the reconstructed file, exactly what `docs_read_at` returns.

    use omgbase_reconcile::Config;
    use omgbase_store::SequentialMinter;

    const REV1: &str = "# Notes\n\n## Log\n\n- first\n\n- second\n";
    const REV2: &str = "# Notes\n\n## Log\n\n- first\n\n- second\n\n- third\n- fourth\n";
    const REV3: &str = "# Notes\n\n## Log\n\n- first\n\n- second\n\n- third\n- fourth\n- fifth\n";

    /// A store with `log.md` observed three times (a heading over a loose
    /// list, then a tight pair appended, then one more bullet); returns the
    /// store, the doc id and the three rev ids in order.
    fn log_doc_store() -> (Store, String, Vec<String>) {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut revs = Vec::new();
        let mut doc_id = String::new();
        for (i, source) in [REV1, REV2, REV3].iter().enumerate() {
            let ts = format!("2026-09-30T10:0{i}:00.000Z");
            let out = store
                .observe_one(&repo, "log.md", source, &ts, &Config::default())
                .unwrap();
            assert!(!out.echo, "revision {i} must commit");
            doc_id = out.doc_id;
            revs.push(out.rev.expect("a commit has a rev"));
        }
        (store, doc_id, revs)
    }

    #[test]
    fn diff_unified_is_over_the_reconstructed_file_not_the_block_map() {
        let (store, doc_id, revs) = log_doc_store();
        // The two sides are byte for byte what `docs_read_at` returns.
        for (rev, source) in revs.iter().zip([REV1, REV2, REV3]) {
            let read = store.read_at_revision(&doc_id, rev).unwrap().unwrap();
            assert_eq!(read.content, source);
            assert!(read.rendered_hash_match);
        }
        let diff = diff_unified_text(&store, &doc_id, &revs[1], &revs[2]).unwrap();
        assert_eq!(diff, unified_diff(REV2, REV3));
        // Exactly one hunk, one `+` line, no `-` lines, the bullet once and
        // after the previous last item.
        assert_eq!(diff.matches("@@").count(), 2, "one hunk header: {diff}");
        let lines: Vec<&str> = diff.lines().collect();
        let plus: Vec<&str> = lines
            .iter()
            .copied()
            .filter(|l| l.starts_with('+'))
            .collect();
        assert_eq!(plus, vec!["+- fifth"], "{diff}");
        assert!(!lines.iter().any(|l| l.starts_with('-')), "{diff}");
        assert_eq!(diff.matches("- fifth").count(), 1, "{diff}");
        let fourth = lines.iter().position(|l| *l == " - fourth").unwrap();
        let fifth = lines.iter().position(|l| *l == "+- fifth").unwrap();
        assert_eq!(fifth, fourth + 1, "{diff}");
        assert_eq!(diff, "@@ -8,4 +8,5 @@\n \n - third\n - fourth\n+- fifth\n ");
        // The first append (a tight pair onto a loose list) reads the same way.
        let first = diff_unified_text(&store, &doc_id, &revs[0], &revs[1]).unwrap();
        assert_eq!(first, unified_diff(REV1, REV2));
        assert_eq!(first.matches("- third").count(), 1, "{first}");
        assert_eq!(first.matches("- fourth").count(), 1, "{first}");
        assert_eq!(first.matches("@@").count(), 2, "one hunk header: {first}");
        // Same revision on both sides: nothing.
        assert_eq!(
            diff_unified_text(&store, &doc_id, &revs[2], &revs[2]).unwrap(),
            ""
        );
    }

    #[test]
    fn diff_unified_unknown_revision_is_target_missing_like_diff() {
        let (store, doc_id, revs) = log_doc_store();
        let err = diff_unified_text(&store, &doc_id, &revs[0], "rv_nope").unwrap_err();
        assert_eq!(err.code, "target_missing");
        assert_eq!(
            err.message,
            format!("no revision \"rv_nope\" for document {doc_id}")
        );
        assert_eq!(err.data, Some(json!({ "doc": doc_id, "rev": "rv_nope" })));
        // Byte-identical to what the block-grain `diff` reports.
        let block_err = diff_blocks(&store, &doc_id, &revs[0], "rv_nope").unwrap_err();
        assert_eq!(err, block_err);
    }

    #[test]
    fn textbook_tie_case() {
        let script: Vec<String> = myers_script(
            &diff_lines("a\nb\nc\na\nb\nb\na"),
            &diff_lines("c\nb\na\nb\na\nc"),
        )
        .into_iter()
        .map(|op| match op {
            EditOp::Keep(l) => format!(" {l}"),
            EditOp::Delete(l) => format!("-{l}"),
            EditOp::Insert(l) => format!("+{l}"),
        })
        .collect();
        assert_eq!(script.join("|"), "-a|-b| c|+b| a| b|-b| a|+c");
        assert_eq!(
            unified_diff("a\nb\nc\na\nb\nb\na", "c\nb\na\nb\na\nc"),
            "@@ -1,7 +1,6 @@\n-a\n-b\n c\n+b\n a\n b\n-b\n a\n+c"
        );
    }
}
