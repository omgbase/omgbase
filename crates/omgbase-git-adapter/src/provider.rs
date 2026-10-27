//! The git history provider (`spec/store` §5.12; modular-core Phase 6a; the
//! remote half 6b): the [`HistoryProvider`] the composition layer attaches
//! under the name `git` (`Capabilities::with_provider` in the `omgbase`
//! binary's store opener and the fixture runners). One instance per store;
//! the bare repository of a repository lives at `<workspace>/.omgbase/git`
//! (`config.git_dir`, relative to the workspace root — the parent of the
//! engine's `.omgbase` directory). The remote verbs (`remote_set` …
//! `reconcile`) are inherent methods the CLI and the runners call on the
//! concrete type; the seam carries what every provider answers
//! (`remote_summary`, `remote_sync`).

use std::path::{Path, PathBuf};

use omgbase_store::{
    CheckpointResult, CommitRecord, HistoryProvider, HistoryReader, HistoryVaultSink,
    ProviderAvailability, ProviderEnabled, ProviderPurge, PushResult, RemoteSummary,
    RemoteSyncResult, Result,
};
use rusqlite::Connection;
use serde_json::{Map, Value as Json};

use crate::config::{
    GIT_PROVIDER, GitHistoryConfig, RemoteOptions, git_config_for, read_git_config,
};
use crate::cursor::clear_git_cursor;
use crate::exclude::ensure_excluded;
use crate::git::{GitIdentity, GitRepo, git_available};
use crate::reader::GitHistoryReader;
use crate::remote::{
    FetchResult, ReconcileMode, ReconcileResult, RemoteContext, RemoteStatus, ResolveChoice,
    ResolveResult, fetch_remote, push_after_checkpoint, push_branch, reconcile_remote, remote_set,
    remote_status, remote_summary, remote_sync, remote_unset, resolve_conflict,
};
use crate::worker::{WorkerContext, commit_snapshot, run_checkpoint};

/// The committer identity in production — `omgbase <omgbase@localhost>`. The
/// author's name is the commit's actor when it has one.
#[must_use]
pub fn default_identity() -> GitIdentity {
    GitIdentity::new("omgbase", "omgbase@localhost")
}

/// The identity the fixture runners and the CLI under the spec seams use
/// (`spec/store` §9.4 "The git provider") — `omgbase <omgbase@fixture>`:
/// pinned shas follow from it.
#[must_use]
pub fn fixture_identity() -> GitIdentity {
    GitIdentity::new("omgbase", "omgbase@fixture")
}

/// The provider: the workspace root its bare repository lives under and the
/// committer identity.
#[derive(Clone, Debug)]
pub struct GitHistoryProvider {
    root: PathBuf,
    identity: GitIdentity,
}

impl GitHistoryProvider {
    /// A provider over the workspace rooted at `root` (the parent of
    /// `.omgbase`) committing as `identity` — [`default_identity`] in
    /// production, [`fixture_identity`] under the conformance seams.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>, identity: GitIdentity) -> Self {
        Self {
            root: root.into(),
            identity,
        }
    }

    /// The workspace root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The bare repository of a repository whose manifest `config` this is
    /// (the measurement script, the fixture runners' `git_log`/`git_tree`).
    #[must_use]
    pub fn git_repo(&self, config: &Map<String, Json>) -> GitRepo {
        self.repo_of(&read_git_config(config))
    }

    fn repo_of(&self, config: &GitHistoryConfig) -> GitRepo {
        GitRepo::new(self.root.join(&config.git_dir))
    }

    /// The remote half's context over a row's config (17.6, Phase 6b).
    fn remote_ctx<'a>(
        &'a self,
        repo_id: &'a str,
        git: &'a GitRepo,
        config: &'a GitHistoryConfig,
    ) -> RemoteContext<'a> {
        RemoteContext {
            repo_id,
            git,
            config,
            identity: &self.identity,
        }
    }

    // ---- the remote half (17.6, Phase 6b; `remote.rs`) ----

    /// `history remote set`: returns the config as written to the row.
    pub fn remote_set(
        &self,
        conn: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
        options: &RemoteOptions,
        now: &str,
    ) -> Result<GitHistoryConfig> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        remote_set(&self.remote_ctx(repo_id, &git, &c), conn, options, now)
    }

    /// `history remote unset`.
    pub fn remote_unset(
        &self,
        conn: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
        now: &str,
    ) -> Result<GitHistoryConfig> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        remote_unset(&self.remote_ctx(repo_id, &git, &c), conn, now)
    }

    /// `history remote status` (local refs only).
    pub fn remote_status(
        &self,
        conn: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
    ) -> Result<RemoteStatus> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        remote_status(&self.remote_ctx(repo_id, &git, &c), conn)
    }

    /// `history push`.
    pub fn push(
        &self,
        conn: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
        now: &str,
    ) -> Result<PushResult> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        push_branch(&self.remote_ctx(repo_id, &git, &c), conn, now)
    }

    /// `history fetch`: inbound content through `vault`.
    pub fn fetch(
        &self,
        repo_id: &str,
        config: &Map<String, Json>,
        vault: &mut dyn HistoryVaultSink,
        now: &str,
    ) -> Result<FetchResult> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        fetch_remote(&self.remote_ctx(repo_id, &git, &c), vault, now)
    }

    /// `history remote resolve <path> --ours|--theirs`.
    pub fn resolve(
        &self,
        repo_id: &str,
        config: &Map<String, Json>,
        vault: &mut dyn HistoryVaultSink,
        path: &str,
        choice: ResolveChoice,
        now: &str,
    ) -> Result<ResolveResult> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        resolve_conflict(
            &self.remote_ctx(repo_id, &git, &c),
            vault,
            path,
            choice,
            now,
        )
    }

    /// `history remote reconcile --rebase|--merge|--adopt|--fork`.
    pub fn reconcile(
        &self,
        repo_id: &str,
        config: &Map<String, Json>,
        vault: &mut dyn HistoryVaultSink,
        mode: ReconcileMode,
        now: &str,
    ) -> Result<ReconcileResult> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        reconcile_remote(&self.remote_ctx(repo_id, &git, &c), vault, mode, now)
    }
}

