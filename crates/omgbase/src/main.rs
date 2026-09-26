//! `omgbase` — the Rust binary over `omgbase-surface`.
//!
//! ```text
//! omgbase mcp [--workspace DIR] [--repo SLUG]   serve the tool catalog over MCP stdio
//! omgbase --version
//! ```
//!
//! Thin by design: workspace discovery and repo selection are
//! `omgbase-sync`'s, the tools are `omgbase-surface`'s, the transport is
//! [`mcp`]. The embedding provider named by the repo's `embedding.*`
//! settings is wired when it can be spawned (a failure is reported on stderr
//! and semantic queries fail `semantic_unavailable`).
//!
//! Two environment variables are the conformance seams of `spec/surface`
//! §7.1, for cross-engine interop runs only: `OMGBASE_SPEC_MINTER=sequential`
//! installs the fixture minter (`d_0, d_1, …`, counters fresh at process
//! start) for the workspace and the store, and `OMGBASE_SPEC_CLOCK=<RFC 3339>`
//! makes that instant "now" for every commit a tool stamps. Both are
//! announced on stderr when active.

mod mcp;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use omgbase_search::{EmbeddingProvider, EmbeddingSettings, create_external_provider};
use omgbase_store::{IdMinter, RandomMinter, SequentialMinter, Store};
use omgbase_surface::Surface;
use omgbase_sync::Workspace;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// `spec/surface` §7.1: `sequential` installs the fixture minter.
const SPEC_MINTER_ENV: &str = "OMGBASE_SPEC_MINTER";
/// `spec/surface` §7.1: an RFC 3339 instant that is "now" for the process.
const SPEC_CLOCK_ENV: &str = "OMGBASE_SPEC_CLOCK";

const USAGE: &str = "\
omgbase — a versioned, addressable graph layer over authored Markdown

Usage:
  omgbase mcp [--workspace DIR] [--repo SLUG]   serve the tool catalog over MCP stdio
  omgbase --version                             print the version
  omgbase --help                                this text

Environment:
  OMGBASE_WORKSPACE      the workspace when no --workspace is given
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

fn minter_for(seams: &Seams) -> Box<dyn IdMinter> {
    if seams.sequential_minter {
        Box::new(SequentialMinter::new())
    } else {
        Box::new(RandomMinter)
    }
}

struct McpArgs {
    workspace: Option<PathBuf>,
    repo: Option<String>,
}

fn parse_mcp_args(args: &[String]) -> Result<McpArgs, String> {
    let mut out = McpArgs {
        workspace: None,
        repo: None,
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

/// The repo's `embedding.*` settings as a provider, when configured.
fn embedding_provider(ws: &Workspace, repo_id: &str) -> Option<Box<dyn EmbeddingProvider>> {
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
    match create_external_provider(&cfg) {
        Ok(Some(p)) => {
            eprintln!("[mcp] semantic query enabled via {}", p.model());
            Some(p)
        }
        Ok(None) => None,
        Err(e) => {
            eprintln!("[mcp] embedder nonfunctional — semantic search disabled: {e}");
            None
        }
    }
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
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let ws =
        open_workspace(opts.workspace.as_deref(), &cwd, minter_for(&seams))?.ok_or_else(|| {
            "no workspace found: run inside a directory holding .omgbase/, or pass --workspace"
                .to_owned()
        })?;
    let repo = ws
        .select_repo(&cwd, opts.repo.as_deref())
        .map_err(|e| e.to_string())?;
    let provider = embedding_provider(&ws, &repo.repo_id);
    eprintln!(
        "[mcp] serving {} on stdio{}",
        repo.slug,
        if repo.root_path.is_some() {
            ""
        } else {
            " · sourceless (mutation disabled)"
        }
    );
    let root: &Path = ws.root();
    eprintln!("[mcp] workspace {}", root.display());
    // The surface owns its store: hand the workspace's database over to it.
    // The workspace minted nothing (selection only reads), so a fresh
    // sequential minter here still counts from 0 for the process (§7.1).
    let db = ws.db_path().to_path_buf();
    ws.close().map_err(|e| e.to_string())?;
    let store = Store::open_with_minter(&db, minter_for(&seams)).map_err(|e| e.to_string())?;
    let mut surface = Surface::new(store, &repo.repo_id, provider);
    if let Some(ts) = seams.clock {
        surface = surface.with_clock(move || ts.clone());
    }
    mcp::serve(&mut surface, VERSION).map_err(|e| e.to_string())
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
        assert!(parse_mcp_args(&["--bogus".into()]).is_err());
    }
}
