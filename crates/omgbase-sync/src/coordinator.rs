//! The coordinator (`spec/sync/README.md` §6): drives a source against an
//! engine client with no reconciliation logic of its own — whole-file bytes
//! in, the change feed out. Loop safety: the engine's echo gate makes a
//! written file that comes back an echo, and observed commits are never
//! exported.

use std::sync::mpsc::Receiver;

/// The storage form of a path the engine reported (`spec/surface` §1 "Paths",
/// 2.0: every path a tool returns is `/`-rooted; a source speaks the
/// repo-relative form). Every leading `/` is stripped.
fn storage_path(path: &str) -> String {
    path.trim_start_matches('/').to_owned()
}

use serde_json::Value;

use crate::engine::{EngineClient, FileBytes};
use crate::error::Result;
use crate::source::{SyncSource, WatchEvent};

/// What a `sync_in`/`reconcile` did, by path.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncInSummary {
    pub ingested: Vec<String>,
    /// Echoes: the bytes already matched, no commit.
    pub suppressed: Vec<String>,
    /// Ingested but carrying git conflict markers.
    pub conflicted: Vec<String>,
    /// Gone paths whose live doc was tombstoned.
    pub deleted: Vec<String>,
}

impl SyncInSummary {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "ingested": self.ingested,
            "suppressed": self.suppressed,
            "conflicted": self.conflicted,
            "deleted": self.deleted,
        })
    }
}

/// What a `sync_out` did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncOutSummary {
    /// The final feed cursor.
    pub cursor: i64,
    pub written: Vec<String>,
    pub removed: Vec<String>,
}

impl SyncOutSummary {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "cursor": self.cursor,
            "written": self.written,
            "removed": self.removed,
        })
    }
}

/// A source paired with an engine.
pub struct Coordinator<'a> {
    engine: &'a mut dyn EngineClient,
    source: &'a mut dyn SyncSource,
}

impl<'a> Coordinator<'a> {
    pub fn new(engine: &'a mut dyn EngineClient, source: &'a mut dyn SyncSource) -> Self {
        Self { engine, source }
    }

    /// source → engine: the source's full current scope.
    pub fn sync_in(&mut self) -> Result<SyncInSummary> {
        let paths: Vec<String> = self
            .source
            .enumerate()?
            .into_iter()
            .map(|e| e.path)
            .collect();
        self.reconcile(&paths)
    }

    /// source → engine for a set of paths: fetch each; present items go to
    /// `observe_many` in one call, gone paths to `observe_delete` one by one.
    pub fn reconcile(&mut self, paths: &[String]) -> Result<SyncInSummary> {
        let mut files: Vec<FileBytes> = Vec::new();
        let mut gone: Vec<String> = Vec::new();
        for path in paths {
            match self.source.fetch(path)? {
                Some(item) => files.push(FileBytes {
                    path: path.clone(),
                    content: item.content,
                }),
                None => gone.push(path.clone()),
            }
        }
        let mut summary = SyncInSummary::default();
        if !files.is_empty() {
            // The engine answers in the surface's reference form (`/a.md`,
            // `spec/surface` §1 "Paths", 2.0); a source speaks storage paths.
            for r in self.engine.observe_many(&files)? {
                let path = storage_path(&r.path);
                if r.echo {
                    summary.suppressed.push(path);
                } else if r.conflicted {
                    summary.conflicted.push(path);
                } else {
                    summary.ingested.push(path);
                }
            }
        }
        for path in gone {
            if self.engine.observe_delete(&path)?.deleted() {
                summary.deleted.push(path);
            }
        }
        Ok(summary)
    }

