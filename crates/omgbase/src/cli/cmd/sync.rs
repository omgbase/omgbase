//! `sync` (§6): one verb, three modes —
//!
//! ```text
//! omgbase sync                     one-shot local freshness sweep (fs → DB)
//! omgbase sync --watch             stay live locally (the fs adapter's stream)
//! omgbase sync --server <cmd|url>  mirror a directory into a remote engine over MCP
//!                                  [--root <dir>] [--out] [--watch]
//! ```
//!
//! The one-shot is the explicit form of the freshness sweep every read runs
//! (§3.7), rendered. `--watch` is the reference's `runLocalWatch` over
//! [`crate::watch`] (lease → adapter → `watch` → `ready` → priming sweep →
//! live; `spec/sync` §5) with the embed drain when a provider is
//! configured, until `SIGINT`/`SIGTERM`. `--server` is the reference's
//! `runFsMirror`: no local workspace — the [`Coordinator`] drives the `fs`
//! adapter (launched as `spec/sync` §5 prescribes: `$OMGBASE_FS_ADAPTER`,
//! else `omgbase-fs-adapter` on `PATH`, then `--root <dir>`) against the
//! [`McpEngineClient`] the `--server` value names (the same url-vs-command
//! rule as every remote verb, `Cli::remote_spec`): one `sync_in`, `--out`
//! adds a `sync_out`, `--watch` stays live after `ready`. Both live modes
//! are unpinned by the fixtures (timing, a second process); only the card
//! and the one-shot are.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use omgbase_search::create_external_provider;
use omgbase_surface::reference_path;
use omgbase_sync::registry::FS_ADAPTER_COMMAND;
use omgbase_sync::{
    CheckpointResult, Coordinator, ExternalSource, McpEngineClient, Readiness, RealFileSystem,
    RepoRow, SyncInSummary, SyncSource, WatchEvent, WatchLease, freshness_sweep, wait_ready,
};
use serde_json::json;

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::{Cli, WsInfo, resolve_path};
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result, js_json};
use crate::cli::render::Style;
use crate::cli::seams::{MinterSource, open_store};
use crate::drain::{DrainFn, DrainReport, Drainer, SharedProvider};
use crate::watch;

/// How often the live loops check for a signal.
const POLL: Duration = Duration::from_millis(100);

pub fn sync(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "sync");
    }
    let a = parse_args(
        args,
        &[Opt::flag("watch"), Opt::flag("out"), Opt::value("root")],
    )?;
    // Remote: the coordinator against an MCP server; no local workspace.
    if cli.flags.server.is_some() {
        let root = match a.value("root") {
            Some(r) => resolve_path(&cli.cwd, r),
            None => cli.cwd.clone(),
        };
        return run_fs_mirror(cli, &root, a.flag("out"), a.flag("watch"));
    }
    let ws = cli.workspace()?;
    let repo = cli.repo()?;
    if a.flag("watch") {
        return run_local_watch(cli, &ws, &repo);
    }
    run_one_shot(cli, &repo)
}

// ---- one-shot ---------------------------------------------------------------------------

