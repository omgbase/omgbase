//! Fault injection outside the fixture runners (modular-core Phase 5a; the
//! plan's §8 acceptance matrix — recovery, optional history; `spec/store`
//! §9.7) — the twin of the reference's `packages/core/src/fault-injection.test.ts`.
//!
//! `OMGBASE_FAULT=<site>[:<nth>]` arms one of the five named sites
//! (`omgbase_store::fault`); a write is driven through each and the matrix
//! outcome asserted: ROLLED BACK (nothing minted, the request fails, a retry
//! lands), RECOVERABLE (the rows are durable, the file is owed, `recover_repo`
//! replays it and is then a no-op), ALERT RAISED (`capture_failed`,
//! `materialization_failed`), RETRIED (the next pass clears). Every site is
//! spelled identically by the reference.
//!
//! The hook is read from the process environment, so the tests take one lock
//! and arm/disarm inside it (the counts are per process: `reset_faults`).

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use omgbase_store::doc_store::FsDocStore;
use omgbase_store::fault::{
    FAULT_ENV, FAULT_SITES, FaultSite, fault_passes, parse_fault, reset_faults,
};
use omgbase_store::{
    ApplyOrigin, ApplyRequest, ApplyResult, CAPTURE_FAILED_ALERT, Capabilities, Config, Error,
    Expect, MATERIALIZATION_FAILED_ALERT, Op, RandomMinter, Store, list_active_alerts,
};
use omgbase_sync::{RealFileSystem, RecoveryResult, ensure_repo, recover_repo};

mod common;
use common::TempDir;

const ORIGIN_ACTOR: &str = "agent:fault-test";
const SOURCE: &str = "# A\n\nBody.\n";

/// One test at a time touches `OMGBASE_FAULT` (a process-wide variable).
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn arm(spec: &str) {
    // Edition 2024: the environment is shared with every thread; the lock
    // held by every test here is what makes this sound.
    unsafe { std::env::set_var(FAULT_ENV, spec) };
    reset_faults();
}

fn disarm() {
    unsafe { std::env::remove_var(FAULT_ENV) };
    reset_faults();
}

fn is_injected(e: &Error) -> bool {
    matches!(e, Error::InjectedFault { .. })
}

/// A file-backed workspace with one observed document (`a.md`, one
/// paragraph) under the composition `OMGBASE_CAPABILITIES` names — the
/// reference's `beforeEach`.
struct Fx {
    _guard: MutexGuard<'static, ()>,
    _dir: TempDir,
    root: PathBuf,
    store: Store,
    repo: String,
    body: String,
    clock: u32,
}

impl Fx {
    fn new(tag: &str) -> Self {
        let guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        disarm();
        let dir = TempDir::new("fault", tag);
        let root = dir.path().to_path_buf();
        let mut store = Store::open_with(
            root.join(".omgbase").join("omgbase.db"),
            Box::new(RandomMinter),
            Capabilities::standard_from_env().expect("OMGBASE_CAPABILITIES"),
        )
        .expect("store opens");
        let repo = ensure_repo(&mut store, "fx", Some(&dir.path_str())).expect("ensure_repo");
        fs::write(root.join("a.md"), SOURCE).expect("write a.md");
        store
            .observe_one(
                &repo,
                "a.md",
                SOURCE,
                "2026-10-26T10:00:00.000Z",
                &Config::default(),
            )
            .expect("observe a.md");
        let body: String = store
            .conn()
            .query_row(
                "SELECT block_id FROM blocks WHERE type = 'paragraph'",
                [],
                |r| r.get(0),
            )
            .expect("the paragraph");
        Self {
            _guard: guard,
            _dir: dir,
            root,
            store,
            repo,
            body,
            clock: 0,
        }
    }

    /// A fresh, later timestamp per write.
    fn ts(&mut self) -> String {
        self.clock += 1;
        format!("2026-10-26T10:{:02}:00.000Z", self.clock)
    }

    fn count(&self, table: &str) -> i64 {
        self.store
            .conn()
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .expect("count")
    }

    /// The paragraph's current raw.
    fn raw(&self) -> String {
        self.store
            .conn()
            .query_row(
                "SELECT raw FROM blocks WHERE block_id = ?1",
                [&self.body],
                |r| r.get(0),
            )
            .expect("raw")
    }

    fn hash_of(&self) -> String {
        self.store
            .conn()
            .query_row(
                "SELECT lower(hex(raw_hash)) FROM blocks WHERE block_id = ?1",
                [&self.body],
                |r| r.get(0),
            )
            .expect("raw_hash")
    }

    fn alerts(&self) -> Vec<String> {
        list_active_alerts(self.store.conn(), &self.repo)
            .expect("alerts")
            .into_iter()
            .map(|a| a.code)
            .collect()
    }