    /// engine → source: page `changes_since(cursor)`; for every digest whose
    /// origin is not `observed`, every revision's doc is re-read by path and
    /// written, or removed when it no longer reads; follows `truncated`
    /// pages; returns the final cursor. A source without write-through
    /// exports nothing and returns `cursor` unchanged.
    pub fn sync_out(&mut self, cursor: i64) -> Result<SyncOutSummary> {
        let mut summary = SyncOutSummary {
            cursor,
            ..SyncOutSummary::default()
        };
        if !self.source.capabilities().write_through {
            return Ok(summary);
        }
        let mut cur = cursor;
        loop {
            let page = self.engine.changes_since(cur, None, None)?;
            for digest in &page.digests {
                if digest.origin == "observed" {
                    continue;
                }
                for rev in &digest.revisions {
                    // `changes_since` reports the reference form; the source takes storage paths.
                    let path = storage_path(&rev.path);
                    match self.engine.read_doc(&path)? {
                        Some(doc) => {
                            self.source.write(&path, &doc.content)?;
                            summary.written.push(path);
                        }
                        None => {
                            self.source.remove(&path)?;
                            summary.removed.push(path);
                        }
                    }
                }
            }
            cur = page.cursor;
            if !page.truncated {
                break;
            }
        }
        summary.cursor = cur;
        Ok(summary)
    }

    /// Live source → engine: subscribe when the source can watch; `None`
    /// otherwise. The stream yields [`WatchEvent::Ready`] once the feed is
    /// primed (a host waits for it — [`crate::wait_ready`] — before its
    /// priming sweep, §5), then batches. Drive it with
    /// [`Coordinator::handle_batches`] or call [`Coordinator::reconcile`] per
    /// received batch.
    pub fn watch_in(&mut self) -> Result<Option<Receiver<WatchEvent>>> {
        if !self.source.capabilities().watch {
            return Ok(None);
        }
        Ok(Some(self.source.watch()?))
    }

    /// Reconcile every batch the stream yields until it closes (the adapter
    /// exited or `unwatch` ran), reporting each summary or error. `Ready` is
    /// not a batch and is skipped.
    pub fn handle_batches(
        &mut self,
        events: &Receiver<WatchEvent>,
        mut on_summary: impl FnMut(SyncInSummary),
        mut on_error: impl FnMut(crate::error::Error),
    ) {
        for event in events.iter() {
            let WatchEvent::Batch(paths) = event else {
                continue;
            };
            match self.reconcile(&paths) {
                Ok(s) => on_summary(s),
                Err(e) => on_error(e),
            }
        }
    }

    /// Stop the watch stream.
    pub fn stop_watch(&mut self) -> Result<()> {
        self.source.unwatch()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::InProcessEngineClient;
    use crate::source::{MemSource, SourceCapabilities};
    use omgbase_store::{NullDocStore, SequentialMinter, Store};

    const TS: &str = "2026-09-26T10:00:00.000Z";

    #[test]
    fn sync_in_reconcile_and_sync_out_round_trip() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut source = MemSource::with_files(&[("a.md", "# A\n\nOne.\n"), ("b.md", "# B\n")]);
        {
            let mut engine = InProcessEngineClient::new(&mut store, &repo).at(TS);
            let mut co = Coordinator::new(&mut engine, &mut source);
            let s = co.sync_in().unwrap();
            assert_eq!(s.ingested, ["a.md", "b.md"]);
            assert!(s.suppressed.is_empty() && s.deleted.is_empty() && s.conflicted.is_empty());
            // Again: everything echoes.
            let s = co.sync_in().unwrap();
            assert_eq!(s.suppressed, ["a.md", "b.md"]);
            assert_eq!(
                s.to_json()["suppressed"],
                serde_json::json!(["a.md", "b.md"])
            );
            // Observed commits are never exported.
            let out = co.sync_out(0).unwrap();
            assert_eq!(out.cursor, 2);
            assert!(out.written.is_empty() && out.removed.is_empty());
        }
        // An engine-authored (api) commit exports; a gone path deletes.
        let ctx = omgbase_store::DocOpContext {
            repo_id: repo.clone(),
            actor: Some("agent:test".into()),
            ts: TS.into(),
        };
        store
            .docs_create(&ctx, &mut NullDocStore, "authored.md", "# Authored\n", None)
            .unwrap();
        source.files.remove("b.md");
        source.set("c.md", "<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n");
        let out = {
            let mut engine = InProcessEngineClient::new(&mut store, &repo).at(TS);
            let mut co = Coordinator::new(&mut engine, &mut source);
            let s = co
                .reconcile(&["b.md".to_owned(), "c.md".to_owned(), "zzz.md".to_owned()])
                .unwrap();
            assert_eq!(s.deleted, ["b.md"]);
            assert_eq!(s.conflicted, ["c.md"]);
            co.sync_out(2).unwrap()
        };
        assert_eq!(out.written, ["authored.md"]);
        assert!(out.removed.is_empty());
        assert_eq!(out.cursor, 5);
        assert_eq!(source.files["authored.md"], "# Authored\n");
        assert_eq!(source.log.len(), 1);
        assert_eq!(out.to_json()["cursor"], 5);
        // The written file comes back as an echo: the loop terminates.
        {
            let mut engine = InProcessEngineClient::new(&mut store, &repo).at(TS);
            let mut co = Coordinator::new(&mut engine, &mut source);
            let s = co.reconcile(&["authored.md".to_owned()]).unwrap();
            assert_eq!(s.suppressed, ["authored.md"]);
            assert_eq!(co.sync_out(5).unwrap().cursor, 5);
        }
    }

