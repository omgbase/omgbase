//! The git history provider (`spec/store` §5.12; modular-core Phase 6a) end
//! to end on a temporary workspace: the baseline, one commit per feed row
//! under `every`, the folding under a debounce cadence, the move and the
//! delete, the fault at `git.commit` and its byte-identical replay, the rescan
//! after a purge, the reader's shapes and its decision-table rows, the
//! provider conflict, the unavailable provider. The fixture suites pin the
//! same behaviour as projections (`spec/store/cases/history/git.json`,
//! `spec/surface/cases/reads.json` `git-history`); these are the unit-level
//! pins and the edges the fixtures do not reach — the twin of
//! `packages/git-adapter/src/git-adapter.test.ts`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use omgbase_git_adapter::{
    GIT_BIN_ENV, GitHistoryProvider, fixture_identity, git_config_for, read_git_cursor,
    reset_git_probe,
};
use omgbase_reconcile::Config;
use omgbase_store::{
    ArmedFault, BatchItem, Capabilities, Composition, Error, FaultSite,
    HISTORY_PROVIDER_UNAVAILABLE_ALERT, SequentialMinter, Store, list_active_alerts,
    read_capability, reset_faults, set_armed_fault,
};
use serde_json::{Map, json};

/// The tests arm process-wide state (the fault site, `OMGBASE_GIT_BIN`): one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

struct Fx {
    root: PathBuf,
    store: Store,
    repo: String,
}

