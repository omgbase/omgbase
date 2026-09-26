//! The in-process filesystem watcher of `omgbase mcp` (the reference's
//! `omg mcp` default): take the watch lease (`spec/sync` §7), prime the
//! session with one freshness sweep (§4.3), spawn the repo's registered `fs`
//! adapter (§5) and reconcile every batch of its watch stream into a
//! checkpoint (§6 `reconcile_changes`).
//!
//! Ownership: the MCP loop is synchronous on stdin and owns the surface's
//! store; the batches arrive on another thread. That thread owns its **own**
//! `Store` connection over the same SQLite file (WAL; a `Store` is not
//! `Send`, so it is opened on the thread) and takes the workspace writer
//! lock around each checkpoint, as the reference's checkpoint does and as
//! the MCP loop does around every write tool — so a checkpoint and a tool
//! call never interleave inside one commit; where a read overlaps a write,
//! SQLite's WAL plus the busy timeout on both connections serialize them.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::thread::JoinHandle;
use std::time::Duration;

use omgbase_store::Config;
use omgbase_sync::fs::RealFileSystem;
use omgbase_sync::registry::{AdapterRow, FS_ADAPTER, SourceRow};
use omgbase_sync::{
    CheckpointResult, ExternalSource, RepoRow, SyncSource, WatchLease, WriterLockOptions,
    freshness_sweep, reconcile_changes, with_writer_lock,
};

use crate::drain::DrainHandle;
use crate::{MinterSource, open_store, stamp};

/// A command line (whitespace-split) that replaces the registry's `fs`
/// adapter command — e.g. `node /repo/packages/fs-adapter/dist/src/bin.js`
/// while developing, or an absolute path when the bin is not on `PATH`.
pub const ADAPTER_ENV: &str = "OMGBASE_FS_ADAPTER";

/// How often the thread checks the stop flag between batches.
const POLL: Duration = Duration::from_millis(200);

/// What the watcher needs to start.
pub struct WatchOptions {
    /// `<workspace>/.omgbase` — the lease and the writer lock live here.
    pub omgbase_dir: PathBuf,
    pub db_path: PathBuf,
    pub repo: RepoRow,
    pub minters: MinterSource,
    /// The pinned clock (`OMGBASE_SPEC_CLOCK`), if any.
    pub clock: Option<String>,
    /// `$OMGBASE_FS_ADAPTER` split on whitespace, when set.
    pub adapter_override: Option<Vec<String>>,
    /// Scheduled after every checkpoint that ingested or deleted something.
    pub drain: Option<DrainHandle>,
}

/// How `start` ended.
pub enum Outcome {
    /// Watching; stop it at shutdown.
    Live(Watcher),
    /// Another live watcher holds the lease (`omg watch`, another `mcp`).
    LeaseHeld,
    /// The repo has no `fs` source (sourceless): nothing to watch.
    NoSource,
    /// The adapter could not be started (not installed, bad handshake, no
    /// `watch` capability): serve without a watcher.
    AdapterUnavailable(String),
}

/// A live watcher: the adapter thread and the lease it holds.
pub struct Watcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    lease: Option<WatchLease>,
    argv: Vec<String>,
}

impl Watcher {
    /// The adapter command line that is running.
    #[must_use]
    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    /// Stop the stream (the thread `unwatch`es and closes the adapter),
    /// join the thread, release the lease.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        if let Some(mut lease) = self.lease.take() {
            lease.release();
        }
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        if let Some(mut lease) = self.lease.take() {
            lease.release();
        }
    }
}

/// The adapter row to spawn: the registry's, or `override_argv` in front of
/// the registry's fixed `args` (the reference always launches the bundled
/// `@omgbase/fs-adapter` for the built-in `fs` adapter; this port has no
/// bundle, so the stored command — `omgbase-fs-adapter` on `PATH` — is the
/// default and the environment can point elsewhere).
#[must_use]
pub fn resolve_adapter(row: &AdapterRow, override_argv: Option<&[String]>) -> AdapterRow {
    match override_argv {
        Some([command, rest @ ..]) => {
            let mut args = rest.to_vec();
            args.extend(row.args.iter().cloned());
            AdapterRow {
                name: row.name.clone(),
                command: command.clone(),
                args,
            }
        }
        _ => row.clone(),
    }
}

/// `$OMGBASE_FS_ADAPTER` as an argv, when set and non-empty.
#[must_use]
pub fn adapter_override_from_env() -> Option<Vec<String>> {
    let raw = std::env::var(ADAPTER_ENV).ok()?;
    let argv: Vec<String> = raw.split_whitespace().map(str::to_owned).collect();
    (!argv.is_empty()).then_some(argv)
}

