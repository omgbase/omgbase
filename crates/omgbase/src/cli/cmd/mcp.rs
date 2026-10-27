//! `mcp` (§6): the MCP server on stdio (`spec/surface` §4, §7) with the
//! in-process filesystem watcher and the background embed drain. `--tools
//! <full|minimal>` (cli 4.2) picks the catalog profile the surface serves
//! (`spec/surface` §4 "Profiles"); the `mcp.tools` setting is the default
//! when the flag is absent.
//!
//! Thin by design: workspace discovery and repo selection are the context's
//! (`-C` / `--workspace`), the tools are `omgbase-surface`'s, the transport
//! is [`crate::mcp`]. Around the loop, two long-lived helpers mirror the
//! reference's `omg mcp`: the [`crate::watch`]er (on by default; off with
//! `--no-watch` or when another live watcher holds the lease; started as
//! `spec/sync` §5 orders it — lease, adapter, `watch`, wait for `ready`,
//! priming sweep, then "watcher live") and the [`crate::drain`]er (when the
//! repo's `embedding.*` settings name a provider; a provider that cannot
//! be spawned is reported on stderr and semantic queries fail
//! `provider_unavailable`).
//!
//! Threads: the MCP loop runs on the main thread and owns the surface's
//! store; the watcher and the drainer each own a store connection of their
//! own over the same WAL database (busy timeout on every connection). The
//! embedding provider is **one** process for the whole host, as the
//! reference's one `embedding.worker` serves both `semantic()` and its
//! `EmbedDrainer`: it is spawned once here and shared through a
//! [`SharedProvider`] — the surface holds one handle for the query path,
//! the drain thread another, and the lock is held per `embed` batch, so a
//! query that lands mid-drain waits for one batch, never the drain.
//! Shutdown — stdin EOF, `SIGINT` or `SIGTERM` — stops the watcher
//! (unwatch, close the adapter, join), releases the lease, flushes and
//! closes the drainer (whose handle drops with its thread), then drops the
//! surface, whose handle is the last: the provider child is killed there.
//!
//! CRITICAL: on stdio, stdout is the protocol channel. Nothing here writes
//! to stdout — every diagnostic goes to stderr.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omgbase_git_adapter::{Cadence, CheckpointScheduler, read_git_config};
use omgbase_search::{EmbeddingProvider, EmbeddingSettings, create_external_provider};
use omgbase_store::manifest::{
    ManifestState, NATIVE_PROVIDER, history_provider_of, provider_config_of, read_capability,
};
use omgbase_surface::{Profile, Surface};
use omgbase_sync::workspace::{WORKSPACE_ENV, find_root};
use omgbase_sync::{run_provider_checkpoint, with_writer_lock};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Io, Result};
use crate::cli::render::Style;
use crate::cli::seams::{
    MinterSource, SPEC_CLOCK_ENV, SPEC_MINTER_ENV, WRITER_LOCK_TIMEOUT_ENV, open_store,
    open_store_at,
};
use crate::drain::{DrainFn, DrainReport, Drainer, SharedProvider};
use crate::{mcp as transport, watch};
use serde_json::Value as Json;

/// The seams announced on stderr (§6 `mcp`), so a conformance run is
/// visibly not a production one.
fn announce_seams(cli: &Cli) {
    if cli.seams.sequential_minter {
        cli.io.err(&cli.style.dim(&format!(
            "[mcp] spec seam: sequential id minter ({SPEC_MINTER_ENV}=sequential) — conformance run, not for production"
        )));
    }
    if let Some(ts) = &cli.seams.clock {
        cli.io.err(&cli.style.dim(&format!(
            "[mcp] spec seam: clock pinned to {ts} ({SPEC_CLOCK_ENV}) — conformance run, not for production"
        )));
    }
    if let Some(ms) = cli.seams.writer_lock_timeout_ms {
        cli.io.err(&cli.style.dim(&format!(
            "[mcp] test seam: writer lock waits {ms} ms ({WRITER_LOCK_TIMEOUT_ENV}) — not for production"
        )));
    }
}

/// The repo's `embedding.*` settings, when a provider is named.
fn embedding_settings(store: &omgbase_store::Store, repo_id: &str) -> Option<EmbeddingSettings> {
    match crate::cli::seams::embedding_settings(store, repo_id) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[mcp] settings unreadable: {e}");
            None
        }
    }
}

