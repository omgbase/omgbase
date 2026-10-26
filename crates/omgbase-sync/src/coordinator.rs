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

use omgbase_format::hash::{hex, sha256};
use omgbase_store::FeedEntryKind;
use serde_json::{Map, Value};

use crate::engine::{EngineClient, FileBytes};
use crate::error::{Error, Result};
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
    /// The feed's epoch the cursor belongs to (§6, 4.0); a consumer stores
    /// both. `None` when no page was read (a read-only source).
    pub epoch: Option<String>,
    pub written: Vec<String>,
    pub removed: Vec<String>,
    /// Set when the feed had expired the cursor and the rescan procedure
    /// (§6) ran before resuming.
    pub rescanned: bool,
}

impl SyncOutSummary {
    /// `{ cursor, epoch, written, removed, rescanned? }` — `rescanned` only
    /// when true, as the reference spells it.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("cursor".to_owned(), Value::from(self.cursor));
        m.insert(
            "epoch".to_owned(),
            self.epoch.clone().map_or(Value::Null, Value::String),
        );
        m.insert("written".to_owned(), serde_json::json!(self.written));
        m.insert("removed".to_owned(), serde_json::json!(self.removed));
        if self.rescanned {
            m.insert("rescanned".to_owned(), Value::Bool(true));
        }
        Value::Object(m)
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

    /// engine → source: page the change feed from `(epoch, cursor)` (through
    /// `truncated`), skipping observed-origin commits (they originated from a
    /// source — §6), and apply each digest's documents by `kind`:
    /// `created`/`changed`/`moved` → read the doc by path and `write` at
    /// `_path` (a `moved` also `remove`s `from_path`); `deleted` → `remove`.
    /// When the feed has **expired** the cursor (another epoch, past the head,
    /// pruned behind the oldest retained row — `spec/surface` §3
    /// `expired_cursor`) the rescan procedure of §6 runs — the server's live
    /// documents are listed and the source reconverged to them — and the walk
    /// resumes from the error's `head` under its `epoch`, once per call. A
    /// source without write-through exports nothing and returns `cursor`
    /// unchanged.
    pub fn sync_out(&mut self, cursor: i64, epoch: Option<&str>) -> Result<SyncOutSummary> {
        let mut summary = SyncOutSummary {
            cursor,
            epoch: epoch.map(str::to_owned),
            ..SyncOutSummary::default()
        };
        if !self.source.capabilities().write_through {
            return Ok(summary);
        }
        let mut cur = cursor;
        let mut ep: Option<String> = epoch.map(str::to_owned);
        loop {
            let page = match self.engine.changes_since(cur, ep.as_deref(), None, None) {
                Ok(page) => page,
                Err(Error::FeedExpired { epoch, head, .. }) if !summary.rescanned => {
                    // The rescan (§6): record S = head and E = epoch from the
                    // error, reconverge the source to the server's live
                    // documents, resume from (E, S). Once per call: a second
                    // expiry means the bootstrap lease (the retention floor)
                    // did not hold and the caller retries.
                    let (written, removed) = self.rescan()?;
                    summary.written.extend(written);
                    summary.removed.extend(removed);
                    cur = head;
                    ep = Some(epoch);
                    summary.rescanned = true;
                    continue;
                }
                Err(e) => return Err(e),
            };
            for digest in &page.digests {
                if digest.origin == "observed" {
                    continue;
                }
                for rev in &digest.revisions {
                    // `changes_since` reports the reference form; the source
                    // takes storage paths.
                    let path = storage_path(&rev.path);
                    if rev.kind == FeedEntryKind::Moved
                        && let Some(from) = &rev.from_path
                    {
                        let from = storage_path(from);
                        if from != path {
                            self.remove_once(&from, &mut summary.removed)?;
                        }
                    }
                    if rev.kind == FeedEntryKind::Deleted {
                        self.remove_once(&path, &mut summary.removed)?;
                        continue;
                    }
                    match self.engine.read_doc(&path)? {
                        Some(doc) => {
                            self.source.write(&path, &doc.content)?;
                            summary.written.push(path);
                        }
                        // The document no longer reads (tombstoned later in
                        // the feed): its `deleted` digest follows and would
                        // remove the same path again.
                        None => self.remove_once(&path, &mut summary.removed)?,
                    }
                }
            }
            cur = page.cursor;
            ep = Some(page.epoch);
            if !page.truncated {
                break;
            }
        }
        summary.cursor = cur;
        summary.epoch = ep;
        Ok(summary)
    }

    /// `remove` a source path once per `sync_out` call (a tombstoned
    /// document's own digest and its earlier digests all name it).
    fn remove_once(&mut self, path: &str, removed: &mut Vec<String>) -> Result<()> {
        if removed.iter().any(|p| p == path) {
            return Ok(());
        }
        self.source.remove(path)?;
        removed.push(path.to_owned());
        Ok(())
    }

