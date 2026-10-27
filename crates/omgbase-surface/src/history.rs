//! History (`spec/surface/README.md` §3): `docs_history` composed over the
//! repository's [`HistoryReader`] — the native recorder's rows, or an attached
//! provider's (the git history provider, 6.4 — Phase 6a) — and the unified
//! diff both engines pin byte for byte (re-exported from the store, where the
//! recorder and the git provider diff with it). `blocks_history`, `docs_diff`
//! and `docs_diff_unified` are the reader's own methods since Phase 6a
//! (`omgbase_store::HistoryReader`); `changes_since` is the store's. Port of
//! `packages/core/src/graph/history.ts`.

use omgbase_format::hash::hex;
use omgbase_store::{HistoryReader, Store, is_id_ref};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::error::Result;
use crate::paths::{reference_path, storage_path};
use crate::read::find_doc_by_ref;

// The unified diff (spec/surface §3): a line-grain diff over a deterministic
// Myers script, so both engines produce the same bytes for the same two texts.
// It lives in the store since Phase 6a (the git provider diffs two blobs with
// it); re-exported here so the surface and its tests pin it as before.
pub use omgbase_store::diff::{EditOp, diff_lines, myers_script, unified_diff};

/// A `docs` row: `(doc_id, path, head, deleted_at)`.
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
                "SELECT doc_id, path, head, deleted_at FROM docs WHERE doc_id = ?1",
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
            "SELECT doc_id, path, head, deleted_at FROM docs WHERE repo_id = ?1 AND path = ?2",
            params![repo_id, storage_path(r)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?)
}

