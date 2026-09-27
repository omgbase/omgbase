//! Ignored by default: ingest a large real corpus through the priming-sweep
//! path (`freshness_sweep` over `RealFileSystem`) with the **production**
//! random minter into a temporary workspace. This is the proof behind
//! `spec/store` §2.1 "Uniqueness at mint" (13.5): before the in-use check a
//! 3,000-document corpus (about 360,000 blocks) failed with `UNIQUE
//! constraint failed: blocks.block_id`, where the birthday bound over 32⁷
//! ids predicts it. Run with
//!
//! ```text
//! OMGBENCH_SRC=/path/to/corpus cargo test -p omgbase-sync --release \
//!     --test ingest_corpus -- --ignored --nocapture
//! ```
//!
//! `OMGBENCH_SRC` defaults to `/tmp/omgbench/src`.

use std::path::Path;
use std::time::Instant;

use omgbase_reconcile::Config;
use omgbase_sync::fs::TempDir;
use omgbase_sync::{RealFileSystem, Workspace, freshness_sweep, now_ts, registry};

fn count(store: &omgbase_store::Store, sql: &str) -> i64 {
    store.conn().query_row(sql, [], |r| r.get(0)).expect(sql)
}

#[test]
#[ignore = "needs a corpus at OMGBENCH_SRC (default /tmp/omgbench/src) and takes minutes"]
fn ingests_a_large_corpus_with_the_random_minter() {
    let src = std::env::var("OMGBENCH_SRC").unwrap_or_else(|_| "/tmp/omgbench/src".to_owned());
    let src = Path::new(&src);
    assert!(src.is_dir(), "no corpus at {}", src.display());

    let tmp = TempDir::new("ingest-corpus");
    let mut ws = Workspace::open(tmp.path()).expect("workspace opens with the production minter");
    let store = ws.store_mut();
    let repo_id = registry::ensure_repo(store, "bench", src.to_str()).expect("repo");

    let started = Instant::now();
    let result = freshness_sweep(
        store,
        &repo_id,
        &RealFileSystem,
        src,
        &now_ts(),
        None,
        &Config::default(),
    )
    .expect("the sweep ingests every file without a collision");
    let elapsed = started.elapsed();

    let live_docs = count(
        store,
        "SELECT COUNT(*) FROM docs WHERE deleted_commit IS NULL",
    );
    let live_blocks = count(
        store,
        "SELECT COUNT(*) FROM blocks WHERE deleted_commit IS NULL",
    );
    let all_blocks = count(store, "SELECT COUNT(*) FROM blocks");
    eprintln!(
        "swept {} files at {}: {} ingested, {} conflicted, {} deleted; {live_docs} live docs, \
         {live_blocks} live blocks ({all_blocks} rows) in {:.1}s",
        result.scanned,
        src.display(),
        result.checkpoint.ingested.len(),
        result.checkpoint.conflicted.len(),
        result.checkpoint.deleted.len(),
        elapsed.as_secs_f64(),
    );

    assert!(result.scanned > 0, "the corpus has files");
    assert_eq!(result.checkpoint.ingested.len(), result.scanned);
    assert!(result.checkpoint.conflicted.is_empty());
    assert_eq!(live_docs, i64::try_from(result.scanned).unwrap());
    if let Ok(want) = std::env::var("OMGBENCH_EXPECT_DOCS") {
        assert_eq!(live_docs.to_string(), want, "OMGBENCH_EXPECT_DOCS");
    }
    assert!(live_blocks > 0);
}
