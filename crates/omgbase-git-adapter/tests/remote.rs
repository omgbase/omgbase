//! The remote half (`spec/store` §5.12 "The remote binding" … "Divergence",
//! 17.6; modular-core Phase 6b) end to end against a SECOND bare repository
//! under the temp dir as the remote (a local path URL — no network): the
//! binding, push and the remote's log equal to ours, fetch of a remote-side
//! commit written through the vault sink (`observe_batch` here — the source
//! boundary), the clean three-way merge, the conflict with its sidecar and
//! alert and the resolve, the rewritten remote and each of the four
//! remediations, the ids ref written and carried, the rejected push, the
//! no-op rule after a fetch, the sweep's steps 7–8. The twin of
//! `packages/git-adapter/src/remote.test.ts`; the fixture suites pin the same
//! behaviour as projections (`spec/store/cases/history/git-remote.json`,
//! `spec/surface/cases/reads.json` `git-remote`).

use std::path::PathBuf;
use std::sync::Mutex;

use omgbase_git_adapter::{
    GIT_MERGE_CONFLICT_ALERT, GIT_REMOTE_DIVERGED_ALERT, GIT_REMOTE_FORKED_ALERT,
    GitHistoryProvider, GitIdentity, GitRepo, ReconcileMode, RemoteOptions, ResolveChoice,
    fixture_identity, ids_path, parse_message, read_git_cursor, sidecar_path, ts_segment,
};
use omgbase_reconcile::Config;
use omgbase_store::{
    BatchItem, Capabilities, Composition, Error, HistoryVaultSink, PushOutcome, RemoteState,
    SequentialMinter, Store, VaultChange, list_active_alerts, provider_config_of, read_capability,
};
use serde_json::{Map, Value as Json, json};

/// The tests share process-wide state (the git probe): one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

const REMOTE_IDENTITY: (&str, &str) = ("remote", "remote@fixture");

struct Fx {
    root: PathBuf,
    remote_dir: PathBuf,
    store: Store,
    repo: String,
}

/// The vault sink bound to `observe_batch` — the source boundary.
struct Sink<'a> {
    store: &'a mut Store,
    repo: &'a str,
}

impl HistoryVaultSink for Sink<'_> {
    fn conn(&self) -> &rusqlite::Connection {
        self.store.conn()
    }

    fn apply(&mut self, changes: &[VaultChange], ts: &str) -> omgbase_store::Result<()> {
        let items: Vec<BatchItem> = changes
            .iter()
            .map(|c| BatchItem {
                path: c.path.clone(),
                source: c
                    .content
                    .as_ref()
                    .map(|b| String::from_utf8_lossy(b).into_owned()),
            })
            .collect();
        self.store
            .observe_batch(self.repo, &items, ts, &Config::default())?;
        Ok(())
    }
}

impl Fx {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "omgbase-git-remote-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(root.join(".omgbase")).unwrap();
        let remote_dir = root.join("remote.git");
        GitRepo::new(remote_dir.clone()).init("omgbase").unwrap();
        let caps =
            Capabilities::for_composition(Composition::Git, Capabilities::standard).with_provider(
                Box::new(GitHistoryProvider::new(root.clone(), fixture_identity())),
            );
        let mut store =
            Store::open_in_memory_with_capabilities(Box::new(SequentialMinter::new()), caps)
                .unwrap();
        let repo = store
            .create_repo_with("fx", "2026-10-20T10:00:00.000Z", false)
            .unwrap();
        let mut fx = Self {
            root,
            remote_dir,
            store,
            repo,
        };
        fx.write("a.md", "# A\n\nFirst.\n", "2026-10-20T10:00:00.000Z");
        fx.write("b.md", "# B\n\nOnly.\n", "2026-10-20T10:00:00.000Z");
        fx.store
            .enable_history_with(
                &fx.repo,
                "2026-10-20T10:01:00.000Z",
                true,
                Some("git"),
                &Map::new(),
            )
            .unwrap();
        fx
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

    fn provider(&self) -> GitHistoryProvider {
        GitHistoryProvider::new(self.root.clone(), fixture_identity())
    }

    fn config(&self) -> Map<String, Json> {
        provider_config_of(
            &read_capability(self.store.conn(), &self.repo, "history")
                .unwrap()
                .unwrap(),
        )
    }

    fn git(&self) -> GitRepo {
        self.provider().git_repo(&self.config())
    }

    fn remote(&self) -> GitRepo {
        GitRepo::new(self.remote_dir.clone())
    }

    fn bind(
        &self,
        extra: &[(&str, &str)],
    ) -> omgbase_store::Result<Option<omgbase_git_adapter::GitRemoteConfig>> {
        let mut opts = RemoteOptions {
            url: self.remote_dir.to_string_lossy().into_owned(),
            ..RemoteOptions::default()
        };
        for (k, v) in extra {
            match *k {
                "url" => opts.url = (*v).to_owned(),
                "name" => opts.name = Some((*v).to_owned()),
                "branch" => opts.branch = Some((*v).to_owned()),
                "push" => opts.push = Some((*v).to_owned()),
                "fetch" => opts.fetch = Some((*v).to_owned()),
                _ => unreachable!(),
            }
        }
        self.provider()
            .remote_set(
                self.store.conn(),
                &self.repo,
                &self.config(),
                &opts,
                "2026-10-20T10:01:30.000Z",
            )
            .map(|c| c.remote)
    }