    #[test]
    fn sync_out_removes_tombstoned_docs_and_pages() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut source = MemSource::with_files(&[]);
        // 60 api commits via docs_create so paging (limit 50) is exercised.
        let ctx = omgbase_store::DocOpContext {
            repo_id: repo.clone(),
            actor: Some("t".into()),
            ts: TS.into(),
        };
        for i in 0..60 {
            store
                .docs_create(
                    &ctx,
                    &mut NullDocStore,
                    &format!("n{i:02}.md"),
                    "# N\n",
                    None,
                )
                .unwrap();
        }
        store
            .docs_delete(&ctx, &mut NullDocStore, "n00.md")
            .unwrap();
        let out = {
            let mut engine = InProcessEngineClient::new(&mut store, &repo).at(TS);
            let mut co = Coordinator::new(&mut engine, &mut source);
            co.sync_out(0).unwrap()
        };
        assert_eq!(out.cursor, 61);
        assert_eq!(out.written.len(), 59);
        assert_eq!(out.removed, ["n00.md"]);
        assert_eq!(source.files.len(), 59);
        // Read-only source: nothing exported, cursor unchanged.
        let mut ro = MemSource::new(SourceCapabilities::default());
        let mut engine = InProcessEngineClient::new(&mut store, &repo).at(TS);
        let mut co = Coordinator::new(&mut engine, &mut ro);
        assert_eq!(
            co.sync_out(3).unwrap(),
            SyncOutSummary {
                cursor: 3,
                ..SyncOutSummary::default()
            }
        );
        assert!(co.watch_in().unwrap().is_none());
    }

    #[test]
    fn watch_in_reconciles_batches() {
        let mut store = Store::open_in_memory().unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut source = MemSource::with_files(&[("a.md", "# A\n")]);
        let rx = {
            let mut engine = InProcessEngineClient::new(&mut store, &repo);
            let mut co = Coordinator::new(&mut engine, &mut source);
            co.watch_in().unwrap().expect("watching source")
        };
        source.emit(&["a.md"]);
        source.emit(&["gone.md"]);
        // Stopping the watch drops the sender, so the stream ends.
        source.unwatch().unwrap();
        let mut engine = InProcessEngineClient::new(&mut store, &repo);
        let mut co = Coordinator::new(&mut engine, &mut source);
        let mut summaries = Vec::new();
        co.handle_batches(&rx, |s| summaries.push(s), |e| panic!("{e}"));
        assert_eq!(summaries.len(), 2, "the leading `Ready` is not a batch");
        assert_eq!(summaries[0].ingested, ["a.md"]);
        assert!(
            summaries[1].deleted.is_empty(),
            "nothing was live at gone.md"
        );
        co.stop_watch().unwrap();
    }
}