/// §3 `docs_history`: `{ docs: [{ _id, _path, deleted, currentRev, versions }],
/// truncated, coverage }` — each version a `revisions` row under the row's
/// own names (§1.2, 5.0): `_rev _seq _commit _ts _origin _actor _hash
/// _is_current _archived` (through 4.11 `rev seq commit updated_at origin
/// actor hash isCurrent archived`), plus `retained` (6.2, resolution 11): the
/// current head is ALWAYS listed — `retained: false` with `_seq` null and the
/// feed row's commit/ts/origin/actor when the reader has no version for it
/// (minted while capture was off, purged, or — Phase 6a — not yet
/// checkpointed by a provider's worker); `coverage` the repository's history
/// coverage intervals. The versions are the `reader`'s
/// ([`HistoryReader::doc_versions`]): the recorder's rows (answering on a
/// database without the bundle too — every head unretained), or the git
/// provider's commits. The reference's `docHistory`.
pub fn docs_history(
    store: &Store,
    reader: &dyn HistoryReader,
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
            "AND deleted_at IS NULL"
        };
        // The glob is spelled in either path form; the column holds the storage form.
        let glob = storage_path(glob);
        let (path_clause, param) = if glob.contains('*') {
            (
                "path LIKE ?2 ESCAPE '\\'",
                crate::context::glob_to_like(glob, false),
            )
        } else {
            ("path = ?2", glob.to_owned())
        };
        let sql = format!(
            "SELECT doc_id, path, head, deleted_at FROM docs WHERE repo_id = ?1 AND {path_clause} {deleted_clause} ORDER BY path LIMIT ?3"
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
    // An unretained head's commit, from the feed row that minted it (the
    // core's record; null once the feed pruned it).
    let mut head_feed = conn.prepare(
        "SELECT f.commit_id, f.ts, f.origin, f.actor FROM feed_entries e JOIN feed f ON f.repo_id = e.repo_id AND f.epoch = e.epoch AND f.seq = e.seq
         WHERE e.head = ?1 ORDER BY e.rowid DESC LIMIT 1",
    )?;
    let mut head_row = conn.prepare("SELECT file_hash, updated_at FROM docs WHERE doc_id = ?1")?;
    let mut docs = Vec::new();
    for (doc_id, path, head, deleted_at) in doc_rows {
        let mut versions: Vec<Json> = reader
            .doc_versions(conn, &doc_id, head.as_deref())?
            .iter()
            .map(omgbase_store::DocVersion::to_json)
            .collect();
        // Resolution 11 (Phase 4b): the current head is ALWAYS listed —
        // unretained when the reader has no version for it (minted while
        // capture was off, purged, or not yet checkpointed), with what the
        // core knows: the feed row that minted it, the document's `file_hash`
        // and `updated_at`.
        if let Some(h) = &head
            && !versions
                .iter()
                .any(|v| v.get("_rev").and_then(Json::as_str) == Some(h.as_str()))
        {
            type FeedHead = (String, String, String, Option<String>);
            let feed: Option<FeedHead> = head_feed
                .query_row(params![h], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .optional()?;
            let (file_hash, updated_at): (Vec<u8>, String) =
                head_row.query_row(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            versions.push(json!({
                "_rev": h,
                "_seq": Json::Null,
                "_commit": feed.as_ref().map(|f| f.0.clone()),
                "_ts": feed.as_ref().map_or(updated_at, |f| f.1.clone()),
                "_origin": feed.as_ref().map(|f| f.2.clone()),
                "_actor": feed.as_ref().and_then(|f| f.3.clone()),
                "_hash": hex(&file_hash),
                "_is_current": true,
                "_archived": false,
                "retained": false,
            }));
        }
        let mut m = Map::new();
        m.insert("_id".to_owned(), json!(doc_id));
        m.insert("_path".to_owned(), json!(reference_path(&path)));
        m.insert("deleted".to_owned(), json!(deleted_at.is_some()));
        m.insert("currentRev".to_owned(), json!(head));
        m.insert("versions".to_owned(), Json::Array(versions));
        docs.push(Json::Object(m));
    }
    let coverage: Vec<Json> = omgbase_store::read_capability(conn, repo_id, "history")?
        .map(|r| r.coverage)
        .unwrap_or_default()
        .iter()
        .map(|i| json!({ "from": i.from, "to": i.to }))
        .collect();
    Ok(json!({ "docs": docs, "truncated": truncated, "coverage": coverage }))
}

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

    // ---- docs_diff_unified over a store --------------------------------------------
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
        let reader = store.history().unwrap();
        let diff = reader
            .diff_unified(store.conn(), &doc_id, &revs[1], &revs[2])
            .unwrap();
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
        let first = reader
            .diff_unified(store.conn(), &doc_id, &revs[0], &revs[1])
            .unwrap();
        assert_eq!(first, unified_diff(REV1, REV2));
        assert_eq!(first.matches("- third").count(), 1, "{first}");
        assert_eq!(first.matches("- fourth").count(), 1, "{first}");
        assert_eq!(first.matches("@@").count(), 2, "one hunk header: {first}");
        // Same revision on both sides: nothing.
        assert_eq!(
            reader
                .diff_unified(store.conn(), &doc_id, &revs[2], &revs[2])
                .unwrap(),
            ""
        );
    }

    #[test]
    fn diff_unified_unknown_revision_is_target_missing_like_diff() {
        let (store, doc_id, revs) = log_doc_store();
        let reader = store.history().unwrap();
        let err = crate::error::SurfaceError::from(
            reader
                .diff_unified(store.conn(), &doc_id, &revs[0], "rv_nope")
                .unwrap_err(),
        );
        assert_eq!(err.code, "target_missing");
        assert_eq!(
            err.message,
            format!("no revision \"rv_nope\" for document {doc_id}")
        );
        assert_eq!(err.data, Some(json!({ "doc": doc_id, "rev": "rv_nope" })));
        // Byte-identical to what the block-grain `diff` reports.
        let block_err = crate::error::SurfaceError::from(
            reader
                .diff_blocks(store.conn(), &doc_id, &revs[0], "rv_nope")
                .unwrap_err(),
        );
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