    fn push(&self, ts: &str) -> omgbase_store::Result<omgbase_store::PushResult> {
        self.provider()
            .push(self.store.conn(), &self.repo, &self.config(), ts)
    }

    fn fetch(&mut self, ts: &str) -> omgbase_store::Result<omgbase_git_adapter::FetchResult> {
        let (provider, config, repo) = (self.provider(), self.config(), self.repo.clone());
        let mut sink = Sink {
            store: &mut self.store,
            repo: &repo,
        };
        provider.fetch(&repo, &config, &mut sink, ts)
    }

    fn resolve(
        &mut self,
        path: &str,
        choice: ResolveChoice,
        ts: &str,
    ) -> omgbase_store::Result<omgbase_git_adapter::ResolveResult> {
        let (provider, config, repo) = (self.provider(), self.config(), self.repo.clone());
        let mut sink = Sink {
            store: &mut self.store,
            repo: &repo,
        };
        provider.resolve(&repo, &config, &mut sink, path, choice, ts)
    }

    fn reconcile(
        &mut self,
        mode: ReconcileMode,
        ts: &str,
    ) -> omgbase_store::Result<omgbase_git_adapter::ReconcileResult> {
        let (provider, config, repo) = (self.provider(), self.config(), self.repo.clone());
        let mut sink = Sink {
            store: &mut self.store,
            repo: &repo,
        };
        provider.reconcile(&repo, &config, &mut sink, mode, ts)
    }

    fn checkpoint(&self, ts: &str) -> omgbase_store::CheckpointResult {
        self.store.history_checkpoint(&self.repo, ts).unwrap()
    }

    fn status(&self) -> omgbase_git_adapter::RemoteStatus {
        self.provider()
            .remote_status(self.store.conn(), &self.repo, &self.config())
            .unwrap()
    }

    fn alerts(&self) -> Vec<omgbase_store::Alert> {
        list_active_alerts(self.store.conn(), &self.repo).unwrap()
    }

    fn reconstruct(&self, doc: &str) -> Option<String> {
        self.store.reconstruct(doc).unwrap()
    }

    /// A commit on the REMOTE made by "someone else" under the determinism env.
    fn remote_commit(
        &self,
        files: &[(&str, Option<&str>)],
        ts: &str,
        message: &str,
        rewrite: bool,
    ) -> String {
        let r = self.remote();
        r.init("omgbase").unwrap();
        let tip = r.tip("omgbase").unwrap();
        let base = if rewrite {
            tip.as_deref()
                .and_then(|t| r.parents_of(t).unwrap().first().cloned())
        } else {
            tip
        };
        let mut adds = Vec::new();
        let mut removes = Vec::new();
        for (path, content) in files {
            match content {
                Some(c) => adds.push(((*path).to_owned(), r.write_blob(c.as_bytes()).unwrap())),
                None => removes.push((*path).to_owned()),
            }
        }
        let base_tree = base.as_deref().map(|b| r.tree_of(b).unwrap());
        let tree = r.build_tree(base_tree.as_deref(), &adds, &removes).unwrap();
        let id = GitIdentity::new(REMOTE_IDENTITY.0, REMOTE_IDENTITY.1);
        let sha = r
            .commit_tree(
                &tree,
                base.as_deref(),
                &format!("{message}\n"),
                &id,
                &id,
                ts,
            )
            .unwrap();
        r.set_ref("refs/heads/omgbase", &sha).unwrap();
        sha
    }

