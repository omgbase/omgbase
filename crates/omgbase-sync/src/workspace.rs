//! The workspace (`spec/sync/README.md` §1): the directory holding
//! `.omgbase/`, discovered by walking up like git; its repos with their
//! *derived* root paths; repo selection for a command run in some `cwd`.

use std::path::{Path, PathBuf};

use omgbase_store::{IdMinter, RandomMinter, Store};
use rusqlite::params;

use crate::error::{Error, Result};

/// The directory a workspace is recognised by.
pub const OMGBASE_DIR: &str = ".omgbase";
/// The database file inside it (`spec/store` §1).
pub const DB_FILE: &str = "omgbase.db";
/// The environment variable that names a workspace when no flag does.
pub const WORKSPACE_ENV: &str = "OMGBASE_WORKSPACE";

/// A repo as the workspace lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoRow {
    pub repo_id: String,
    pub slug: String,
    /// The `config.root` of the first `fs` source attached to the repo;
    /// `None` for a sourceless repo (§1: its sync and watch are no-ops).
    pub root_path: Option<String>,
}

impl RepoRow {
    /// A row for the pure [`select_repo`] (the id is irrelevant there).
    #[must_use]
    pub fn candidate(slug: &str, root_path: Option<&str>) -> Self {
        Self {
            repo_id: String::new(),
            slug: slug.to_owned(),
            root_path: root_path.map(str::to_owned),
        }
    }
}

