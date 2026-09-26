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

mod mcp;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use omgbase_search::{EmbeddingProvider, EmbeddingSettings, create_external_provider};
use omgbase_store::Store;
use omgbase_surface::Surface;
use omgbase_sync::Workspace;

const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "\
omgbase — a versioned, addressable graph layer over authored Markdown

Usage:
  omgbase mcp [--workspace DIR] [--repo SLUG]   serve the tool catalog over MCP stdio
  omgbase --version                             print the version
  omgbase --help                                this text

Environment:
  OMGBASE_WORKSPACE   the workspace when no --workspace is given
";

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

fn run_mcp(args: &[String]) -> Result<(), String> {
    let opts = parse_mcp_args(args)?;
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let ws = Workspace::locate(opts.workspace.as_deref(), &cwd)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
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
    let db = ws.db_path().to_path_buf();
    ws.close().map_err(|e| e.to_string())?;
    let store = Store::open(&db).map_err(|e| e.to_string())?;
    let mut surface = Surface::new(store, &repo.repo_id, provider);
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