impl Fx {
    fn new(name: &str, composition: Composition) -> Self {
        let root = std::env::temp_dir().join(format!(
            "omgbase-git-adapter-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(root.join(".omgbase")).unwrap();
        let caps =
            Capabilities::for_composition(composition, Capabilities::standard).with_provider(
                Box::new(GitHistoryProvider::new(root.clone(), fixture_identity())),
            );
        let mut store =
            Store::open_in_memory_with_capabilities(Box::new(SequentialMinter::new()), caps)
                .unwrap();
        let repo = store
            .create_repo_at("fx", "2026-10-20T10:00:00.000Z")
            .unwrap();
        reset_faults();
        set_armed_fault(None);
        Self { root, store, repo }
    }

    fn write(&mut self, path: &str, text: &str, ts: &str) {
        self.store
            .observe_batch(
                &self.repo,
                &[BatchItem::observed(path, text)],
                ts,
                &Config::default(),
            )
            .unwrap();
    }

    fn delete(&mut self, path: &str, ts: &str) {
        self.store
            .observe_batch(
                &self.repo,
                &[BatchItem {
                    path: path.to_owned(),
                    source: None,
                }],
                ts,
                &Config::default(),
            )
            .unwrap();
    }

    fn enable(
        &mut self,
        ts: &str,
        options: Map<String, serde_json::Value>,
    ) -> omgbase_store::Result<omgbase_store::HistoryLifecycleResult> {
        self.store
            .enable_history_with(&self.repo, ts, true, Some("git"), &options)
    }

    fn git(&self) -> omgbase_git_adapter::GitRepo {
        let row = read_capability(self.store.conn(), &self.repo, "history")
            .unwrap()
            .unwrap();
        GitHistoryProvider::new(self.root.clone(), fixture_identity()).git_repo(&row.config)
    }

    fn log(&self, branch: &str) -> String {
        let git = self.git();
        if git.exists() {
            git.text(&[
                "log",
                "--reverse",
                "--format=%H%n%s%n%(trailers)",
                &format!("refs/heads/{branch}"),
            ])
            .unwrap()
        } else {
            String::new()
        }
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        set_armed_fault(None);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn is_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[test]
fn baselines_commits_one_row_per_feed_row_and_reads_back_through_the_seam() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("basics", Composition::Git);
    fx.write("a.md", "# A\n\nFirst.\n", "2026-10-20T10:00:00.000Z");
    fx.write("b.md", "# B\n\nOnly.\n", "2026-10-20T10:00:00.000Z");
    let r = fx.enable("2026-10-20T10:01:00.000Z", Map::new()).unwrap();
    assert!(r.changed);
    assert_eq!(r.baseline, Some(("c_2".to_owned(), 2)));
    assert!(r.tip.as_deref().is_some_and(is_sha));
    let row = read_capability(fx.store.conn(), &fx.repo, "history")
        .unwrap()
        .unwrap();
    assert_eq!(row.config, git_config_for(&Map::new()).unwrap().to_map());
    assert!(
        fx.log("omgbase")
            .contains("history enabled\nomgbase-seq: ep_0:3\n")
    );
    let tree = fx.git().ls_tree("refs/heads/omgbase").unwrap();
    assert!(
        tree.contains("\ta.md\n") && tree.ends_with("\tb.md\n"),
        "{tree}"
    );
    // The row's state on the wire.
    let states = omgbase_sync::capability_states(Some(&fx.store), Some(&fx.repo));
    assert_eq!(
        states["history"],
        json!({ "state": "enabled", "provider": "git", "coverage_from": "2026-10-20T10:01:00.000Z", "writer_requires": true, "completeness": "every", "remote": null })
    );
    // No native row: `capture_for` is None for the provider row.
    assert!(fx.store.capture_for(Some(&fx.repo)).unwrap().is_none());
    fx.write(
        "a.md",
        "# A\n\nFirst, edited.\n",
        "2026-10-20T10:02:00.000Z",
    );
    let cp = fx
        .store
        .history_checkpoint(&fx.repo, "2026-10-20T10:03:00.000Z")
        .unwrap();
    assert_eq!(
        (cp.committed, cp.from_seq, cp.to_seq, cp.rescanned),
        (1, 4, 4, false)
    );
    let cursor = read_git_cursor(fx.store.conn(), &fx.repo).unwrap().unwrap();
    assert_eq!(
        (cursor.tip.as_str(), cursor.epoch.as_str(), cursor.seq),
        (cp.tip.as_deref().unwrap(), "ep_0", 4)
    );
    let reader = fx.store.history_reader_for(&fx.repo).unwrap().unwrap();
    let conn = fx.store.conn();
    let versions = reader.doc_versions(conn, "d_0", Some("r_2")).unwrap();
    let shape: Vec<(String, Option<i64>, bool, bool)> = versions
        .iter()
        .map(|v| (v.rev.clone(), v.seq, v.is_current, v.retained))
        .collect();
    assert_eq!(
        shape,
        [
            ("r_0".to_owned(), Some(3), false, true),
            ("r_2".to_owned(), Some(4), true, true)
        ]
    );
    assert_eq!(versions[1].commit, cp.tip);
    assert_eq!(
        reader
            .read_at_revision(conn, "d_0", "r_0")
            .unwrap()
            .unwrap()
            .content,
        "# A\n\nFirst.\n"
    );
    assert_eq!(
        reader
            .read_at_revision(conn, "d_0", cp.tip.as_deref().unwrap())
            .unwrap()
            .unwrap()
            .content,
        "# A\n\nFirst, edited.\n"
    );
    assert_eq!(
        fx.store
            .read_at_revision("d_0", "r_0")
            .unwrap()
            .unwrap()
            .content,
        "# A\n\nFirst.\n"
    );
    let latest = reader.latest_revisions(conn, "d_0").unwrap();
    assert_eq!(latest[0], cp.tip.clone().unwrap());
    assert!(
        reader
            .diff_unified(conn, "d_0", &latest[1], &latest[0])
            .unwrap()
            .contains("+First, edited.")
    );
    let rows: Vec<(String, String, i64, bool)> = reader
        .revision_rows(conn, &fx.repo)
        .unwrap()
        .iter()
        .map(|x| {
            (
                x.path.clone(),
                x.rev_id.clone(),
                x.seq,
                Some(&x.commit_id) == cp.tip.as_ref(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("a.md".to_owned(), "r_0".to_owned(), 3, false),
            ("a.md".to_owned(), "r_2".to_owned(), 4, true),
            ("b.md".to_owned(), "r_1".to_owned(), 3, false),
        ]
    );
    assert!(
        reader
            .has_revision(conn, cp.tip.as_deref().unwrap())
            .unwrap()
    );
    assert!(reader.has_revision(conn, "r_2").unwrap());
    assert!(!reader.has_revision(conn, "r_9").unwrap());
    assert_eq!(
        reader
            .uncaptured_heads(conn, &fx.repo, "2026-10-20T10:01:00.000Z")
            .unwrap(),
        0
    );
    assert_eq!(reader.disposition_counts(conn, "c_3").unwrap(), None);
    // Block lineage is not recorded.
    assert!(matches!(
        reader.blocks_history(conn, "b_0", None).unwrap_err(),
        Error::HistoryUnsupported { ref fix, .. } if fix == "docs_history"
    ));
    assert!(matches!(
        reader.diff_blocks(conn, "d_0", "r_0", "r_2").unwrap_err(),
        Error::HistoryUnsupported { ref fix, .. } if fix == "docs_diff_unified"
    ));
}

#[test]
fn decides_a_sha_token_itself() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("sha", Composition::Git);
    fx.write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    fx.write("b.md", "# B\n", "2026-10-20T10:00:00.000Z");
    fx.enable("2026-10-20T10:01:00.000Z", Map::new()).unwrap();
    fx.write("b.md", "# B2\n", "2026-10-20T10:02:00.000Z");
    let cp = fx
        .store
        .history_checkpoint(&fx.repo, "2026-10-20T10:03:00.000Z")
        .unwrap();
    let tip = cp.tip.unwrap();
    {
        let reader = fx.store.history_reader_for(&fx.repo).unwrap().unwrap();
        let conn = fx.store.conn();
        assert!(matches!(
            reader
                .read_at_revision(conn, "d_0", &"0".repeat(40))
                .unwrap_err(),
            Error::HistoryPruned { .. }
        ));
        // The second commit touched b.md (d_1) only: asked of a.md it names no version of it.
        assert!(matches!(
            reader.read_at_revision(conn, "d_0", &tip).unwrap_err(),
            Error::TargetMissingRevision { .. }
        ));
        // A head token nobody committed: None — the core's claim table decides.
        assert!(
            reader
                .read_at_revision(conn, "d_0", "r_9")
                .unwrap()
                .is_none()
        );
    }
    fx.store
        .disable_history(&fx.repo, "2026-10-20T10:04:00.000Z")
        .unwrap();
    fx.enable("2026-10-20T10:05:00.000Z", Map::new()).unwrap();
    let fresh = fx.store.history_reader_for(&fx.repo).unwrap().unwrap();
    // 10:02 lies inside the first interval.
    assert_eq!(
        fresh
            .read_at_revision(fx.store.conn(), "d_1", &tip)
            .unwrap()
            .unwrap()
            .content,
        "# B2\n"
    );
    assert_eq!(
        read_capability(fx.store.conn(), &fx.repo, "history")
            .unwrap()
            .unwrap()
            .coverage
            .len(),
        2
    );
}

#[test]
fn folds_under_a_debounce_cadence_records_moves_and_deletions_and_reports_checkpoints() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("debounce", Composition::Git);
    fx.write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    let opts = json!({ "cadence": { "debounce_ms": 1000 }, "branch": "notes" })
        .as_object()
        .cloned()
        .unwrap();
    fx.enable("2026-10-20T10:01:00.000Z", opts).unwrap();
    let states = omgbase_sync::capability_states(Some(&fx.store), Some(&fx.repo));
    assert_eq!(states["history"]["completeness"], "checkpoints");
    fx.write("a.md", "# A2\n", "2026-10-20T10:02:00.000Z");
    fx.write("c.md", "# C\n", "2026-10-20T10:03:00.000Z");
    fx.delete("a.md", "2026-10-20T10:04:00.000Z");
    let cp = fx
        .store
        .history_checkpoint(&fx.repo, "2026-10-20T10:05:00.000Z")
        .unwrap();
    assert_eq!((cp.committed, cp.from_seq, cp.to_seq), (1, 3, 5));
    let text = fx
        .git()
        .text(&["log", "-1", "--format=%B", "refs/heads/notes"])
        .unwrap();
    assert!(text.contains("omgbase-seq: ep_0:3-5\n"), "{text}");
    assert!(text.contains("omgbase-doc: d_0 a.md -\n"), "{text}");
    let tree = fx.git().ls_tree("refs/heads/notes").unwrap();
    assert!(
        !tree.contains("a.md") && tree.ends_with("\tc.md\n"),
        "{tree}"
    );
}

#[test]
fn closes_the_crash_gap_a_fault_at_git_commit_leaves_the_tip_and_the_replay_writes_the_same_commit()
{
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("crash", Composition::Git);
    fx.write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    fx.enable("2026-10-20T10:01:00.000Z", Map::new()).unwrap();
    let before = fx.git().tip("omgbase").unwrap();
    fx.write("a.md", "# A2\n", "2026-10-20T10:02:00.000Z");
    set_armed_fault(Some(ArmedFault {
        site: FaultSite::GitCommit,
        nth: 1,
    }));
    reset_faults();
    let err = fx
        .store
        .history_checkpoint(&fx.repo, "2026-10-20T10:03:00.000Z")
        .unwrap_err();
    assert_eq!(err.to_string(), "injected fault at git.commit (pass 1)");
    assert_eq!(fx.git().tip("omgbase").unwrap(), before);
    assert_eq!(
        read_git_cursor(fx.store.conn(), &fx.repo)
            .unwrap()
            .unwrap()
            .seq,
        2
    );
    set_armed_fault(None);
    reset_faults();
    let cp = fx
        .store
        .history_checkpoint(&fx.repo, "2026-10-20T10:03:00.000Z")
        .unwrap();
    assert_eq!(cp.committed, 1);
    // Running again: nothing to do, the cursor at the tip.
    let again = fx
        .store
        .history_checkpoint(&fx.repo, "2026-10-20T10:04:00.000Z")
        .unwrap();
    assert_eq!((again.committed, again.tip), (0, cp.tip));
}

#[test]
fn purge_removes_the_repository_the_next_checkpoint_rescans_disable_keeps_it_and_native_conflicts()
{
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("purge", Composition::Git);
    fx.write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    fx.enable("2026-10-20T10:01:00.000Z", Map::new()).unwrap();
    let dir = fx.git().git_dir().to_path_buf();
    let purged = fx
        .store
        .purge_history_at(&fx.repo, None, "2026-10-20T10:02:00.000Z")
        .unwrap();
    let p = purged.provider.unwrap();
    assert_eq!(
        (p.name.as_str(), p.removed, Path::new(&p.path)),
        ("git", true, dir.as_path())
    );
    assert!(!dir.exists());
    assert!(
        read_git_cursor(fx.store.conn(), &fx.repo)
            .unwrap()
            .is_none()
    );
    {
        let reader = fx.store.history_reader_for(&fx.repo).unwrap().unwrap();
        assert!(
            reader
                .doc_versions(fx.store.conn(), "d_0", Some("r_0"))
                .unwrap()
                .is_empty()
        );
    }
    let cp = fx
        .store
        .history_checkpoint(&fx.repo, "2026-10-20T10:03:00.000Z")
        .unwrap();
    assert!(cp.rescanned);
    assert!(
        fx.log("omgbase")
            .contains("rescan: 1 document(s)\nomgbase-seq: ep_0:2\n")
    );
    fx.store
        .disable_history(&fx.repo, "2026-10-20T10:04:00.000Z")
        .unwrap();
    assert!(dir.exists());
    assert!(
        omgbase_sync::run_provider_checkpoint(&fx.store, &fx.repo, "2026-10-20T10:04:30.000Z")
            .unwrap()
            .is_none()
    );
    // No native module on this composition.
    assert!(matches!(
        fx.store
            .enable_history(&fx.repo, "2026-10-20T10:05:00.000Z", true)
            .unwrap_err(),
        Error::HistoryUnavailable
    ));
    // On the full composition a native repository refuses `--provider git`, a git repository the native enable.
    let mut full = Fx::new("conflict", Composition::Full);
    full.write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    assert!(matches!(
        full.enable("2026-10-20T10:00:30.000Z", Map::new())
            .unwrap_err(),
        Error::HistoryProviderConflict { .. }
    ));
    full.store
        .disable_history(&full.repo, "2026-10-20T10:01:00.000Z")
        .unwrap();
    full.enable("2026-10-20T10:02:00.000Z", Map::new()).unwrap();
    let e = full
        .store
        .enable_history(&full.repo, "2026-10-20T10:03:00.000Z", true)
        .unwrap_err();
    assert_eq!(
        e.to_string(),
        "history is already enabled with the git provider — run omg history disable first, then omg history enable"
    );
    assert_eq!(
        omgbase_sync::capability_states(Some(&full.store), Some(&full.repo))["history"]["provider"],
        "git"
    );
}

#[test]
fn a_provider_that_cannot_run_is_unavailable_with_the_alert_raised_and_writes_continue() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("unavailable", Composition::Git);
    fx.write("a.md", "# A\n", "2026-10-20T10:00:00.000Z");
    fx.enable("2026-10-20T10:01:00.000Z", Map::new()).unwrap();
    // The executable goes missing (`OMGBASE_GIT_BIN` names one that does not exist; the probe is re-run).
    // SAFETY: the tests of this file run one at a time (SERIAL) and nothing else
    // in this process reads the environment meanwhile.
    unsafe { std::env::set_var(GIT_BIN_ENV, "/nonexistent/git") };
    reset_git_probe();
    let outcome = (|| {
        let err = fx.store.history_reader_for(&fx.repo).err()?;
        assert!(
            err.to_string().starts_with(
                "the git history provider is unavailable: /nonexistent/git is not on PATH (ENOENT)"
            ),
            "{err}"
        );
        let codes: Vec<String> = list_active_alerts(fx.store.conn(), &fx.repo)
            .unwrap()
            .iter()
            .map(|a| a.code.clone())
            .collect();
        assert_eq!(codes, [HISTORY_PROVIDER_UNAVAILABLE_ALERT]);
        assert_eq!(
            omgbase_sync::capability_states(Some(&fx.store), Some(&fx.repo))["history"]["state"],
            "unavailable"
        );
        fx.write("a.md", "# A2\n", "2026-10-20T10:02:00.000Z"); // the write lands
        assert!(
            omgbase_sync::run_provider_checkpoint(&fx.store, &fx.repo, "2026-10-20T10:03:00.000Z")
                .unwrap()
                .is_none()
        );
        Some(())
    })();
    unsafe { std::env::remove_var(GIT_BIN_ENV) };
    reset_git_probe();
    assert!(outcome.is_some(), "the reader must refuse");
    // The provider back: the next checkpoint clears the alert.
    fx.store
        .history_checkpoint(&fx.repo, "2026-10-20T10:04:00.000Z")
        .unwrap();
    assert!(
        list_active_alerts(fx.store.conn(), &fx.repo)
            .unwrap()
            .is_empty()
    );
}