impl HistoryProvider for GitHistoryProvider {
    fn name(&self) -> &str {
        GIT_PROVIDER
    }

    fn available(&self) -> ProviderAvailability {
        git_available()
    }

    fn reader<'a>(
        &'a self,
        repo_id: &str,
        config: &Map<String, Json>,
    ) -> Box<dyn HistoryReader + 'a> {
        let c = read_git_config(config);
        Box::new(GitHistoryReader::new(repo_id, self.repo_of(&c), c))
    }

    fn enable(
        &self,
        tx: &Connection,
        repo_id: &str,
        commit: &CommitRecord<'_>,
        options: &Map<String, Json>,
    ) -> Result<ProviderEnabled> {
        let config = git_config_for(options)?;
        let git = self.repo_of(&config);
        git.init(&config.branch)?;
        ensure_excluded(&self.root).map_err(|e| {
            omgbase_store::Error::Other(format!("cannot write .git/info/exclude: {e}"))
        })?;
        let ctx = WorkerContext {
            conn: tx,
            repo_id,
            git: &git,
            config: &config,
            identity: &self.identity,
        };
        let snap = commit_snapshot(&ctx, commit.ts, Some(commit))?;
        Ok(ProviderEnabled {
            config: config.to_map(),
            revisions: snap.documents,
            tip: Some(snap.tip),
        })
    }

    fn purge(
        &self,
        tx: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
    ) -> Result<ProviderPurge> {
        let git = self.repo_of(&read_git_config(config));
        let removed = git.remove()?;
        clear_git_cursor(tx, repo_id)?;
        Ok(ProviderPurge {
            removed,
            path: git.git_dir().to_string_lossy().into_owned(),
        })
    }

    fn checkpoint(
        &self,
        conn: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
        now: &str,
    ) -> Result<CheckpointResult> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        let ctx = WorkerContext {
            conn,
            repo_id,
            git: &git,
            config: &c,
            identity: &self.identity,
        };
        let mut result = run_checkpoint(&ctx, now)?;
        // `push: "on-checkpoint"` (17.6): the push follows a checkpoint that
        // committed; its outcome rides on the receipt.
        result.push = push_after_checkpoint(
            &self.remote_ctx(repo_id, &git, &c),
            conn,
            now,
            result.committed,
        );
        Ok(result)
    }

    fn remote_summary(
        &self,
        conn: &Connection,
        repo_id: &str,
        config: &Map<String, Json>,
    ) -> Result<Option<RemoteSummary>> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        remote_summary(&self.remote_ctx(repo_id, &git, &c), conn)
    }

    fn remote_sync(
        &self,
        repo_id: &str,
        config: &Map<String, Json>,
        now: &str,
        vault: &mut dyn HistoryVaultSink,
    ) -> Result<Option<RemoteSyncResult>> {
        let c = read_git_config(config);
        let git = self.repo_of(&c);
        remote_sync(&self.remote_ctx(repo_id, &git, &c), vault, now)
    }
}
