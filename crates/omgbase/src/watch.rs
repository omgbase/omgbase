//! The in-process filesystem watcher of `omgbase mcp` (the reference's
//! `omg mcp` default), ordered as `spec/sync` §5 "Readiness" prescribes:
//! take the watch lease (§7), launch the repo's `fs` adapter (§5 — the
//! host's launcher, `$OMGBASE_FS_ADAPTER` or `omgbase-fs-adapter` on `PATH`,
//! never the registry row's command), `watch`, **wait for `ready`** (bounded
//! by [`READY_PATIENCE`]; a timeout is a warning and the host proceeds as if
//! ready), then prime the session with one freshness sweep (§4.3), then
//! report the watcher live. An edit landing before readiness is caught by
//! the sweep, one landing after it by the feed; a batch the adapter reports
//! before `ready` is handed to the thread and reconciled first (an edit
//! caught twice is an echo). Every batch of the stream becomes a checkpoint
//! (§6 `reconcile_changes`). Without a usable adapter the sweep still runs.
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

use omgbase_store::{Config, Store};
use omgbase_sync::fs::RealFileSystem;
use omgbase_sync::registry::{AdapterRow, FS_ADAPTER, FS_ADAPTER_COMMAND, SourceRow};
use omgbase_sync::{
    CheckpointResult, ExternalSource, Readiness, RepoRow, SyncSource, WatchEvent, WatchLease,
    WriterLockOptions, freshness_sweep, reconcile_changes, wait_ready, with_writer_lock,
};

use crate::drain::DrainHandle;
use crate::{MinterSource, open_store, stamp};

/// A command line (whitespace-split) that launches the `fs` adapter instead
/// of `omgbase-fs-adapter` from `PATH` — e.g. `node
/// /repo/packages/fs-adapter/dist/src/bin.js` while developing, or an
/// absolute path when the bin is not on `PATH` (`spec/sync` §5).
pub const ADAPTER_ENV: &str = "OMGBASE_FS_ADAPTER";

/// How long the host waits for the adapter's `{"event":"ready"}` after
/// `watch` before proceeding with a warning (`spec/sync` §5: unpinned; both
/// hosts use 30 s).
pub const READY_PATIENCE: Duration = Duration::from_secs(30);

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
    /// How long to wait for the adapter's `ready` ([`READY_PATIENCE`] in
    /// production; tests shorten it).
    pub ready_patience: Duration,
    /// Scheduled after every checkpoint that ingested or deleted something.
    pub drain: Option<DrainHandle>,
    /// Called with every batch checkpoint (and the priming sweep's) instead
    /// of the `[watch] …` stderr lines — a host with its own rendering
    /// (`omgbase sync --watch`). `None` keeps the default lines.
    pub on_checkpoint: Option<CheckpointHook>,
}

/// A host's checkpoint renderer (runs on the watcher thread).
pub type CheckpointHook = Arc<dyn Fn(&CheckpointResult) + Send + Sync>;

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

