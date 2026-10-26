//! The legacy-bytes REPAIR (`spec/store` §5.11 "The repair"; `spec/sync` §4.3
//! step 5; store 17.4 / sync 4.4 — modular-core Phase 5a-ii, finding F1). A
//! document the `legacy_bytes` alert names has the right `raw`s and the wrong
//! (missing) separators (`omgbase_store::legacy_bytes`). When its file is
//! present and `sha256(file) == docs.file_hash` — the bytes the store already
//! agrees with (I1) — the sweep rewrites the SEPARATOR columns from the file's
//! parse and nothing else: `blocks.trivia`/`trivia_hash` per block,
//! `docs.leading_trivia` and `frontmatter_trivia`. Every block keeps its id
//! (the parse must have the stored tree's exact shape, types and `raw`s —
//! identical texts map to the same ids positionally, no matcher involved),
//! the head stays (content, structure, path and liveness did not change — D1),
//! no feed row, no revision, no change to `updated_at`: the recorder's
//! captured head stays the 16.x capture (legacy fidelity — `docs_read { at:
//! <head> }` renders the legacy bytes with `rendered_hash_match: false`, as it
//! did through 16.x). Port of `packages/core/src/sync/legacy-bytes.ts`.

use std::collections::HashMap;

use omgbase_format::hash::sha256;
use omgbase_format::{Block, BlockKind, parse_path};
use omgbase_store::Store;
use omgbase_store::read::reconstruct;
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::Result;

/// Why a named document was not repaired by this sweep (`spec/sync` §4.3 step 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacyRepairOutcome {
    /// The separators were rewritten; `sha256(reconstruct) == file_hash` holds again.
    Repaired,
    /// The parse of the file does not have the rows' shape, types, `raw`s or
    /// frontmatter raw — not a pure separator loss; the document stays listed.
    StructureDiffers,
    /// The rewrite did not make the rows reproduce the file (rolled back); the
    /// document stays listed.
    NotReproduced,
}

struct StoredRow {
    block_id: String,
    parent_block: Option<String>,
    ordinal: i64,
    kind: String,
    raw: String,
}

/// Pair every stored block with the parsed block at the same position, or
/// `None` when the trees differ in shape, type or `raw` anywhere.
fn pair_positionally<'a>(
    rows: &[StoredRow],
    parsed: &'a [Block],
) -> Option<Vec<(String, &'a Block)>> {
    let mut children: HashMap<Option<&str>, Vec<&StoredRow>> = HashMap::new();
    for r in rows {
        children
            .entry(r.parent_block.as_deref())
            .or_default()
            .push(r);
    }
    for list in children.values_mut() {
        list.sort_by_key(|r| r.ordinal);
    }
    let mut out = Vec::new();
    fn walk<'a>(
        children: &HashMap<Option<&str>, Vec<&StoredRow>>,
        parent: Option<&str>,
        blocks: &'a [Block],
        out: &mut Vec<(String, &'a Block)>,
    ) -> bool {
        let empty = Vec::new();
        let stored = children.get(&parent).unwrap_or(&empty);
        if stored.len() != blocks.len() {
            return false;
        }
        for (s, b) in stored.iter().zip(blocks) {
            if s.kind != b.kind.as_str() || s.raw != b.raw {
                return false;
            }
            out.push((s.block_id.clone(), b));
            if !walk(children, Some(s.block_id.as_str()), &b.children, out) {
                return false;
            }
        }
        true
    }
    if !walk(&children, None, parsed, &mut out) {
        return None;
    }
    (out.len() == rows.len()).then_some(out)
}