    fn live_paths(&self) -> Vec<String> {
        let mut stmt = self
            .store
            .conn()
            .prepare(
                "SELECT path FROM docs WHERE repo_id = ?1 AND deleted_at IS NULL ORDER BY path",
            )
            .unwrap();
        stmt.query_map([&self.repo], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn log_of(repo: &GitRepo, reference: &str) -> String {
    if repo.ref_sha(reference).unwrap().is_none() {
        return String::new();
    }
    repo.text(&[
        "log",
        "--reverse",
        "--format=%H%n%s%n%(trailers)",
        reference,
    ])
    .unwrap()
}

fn blob_text(repo: &GitRepo, commit: &str, path: &str) -> String {
    let entries = repo.tree_entries(commit).unwrap();
    String::from_utf8(repo.blob(&entries[path]).unwrap()).unwrap()
}

/// The remote rewritten after a round trip: our push, the remote's `c.md`
/// fetched (fast-forward) and pushed past, the rewrite, our local edit
/// checkpointed, the fetch that detects it. Returns `(old, rewritten, local)`.
fn diverged(fx: &mut Fx) -> (String, String, String) {
    fx.bind(&[]).unwrap();
    fx.push("2026-10-20T10:02:00.000Z").unwrap();
    let old = fx.remote_commit(
        &[("c.md", Some("# C\n\nFirst remote version.\n"))],
        "2026-10-20T10:02:30.000Z",
        "add c.md",
        false,
    );
    assert_eq!(
        fx.fetch("2026-10-20T10:03:00.000Z").unwrap().state,
        omgbase_git_adapter::FetchState::FastForward
    );
    fx.checkpoint("2026-10-20T10:03:10.000Z");
    fx.push("2026-10-20T10:03:20.000Z").unwrap();
    let rewritten = fx.remote_commit(
        &[
            ("c.md", Some("# C\n\nRewritten remote version.\n")),
            ("d.md", Some("# D\n\nAdded in the rewrite.\n")),
        ],
        "2026-10-20T10:03:30.000Z",
        "rewrite: c.md differently, d.md added",
        true,
    );
    fx.write("a.md", "# A\n\nEdited here.\n", "2026-10-20T10:04:00.000Z");
    let local = fx.checkpoint("2026-10-20T10:04:30.000Z").tip.unwrap();
    let f = fx.fetch("2026-10-20T10:05:00.000Z").unwrap();
    assert_eq!(f.state, omgbase_git_adapter::FetchState::Diverged);
    assert_eq!(f.remote_tip.as_deref(), Some(rewritten.as_str()));
    assert_eq!(f.old_remote_tip, Some(Some(old.clone())));
    (old, rewritten, local)
}

#[test]
fn the_binding_is_written_read_and_unset_and_refusals_are_the_pinned_messages() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let fx = Fx::new("binding");
    let c = fx.bind(&[]).unwrap().unwrap();
    assert_eq!(
        c.to_json(),
        json!({ "name": "origin", "url": fx.remote_dir.to_string_lossy(), "branch": "omgbase", "push": "off", "fetch": "off" })
    );
    assert_eq!(fx.config()["remote"], c.to_json());
    assert_eq!(fx.git().remotes().unwrap(), vec!["origin".to_owned()]);
    let s = fx.status();
    assert_eq!(
        (s.state, s.remote_tip, s.pushed_through),
        (RemoteState::Unknown, None, None)
    );
    assert_eq!(s.local_tip, fx.git().tip("omgbase").unwrap());
    let states = omgbase_sync::capability_states(Some(&fx.store), Some(&fx.repo));
    assert_eq!(
        states["history"]["remote"],
        json!({ "name": "origin", "branch": "omgbase", "state": "unknown", "pushed_through": null })
    );
    assert!(
        fx.bind(&[("url", "https://user:pw@example.com/x.git")])
            .unwrap_err()
            .to_string()
            .contains("credentials")
    );
    assert!(
        fx.bind(&[("push", "always")])
            .unwrap_err()
            .to_string()
            .contains("--push must be one of")
    );
    assert!(
        fx.bind(&[("name", "-x")])
            .unwrap_err()
            .to_string()
            .contains("remote name")
    );
    fx.bind(&[
        ("name", "backup"),
        ("branch", "notes"),
        ("push", "on-checkpoint"),
        ("fetch", "periodic"),
    ])
    .unwrap();
    assert_eq!(fx.git().remotes().unwrap(), vec!["backup".to_owned()]);
    assert_eq!(fx.config()["remote"]["push"], "on-checkpoint");
    fx.provider()
        .remote_unset(
            fx.store.conn(),
            &fx.repo,
            &fx.config(),
            "2026-10-20T10:02:00.000Z",
        )
        .unwrap();
    assert_eq!(fx.config()["remote"], Json::Null);
    assert!(fx.git().remotes().unwrap().is_empty());
    assert_eq!(
        omgbase_sync::capability_states(Some(&fx.store), Some(&fx.repo))["history"]["remote"],
        Json::Null
    );
    assert!(
        fx.push("2026-10-20T10:02:30.000Z")
            .unwrap_err()
            .to_string()
            .contains("no remote is bound")
    );
}

#[test]
fn push_carries_the_branch_and_the_ids_ref_and_on_checkpoint_pushes_by_itself() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("push");
    fx.bind(&[]).unwrap();
    let r = fx.push("2026-10-20T10:02:00.000Z").unwrap();
    assert_eq!(
        r.to_json(),
        json!({ "pushed": true, "tip": fx.git().tip("omgbase").unwrap(), "pushed_through": 3, "ids": "pushed" })
    );
    assert_eq!(
        log_of(&fx.remote(), "refs/heads/omgbase"),
        log_of(&fx.git(), "refs/heads/omgbase")
    );
    assert_eq!(
        fx.remote().ref_sha("refs/omgbase/ids").unwrap(),
        fx.git().ref_sha("refs/omgbase/ids").unwrap()
    );
    assert_eq!(fx.status().state, RemoteState::InSync);
    let cursor = read_git_cursor(fx.store.conn(), &fx.repo).unwrap().unwrap();
    assert_eq!(
        cursor.pushed.as_ref().map(|p| (p.tip.clone(), p.seq)),
        Some((fx.git().tip("omgbase").unwrap().unwrap(), Some(3)))
    );
    assert!(!fx.push("2026-10-20T10:02:30.000Z").unwrap().pushed);
    // `on-checkpoint`: the checkpoint pushes by itself and reports it on the receipt.
    fx.bind(&[("push", "on-checkpoint")]).unwrap();
    fx.write(
        "a.md",
        "# A\n\nFirst, edited.\n",
        "2026-10-20T10:03:00.000Z",
    );
    assert_eq!(fx.status().state, RemoteState::InSync);
    let cp = fx.checkpoint("2026-10-20T10:04:00.000Z");
    assert_eq!(cp.committed, 1);
    assert_eq!(
        cp.push.as_ref().map(PushOutcome::to_json),
        Some(json!({ "pushed": true, "tip": cp.tip, "pushed_through": 4, "ids": "pushed" }))
    );
    assert_eq!(
        log_of(&fx.remote(), "refs/heads/omgbase"),
        log_of(&fx.git(), "refs/heads/omgbase")
    );
    // A fresh clone of both refs lists the id map of a document.
    let shown = fx
        .remote()
        .text(&["show", &format!("refs/omgbase/ids:{}", ids_path("d_0"))])
        .unwrap();
    let map: Json = serde_json::from_str(&shown).unwrap();
    assert_eq!(map["doc"], "d_0");
    assert_eq!(map["head"], "r_2");
    let blocks: Vec<(String, Json, i64)> = map["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b["id"].as_str().unwrap().to_owned(),
                b["parent"].clone(),
                b["ordinal"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        blocks,
        vec![
            ("b_0".to_owned(), Json::Null, 0),
            ("b_4".to_owned(), Json::Null, 1)
        ]
    );
    assert!(
        shown.starts_with("{\"blocks\":[{\"hash\":\"")
            && shown.ends_with("}],\"doc\":\"d_0\",\"head\":\"r_2\"}\n")
    );
    let ids_log = log_of(&fx.git(), "refs/omgbase/ids");
    assert!(ids_log.contains("ids: 2 document(s)\nomgbase-seq: ep_0:3\n"));
    assert!(ids_log.contains(&format!("omgbase-content: {}\n", cp.tip.unwrap())));
}

#[test]
fn a_rejected_push_raises_git_remote_diverged_and_a_fetch_merges_it_away() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("rejected");
    fx.bind(&[]).unwrap();
    fx.push("2026-10-20T10:02:00.000Z").unwrap();
    fx.remote_commit(
        &[("c.md", Some("# C\n\nFrom the remote.\n"))],
        "2026-10-20T10:02:30.000Z",
        "remote edit",
        false,
    );
    fx.write(
        "a.md",
        "# A\n\nFirst, edited.\n",
        "2026-10-20T10:03:00.000Z",
    );
    fx.checkpoint("2026-10-20T10:03:30.000Z");
    let err = fx.push("2026-10-20T10:04:00.000Z").unwrap_err();
    let Error::GitRemoteDiverged { message, data } = &err else {
        panic!("{err}");
    };
    assert!(
        message.contains("was rejected: the remote is at "),
        "{message}"
    );
    assert_eq!(
        Json::Object(data.clone()),
        json!({ "remote": "origin", "branch": "omgbase", "local_tip": fx.git().tip("omgbase").unwrap(), "remote_tip": fx.remote().tip("omgbase").unwrap() })
    );
    let a = fx.alerts();
    assert_eq!(
        a.iter()
            .map(|x| (x.code.as_str(), x.severity.as_str()))
            .collect::<Vec<_>>(),
        vec![(GIT_REMOTE_DIVERGED_ALERT, "warning")]
    );
    assert_eq!(fx.status().state, RemoteState::Diverged);
    // Not paused: fetch merges the remote's commit, then the push lands and the alert is gone.
    let f = fx.fetch("2026-10-20T10:05:00.000Z").unwrap();
    assert_eq!(f.state, omgbase_git_adapter::FetchState::Merged);
    assert_eq!(f.applied, vec!["c.md".to_owned()]);
    assert!(fx.alerts().is_empty());
    assert!(fx.push("2026-10-20T10:06:00.000Z").unwrap().pushed);
    assert_eq!(
        log_of(&fx.remote(), "refs/heads/omgbase"),
        log_of(&fx.git(), "refs/heads/omgbase")
    );
}

#[test]
fn fetch_fast_forwards_through_the_sink_and_the_worker_then_commits_nothing() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("ff");
    fx.bind(&[]).unwrap();
    fx.push("2026-10-20T10:02:00.000Z").unwrap();
    let rc = fx.remote_commit(
        &[
            ("a.md", Some("# A\n\nEdited on the remote.\n")),
            ("c.md", Some("# C\n\nNew on the remote.\n")),
        ],
        "2026-10-20T10:02:30.000Z",
        "remote edit",
        false,
    );
    let f = fx.fetch("2026-10-20T10:03:00.000Z").unwrap();
    assert_eq!(
        f.to_json(),
        json!({ "state": "fast-forward", "remote_tip": rc, "tip": rc, "applied": ["a.md", "c.md"], "conflicts": [] })
    );
    assert_eq!(
        fx.git().tip("omgbase").unwrap().as_deref(),
        Some(rc.as_str())
    );
    assert_eq!(
        fx.reconstruct("d_0").as_deref(),
        Some("# A\n\nEdited on the remote.\n")
    );
    assert_eq!(fx.live_paths(), vec!["a.md", "b.md", "c.md"]);
    assert_eq!(
        read_git_cursor(fx.store.conn(), &fx.repo)
            .unwrap()
            .unwrap()
            .tip,
        rc
    );
    let cp = fx.checkpoint("2026-10-20T10:04:00.000Z");
    assert_eq!(
        (
            cp.committed,
            cp.from_seq,
            cp.to_seq,
            cp.tip.as_deref(),
            cp.rescanned
        ),
        (0, 4, 5, Some(rc.as_str()), false)
    );
    assert_eq!(
        read_git_cursor(fx.store.conn(), &fx.repo)
            .unwrap()
            .unwrap()
            .seq,
        5
    );
    let ids = fx.git().tree_entries("refs/omgbase/ids").unwrap();
    assert_eq!(
        ids.keys().cloned().collect::<Vec<_>>(),
        vec![ids_path("d_0"), ids_path("d_1"), ids_path("d_2")]
    );
    let ids_tip = fx.git().ref_sha("refs/omgbase/ids").unwrap().unwrap();
    let t = parse_message(&fx.git().message(&ids_tip).unwrap()).unwrap();
    assert_eq!((t.content.as_deref(), t.to), (Some(rc.as_str()), 5));
    assert_eq!(fx.status().state, RemoteState::InSync);
    assert_eq!(fx.checkpoint("2026-10-20T10:05:00.000Z").committed, 0);
    assert_eq!(
        fx.fetch("2026-10-20T10:06:00.000Z").unwrap().state,
        omgbase_git_adapter::FetchState::Nothing
    );
}