/// The `root` of an `fs` source's stored `config` JSON, or `None` when the
/// config is unparsable, the root is not a string, or it is empty.
#[must_use]
pub fn fs_root_from_config(config: Option<&str>) -> Option<String> {
    let text = config?;
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get("root") {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// The repos of a store with their derived root paths, ordered by `slug`
/// (§1: attachments joined to sources with `adapter = 'fs'`, the first
/// non-empty root per repo).
pub fn list_repos(store: &Store) -> Result<Vec<RepoRow>> {
    let mut stmt = store.conn().prepare(
        "SELECT r.repo_id, r.slug, s.config
         FROM repos r
         LEFT JOIN attachments a ON a.repo_id = r.repo_id
         LEFT JOIN sources s ON s.source_id = a.source_id AND s.adapter = 'fs'
         ORDER BY r.slug",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut out: Vec<RepoRow> = Vec::new();
    for row in rows {
        let (repo_id, slug, config) = row?;
        let root = fs_root_from_config(config.as_deref());
        match out.iter_mut().find(|r| r.repo_id == repo_id) {
            Some(existing) => {
                if existing.root_path.is_none() {
                    existing.root_path = root;
                }
            }
            None => out.push(RepoRow {
                repo_id,
                slug,
                root_path: root,
            }),
        }
    }
    Ok(out)
}

/// Why [`select_repo`] found nothing: `repo_not_found` with the slugs that
/// exist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoSelection {
    /// Always `"repo_not_found"` (the reference's one code).
    pub error: &'static str,
    pub message: String,
    pub candidates: Vec<String>,
}

impl RepoSelection {
    fn not_found(message: String, repos: &[RepoRow]) -> Self {
        Self {
            error: "repo_not_found",
            message,
            candidates: repos.iter().map(|r| r.slug.clone()).collect(),
        }
    }
}

impl From<RepoSelection> for Error {
    fn from(s: RepoSelection) -> Self {
        Error::RepoNotFound {
            message: s.message,
            candidates: s.candidates,
        }
    }
}

/// Node's `path.resolve` for one segment: absolute against the process cwd
/// when relative, then `.`/`..`/duplicate-slash normalization; no trailing
/// slash except for the root.
fn resolve_path(p: &str) -> String {
    let joined = if p.starts_with('/') {
        p.to_owned()
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        format!("{}/{p}", cwd.to_string_lossy())
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
        "/".to_owned()
    } else {
        format!("/{}", parts.join("/"))
    }
}

/// Path-prefix containment after resolving both (§1): `root == here` or
/// `here` is under `root`.
fn contains(root: &str, here: &str) -> bool {
    let root = resolve_path(root);
    let here = resolve_path(here);
    if root == "/" {
        return true;
    }
    here == root
        || here
            .strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// §1 repo selection, pure over the rows: an explicit slug must exist; else
/// with exactly one repo, that repo; else the repos whose root path contains
/// `cwd` (sourceless repos never match) — exactly one → it; none →
/// `repo_not_found`; several → the longest resolved root path.
pub fn select_repo<'a>(
    repos: &'a [RepoRow],
    cwd: &str,
    slug: Option<&str>,
) -> std::result::Result<&'a RepoRow, RepoSelection> {
    if let Some(slug) = slug.filter(|s| !s.is_empty()) {
        return repos
            .iter()
            .find(|r| r.slug == slug)
            .ok_or_else(|| RepoSelection::not_found(format!("no repo with slug '{slug}'"), repos));
    }
    if repos.len() == 1 {
        return Ok(&repos[0]);
    }
    let here = resolve_path(cwd);
    let mut containing: Vec<&RepoRow> = repos
        .iter()
        .filter(|r| {
            r.root_path
                .as_deref()
                .is_some_and(|root| contains(root, &here))
        })
        .collect();
    match containing.len() {
        1 => Ok(containing[0]),
        0 => Err(RepoSelection::not_found(
            format!("no repo contains {here}; select one with --repo"),
            repos,
        )),
        _ => {
            // Deepest root wins: the longest resolved root path (stable sort,
            // as the reference's `Array.prototype.sort`).
            containing.sort_by_key(|r| {
                std::cmp::Reverse(resolve_path(r.root_path.as_deref().unwrap_or("")).len())
            });
            Ok(containing[0])
        }
    }
}

/// An open workspace: its root, `.omgbase/` directory, database path and
/// store.
pub struct Workspace {
    root: PathBuf,
    omgbase_dir: PathBuf,
    db_path: PathBuf,
    store: Store,
}

impl std::fmt::Debug for Workspace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Workspace")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

/// Walk up from `start` to the filesystem root; the first directory holding
/// a `.omgbase` *directory* is the workspace root (§1).
#[must_use]
pub fn find_root(start: &Path) -> Option<PathBuf> {
    let mut dir = if start.is_absolute() {
        start.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(start)
    };
    loop {
        if dir.join(OMGBASE_DIR).is_dir() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
}

impl Workspace {
    /// Open the workspace rooted exactly at `root`, creating `.omgbase/` and
    /// the database as needed.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_minter(root, Box::new(RandomMinter))
    }

    /// [`Workspace::open`] with a replaceable id minter (`spec/store` §2.2).
    pub fn open_with_minter(root: impl AsRef<Path>, minter: Box<dyn IdMinter>) -> Result<Self> {
        let root = root.as_ref();
        let root = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| Error::io("cannot read the current directory", root, e))?
                .join(root)
        };
        let omgbase_dir = root.join(OMGBASE_DIR);
        let db_path = omgbase_dir.join(DB_FILE);
        let store = Store::open_with_minter(&db_path, minter)?;
        Ok(Self {
            root,
            omgbase_dir,
            db_path,
            store,
        })
    }

    /// The workspace containing `start` (walk up), or `None`.
    pub fn find(start: &Path) -> Result<Option<Self>> {
        match find_root(start) {
            Some(root) => Ok(Some(Self::open(root)?)),
            None => Ok(None),
        }
    }

    /// §1 precedence: an explicit `--workspace` value, else
    /// `$OMGBASE_WORKSPACE`, else discovery from `start`.
    pub fn locate(explicit: Option<&Path>, start: &Path) -> Result<Option<Self>> {
        if let Some(p) = explicit {
            return Ok(Some(Self::open(p)?));
        }
        if let Some(env) = std::env::var_os(WORKSPACE_ENV).filter(|v| !v.is_empty()) {
            return Ok(Some(Self::open(PathBuf::from(env))?));
        }
        Self::find(start)
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `<root>/.omgbase` — where the locks live (§7).
    #[must_use]
    pub fn omgbase_dir(&self) -> &Path {
        &self.omgbase_dir
    }

    #[must_use]
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    #[must_use]
    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut Store {
        &mut self.store
    }

    /// The repos with their derived roots, by slug.
    pub fn repos(&self) -> Result<Vec<RepoRow>> {
        list_repos(&self.store)
    }

    pub fn repo_by_slug(&self, slug: &str) -> Result<Option<RepoRow>> {
        Ok(self.repos()?.into_iter().find(|r| r.slug == slug))
    }

    /// [`select_repo`] over this workspace's repos.
    pub fn select_repo(&self, cwd: &Path, slug: Option<&str>) -> Result<RepoRow> {
        let repos = self.repos()?;
        let cwd = cwd.to_string_lossy();
        select_repo(&repos, &cwd, slug)
            .cloned()
            .map_err(Error::from)
    }

    /// Whether `slug` exists (a cheap probe the registry uses).
    pub fn has_repo(&self, slug: &str) -> Result<bool> {
        Ok(self
            .store
            .conn()
            .query_row("SELECT 1 FROM repos WHERE slug = ?1", params![slug], |_| {
                Ok(())
            })
            .is_ok())
    }

    /// Close the store.
    pub fn close(self) -> Result<()> {
        Ok(self.store.close()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(specs: &[(&str, Option<&str>)]) -> Vec<RepoRow> {
        specs
            .iter()
            .map(|(slug, root)| RepoRow::candidate(slug, *root))
            .collect()
    }

    #[test]
    fn fs_root_parsing() {
        assert_eq!(
            fs_root_from_config(Some(r#"{"root":"/data/v"}"#)),
            Some("/data/v".to_owned())
        );
        assert_eq!(fs_root_from_config(Some(r#"{"root":""}"#)), None);
        assert_eq!(fs_root_from_config(Some(r#"{"root":3}"#)), None);
        assert_eq!(fs_root_from_config(Some("{")), None);
        assert_eq!(fs_root_from_config(None), None);
    }

    #[test]
    fn resolve_normalizes_like_node() {
        assert_eq!(resolve_path("/a/b/../c/./d/"), "/a/c/d");
        assert_eq!(resolve_path("//a///b"), "/a/b");
        assert_eq!(resolve_path("/"), "/");
        assert_eq!(resolve_path("/.."), "/");
        assert!(resolve_path("rel").starts_with('/'));
    }

    #[test]
    fn containment_is_by_path_component() {
        assert!(contains("/a/b", "/a/b"));
        assert!(contains("/a/b", "/a/b/c"));
        assert!(contains("/a/b/", "/a/b/c"));
        assert!(!contains("/a/b", "/a/bc"));
        assert!(!contains("/a/b", "/a"));
        assert!(contains("/", "/anything"));
    }

    #[test]
    fn explicit_slug_wins_or_fails_with_candidates() {
        let r = rows(&[("a", Some("/x")), ("b", None)]);
        assert_eq!(select_repo(&r, "/nowhere", Some("b")).unwrap().slug, "b");
        let err = select_repo(&r, "/x", Some("zzz")).unwrap_err();
        assert_eq!(err.error, "repo_not_found");
        assert_eq!(err.candidates, vec!["a", "b"]);
        assert!(err.message.contains("zzz"));
    }

    #[test]
    fn single_repo_matches_any_cwd_even_sourceless() {
        let r = rows(&[("only", None)]);
        assert_eq!(select_repo(&r, "/anywhere", None).unwrap().slug, "only");
    }

    #[test]
    fn cwd_containment_and_deepest_root() {
        let r = rows(&[
            ("outer", Some("/data")),
            ("inner", Some("/data/inner")),
            ("headless", None),
            ("other", Some("/elsewhere")),
        ]);
        assert_eq!(
            select_repo(&r, "/data/inner/deep", None).unwrap().slug,
            "inner"
        );
        assert_eq!(select_repo(&r, "/data/x", None).unwrap().slug, "outer");
        assert_eq!(select_repo(&r, "/elsewhere", None).unwrap().slug, "other");
        let err = select_repo(&r, "/tmp", None).unwrap_err();
        assert_eq!(err.candidates, vec!["outer", "inner", "headless", "other"]);
        assert!(err.message.contains("/tmp"));
        assert_eq!(
            select_repo(&r, "/data/../data/inner", None).unwrap().slug,
            "inner"
        );
    }

    #[test]
    fn find_root_walks_up_to_a_dot_omgbase_directory() {
        let base = std::env::temp_dir().join(format!("omgbase-sync-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("ws/.omgbase")).unwrap();
        std::fs::create_dir_all(base.join("ws/a/b")).unwrap();
        std::fs::write(base.join("ws/a/.omgbase"), "not a dir").unwrap();
        assert_eq!(find_root(&base.join("ws/a/b")).unwrap(), base.join("ws"));
        assert_eq!(find_root(&base.join("ws")).unwrap(), base.join("ws"));
        assert_eq!(find_root(&base), None);
        let ws = Workspace::open(base.join("fresh")).unwrap();
        assert!(ws.db_path().is_file());
        assert_eq!(ws.omgbase_dir(), base.join("fresh/.omgbase"));
        assert!(ws.repos().unwrap().is_empty());
        assert!(!ws.has_repo("x").unwrap());
        ws.close().unwrap();
        let found = Workspace::find(&base.join("fresh")).unwrap().unwrap();
        assert_eq!(found.root(), base.join("fresh"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
