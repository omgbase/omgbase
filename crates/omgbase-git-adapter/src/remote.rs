//! The remote half of the git history provider (`spec/store` §5.12 "The
//! remote binding" … "Divergence", 17.6 — modular-core Phase 6b; the design
//! note's §8 and "Remote divergence"). Sync is coordination between the
//! engine's branch and the remote's: OUTBOUND is `git push` — never
//! `--force`; a rejected push is reported, not forced — INBOUND is `git
//! fetch` into the bare repository and a THREE-WAY MERGE AT THE TREE LEVEL
//! with the common ancestor git supplies (the piece optional native history
//! took away), whose clean result flows into the vault THROUGH THE SOURCE
//! BOUNDARY ([`HistoryVaultSink`]: external edits the ordinary reconcile
//! matches identities for, the feed records, the worker then finds already in
//! the tree) and whose conflicts are surfaced with BOTH versions kept (the
//! remote's as a sidecar beside ours) until the operator settles each. A
//! REWRITTEN remote (rebased, force-pushed — its tip no longer descends from
//! the tip we last knew) is detected, stopped and alerted; push and fetch
//! pause, checkpointing continues, and one of four explicit remediations is
//! the operator's: `--rebase`, `--merge`, `--adopt`, `--fork`. NEVER: a
//! force-push, unpushed local commits dropped without a backup ref, a silent
//! last-write-wins. Port of `packages/git-adapter/src/remote.ts`, the git
//! argv, the ref names, the alert codes, details and messages byte for byte.
//!
//! Refs this module keeps in the bare repository, all under names git itself
//! never writes: `refs/remotes/<name>/<branch>` the remote-tracking ref (the
//! last tip seen on the remote — moved by fetch and by a successful push);
//! `refs/omgbase/remotes/<name>/ids` the remote's ids ref as fetched;
//! `refs/omgbase/diverged/<name>` the OLD remote tip while a divergence
//! stands (the base `--rebase` and `--merge` use; the objects stay
//! reachable); `refs/omgbase/merge/<name>` the remote tip a merge with
//! conflicts is waiting on; `refs/omgbase/backup/<ts>` our previous tip
//! before a remediation moved the branch.
//!
//! The vault sink LENDS the connection (the Rust seam's shape): every read of
//! the rows happens between applies, never across one.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use omgbase_store::{
    AlertInput, AlertSeverity, Error, HistoryVaultSink, PushOutcome, PushResult, RemoteState,
    RemoteSummary, RemoteSyncResult, Result, VaultChange, clear_alert, feed_status,
    list_active_alerts, raise_alert, repo_epoch, update_history_provider_config,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::config::{
    FetchPolicy, GitHistoryConfig, GitRemoteConfig, PushPolicy, RemoteOptions, remote_config_for,
};
use crate::cursor::{GitPushed, read_git_cursor, write_git_cursor, write_git_pushed};
use crate::git::{EMPTY_TREE, GitIdentity, GitRepo, PushStatus};
use crate::trailers::{CommitTrailers, parse_message, render_message};
use crate::worker::{WorkerContext, resume_position, run_checkpoint};

/// The alert of a rejected push or a rewritten remote.
pub const GIT_REMOTE_DIVERGED_ALERT: &str = "git_remote_diverged";
/// The alert of a tree-level merge that left conflicts.
pub const GIT_MERGE_CONFLICT_ALERT: &str = "git_merge_conflict";
/// The alert of `--fork`: the branch pushed aside, push and fetch paused.
pub const GIT_REMOTE_FORKED_ALERT: &str = "git_remote_forked";

/// What the remote half needs beside the connection (the vault lends that).
pub struct RemoteContext<'a> {
    pub repo_id: &'a str,
    pub git: &'a GitRepo,
    pub config: &'a GitHistoryConfig,
    pub identity: &'a GitIdentity,
}

impl RemoteContext<'_> {
    /// The worker's view over `conn`.
    fn worker<'c>(&'c self, conn: &'c Connection) -> WorkerContext<'c> {
        WorkerContext {
            conn,
            repo_id: self.repo_id,
            git: self.git,
            config: self.config,
            identity: self.identity,
        }
    }
}

/// What a fetch found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchState {
    Nothing,
    FastForward,
    Merged,
    Conflict,
    Diverged,
}

impl FetchState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            FetchState::Nothing => "nothing",
            FetchState::FastForward => "fast-forward",
            FetchState::Merged => "merged",
            FetchState::Conflict => "conflict",
            FetchState::Diverged => "diverged",
        }
    }
}

/// `history remote reconcile`'s mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReconcileMode {
    Rebase,
    Merge,
    Adopt,
    Fork,
}

impl ReconcileMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            ReconcileMode::Rebase => "rebase",
            ReconcileMode::Merge => "merge",
            ReconcileMode::Adopt => "adopt",
            ReconcileMode::Fork => "fork",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "rebase" => Some(ReconcileMode::Rebase),
            "merge" => Some(ReconcileMode::Merge),
            "adopt" => Some(ReconcileMode::Adopt),
            "fork" => Some(ReconcileMode::Fork),
            _ => None,
        }
    }
}

/// `history remote resolve`'s choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolveChoice {
    Ours,
    Theirs,
}

impl ResolveChoice {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            ResolveChoice::Ours => "ours",
            ResolveChoice::Theirs => "theirs",
        }
    }
}

/// `history remote status`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteStatus {
    pub remote: String,
    pub branch: String,
    pub local_tip: Option<String>,
    pub remote_tip: Option<String>,
    pub pushed_through: Option<i64>,
    pub state: RemoteState,
}

impl RemoteStatus {
    /// `{ remote, branch, local_tip, remote_tip, pushed_through, state }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "remote": self.remote,
            "branch": self.branch,
            "local_tip": self.local_tip,
            "remote_tip": self.remote_tip,
            "pushed_through": self.pushed_through,
            "state": self.state.as_str(),
        })
    }
}

/// `history fetch`'s receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchResult {
    pub state: FetchState,
    /// The remote's tip after the fetch (`None` when the remote branch does not exist yet).
    pub remote_tip: Option<String>,
    /// `diverged` alone: the tip we last knew the remote at (`Some(None)` for unrelated histories).
    pub old_remote_tip: Option<Option<String>>,
    /// Our branch tip after the fetch.
    pub tip: Option<String>,
    /// The paths written into the vault from the remote (sidecars included), in path order.
    pub applied: Vec<String>,
    /// The conflicting paths (a sidecar beside each).
    pub conflicts: Vec<String>,
}

impl FetchResult {
    /// `{ state, remote_tip, old_remote_tip?, tip, applied, conflicts }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = Map::new();
        m.insert("state".to_owned(), json!(self.state.as_str()));
        m.insert("remote_tip".to_owned(), json!(self.remote_tip));
        if let Some(old) = &self.old_remote_tip {
            m.insert("old_remote_tip".to_owned(), json!(old));
        }
        m.insert("tip".to_owned(), json!(self.tip));
        m.insert("applied".to_owned(), json!(self.applied));
        m.insert("conflicts".to_owned(), json!(self.conflicts));
        Json::Object(m)
    }

    fn nothing(remote_tip: Option<String>, tip: Option<String>) -> Self {
        Self {
            state: FetchState::Nothing,
            remote_tip,
            old_remote_tip: None,
            tip,
            applied: Vec::new(),
            conflicts: Vec::new(),
        }
    }
}

/// `history remote resolve`'s receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolveResult {
    pub path: String,
    pub choice: ResolveChoice,
    pub remaining: Vec<String>,
    /// The merge commit written when the last conflict was settled, else `None`.
    pub merged: Option<String>,
    pub tip: Option<String>,
}

impl ResolveResult {
    /// `{ path, choice, remaining, merged, tip }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "path": self.path,
            "choice": self.choice.as_str(),
            "remaining": self.remaining,
            "merged": self.merged,
            "tip": self.tip,
        })
    }
}