fn run_one_shot(cli: &mut Cli, repo: &RepoRow) -> Result<i32> {
    let style = cli.style;
    let Some(root) = repo.root_path.as_deref() else {
        if cli.machine() {
            cli.io.out(&js_json(
                &json!({ "scanned": 0, "ingested": [], "deleted": [], "conflicted": [], "changed": false }),
            ));
        } else {
            // §9 Fixed: the note goes to stderr.
            cli.io.err(&style.dim(&format!(
                "  {} has no filesystem source — nothing to sync",
                repo.slug
            )));
        }
        return Ok(EXIT_OK);
    };
    let now = cli.now();
    let result = freshness_sweep(
        cli.store_mut()?,
        &repo.repo_id,
        &RealFileSystem,
        Path::new(root),
        &now,
        None,
        &omgbase_store::Config::default(),
    )?;
    let cp = &result.checkpoint;
    // The paths the sweep names print in the reference form (spec/surface §1 "Paths").
    let rooted =
        |paths: &[String]| -> Vec<String> { paths.iter().map(|p| reference_path(p)).collect() };
    let (ingested, suppressed, deleted, conflicted) = (
        rooted(&cp.ingested),
        rooted(&cp.suppressed),
        rooted(&cp.deleted),
        rooted(&cp.conflicted),
    );
    if cli.machine() {
        // The `SweepResult` as the reference spells it (camelCase).
        cli.io.out(&js_json(&json!({
            "checkpointId": cp.checkpoint_id, "ingested": ingested, "suppressed": suppressed,
            "deleted": deleted, "conflicted": conflicted, "scanned": result.scanned,
            "candidates": result.candidates, "changed": result.changed,
        })));
        return Ok(EXIT_OK);
    }
    let g = style.glyphs();
    cli.io.out(&style.wordmark("sync"));
    cli.io.out(&style.rule());
    cli.io.out(&format!(
        "  {}   {} files",
        style.dim("scanned"),
        result.scanned
    ));
    if !ingested.is_empty() {
        cli.io.out(&format!(
            "  {} ingested  {}",
            style.ok(g.ok),
            ingested.len()
        ));
        for p in &ingested {
            cli.io.out(&format!("      {}", style.accent(p)));
        }
    }
    if !deleted.is_empty() {
        cli.io.out(&format!(
            "  {} deleted   {}",
            style.err(g.err),
            deleted.len()
        ));
        for p in &deleted {
            cli.io.out(&format!("      {}", style.dim(p)));
        }
    }
    if !conflicted.is_empty() {
        cli.io.out(&format!(
            "  {} conflicts {}",
            style.warn(g.warn),
            conflicted.len()
        ));
        for p in &conflicted {
            cli.io.out(&format!("      {}", style.warn(p)));
        }
    }
    if !result.changed {
        cli.io
            .out(&format!("  {}", style.dim("already up to date")));
    }
    Ok(EXIT_OK)
}

// ---- signals ----------------------------------------------------------------------------

/// Set by the `SIGINT`/`SIGTERM` handler; polled by the live loops.
static SIGNALLED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_sig: libc::c_int) {
    SIGNALLED.store(true, Ordering::SeqCst);
}

/// Install the handlers (the live loops poll [`SIGNALLED`]).
fn install_signal_handlers() {
    // SAFETY: the handler only stores to an atomic — async-signal-safe —
    // and touches no other state.
    let handler = on_signal as extern "C" fn(libc::c_int) as *const () as libc::sighandler_t;
    unsafe {
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGTERM, handler);
    }
}

fn signalled() -> bool {
    SIGNALLED.load(Ordering::SeqCst)
}

/// The `sync` glyph of the reference's style tiers (`⟳`; `~` in plain).
fn sync_glyph(style: &Style) -> &'static str {
    if style.glyphs().ok == "ok" {
        "~"
    } else {
        "⟳"
    }
}

// ---- local watch ------------------------------------------------------------------------

/// The drainer over its own connection (built on the drain thread) and a
/// handle to the shared provider (`spec/search` §2.6).
fn start_drainer(
    db: &Path,
    repo_id: &str,
    minters: &MinterSource,
    provider: SharedProvider,
) -> Drainer {
    let (db, repo_id, minters) = (db.to_path_buf(), repo_id.to_owned(), minters.clone());
    Drainer::spawn(crate::drain::DEBOUNCE, move || {
        let store = open_store(&db, &minters)?;
        Ok(Box::new(move || {
            let stats = store
                .drain(&repo_id, &provider)
                .map_err(|e| e.to_string())?;
            Ok(DrainReport {
                embedded: stats.blocks.embedded + stats.docs.embedded,
                pooled: stats.docs.pooled,
            })
        }) as DrainFn)
    })
}

