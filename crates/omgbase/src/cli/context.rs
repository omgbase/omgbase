//! The per-invocation context every verb receives (`spec/cli` §2.1, §3.7):
//! the global flags, the resolved cwd, the invoked program name, the IO and
//! style, the seams; and the lazily opened engine — workspace discovery
//! (walk up for `.omgbase/`), repo selection (`spec/sync` §1), one store
//! connection that becomes the [`Surface`] every verb calls tools on, the
//! embedding provider when a verb wants `semantic()`.

use std::path::{Path, PathBuf};

use omgbase_search::{EmbeddingProvider, EmbeddingSettings, create_external_provider};
use omgbase_store::Store;
use omgbase_surface::Surface;
use omgbase_sync::workspace::{OMGBASE_DIR, find_root};
use omgbase_sync::{RealFileSystem, RepoRow, WatchLease, freshness_sweep};
use serde_json::{Value as Json, json};

use super::argv::Globals;
use super::output::{CliError, Io, Result};
use super::render::Style;
use super::seams::{MinterSource, Seams, open_store, stamp};

/// Commands that run without a workspace (§3.7).
pub const NO_WORKSPACE_OK: &[&str] = &["init", "help", "version"];
/// Commands that manage sync themselves — no freshness sweep (§3.7).
pub const SKIP_FRESHNESS: &[&str] = &["sync", "mcp", "init", "source", "help", "version", "shell"];
/// Commands that accept `--server` (§2.3).
pub const REMOTE_OK: &[&str] = &[
    "sync", "query", "outline", "hist", "cat", "ls", "diff", "find", "log", "new", "mv", "meta",
    "rm", "update", "retarget", "apply", "insert", "move", "split", "merge", "done", "append",
    "node", "shell",
];

/// An open workspace's paths.
#[derive(Clone, Debug)]
pub struct WsInfo {
    pub root: PathBuf,
    pub omgbase_dir: PathBuf,
    pub db_path: PathBuf,
}

/// The engine behind the verbs: a store until a repo is selected, then the
/// surface over it.
enum Engine {
    Closed,
    Store(Box<Store>),
    Surface(Box<Surface>),
}

/// The context.
pub struct Cli {
    pub flags: Globals,
    pub io: Io,
    pub style: Style,
    /// The cwd after `-C`, resolved (`path.resolve` semantics: absolute,
    /// normalized, symlinks kept).
    pub cwd: PathBuf,
    /// The name the binary was invoked as (`omg` or `omgbase`).
    pub prog: String,
    pub seams: Seams,
    pub minters: MinterSource,
    ws: Option<WsInfo>,
    engine: Engine,
    repo: Option<RepoRow>,
}

/// Node's `path.resolve` for one segment against `base`.
pub fn resolve_path(base: &Path, p: &str) -> PathBuf {
    let joined = if p.starts_with('/') {
        p.to_owned()
    } else {
        format!("{}/{p}", base.to_string_lossy())
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        PathBuf::from("/")
    } else {
        PathBuf::from(format!("/{}", parts.join("/")))
    }
}

impl Cli {
    pub fn new(flags: Globals, prog: &str, seams: Seams) -> Self {
        let io = Io;
        let process_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        let cwd = match &flags.directory {
            Some(d) => resolve_path(&process_cwd, d),
            None => process_cwd,
        };
        let style = Style::detect(flags.no_color, io.stdout_tty());
        let minters = MinterSource::from_seams(&seams);
        Self {
            flags,
            io,
            style,
            cwd,
            prog: prog.to_owned(),
            seams,
            minters,
            ws: None,
            engine: Engine::Closed,
            repo: None,
        }
    }

    /// Not the human mode.
    pub fn machine(&self) -> bool {
        self.flags.machine()
    }

    /// "Now": the pinned clock, else the wall clock.
    pub fn now(&self) -> String {
        stamp(self.seams.clock.as_ref())
    }

    /// "Now" in milliseconds since the epoch.
    pub fn now_ms(&self) -> i64 {
        omgbase_store::time::parse_ms(&self.now()).unwrap_or(0)
    }

    /// The `repo_not_found` of a missing workspace (§2.1).
    pub fn no_workspace_error(&self) -> CliError {
        CliError::engine_hint(
            "repo_not_found",
            format!(
                "no omgbase workspace found at or above {}",
                self.cwd.display()
            ),
            format!(
                "run `{p} init` to create one here, or `{p} -C <dir> …` to run inside an existing workspace",
                p = self.prog
            ),
        )
    }

    /// Discover and open the workspace (walk up from the cwd for `.omgbase/`).
    pub fn workspace(&mut self) -> Result<WsInfo> {
        if let Some(ws) = &self.ws {
            return Ok(ws.clone());
        }
        let Some(root) = find_root(&self.cwd) else {
            return Err(self.no_workspace_error());
        };
        self.open_at(root)
    }

    /// Open the workspace rooted exactly at `root` (`mcp --workspace`, `init`).
    pub fn open_at(&mut self, root: PathBuf) -> Result<WsInfo> {
        let omgbase_dir = root.join(OMGBASE_DIR);
        let db_path = omgbase_dir.join(omgbase_sync::workspace::DB_FILE);
        std::fs::create_dir_all(&omgbase_dir)?;
        let store =
            open_store(&db_path, &self.minters).map_err(|e| CliError::engine("error", e))?;
        let ws = WsInfo {
            root,
            omgbase_dir,
            db_path,
        };
        self.ws = Some(ws.clone());
        self.engine = Engine::Store(Box::new(store));
        Ok(ws)
    }