#[test]
fn fetch_merges_when_both_sides_moved_and_the_same_blob_is_no_conflict() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("merge");
    fx.bind(&[]).unwrap();
    fx.push("2026-10-20T10:02:00.000Z").unwrap();
    let rc = fx.remote_commit(
        &[
            ("c.md", Some("# C\n\nFrom the remote.\n")),
            ("b.md", Some("# B\n\nSame edit.\n")),
        ],
        "2026-10-20T10:02:30.000Z",
        "remote edit",
        false,
    );
    fx.write("a.md", "# A\n\nEdited here.\n", "2026-10-20T10:03:00.000Z");
    fx.write("b.md", "# B\n\nSame edit.\n", "2026-10-20T10:03:10.000Z");
    let before = fx.checkpoint("2026-10-20T10:03:30.000Z").tip.unwrap();
    let f = fx.fetch("2026-10-20T10:04:00.000Z").unwrap();
    assert_eq!(f.state, omgbase_git_adapter::FetchState::Merged);
    assert_eq!(f.applied, vec!["c.md".to_owned()]);
    let merged = fx.git().tip("omgbase").unwrap().unwrap();
    assert_eq!(f.tip.as_deref(), Some(merged.as_str()));
    assert_eq!(
        fx.git().parents_of(&merged).unwrap(),
        vec![before, rc.clone()]
    );
    let message = fx.git().message(&merged).unwrap();
    assert!(message.starts_with("merge origin/omgbase\n\n"));
    assert_eq!(
        parse_message(&message).unwrap().merge.as_deref(),
        Some(rc.as_str())
    );
    assert_eq!(fx.git().tree_entries(&merged).unwrap().len(), 3);
    assert_eq!(
        fx.reconstruct("d_1").as_deref(),
        Some("# B\n\nSame edit.\n")
    );
    assert_eq!(fx.status().state, RemoteState::Ahead);
    assert_eq!(fx.checkpoint("2026-10-20T10:05:00.000Z").committed, 0);
    assert!(fx.push("2026-10-20T10:06:00.000Z").unwrap().pushed);
    assert_eq!(
        fx.remote().tip("omgbase").unwrap().as_deref(),
        Some(merged.as_str())
    );
}

