//! The git history provider (`spec/store` §5.12; modular-core Phase 6a): the
//! [`HistoryProvider`] the composition layer attaches under the name `git`
//! (`Capabilities::with_provider` in the `omgbase` binary's store opener and
//! the fixture runners). One instance per store; the bare repository of a
//! repository lives at `<workspace>/.omgbase/git` (`config.git_dir`, relative
//! to the workspace root — the parent of the engine's `.omgbase` directory).

use std::path::{Path, PathBuf};

use omgbase_store::{
    CheckpointResult, CommitRecord, HistoryProvider, HistoryReader, ProviderAvailability,
    ProviderEnabled, ProviderPurge, Result,
};
use rusqlite::Connection;
use serde_json::{Map, Value as Json};

use crate::config::{GIT_PROVIDER, GitHistoryConfig, git_config_for, read_git_config};
use crate::cursor::clear_git_cursor;
use crate::exclude::ensure_excluded;
use crate::git::{GitIdentity, GitRepo, git_available};
use crate::reader::GitHistoryReader;
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
        run_checkpoint(&ctx, now)
    }
}