/// The settings as the host's one provider, spawned here and shared by the
/// query path (`semantic()`, `resolve`) and the drain thread; `Err(reason)`
/// when it cannot start — the capability's `unavailable` state (Phase 2).
fn embedding_provider(
    cfg: &EmbeddingSettings,
) -> std::result::Result<Option<SharedProvider>, String> {
    match create_external_provider(cfg) {
        Ok(Some(p)) => {
            eprintln!("[mcp] semantic query enabled via {}", p.model());
            Ok(Some(SharedProvider::new(p)))
        }
        Ok(None) => Ok(None),
        Err(e) => {
            eprintln!("[mcp] embedder nonfunctional — semantic search + auto-embed disabled: {e}");
            Err(e.to_string())
        }
    }
}

/// The drainer over its own connection (built on the drain thread) and a
/// handle to the host's shared provider (`spec/search` §2.6): every batch
/// the drain embeds takes the provider lock once and releases it.
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
            // The indexer (Phase 2): positioned by the watermark.
            let stats = store
                .require_semantic()
                .and_then(|sem| sem.drain(&store, &repo_id, &provider))
                .map_err(|e| e.to_string())?
                .stats;
            Ok(DrainReport {
                embedded: stats.blocks.embedded + stats.docs.embedded,
                pooled: stats.docs.pooled,
            })
        }) as DrainFn)
    })
}

// ---- shutdown -------------------------------------------------------------------------

/// Set by the `SIGINT`/`SIGTERM` handler; polled by the signal thread.
static SIGNALLED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_sig: libc::c_int) {
    SIGNALLED.store(true, Ordering::SeqCst);
}

/// Install the handlers (idempotent enough for one process).
fn install_signal_handlers() {
    // SAFETY: `signal` installs a handler that only stores to an atomic —
    // async-signal-safe — and touches no other state.
    let handler = on_signal as extern "C" fn(libc::c_int) as *const () as libc::sighandler_t;
    unsafe {
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGTERM, handler);
    }
}

/// The helpers shutdown stops, in the reference's order.
#[derive(Default)]
struct Helpers {
    watcher: Option<watch::Watcher>,
    drainer: Option<Drainer>,
    /// The git provider's checkpoint scheduler (17.6, Phase 6b).
    scheduler: Option<CheckpointScheduler>,
}

impl Helpers {
    /// Stop the watcher (unwatch, close the adapter, join, release the
    /// lease), then flush and close the drainer, then run a debounced git
    /// checkpoint still pending (its error is reported, never thrown).
    fn shutdown(self) {
        if let Some(w) = self.watcher {
            w.stop();
        }
        if let Some(d) = self.drainer {
            d.flush();
            d.close();
        }
        if let Some(s) = self.scheduler {
            s.flush();
            s.close();
        }
    }
}

/// The git history provider's cadence (`spec/store` §5.12 "Cadence", 17.6 —
/// Phase 6b): the mutation hook also runs the checkpoint worker — under
/// `every` synchronously after each successful write (the git history is
/// complete without `omg sync`), under `{ debounce_ms }` once, `debounce_ms`
/// after the last mutation (a burst folds into one commit). The worker runs
/// over a connection of its own under the workspace writer lock — taken by
/// the run unless the caller already holds it (the hook fires inside a locked
/// tool call; the reference's lock is re-entrant, this engine's is not). The
/// watcher's checkpoints notify it too. `None` for a native repository.
fn git_scheduler(
    store: &omgbase_store::Store,
    db: &Path,
    omgbase_dir: &Path,
    repo_id: &str,
    minters: &MinterSource,
    clock: Option<String>,
    lock: omgbase_sync::WriterLockOptions,
) -> Option<(CheckpointScheduler, Cadence)> {
    let row = read_capability(store.conn(), repo_id, "history")
        .ok()
        .flatten()
        .filter(|r| r.state == ManifestState::Enabled)?;
    if history_provider_of(Some(&row)) == NATIVE_PROVIDER {
        return None;
    }
    let cadence = read_git_config(&provider_config_of(&row)).cadence;
    let (db, omgbase_dir, repo_id, minters) = (
        db.to_path_buf(),
        omgbase_dir.to_path_buf(),
        repo_id.to_owned(),
        minters.clone(),
    );
    let run = move |under_lock: bool| -> std::result::Result<(), String> {
        let now = crate::stamp(clock.as_ref());
        let store = open_store_at(&db, &minters, &now)?;
        let once = || run_provider_checkpoint(&store, &repo_id, &now).map(|_| ());
        if under_lock {
            once().map_err(|e| e.to_string())
        } else {
            with_writer_lock(&omgbase_dir, lock, once).map_err(|e| e.to_string())
        }
    };
    let on_error = |e: &str| eprintln!("[mcp] git checkpoint failed: {e}");
    Some((
        CheckpointScheduler::new(cadence.clone(), Arc::new(run), Some(Arc::new(on_error))),
        cadence,
    ))
}