#[test]
fn a_conflict_keeps_both_versions_until_resolve_completes_the_merge() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("conflict");
    fx.bind(&[]).unwrap();
    fx.push("2026-10-20T10:02:00.000Z").unwrap();
    let rc = fx.remote_commit(
        &[("a.md", Some("# A\n\nTheirs.\n"))],
        "2026-10-20T10:02:30.000Z",
        "remote edit",
        false,
    );
    fx.write("a.md", "# A\n\nOurs.\n", "2026-10-20T10:03:00.000Z");
    let ours = fx.checkpoint("2026-10-20T10:03:30.000Z").tip.unwrap();
    let f = fx.fetch("2026-10-20T10:04:00.000Z").unwrap();
    let side = sidecar_path("a.md", "remote", &rc);
    assert_eq!(side, format!("a.remote-{}.md", &rc[..7]));
    assert_eq!(
        f.to_json(),
        json!({ "state": "conflict", "remote_tip": rc, "tip": ours, "applied": [side], "conflicts": ["a.md"] })
    );
    assert_eq!(fx.reconstruct("d_0").as_deref(), Some("# A\n\nOurs.\n"));
    assert_eq!(
        fx.live_paths(),
        vec!["a.md".to_owned(), side.clone(), "b.md".to_owned()]
    );
    let a = fx.alerts();
    assert_eq!(
        a.iter().map(|x| x.code.as_str()).collect::<Vec<_>>(),
        vec![GIT_MERGE_CONFLICT_ALERT]
    );
    assert_eq!(
        Json::Object(a[0].detail.clone()),
        json!({ "base": fx.git().merge_base(&ours, &rc).unwrap(), "branch": "omgbase", "paths": ["a.md"], "remote": "origin", "remote_tip": rc })
    );
    assert_eq!(
        a[0].message,
        format!(
            "the merge of origin/omgbase at {rc} left 1 conflict(s): a.md — both versions are in the vault; settle each with omg history remote resolve <path> --ours|--theirs"
        )
    );
    assert_eq!(
        fx.git().tip("omgbase").unwrap().as_deref(),
        Some(ours.as_str())
    );
    assert!(matches!(
        fx.fetch("2026-10-20T10:04:30.000Z").unwrap_err(),
        Error::GitMergeConflict { .. }
    ));
    assert!(matches!(
        fx.push("2026-10-20T10:04:40.000Z").unwrap_err(),
        Error::GitMergeConflict { .. }
    ));
    // The sidecar is a document like any other: the next checkpoint commits it.
    let cp = fx.checkpoint("2026-10-20T10:05:00.000Z");
    assert_eq!(cp.committed, 1);
    assert!(
        fx.git()
            .tree_entries(cp.tip.as_deref().unwrap())
            .unwrap()
            .contains_key(&side)
    );
    let r = fx
        .resolve("a.md", ResolveChoice::Theirs, "2026-10-20T10:06:00.000Z")
        .unwrap();
    assert!(r.remaining.is_empty());
    assert_eq!(r.merged, fx.git().tip("omgbase").unwrap());
    let merged = r.merged.clone().unwrap();
    assert_eq!(fx.git().parents_of(&merged).unwrap()[1], rc);
    assert_eq!(fx.reconstruct("d_0").as_deref(), Some("# A\n\nTheirs.\n"));
    assert!(!fx.git().tree_entries(&merged).unwrap().contains_key(&side));
    assert_eq!(blob_text(&fx.git(), &merged, "a.md"), "# A\n\nTheirs.\n");
    assert!(fx.alerts().is_empty());
    assert!(
        fx.resolve("a.md", ResolveChoice::Ours, "2026-10-20T10:06:30.000Z")
            .unwrap_err()
            .to_string()
            .contains("no merge conflict is pending")
    );
    assert!(fx.push("2026-10-20T10:07:00.000Z").unwrap().pushed);
    assert_eq!(
        fx.remote().tip("omgbase").unwrap().as_deref(),
        Some(merged.as_str())
    );
}

