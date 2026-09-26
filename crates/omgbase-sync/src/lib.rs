//! # omgbase-sync
//!
//! The omgbase sync layer, Rust implementation of `spec/sync`: how bytes get
//! *between* an omgbase repository (an [`omgbase_store::Store`]) and the
//! places they live — the [`workspace`] on disk that holds the database, the
//! source [`registry`] that says where a repo's bytes come from, the
//! [`settings`] layers, the [`checkpoint`] rows and the filesystem fast path
//! ([`freshness`] sweep, disk drift, [`recovery`]) over a [`fs::FileSystem`]
//! seam, the adapter stdio protocol client ([`external`]), the [`driver`] and
//! the [`coordinator`] over an [`engine::EngineClient`], and the advisory
//! [`lock`]s. [`pipe`] is an in-memory pipe with a scripted adapter, for
//! driving the protocol client without a process. The reconciliation itself is the store's (`spec/store` §5).
//!
//! ```no_run
//! use omgbase_reconcile::Config;
//! use omgbase_store::Store;
//! use omgbase_sync::{fs::RealFileSystem, registry, freshness};
//!
//! let mut store = Store::open(".omgbase/omgbase.db")?;
//! let repo = registry::ensure_repo(&mut store, "notes", Some("/home/me/notes"))?;
//! let sweep = freshness::freshness_sweep(
//!     &mut store, &repo, &RealFileSystem, "/home/me/notes".as_ref(),
//!     "2026-09-26T10:00:00.000Z", None, &Config::default(),
//! )?;
//! println!("{} files scanned, changed: {}", sweep.scanned, sweep.changed);
//! # Ok::<(), omgbase_sync::Error>(())
//! ```

#![deny(unsafe_code)]

pub mod admin;
pub mod checkpoint;
pub mod coordinator;
pub mod driver;
pub mod engine;
pub mod error;
pub mod external;
pub mod freshness;
pub mod fs;
pub mod lock;
pub mod pipe;
pub mod recovery;
pub mod registry;
pub mod settings;
pub mod source;
pub mod workspace;

pub use admin::{DiskStatus, RepoStatus, SyncStatus, repos_status, sync_status};
pub use checkpoint::{CheckpointResult, finish_checkpoint, process_checkpoint};
pub use coordinator::{Coordinator, SyncInSummary, SyncOutSummary};
pub use driver::{AttachResult, attach_source, reconcile_changes};
pub use engine::{DocBytes, EngineClient, InProcessEngineClient};
pub use error::{Error, Result};
pub use external::ExternalSource;
pub use freshness::{
    DiskDrift, SweepPlan, SweepResult, detect_disk_drift, freshness_sweep, rebuild_file_stats,
    record_file_stat, sweep_plan,
};
pub use fs::{FileStat, FileSystem, MemFileSystem, RealFileSystem, is_ignored_dir};
pub use lock::{WatchLease, WriterLock, WriterLockOptions, pid_alive, with_writer_lock};
pub use omgbase_store::{ChangesPage, CommitDigest, DeleteOutcome, DigestRevision, ObserveOutcome};
pub use recovery::{RecoveryResult, recover_repo};
pub use registry::{
    AdapterRow, SourceRow, attach, create_source, delete_source, detach, ensure_adapter,
    ensure_repo, list_adapters, list_sources, render_config_flags, source_by_name,
    sources_for_repo,
};
pub use settings::{
    Settings, deep_merge, repo_own_settings, resolve_settings, workspace_settings,
    write_repo_settings, write_workspace_settings,
};
pub use source::{SourceCapabilities, SourceEntry, SourceIdentity, SourceItem, SyncSource};
pub use workspace::{RepoRow, RepoSelection, Workspace, select_repo};

/// The `spec/sync/VERSION` this crate implements (`major.minor`).
pub const SPEC_VERSION: &str = "1.1";

/// The adapter protocol number the handshake must carry (`spec/sync` §5).
pub const PROTOCOL_VERSION: u64 = 1;

/// The current time as the store writes it (`spec/store` §2.4:
/// `YYYY-MM-DDTHH:MM:SS.fffZ`).
#[must_use]
pub fn now_ts() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    omgbase_store::time::format_ms(ms)
}
