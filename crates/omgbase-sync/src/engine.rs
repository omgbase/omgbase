//! The engine client (`spec/sync/README.md` §6): the coordinator's view of
//! "the omgbase side" — `observe_many`, `observe_delete`, `changes_since`,
//! `read_doc` — behind one trait so the same coordinator runs against an
//! in-process store or a remote server. The in-process client is here; a
//! remote client belongs to the binary that speaks MCP.

use omgbase_format::hash::hex;
use omgbase_reconcile::Config;
use omgbase_store::{BatchItem, BatchOutcome, ChangesPage, DeleteOutcome, ObserveOutcome, Store};
use rusqlite::{OptionalExtension, params};

use crate::error::{Error, Result};

/// Bytes to observe at a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileBytes {
    pub path: String,
    pub content: String,
}

impl FileBytes {
    #[must_use]
    pub fn new(path: &str, content: &str) -> Self {
        Self {
            path: path.to_owned(),
            content: content.to_owned(),
        }
    }
}

/// A document's current bytes and hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocBytes {
    pub content: String,
    /// Hex of the doc's `file_hash` (`""` when null).
    pub content_hash: String,
}

/// The default `changes_since` page size.
pub const DEFAULT_LIMIT: usize = 50;

/// Everything the reconcile loop needs from the engine.
pub trait EngineClient {
    /// Observe whole-file bytes as observed commits (echo-suppressed
    /// engine-side), one batch, then sweep the pool.
    fn observe_many(&mut self, files: &[FileBytes]) -> Result<Vec<ObserveOutcome>>;
    /// Mirror a source-side deletion (tombstone, then sweep).
    fn observe_delete(&mut self, path: &str) -> Result<DeleteOutcome>;
    /// The repo's change feed after `cursor` (§6).
    fn changes_since(
        &mut self,
        cursor: i64,
        limit: Option<usize>,
        origin: Option<&str>,
    ) -> Result<ChangesPage>;
    /// The current bytes at `path`, or `None` when no live doc reads there.
    fn read_doc(&mut self, path: &str) -> Result<Option<DocBytes>>;
    /// Release the connection (the store's lifetime is the caller's).
    fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

/// The in-process client over an open store: each call is timestamped by
/// `clock` (the wall clock by default; a fixture pins it).
pub struct InProcessEngineClient<'a> {
    store: &'a mut Store,
    repo_id: String,
    config: Config,
    clock: Box<dyn FnMut() -> String + 'a>,
}

impl std::fmt::Debug for InProcessEngineClient<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InProcessEngineClient")
            .field("repo_id", &self.repo_id)
            .finish_non_exhaustive()
    }
}

impl<'a> InProcessEngineClient<'a> {
    #[must_use]
    pub fn new(store: &'a mut Store, repo_id: &str) -> Self {
        Self {
            store,
            repo_id: repo_id.to_owned(),
            config: Config::default(),
            clock: Box::new(crate::now_ts),
        }
    }

    /// The matcher thresholds every observe uses.
    #[must_use]
    pub fn with_config(mut self, config: Config) -> Self {
        self.config = config;
        self
    }

    /// Replace the wall clock.
    #[must_use]
    pub fn with_clock(mut self, clock: impl FnMut() -> String + 'a) -> Self {
        self.clock = Box::new(clock);
        self
    }

    /// Every call at one fixed timestamp.
    #[must_use]
    pub fn at(self, ts: &str) -> Self {
        let ts = ts.to_owned();
        self.with_clock(move || ts.clone())
    }

    #[must_use]
    pub fn store(&self) -> &Store {
        self.store
    }

    #[must_use]
    pub fn repo_id(&self) -> &str {
        &self.repo_id
    }
}

