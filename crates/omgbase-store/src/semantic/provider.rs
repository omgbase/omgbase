//! The default [`SemanticProvider`]: the `search` module behind the trait
//! (`docs/modular-core/README.md` §6), plus the indexer of Phase 2 — the
//! watermark-positioned drain (bootstrap / catch-up / rescan), the rebuild,
//! the freshness report and the queue.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};

use crate::Store;
use crate::core::capabilities::{DocEmbedStats, EmbedStats, ForeignVectors, SemanticProvider};
use crate::core::semantic_shapes::{
    DocVectorHit, DrainMode, DrainOutcome, DrainStats, HybridHit, HybridQuery, IndexIdentity,
    PrunedVectors, QueryVector, ResolveHit, SemanticFreshness, SemanticQueue, VectorHit,
};
use crate::error::Result;
use crate::semantic::search::{
    block_vector, build_doc_embed_tasks, build_doc_embed_tasks_for_docs, build_embed_tasks,
    build_embed_tasks_for_doc, doc_heads, doc_vector_search, embed_process, embed_process_docs,
    embed_process_docs_at, foreign_vector_count, hybrid_search, live_docs, prune_foreign_vectors,
    prune_gone, prune_gone_docs, resolve, stale_blocks, stale_docs, vector_search,
};
use crate::semantic::watermark::{self, Watermark};

/// The provider over the store's own `embeddings` / `doc_embeddings` caches.
#[derive(Clone, Copy, Debug, Default)]
pub struct Provider;

/// The tables the bundle owns (`spec/store` 17.0 §1.4.3).
pub const TABLES: &[&str] = &["embeddings", "doc_embeddings"];

/// A catch-up re-scans at most this many documents; beyond it a full pass is
/// cheaper than per-document task building (and the feed page walk).
pub const CATCH_UP_MAX_DOCS: usize = 500;

/// The feed page the catch-up walks by.
const FEED_PAGE: usize = 200;

/// The repository's feed head (`spec/store` §3.1 `feed`, 17.0 D7): the
/// core's `max(seq)` of the current epoch, 0 when nothing committed.
fn feed_head(store: &Store, repo_id: &str) -> Result<i64> {
    Ok(store.feed_status(repo_id)?.head)
}

/// The documents the feed names after `cursor`, or `None` when the cursor
/// cannot be served (`expired_cursor`: it lies beyond the head — a restore, a
/// rebuild-from-files — or the feed was pruned past it, D7) or the set
/// outgrew [`CATCH_UP_MAX_DOCS`].
fn touched_since(store: &Store, repo_id: &str, cursor: i64) -> Result<Option<HashSet<String>>> {
    let mut touched = HashSet::new();
    let mut at = cursor;
    loop {
        let page = match store.changes_since(
            repo_id,
            &crate::core::feed::ChangesSinceOptions {
                cursor: at,
                limit: FEED_PAGE,
                ..crate::core::feed::ChangesSinceOptions::default()
            },
        ) {
            Ok(page) => page,
            Err(crate::error::Error::ExpiredCursor(_)) => return Ok(None),
            Err(e) => return Err(e),
        };
        for d in &page.digests {
            for r in &d.revisions {
                touched.insert(r.doc.clone());
            }
            at = d.seq;
        }
        if touched.len() > CATCH_UP_MAX_DOCS {
            return Ok(None);
        }
        if !page.truncated {
            return Ok(Some(touched));
        }
    }
}

/// One full pass (the §2.6 drain as it always ran): the block pass, then the
/// document pass under the late-result rule, both built from one read
/// snapshot of the head.
fn full_pass(
    conn: &Connection,
    repo_id: &str,
    provider: &dyn omgbase_search::EmbeddingProvider,
) -> Result<DrainStats> {
    let (block_tasks, doc_tasks, heads) = {
        // One read transaction: the tasks and the heads they were built
        // from describe the same instant of the head.
        let tx = conn.unchecked_transaction()?;
        let block_tasks = build_embed_tasks(&tx, repo_id)?;
        let doc_tasks = build_doc_embed_tasks(&tx, repo_id)?;
        let heads = doc_heads(&tx, &doc_tasks)?;
        tx.commit()?;
        (block_tasks, doc_tasks, heads)
    };
    let blocks = embed_process(conn, &block_tasks, provider)?;
    let docs = embed_process_docs_at(conn, &doc_tasks, provider, Some(&heads))?;
    Ok(DrainStats { blocks, docs })
}