#[test]
fn resolve_ours_keeps_our_bytes_and_drops_the_sidecar() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("resolve-ours");
    fx.bind(&[]).unwrap();
    fx.push("2026-10-20T10:02:00.000Z").unwrap();
    let rc = fx.remote_commit(
        &[("a.md", Some("# A\n\nTheirs.\n"))],
        "2026-10-20T10:02:30.000Z",
        "remote edit",
        false,
    );
    fx.write("a.md", "# A\n\nOurs.\n", "2026-10-20T10:03:00.000Z");
    fx.checkpoint("2026-10-20T10:03:30.000Z");
    assert_eq!(
        fx.fetch("2026-10-20T10:04:00.000Z").unwrap().state,
        omgbase_git_adapter::FetchState::Conflict
    );
    let r = fx
        .resolve("a.md", ResolveChoice::Ours, "2026-10-20T10:05:00.000Z")
        .unwrap();
    let merged = r.merged.unwrap();
    assert_eq!(fx.reconstruct("d_0").as_deref(), Some("# A\n\nOurs.\n"));
    assert!(
        !fx.git()
            .tree_entries(&merged)
            .unwrap()
            .contains_key(&sidecar_path("a.md", "remote", &rc))
    );
    assert_eq!(blob_text(&fx.git(), &merged, "a.md"), "# A\n\nOurs.\n");
    assert!(fx.alerts().is_empty());
}