    /// The store (the workspace's connection, wherever it lives now).
    pub fn store(&mut self) -> Result<&Store> {
        self.workspace()?;
        Ok(match &self.engine {
            Engine::Store(s) => s,
            Engine::Surface(s) => s.store(),
            Engine::Closed => unreachable!("workspace() opened the store"),
        })
    }

    pub fn store_mut(&mut self) -> Result<&mut Store> {
        self.workspace()?;
        Ok(match &mut self.engine {
            Engine::Store(s) => s,
            Engine::Surface(s) => s.store_mut(),
            Engine::Closed => unreachable!("workspace() opened the store"),
        })
    }

    /// The workspace's repos with derived roots, by slug.
    pub fn repos(&mut self) -> Result<Vec<RepoRow>> {
        let store = self.store()?;
        Ok(omgbase_sync::workspace::list_repos(store)?)
    }

    /// Select the repo (`spec/sync` §1) honoring `--repo`; cached.
    pub fn repo(&mut self) -> Result<RepoRow> {
        if let Some(r) = &self.repo {
            return Ok(r.clone());
        }
        let repos = self.repos()?;
        let cwd = self.cwd.to_string_lossy().into_owned();
        let selected = omgbase_sync::select_repo(&repos, &cwd, self.flags.repo.as_deref())
            .map_err(|s| {
                CliError::engine_data(s.error, s.message, json!({ "candidates": s.candidates }))
            })?
            .clone();
        self.repo = Some(selected.clone());
        Ok(selected)
    }

    /// The repo's `embedding.*` settings when a provider is named.
    fn embedding_settings(&mut self, repo_id: &str) -> Result<Option<EmbeddingSettings>> {
        let settings = omgbase_sync::resolve_settings(self.store()?, Some(repo_id))?;
        let Some(emb) = settings.get("embedding").and_then(Json::as_object) else {
            return Ok(None);
        };
        let s = |k: &str| emb.get(k).and_then(Json::as_str).map(str::to_owned);
        let n = |k: &str| emb.get(k).and_then(Json::as_u64);
        let cfg = EmbeddingSettings {
            provider: s("provider"),
            model: s("model"),
            dim: n("dim").map(|d| usize::try_from(d).unwrap_or(0)),
            max_input_tokens: n("maxInputTokens")
                .or_else(|| n("max_input_tokens"))
                .map(|d| u32::try_from(d).unwrap_or(u32::MAX)),
        };
        Ok(cfg
            .provider
            .as_deref()
            .is_some_and(|p| !p.trim().is_empty())
            .then_some(cfg))
    }

    /// Whether the effective settings name an embedding provider.
    pub fn has_provider(&mut self) -> Result<bool> {
        let repo = self.repo()?;
        Ok(self.embedding_settings(&repo.repo_id)?.is_some())
    }

    /// The configured provider, spawned; `None` when none is configured;
    /// `embedder_failed` with `{ provider, reason }` when it cannot start.
    fn load_provider(&mut self, repo_id: &str) -> Result<Option<Box<dyn EmbeddingProvider>>> {
        let Some(cfg) = self.embedding_settings(repo_id)? else {
            return Ok(None);
        };
        match create_external_provider(&cfg) {
            Ok(Some(p)) => Ok(Some(p)),
            Ok(None) => Ok(None),
            Err(e) => Err(CliError::engine_data(
                "embedder_failed",
                format!("embedding provider failed to start: {e}"),
                json!({ "provider": cfg.provider, "reason": e.to_string() }),
            )),
        }
    }

    /// The surface over the selected repo. `semantic` loads the configured
    /// embedding provider (once; the first call decides) so `resolve` and
    /// `semantic()` can rank by meaning.
    pub fn surface(&mut self, semantic: bool) -> Result<&mut Surface> {
        let repo = self.repo()?;
        if matches!(self.engine, Engine::Store(_)) {
            let provider = if semantic {
                self.load_provider(&repo.repo_id)?
            } else {
                None
            };
            let Engine::Store(store) = std::mem::replace(&mut self.engine, Engine::Closed) else {
                unreachable!("checked above");
            };
            let mut surface = Surface::new(*store, &repo.repo_id, provider);
            if let Some(ts) = self.seams.clock.clone() {
                surface = surface.with_clock(move || ts.clone());
            }
            self.engine = Engine::Surface(Box::new(surface));
        }
        match &mut self.engine {
            Engine::Surface(s) => Ok(s),
            _ => unreachable!("built above"),
        }
    }

    /// Call one catalog tool on the selected repo.
    pub fn call(&mut self, tool: &str, args: Json) -> Result<Json> {
        Ok(self.surface(false)?.call_result(tool, &args)?)
    }

    /// §3.7: the freshness sweep before a command — the workspace opened, the
    /// repo selected (a failing selection is swallowed), one sweep over its
    /// root unless a live watcher holds the lease.
    pub fn freshness(&mut self) -> Result<()> {
        let ws = self.workspace()?;
        if WatchLease::live(&ws.omgbase_dir) {
            return Ok(());
        }
        let repo = match self.repo() {
            Ok(r) => r,
            Err(CliError::Engine { code, .. }) if code == "repo_not_found" => return Ok(()),
            Err(e) => return Err(e),
        };
        if let Some(root) = repo.root_path.as_deref() {
            let now = self.now();
            let store = self.store_mut()?;
            freshness_sweep(
                store,
                &repo.repo_id,
                &RealFileSystem,
                Path::new(root),
                &now,
                None,
                &omgbase_store::Config::default(),
            )?;
        }
        Ok(())
    }

    /// Close the engine (drops the connection and any provider child).
    pub fn close(&mut self) {
        self.engine = Engine::Closed;
    }
}