impl EngineClient for InProcessEngineClient<'_> {
    fn observe_many(&mut self, files: &[FileBytes]) -> Result<Vec<ObserveOutcome>> {
        let ts = (self.clock)();
        let items: Vec<BatchItem> = files
            .iter()
            .map(|f| BatchItem::observed(&f.path, &f.content))
            .collect();
        let outcomes = self
            .store
            .observe_batch(&self.repo_id, &items, &ts, &self.config)?;
        let mut out = Vec::with_capacity(outcomes.len());
        for o in outcomes {
            match o {
                BatchOutcome::Observed(ob) => out.push(ob),
                BatchOutcome::Deleted(d) => {
                    return Err(Error::Other(format!(
                        "observe_many: unexpected outcome for {}",
                        d.path
                    )));
                }
            }
        }
        self.store.sweep_pool(&ts)?;
        Ok(out)
    }

    fn observe_delete(&mut self, path: &str) -> Result<DeleteOutcome> {
        let ts = (self.clock)();
        Ok(self.store.observe_delete(&self.repo_id, path, &ts)?)
    }

    fn changes_since(
        &mut self,
        cursor: i64,
        limit: Option<usize>,
        origin: Option<&str>,
    ) -> Result<ChangesPage> {
        Ok(self.store.changes_since(
            &self.repo_id,
            cursor,
            limit.unwrap_or(DEFAULT_LIMIT),
            origin,
        )?)
    }

    fn read_doc(&mut self, path: &str) -> Result<Option<DocBytes>> {
        let row: Option<(String, Option<Vec<u8>>)> = self
            .store
            .conn()
            .query_row(
                "SELECT doc_id, file_hash FROM docs WHERE repo_id = ?1 AND path = ?2 AND deleted_commit IS NULL",
                params![self.repo_id, path],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((doc_id, file_hash)) = row else {
            return Ok(None);
        };
        let Some(content) = self.store.reconstruct(&doc_id)? else {
            return Ok(None);
        };
        Ok(Some(DocBytes {
            content,
            content_hash: file_hash.as_deref().map(hex).unwrap_or_default(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_store::SequentialMinter;

    const TS: &str = "2026-09-26T10:00:00.000Z";

    #[test]
    fn in_process_client_round_trip() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut client = InProcessEngineClient::new(&mut store, &repo).at(TS);
        assert_eq!(client.repo_id(), "rp_0");
        let out = client
            .observe_many(&[
                FileBytes::new("a.md", "# A\n"),
                FileBytes::new("b.md", "# B\n"),
            ])
            .unwrap();
        assert_eq!(out.len(), 2);
        assert!(!out[0].echo && out[0].converged);
        let again = client
            .observe_many(&[FileBytes::new("a.md", "# A\n")])
            .unwrap();
        assert!(again[0].echo);
        let doc = client.read_doc("a.md").unwrap().unwrap();
        assert_eq!(doc.content, "# A\n");
        assert_eq!(
            doc.content_hash,
            hex(&omgbase_format::hash::sha256(b"# A\n"))
        );
        assert!(client.read_doc("zzz.md").unwrap().is_none());
        let d = client.observe_delete("b.md").unwrap();
        assert!(d.deleted());
        assert!(!client.observe_delete("b.md").unwrap().deleted());
        assert!(client.read_doc("b.md").unwrap().is_none());
        let page = client.changes_since(0, None, None).unwrap();
        assert_eq!(page.digests.len(), 3);
        assert_eq!(page.head, 3);
        assert_eq!(page.digests[2].origin, "observed");
        assert!(
            page.digests[2].revisions.is_empty(),
            "a tombstone writes no revision"
        );
        let one = client.changes_since(0, Some(1), None).unwrap();
        assert!(one.truncated);
        assert_eq!(client.store().user_version().unwrap(), 13);
        client.close().unwrap();
        drop(client);
        let commits: Vec<String> = {
            let mut stmt = store
                .conn()
                .prepare("SELECT ts FROM commits ORDER BY seq")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert!(
            commits.iter().all(|t| t == TS),
            "the pinned clock stamps every commit"
        );
    }
}