#[test]
fn a_rewritten_remote_is_detected_stopped_and_alerted_and_pauses_push_fetch_and_the_sweep() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("diverged");
    assert!(fx.bind(&[]).is_ok());
    assert!(
        fx.reconcile(ReconcileMode::Merge, "2026-10-20T10:01:40.000Z")
            .unwrap_err()
            .to_string()
            .contains("not diverged")
    );
    let (old, rewritten, local) = diverged(&mut fx);
    let a = fx.alerts();
    assert_eq!(
        a.iter().map(|x| x.code.as_str()).collect::<Vec<_>>(),
        vec![GIT_REMOTE_DIVERGED_ALERT]
    );
    assert_eq!(
        Json::Object(a[0].detail.clone()),
        json!({ "branch": "omgbase", "local_tip": local, "old_remote_tip": old, "remote": "origin", "remote_tip": rewritten })
    );
    assert_eq!(
        a[0].message,
        format!(
            "the remote origin/omgbase was rewritten: its tip {rewritten} does not descend from the last known {old} — push and fetch are paused while checkpoints continue locally; choose omg history remote reconcile --rebase | --merge | --adopt | --fork"
        )
    );
    assert_eq!(
        fx.git()
            .ref_sha("refs/omgbase/diverged/origin")
            .unwrap()
            .as_deref(),
        Some(old.as_str())
    );
    assert!(
        fx.push("2026-10-20T10:05:10.000Z")
            .unwrap_err()
            .to_string()
            .contains("was rewritten")
    );
    assert!(
        fx.fetch("2026-10-20T10:05:20.000Z")
            .unwrap_err()
            .to_string()
            .contains("was rewritten")
    );
    assert_eq!(fx.status().state, RemoteState::Diverged);
    // The sweep's steps 7–8 skip while the divergence stands.
    let (provider, config, repo) = (fx.provider(), fx.config(), fx.repo.clone());
    let mut sink = Sink {
        store: &mut fx.store,
        repo: &repo,
    };
    let synced = omgbase_store::HistoryProvider::remote_sync(
        &provider,
        &repo,
        &config,
        "2026-10-20T10:05:30.000Z",
        &mut sink,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        synced.to_json(),
        json!({ "pushed": null, "fetched": null, "paused": true })
    );
    // Checkpoints continue locally; the remote is never force-pushed.
    fx.write(
        "b.md",
        "# B\n\nStill writing.\n",
        "2026-10-20T10:06:00.000Z",
    );
    assert_eq!(fx.checkpoint("2026-10-20T10:06:30.000Z").committed, 1);
    assert_eq!(
        fx.remote().tip("omgbase").unwrap().as_deref(),
        Some(rewritten.as_str())
    );
}

#[test]
fn reconcile_rebase_replays_our_checkpoints_byte_for_byte_and_rebases_the_ids_ref() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("rebase");
    let (old, rewritten, local) = diverged(&mut fx);
    let ours_before = fx.git().rev_list(Some(&old), &local).unwrap();
    let messages_before: Vec<String> = ours_before
        .iter()
        .map(|c| fx.git().message(c).unwrap())
        .collect();
    let ids_before = fx.git().ref_sha("refs/omgbase/ids").unwrap().unwrap();
    let r = fx
        .reconcile(ReconcileMode::Rebase, "2026-10-20T10:07:00.000Z")
        .unwrap();
    assert_eq!(
        (r.mode, r.rewritten, r.backup.as_deref()),
        (
            ReconcileMode::Rebase,
            ours_before.len(),
            Some(local.as_str())
        )
    );
    assert_eq!(
        fx.git()
            .ref_sha(&format!(
                "refs/omgbase/backup/{}",
                ts_segment("2026-10-20T10:07:00.000Z")
            ))
            .unwrap()
            .as_deref(),
        Some(local.as_str())
    );
    assert!(r.conflicts.is_empty());
    assert_eq!(r.applied, vec!["c.md".to_owned(), "d.md".to_owned()]);
    let tip = fx.git().tip("omgbase").unwrap().unwrap();
    assert_eq!(r.tip.as_deref(), Some(tip.as_str()));
    assert!(fx.git().is_ancestor(&rewritten, &tip).unwrap());
    assert!(!fx.git().is_ancestor(&old, &tip).unwrap());
    let replayed = fx.git().rev_list(Some(&rewritten), &tip).unwrap();
    assert_eq!(replayed.len(), ours_before.len());
    let messages_after: Vec<String> = replayed
        .iter()
        .map(|c| fx.git().message(c).unwrap())
        .collect();
    assert_eq!(messages_after, messages_before);
    assert_eq!(
        blob_text(&fx.git(), &tip, "c.md"),
        "# C\n\nRewritten remote version.\n"
    );
    assert_eq!(blob_text(&fx.git(), &tip, "a.md"), "# A\n\nEdited here.\n");
    assert_eq!(
        fx.reconstruct("d_2").as_deref(),
        Some("# C\n\nRewritten remote version.\n")
    );
    assert!(fx.alerts().is_empty());
    assert!(
        fx.git()
            .ref_sha("refs/omgbase/diverged/origin")
            .unwrap()
            .is_none()
    );
    let ids_tip = fx.git().ref_sha("refs/omgbase/ids").unwrap().unwrap();
    assert_ne!(ids_tip, ids_before);
    let contents: Vec<String> = fx
        .git()
        .rev_list(None, &ids_tip)
        .unwrap()
        .iter()
        .filter_map(|c| parse_message(&fx.git().message(c).unwrap()).and_then(|t| t.content))
        .collect();
    for c in &contents {
        assert_eq!(fx.git().object_type(c).unwrap().as_deref(), Some("commit"));
    }
    assert!(contents.iter().any(|c| replayed.contains(c)));
    assert!(!contents.iter().any(|c| ours_before.contains(c)));
    assert!(fx.push("2026-10-20T10:08:00.000Z").unwrap().pushed);
    assert_eq!(
        log_of(&fx.remote(), "refs/heads/omgbase"),
        log_of(&fx.git(), "refs/heads/omgbase")
    );
    assert_eq!(fx.checkpoint("2026-10-20T10:09:00.000Z").committed, 0);
}