/// The adapter row to spawn (`spec/sync` §5 "Launching the built-in `fs`
/// adapter"): for the `fs` adapter the registry row's `command` is registry
/// data, never consulted — the launcher is `override_argv`
/// (`$OMGBASE_FS_ADAPTER`: a command and leading arguments) when set and
/// non-empty, else `omgbase-fs-adapter` from `PATH`, followed by the row's
/// fixed `args` (then, at spawn, `render_config_flags(config)`). Every other
/// adapter runs its stored command as is.
#[must_use]
pub fn resolve_adapter(row: &AdapterRow, override_argv: Option<&[String]>) -> AdapterRow {
    if row.name != FS_ADAPTER {
        return row.clone();
    }
    let (command, leading): (String, &[String]) = match override_argv {
        Some([command, rest @ ..]) => (command.clone(), rest),
        _ => (FS_ADAPTER_COMMAND.to_owned(), &[]),
    };
    let mut args = leading.to_vec();
    args.extend(row.args.iter().cloned());
    AdapterRow {
        name: row.name.clone(),
        command,
        args,
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

/// The priming freshness sweep (§4.3) under the writer lock; a failure is
/// logged, never fatal. Runs whether or not an adapter came up: the sweep
/// does not depend on it.
fn prime(store: &mut Store, opts: &WatchOptions, config: &Config) {
    let Some(root) = opts.repo.root_path.as_deref() else {
        return;
    };
    let ts = stamp(opts.clock.as_ref());
    let swept = with_writer_lock(&opts.omgbase_dir, WriterLockOptions::default(), || {
        freshness_sweep(
            store,
            &opts.repo.repo_id,
            &RealFileSystem,
            Path::new(root),
            &ts,
            None,
            config,
        )
    });
    match swept {
        Ok(s) => match &opts.on_checkpoint {
            Some(hook) => hook(&s.checkpoint),
            None if s.changed => eprintln!(
                "[watch] primed: +{} -{}",
                s.checkpoint.ingested.len(),
                s.checkpoint.deleted.len()
            ),
            None => {}
        },
        Err(e) => eprintln!("[watch] priming sweep failed: {e}"),
    }
}

/// Take the lease; find the `fs` source and its launcher; spawn; `watch`;
/// wait for `ready`; prime; go live (`spec/sync` §5). Every early exit
/// after the lease still primes.
pub fn start(opts: WatchOptions) -> Result<Outcome, String> {
    let Some(lease) = WatchLease::try_acquire(&opts.omgbase_dir).map_err(|e| e.to_string())? else {
        return Ok(Outcome::LeaseHeld);
    };
    let repo_id = opts.repo.repo_id.clone();
    let config = Config::default();
    // A connection of our own for the registry reads and the priming sweep;
    // the thread opens another (a `Store` cannot cross threads).
    let mut store = open_store(&opts.db_path, &opts.minters)?;

    let Some(source) = fs_source(&store, &repo_id)? else {
        prime(&mut store, &opts, &config);
        return Ok(Outcome::NoSource);
    };
    let adapters = omgbase_sync::list_adapters(&store).map_err(|e| e.to_string())?;
    let Some(row) = adapters.into_iter().find(|a| a.name == source.adapter) else {
        prime(&mut store, &opts, &config);
        return Ok(Outcome::AdapterUnavailable(format!(
            "source `{}` names adapter `{}`, which the registry does not hold",
            source.name, source.adapter
        )));
    };
    let adapter = resolve_adapter(&row, opts.adapter_override.as_deref());
    let argv = ExternalSource::argv(&source, &adapter);
    let mut ext = match ExternalSource::spawn_source(&source, &adapter) {
        Ok(s) => s,
        Err(e) => {
            prime(&mut store, &opts, &config);
            return Ok(Outcome::AdapterUnavailable(format!(
                "cannot start the `{}` adapter as `{}`: {e}",
                source.adapter,
                argv.join(" ")
            )));
        }
    };
    if !ext.capabilities().watch {
        let _ = ext.close();
        prime(&mut store, &opts, &config);
        return Ok(Outcome::AdapterUnavailable(format!(
            "adapter `{}` does not advertise `watch`",
            argv.join(" ")
        )));
    }
    let rx = match ext.watch() {
        Ok(rx) => rx,
        Err(e) => {
            let _ = ext.close();
            prime(&mut store, &opts, &config);
            return Ok(Outcome::AdapterUnavailable(format!(
                "adapter `{}` refused `watch`: {e}",
                argv.join(" ")
            )));
        }
    };

    // Wait for `ready`; what the adapter reported before it is not lost.
    let (readiness, early) = wait_ready(&rx, opts.ready_patience);
    match readiness {
        Readiness::Ready => {}
        Readiness::TimedOut => eprintln!(
            "[watch] warning: adapter `{}` did not report ready within {:?}; proceeding as if ready (an edit made before now may be missed until the next sweep)",
            argv.join(" "),
            opts.ready_patience
        ),
        Readiness::Ended => {
            let _ = ext.close();
            prime(&mut store, &opts, &config);
            return Ok(Outcome::AdapterUnavailable(format!(
                "adapter `{}` exited before reporting ready",
                argv.join(" ")
            )));
        }
    }

    prime(&mut store, &opts, &config);
    drop(store);

    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let thread_opts = opts;
    let thread = std::thread::Builder::new()
        .name("omgbase-watch".to_owned())
        .spawn(move || {
            run(&thread_opts, ext, &rx, early, &flag, &config);
        })
        .map_err(|e| format!("cannot spawn the watcher thread: {e}"))?;
    Ok(Outcome::Live(Watcher {
        stop,
        thread: Some(thread),
        lease: Some(lease),
        argv,
    }))
}

/// The thread: its own store; the batches that arrived before `ready`
/// first (after the priming sweep, so at worst echoes), then one checkpoint
/// per non-empty batch under the writer lock, until stopped or the stream
/// ends; then `unwatch` and close the adapter.
fn run(
    opts: &WatchOptions,
    mut source: ExternalSource,
    rx: &std::sync::mpsc::Receiver<WatchEvent>,
    early: Vec<Vec<String>>,
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
    let checkpoint = |store: &mut Store, source: &mut ExternalSource, paths: &[String]| {
        if paths.is_empty() {
            return;
        }
        let ts = stamp(opts.clock.as_ref());
        let result = with_writer_lock(&opts.omgbase_dir, WriterLockOptions::default(), || {
            reconcile_changes(store, &opts.repo.repo_id, source, paths, &ts, None, config)
        });
        match result {
            Ok(r) => match &opts.on_checkpoint {
                Some(hook) => hook(&r),
                None => on_checkpoint(&r, opts.drain.as_ref()),
            },
            Err(e) => eprintln!("[watch] error: {e}"),
        }
    };
    for paths in early {
        checkpoint(&mut store, &mut source, &paths);
    }
    while !stop.load(Ordering::SeqCst) {
        let paths = match rx.recv_timeout(POLL) {
            Ok(WatchEvent::Batch(p)) => p,
            // A second `ready` (or a late one after a timeout) changes nothing.
            Ok(WatchEvent::Ready) | Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                eprintln!("[watch] the adapter's stream ended; watching stopped");
                break;
            }
        };
        checkpoint(&mut store, &mut source, &paths);
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
            ready_patience: Duration::from_millis(300),
            drain: None,
            on_checkpoint: None,
        }
    }

    fn count(db: &Path, table: &str) -> i64 {
        let store = Store::open(db).unwrap();
        store
            .conn()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// A `sh` adapter that advertises `watch` and answers every request by
    /// its id: `watch` with `ok` followed by `then` (extra lines after the
    /// response — events), `fetch` with the fixture file's bytes (so a
    /// reconcile of `a.md` is an echo), anything else with `ok`; it stays up
    /// until stdin EOF. Written to `dir` (not a `.md`, so the walk skips it).
    fn sh_adapter(dir: &Path, then: &str) -> String {
        let script = r##"
printf '%s\n' '{"protocol":1,"capabilities":{"watch":true}}'
while IFS= read -r line; do
  id="${line#*\"id\":}"; id="${id%%,*}"
  case "$line" in
    *'"watch"'*) printf '%s\n' "{\"id\":$id,\"result\":{\"ok\":true}}"; __THEN__ ;;
    *'"fetch"'*) printf '%s\n' "{\"id\":$id,\"result\":{\"item\":{\"path\":\"a.md\",\"revision\":\"1\",\"content\":\"# A\\n\"}}}" ;;
    *) printf '%s\n' "{\"id\":$id,\"result\":{\"ok\":true}}" ;;
  esac