/// The repo's `fs` source with a usable `config.root`, if any.
fn fs_source(store: &omgbase_store::Store, repo_id: &str) -> Result<Option<SourceRow>, String> {
    let sources = omgbase_sync::sources_for_repo(store, repo_id).map_err(|e| e.to_string())?;
    Ok(sources.into_iter().find(|s| {
        s.adapter == FS_ADAPTER
            && s.config
                .get("root")
                .and_then(|v| v.as_str())
                .is_some_and(|r| !r.is_empty())
    }))
}

/// Take the lease, prime, spawn, watch.
pub fn start(opts: WatchOptions) -> Result<Outcome, String> {
    let Some(lease) = WatchLease::try_acquire(&opts.omgbase_dir).map_err(|e| e.to_string())? else {
        return Ok(Outcome::LeaseHeld);
    };
    let repo_id = opts.repo.repo_id.clone();
    let config = Config::default();
    // A connection of our own for the priming sweep and the registry reads;
    // the thread opens another (a `Store` cannot cross threads).
    let mut store = open_store(&opts.db_path, &opts.minters)?;

    if let Some(root) = opts.repo.root_path.as_deref() {
        let ts = stamp(opts.clock.as_ref());
        let swept = with_writer_lock(&opts.omgbase_dir, WriterLockOptions::default(), || {
            freshness_sweep(
                &mut store,
                &repo_id,
                &RealFileSystem,
                Path::new(root),
                &ts,
                None,
                &config,
            )
        });
        match swept {
            Ok(s) if s.changed => eprintln!(
                "[watch] primed: +{} -{}",
                s.checkpoint.ingested.len(),
                s.checkpoint.deleted.len()
            ),
            Ok(_) => {}
            Err(e) => eprintln!("[watch] priming sweep failed: {e}"),
        }
    }

    let Some(source) = fs_source(&store, &repo_id)? else {
        return Ok(Outcome::NoSource);
    };
    let adapters = omgbase_sync::list_adapters(&store).map_err(|e| e.to_string())?;
    let Some(row) = adapters.into_iter().find(|a| a.name == source.adapter) else {
        return Ok(Outcome::AdapterUnavailable(format!(
            "source `{}` names adapter `{}`, which the registry does not hold",
            source.name, source.adapter
        )));
    };
    drop(store);
    let adapter = resolve_adapter(&row, opts.adapter_override.as_deref());
    let argv = ExternalSource::argv(&source, &adapter);
    let mut ext = match ExternalSource::spawn_source(&source, &adapter) {
        Ok(s) => s,
        Err(e) => {
            return Ok(Outcome::AdapterUnavailable(format!(
                "cannot start the `{}` adapter as `{}`: {e}",
                source.adapter,
                argv.join(" ")
            )));
        }
    };
    if !ext.capabilities().watch {
        let _ = ext.close();
        return Ok(Outcome::AdapterUnavailable(format!(
            "adapter `{}` does not advertise `watch`",
            argv.join(" ")
        )));
    }
    let rx = match ext.watch() {
        Ok(rx) => rx,
        Err(e) => {
            let _ = ext.close();
            return Ok(Outcome::AdapterUnavailable(format!(
                "adapter `{}` refused `watch`: {e}",
                argv.join(" ")
            )));
        }
    };

    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let thread_opts = opts;
    let thread = std::thread::Builder::new()
        .name("omgbase-watch".to_owned())
        .spawn(move || {
            run(&thread_opts, ext, &rx, &flag, &config);
        })
        .map_err(|e| format!("cannot spawn the watcher thread: {e}"))?;
    Ok(Outcome::Live(Watcher {
        stop,
        thread: Some(thread),
        lease: Some(lease),
        argv,
    }))
}

/// The thread: its own store, then one checkpoint per non-empty batch
/// under the writer lock, until stopped or the stream ends; then `unwatch`
/// and close the adapter.
fn run(
    opts: &WatchOptions,
    mut source: ExternalSource,
    rx: &std::sync::mpsc::Receiver<Vec<String>>,
    stop: &AtomicBool,
    config: &Config,
) {
    let mut store = match open_store(&opts.db_path, &opts.minters) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[watch] error: {e}");
            let _ = source.unwatch();
            let _ = source.close();
            return;
        }
    };
    while !stop.load(Ordering::SeqCst) {
        let paths = match rx.recv_timeout(POLL) {
            Ok(p) => p,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                eprintln!("[watch] the adapter's stream ended; watching stopped");
                break;
            }
        };
        if paths.is_empty() {
            continue;
        }
        let ts = stamp(opts.clock.as_ref());
        let result = with_writer_lock(&opts.omgbase_dir, WriterLockOptions::default(), || {
            reconcile_changes(
                &mut store,
                &opts.repo.repo_id,
                &mut source,
                &paths,
                &ts,
                None,
                config,
            )
        });
        match result {
            Ok(r) => on_checkpoint(&r, opts.drain.as_ref()),
            Err(e) => eprintln!("[watch] error: {e}"),
        }
    }
    let _ = source.unwatch();
    let _ = source.close();
}