#[test]
fn reconcile_merge_keeps_both_histories_under_one_merge_commit() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("merge-mode");
    let (_old, rewritten, local) = diverged(&mut fx);
    let r = fx
        .reconcile(ReconcileMode::Merge, "2026-10-20T10:07:00.000Z")
        .unwrap();
    assert_eq!(
        (r.mode, r.rewritten, r.backup.as_deref()),
        (ReconcileMode::Merge, 1, Some(local.as_str()))
    );
    assert!(r.conflicts.is_empty());
    assert_eq!(r.applied, vec!["c.md".to_owned(), "d.md".to_owned()]);
    let tip = fx.git().tip("omgbase").unwrap().unwrap();
    assert_eq!(
        fx.git().parents_of(&tip).unwrap(),
        vec![local, rewritten.clone()]
    );
    assert_eq!(
        parse_message(&fx.git().message(&tip).unwrap())
            .unwrap()
            .merge
            .as_deref(),
        Some(rewritten.as_str())
    );
    assert_eq!(
        blob_text(&fx.git(), &tip, "c.md"),
        "# C\n\nRewritten remote version.\n"
    );
    assert!(fx.alerts().is_empty());
    assert!(fx.push("2026-10-20T10:08:00.000Z").unwrap().pushed);
    assert_eq!(
        fx.remote().tip("omgbase").unwrap().as_deref(),
        Some(tip.as_str())
    );
}

#[test]
fn reconcile_adopt_takes_the_remote_and_keeps_our_edits_as_local_sidecars_then_fork_pushes_aside() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut fx = Fx::new("adopt");
    let (_old, rewritten, local) = diverged(&mut fx);
    let r = fx
        .reconcile(ReconcileMode::Adopt, "2026-10-20T10:07:00.000Z")
        .unwrap();
    let side = sidecar_path("a.md", "local", &local);
    assert_eq!(
        r.to_json(),
        json!({ "mode": "adopt", "tip": rewritten, "backup": local, "rewritten": 0, "fork": null, "applied": ["a.md", side, "c.md", "d.md"], "conflicts": ["a.md"] })
    );
    assert_eq!(
        fx.git().tip("omgbase").unwrap().as_deref(),
        Some(rewritten.as_str())
    );
    assert_eq!(fx.reconstruct("d_0").as_deref(), Some("# A\n\nFirst.\n"));
    let a = fx.alerts();
    assert_eq!(
        a.iter().map(|x| x.code.as_str()).collect::<Vec<_>>(),
        vec![GIT_MERGE_CONFLICT_ALERT]
    );
    assert_eq!(a[0].detail["holds"], json!({ "a.md": "ours" }));
    assert_eq!(a[0].detail["sidecars"], json!({ "a.md": side }));
    fx.checkpoint("2026-10-20T10:08:00.000Z");
    let r = fx
        .resolve("a.md", ResolveChoice::Ours, "2026-10-20T10:09:00.000Z")
        .unwrap();
    assert_eq!(r.merged, None);
    assert_eq!(
        fx.reconstruct("d_0").as_deref(),
        Some("# A\n\nEdited here.\n")
    );
    assert!(fx.alerts().is_empty());
    assert!(fx.push("2026-10-20T10:10:00.000Z").unwrap().pushed);

    // `--fork`, from a fresh divergence: the branch pushed aside, paused until `--adopt`.
    let mut fx = Fx::new("fork");
    let (old, rewritten, local) = diverged(&mut fx);
    let r = fx
        .reconcile(ReconcileMode::Fork, "2026-10-20T10:07:00.000Z")
        .unwrap();
    let fork = format!("omgbase-omgbase-{}", ts_segment("2026-10-20T10:07:00.000Z"));
    assert_eq!(
        r.to_json(),
        json!({ "mode": "fork", "tip": local, "backup": null, "rewritten": 0, "fork": fork, "applied": [], "conflicts": [] })
    );
    assert_eq!(
        fx.remote()
            .ref_sha(&format!("refs/heads/{fork}"))
            .unwrap()
            .as_deref(),
        Some(local.as_str())
    );
    assert_eq!(
        fx.remote().tip("omgbase").unwrap().as_deref(),
        Some(rewritten.as_str())
    );
    let a = fx.alerts();
    assert_eq!(
        a.iter().map(|x| x.code.as_str()).collect::<Vec<_>>(),
        vec![GIT_REMOTE_FORKED_ALERT]
    );
    assert_eq!(
        Json::Object(a[0].detail.clone()),
        json!({ "branch": "omgbase", "fork": fork, "local_tip": local, "old_remote_tip": old, "remote": "origin", "remote_tip": rewritten })
    );
    let err = fx.push("2026-10-20T10:08:00.000Z").unwrap_err();
    assert!(
        matches!(&err, Error::GitRemoteDiverged { message, .. } if message.contains("was pushed to origin/")),
        "{err}"
    );
    assert_eq!(
        fx.reconcile(ReconcileMode::Adopt, "2026-10-20T10:09:00.000Z")
            .unwrap()
            .tip
            .as_deref(),
        Some(rewritten.as_str())
    );
    assert!(
        fx.alerts()
            .iter()
            .all(|x| x.code == GIT_MERGE_CONFLICT_ALERT)
    );
}