    /// `(path, kind)` of every pending row (the reference's `listPending`).
    fn pending(&self) -> Vec<(String, String)> {
        let mut stmt = self
            .store
            .conn()
            .prepare(
                "SELECT path, kind FROM pending_materializations WHERE repo_id = ?1 ORDER BY rowid",
            )
            .expect("pending");
        let rows = stmt
            .query_map([&self.repo], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("pending rows");
        rows.collect::<Result<_, _>>().expect("pending rows")
    }

    fn file(&self) -> String {
        fs::read_to_string(self.root.join("a.md")).expect("a.md")
    }

    /// The reference's `edit`: an `update` of the paragraph under a CAS on its
    /// current content hash, through the api path with the filesystem doc store.
    fn edit(&mut self, markdown: &str) -> omgbase_store::Result<ApplyResult> {
        let req = ApplyRequest {
            repo_id: self.repo.clone(),
            ops: vec![Op::Update {
                block: self.body.clone(),
                markdown: Some(markdown.to_owned()),
                attrs: None,
                expect: Some(Expect::content(self.hash_of())),
                trivia: None,
                child_ids: None,
            }],
            origin: ApplyOrigin::new(ORIGIN_ACTOR, None),
            dry_run: false,
        };
        let ts = self.ts();
        let mut ds = FsDocStore::new(&self.root);
        self.store.apply(&req, &mut ds, &ts)
    }

    fn recover(&mut self) -> RecoveryResult {
        let ts = self.ts();
        recover_repo(
            &mut self.store,
            &self.repo,
            &RealFileSystem,
            &self.root,
            &ts,
            &Config::default(),
        )
        .expect("recover_repo")
    }

    fn materialize_pending(&mut self) -> omgbase_store::Result<Vec<String>> {
        let ts = self.ts();
        let mut ds = FsDocStore::new(&self.root);
        self.store.materialize_pending_at(&self.repo, &mut ds, &ts)
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        disarm();
    }
}

fn recovery(r: &RecoveryResult) -> (Vec<String>, Vec<String>, Vec<String>) {
    (r.materialized.clone(), r.healed.clone(), r.missing.clone())
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

// ---- the hook (OMGBASE_FAULT) ------------------------------------------------------------

#[test]
fn parses_site_and_nth_refuses_an_unknown_site_or_a_bad_count_and_is_unarmed_when_unset() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(parse_fault("").unwrap(), None);
    let armed = parse_fault("feed.append").unwrap().unwrap();
    assert_eq!((armed.site, armed.nth), (FaultSite::FeedAppend, 1));
    let armed = parse_fault("materialize.after-write:3").unwrap().unwrap();
    assert_eq!(
        (armed.site, armed.nth),
        (FaultSite::MaterializeAfterWrite, 3)
    );
    let e = parse_fault("recorder").unwrap_err().to_string();
    assert!(
        e.contains("unknown fault site \"recorder\"; the sites are recorder.capture, feed.append, commit.after-commit, materialize.before-write, materialize.after-write"),
        "{e}"
    );
    let e = parse_fault("feed.append:0").unwrap_err().to_string();
    assert!(e.contains("positive integer"), "{e}");
    assert_eq!(FAULT_SITES.len(), 5);
}

#[test]
fn the_nth_pass_throws_the_passes_before_it_do_not_and_the_message_is_pinned() {
    let mut fx = Fx::new("nth");
    arm("feed.append:2");
    let first = fx.edit("First edit.").expect("the first edit lands");
    assert!(first.committed);
    assert_eq!(fault_passes(FaultSite::FeedAppend), 1);
    let caught = fx.edit("Second edit.").expect_err("the second pass raises");
    assert!(is_injected(&caught), "{caught}");
    assert_eq!(caught.to_string(), "injected fault at feed.append (pass 2)");
    assert_eq!(fx.raw(), "First edit.");
}

// ---- feed.append — inside the commit transaction ------------------------------------------

#[test]
fn feed_append_rolls_the_whole_request_back_and_the_retry_lands() {
    let mut fx = Fx::new("feed");
    let feed = fx.count("feed");
    let claims = fx.count("id_claims");
    arm("feed.append");
    let e = fx.edit("Changed.").expect_err("the write fails");
    assert!(is_injected(&e), "{e}");
    assert_eq!(fx.count("feed"), feed);
    assert_eq!(fx.count("id_claims"), claims);
    assert_eq!(fx.raw(), "Body.");
    assert_eq!(fx.file(), SOURCE);
    assert_eq!(fx.pending(), Vec::<(String, String)>::new());
    assert_eq!(fx.alerts(), Vec::<String>::new());
    disarm();
    assert!(fx.edit("Changed.").expect("the retry lands").committed);
    assert_eq!(fx.raw(), "Changed.");
    assert_eq!(fx.file(), "# A\n\nChanged.\n");
}

// ---- recorder.capture — a recorder throw (spec/store §5.4 step 15, resolution 18) ------------

#[test]
fn recorder_capture_rolls_the_member_back_as_capture_failed_raises_the_alert_and_the_next_capture_clears_it()
 {
    let mut fx = Fx::new("recorder");
    if fx.store.history().is_none() {
        eprintln!("skipped: the composition has no recorder (OMGBASE_CAPABILITIES)");
        return;
    }
    let feed = fx.count("feed");
    arm("recorder.capture");
    let caught = fx.edit("Changed.").expect_err("the capture fails");
    match &caught {
        Error::CaptureFailed { reason, .. } => assert!(
            reason.contains("injected fault at recorder.capture (pass 1)"),
            "{reason}"
        ),
        other => panic!("expected capture_failed, got {other}"),
    }
    assert!(
        caught
            .to_string()
            .contains("injected fault at recorder.capture (pass 1)")
    );
    assert_eq!(fx.count("feed"), feed);
    assert_eq!(fx.raw(), "Body.");
    assert_eq!(fx.alerts(), vec![CAPTURE_FAILED_ALERT.to_owned()]);
    let alert = &list_active_alerts(fx.store.conn(), &fx.repo).unwrap()[0];
    let reason = alert.detail["reason"].as_str().unwrap_or_default();
    assert!(
        reason.contains("injected fault at recorder.capture"),
        "{reason}"
    );
    disarm();
    assert!(fx.edit("Changed.").expect("the retry lands").committed);
    assert_eq!(fx.alerts(), Vec::<String>::new());
    assert_eq!(fx.count("feed"), feed + 1);
}

// ---- commit.after-commit — the rows are durable, the files are owed ----------------------------

#[test]
fn commit_after_commit_fails_after_commit_the_pending_row_survives_and_recover_repo_replays_it_then_is_a_no_op()
 {
    let mut fx = Fx::new("after-commit");
    let feed = fx.count("feed");
    arm("commit.after-commit");
    let e = fx
        .edit("Changed.")
        .expect_err("the request fails after COMMIT");
    assert!(is_injected(&e), "{e}");
    assert_eq!(fx.count("feed"), feed + 1);
    assert_eq!(fx.raw(), "Changed.");
    assert_eq!(fx.file(), SOURCE);
    assert_eq!(fx.pending(), vec![("a.md".to_owned(), "write".to_owned())]);
    disarm();
    let first = fx.recover();
    assert_eq!(
        recovery(&first),
        (strings(&["a.md"]), Vec::new(), Vec::new())
    );
    assert_eq!(fx.file(), "# A\n\nChanged.\n");
    assert_eq!(fx.pending(), Vec::<(String, String)>::new());
    assert_eq!(
        recovery(&fx.recover()),
        (Vec::new(), Vec::new(), Vec::new())
    );
    assert_eq!(fx.alerts(), Vec::<String>::new());
}

// ---- materialize.before-write — the materializer fails before touching the disk ----------------

#[test]
fn materialize_before_write_on_the_api_path_keeps_the_row_and_the_replay_recovers() {
    let mut fx = Fx::new("before-write-api");
    arm("materialize.before-write");
    let e = fx.edit("Changed.").expect_err("the materializer fails");
    assert!(is_injected(&e), "{e}");
    assert_eq!(fx.raw(), "Changed.");
    assert_eq!(fx.file(), SOURCE);
    assert_eq!(fx.pending().len(), 1);
    disarm();
    assert_eq!(
        recovery(&fx.recover()),
        (strings(&["a.md"]), Vec::new(), Vec::new())
    );
    assert_eq!(fx.file(), "# A\n\nChanged.\n");
}

#[test]
fn materialize_before_write_on_the_replay_path_raises_materialization_failed_keeps_the_row_and_a_passing_replay_clears_it()
 {
    let mut fx = Fx::new("before-write-replay");
    arm("commit.after-commit");
    let e = fx
        .edit("Changed.")
        .expect_err("the request fails after COMMIT");
    assert!(is_injected(&e), "{e}");
    arm("materialize.before-write");
    let e = fx.materialize_pending().expect_err("the replay fails");
    assert!(is_injected(&e), "{e}");
    assert!(
        fx.alerts()
            .contains(&MATERIALIZATION_FAILED_ALERT.to_owned()),
        "{:?}",
        fx.alerts()
    );
    assert_eq!(fx.pending().len(), 1);
    disarm();
    assert_eq!(
        fx.materialize_pending().expect("the replay lands"),
        strings(&["a.md"])
    );
    assert_eq!(fx.alerts(), Vec::<String>::new());
    assert_eq!(fx.file(), "# A\n\nChanged.\n");
}

// ---- materialize.after-write — the file landed, its row did not go -----------------------------

#[test]
fn materialize_after_write_leaves_the_file_and_the_row_and_the_replay_clears_the_row_without_rewriting()
 {
    let mut fx = Fx::new("after-write");
    arm("materialize.after-write");
    let e = fx
        .edit("Changed.")
        .expect_err("the materializer fails after the write");
    assert!(is_injected(&e), "{e}");
    assert_eq!(fx.file(), "# A\n\nChanged.\n");
    assert_eq!(fx.pending().len(), 1);
    disarm();
    assert_eq!(
        recovery(&fx.recover()),
        (strings(&["a.md"]), Vec::new(), Vec::new())
    );
    assert_eq!(fx.pending(), Vec::<(String, String)>::new());
    assert_eq!(
        recovery(&fx.recover()),
        (Vec::new(), Vec::new(), Vec::new())
    );
}
