//! # omgbase-git-adapter
//!
//! The Git-backed history provider (modular-core Phase 6a, the remote half
//! 6b; `spec/store` §5.12, `spec/surface` §3 "The git provider", `spec/cli`
//! `history`, `spec/sync` §6), Rust implementation — the twin of
//! `@omgbase/git-adapter`.
//! The core knows a [`HistoryProvider`](omgbase_store::HistoryProvider) by
//! name; this crate is the one named `git`. Nothing here is imported by
//! `omgbase-store`: the composition layer (the `omgbase` binary, the fixture
//! runners) attaches [`GitHistoryProvider`] through
//! [`Capabilities::with_provider`](omgbase_store::Capabilities::with_provider)
//! before a store opens.
//!
//! - [`git`] — the plumbing wrapper: every call spawns `git` with `GIT_DIR`
//!   and an environment that reads no user configuration, so every object's
//!   bytes are a function of the engine's inputs alone.
//! - [`trailers`] — the commit message codec: a subject, a blank line, the
//!   `omgbase-*` trailers both engines render and parse themselves.
//! - [`worker`] — the checkpoint worker: the feed rows since the branch tip
//!   become commits built from the database rows.
//! - [`reader`] — the read half over the bare repository.
//! - [`remote`] — the remote half (6b): the binding, push (never `--force`),
//!   fetch with the tree-level three-way merge through the vault sink,
//!   conflict sidecars and `resolve`, the divergence remediations.
//! - [`ids`] — the identity record's second half: `refs/omgbase/ids`.
//! - [`scheduler`] — the mutation hook's debounce timer.
//! - [`provider`] — the seam implementation; [`config`], [`cursor`],
//!   [`exclude`] its helpers.

#![forbid(unsafe_code)]

pub mod config;
pub mod cursor;
pub mod exclude;
pub mod git;
pub mod ids;
pub mod provider;
pub mod reader;
pub mod remote;
pub mod scheduler;
pub mod trailers;
pub mod worker;

pub use config::{
    Cadence, DEFAULT_BRANCH, DEFAULT_GIT_DIR, DEFAULT_REMOTE_NAME, FETCH_POLICIES, FetchPolicy,
    GIT_PROVIDER, GitHistoryConfig, GitRemoteConfig, IDS_REF, PUSH_POLICIES, PushPolicy,
    RemoteOptions, git_config_for, parse_cadence, read_git_config, read_remote_config,
    refuse_credentials, remote_config_for, valid_remote_name,
};
pub use cursor::{
    GIT_CURSOR_SOURCE, GitCursor, GitPushed, clear_git_cursor, read_git_cursor, write_git_cursor,
    write_git_pushed,
};
pub use exclude::{EXCLUDE_LINE, Excluded, ensure_excluded, exclude_file_for};
pub use git::{
    EMPTY_TREE, GIT_BIN_ENV, GitIdentity, GitRepo, LogRecord, PushStatus, ZERO_SHA, git_available,
    git_bin, git_date, is_sha, reset_git_probe,
};
pub use ids::{
    IDS_PREFIX, IdsBlock, IdsRecord, IdsSyncInput, ids_blob_text, ids_path, ids_position,
    ids_record, sync_ids,
};
pub use provider::{GitHistoryProvider, default_identity, fixture_identity};
pub use reader::GitHistoryReader;
pub use remote::{
    FetchResult, FetchState, GIT_MERGE_CONFLICT_ALERT, GIT_REMOTE_DIVERGED_ALERT,
    GIT_REMOTE_FORKED_ALERT, ReconcileMode, ReconcileResult, RemoteContext, RemoteStatus,
    ResolveChoice, ResolveResult, conflict_message, fetch_remote, forked_message, paused_by,
    push_after_checkpoint, push_branch, reconcile_remote, rejected_message, remote_set,
    remote_status, remote_summary, remote_sync, remote_unset, resolve_conflict, rewritten_message,
    sidecar_path, ts_segment,
};
pub use scheduler::{CheckpointScheduler, ErrorFn, RunFn};
pub use trailers::{
    CommitTrailers, DocTrailer, TRAILER_PREFIX, parse_message, render_message, seq_value,
    subject_of,
};
pub use worker::{WorkerContext, commit_snapshot, resume_position, run_checkpoint, tip_position};

/// This crate's own version (`Cargo.toml`), for the `version` tool.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
