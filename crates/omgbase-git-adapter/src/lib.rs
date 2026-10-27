//! # omgbase-git-adapter
//!
//! The Git-backed history provider (modular-core Phase 6a; `spec/store`
//! §5.12, `spec/surface` §3 "The git provider", `spec/cli` `history`,
//! `spec/sync` §6), Rust implementation — the twin of `@omgbase/git-adapter`.
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
//! - [`provider`] — the seam implementation; [`config`], [`cursor`],
//!   [`exclude`] its helpers.

#![forbid(unsafe_code)]

pub mod config;
pub mod cursor;
pub mod exclude;
pub mod git;
pub mod provider;
pub mod reader;
pub mod trailers;
pub mod worker;

pub use config::{
    Cadence, DEFAULT_BRANCH, DEFAULT_GIT_DIR, GIT_PROVIDER, GitHistoryConfig, IDS_REF,
    git_config_for, parse_cadence, read_git_config, refuse_credentials,
};
pub use cursor::{
    GIT_CURSOR_SOURCE, GitCursor, clear_git_cursor, read_git_cursor, write_git_cursor,
};
pub use exclude::{EXCLUDE_LINE, Excluded, ensure_excluded, exclude_file_for};
pub use git::{
    GIT_BIN_ENV, GitIdentity, GitRepo, LogRecord, ZERO_SHA, git_available, git_bin, git_date,
    is_sha, reset_git_probe,
};
pub use provider::{GitHistoryProvider, default_identity, fixture_identity};
pub use reader::GitHistoryReader;
pub use trailers::{
    CommitTrailers, DocTrailer, TRAILER_PREFIX, parse_message, render_message, seq_value,
    subject_of,
};
pub use worker::{WorkerContext, commit_snapshot, run_checkpoint, tip_position};

/// This crate's own version (`Cargo.toml`), for the `version` tool.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