/// Whoever gets here first — the main thread at stdin EOF or the signal
/// thread — runs the shutdown; the other finds nothing to do.
type Shared = Arc<Mutex<Option<Helpers>>>;

fn take_helpers(shared: &Shared) -> Option<Helpers> {
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
}

/// A thread that ends the process cleanly on a signal while the main
/// thread is blocked reading stdin (which a signal does not interrupt).
fn spawn_signal_thread(shared: Shared) {
    install_signal_handlers();
    std::thread::Builder::new()
        .name("omgbase-signals".to_owned())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(50));
                if SIGNALLED.load(Ordering::SeqCst) {
                    if let Some(h) = take_helpers(&shared) {
                        eprintln!("[mcp] signal: shutting down");
                        h.shutdown();
                        std::process::exit(0);
                    }
                    return;
                }
            }
        })
        .expect("spawn the signal thread");
}

// ---- the tools profile (`spec/surface` §4 "Profiles"; `spec/cli` §6 `mcp`, 4.2) -------

/// `--tools <full|minimal>`: the flag's value as a profile, or the usage
/// error (exit 2) naming both (the reference's wording).
fn profile_flag(value: &str) -> Result<Profile> {
    value.parse::<Profile>().map_err(|_| {
        CliError::usage(format!(
            "--tools must be one of full|minimal (got {})",
            Json::String(value.to_owned())
        ))
    })
}

/// The profile to serve: the flag, else the `mcp.tools` setting (the repo's
/// over the workspace's), else `full`. A setting value that is not one of
/// the two names is reported on stderr and ignored — the server comes up
/// `full`, never silently reduced (as the reference does).
fn tools_profile(
    io: Io,
    style: &Style,
    flag: Option<&str>,
    store: &omgbase_store::Store,
    repo_id: &str,
) -> Result<Profile> {
    if let Some(v) = flag {
        return profile_flag(v);
    }
    let settings = omgbase_sync::resolve_settings(store, Some(repo_id))?;
    match settings.get("mcp").and_then(|m| m.get("tools")) {
        None => Ok(Profile::Full),
        Some(v) => match v.as_str().and_then(|s| s.parse::<Profile>().ok()) {
            Some(p) => Ok(p),
            None => {
                io.err(&style.warn(&format!(
                    "[mcp] ignoring setting mcp.tools = {v} (expected full|minimal); serving the full catalog"
                )));
                Ok(Profile::Full)
            }
        },
    }
}

// ---- the command --------------------------------------------------------------------------

/// `spec/sync` §1 precedence for the served workspace: an explicit
/// `--workspace`, else `$OMGBASE_WORKSPACE`, else discovery from the cwd
/// (`-C`), with the tailored hint when none is found.
fn locate(cli: &mut Cli, explicit: Option<&str>) -> Result<crate::cli::context::WsInfo> {
    if let Some(dir) = explicit {
        return cli.open_at(PathBuf::from(dir));
    }
    if let Some(env) = std::env::var_os(WORKSPACE_ENV).filter(|v| !v.is_empty()) {
        return cli.open_at(PathBuf::from(env));
    }
    if find_root(&cli.cwd).is_none() {
        let message = cli.no_workspace_error().message().to_owned();
        let p = &cli.prog;
        return Err(CliError::engine_hint(
            "repo_not_found",
            message,
            format!(
                "`{p} mcp` serves one workspace: point it there with -C, e.g. {{\"command\": \"{p}\", \"args\": [\"mcp\", \"-C\", \"/path/to/notes\"]}} in the MCP host config — or create one first with `{p} init <dir>` and `{p} -C <dir> source add .`"
            ),
        ));
    }
    cli.workspace()
}