/// The catch-up pass over `touched`: the live ones are re-tasked by
/// themselves, the deleted ones lose their document vector.
fn catch_up_pass(
    conn: &Connection,
    touched: &HashSet<String>,
    provider: &dyn omgbase_search::EmbeddingProvider,
) -> Result<(DrainStats, usize)> {
    let live = live_docs(conn, touched)?;
    let (block_tasks, doc_tasks, heads) = {
        let tx = conn.unchecked_transaction()?;
        let mut block_tasks = Vec::new();
        for id in &live {
            block_tasks.extend(build_embed_tasks_for_doc(&tx, id)?);
        }
        let doc_tasks = build_doc_embed_tasks_for_docs(&tx, &live)?;
        let heads = doc_heads(&tx, &doc_tasks)?;
        tx.commit()?;
        (block_tasks, doc_tasks, heads)
    };
    let blocks = embed_process(conn, &block_tasks, provider)?;
    let docs = embed_process_docs_at(conn, &doc_tasks, provider, Some(&heads))?;
    Ok((DrainStats { blocks, docs }, live.len()))
}

/// Where a drain stands before it runs: the identity it embeds under, the
/// head it will stamp, how it found its position and (a catch-up's) the
/// documents to re-scan.
struct Position {
    identity: IndexIdentity,
    head: i64,
    mode: DrainMode,
    touched: Option<HashSet<String>>,
}

impl Provider {
    /// The drain at `position`: the pass, the prune a rescan owes, the
    /// document-vector sweep every pass owes (S1's cheap half), then the
    /// watermark at the head under the identity.
    fn run(
        &self,
        store: &Store,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
        position: Position,
    ) -> Result<DrainOutcome> {
        let Position {
            identity,
            head,
            mode,
            touched,
        } = position;
        let conn = store.conn();
        let (stats, docs_rescanned) = match (mode, touched) {
            (DrainMode::CatchUp, Some(touched)) => {
                let (stats, n) = catch_up_pass(conn, &touched, provider)?;
                (stats, Some(n))
            }
            _ => (full_pass(conn, repo_id, provider)?, None),
        };
        let pruned = match mode {
            DrainMode::Rescan => prune_gone(conn, &identity.model)?,
            DrainMode::Bootstrap | DrainMode::CatchUp => PrunedVectors {
                blocks: 0,
                docs: prune_gone_docs(conn, &identity.model)?,
            },
        };
        watermark::write(
            conn,
            repo_id,
            &Watermark {
                processed_seq: head,
                index: identity,
            },
        )?;
        Ok(DrainOutcome {
            stats,
            mode,
            pruned,
            processed_seq: head,
            docs_rescanned,
        })
    }
}

impl SemanticProvider for Provider {
    fn attach(&self, conn: &Connection) -> Result<()> {
        crate::semantic::cosine::register(conn)
    }