done
"##
        .replace("__THEN__", then);
        let path = dir.join("adapter.sh");
        std::fs::write(&path, script).unwrap();
        path.to_string_lossy().into_owned()
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
        // The priming sweep still ran although the adapter did not come up.
        assert_eq!(count(&db, "docs"), 1);
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
    fn ready_is_awaited_and_an_early_batch_is_reconciled_after_the_prime() {
        // §5: watch → ready → priming sweep → live. The adapter reports a
        // batch before `ready`; the thread reconciles it after the sweep
        // (an echo) as its own checkpoint.
        let tmp = TempDir::new("watch-ready");
        let root = tmp.path().to_string_lossy().into_owned();
        std::fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        let script = sh_adapter(
            tmp.path(),
            r#"printf '%s\n' '{"event":"batch","paths":["a.md"]}' '{"event":"ready"}'"#,
        );
        let mut opts = options(&tmp, Some(&root), Some(&["sh", &script]));
        // Long patience: had `ready` gone unnoticed, `start` would sit it out.
        opts.ready_patience = Duration::from_secs(10);
        let (dir, db) = (opts.omgbase_dir.clone(), opts.db_path.clone());
        let started = std::time::Instant::now();
        let watcher = match start(opts).unwrap() {
            Outcome::Live(w) => w,
            Outcome::AdapterUnavailable(m) => panic!("{m}"),
            _ => panic!("expected Live"),
        };
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "ready arrived: no wait for patience"
        );
        assert_eq!(watcher.argv()[0], "sh");
        assert!(WatchLease::live(&dir));
        assert_eq!(count(&db, "docs"), 1, "the priming sweep ran before live");
        watcher.stop();
        assert!(!WatchLease::live(&dir), "the lease is released");
        assert_eq!(
            count(&db, "checkpoints"),
            2,
            "the sweep's checkpoint, then the early batch's"
        );
        assert_eq!(count(&db, "docs"), 1);
    }

    #[test]
    fn a_silent_adapter_is_tolerated_after_patience() {
        // An adapter built before sync 1.2 never says `ready`: after
        // patience the host warns and proceeds — sweep, then live.
        let tmp = TempDir::new("watch-silent");
        let root = tmp.path().to_string_lossy().into_owned();
        std::fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        let script = sh_adapter(tmp.path(), ":");
        let opts = options(&tmp, Some(&root), Some(&["sh", &script]));
        let db = opts.db_path.clone();
        let started = std::time::Instant::now();
        let watcher = match start(opts).unwrap() {
            Outcome::Live(w) => w,
            Outcome::AdapterUnavailable(m) => panic!("{m}"),
            _ => panic!("expected Live"),
        };
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert_eq!(count(&db, "docs"), 1);
        watcher.stop();
        assert_eq!(count(&db, "checkpoints"), 1);
    }

    #[test]
    fn an_adapter_that_dies_before_ready_is_unavailable_but_the_sweep_runs() {
        let tmp = TempDir::new("watch-dies");
        let root = tmp.path().to_string_lossy().into_owned();
        std::fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        let script = "echo '{\"protocol\":1,\"capabilities\":{\"watch\":true}}'; read -r line; echo '{\"id\":1,\"result\":{\"ok\":true}}'; exit 0";
        let opts = options(&tmp, Some(&root), Some(&["sh", "-c", script]));
        let (dir, db) = (opts.omgbase_dir.clone(), opts.db_path.clone());
        match start(opts).unwrap() {
            Outcome::AdapterUnavailable(msg) => {
                assert!(msg.contains("before reporting ready"), "{msg}")
            }
            _ => panic!("expected AdapterUnavailable"),
        }
        assert!(!WatchLease::live(&dir));
        assert_eq!(count(&db, "docs"), 1);
    }

    #[test]
    fn the_fs_launcher_never_reads_the_row_command() {
        // §5 "Launching the built-in `fs` adapter": the row's command is
        // registry data; the launcher is the override or the PATH bin.
        let row = AdapterRow {
            name: "fs".into(),
            command: "/registry/says/this".into(),
            args: vec!["--v".into()],
        };
        let default = resolve_adapter(&row, None);
        assert_eq!(default.command, FS_ADAPTER_COMMAND);
        assert_eq!(default.args, ["--v"]);
        assert_eq!(resolve_adapter(&row, Some(&[])), default, "empty override");
        let o = resolve_adapter(&row, Some(&["node".to_owned(), "/x/bin.js".to_owned()]));
        assert_eq!(o.command, "node");
        assert_eq!(o.args, ["/x/bin.js", "--v"]);
        assert_eq!(o.name, "fs");
        // Every other adapter runs its stored command, override or not.
        let other = AdapterRow {
            name: "git".into(),
            command: "omgbase-git-adapter".into(),
            args: vec![],
        };
        assert_eq!(resolve_adapter(&other, None), other);
        assert_eq!(
            resolve_adapter(&other, Some(&["node".to_owned()])),
            other,
            "the fs override is not a general one"
        );
    }
}