/// The reference's `runLocalWatch`: the lease, the embedder (a configured
/// but broken one warns and disables auto-embed; it never takes the watcher
/// down), the adapter, `watch`, `ready`, the priming sweep, then live until
/// a signal — every checkpoint that changed something prints
/// `<sync> +N -M[ !K]` and schedules a drain.
fn run_local_watch(cli: &mut Cli, ws: &WsInfo, repo: &RepoRow) -> Result<i32> {
    let (io, style) = (cli.io, cli.style);
    if WatchLease::live(&ws.omgbase_dir) {
        return Err(CliError::engine(
            "target_missing",
            "another watcher already holds the lease for this workspace",
        ));
    }
    let provider: Option<SharedProvider> = match cli.embedding_settings(&repo.repo_id)? {
        Some(cfg) => match create_external_provider(&cfg) {
            Ok(Some(p)) => Some(SharedProvider::new(p)),
            Ok(None) => None,
            Err(e) => {
                io.err(&style.err(&format!(
                    "  ✖ EMBEDDER NONFUNCTIONAL — auto-embed disabled (provider: {}; reason: {e})",
                    cfg.provider.as_deref().unwrap_or("?")
                )));
                None
            }
        },
        None => None,
    };
    let minters = cli.minters.clone();
    let clock = cli.seams.clock.clone();
    // The watcher and the drainer open connections of their own.
    cli.close();

    let drainer = provider.map(|p| start_drainer(&ws.db_path, &repo.repo_id, &minters, p));
    let drain_handle = drainer.as_ref().map(Drainer::handle);

    let glyph = sync_glyph(&style);
    let hook_drain = drain_handle.clone();
    let on_checkpoint: watch::CheckpointHook = Arc::new(move |r: &CheckpointResult| {
        if r.ingested.is_empty() && r.deleted.is_empty() && r.conflicted.is_empty() {
            return;
        }
        let conflicts = if r.conflicted.is_empty() {
            String::new()
        } else {
            format!(" !{}", r.conflicted.len())
        };
        io.err(&format!(
            "{} +{} -{}{conflicts}",
            style.ok(glyph),
            r.ingested.len(),
            r.deleted.len()
        ));
        if let Some(d) = &hook_drain {
            d.schedule();
        }
    });

    let outcome = watch::start(watch::WatchOptions {
        omgbase_dir: ws.omgbase_dir.clone(),
        db_path: ws.db_path.clone(),
        repo: repo.clone(),
        minters,
        clock,
        adapter_override: watch::adapter_override_from_env(),
        ready_patience: watch::READY_PATIENCE,
        drain: drain_handle.clone(),
        on_checkpoint: Some(on_checkpoint),
    })
    .map_err(|e| CliError::engine("error", e))?;
    let watcher = match outcome {
        watch::Outcome::Live(w) => w,
        watch::Outcome::LeaseHeld => {
            return Err(CliError::engine(
                "target_missing",
                "another watcher already holds the lease for this workspace",
            ));
        }
        watch::Outcome::NoSource => {
            io.err(&style.dim(&format!(
                "  {} has no filesystem source — nothing to watch",
                repo.slug
            )));
            if let Some(d) = drainer {
                d.close();
            }
            return Ok(EXIT_OK);
        }
        watch::Outcome::AdapterUnavailable(why) => {
            if let Some(d) = drainer {
                d.close();
            }
            return Err(CliError::engine_hint(
                "error",
                why,
                format!(
                    "install @omgbase/fs-adapter (the `{FS_ADAPTER_COMMAND}` bin on PATH) or set {}=<command line>",
                    watch::ADAPTER_ENV
                ),
            ));
        }
    };
    // Embed anything already stale at startup, in the background.
    if let Some(d) = &drain_handle {
        d.schedule();
    }
    io.err(&style.dim(&format!(
        "  watching {} — Ctrl-C to stop{}",
        repo.slug,
        if drainer.is_some() {
            " · auto-embed on"
        } else {
            ""
        }
    )));

    install_signal_handlers();
    while !signalled() {
        std::thread::sleep(POLL);
    }
    watcher.stop();
    if let Some(d) = drainer {
        d.flush();
        d.close();
    }
    Ok(EXIT_OK)
}

// ---- the remote mirror ------------------------------------------------------------------

/// `spec/sync` §5 "Launching the built-in `fs` adapter" for a registry-less
/// host: `$OMGBASE_FS_ADAPTER` (a command and leading arguments) when set,
/// else `omgbase-fs-adapter` from `PATH`; no fixed args; then `--root <dir>`.
fn fs_adapter_argv(root: &Path) -> Vec<String> {
    let mut argv =
        watch::adapter_override_from_env().unwrap_or_else(|| vec![FS_ADAPTER_COMMAND.to_owned()]);
    argv.push("--root".to_owned());
    argv.push(root.to_string_lossy().into_owned());
    argv
}

fn in_line(s: &SyncInSummary) -> String {
    format!(
        "in: +{} ingested, ={} unchanged, !{} conflicted, -{} deleted",
        s.ingested.len(),
        s.suppressed.len(),
        s.conflicted.len(),
        s.deleted.len()
    )
}

fn watch_line(s: &SyncInSummary) -> String {
    format!(
        "watch: +{} ={} !{} -{}",
        s.ingested.len(),
        s.suppressed.len(),
        s.conflicted.len(),
        s.deleted.len()
    )
}

