//! `omgbase` — the Rust binary over `omgbase-surface`.
//!
//! ```text
//! omgbase mcp [--workspace DIR] [--repo SLUG] [--no-watch]   serve the tool catalog over MCP stdio
//! omgbase --version
//! ```
//!
//! Thin by design: workspace discovery and repo selection are
//! `omgbase-sync`'s, the tools are `omgbase-surface`'s, the transport is
//! [`mcp`]. Around the loop, two long-lived helpers mirror the reference's
//! `omg mcp`: the in-process filesystem [`watch`]er (on by default; off with
//! `--no-watch` or when another live watcher holds the lease) and the
//! background embed [`drain`]er (when the repo's `embedding.*` settings name
//! a provider). The embedding provider is wired when it can be spawned (a
//! failure is reported on stderr and semantic queries fail
//! `semantic_unavailable`).
//!
//! Threads: the MCP loop runs on the main thread and owns the surface's
//! store and provider; the watcher and the drainer each own a store
//! connection of their own over the same WAL database (busy timeout on
//! every connection) and, for the drainer, a second provider instance.
//! Shutdown — stdin EOF, `SIGINT` or `SIGTERM` — stops the watcher
//! (unwatch, close the adapter, join), releases the lease, flushes and
//! closes the drainer, then drops the surface (killing its provider).
//!
//! Two environment variables are the conformance seams of `spec/surface`
//! §7.1, for cross-engine interop runs only: `OMGBASE_SPEC_MINTER=sequential`
//! installs the fixture minter (`d_0, d_1, …`, counters fresh at process
//! start and shared by every thread) for the workspace and the store, and
//! `OMGBASE_SPEC_CLOCK=<RFC 3339>` makes that instant "now" for every commit
//! a tool or the watcher stamps. Both are announced on stderr.

mod drain;
mod mcp;
mod watch;

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omgbase_search::{EmbeddingProvider, EmbeddingSettings, create_external_provider};
use omgbase_store::{IdMinter, RandomMinter, SequentialMinter, Store};
use omgbase_surface::Surface;
use omgbase_sync::Workspace;

use crate::drain::{DrainFn, DrainReport, Drainer};

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// `spec/surface` §7.1: `sequential` installs the fixture minter.
const SPEC_MINTER_ENV: &str = "OMGBASE_SPEC_MINTER";
/// `spec/surface` §7.1: an RFC 3339 instant that is "now" for the process.
const SPEC_CLOCK_ENV: &str = "OMGBASE_SPEC_CLOCK";

/// How long a connection waits on a busy database before failing (the
/// writer lock keeps writers apart; this covers a read overlapping a
/// commit and the drainer's short vector transactions).
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const USAGE: &str = "\
omgbase — a versioned, addressable graph layer over authored Markdown

Usage:
  omgbase mcp [--workspace DIR] [--repo SLUG] [--no-watch]
                         serve the tool catalog over MCP stdio; by default an
                         in-process watcher keeps the repo fresh (needs the
                         `omgbase-fs-adapter` bin, see OMGBASE_FS_ADAPTER) and,
                         with an embedding provider configured, a background
                         drain embeds what mutations and checkpoints touch
  omgbase --version      print the version
  omgbase --help         this text

Options:
  --workspace DIR        the workspace (a directory holding .omgbase/)
  --repo SLUG            which repo, when the workspace has several
  --no-watch             don't run the in-process file watcher (it is auto-off
                         when another live watcher holds the lease)