    /// The rescan procedure, steps 2–3 (§6, 4.0): page the server's live
    /// documents into `L = { (id, path, hash) }`; for every document whose
    /// hash differs from the source's copy (hashed as the engine hashes a
    /// file — sha256 of the bytes), pull the bytes and write them at `path`;
    /// every source-side path not in `L` is removed (absence from `L` is
    /// deletion — the source has paths, not ids, so a moved document is a
    /// write at the new path and a removal of the old one). The caller
    /// resumes the feed (step 4). Returns `(written, removed)`.
    pub fn rescan(&mut self) -> Result<(Vec<String>, Vec<String>)> {
        let mut written = Vec::new();
        let mut removed = Vec::new();
        if !self.source.capabilities().write_through {
            return Ok((written, removed));
        }
        let listed = self.engine.list_docs()?;
        let mut live: Vec<String> = Vec::with_capacity(listed.len());
        for d in &listed {
            let path = storage_path(&d.path);
            live.push(path.clone());
            let have = self.source.fetch(&path)?;
            let have_hash = have.map(|it| hex(&sha256(it.content.as_bytes())));
            if have_hash.is_some() && have_hash == d.hash {
                continue;
            }
            let Some(doc) = self.engine.read_doc(&path)? else {
                continue;
            };
            self.source.write(&path, &doc.content)?;
            written.push(path);
        }
        for entry in self.source.enumerate()? {
            if live.contains(&entry.path) {
                continue;
            }
            self.source.remove(&entry.path)?;
            removed.push(entry.path);
        }
        Ok((written, removed))
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
            let out = co.sync_out(0, None).unwrap();
            assert_eq!((out.cursor, out.epoch.as_deref()), (2, Some("ep_0")));
            assert!(out.written.is_empty() && out.removed.is_empty());
            assert!(!out.rescanned);
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
            co.sync_out(2, Some("ep_0")).unwrap()
        };
        assert_eq!(out.written, ["authored.md"]);
        assert!(out.removed.is_empty());
        assert_eq!(out.cursor, 5);
        assert_eq!(source.files["authored.md"], "# Authored\n");
        assert_eq!(source.log.len(), 1);
        assert_eq!(out.to_json()["cursor"], 5);
        assert!(out.to_json().get("rescanned").is_none());
        // The written file comes back as an echo: the loop terminates.
        {
            let mut engine = InProcessEngineClient::new(&mut store, &repo).at(TS);
            let mut co = Coordinator::new(&mut engine, &mut source);
            let s = co.reconcile(&["authored.md".to_owned()]).unwrap();
            assert_eq!(s.suppressed, ["authored.md"]);
            assert_eq!(co.sync_out(5, None).unwrap().cursor, 5);
        }
    }

    /// §6 (4.0): an expired cursor runs the rescan — the stale copy is
    /// rewritten, the missing document written, the foreign path removed —
    /// and the walk resumes from the error's head under its epoch.
    #[test]
    fn an_expired_cursor_rescans_then_resumes() {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let ctx = omgbase_store::DocOpContext {
            repo_id: repo.clone(),
            actor: Some("agent:test".into()),
            ts: TS.into(),
        };
        store
            .docs_create(
                &ctx,
                &mut NullDocStore,
                "x.md",
                "# X\n\nServer copy.\n",
                None,
            )
            .unwrap();
        store
            .docs_create(&ctx, &mut NullDocStore, "y.md", "# Y\n", None)
            .unwrap();
        let mut source =
            MemSource::with_files(&[("x.md", "# X\n\nStale copy.\n"), ("stale.md", "# S\n")]);
        let mut engine = InProcessEngineClient::new(&mut store, &repo).at(TS);
        let mut co = Coordinator::new(&mut engine, &mut source);
        let out = co.sync_out(99, None).unwrap();
        assert!(out.rescanned);
        assert_eq!((out.cursor, out.epoch.as_deref()), (2, Some("ep_0")));
        assert_eq!(out.written, ["x.md", "y.md"]);
        assert_eq!(out.removed, ["stale.md"]);
        assert_eq!(out.to_json()["rescanned"], true);
        // Another epoch expires the cursor the same way.
        let again = co.sync_out(0, Some("ep_other")).unwrap();
        assert!(again.rescanned && again.written.is_empty() && again.removed.is_empty());
        // A second expiry in one call is the caller's retry: the error surfaces.
        // (A cursor past the head after the rescan cannot happen here; a
        // read-only source short-circuits before any page.)
        assert_eq!(source.files.len(), 2);
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
            co.sync_out(0, None).unwrap()
        };
        assert_eq!(out.cursor, 61);
        assert_eq!(out.written.len(), 59);
        assert_eq!(
            out.removed,
            ["n00.md"],
            "removed once: the create's digest and the delete's both name it"
        );
        assert_eq!(source.files.len(), 59);
        // Read-only source: nothing exported, cursor unchanged.
        let mut ro = MemSource::new(SourceCapabilities::default());
        let mut engine = InProcessEngineClient::new(&mut store, &repo).at(TS);
        let mut co = Coordinator::new(&mut engine, &mut ro);
        assert_eq!(
            co.sync_out(3, None).unwrap(),
            SyncOutSummary {
                cursor: 3,
                ..SyncOutSummary::default()
            }
        );
        assert_eq!(
            co.sync_out(3, None).unwrap().to_json(),
            serde_json::json!({ "cursor": 3, "epoch": null, "written": [], "removed": [] })
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
