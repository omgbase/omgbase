//! `mcp` (§6): the MCP server on stdio (`spec/surface` §4, §7) with the
//! in-process filesystem watcher and the background embed drain.
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
//! `semantic_unavailable`).
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

use omgbase_search::{EmbeddingProvider, EmbeddingSettings, create_external_provider};
use omgbase_surface::Surface;
use omgbase_sync::workspace::{WORKSPACE_ENV, find_root};

use crate::cli::argv::{Opt, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result};
use crate::cli::seams::{MinterSource, SPEC_CLOCK_ENV, SPEC_MINTER_ENV, open_store};
use crate::drain::{DrainFn, DrainReport, Drainer, SharedProvider};
use crate::{mcp as transport, watch};

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
}

/// The repo's `embedding.*` settings, when a provider is named.
fn embedding_settings(store: &omgbase_store::Store, repo_id: &str) -> Option<EmbeddingSettings> {
    let settings = match omgbase_sync::resolve_settings(store, Some(repo_id)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[mcp] settings unreadable: {e}");
            return None;
        }
    };
    let emb = settings.get("embedding")?.as_object()?;
    let s = |k: &str| emb.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let n = |k: &str| emb.get(k).and_then(serde_json::Value::as_u64);
    let cfg = EmbeddingSettings {
        provider: s("provider"),
        model: s("model"),
        dim: n("dim").map(|d| usize::try_from(d).unwrap_or(0)),
        max_input_tokens: n("maxInputTokens")
            .or_else(|| n("max_input_tokens"))
            .map(|d| u32::try_from(d).unwrap_or(u32::MAX)),
    };
    cfg.provider
        .as_deref()
        .is_some_and(|p| !p.trim().is_empty())
        .then_some(cfg)
}

/// The settings as the host's one provider, spawned here and shared by the
/// query path (`semantic()`, `resolve`) and the drain thread.
fn embedding_provider(cfg: &EmbeddingSettings) -> Option<SharedProvider> {
    match create_external_provider(cfg) {
        Ok(Some(p)) => {
            eprintln!("[mcp] semantic query enabled via {}", p.model());
            Some(SharedProvider::new(p))
        }
        Ok(None) => None,
        Err(e) => {
            eprintln!("[mcp] embedder nonfunctional — semantic search + auto-embed disabled: {e}");
            None
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
}

impl Helpers {
    /// Stop the watcher (unwatch, close the adapter, join, release the
    /// lease), then flush and close the drainer.
    fn shutdown(self) {
        if let Some(w) = self.watcher {
            w.stop();
        }
        if let Some(d) = self.drainer {
            d.flush();
            d.close();
        }
    }
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
    let a = parse_args(args, &[Opt::flag("no-watch"), Opt::value("workspace")])?;
    announce_seams(cli);

    let ws = locate(cli, a.value("workspace"))?;
    let repo = cli.repo()?;

    // Connect the configured embedder once (if any) for `semantic()`; a
    // configured-but-broken embedder is reported, never fatal.
    let embedding = embedding_settings(cli.store()?, &repo.repo_id);
    let provider = embedding.as_ref().and_then(embedding_provider);
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

    let shared: Shared = Arc::new(Mutex::new(Some(Helpers { watcher, drainer })));
    spawn_signal_thread(Arc::clone(&shared));

    // The surface owns its store — a connection of its own over the database
    // — and the query path's handle to the shared provider (the last one
    // standing at shutdown, so dropping the surface kills the child).
    let store = open_store(&db, &minters).map_err(|e| CliError::engine("error", e))?;
    let query_provider: Option<Box<dyn EmbeddingProvider>> =
        provider.map(|p| Box::new(p) as Box<dyn EmbeddingProvider>);
    let mut surface = Surface::new(store, &repo.repo_id, query_provider);
    if let Some(ts) = clock {
        surface = surface.with_clock(move || ts.clone());
    }
    if let Some(h) = drain_handle {
        // Fires after every successful non-dry-run write (the catalog's
        // hook); the drain itself runs off this thread.
        surface = surface.with_mutation_hook(move || h.schedule());
    }
    let serve_opts = transport::ServeOptions {
        omgbase_dir: Some(omgbase_dir),
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