/// Repair one legacy document from `content` — the file's bytes, which the
/// caller has checked hash to the document's `file_hash`. One transaction; a
/// rewrite that does not make the rows reproduce the file is rolled back.
/// Writes no feed row, no head, no timestamp.
pub fn repair_legacy_bytes(
    store: &Store,
    doc_id: &str,
    path: &str,
    content: &str,
) -> Result<LegacyRepairOutcome> {
    let tx = store.transaction()?;
    let doc: Option<(String, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT leading_trivia, frontmatter_raw, frontmatter_trivia FROM docs WHERE doc_id = ?1 AND deleted_at IS NULL",
            params![doc_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((_, frontmatter_raw, _)) = doc else {
        return Ok(LegacyRepairOutcome::StructureDiffers);
    };
    let tree = parse_path(path, content);
    let (fm_block, rest) = match tree.children.first() {
        Some(b) if b.kind == BlockKind::Frontmatter => (Some(b), &tree.children[1..]),
        _ => (None, &tree.children[..]),
    };
    if fm_block.map(|b| b.raw.as_str()) != frontmatter_raw.as_deref() {
        return Ok(LegacyRepairOutcome::StructureDiffers);
    }
    let rows: Vec<StoredRow> = {
        let mut stmt = tx.prepare(
            "SELECT block_id, parent_block, ordinal, type, raw FROM blocks WHERE doc_id = ?1 AND deleted_at IS NULL",
        )?;
        let it = stmt.query_map(params![doc_id], |r| {
            Ok(StoredRow {
                block_id: r.get(0)?,
                parent_block: r.get(1)?,
                ordinal: r.get(2)?,
                kind: r.get(3)?,
                raw: r.get(4)?,
            })
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let Some(pairs) = pair_positionally(&rows, rest) else {
        return Ok(LegacyRepairOutcome::StructureDiffers);
    };
    rewrite_separators(
        &tx,
        doc_id,
        &tree.leading_trivia,
        fm_block.map(|b| b.trivia.as_str()),
        &pairs,
    )?;
    let after = reconstruct(&tx, doc_id)?;
    let reproduced = after.is_some_and(|a| sha256(a.as_bytes()) == sha256(content.as_bytes()));
    if !reproduced {
        tx.rollback()?;
        return Ok(LegacyRepairOutcome::NotReproduced);
    }
    tx.commit()?;
    Ok(LegacyRepairOutcome::Repaired)
}

/// The separator columns, and nothing else: `leading_trivia`,
/// `frontmatter_trivia`, every block's `trivia`/`trivia_hash` (NULL when empty
/// — `spec/store` §8 C2).
fn rewrite_separators(
    conn: &Connection,
    doc_id: &str,
    leading_trivia: &str,
    frontmatter_trivia: Option<&str>,
    pairs: &[(String, &Block)],
) -> Result<()> {
    conn.execute(
        "UPDATE docs SET leading_trivia = ?1, frontmatter_trivia = ?2 WHERE doc_id = ?3",
        params![leading_trivia, frontmatter_trivia, doc_id],
    )?;
    let mut upd = conn.prepare(
        "UPDATE blocks SET trivia = ?1, trivia_hash = ?2 WHERE block_id = ?3 AND doc_id = ?4",
    )?;
    for (block_id, block) in pairs {
        let trivia = (!block.trivia.is_empty()).then_some(block.trivia.as_str());
        let hash = trivia.map(|t| sha256(t.as_bytes()).to_vec());
        upd.execute(params![trivia, hash, block_id, doc_id])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Mirrors `packages/core/src/core/store/legacy-bytes.test.ts`'s repair
    // half over the in-memory filesystem: the sweep repairs the rows from the
    // file (ids, head, `updated_at` and the feed unchanged, the alert
    // cleared), a missing file stays listed, a diverged file is re-ingested,
    // a parse whose structure differs is refused and changes nothing.
    use super::*;
    use crate::freshness::freshness_sweep;
    use crate::fs::MemFileSystem;
    use omgbase_reconcile::Config;
    use omgbase_store::legacy_bytes::{refresh_legacy_bytes_alert, unreproducible_docs};
    use omgbase_store::{Alert, SequentialMinter, list_active_alerts};
    use std::path::Path;

    const T0: &str = "2026-10-26T10:00:00.000Z";
    const T5: &str = "2026-10-26T10:05:00.000Z";
    const T6: &str = "2026-10-26T10:06:00.000Z";
    const ROOT: &str = "/r";
    const A: &str = "# A\n\nAlpha paragraph about apples.\n\n- one\n- two\n";
    const B: &str = "# B\n\nBeta paragraph about bees.\n";

    struct Doc {
        doc_id: String,
        head: String,
        file_hash: Vec<u8>,
        updated_at: String,
    }

    fn doc_of(store: &Store, path: &str) -> Doc {
        store
            .conn()
            .query_row(
                "SELECT doc_id, head, file_hash, updated_at FROM docs WHERE path = ?1 AND deleted_at IS NULL",
                params![path],
                |r| {
                    Ok(Doc {
                        doc_id: r.get(0)?,
                        head: r.get(1)?,
                        file_hash: r.get(2)?,
                        updated_at: r.get(3)?,
                    })
                },
            )
            .unwrap()
    }

    fn block_ids(store: &Store, doc_id: &str) -> Vec<String> {
        let mut stmt = store
            .conn()
            .prepare("SELECT block_id FROM blocks WHERE doc_id = ?1 ORDER BY ordinal, parent_block")
            .unwrap();
        stmt.query_map(params![doc_id], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap()
    }

    fn rows_of(store: &Store, doc_id: &str) -> Vec<(String, Option<String>)> {
        let mut stmt = store
            .conn()
            .prepare("SELECT block_id, trivia FROM blocks WHERE doc_id = ?1 ORDER BY block_id")
            .unwrap();
        stmt.query_map(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap()
    }

    fn count(store: &Store, table: &str) -> i64 {
        store
            .conn()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn erase_separators(store: &Store, doc_id: &str) {
        store
            .conn()
            .execute(
                "UPDATE blocks SET trivia = NULL, trivia_hash = NULL WHERE doc_id = ?1",
                params![doc_id],
            )
            .unwrap();
    }

    /// A swept repository with `a.md` and `b.md`.
    fn seeded() -> (Store, String, MemFileSystem) {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut fs = MemFileSystem::new();
        fs.set("a.md", A, 1);
        fs.set("b.md", B, 1);
        freshness_sweep(
            &mut store,
            &repo,
            &fs,
            Path::new(ROOT),
            T0,
            &Config::default(),
        )
        .unwrap();
        (store, repo, fs)
    }

    fn active(store: &Store, repo: &str) -> Vec<Alert> {
        list_active_alerts(store.conn(), repo).unwrap()
    }

    fn active_codes(store: &Store, repo: &str) -> Vec<String> {
        active(store, repo).iter().map(|a| a.code.clone()).collect()
    }

    #[test]
    fn the_sweep_repairs_the_rows_from_the_file_ids_head_updated_at_and_the_feed_unchanged_the_alert_cleared()
     {
        let (mut store, repo, fs) = seeded();
        let a = doc_of(&store, "a.md");
        let ids = block_ids(&store, &a.doc_id);
        let feed = count(&store, "feed");
        erase_separators(&store, &a.doc_id);
        // The migration's on-open check, by hand.
        refresh_legacy_bytes_alert(store.conn(), &repo, T0, None).unwrap();
        assert_eq!(active_codes(&store, &repo), ["legacy_bytes"]);
        let r = freshness_sweep(
            &mut store,
            &repo,
            &fs,
            Path::new(ROOT),
            T5,
            &Config::default(),
        )
        .unwrap();
        assert_eq!(r.repaired, ["a.md"]);
        assert!(r.batch.ingested.is_empty());
        assert!(r.changed);
        assert_eq!(r.to_json()["repaired"], serde_json::json!(["a.md"]));
        assert_eq!(store.reconstruct(&a.doc_id).unwrap().as_deref(), Some(A));
        let after = doc_of(&store, "a.md");
        assert_eq!(after.head, a.head);
        assert_eq!(after.updated_at, a.updated_at);
        assert_eq!(after.file_hash, a.file_hash);
        assert_eq!(block_ids(&store, &a.doc_id), ids);
        assert_eq!(count(&store, "feed"), feed);
        assert!(active_codes(&store, &repo).is_empty());
        // C2 holds again: trivia_hash == sha256(trivia), both NULL or neither.
        let rows: Vec<(Option<String>, Option<Vec<u8>>)> = {
            let mut stmt = store
                .conn()
                .prepare("SELECT trivia, trivia_hash FROM blocks WHERE doc_id = ?1")
                .unwrap();
            stmt.query_map(params![a.doc_id], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .collect::<std::result::Result<_, _>>()
                .unwrap()
        };
        for (trivia, hash) in rows {
            match trivia {
                None => assert!(hash.is_none()),
                Some(t) => assert_eq!(hash.unwrap(), sha256(t.as_bytes()).to_vec()),
            }
        }
        // A later sweep has nothing to do and the alert stays cleared.
        let again = freshness_sweep(
            &mut store,
            &repo,
            &fs,
            Path::new(ROOT),
            T6,
            &Config::default(),
        )
        .unwrap();
        assert!(again.repaired.is_empty());
        assert!(!again.changed);
        assert!(active_codes(&store, &repo).is_empty());
    }

    #[test]
    fn a_document_whose_file_is_gone_stays_listed_one_whose_file_diverged_is_re_ingested_not_repaired()
     {
        let (mut store, repo, mut fs) = seeded();
        let a = doc_of(&store, "a.md");
        let b = doc_of(&store, "b.md");
        erase_separators(&store, &a.doc_id);
        erase_separators(&store, &b.doc_id);
        // b's file left without the cache noticing (no deletion to observe),
        // a's file moved on.
        store
            .conn()
            .execute("DELETE FROM file_stats WHERE path = 'b.md'", [])
            .unwrap();
        fs.remove("b.md");
        fs.set("a.md", &A.replace("apples", "pears"), 2);
        let listed = refresh_legacy_bytes_alert(store.conn(), &repo, T0, None).unwrap();
        assert_eq!(
            listed.iter().map(|d| d.doc_id.as_str()).collect::<Vec<_>>(),
            [a.doc_id.as_str(), b.doc_id.as_str()]
        );
        let r = freshness_sweep(
            &mut store,
            &repo,
            &fs,
            Path::new(ROOT),
            T5,
            &Config::default(),
        )
        .unwrap();
        assert_eq!(r.batch.ingested, ["a.md"]);
        assert!(r.repaired.is_empty());
        assert_ne!(doc_of(&store, "a.md").head, a.head);
        let active = active(&store, &repo);
        assert_eq!(
            serde_json::Value::Object(active[0].detail.clone()),
            serde_json::json!({ "docs": 1, "sample": [b.doc_id] })
        );
        assert_eq!(unreproducible_docs(store.conn(), &repo).unwrap().len(), 1);
    }

    #[test]
    fn the_repair_refuses_a_parse_whose_structure_differs_from_the_rows_and_changes_nothing() {
        let (store, _repo, _fs) = seeded();
        let a = doc_of(&store, "a.md");
        erase_separators(&store, &a.doc_id);
        let before = rows_of(&store, &a.doc_id);
        assert_eq!(
            repair_legacy_bytes(&store, &a.doc_id, "a.md", &A.replace("apples", "pears")).unwrap(),
            LegacyRepairOutcome::StructureDiffers
        );
        assert_eq!(
            repair_legacy_bytes(&store, &a.doc_id, "a.md", &format!("---\nk: v\n---\n{A}"))
                .unwrap(),
            LegacyRepairOutcome::StructureDiffers
        );
        assert_eq!(
            repair_legacy_bytes(
                &store,
                &a.doc_id,
                "a.md",
                "# A\n\nAlpha paragraph about apples.\n"
            )
            .unwrap(),
            LegacyRepairOutcome::StructureDiffers,
            "fewer blocks"
        );
        assert_eq!(rows_of(&store, &a.doc_id), before);
        assert_eq!(
            repair_legacy_bytes(&store, &a.doc_id, "a.md", A).unwrap(),
            LegacyRepairOutcome::Repaired
        );
        assert_eq!(store.reconstruct(&a.doc_id).unwrap().as_deref(), Some(A));
        // A tombstoned or unknown document is `structure_differs`.
        assert_eq!(
            repair_legacy_bytes(&store, "d_nope", "a.md", A).unwrap(),
            LegacyRepairOutcome::StructureDiffers
        );
    }

    #[test]
    fn a_frontmatter_document_is_repaired_with_its_separator() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut fs = MemFileSystem::new();
        let src = "---\nk: v\n---\n\n# F\n\nBody.\n";
        fs.set("f.md", src, 1);
        freshness_sweep(
            &mut store,
            &repo,
            &fs,
            Path::new(ROOT),
            T0,
            &Config::default(),
        )
        .unwrap();
        let f = doc_of(&store, "f.md");
        erase_separators(&store, &f.doc_id);
        store
            .conn()
            .execute(
                "UPDATE docs SET frontmatter_trivia = NULL WHERE doc_id = ?1",
                params![f.doc_id],
            )
            .unwrap();
        assert_ne!(store.reconstruct(&f.doc_id).unwrap().as_deref(), Some(src));
        assert_eq!(
            repair_legacy_bytes(&store, &f.doc_id, "f.md", src).unwrap(),
            LegacyRepairOutcome::Repaired
        );
        assert_eq!(store.reconstruct(&f.doc_id).unwrap().as_deref(), Some(src));
        let fm_trivia: Option<String> = store
            .conn()
            .query_row(
                "SELECT frontmatter_trivia FROM docs WHERE doc_id = ?1",
                params![f.doc_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fm_trivia.as_deref(), Some("\n\n"));
    }
}
