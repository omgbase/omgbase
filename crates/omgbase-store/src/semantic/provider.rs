//! The default [`SemanticProvider`]: today's `search` module behind the
//! trait, call for call (`docs/modular-core/README.md` §6).

use rusqlite::{Connection, OptionalExtension, params};

use crate::core::capabilities::{DocEmbedStats, EmbedStats, ForeignVectors, SemanticProvider};
use crate::error::Result;
use crate::semantic::search::{
    block_vector, build_doc_embed_tasks, build_embed_tasks, embed_process, embed_process_docs,
    prune_foreign_vectors,
};

/// The provider over the store's own `embeddings` / `doc_embeddings` caches.
#[derive(Clone, Copy, Debug, Default)]
pub struct Provider;

impl SemanticProvider for Provider {
    fn attach(&self, conn: &Connection) -> Result<()> {
        crate::semantic::cosine::register(conn)
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

    fn prune_foreign(&self, conn: &Connection, model: &str) -> Result<ForeignVectors> {
        prune_foreign_vectors(conn, model)
    }
}
