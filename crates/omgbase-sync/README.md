# omgbase-sync

The omgbase sync layer, Rust implementation of `spec/sync`: how bytes get
*between* an omgbase repository (an `omgbase-store` database) and the places
they live.

- **Workspace** (§1): `.omgbase/` discovery by walking up, `Workspace::open`
  / `find` / `locate` (`--workspace` > `OMGBASE_WORKSPACE` > discovery),
  repos with their *derived* root path, and `select_repo` as a pure function
  over `[(slug, root_path)]` + `cwd` + an optional slug.
- **Registry** (§2): `ensure_adapter`, `create_source` (mints `src`),
  `delete_source`, `attach` / `detach`, `sources_for_repo`, `ensure_repo`
  (mints `rp` and the `<slug>-fs` source), `render_config_flags` with
  JavaScript stringification of scalars.
- **Settings** (§3): the workspace layer and a repo's own blob, `deep_merge`,
  `resolve_settings`.
- **Checkpoints and the filesystem fast path** (§4): a `FileSystem` seam
  (`RealFileSystem`, `MemFileSystem` for fixtures — the walk visits each
  directory's entries in bytewise name order, depth-first), `process_checkpoint`, `sweep_plan` as a
  pure function over the `file_stats` cache and a snapshot, `freshness_sweep`,
  `record_file_stat`, `detect_disk_drift`, `rebuild_file_stats`,
  `recover_repo`, `repos_status`, `sync_status`.
- **The adapter protocol** (§5): the `SyncSource` trait and `ExternalSource`,
  which spawns an adapter with `args + render_config_flags(config)` and the
  source's `env` and speaks the NDJSON handshake / request / response
  protocol (ids from 1), with the watch stream on a channel. `pipe` offers an
  in-memory pipe and a scripted adapter for driving it without a process.
- **Driver and coordinator** (§6): `reconcile_changes`, `attach_source`, the
  `EngineClient` trait with `InProcessEngineClient` over the store
  (`observe_many`, `observe_delete`, `changes_since`, `read_doc`), and
  `Coordinator::{sync_in, reconcile, sync_out, watch_in}`.
- **Locks** (§7): `WriterLock` (`O_EXCL`, pid JSON, dead holders stolen,
  25 ms poll / 5 s timeout) and `WatchLease`; liveness via `kill(pid, 0)`.

```rust,no_run
use omgbase_reconcile::Config;
use omgbase_store::Store;
use omgbase_sync::{fs::RealFileSystem, freshness, registry};

let mut store = Store::open(".omgbase/omgbase.db")?;
let repo = registry::ensure_repo(&mut store, "notes", Some("/home/me/notes"))?;
let sweep = freshness::freshness_sweep(
    &mut store, &repo, &RealFileSystem, "/home/me/notes".as_ref(),
    "2026-09-26T10:00:00.000Z", None, &Config::default(),
)?;
println!("{} files scanned, changed: {}", sweep.scanned, sweep.changed);
# Ok::<(), omgbase_sync::Error>(())
```

Conformance: `tests/spec.rs` runs every case under `spec/sync/cases`
(`pure`, `registry`, `checkpoint`, `protocol` — adapter transcripts over an
in-process pipe, coordinator scripts against a recording engine client),
gated by `tests/spec-passing.txt` while the port runs behind the fixtures.
The crate version tracks `spec/sync/VERSION` (`1.1`).

Unix only: lock-holder liveness uses `kill(pid, 0)`.