/// The reference's `runFsMirror`: connect, open the `fs` adapter on `root`,
/// `sync_in` (+ `sync_out` with `out`), and with `watch` stay live —
/// `ready` awaited with bounded patience — until a signal.
fn run_fs_mirror(cli: &mut Cli, root: &Path, out: bool, watch: bool) -> Result<i32> {
    let (io, style) = (cli.io, cli.style);
    let log = move |msg: &str| io.err(&style.dim(&format!("  {msg}")));
    let spec = cli.remote_spec()?;
    let mut engine = McpEngineClient::connect(&spec).map_err(|e| {
        CliError::engine_hint(
            "remote_unavailable",
            format!("cannot reach the --server engine: {e}"),
            "an http(s) url is connected over Streamable HTTP; anything else is spawned as a stdio MCP server command (e.g. --server \"omg mcp -C /vault\")",
        )
    })?;
    let argv = fs_adapter_argv(root);
    let mut source = match ExternalSource::spawn(&argv[0], &argv[1..], &BTreeMap::new()) {
        Ok(s) => s,
        Err(e) => {
            let _ = engine.close();
            return Err(CliError::engine_hint(
                "error",
                format!("cannot start the `fs` adapter as `{}`: {e}", argv.join(" ")),
                format!(
                    "install @omgbase/fs-adapter (the `{FS_ADAPTER_COMMAND}` bin on PATH) or set {}=<command line>",
                    watch::ADAPTER_ENV
                ),
            ));
        }
    };
    let result = mirror(&mut engine, &mut source, out, watch, &log);
    let _ = source.close();
    let _ = engine.close();
    result.map(|()| EXIT_OK)
}

fn mirror(
    engine: &mut McpEngineClient,
    source: &mut ExternalSource,
    out: bool,
    watch: bool,
    log: &dyn Fn(&str),
) -> Result<()> {
    let mut co = Coordinator::new(engine, source);
    let s = co.sync_in()?;
    log(&in_line(&s));
    if out {
        let o = co.sync_out(0)?;
        log(&format!(
            "out: →{} written, ✗{} removed",
            o.written.len(),
            o.removed.len()
        ));
    }
    if !watch {
        return Ok(());
    }
    let Some(rx) = co.watch_in()? else {
        log("source cannot watch — nothing to do (did the initial sync above)");
        return Ok(());
    };
    // spec/sync §5: report live only once the feed is primed (bounded patience).
    let (readiness, early) = wait_ready(&rx, watch::READY_PATIENCE);
    if readiness != Readiness::Ready {
        log(&format!(
            "the fs adapter did not report ready within {}s — proceeding as if ready",
            watch::READY_PATIENCE.as_secs()
        ));
    }
    log("watching — Ctrl-C to stop");
    install_signal_handlers();
    let on_batch = |co: &mut Coordinator<'_>, paths: &[String]| match co.reconcile(paths) {
        Ok(s) => log(&watch_line(&s)),
        Err(e) => log(&format!("watch error: {e}")),
    };
    for paths in early {
        on_batch(&mut co, &paths);
    }
    while !signalled() {
        match rx.recv_timeout(POLL) {
            Ok(WatchEvent::Batch(paths)) => on_batch(&mut co, &paths),
            Ok(WatchEvent::Ready) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                log("the fs adapter's stream ended; watching stopped");
                break;
            }
        }
    }
    co.stop_watch()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fs_adapter_argv_follows_the_launcher_rule() {
        // Without the override: the PATH bin, then `--root`.
        // (The env var is process-global; only the default is asserted here,
        // `watch::tests` covers the override split.)
        if std::env::var_os(watch::ADAPTER_ENV).is_none() {
            assert_eq!(
                fs_adapter_argv(Path::new("/v")),
                [FS_ADAPTER_COMMAND, "--root", "/v"]
            );
        }
        let s = SyncInSummary {
            ingested: vec!["a.md".into()],
            suppressed: vec![],
            conflicted: vec![],
            deleted: vec!["b.md".into(), "c.md".into()],
        };
        assert_eq!(
            in_line(&s),
            "in: +1 ingested, =0 unchanged, !0 conflicted, -2 deleted"
        );
        assert_eq!(watch_line(&s), "watch: +1 =0 !0 -2");
    }
}