/// `history remote reconcile`'s receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReconcileResult {
    pub mode: ReconcileMode,
    pub tip: Option<String>,
    /// The previous tip, kept on `refs/omgbase/backup/<ts>` (rebase, merge, adopt).
    pub backup: Option<String>,
    /// `--rebase`: the commits rewritten; `--merge`: 1 when the merge commit was written, 0 while conflicts stand.
    pub rewritten: usize,
    /// `--fork`: the branch pushed.
    pub fork: Option<String>,
    pub applied: Vec<String>,
    pub conflicts: Vec<String>,
}

impl ReconcileResult {
    /// `{ mode, tip, backup, rewritten, fork, applied, conflicts }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "mode": self.mode.as_str(),
            "tip": self.tip,
            "backup": self.backup,
            "rewritten": self.rewritten,
            "fork": self.fork,
            "applied": self.applied,
            "conflicts": self.conflicts,
        })
    }
}

// ---- refs and helpers ----

fn tracking_ref(r: &GitRemoteConfig) -> String {
    format!("refs/remotes/{}/{}", r.name, r.branch)
}
fn ids_tracking_ref(r: &GitRemoteConfig) -> String {
    format!("refs/omgbase/remotes/{}/ids", r.name)
}
fn diverged_ref(r: &GitRemoteConfig) -> String {
    format!("refs/omgbase/diverged/{}", r.name)
}
fn merge_ref(r: &GitRemoteConfig) -> String {
    format!("refs/omgbase/merge/{}", r.name)
}
fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// `<ts>` as a ref/branch segment: `20260927T000000Z`.
#[must_use]
pub fn ts_segment(ts: &str) -> String {
    let stripped: String = ts.chars().filter(|c| !matches!(c, '-' | ':')).collect();
    // `.<digits>Z` at the end → `Z`.
    if let Some(dot) = stripped.rfind('.')
        && stripped.ends_with('Z')
        && stripped[dot + 1..stripped.len() - 1]
            .bytes()
            .all(|b| b.is_ascii_digit())
    {
        return format!("{}Z", &stripped[..dot]);
    }
    stripped
}

/// The sidecar beside `path` holding the OTHER side's version:
/// `<stem>.remote-<short>.md` / `<stem>.local-<short>.md` (a path without
/// `.md` keeps its name and gains the suffix).
#[must_use]
pub fn sidecar_path(path: &str, side: &str, sha: &str) -> String {
    match path.strip_suffix(".md") {
        Some(stem) => format!("{stem}.{side}-{}.md", short(sha)),
        None => format!("{path}.{side}-{}", short(sha)),
    }
}

fn require_remote<'a>(rc: &RemoteContext<'a>) -> Result<&'a GitRemoteConfig> {
    rc.config.remote.as_ref().ok_or_else(|| {
        Error::Other(
            "no remote is bound to this repository's git history — run omg history remote set --url <url> first"
                .to_owned(),
        )
    })
}

fn active_alert(conn: &Connection, repo_id: &str, code: &str) -> Result<Option<Map<String, Json>>> {
    Ok(list_active_alerts(conn, repo_id)?
        .into_iter()
        .find(|a| a.code == code)
        .map(|a| a.detail))
}

fn str_of(m: &Map<String, Json>, k: &str) -> Option<String> {
    m.get(k).and_then(Json::as_str).map(str::to_owned)
}