Environment:
  OMGBASE_WORKSPACE      the workspace when no --workspace is given
  OMGBASE_FS_ADAPTER     the command line that runs the `fs` adapter instead
                         of the registry's `omgbase-fs-adapter` (e.g. `node
                         /path/to/fs-adapter/dist/src/bin.js`)
  OMGBASE_SPEC_MINTER    conformance seam (spec/surface §7.1): `sequential`
                         installs the fixture id minter for the process
  OMGBASE_SPEC_CLOCK     conformance seam: an RFC 3339 instant that is \"now\"
                         for every commit a tool stamps
";

/// The §7.1 seams as read from the environment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Seams {
    sequential_minter: bool,
    /// The pinned clock, canonical `YYYY-MM-DDTHH:MM:SS.fffZ`.
    clock: Option<String>,
}

/// Read the seams; an unrecognized value is a startup error (the seams are
/// too consequential to ignore silently).
fn read_seams(minter: Option<&str>, clock: Option<&str>) -> Result<Seams, String> {
    let sequential_minter = match minter.map(str::trim).filter(|v| !v.is_empty()) {
        None => false,
        Some("sequential") => true,
        Some(other) => {
            return Err(format!(
                "{SPEC_MINTER_ENV}={other:?}: the only supported value is `sequential`"
            ));
        }
    };
    let clock = match clock.map(str::trim).filter(|v| !v.is_empty()) {
        None => None,
        Some(v) => Some(canonical_instant(v).ok_or_else(|| {
            format!(
                "{SPEC_CLOCK_ENV}={v:?}: not an RFC 3339 instant (e.g. 2026-09-27T00:00:00.000Z)"
            )
        })?),
    };
    Ok(Seams {
        sequential_minter,
        clock,
    })
}

/// An RFC 3339 date-time (`Z` or a `±HH:MM` offset) as the store writes
/// instants (`spec/store` §2.4: UTC, millisecond precision).
fn canonical_instant(v: &str) -> Option<String> {
    use omgbase_store::time::{format_ms, parse_ms};
    if let Ok(ms) = parse_ms(v) {
        return Some(format_ms(ms));
    }
    // `<date-time>±HH:MM`: parse the body as UTC, then remove the offset.
    let idx = v.len().checked_sub(6)?;
    let (body, off) = v.split_at(idx);
    let sign = match off.as_bytes().first()? {
        b'+' => 1i64,
        b'-' => -1i64,
        _ => return None,
    };
    let (h, m) = off[1..].split_once(':')?;
    let (h, m): (i64, i64) = (h.parse().ok()?, m.parse().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    let ms = parse_ms(&format!("{body}Z")).ok()?;
    Some(format_ms(ms - sign * (h * 60 + m) * 60_000))
}

/// "Now" as a commit stamps it: the pinned clock, else the wall clock.
pub(crate) fn stamp(pinned: Option<&String>) -> String {
    pinned.cloned().unwrap_or_else(omgbase_sync::now_ts)
}

/// Where every thread's store gets its minter: the production CSPRNG
/// minter, or — under the §7.1 seam — one sequential minter shared by the
/// whole process (its counters are process-wide in the reference too), so a
/// watcher checkpoint and a tool call never mint the same id.
#[derive(Clone)]
pub(crate) enum MinterSource {
    Random,
    Sequential(Arc<Mutex<SequentialMinter>>),
}

impl MinterSource {
    fn from_seams(seams: &Seams) -> Self {
        if seams.sequential_minter {
            Self::Sequential(Arc::new(Mutex::new(SequentialMinter::new())))
        } else {
            Self::Random
        }
    }

    /// A minter for one store.
    pub(crate) fn minter(&self) -> Box<dyn IdMinter> {
        match self {
            Self::Random => Box::new(RandomMinter),
            Self::Sequential(shared) => {
                let shared = Arc::clone(shared);
                Box::new(move |prefix: &str| {
                    shared
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .mint(prefix)
                })
            }
        }
    }
}

/// Open a store connection over `db` with the busy timeout every connection
/// of this process carries.
pub(crate) fn open_store(db: &Path, minters: &MinterSource) -> Result<Store, String> {
    let store = Store::open_with_minter(db, minters.minter()).map_err(|e| e.to_string())?;
    store
        .conn()
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| format!("busy_timeout: {e}"))?;
    Ok(store)
}

struct McpArgs {
    workspace: Option<PathBuf>,
    repo: Option<String>,
    no_watch: bool,
}

fn parse_mcp_args(args: &[String]) -> Result<McpArgs, String> {
    let mut out = McpArgs {
        workspace: None,
        repo: None,
        no_watch: false,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--workspace" => {
                out.workspace = Some(PathBuf::from(
                    it.next().ok_or("--workspace needs a directory")?,
                ));
            }
            "--repo" => out.repo = Some(it.next().ok_or("--repo needs a slug")?.clone()),
            "--no-watch" => out.no_watch = true,
            other => match other.strip_prefix("--workspace=") {
                Some(v) => out.workspace = Some(PathBuf::from(v)),
                None => match other.strip_prefix("--repo=") {
                    Some(v) => out.repo = Some(v.to_owned()),
                    None => return Err(format!("unknown argument {other}")),
                },
            },
        }
    }
    Ok(out)
}

/// The repo's `embedding.*` settings, when a provider is named.
fn embedding_settings(ws: &Workspace, repo_id: &str) -> Option<EmbeddingSettings> {
    let settings = match omgbase_sync::resolve_settings(ws.store(), Some(repo_id)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[mcp] settings unreadable: {e}");
            return None;
        }
    };
    let emb = settings.get("embedding")?.as_object()?;
    let s = |k: &str| emb.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let n = |k: &str| emb.get(k).and_then(|v| v.as_u64());
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

/// The settings as a provider for the query path (`semantic()`, `resolve`).
fn embedding_provider(cfg: &EmbeddingSettings) -> Option<Box<dyn EmbeddingProvider>> {
    match create_external_provider(cfg) {
        Ok(Some(p)) => {
            eprintln!("[mcp] semantic query enabled via {}", p.model());
            Some(p)
        }
        Ok(None) => None,
        Err(e) => {
            eprintln!("[mcp] embedder nonfunctional — semantic search + auto-embed disabled: {e}");
            None
        }
    }
}

/// The drainer over its own connection and its own provider instance,
/// both built on the drain thread (`spec/search` §2.6).
fn start_drainer(
    db: &Path,
    repo_id: &str,
    minters: &MinterSource,
    cfg: &EmbeddingSettings,
) -> Drainer {
    let (db, repo_id, minters, cfg) = (
        db.to_path_buf(),
        repo_id.to_owned(),
        minters.clone(),
        cfg.clone(),
    );
    Drainer::spawn(drain::DEBOUNCE, move || {
        let store = open_store(&db, &minters)?;
        let provider = create_external_provider(&cfg)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no embedding provider configured".to_owned())?;
        Ok(Box::new(move || {
            let stats = store
                .drain(&repo_id, provider.as_ref())
                .map_err(|e| e.to_string())?;
            Ok(DrainReport {
                embedded: stats.blocks.embedded + stats.docs.embedded,
                pooled: stats.docs.pooled,
            })
        }) as DrainFn)
    })
}

/// `spec/sync` §1 precedence — an explicit `--workspace`, else
/// `$OMGBASE_WORKSPACE`, else discovery from `cwd` — opened with `minter`.
fn open_workspace(
    explicit: Option<&Path>,
    cwd: &Path,
    minter: Box<dyn IdMinter>,
) -> Result<Option<Workspace>, String> {
    let root = explicit
        .map(Path::to_path_buf)
        .or_else(|| {
            std::env::var_os(omgbase_sync::workspace::WORKSPACE_ENV)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| omgbase_sync::workspace::find_root(cwd));
    match root {
        Some(root) => Workspace::open_with_minter(root, minter)
            .map(Some)
            .map_err(|e| e.to_string()),
        None => Ok(None),
    }
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

fn run_mcp(args: &[String]) -> Result<(), String> {
    let opts = parse_mcp_args(args)?;
    let seams = read_seams(
        std::env::var(SPEC_MINTER_ENV).ok().as_deref(),
        std::env::var(SPEC_CLOCK_ENV).ok().as_deref(),
    )?;
    if seams.sequential_minter {
        eprintln!("[mcp] conformance seam: sequential id minter ({SPEC_MINTER_ENV})");
    }
    if let Some(ts) = &seams.clock {
        eprintln!("[mcp] conformance seam: clock pinned to {ts} ({SPEC_CLOCK_ENV})");
    }
    let minters = MinterSource::from_seams(&seams);
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let ws =
        open_workspace(opts.workspace.as_deref(), &cwd, minters.minter())?.ok_or_else(|| {
            "no workspace found: run inside a directory holding .omgbase/, or pass --workspace"
                .to_owned()
        })?;
    let repo = ws
        .select_repo(&cwd, opts.repo.as_deref())
        .map_err(|e| e.to_string())?;

    // Connect the configured embedder once (if any) for `semantic()`; a
    // configured-but-broken embedder is reported, never fatal.
    let embedding = embedding_settings(&ws, &repo.repo_id);
    let provider = embedding.as_ref().and_then(embedding_provider);
    let root: &Path = ws.root();
    eprintln!("[mcp] workspace {}", root.display());
    let omgbase_dir = ws.omgbase_dir().to_path_buf();
    let db = ws.db_path().to_path_buf();
    // The workspace minted nothing (selection only reads), so the shared
    // sequential minter still counts from 0 for the process (§7.1).
    ws.close().map_err(|e| e.to_string())?;

    // The drainer: only when the provider is live (the reference gates it on
    // `embedding` having loaded — a broken embedder disables auto-embed too).
    let drainer = match (&embedding, provider.is_some()) {
        (Some(cfg), true) => Some(start_drainer(&db, &repo.repo_id, &minters, cfg)),
        _ => None,
    };
    let drain_handle = drainer.as_ref().map(Drainer::handle);

    // The watcher: off with --no-watch or when another live watcher holds
    // the lease; otherwise prime, spawn the adapter, stream.
    let mut watcher = None;
    let status = if opts.no_watch {
        "watcher off (--no-watch)".to_owned()
    } else {
        match watch::start(watch::WatchOptions {
            omgbase_dir: omgbase_dir.clone(),
            db_path: db.clone(),
            repo: repo.clone(),
            minters: minters.clone(),
            clock: seams.clock.clone(),
            adapter_override: watch::adapter_override_from_env(),
            drain: drain_handle.clone(),
        })? {
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

    // The surface owns its store: a connection of its own over the database.
    let store = open_store(&db, &minters)?;
    let mut surface = Surface::new(store, &repo.repo_id, provider);
    if let Some(ts) = seams.clock {
        surface = surface.with_clock(move || ts.clone());
    }
    if let Some(h) = drain_handle {
        // Fires after every successful non-dry-run write (the catalog's
        // hook); the drain itself runs off this thread.
        surface = surface.with_mutation_hook(move || h.schedule());
    }
    let serve_opts = mcp::ServeOptions {
        omgbase_dir: Some(omgbase_dir),
    };
    let served = mcp::serve(&mut surface, VERSION, &serve_opts).map_err(|e| e.to_string());
    // stdin closed (or the loop failed): stop the helpers, then the surface
    // drops with its provider.
    if let Some(h) = take_helpers(&shared) {
        h.shutdown();
    }
    drop(surface);
    served
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version" | "-V") => {
            println!("omgbase {VERSION}");
            ExitCode::SUCCESS
        }
        None | Some("--help" | "-h") => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("mcp") => match run_mcp(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("omgbase mcp: {e}");
                ExitCode::from(1)
            }
        },
        Some(other) => {
            eprintln!("omgbase: unknown command {other}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seams_parse_and_reject() {
        assert_eq!(read_seams(None, None).unwrap(), Seams::default());
        let s = read_seams(Some("sequential"), Some("2026-09-27T00:00:00Z")).unwrap();
        assert!(s.sequential_minter);
        assert_eq!(s.clock.as_deref(), Some("2026-09-27T00:00:00.000Z"));
        assert!(read_seams(Some("random"), None).is_err());
        assert!(read_seams(None, Some("yesterday")).is_err());
        assert!(!read_seams(Some(""), Some(" ")).unwrap().sequential_minter);
    }

    #[test]
    fn canonical_instant_accepts_offsets() {
        assert_eq!(
            canonical_instant("2026-09-27T02:30:00.5+02:30").as_deref(),
            Some("2026-09-27T00:00:00.500Z")
        );
        assert_eq!(
            canonical_instant("2026-09-26T23:00:00-01:00").as_deref(),
            Some("2026-09-27T00:00:00.000Z")
        );
        assert_eq!(canonical_instant("2026-09-27"), None);
        assert_eq!(canonical_instant("2026-09-27T00:00:00+25:00"), None);
    }

    #[test]
    fn mcp_args() {
        let a = parse_mcp_args(&["--workspace".into(), "/w".into(), "--repo=x".into()]).unwrap();
        assert_eq!(a.workspace.as_deref(), Some(Path::new("/w")));
        assert_eq!(a.repo.as_deref(), Some("x"));
        assert!(!a.no_watch);
        assert!(parse_mcp_args(&["--no-watch".into()]).unwrap().no_watch);
        assert!(parse_mcp_args(&["--bogus".into()]).is_err());
    }

    #[test]
    fn the_sequential_minter_is_shared_across_stores() {
        let minters = MinterSource::from_seams(&Seams {
            sequential_minter: true,
            clock: None,
        });
        let mut a = minters.minter();
        let mut b = minters.minter();
        assert_eq!(a.mint("d"), "d_0");
        assert_eq!(b.mint("d"), "d_1");
        assert_eq!(a.mint("b"), "b_0");
        let mut r = MinterSource::Random.minter();
        assert!(r.mint("d").starts_with("d_"));
        assert_eq!(
            stamp(Some(&"2026-09-27T00:00:00.000Z".to_owned())),
            "2026-09-27T00:00:00.000Z"
        );
        assert!(stamp(None).ends_with('Z'));
    }
}