pub fn mcp(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "mcp");
    }
    // `--workspace <dir>` is the host-config spelling this binary has always
    // accepted (an alias of the global `-C` for the served workspace).
    let a = parse_args(
        args,
        &[
            Opt::flag("no-watch"),
            Opt::value("workspace"),
            Opt::value("tools"),
        ],
    )?;
    // The flag is checked before the workspace is opened: a bad value is a
    // usage error wherever the host starts us.
    if let Some(v) = a.value("tools") {
        profile_flag(v)?;
    }
    announce_seams(cli);

    let ws = locate(cli, a.value("workspace"))?;
    let repo = cli.repo()?;
    let (io, style) = (cli.io, cli.style);
    let profile = tools_profile(io, &style, a.value("tools"), cli.store()?, &repo.repo_id)?;

    // Connect the configured embedder once (if any) for `semantic()`; a
    // configured-but-broken embedder is reported, never fatal.
    // (`spec/store` §5.10, Phase 4b) a repository whose semantic row was
    // switched off by `omg embed disable` loads no embedder: `semantic()`
    // answers `capability_unavailable { semantic, disabled, fix }` from the
    // surface's gate, `blocks_resolve` is FTS-only.
    let switched_off = cli
        .store()?
        .semantic_switched_off(&repo.repo_id)
        .unwrap_or(false);
    let embedding = embedding_settings(cli.store()?, &repo.repo_id).filter(|_| !switched_off);
    let (provider, embedder_fault) = match embedding.as_ref().map(embedding_provider) {
        Some(Ok(p)) => (p, None),
        Some(Err(reason)) => (None, Some(reason)),
        None => (None, None),
    };
    eprintln!("[mcp] workspace {}", ws.root.display());
    let omgbase_dir = ws.omgbase_dir.clone();
    let db = ws.db_path.clone();
    let minters = cli.minters.clone();
    let clock = cli.seams.clock.clone();
    // The context minted nothing (selection only reads), so the shared
    // sequential minter still counts from 0 for the process (§7.1).
    cli.close();

    // The drainer: only when the provider is live (the reference gates it on
    // `embedding` having loaded — a broken embedder disables auto-embed too);
    // it shares the provider the query path uses.
    let drainer = provider
        .as_ref()
        .map(|p| start_drainer(&db, &repo.repo_id, &minters, p.clone()));
    let drain_handle = drainer.as_ref().map(Drainer::handle);

    // The git provider's checkpoint scheduler (Phase 6b), read off the
    // repository's manifest row before the context closes.
    let scheduler = {
        let probe = open_store_at(&db, &minters, &crate::stamp(clock.as_ref()))
            .map_err(|e| CliError::engine("error", e))?;
        git_scheduler(
            &probe,
            &db,
            &omgbase_dir,
            &repo.repo_id,
            &minters,
            clock.clone(),
            cli.seams.lock_options(),
        )
    };
    if let Some((_, cadence)) = &scheduler {
        eprintln!(
            "[mcp] git checkpoint on mutation: {}",
            match cadence {
                Cadence::Every => "every write".to_owned(),
                Cadence::Debounce { debounce_ms } =>
                    format!("{debounce_ms} ms after the last write"),
            }
        );
    }
    let scheduler = scheduler.map(|(s, _)| s);
    let watch_git: Option<Arc<dyn Fn() + Send + Sync>> = scheduler.as_ref().map(|s| {
        let s = s.clone();
        Arc::new(move || s.notify(false)) as Arc<dyn Fn() + Send + Sync>
    });

    // The watcher: off with --no-watch or when another live watcher holds
    // the lease; otherwise spawn the adapter, watch, wait for ready, prime,
    // stream (spec/sync §5) — "watcher live" is reported only after that.
    let mut watcher = None;
    let status = if a.flag("no-watch") {
        "watcher off (--no-watch)".to_owned()
    } else {
        match watch::start(watch::WatchOptions {
            omgbase_dir: omgbase_dir.clone(),
            db_path: db.clone(),
            repo: repo.clone(),
            minters: minters.clone(),
            clock: clock.clone(),
            adapter_override: watch::adapter_override_from_env(),
            ready_patience: watch::READY_PATIENCE,
            drain: drain_handle.clone(),
            git: watch_git,
            on_checkpoint: None,
        })
        .map_err(|e| CliError::engine("error", e))?
        {
            watch::Outcome::Live(w) => {
                eprintln!("[watch] adapter: {}", w.argv().join(" "));
                watcher = Some(w);
                "watcher live".to_owned()
            }
            watch::Outcome::LeaseHeld => "watcher elsewhere".to_owned(),
            watch::Outcome::NoSource => "sourceless (no watch)".to_owned(),
            watch::Outcome::AdapterUnavailable(why) => {
                eprintln!(
                    "[mcp] watcher unavailable: {why}\n      install @omgbase/fs-adapter (the `omgbase-fs-adapter` bin on PATH) or set {}=<command line>; serving without a watcher — one-shot commands and `omg watch` keep the repo fresh",
                    watch::ADAPTER_ENV
                );
                "no watch (adapter unavailable)".to_owned()
            }
        }
    };
    eprintln!("[mcp] serving {} on stdio · {status}", repo.slug);
    if drainer.is_some() {
        eprintln!("[mcp] auto-embed on mutation enabled");
    }
    if profile != Profile::Full {
        eprintln!("[mcp] tools profile: {profile}");
    }

    let shared: Shared = Arc::new(Mutex::new(Some(Helpers {
        watcher,
        drainer,
        scheduler: scheduler.clone(),
    })));
    spawn_signal_thread(Arc::clone(&shared));

    // The surface owns its store — a connection of its own over the database
    // — and the query path's handle to the shared provider (the last one
    // standing at shutdown, so dropping the surface kills the child).
    let mut store = open_store_at(&db, &minters, &crate::stamp(clock.as_ref()))
        .map_err(|e| CliError::engine("error", e))?;
    // Capability discovery (Phase 2): the state is derived from the
    // configuration (`version`); a provider configured but failed to start
    // marks the capability `unavailable` with its reason, so a
    // `semantic(...)` query answers `capability_unavailable` (retriable)
    // rather than "none is configured"; nothing configured keeps the
    // module and the pinned `provider_unavailable`.
    if let Some(reason) = embedder_fault {
        store.detach_semantic(Some(reason));
    }
    let query_provider: Option<Box<dyn EmbeddingProvider>> =
        provider.map(|p| Box::new(p) as Box<dyn EmbeddingProvider>);
    let mut surface = Surface::new(store, &repo.repo_id, query_provider)
        .with_build_info(crate::cli::build_info())
        .with_profile(profile);
    if let Some(name) = embedding.as_ref().and_then(|e| e.provider.clone()) {
        surface = surface.with_provider_name(&name);
    }
    if let Some(ts) = clock {
        surface = surface.with_clock(move || ts.clone());
    }
    if drain_handle.is_some() || scheduler.is_some() {
        // Fires after every successful non-dry-run write (the catalog's
        // hook), inside the tool call's writer lock; the drain itself runs
        // off this thread, the git checkpoint under `every` right here.
        let hook_scheduler = scheduler.clone();
        surface = surface.with_mutation_hook(move || {
            if let Some(h) = &drain_handle {
                h.schedule();
            }
            if let Some(s) = &hook_scheduler {
                s.notify(true);
            }
        });
    }
    let serve_opts = transport::ServeOptions {
        omgbase_dir: Some(omgbase_dir),
        lock: cli.seams.lock_options(),
    };
    let served = transport::serve(&mut surface, crate::cli::VERSION, &serve_opts);
    // stdin closed (or the loop failed): stop the helpers (the drain thread's
    // provider handle goes with it), then the surface drops with the last
    // handle — the provider child dies here.
    if let Some(h) = take_helpers(&shared) {
        h.shutdown();
    }
    drop(surface);
    served.map_err(|e| CliError::engine("error", e.to_string()))?;
    Ok(EXIT_OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_beats_the_setting_and_a_bad_setting_serves_full() {
        let style = Style::detect(true, false);
        let t = |flag: Option<&str>, store: &omgbase_store::Store, repo: &str| {
            tools_profile(Io, &style, flag, store, repo)
        };
        let mut store = omgbase_store::Store::open_in_memory().unwrap();
        let repo = store.create_repo("r").unwrap();
        assert_eq!(t(None, &store, &repo).unwrap(), Profile::Full);
        assert_eq!(t(Some("minimal"), &store, &repo).unwrap(), Profile::Minimal);
        let err = t(Some("lite"), &store, &repo).unwrap_err();
        assert!(matches!(err, CliError::Usage { .. }));
        assert_eq!(
            err.message(),
            "--tools must be one of full|minimal (got \"lite\")"
        );
        let mut settings = serde_json::Map::new();
        settings.insert("mcp".to_owned(), serde_json::json!({ "tools": "minimal" }));
        omgbase_sync::write_repo_settings(&store, &repo, &settings).unwrap();
        assert_eq!(t(None, &store, &repo).unwrap(), Profile::Minimal);
        assert_eq!(t(Some("full"), &store, &repo).unwrap(), Profile::Full);
        // An unrecognized setting is reported (stderr) and the full catalog served.
        settings.insert("mcp".to_owned(), serde_json::json!({ "tools": "lite" }));
        omgbase_sync::write_repo_settings(&store, &repo, &settings).unwrap();
        assert_eq!(t(None, &store, &repo).unwrap(), Profile::Full);
        settings.insert("mcp".to_owned(), serde_json::json!({ "tools": 3 }));
        omgbase_sync::write_repo_settings(&store, &repo, &settings).unwrap();
        assert_eq!(t(None, &store, &repo).unwrap(), Profile::Full);
    }
}