fn strs_of(m: &Map<String, Json>, k: &str) -> Vec<String> {
    m.get(k)
        .and_then(Json::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Json::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Are push and fetch PAUSED? While the remote stands rewritten
/// (`git_remote_diverged` carrying `old_remote_tip`) or forked, nothing moves
/// either way until a remediation; a plain rejected push (no
/// `old_remote_tip`) pauses nothing — `history fetch` merges the remote's
/// commits and clears it.
pub fn paused_by(
    conn: &Connection,
    repo_id: &str,
) -> Result<Option<(&'static str, Map<String, Json>)>> {
    if let Some(d) = active_alert(conn, repo_id, GIT_REMOTE_DIVERGED_ALERT)?
        && d.contains_key("old_remote_tip")
    {
        return Ok(Some((GIT_REMOTE_DIVERGED_ALERT, d)));
    }
    if let Some(d) = active_alert(conn, repo_id, GIT_REMOTE_FORKED_ALERT)? {
        return Ok(Some((GIT_REMOTE_FORKED_ALERT, d)));
    }
    Ok(None)
}

fn paused_error(code: &str, d: &Map<String, Json>) -> Error {
    let remote = str_of(d, "remote").unwrap_or_default();
    let branch = str_of(d, "branch").unwrap_or_default();
    let message = if code == GIT_REMOTE_FORKED_ALERT {
        forked_message(&remote, &branch, &str_of(d, "fork").unwrap_or_default())
    } else {
        rewritten_message(
            &remote,
            &branch,
            str_of(d, "remote_tip").as_deref(),
            str_of(d, "old_remote_tip").as_deref(),
        )
    };
    // The data in the pinned key order (the alert row stores its detail canonically sorted).
    let mut data = Map::new();
    data.insert("remote".to_owned(), json!(remote));
    data.insert("branch".to_owned(), json!(branch));
    data.insert("local_tip".to_owned(), json!(str_of(d, "local_tip")));
    data.insert("remote_tip".to_owned(), json!(str_of(d, "remote_tip")));
    data.insert(
        "old_remote_tip".to_owned(),
        json!(str_of(d, "old_remote_tip")),
    );
    if let Some(f) = d.get("fork") {
        data.insert("fork".to_owned(), f.clone());
    }
    Error::GitRemoteDiverged { message, data }
}

fn pending_merge_error(
    conn: &Connection,
    repo_id: &str,
    r: &GitRemoteConfig,
) -> Result<Option<Error>> {
    let Some(detail) = active_alert(conn, repo_id, GIT_MERGE_CONFLICT_ALERT)? else {
        return Ok(None);
    };
    let paths = strs_of(&detail, "paths");
    Ok(Some(Error::GitMergeConflict {
        message: conflict_message(
            &r.name,
            &r.branch,
            str_of(&detail, "remote_tip").as_deref(),
            &paths,
        ),
        data: detail,
    }))
}

// ---- the pinned messages (byte for byte in both engines) ----

/// The rejected push's message.
#[must_use]
pub fn rejected_message(
    remote: &str,
    branch: &str,
    remote_tip: Option<&str>,
    local_tip: Option<&str>,
) -> String {
    format!(
        "push to {remote}/{branch} was rejected: the remote is at {}, which does not descend from {} — run omg history fetch to merge the remote's commits, then push again",
        remote_tip.unwrap_or("an unknown tip"),
        local_tip.unwrap_or("our tip")
    )
}

/// The rewritten remote's message.
#[must_use]
pub fn rewritten_message(
    remote: &str,
    branch: &str,
    remote_tip: Option<&str>,
    old_remote_tip: Option<&str>,
) -> String {
    format!(
        "the remote {remote}/{branch} was rewritten: its tip {} does not descend from the last known {} — push and fetch are paused while checkpoints continue locally; choose omg history remote reconcile --rebase | --merge | --adopt | --fork",
        remote_tip.unwrap_or("(none)"),
        old_remote_tip.unwrap_or("(none — unrelated histories)")
    )
}

/// The merge conflict's message.
#[must_use]
pub fn conflict_message(
    remote: &str,
    branch: &str,
    remote_tip: Option<&str>,
    paths: &[String],
) -> String {
    format!(
        "the merge of {remote}/{branch} at {} left {} conflict(s): {} — both versions are in the vault; settle each with omg history remote resolve <path> --ours|--theirs",
        remote_tip.unwrap_or("(none)"),
        paths.len(),
        paths.join(", ")
    )
}

/// The fork's message.
#[must_use]
pub fn forked_message(remote: &str, branch: &str, fork: &str) -> String {
    format!(
        "the engine's branch was pushed to {remote}/{fork} — merge it into {branch} with git, then run omg history remote reconcile --adopt (push and fetch stay paused until then)"
    )
}

// ---- the binding ----

/// `history remote set`: the remote in the bare repository and the row's
/// `remote` member; returns the config as written.
pub fn remote_set(
    rc: &RemoteContext<'_>,
    conn: &Connection,
    opts: &RemoteOptions,
    now: &str,
) -> Result<GitHistoryConfig> {
    let remote = remote_config_for(opts, &rc.config.branch)?;
    rc.git.init(&rc.config.branch)?;
    if let Some(previous) = &rc.config.remote
        && previous.name != remote.name
    {
        forget_remote(rc, conn, previous, now)?;
    }
    rc.git.set_remote(&remote.name, &remote.url)?;
    let config = GitHistoryConfig {
        remote: Some(remote),
        ..rc.config.clone()
    };
    update_history_provider_config(conn, rc.repo_id, &config.to_map(), now)?;
    Ok(config)
}

/// `history remote unset`: the remote, its tracking and bookkeeping refs,
/// the alerts about it and the row's binding leave; the pushed record is
/// cleared.
pub fn remote_unset(
    rc: &RemoteContext<'_>,
    conn: &Connection,
    now: &str,
) -> Result<GitHistoryConfig> {
    if let Some(previous) = &rc.config.remote {
        forget_remote(rc, conn, previous, now)?;
    }
    let config = GitHistoryConfig {
        remote: None,
        ..rc.config.clone()
    };
    update_history_provider_config(conn, rc.repo_id, &config.to_map(), now)?;
    write_git_pushed(conn, rc.repo_id, &repo_epoch(conn, rc.repo_id)?, None)?;
    Ok(config)
}

fn forget_remote(
    rc: &RemoteContext<'_>,
    conn: &Connection,
    r: &GitRemoteConfig,
    now: &str,
) -> Result<()> {
    if rc.git.exists() {
        rc.git.remove_remote(&r.name)?;
        for reference in [
            tracking_ref(r),
            ids_tracking_ref(r),
            diverged_ref(r),
            merge_ref(r),
        ] {
            rc.git.delete_ref(&reference)?;
        }
    }
    for code in [
        GIT_REMOTE_DIVERGED_ALERT,
        GIT_MERGE_CONFLICT_ALERT,
        GIT_REMOTE_FORKED_ALERT,
    ] {
        clear_alert(conn, rc.repo_id, code, now)?;
    }
    Ok(())
}

/// The seq a tip's `omgbase-seq` trailer covers when it is of `epoch`, else `None`.
fn seq_of(git: &GitRepo, tip: Option<&str>, epoch: &str) -> Result<Option<i64>> {
    let Some(tip) = tip else {
        return Ok(None);
    };
    Ok(parse_message(&git.message(tip)?)
        .filter(|t| t.epoch == epoch)
        .map(|t| t.to))
}

/// `history remote status` (local refs only — no network): where the two sides stand.
pub fn remote_status(rc: &RemoteContext<'_>, conn: &Connection) -> Result<RemoteStatus> {
    let r = require_remote(rc)?;
    let git = rc.git;
    let (local, remote) = if git.exists() {
        (git.tip(&rc.config.branch)?, git.ref_sha(&tracking_ref(r))?)
    } else {
        (None, None)
    };
    let cursor = read_git_cursor(conn, rc.repo_id)?;
    let state = match (&local, &remote) {
        (Some(l), Some(rt)) => {
            if active_alert(conn, rc.repo_id, GIT_REMOTE_DIVERGED_ALERT)?.is_some()
                || active_alert(conn, rc.repo_id, GIT_REMOTE_FORKED_ALERT)?.is_some()
            {
                RemoteState::Diverged
            } else if l == rt {
                RemoteState::InSync
            } else if git.is_ancestor(rt, l)? {
                RemoteState::Ahead
            } else if git.is_ancestor(l, rt)? {
                RemoteState::Behind
            } else {
                RemoteState::Diverged
            }
        }
        _ => RemoteState::Unknown,
    };
    Ok(RemoteStatus {
        remote: r.name.clone(),
        branch: r.branch.clone(),
        local_tip: local,
        remote_tip: remote,
        pushed_through: cursor.and_then(|c| c.pushed).and_then(|p| p.seq),
        state,
    })
}

/// `version.capabilities.history.remote`.
pub fn remote_summary(rc: &RemoteContext<'_>, conn: &Connection) -> Result<Option<RemoteSummary>> {
    if rc.config.remote.is_none() {
        return Ok(None);
    }
    let s = remote_status(rc, conn)?;
    Ok(Some(RemoteSummary {
        name: s.remote,
        branch: s.branch,
        state: s.state,
        pushed_through: s.pushed_through,
    }))
}

// ---- push ----

/// `history push`: the content branch (`refs/heads/<b>:refs/heads/<rb>`) and,
/// when it exists, the ids ref — never `--force`. A rejected push raises
/// `git_remote_diverged` (warning; `{ remote, branch, local_tip, remote_tip }`)
/// and fails with it; the ids ref's rejection alone is reported (`ids:
/// "rejected"`) — two engines writing one remote's identities is 6c's.
pub fn push_branch(rc: &RemoteContext<'_>, conn: &Connection, now: &str) -> Result<PushResult> {
    let r = require_remote(rc)?;
    if let Some((code, detail)) = paused_by(conn, rc.repo_id)? {
        return Err(paused_error(code, &detail));
    }
    // A merge with conflicts is waiting: the branch does not yet hold what the
    // remote has, so a push could only be rejected — refuse with the conflict instead.
    if let Some(e) = pending_merge_error(conn, rc.repo_id, r)? {
        return Err(e);
    }
    let git = rc.git;
    let epoch = repo_epoch(conn, rc.repo_id)?;
    let local = if git.exists() {
        git.tip(&rc.config.branch)?
    } else {
        None
    };
    let Some(local) = local else {
        return Ok(PushResult {
            pushed: false,
            tip: None,
            pushed_through: None,
            ids: Some("none".to_owned()),
        });
    };
    let before = git.ref_sha(&tracking_ref(r))?;
    let refspec = format!("refs/heads/{}:refs/heads/{}", rc.config.branch, r.branch);
    match git.push(&r.name, &[&refspec])? {
        PushStatus::Rejected(_) => {
            // Unreachable now: the rejection stands on its own.
            let remote_tip = git
                .ls_remote(&r.name, &format!("refs/heads/{}", r.branch))
                .unwrap_or(None);
            let mut detail = Map::new();
            detail.insert("remote".to_owned(), json!(r.name));
            detail.insert("branch".to_owned(), json!(r.branch));
            detail.insert("local_tip".to_owned(), json!(local));
            detail.insert("remote_tip".to_owned(), json!(remote_tip));
            let message = rejected_message(&r.name, &r.branch, remote_tip.as_deref(), Some(&local));
            raise_alert(
                conn,
                rc.repo_id,
                &AlertInput {
                    code: GIT_REMOTE_DIVERGED_ALERT,
                    severity: AlertSeverity::Warning,
                    message: &message,
                    detail: Some(&detail),
                },
                now,
            )?;
            return Err(Error::GitRemoteDiverged {
                message,
                data: detail,
            });
        }
        PushStatus::Failed(stderr) => {
            return Err(Error::Other(format!("push to {} failed: {stderr}", r.name)));
        }
        PushStatus::Ok => {}
    }
    git.set_ref(&tracking_ref(r), &local)?;
    // A rejected push's alert ends with the push that lands.
    clear_alert(conn, rc.repo_id, GIT_REMOTE_DIVERGED_ALERT, now)?;
    let seq = match seq_of(git, Some(&local), &epoch)? {
        Some(s) => Some(s),
        None => read_git_cursor(conn, rc.repo_id)?.map(|c| c.seq),
    };
    write_git_pushed(
        conn,
        rc.repo_id,
        &epoch,
        Some(GitPushed {
            tip: local.clone(),
            seq,
        }),
    )?;
    let mut ids = "none";
    if let Some(ids_tip) = git.ref_sha(&rc.config.ids_ref)? {
        let spec = format!("{}:{}", rc.config.ids_ref, rc.config.ids_ref);
        match git.push(&r.name, &[&spec])? {
            PushStatus::Ok => {
                git.set_ref(&ids_tracking_ref(r), &ids_tip)?;
                ids = "pushed";
            }
            PushStatus::Rejected(_) => ids = "rejected",
            PushStatus::Failed(stderr) => {
                return Err(Error::Other(format!(
                    "push of {} to {} failed: {stderr}",
                    rc.config.ids_ref, r.name
                )));
            }
        }
    }
    Ok(PushResult {
        pushed: before.as_deref() != Some(local.as_str()),
        tip: Some(local),
        pushed_through: seq,
        ids: Some(ids.to_owned()),
    })
}

// ---- fetch and the tree-level merge ----

struct ThreeWay {
    /// The remote's changes we did not touch: `(path, blob | None)`, in `diff-tree` order.
    theirs_only: Vec<(String, Option<String>)>,
    /// Paths both sides changed to different blobs, sorted.
    conflicts: Vec<String>,
}

/// The per-path rule of `spec/store` §5.12 "Merge": one side changed → take
/// it; both to the same blob → take it; both to different blobs → conflict.
fn three_way(git: &GitRepo, base: Option<&str>, ours: &str, theirs: &str) -> Result<ThreeWay> {
    let base_tree = base.unwrap_or(EMPTY_TREE);
    let our_changes: HashMap<String, Option<String>> =
        git.diff_trees(base_tree, ours)?.into_iter().collect();
    let their_changes = git.diff_trees(base_tree, theirs)?;
    let mut theirs_only = Vec::new();
    let mut conflicts = Vec::new();
    for (path, blob) in their_changes {
        match our_changes.get(&path) {
            None => theirs_only.push((path, blob)),
            Some(ours) if *ours != blob => conflicts.push(path),
            Some(_) => {}
        }
    }
    conflicts.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Ok(ThreeWay {
        theirs_only,
        conflicts,
    })
}

/// The changes as vault writes, by path (bytewise), the blobs read.
fn blob_changes(git: &GitRepo, changes: &[(String, Option<String>)]) -> Result<Vec<VaultChange>> {
    let mut sorted: Vec<&(String, Option<String>)> = changes.iter().collect();
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut out = Vec::with_capacity(sorted.len());
    for (path, blob) in sorted {
        out.push(VaultChange {
            path: path.clone(),
            content: match blob {
                Some(b) => Some(git.blob(b)?),
                None => None,
            },
        });
    }
    Ok(out)
}

/// The position the worker will resume from after the branch moves: the
/// current resume position, else the feed head before anything is ingested.
fn position_before_apply(rc: &RemoteContext<'_>, conn: &Connection, epoch: &str) -> Result<i64> {
    match resume_position(&rc.worker(conn), epoch)? {
        Some((_, seq)) => Ok(seq),
        None => Ok(feed_status(conn, rc.repo_id)?.head),
    }
}

fn merge_trailers(epoch: &str, seq: i64, now: &str, remote_tip: &str) -> CommitTrailers {
    CommitTrailers {
        epoch: epoch.to_owned(),
        from: seq,
        to: seq,
        ts: now.to_owned(),
        commits: Vec::new(),
        origin: None,
        actor: None,
        plan: None,
        docs: Vec::new(),
        rescan: None,
        merge: Some(remote_tip.to_owned()),
        content: None,
    }
}

/// The merge commit: `tree` over parents (ours, theirs), subject `merge
/// <name>/<rb>`, trailer `omgbase-merge: <remote tip>`.
#[allow(clippy::too_many_arguments)]
fn write_merge_commit(
    rc: &RemoteContext<'_>,
    conn: &Connection,
    r: &GitRemoteConfig,
    tree: &str,
    ours: &str,
    theirs: &str,
    seq: i64,
    now: &str,
) -> Result<String> {
    let epoch = repo_epoch(conn, rc.repo_id)?;
    let message = render_message(
        &format!("merge {}/{}", r.name, r.branch),
        &merge_trailers(&epoch, seq, now, theirs),
    );
    let sha = rc.git.commit_tree_parents(
        tree,
        &[ours, theirs],
        &message,
        rc.identity,
        rc.identity,
        now,
    )?;
    rc.git.update_ref(&rc.config.branch, &sha, Some(ours))?;
    write_git_cursor(conn, rc.repo_id, &sha, &epoch, seq)?;
    Ok(sha)
}

/// Record a merge with conflicts: the remote's versions as sidecars in the
/// vault (the caller applied them), the pending ref, the alert.
fn record_conflicts(
    rc: &RemoteContext<'_>,
    conn: &Connection,
    r: &GitRemoteConfig,
    remote_tip: &str,
    conflicts: &[String],
    now: &str,
    extra: &[(&str, Json)],
) -> Result<()> {
    rc.git.set_ref(&merge_ref(r), remote_tip)?;
    let mut detail = Map::new();
    detail.insert("remote".to_owned(), json!(r.name));
    detail.insert("branch".to_owned(), json!(r.branch));
    detail.insert("remote_tip".to_owned(), json!(remote_tip));
    detail.insert("paths".to_owned(), json!(conflicts));
    for (k, v) in extra {
        detail.insert((*k).to_owned(), v.clone());
    }
    raise_alert(
        conn,
        rc.repo_id,
        &AlertInput {
            code: GIT_MERGE_CONFLICT_ALERT,
            severity: AlertSeverity::Warning,
            message: &conflict_message(&r.name, &r.branch, Some(remote_tip), conflicts),
            detail: Some(&detail),
        },
        now,
    )
}

/// The remote's versions of the conflicting paths as sidecars
/// (`<stem>.remote-<short>.md`); a path the remote deleted gets no sidecar.
fn remote_sidecars(
    git: &GitRepo,
    remote_tip: &str,
    conflicts: &[String],
) -> Result<Vec<VaultChange>> {
    let theirs = git.tree_entries(remote_tip)?;
    let mut out = Vec::new();
    for path in conflicts {
        if let Some(blob) = theirs.get(path) {
            out.push(VaultChange {
                path: sidecar_path(path, "remote", remote_tip),
                content: Some(git.blob(blob)?),
            });
        }
    }
    Ok(out)
}

/// The tree of `ours` plus the remote's changes (the adds and removes of a clean merge).
fn merged_tree(
    git: &GitRepo,
    ours: &str,
    theirs_only: &[(String, Option<String>)],
) -> Result<String> {
    let adds: Vec<(String, String)> = theirs_only
        .iter()
        .filter_map(|(p, b)| b.as_ref().map(|b| (p.clone(), b.clone())))
        .collect();
    let removes: Vec<String> = theirs_only
        .iter()
        .filter(|(_, b)| b.is_none())
        .map(|(p, _)| p.clone())
        .collect();
    git.build_tree(Some(&git.tree_of(ours)?), &adds, &removes)
}

fn paths_of(changes: &[VaultChange]) -> Vec<String> {
    changes.iter().map(|c| c.path.clone()).collect()
}

/// What a fetch decided before the vault is written.
enum FetchPlan {
    FastForward {
        epoch: String,
        seq: i64,
        local: Option<String>,
        remote_tip: String,
        changes: Vec<VaultChange>,
    },
    Merge {
        seq: i64,
        local: String,
        remote_tip: String,
        base: Option<String>,
        theirs_only: Vec<(String, Option<String>)>,
        conflicts: Vec<String>,
        changes: Vec<VaultChange>,
    },
}

/// `history fetch` (`spec/store` §5.12 "Fetch"): fetch `<name>/<rb>` into
/// the tracking ref (and the remote's ids ref when it has one), then —
/// nothing new: `nothing`; the remote rewritten (its tip does not descend
/// from the tip we last knew, or unrelated histories): `diverged` — the
/// alert, the old tip kept, push and fetch paused; we are behind: the
/// remote's tree changes into the vault through the sink, then our branch
/// fast-forwarded; both moved: the three-way merge — clean: the remote's
/// changes into the vault and one merge commit; conflicts: the remote's
/// versions beside ours, the alert, no merge commit until `resolve`.
pub fn fetch_remote(
    rc: &RemoteContext<'_>,
    vault: &mut dyn HistoryVaultSink,
    now: &str,
) -> Result<FetchResult> {
    let r = require_remote(rc)?;
    let git = rc.git;
    let plan = {
        let conn = vault.conn();
        if let Some((code, detail)) = paused_by(conn, rc.repo_id)? {
            return Err(paused_error(code, &detail));
        }
        if let Some(e) = pending_merge_error(conn, rc.repo_id, r)? {
            return Err(e);
        }
        git.init(&rc.config.branch)?;
        let epoch = repo_epoch(conn, rc.repo_id)?;
        let local = git.tip(&rc.config.branch)?;
        let old = git.ref_sha(&tracking_ref(r))?;
        let remote_has = git.ls_remote(&r.name, &format!("refs/heads/{}", r.branch))?;
        if remote_has.is_none() {
            return Ok(FetchResult::nothing(None, local));
        }
        if let Some(err) = git.fetch(
            &r.name,
            &[&format!("+refs/heads/{}:{}", r.branch, tracking_ref(r))],
        )? {
            return Err(Error::Other(format!("fetch from {} failed: {err}", r.name)));
        }
        if git.ls_remote(&r.name, &rc.config.ids_ref)?.is_some() {
            git.fetch(
                &r.name,
                &[&format!("+{}:{}", rc.config.ids_ref, ids_tracking_ref(r))],
            )?;
        }
        let remote_tip = git
            .ref_sha(&tracking_ref(r))?
            .ok_or_else(|| Error::Other("the tracking ref did not move".to_owned()))?;
        // A rejected push's alert is about a remote we have now fetched: it ends
        // here (the merge below settles it, or the divergence alert replaces it).
        clear_alert(conn, rc.repo_id, GIT_REMOTE_DIVERGED_ALERT, now)?;
        if old.as_deref() == Some(remote_tip.as_str())
            || local.as_deref() == Some(remote_tip.as_str())
        {
            return Ok(FetchResult::nothing(Some(remote_tip), local));
        }
        let rewritten = match &old {
            Some(o) => !git.is_ancestor(o, &remote_tip)?,
            None => match &local {
                Some(l) => git.merge_base(l, &remote_tip)?.is_none(),
                None => false,
            },
        };
        if rewritten {
            if let Some(o) = &old {
                git.set_ref(&diverged_ref(r), o)?;
            }
            let mut detail = Map::new();
            detail.insert("remote".to_owned(), json!(r.name));
            detail.insert("branch".to_owned(), json!(r.branch));
            detail.insert("local_tip".to_owned(), json!(local));
            detail.insert("remote_tip".to_owned(), json!(remote_tip));
            detail.insert("old_remote_tip".to_owned(), json!(old));
            raise_alert(
                conn,
                rc.repo_id,
                &AlertInput {
                    code: GIT_REMOTE_DIVERGED_ALERT,
                    severity: AlertSeverity::Warning,
                    message: &rewritten_message(
                        &r.name,
                        &r.branch,
                        Some(&remote_tip),
                        old.as_deref(),
                    ),
                    detail: Some(&detail),
                },
                now,
            )?;
            return Ok(FetchResult {
                state: FetchState::Diverged,
                remote_tip: Some(remote_tip),
                old_remote_tip: Some(old),
                tip: local,
                applied: Vec::new(),
                conflicts: Vec::new(),
            });
        }
        let behind = match &local {
            None => true,
            Some(l) => git.is_ancestor(l, &remote_tip)?,
        };
        if behind {
            // Behind: the remote's changes enter through the vault, then the branch follows.
            let seq = position_before_apply(rc, conn, &epoch)?;
            let changes = blob_changes(
                git,
                &git.diff_trees(local.as_deref().unwrap_or(EMPTY_TREE), &remote_tip)?,
            )?;
            FetchPlan::FastForward {
                epoch,
                seq,
                local,
                remote_tip,
                changes,
            }
        } else {
            let local = local.expect("a tip: `behind` covered None");
            if git.is_ancestor(&remote_tip, &local)? {
                // Ahead: a push is due, nothing to merge.
                return Ok(FetchResult::nothing(Some(remote_tip), Some(local)));
            }
            // Both moved: the three-way merge at the tree level with the ancestor git supplies.
            let base = git.merge_base(&local, &remote_tip)?;
            let ThreeWay {
                theirs_only,
                conflicts,
            } = three_way(git, base.as_deref(), &local, &remote_tip)?;
            let seq = position_before_apply(rc, conn, &epoch)?;
            let mut changes = blob_changes(git, &theirs_only)?;
            changes.extend(remote_sidecars(git, &remote_tip, &conflicts)?);
            FetchPlan::Merge {
                seq,
                local,
                remote_tip,
                base,
                theirs_only,
                conflicts,
                changes,
            }
        }
    };
    match plan {
        FetchPlan::FastForward {
            epoch,
            seq,
            local,
            remote_tip,
            changes,
        } => {
            vault.apply(&changes, now)?;
            let conn = vault.conn();
            git.update_ref(&rc.config.branch, &remote_tip, local.as_deref())?;
            write_git_cursor(conn, rc.repo_id, &remote_tip, &epoch, seq)?;
            Ok(FetchResult {
                state: FetchState::FastForward,
                remote_tip: Some(remote_tip.clone()),
                old_remote_tip: None,
                tip: Some(remote_tip),
                applied: paths_of(&changes),
                conflicts: Vec::new(),
            })
        }
        FetchPlan::Merge {
            seq,
            local,
            remote_tip,
            base,
            theirs_only,
            conflicts,
            changes,
        } => {
            vault.apply(&changes, now)?;
            let conn = vault.conn();
            if !conflicts.is_empty() {
                record_conflicts(
                    rc,
                    conn,
                    r,
                    &remote_tip,
                    &conflicts,
                    now,
                    &[("base", json!(base))],
                )?;
                return Ok(FetchResult {
                    state: FetchState::Conflict,
                    remote_tip: Some(remote_tip),
                    old_remote_tip: None,
                    tip: Some(local),
                    applied: paths_of(&changes),
                    conflicts,
                });
            }
            let tree = merged_tree(git, &local, &theirs_only)?;
            let merged = write_merge_commit(rc, conn, r, &tree, &local, &remote_tip, seq, now)?;
            Ok(FetchResult {
                state: FetchState::Merged,
                remote_tip: Some(remote_tip),
                old_remote_tip: None,
                tip: Some(merged),
                applied: paths_of(&changes),
                conflicts: Vec::new(),
            })
        }
    }
}

// ---- resolve ----

/// `history remote resolve <path> --ours|--theirs`: the sidecar leaves the
/// vault (`--theirs` first writes the remote's version over ours); the path
/// leaves the alert; when none remains the pending merge — if one waits — is
/// committed over the resolution the worker just checkpointed.
pub fn resolve_conflict(
    rc: &RemoteContext<'_>,
    vault: &mut dyn HistoryVaultSink,
    path: &str,
    choice: ResolveChoice,
    now: &str,
) -> Result<ResolveResult> {
    let r = require_remote(rc)?;
    let git = rc.git;
    let (detail, paths, remote_tip, changes) = {
        let conn = vault.conn();
        let Some(detail) = active_alert(conn, rc.repo_id, GIT_MERGE_CONFLICT_ALERT)? else {
            return Err(Error::Other(
                "no merge conflict is pending for this repository".to_owned(),
            ));
        };
        let paths = strs_of(&detail, "paths");
        if !paths.iter().any(|p| p == path) {
            return Err(Error::Other(format!(
                "{path} is not a pending conflict (pending: {})",
                paths.join(", ")
            )));
        }
        let remote_tip = str_of(&detail, "remote_tip");
        let holds = detail
            .get("holds")
            .and_then(Json::as_object)
            .and_then(|h| h.get(path))
            .and_then(Json::as_str)
            .unwrap_or("theirs")
            .to_owned();
        let sidecar = detail
            .get("sidecars")
            .and_then(Json::as_object)
            .and_then(|s| s.get(path))
            .and_then(Json::as_str)
            .map(str::to_owned)
            .or_else(|| {
                remote_tip
                    .as_deref()
                    .map(|t| sidecar_path(path, "remote", t))
            });
        let mut changes: Vec<VaultChange> = Vec::new();
        if holds == "theirs" {
            // The vault holds OURS at the path, THEIRS in the sidecar.
            if choice == ResolveChoice::Theirs
                && let Some(t) = &remote_tip
            {
                let blob = git.tree_entries(t)?.get(path).cloned();
                changes.push(VaultChange {
                    path: path.to_owned(),
                    content: match blob {
                        Some(b) => Some(git.blob(&b)?),
                        None => None,
                    },
                });
            }
        } else if choice == ResolveChoice::Ours
            && let Some(side) = &sidecar
        {
            // `--adopt` left THEIRS at the path, OURS in the sidecar: ours comes back.
            let live: Option<String> = conn
                .query_row(
                    "SELECT doc_id FROM docs WHERE repo_id = ?1 AND path = ?2 AND deleted_at IS NULL",
                    params![rc.repo_id, side],
                    |row| row.get(0),
                )
                .optional()?;
            let bytes = match live {
                Some(doc_id) => omgbase_store::read::reconstruct(conn, &doc_id)?,
                None => None,
            };
            if let Some(b) = bytes {
                changes.push(VaultChange {
                    path: path.to_owned(),
                    content: Some(b.into_bytes()),
                });
            }
        }
        if let Some(side) = &sidecar {
            changes.push(VaultChange {
                path: side.clone(),
                content: None,
            });
        }
        (detail, paths, remote_tip, changes)
    };
    vault.apply(&changes, now)?;
    let conn = vault.conn();
    let remaining: Vec<String> = paths.into_iter().filter(|p| p != path).collect();
    let mut merged = None;
    if remaining.is_empty() {
        clear_alert(conn, rc.repo_id, GIT_MERGE_CONFLICT_ALERT, now)?;
        if let Some(waiting) = git.ref_sha(&merge_ref(r))? {
            // The resolution is checkpointed first, so the merge commit's tree is the vault's.
            run_checkpoint(&rc.worker(conn), now)?;
            let tip = git
                .tip(&rc.config.branch)?
                .ok_or_else(|| Error::Other("the branch has no tip".to_owned()))?;
            let epoch = repo_epoch(conn, rc.repo_id)?;
            let seq = position_before_apply(rc, conn, &epoch)?;
            merged = Some(write_merge_commit(
                rc,
                conn,
                r,
                &git.tree_of(&tip)?,
                &tip,
                &waiting,
                seq,
                now,
            )?);
            git.delete_ref(&merge_ref(r))?;
        }
    } else {
        let mut refreshed = detail.clone();
        refreshed.insert("paths".to_owned(), json!(remaining));
        raise_alert(
            conn,
            rc.repo_id,
            &AlertInput {
                code: GIT_MERGE_CONFLICT_ALERT,
                severity: AlertSeverity::Warning,
                message: &conflict_message(&r.name, &r.branch, remote_tip.as_deref(), &remaining),
                detail: Some(&refreshed),
            },
            now,
        )?;
    }
    Ok(ResolveResult {
        path: path.to_owned(),
        choice,
        remaining,
        merged,
        tip: git.tip(&rc.config.branch)?,
    })
}

// ---- the divergence remediations ----

fn clear_divergence(
    rc: &RemoteContext<'_>,
    conn: &Connection,
    r: &GitRemoteConfig,
    now: &str,
) -> Result<()> {
    clear_alert(conn, rc.repo_id, GIT_REMOTE_DIVERGED_ALERT, now)?;
    clear_alert(conn, rc.repo_id, GIT_REMOTE_FORKED_ALERT, now)?;
    rc.git.delete_ref(&diverged_ref(r))
}

fn backup(rc: &RemoteContext<'_>, tip: &str, now: &str) -> Result<String> {
    rc.git
        .set_ref(&format!("refs/omgbase/backup/{}", ts_segment(now)), tip)?;
    Ok(tip.to_owned())
}

fn raise_conflicts(
    conn: &Connection,
    repo_id: &str,
    r: &GitRemoteConfig,
    remote_tip: &str,
    detail: &Map<String, Json>,
    paths: &[String],
    now: &str,
) -> Result<()> {
    raise_alert(
        conn,
        repo_id,
        &AlertInput {
            code: GIT_MERGE_CONFLICT_ALERT,
            severity: AlertSeverity::Warning,
            message: &conflict_message(&r.name, &r.branch, Some(remote_tip), paths),
            detail: Some(detail),
        },
        now,
    )
}

/// `history remote reconcile --rebase|--merge|--adopt|--fork`.
#[allow(clippy::too_many_lines)]
pub fn reconcile_remote(
    rc: &RemoteContext<'_>,
    vault: &mut dyn HistoryVaultSink,
    mode: ReconcileMode,
    now: &str,
) -> Result<ReconcileResult> {
    let r = require_remote(rc)?;
    let git = rc.git;
    // The common prologue, over the lent connection.
    let (epoch, local, remote_tip, old) = {
        let conn = vault.conn();
        let Some((_, detail)) = paused_by(conn, rc.repo_id)? else {
            return Err(Error::Other(
                "the remote is not diverged: history remote reconcile applies only while the git_remote_diverged (or git_remote_forked) alert is active"
                    .to_owned(),
            ));
        };
        let epoch = repo_epoch(conn, rc.repo_id)?;
        let local = git.tip(&rc.config.branch)?;
        let remote_tip = match git.ref_sha(&tracking_ref(r))? {
            Some(t) => Some(t),
            None => str_of(&detail, "remote_tip"),
        };
        let old = match git.ref_sha(&diverged_ref(r))? {
            Some(o) => Some(o),
            None => str_of(&detail, "old_remote_tip"),
        };
        (epoch, local, remote_tip, old)
    };
    let (Some(local), Some(remote_tip)) = (local, remote_tip) else {
        return Err(Error::Other(
            "nothing to reconcile: the branch or the remote has no tip".to_owned(),
        ));
    };
    let mut result = ReconcileResult {
        mode,
        tip: Some(local.clone()),
        backup: None,
        rewritten: 0,
        fork: None,
        applied: Vec::new(),
        conflicts: Vec::new(),
    };

    match mode {
        ReconcileMode::Fork => {
            let fork = format!("{}-omgbase-{}", r.branch, ts_segment(now));
            let spec = format!("refs/heads/{}:refs/heads/{fork}", rc.config.branch);
            match git.push(&r.name, &[&spec])? {
                PushStatus::Ok => {}
                PushStatus::Rejected(stderr) | PushStatus::Failed(stderr) => {
                    return Err(Error::Other(format!(
                        "push of the fork {fork} to {} failed: {stderr}",
                        r.name
                    )));
                }
            }
            let conn = vault.conn();
            clear_divergence(rc, conn, r, now)?;
            let mut detail = Map::new();
            detail.insert("remote".to_owned(), json!(r.name));
            detail.insert("branch".to_owned(), json!(r.branch));
            detail.insert("fork".to_owned(), json!(fork));
            detail.insert("local_tip".to_owned(), json!(local));
            detail.insert("remote_tip".to_owned(), json!(remote_tip));
            detail.insert("old_remote_tip".to_owned(), json!(old));
            raise_alert(
                conn,
                rc.repo_id,
                &AlertInput {
                    code: GIT_REMOTE_FORKED_ALERT,
                    severity: AlertSeverity::Warning,
                    message: &forked_message(&r.name, &r.branch, &fork),
                    detail: Some(&detail),
                },
                now,
            )?;
            result.fork = Some(fork);
            Ok(result)
        }

        ReconcileMode::Adopt => {
            // The remote's head becomes truth: its tree into the vault; a path we
            // edited since the last agreement keeps our version beside it.
            let theirs = git.tree_entries(&remote_tip)?;
            let ours = git.tree_entries(&local)?;
            let base: BTreeMap<String, String> = match &old {
                Some(o) => git.tree_entries(o)?,
                None => BTreeMap::new(),
            };
            let mut changes: Vec<VaultChange> = Vec::new();
            let mut conflicts: Vec<String> = Vec::new();
            let mut sidecars = Map::new();
            let mut holds = Map::new();
            let paths: BTreeSet<&String> = theirs.keys().chain(ours.keys()).collect();
            for path in paths {
                let t = theirs.get(path);
                let o = ours.get(path);
                let b = base.get(path);
                if t == o {
                    continue;
                }
                let theirs_bytes = match t {
                    Some(blob) => Some(git.blob(blob)?),
                    None => None,
                };
                if o == b {
                    // Only the remote changed it.
                    changes.push(VaultChange {
                        path: path.clone(),
                        content: theirs_bytes,
                    });
                    continue;
                }
                if t.is_none() && b.is_none() {
                    // Ours alone, new on our side: kept, committed on top.
                    continue;
                }
                // A local edit the remote does not have: the remote's version takes
                // the path, ours stays beside it.
                let side = sidecar_path(path, "local", &local);
                changes.push(VaultChange {
                    path: path.clone(),
                    content: theirs_bytes,
                });
                if let Some(ob) = o {
                    changes.push(VaultChange {
                        path: side.clone(),
                        content: Some(git.blob(ob)?),
                    });
                }
                conflicts.push(path.clone());
                sidecars.insert(path.clone(), json!(side));
                holds.insert(path.clone(), json!("ours"));
            }
            let seq = position_before_apply(rc, vault.conn(), &epoch)?;
            vault.apply(&changes, now)?;
            let conn = vault.conn();
            result.backup = Some(backup(rc, &local, now)?);
            git.update_ref(&rc.config.branch, &remote_tip, Some(&local))?;
            write_git_cursor(conn, rc.repo_id, &remote_tip, &epoch, seq)?;
            clear_divergence(rc, conn, r, now)?;
            if !conflicts.is_empty() {
                let mut d = Map::new();
                d.insert("remote".to_owned(), json!(r.name));
                d.insert("branch".to_owned(), json!(r.branch));
                d.insert("remote_tip".to_owned(), json!(remote_tip));
                d.insert("paths".to_owned(), json!(conflicts));
                d.insert("sidecars".to_owned(), Json::Object(sidecars));
                d.insert("holds".to_owned(), Json::Object(holds));
                raise_conflicts(conn, rc.repo_id, r, &remote_tip, &d, &conflicts, now)?;
            }
            result.tip = Some(remote_tip);
            result.applied = paths_of(&changes);
            result.conflicts = conflicts;
            Ok(result)
        }

        ReconcileMode::Merge => {
            // One merge commit with the old remote tip as the base (what both
            // sides last agreed on); both histories kept.
            let base = match &old {
                Some(o) => Some(o.clone()),
                None => git.merge_base(&local, &remote_tip)?,
            };
            let ThreeWay {
                theirs_only,
                conflicts,
            } = three_way(git, base.as_deref(), &local, &remote_tip)?;
            let seq = position_before_apply(rc, vault.conn(), &epoch)?;
            let mut changes = blob_changes(git, &theirs_only)?;
            changes.extend(remote_sidecars(git, &remote_tip, &conflicts)?);
            vault.apply(&changes, now)?;
            let conn = vault.conn();
            clear_divergence(rc, conn, r, now)?;
            if !conflicts.is_empty() {
                record_conflicts(
                    rc,
                    conn,
                    r,
                    &remote_tip,
                    &conflicts,
                    now,
                    &[("base", json!(base))],
                )?;
                result.applied = paths_of(&changes);
                result.conflicts = conflicts;
                return Ok(result);
            }
            result.backup = Some(backup(rc, &local, now)?);
            let tree = merged_tree(git, &local, &theirs_only)?;
            let merged = write_merge_commit(rc, conn, r, &tree, &local, &remote_tip, seq, now)?;
            result.tip = Some(merged);
            result.rewritten = 1;
            result.applied = paths_of(&changes);
            Ok(result)
        }

        ReconcileMode::Rebase => {
            // Replay our unpushed checkpoints onto the new remote head, per file
            // three-way with the old remote tip as base.
            let ours_commits = git.rev_list(old.as_deref(), &local)?;
            let mut running = remote_tip.clone();
            let mut conflicts: BTreeSet<String> = BTreeSet::new();
            let mut rewritten: HashMap<String, String> = HashMap::new();
            for c in &ours_commits {
                let parents = git.parents_of(c)?;
                let first_parent = parents.first().cloned();
                let diff = git.diff_trees(first_parent.as_deref().unwrap_or(EMPTY_TREE), c)?;
                let parent_tree = match &first_parent {
                    Some(p) => git.tree_entries(p)?,
                    None => BTreeMap::new(),
                };
                let running_tree = git.tree_entries(&running)?;
                let mut adds: Vec<(String, String)> = Vec::new();
                let mut removes: Vec<String> = Vec::new();
                for (path, blob) in &diff {
                    let current = running_tree.get(path);
                    let before = parent_tree.get(path);
                    if current == blob.as_ref() {
                        continue; // the remote did the same
                    }
                    if current != before {
                        conflicts.insert(path.clone()); // the remote changed it too: ours stands, theirs beside it (below)
                    }
                    match blob {
                        None => {
                            if current.is_some() {
                                removes.push(path.clone());
                            }
                        }
                        Some(b) => adds.push((path.clone(), b.clone())),
                    }
                }
                let tree = if adds.is_empty() && removes.is_empty() {
                    git.tree_of(&running)?
                } else {
                    git.build_tree(Some(&git.tree_of(&running)?), &adds, &removes)?
                };
                let raw = git.message(c)?;
                let message = raw.strip_suffix('\n').unwrap_or(&raw);
                let trailers = parse_message(message);
                let author = git.author_of(c)?;
                let mut new_parents: Vec<String> = vec![running.clone()];
                for p in parents.iter().skip(1) {
                    new_parents.push(rewritten.get(p).cloned().unwrap_or_else(|| p.clone()));
                }
                let parent_refs: Vec<&str> = new_parents.iter().map(String::as_str).collect();
                let ts = trailers
                    .as_ref()
                    .map(|t| t.ts.as_str())
                    .filter(|t| !t.is_empty())
                    .unwrap_or(now);
                let sha = git.commit_tree_parents(
                    &tree,
                    &parent_refs,
                    message,
                    &GitIdentity {
                        name: author.name,
                        email: rc.identity.email.clone(),
                    },
                    rc.identity,
                    ts,
                )?;
                rewritten.insert(c.clone(), sha.clone());
                running = sha;
            }
            // The remote's changes since the old tip that we never touched enter
            // the vault; the conflicting paths' remote versions beside ours.
            let ThreeWay { theirs_only, .. } = three_way(git, old.as_deref(), &local, &remote_tip)?;
            let conflict_paths: Vec<String> = conflicts.into_iter().collect();
            let mut changes = blob_changes(git, &theirs_only)?;
            changes.extend(remote_sidecars(git, &remote_tip, &conflict_paths)?);
            let seq = position_before_apply(rc, vault.conn(), &epoch)?;
            vault.apply(&changes, now)?;
            let conn = vault.conn();
            result.backup = Some(backup(rc, &local, now)?);
            git.update_ref(&rc.config.branch, &running, Some(&local))?;
            write_git_cursor(conn, rc.repo_id, &running, &epoch, seq)?;
            rebase_ids(rc, r, &rewritten, now)?;
            clear_divergence(rc, conn, r, now)?;
            if !conflict_paths.is_empty() {
                let mut d = Map::new();
                d.insert("remote".to_owned(), json!(r.name));
                d.insert("branch".to_owned(), json!(r.branch));
                d.insert("remote_tip".to_owned(), json!(remote_tip));
                d.insert("paths".to_owned(), json!(conflict_paths));
                raise_conflicts(conn, rc.repo_id, r, &remote_tip, &d, &conflict_paths, now)?;
            }
            result.tip = Some(running);
            result.rewritten = ours_commits.len();
            result.applied = paths_of(&changes);
            result.conflicts = conflict_paths;
            Ok(result)
        }
    }
}

/// The ids ref rebased alongside: every ids commit whose `omgbase-content`
/// names a rewritten content commit is replayed — its tree changes over the
/// remote's ids tip when we have fetched one (else over its own base) — with
/// the trailer re-pointed at the rewritten sha. Identities are ours
/// throughout; the remote's ids chain, when it differs, is 6c's reconciliation.
fn rebase_ids(
    rc: &RemoteContext<'_>,
    r: &GitRemoteConfig,
    rewritten: &HashMap<String, String>,
    now: &str,
) -> Result<()> {
    let git = rc.git;
    let Some(ids_tip) = git.ref_sha(&rc.config.ids_ref)? else {
        return Ok(());
    };
    if rewritten.is_empty() {
        return Ok(());
    }
    let chain = git.rev_list(None, &ids_tip)?;
    let mut first = None;
    for (i, c) in chain.iter().enumerate() {
        if parse_message(&git.message(c)?)
            .and_then(|t| t.content)
            .is_some_and(|content| rewritten.contains_key(&content))
        {
            first = Some(i);
            break;
        }
    }
    let Some(first) = first else {
        return Ok(());
    };
    let replay = &chain[first..];
    let base = match git.ref_sha(&ids_tracking_ref(r))? {
        Some(b) => Some(b),
        None => git.parents_of(&replay[0])?.first().cloned(),
    };
    let mut running = base;
    for c in replay {
        let parent = git.parents_of(c)?.first().cloned();
        let diff = git.diff_trees(parent.as_deref().unwrap_or(EMPTY_TREE), c)?;
        let adds: Vec<(String, String)> = diff
            .iter()
            .filter_map(|(p, b)| b.as_ref().map(|b| (p.clone(), b.clone())))
            .collect();
        let running_entries = match &running {
            Some(rn) => git.tree_entries(rn)?,
            None => BTreeMap::new(),
        };
        let removes: Vec<String> = diff
            .iter()
            .filter(|(p, b)| b.is_none() && running.is_some() && running_entries.contains_key(p))
            .map(|(p, _)| p.clone())
            .collect();
        let running_tree = match &running {
            Some(rn) => Some(git.tree_of(rn)?),
            None => None,
        };
        let tree = git.build_tree(running_tree.as_deref(), &adds, &removes)?;
        let raw = git.message(c)?;
        let stripped = raw.strip_suffix('\n').unwrap_or(&raw);
        let message: String = stripped
            .split('\n')
            .map(|line| match line.strip_prefix("omgbase-content: ") {
                Some(sha) if crate::git::is_sha(sha) => {
                    format!(
                        "omgbase-content: {}",
                        rewritten.get(sha).map_or(sha, String::as_str)
                    )
                }
                _ => line.to_owned(),
            })
            .collect::<Vec<_>>()
            .join("\n");
        let t = parse_message(&message);
        let author = git.author_of(c)?;
        let ts = t
            .as_ref()
            .map(|t| t.ts.as_str())
            .filter(|t| !t.is_empty())
            .unwrap_or(now);
        running = Some(git.commit_tree(
            &tree,
            running.as_deref(),
            &message,
            &GitIdentity {
                name: author.name,
                email: rc.identity.email.clone(),
            },
            rc.identity,
            ts,
        )?);
    }
    if let Some(rn) = running {
        git.update_ref_raw(&rc.config.ids_ref, &rn, Some(&ids_tip))?;
    }
    Ok(())
}

// ---- the sweep's steps 7–8 ----

/// `remote_sync` of the provider seam (`spec/sync` §4.3 steps 7–8): push on
/// `periodic`, fetch on `periodic`; both skipped while paused or while a
/// merge waits.
pub fn remote_sync(
    rc: &RemoteContext<'_>,
    vault: &mut dyn HistoryVaultSink,
    now: &str,
) -> Result<Option<RemoteSyncResult>> {
    let Some(r) = rc.config.remote.as_ref() else {
        return Ok(None);
    };
    {
        let conn = vault.conn();
        if paused_by(conn, rc.repo_id)?.is_some()
            || active_alert(conn, rc.repo_id, GIT_MERGE_CONFLICT_ALERT)?.is_some()
        {
            return Ok(Some(RemoteSyncResult {
                pushed: None,
                fetched: None,
                paused: true,
            }));
        }
    }
    let mut out = RemoteSyncResult {
        pushed: None,
        fetched: None,
        paused: false,
    };
    if r.fetch == FetchPolicy::Periodic {
        out.fetched = Some(match fetch_remote(rc, vault, now) {
            Ok(f) => f.to_json(),
            Err(e) => json!({ "error": e.to_string() }),
        });
    }
    if r.push == PushPolicy::Periodic {
        out.pushed = Some(match push_branch(rc, vault.conn(), now) {
            Ok(p) => PushOutcome::Pushed(p),
            Err(e) => PushOutcome::Failed(e.to_string()),
        });
    }
    Ok(Some(out))
}

/// `push: "on-checkpoint"`: after a checkpoint that committed, the push — its
/// error reported on the receipt, never thrown (the checkpoint stands).
pub fn push_after_checkpoint(
    rc: &RemoteContext<'_>,
    conn: &Connection,
    now: &str,
    committed: usize,
) -> Option<PushOutcome> {
    let r = rc.config.remote.as_ref()?;
    if r.push != PushPolicy::OnCheckpoint || committed == 0 {
        return None;
    }
    Some(match push_branch(rc, conn, now) {
        Ok(p) => PushOutcome::Pushed(p),
        Err(e) => PushOutcome::Failed(e.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_sidecars_and_the_pinned_messages() {
        assert_eq!(ts_segment("2026-09-27T00:00:00.000Z"), "20260927T000000Z");
        assert_eq!(ts_segment("2026-10-20T10:07:00Z"), "20261020T100700Z");
        let sha = "e5b5fffac377c823d17941ebb5e1fc5effe73e26";
        assert_eq!(sidecar_path("a.md", "remote", sha), "a.remote-e5b5fff.md");
        assert_eq!(
            sidecar_path("notes/a.md", "local", sha),
            "notes/a.local-e5b5fff.md"
        );
        assert_eq!(sidecar_path("a.txt", "remote", sha), "a.txt.remote-e5b5fff");
        assert_eq!(
            rejected_message("origin", "omgbase", None, None),
            "push to origin/omgbase was rejected: the remote is at an unknown tip, which does not descend from our tip — run omg history fetch to merge the remote's commits, then push again"
        );
        assert_eq!(
            rewritten_message("origin", "omgbase", Some("a"), None),
            "the remote origin/omgbase was rewritten: its tip a does not descend from the last known (none — unrelated histories) — push and fetch are paused while checkpoints continue locally; choose omg history remote reconcile --rebase | --merge | --adopt | --fork"
        );
        assert_eq!(
            conflict_message(
                "origin",
                "omgbase",
                Some("x"),
                &["a.md".to_owned(), "b.md".to_owned()]
            ),
            "the merge of origin/omgbase at x left 2 conflict(s): a.md, b.md — both versions are in the vault; settle each with omg history remote resolve <path> --ours|--theirs"
        );
        assert_eq!(
            forked_message("origin", "omgbase", "omgbase-omgbase-20261020T100700Z"),
            "the engine's branch was pushed to origin/omgbase-omgbase-20261020T100700Z — merge it into omgbase with git, then run omg history remote reconcile --adopt (push and fetch stay paused until then)"
        );
        assert_eq!(ReconcileMode::parse("adopt"), Some(ReconcileMode::Adopt));
        assert_eq!(ReconcileMode::parse("x"), None);
    }
}