/// The reference's `onCheckpoint`: log and schedule a drain when the
/// checkpoint ingested or deleted something.
fn on_checkpoint(r: &CheckpointResult, drain: Option<&DrainHandle>) {
    if r.ingested.is_empty() && r.deleted.is_empty() {
        return;
    }
    eprintln!(
        "[watch] checkpoint: +{} -{}",
        r.ingested.len(),
        r.deleted.len()
    );
    if let Some(d) = drain {
        d.schedule();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_sync::Workspace;
    use omgbase_sync::fs::TempDir;

    fn options(tmp: &TempDir, root: Option<&str>, argv: Option<&[&str]>) -> WatchOptions {
        let mut ws = Workspace::open(tmp.path()).unwrap();
        let repo_id = omgbase_sync::ensure_repo(ws.store_mut(), "r", root).unwrap();
        let (omgbase_dir, db_path) = (ws.omgbase_dir().to_path_buf(), ws.db_path().to_path_buf());
        ws.close().unwrap();
        WatchOptions {
            omgbase_dir,
            db_path,
            repo: RepoRow {
                repo_id,
                slug: "r".into(),
                root_path: root.map(str::to_owned),
            },
            minters: MinterSource::Random,
            clock: None,
            adapter_override: argv.map(|a| a.iter().map(|s| (*s).to_owned()).collect()),
            drain: None,
        }
    }

    #[test]
    fn a_sourceless_repo_has_nothing_to_watch() {
        let tmp = TempDir::new("watch-sourceless");
        let opts = options(&tmp, None, None);
        let dir = opts.omgbase_dir.clone();
        assert!(matches!(start(opts).unwrap(), Outcome::NoSource));
        assert!(!WatchLease::live(&dir), "the lease is released");
    }

    #[test]
    fn a_missing_adapter_degrades_to_no_watch() {
        let tmp = TempDir::new("watch-noadapter");
        let root = tmp.path().to_string_lossy().into_owned();
        std::fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        let opts = options(
            &tmp,
            Some(&root),
            Some(&["definitely-not-an-omgbase-adapter-xyz", "--flag"]),
        );
        let (dir, db) = (opts.omgbase_dir.clone(), opts.db_path.clone());
        match start(opts).unwrap() {
            Outcome::AdapterUnavailable(msg) => {
                assert!(
                    msg.contains("definitely-not-an-omgbase-adapter-xyz --flag --root"),
                    "{msg}"
                );
            }
            _ => panic!("expected AdapterUnavailable"),
        }
        assert!(!WatchLease::live(&dir), "the lease is released");
        // The priming sweep ran before the adapter was tried.
        let store = omgbase_store::Store::open(&db).unwrap();
        let docs: i64 = store
            .conn()
            .query_row("SELECT count(*) FROM docs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(docs, 1);
    }

    #[test]
    fn a_live_lease_elsewhere_skips_the_watcher() {
        let tmp = TempDir::new("watch-lease");
        let root = tmp.path().to_string_lossy().into_owned();
        let opts = options(&tmp, Some(&root), None);
        let held = WatchLease::try_acquire(&opts.omgbase_dir).unwrap().unwrap();
        assert!(matches!(start(opts).unwrap(), Outcome::LeaseHeld));
        drop(held);
    }

    #[test]
    fn a_non_watching_adapter_is_unavailable() {
        // `sh` plays an adapter whose handshake lacks `watch`.
        let tmp = TempDir::new("watch-nowatch");
        let root = tmp.path().to_string_lossy().into_owned();
        let script = "echo '{\"protocol\":1,\"capabilities\":{}}'; cat >/dev/null";
        let opts = options(&tmp, Some(&root), Some(&["sh", "-c", script]));
        // `sh -c <script> --root <dir>`: the flags become `$0`/`$1`, harmless.
        match start(opts).unwrap() {
            Outcome::AdapterUnavailable(msg) => assert!(msg.contains("watch"), "{msg}"),
            _ => panic!("expected AdapterUnavailable"),
        }
    }

    #[test]
    fn override_goes_in_front_of_the_fixed_args() {
        let row = AdapterRow {
            name: "fs".into(),
            command: "omgbase-fs-adapter".into(),
            args: vec!["--v".into()],
        };
        assert_eq!(resolve_adapter(&row, None), row);
        assert_eq!(resolve_adapter(&row, Some(&[])), row);
        let o = resolve_adapter(&row, Some(&["node".to_owned(), "/x/bin.js".to_owned()]));
        assert_eq!(o.command, "node");
        assert_eq!(o.args, ["/x/bin.js", "--v"]);
    }
}