    fn tables(&self) -> &'static [&'static str] {
        TABLES
    }

    /// The surface's `require_rankable` probe (`spec/surface` §4, 3.0): a
    /// document vector of the repository under `model`, or any block vector
    /// under it.
    fn available(&self, conn: &Connection, repo_id: &str, model: &str) -> Result<bool> {
        let any: Option<i64> = conn
            .query_row(
                "SELECT 1 WHERE EXISTS (SELECT 1 FROM doc_embeddings de JOIN docs d ON d.doc_id = de.doc_id WHERE d.repo_id = ?1 AND de.model = ?2) OR EXISTS (SELECT 1 FROM embeddings WHERE model = ?2)",
                params![repo_id, model],
                |r| r.get(0),
            )
            .optional()?;
        Ok(any.is_some())
    }

    fn block_vector(
        &self,
        conn: &Connection,
        block_id: &str,
        model: &str,
    ) -> Result<Option<Vec<u8>>> {
        block_vector(conn, block_id, model)
    }

    fn doc_vector(&self, conn: &Connection, doc_id: &str, model: &str) -> Result<Option<Vec<u8>>> {
        Ok(conn
            .query_row(
                "SELECT vec FROM doc_embeddings WHERE doc_id = ?1 AND model = ?2",
                params![doc_id, model],
                |r| r.get(0),
            )
            .optional()?)
    }

    fn vector_search(
        &self,
        conn: &Connection,
        repo_id: &str,
        model: &str,
        query: &[f32],
        limit: usize,
    ) -> Result<Vec<VectorHit>> {
        vector_search(conn, repo_id, model, query, limit)
    }

    fn doc_vector_search(
        &self,
        conn: &Connection,
        repo_id: &str,
        model: &str,
        query: &[f32],
        limit: usize,
    ) -> Result<Vec<DocVectorHit>> {
        doc_vector_search(conn, repo_id, model, query, limit)
    }

    fn hybrid_search(
        &self,
        conn: &Connection,
        repo_id: &str,
        q: &HybridQuery,
    ) -> Result<Vec<HybridHit>> {
        hybrid_search(conn, repo_id, q)
    }

    fn resolve(
        &self,
        conn: &Connection,
        repo_id: &str,
        query: &str,
        vector: Option<QueryVector>,
        limit: Option<usize>,
    ) -> Result<Vec<ResolveHit>> {
        resolve(conn, repo_id, query, vector, limit)
    }

    fn embed(
        &self,
        conn: &Connection,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<EmbedStats> {
        embed_process(conn, &build_embed_tasks(conn, repo_id)?, provider)
    }

    fn embed_docs(
        &self,
        conn: &Connection,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<DocEmbedStats> {
        embed_process_docs(conn, &build_doc_embed_tasks(conn, repo_id)?, provider)
    }

    /// The position rule: no watermark, or one under another identity →
    /// **bootstrap**; the watermark at the head → a catch-up over nothing
    /// (the watermark is re-stamped); behind the head → **catch-up** over
    /// the documents the feed names since it, when the cursor is served and
    /// the set is bounded; otherwise **rescan**.
    fn drain(
        &self,
        store: &Store,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<DrainOutcome> {
        let conn = store.conn();
        let identity = IndexIdentity::of(provider);
        // The head first: a commit landing after this read is beyond the
        // watermark and the next drain's, whether or not this pass saw it.
        let head = feed_head(store, repo_id)?;
        let mark = watermark::read(conn, repo_id)?;
        let (mode, touched) = match mark {
            Some(m) if m.index == identity => {
                if m.processed_seq > head {
                    (DrainMode::Rescan, None)
                } else {
                    match touched_since(store, repo_id, m.processed_seq)? {
                        Some(t) => (DrainMode::CatchUp, Some(t)),
                        None => (DrainMode::Rescan, None),
                    }
                }
            }
            _ => (DrainMode::Bootstrap, None),
        };
        self.run(
            store,
            repo_id,
            provider,
            Position {
                identity,
                head,
                mode,
                touched,
            },
        )
    }

    fn rebuild(
        &self,
        store: &Store,
        repo_id: &str,
        provider: &dyn omgbase_search::EmbeddingProvider,
    ) -> Result<DrainOutcome> {
        let head = feed_head(store, repo_id)?;
        watermark::invalidate(store.conn(), repo_id)?;
        self.run(
            store,
            repo_id,
            provider,
            Position {
                identity: IndexIdentity::of(provider),
                head,
                mode: DrainMode::Rescan,
                touched: None,
            },
        )
    }

    fn freshness(
        &self,
        store: &Store,
        repo_id: &str,
        index: Option<&IndexIdentity>,
    ) -> Result<SemanticFreshness> {
        let head = feed_head(store, repo_id)?;
        let mark = watermark::read(store.conn(), repo_id)?;
        let fresh = mark
            .as_ref()
            .is_some_and(|m| m.processed_seq == head && index.is_none_or(|i| *i == m.index));
        Ok(SemanticFreshness {
            processed_seq: mark.as_ref().map(|m| m.processed_seq),
            head,
            index: mark.map(|m| m.index),
            fresh,
        })
    }

    fn queue(
        &self,
        conn: &Connection,
        repo_id: &str,
        model: Option<&str>,
    ) -> Result<SemanticQueue> {
        let tasks = build_embed_tasks(conn, repo_id)?;
        let doc_tasks = build_doc_embed_tasks(conn, repo_id)?;
        Ok(SemanticQueue {
            embeddable: tasks.len(),
            stale_blocks: stale_blocks(conn, &tasks, model)?.len(),
            docs: doc_tasks.len(),
            stale_docs: stale_docs(conn, &doc_tasks, model)?.len(),
        })
    }

    fn foreign(&self, conn: &Connection, model: &str) -> Result<ForeignVectors> {
        foreign_vector_count(conn, model)
    }

    fn prune_foreign(&self, conn: &Connection, model: &str) -> Result<ForeignVectors> {
        prune_foreign_vectors(conn, model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BatchItem, SequentialMinter, Store};
    use omgbase_reconcile::Config;
    use omgbase_search::{EmbeddingProvider, FIXTURE_MODEL, FixtureEmbedder};

    const TS: &str = "2026-09-27T00:00:00.000Z";

    /// Twenty-plus words: clears `should_embed`.
    fn para(tag: &str) -> String {
        format!(
            "{tag} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.\n"
        )
    }

    fn observe(store: &mut Store, repo: &str, path: &str, body: &str) {
        store
            .observe_batch(
                repo,
                &[BatchItem {
                    path: path.to_owned(),
                    source: Some(body.to_owned()),
                }],
                TS,
                &Config::default(),
            )
            .unwrap();
    }

    fn delete(store: &mut Store, repo: &str, path: &str) {
        store
            .observe_batch(
                repo,
                &[BatchItem {
                    path: path.to_owned(),
                    source: None,
                }],
                TS,
                &Config::default(),
            )
            .unwrap();
    }

    fn fresh() -> (Store, String) {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("r").unwrap();
        (store, repo)
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// A provider that embeds like the fixture one but under another name.
    struct Renamed(&'static str);

    impl EmbeddingProvider for Renamed {
        fn model(&self) -> &str {
            self.0
        }

        fn dim(&self) -> usize {
            FixtureEmbedder.dim()
        }

        fn max_input_tokens(&self) -> Option<u32> {
            FixtureEmbedder.max_input_tokens()
        }

        fn embed(&self, texts: &[String]) -> omgbase_search::Result<Vec<Vec<f32>>> {
            FixtureEmbedder.embed(texts)
        }
    }

    #[test]
    fn bootstrap_then_catch_up_then_fresh() {
        let (mut store, repo) = fresh();
        let p = Provider;
        observe(
            &mut store,
            &repo,
            "a.md",
            &format!("# A\n\n{}", para("one")),
        );
        observe(
            &mut store,
            &repo,
            "b.md",
            &format!("# B\n\n{}", para("two")),
        );
        let none = p.freshness(&store, &repo, None).unwrap();
        assert_eq!(none.processed_seq, None);
        assert_eq!(none.head, 2);
        assert!(!none.fresh);

        let d = p.drain(&store, &repo, &FixtureEmbedder).unwrap();
        assert_eq!(d.mode, DrainMode::Bootstrap);
        assert_eq!(d.processed_seq, 2);
        assert_eq!(d.docs_rescanned, None);
        assert_eq!(d.stats.blocks.embedded, 2);
        assert_eq!(d.stats.docs.embedded, 2);
        assert_eq!(d.stats.docs.skipped, 0);
        let f = p
            .freshness(&store, &repo, Some(&IndexIdentity::of(&FixtureEmbedder)))
            .unwrap();
        assert_eq!(f.processed_seq, Some(2));
        assert!(f.fresh);
        assert_eq!(f.index.unwrap().model, FIXTURE_MODEL);

        // One document changes: the catch-up re-scans it alone.
        observe(
            &mut store,
            &repo,
            "b.md",
            &format!("# B\n\n{}", para("three")),
        );
        let f = p.freshness(&store, &repo, None).unwrap();
        assert!(!f.fresh, "head 3 > processed 2");
        let d = p.drain(&store, &repo, &FixtureEmbedder).unwrap();
        assert_eq!(d.mode, DrainMode::CatchUp);
        assert_eq!(d.docs_rescanned, Some(1));
        assert_eq!(d.stats.blocks.embedded, 1, "the rewritten paragraph");
        assert_eq!(d.stats.docs.embedded, 1);
        assert_eq!(d.processed_seq, 3);
        assert!(p.freshness(&store, &repo, None).unwrap().fresh);

        // Nothing changed: a catch-up over nothing re-stamps the head.
        let d = p.drain(&store, &repo, &FixtureEmbedder).unwrap();
        assert_eq!((d.mode, d.docs_rescanned), (DrainMode::CatchUp, Some(0)));
        assert_eq!(d.stats, DrainStats::default());
        let q = p.queue(store.conn(), &repo, Some(FIXTURE_MODEL)).unwrap();
        assert_eq!(
            q,
            SemanticQueue {
                embeddable: 2,
                stale_blocks: 0,
                docs: 2,
                stale_docs: 0
            }
        );
    }

    #[test]
    fn a_deleted_document_loses_its_vector_on_catch_up() {
        let (mut store, repo) = fresh();
        let p = Provider;
        observe(
            &mut store,
            &repo,
            "a.md",
            &format!("# A\n\n{}", para("one")),
        );
        observe(
            &mut store,
            &repo,
            "b.md",
            &format!("# B\n\n{}", para("two")),
        );
        p.drain(&store, &repo, &FixtureEmbedder).unwrap();
        assert_eq!(
            count(store.conn(), "SELECT count(*) FROM doc_embeddings"),
            2
        );
        delete(&mut store, &repo, "b.md");
        let d = p.drain(&store, &repo, &FixtureEmbedder).unwrap();
        assert_eq!(d.mode, DrainMode::CatchUp);
        assert_eq!(d.pruned.docs, 1, "S1's document half runs on every pass");
        assert_eq!(d.pruned.blocks, 0, "block vectors wait for a rescan");
        assert_eq!(
            count(store.conn(), "SELECT count(*) FROM doc_embeddings"),
            1
        );
        assert_eq!(count(store.conn(), "SELECT count(*) FROM embeddings"), 2);
    }

    #[test]
    fn an_expired_cursor_rescans_and_prunes_gone_vectors() {
        let (mut store, repo) = fresh();
        let p = Provider;
        observe(
            &mut store,
            &repo,
            "a.md",
            &format!("# A\n\n{}", para("one")),
        );
        observe(
            &mut store,
            &repo,
            "b.md",
            &format!("# B\n\n{}", para("two")),
        );
        p.drain(&store, &repo, &FixtureEmbedder).unwrap();
        delete(&mut store, &repo, "b.md");
        // The watermark says further than the feed goes (a restore).
        watermark::write(
            store.conn(),
            &repo,
            &Watermark {
                processed_seq: 99,
                index: IndexIdentity::of(&FixtureEmbedder),
            },
        )
        .unwrap();
        let d = p.drain(&store, &repo, &FixtureEmbedder).unwrap();
        assert_eq!(d.mode, DrainMode::Rescan);
        assert_eq!(d.pruned, PrunedVectors { blocks: 1, docs: 1 });
        assert_eq!(d.processed_seq, 3);
        assert_eq!(count(store.conn(), "SELECT count(*) FROM embeddings"), 1);
        assert_eq!(
            count(store.conn(), "SELECT count(*) FROM doc_embeddings"),
            1
        );
    }

    #[test]
    fn a_model_change_invalidates_the_watermark_and_rebuild_forces_the_rescan() {
        let (mut store, repo) = fresh();
        let p = Provider;
        observe(
            &mut store,
            &repo,
            "a.md",
            &format!("# A\n\n{}", para("one")),
        );
        p.drain(&store, &repo, &FixtureEmbedder).unwrap();
        let other = Renamed("other-8");
        assert!(
            !p.freshness(&store, &repo, Some(&IndexIdentity::of(&other)))
                .unwrap()
                .fresh,
            "fresh only under the identity the watermark was written for"
        );
        let d = p.drain(&store, &repo, &other).unwrap();
        assert_eq!(d.mode, DrainMode::Bootstrap);
        assert_eq!(
            d.stats.blocks.embedded, 1,
            "re-embedded under the new model"
        );
        assert_eq!(
            p.foreign(store.conn(), "other-8").unwrap(),
            ForeignVectors { blocks: 1, docs: 1 },
            "the old model's vectors stay until pruned on request (§2.6)"
        );
        assert_eq!(
            watermark::read(store.conn(), &repo)
                .unwrap()
                .unwrap()
                .index
                .model,
            "other-8"
        );
        let d = p.rebuild(&store, &repo, &other).unwrap();
        assert_eq!(d.mode, DrainMode::Rescan);
        assert_eq!(d.stats.blocks.cached, 1);
        assert_eq!(
            p.prune_foreign(store.conn(), "other-8").unwrap(),
            ForeignVectors { blocks: 1, docs: 1 }
        );
    }

    #[test]
    fn a_late_document_vector_is_never_published() {
        let (mut store, repo) = fresh();
        observe(
            &mut store,
            &repo,
            "a.md",
            &format!("# A\n\n{}", para("one")),
        );
        let tasks = build_doc_embed_tasks(store.conn(), &repo).unwrap();
        let heads = doc_heads(store.conn(), &tasks).unwrap();
        // The document moves on between the snapshot and the write.
        observe(
            &mut store,
            &repo,
            "a.md",
            &format!("# A\n\n{}", para("two")),
        );
        let s =
            embed_process_docs_at(store.conn(), &tasks, &FixtureEmbedder, Some(&heads)).unwrap();
        assert_eq!((s.embedded, s.skipped), (0, 1));
        assert_eq!(
            count(store.conn(), "SELECT count(*) FROM doc_embeddings"),
            0
        );
        // Without a snapshot the full-pass form writes (the §2.4 input_hash
        // marks the row stale on read).
        let s = embed_process_docs(store.conn(), &tasks, &FixtureEmbedder).unwrap();
        assert_eq!((s.embedded, s.skipped), (1, 0));
    }
}
