//! The workspace writer lock at the CLI's two local boundaries (`spec/sync`
//! §7): a write verb's tool call (`Cli::call_with`) and the checkpoint
//! ingests — the pre-verb freshness sweep (`Cli::freshness`) and the
//! one-shot `sync`. A local write verb takes `writer.lock` for its call and
//! releases it; a read verb's own call never touches it (`--stale`, or a
//! live watch lease, skips the sweep); `--server` locks nothing locally (the
//! engine behind the server locks its own workspace); a lock a live process
//! holds makes a write verb — or a sweep — fail with the reference's
//! `WriterLockTimeout`, rendered as the catch-all engine error — under the
//! `OMGBASE_WRITER_LOCK_TIMEOUT_MS` seam, so the suite never sits out the
//! 5 s wait.
//!
//! Each test bootstraps a workspace with the Rust engine (`ensure_repo` with
//! an `fs` root, one local `sync`) and drives the built binary.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use omgbase_sync::{Workspace, WriterLock};

mod common;
use common::TempDir;

const OMGBASE: &str = env!("CARGO_BIN_EXE_omgbase");
/// One process run must finish within this (a `--server` run starts a
/// second `omgbase` inside it).
const RUN_TIMEOUT: Duration = Duration::from_secs(60);
/// The seam's wait: long enough to poll a few times, short enough to prove
/// the write failed by the timeout and not by the 5 s default.
const LOCK_TIMEOUT_MS: &str = "150";
const SEAM: (&str, &str) = ("OMGBASE_WRITER_LOCK_TIMEOUT_MS", LOCK_TIMEOUT_MS);

const NOTE: &str = "---\nstatus: active\n---\n# Notes\n\nHello.\n";

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// Run the binary to completion (killed past [`RUN_TIMEOUT`]) with the
/// workspace and seam variables cleared unless `env` sets them.
fn run(args: &[&str], env: &[(&str, &str)], cwd: &Path) -> Output {
    let mut cmd = Command::new(OMGBASE);
    cmd.args(args)
        .env_remove("OMGBASE_WORKSPACE")
        .env_remove("OMGBASE_FS_ADAPTER")
        .env_remove("OMGBASE_SPEC_MINTER")
        .env_remove("OMGBASE_SPEC_CLOCK")
        .env_remove("OMGBASE_WRITER_LOCK_TIMEOUT_MS")
        .env("NO_COLOR", "1")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn omgbase");
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_t = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stdout.read_to_end(&mut b);
        b
    });
    let err_t = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + RUN_TIMEOUT;
    let status = loop {
        match child.try_wait().expect("wait") {
            Some(s) => break s,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            None => {
                let _ = child.kill();
                let s = child.wait().expect("wait");
                eprintln!("omgbase {args:?} did not finish within {RUN_TIMEOUT:?}; killed");
                break s;
            }
        }
    };
    Output {
        status,
        stdout: out_t.join().unwrap(),
        stderr: err_t.join().unwrap(),
    }
}

/// A workspace whose repo `notes` is rooted at the directory itself, with
/// `notes.md` written and ingested (one local `sync`).
fn workspace(w: &TempDir) {
    fs::write(w.path().join("notes.md"), NOTE).unwrap();
    let mut ws = Workspace::open(w.path()).expect("open workspace");
    omgbase_sync::ensure_repo(ws.store_mut(), "notes", Some(&w.path_str())).expect("ensure_repo");
    ws.close().expect("close");
    let out = run(&["-C", &w.path_str(), "sync"], &[], w.path());
    assert!(
        out.status.success(),
        "bootstrap sync: {}",
        text(&out.stderr)
    );
    assert!(
        WriterLock::is_free(&omgbase_dir(w)),
        "a fresh workspace has no writer"
    );
}

fn omgbase_dir(w: &TempDir) -> std::path::PathBuf {
    w.path().join(".omgbase")
}

/// Hold the workspace's writer lock as this (live) process: the record the
/// lock protocol writes, with our pid. Returns the bytes written so a test
/// can prove the file was neither stolen nor rewritten.
fn hold_lock(w: &TempDir) -> String {
    let record = format!("{{\"pid\":{},\"ts\":0}}", std::process::id());
    fs::write(WriterLock::path_in(&omgbase_dir(w)), &record).unwrap();
    assert!(!WriterLock::is_free(&omgbase_dir(w)));
    record
}

fn lock_file(w: &TempDir) -> Option<String> {
    fs::read_to_string(WriterLock::path_in(&omgbase_dir(w))).ok()
}

fn note_on_disk(w: &TempDir) -> String {
    fs::read_to_string(w.path().join("notes.md")).unwrap()
}

// ---- the local seam -----------------------------------------------------------------

#[test]
fn a_local_write_verb_takes_and_releases_the_writer_lock() {
    let w = TempDir::new("writer-lock", "local");
    workspace(&w);
    let root = w.path_str();

    // `meta` (docs_set_meta) commits and writes the file; the lock is gone afterwards.
    let out = run(
        &["-C", &root, "meta", "notes.md", "--set", "status=done"],
        &[],
        w.path(),
    );
    assert!(out.status.success(), "meta: {}", text(&out.stderr));
    assert!(
        note_on_disk(&w).contains("status: done"),
        "the write landed"
    );
    assert!(
        !WriterLock::path_in(&omgbase_dir(&w)).exists(),
        "writer.lock is released (unlinked) after the call"
    );
    assert!(WriterLock::is_free(&omgbase_dir(&w)));

    // So is `new` (docs_create), and a `--dry-run` write (which locks too).
    let out = run(&["-C", &root, "new", "b.md", "-m", "# B\n"], &[], w.path());
    assert!(out.status.success(), "new: {}", text(&out.stderr));
    assert!(!WriterLock::path_in(&omgbase_dir(&w)).exists());
    let out = run(
        &[
            "-C",
            &root,
            "--dry-run",
            "meta",
            "notes.md",
            "--set",
            "status=again",
        ],
        &[],
        w.path(),
    );
    assert!(
        out.status.success(),
        "meta --dry-run: {}",
        text(&out.stderr)
    );
    assert!(!WriterLock::path_in(&omgbase_dir(&w)).exists());
    assert!(
        note_on_disk(&w).contains("status: done"),
        "a dry run committed nothing"
    );
}

/// A read verb's own tool call never locks: with the pre-verb sweep skipped
/// (`--stale`), reads go through a held lock untouched. (Without `--stale`
/// the sweep — a checkpoint ingest — is what contends; see
/// [`a_held_lock_contends_the_pre_verb_sweep_and_the_one_shot_sync`].)
#[test]
fn a_read_verb_never_touches_a_held_lock() {
    let w = TempDir::new("writer-lock", "read");
    workspace(&w);
    let root = w.path_str();
    let record = hold_lock(&w);

    // Under the short wait, so a read that *did* lock would fail fast and loudly.
    let started = Instant::now();
    let out = run(&["-C", &root, "--stale", "ls"], &[SEAM], w.path());
    assert!(
        out.status.success(),
        "ls --stale with the lock held: {}",
        text(&out.stderr)
    );
    assert!(
        text(&out.stdout).contains("notes.md"),
        "{}",
        text(&out.stdout)
    );
    assert!(started.elapsed() < Duration::from_secs(20));
    let out = run(
        &["-C", &root, "--stale", "--json", "cat", "notes.md"],
        &[SEAM],
        w.path(),
    );
    assert!(out.status.success(), "cat --stale: {}", text(&out.stderr));
    assert_eq!(
        lock_file(&w).as_deref(),
        Some(record.as_str()),
        "the held lock is untouched by reads"
    );
}

#[test]
fn a_held_lock_fails_a_write_verb_with_the_timeout_error() {
    let w = TempDir::new("writer-lock", "held");
    workspace(&w);
    let root = w.path_str();
    let record = hold_lock(&w);
    let pid = std::process::id();
    let lock_path = WriterLock::path_in(&omgbase_dir(&w));

    // Human rendering: the catch-all engine error (`spec/surface` §9), exit 1,
    // naming the holder — within the seam's wait, not the 5 s default.
    let started = Instant::now();
    let out = run(
        &["-C", &root, "meta", "notes.md", "--set", "status=done"],
        &[SEAM],
        w.path(),
    );
    let elapsed = started.elapsed();
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    let err = text(&out.stderr);
    assert!(
        err.contains(&format!(
            "error[repo_not_found]: could not acquire writer lock {} (held by pid {pid})",
            lock_path.display()
        )),
        "stderr: {err}"
    );
    assert!(text(&out.stdout).is_empty(), "nothing on stdout");
    // The default wait is 5 s; anything clearly under it proves the seam took
    // effect. The slack over the 150 ms seam is for a debug binary spawning
    // under load (the full test battery runs beside this one).
    assert!(
        elapsed < Duration::from_millis(4500),
        "the seam shortened the wait ({elapsed:?})"
    );
    assert!(
        elapsed >= Duration::from_millis(150),
        "it did wait ({elapsed:?})"
    );
    assert!(
        note_on_disk(&w).contains("status: active"),
        "nothing was written"
    );
    assert_eq!(
        lock_file(&w).as_deref(),
        Some(record.as_str()),
        "a live holder's lock is neither stolen nor removed"
    );

    // Machine rendering: the error object on stderr.
    let out = run(
        &[
            "-C",
            &root,
            "--json",
            "meta",
            "notes.md",
            "--set",
            "status=done",
        ],
        &[SEAM],
        w.path(),
    );
    assert_eq!(out.status.code(), Some(1));
    let obj: serde_json::Value = serde_json::from_str(text(&out.stderr).trim())
        .unwrap_or_else(|e| panic!("stderr is one JSON object ({e}): {}", text(&out.stderr)));
    assert_eq!(obj["error"], "repo_not_found");
    assert!(
        obj["message"]
            .as_str()
            .unwrap()
            .starts_with("could not acquire writer lock "),
        "{obj}"
    );
    assert_eq!(obj["retriable"], false);

    // A dry run is a write tool too (`Surface::is_write_tool`): same failure.
    let out = run(
        &["-C", &root, "--dry-run", "rm", "--doc", "notes.md"],
        &[SEAM],
        w.path(),
    );
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    assert!(text(&out.stderr).contains("could not acquire writer lock"));

    // With the pre-verb sweep skipped (`--stale`) the verb's own boundary is
    // the one that contends: the write tool's lock, not the sweep's.
    let out = run(
        &[
            "-C",
            &root,
            "--stale",
            "meta",
            "notes.md",
            "--set",
            "status=done",
        ],
        &[SEAM],
        w.path(),
    );
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains(&format!(
            "could not acquire writer lock {} (held by pid {pid})",
            lock_path.display()
        )),
        "{}",
        text(&out.stderr)
    );
    assert!(note_on_disk(&w).contains("status: active"));

    // Released by its holder, the next write goes through and leaves no lock.
    fs::remove_file(&lock_path).unwrap();
    let out = run(
        &["-C", &root, "meta", "notes.md", "--set", "status=done"],
        &[SEAM],
        w.path(),
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(note_on_disk(&w).contains("status: done"));
    assert!(!lock_path.exists());
}

/// The checkpoint ingests lock too (`spec/sync` §7): a read verb whose
/// pre-verb sweep has a changed file to ingest contends with a held lock
/// and fails before its verb; the same read with `--stale` (no sweep)
/// succeeds; the one-shot `sync` contends the same way. The sweep's lock is
/// released before a verb runs — proven by a write verb over a changed file
/// with the lock free: sweep, then the verb's own lock, no deadlock.
#[test]
fn a_held_lock_contends_the_pre_verb_sweep_and_the_one_shot_sync() {
    let w = TempDir::new("writer-lock", "sweep");
    workspace(&w);
    let root = w.path_str();
    let lock_path = WriterLock::path_in(&omgbase_dir(&w));
    let pid = std::process::id();
    let lock_error = format!(
        "error[repo_not_found]: could not acquire writer lock {} (held by pid {pid})",
        lock_path.display()
    );

    // A change on disk the next sweep must ingest.
    fs::write(
        w.path().join("notes.md"),
        format!(
            "{NOTE}
Changed.
"
        ),
    )
    .unwrap();
    let record = hold_lock(&w);

    // `ls` sweeps first: the sweep contends, the verb never runs.
    let started = Instant::now();
    let out = run(&["-C", &root, "ls"], &[SEAM], w.path());
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains(&lock_error),
        "{}",
        text(&out.stderr)
    );
    assert!(text(&out.stdout).is_empty(), "nothing listed");
    assert!(
        started.elapsed() < Duration::from_millis(4500),
        "the seam shortened the sweep's wait ({:?})",
        started.elapsed()
    );

    // `--stale` skips the sweep: the read goes through, over the stale row.
    let out = run(&["-C", &root, "--stale", "ls"], &[SEAM], w.path());
    assert!(out.status.success(), "ls --stale: {}", text(&out.stderr));
    assert!(text(&out.stdout).contains("notes.md"));
    let out = run(
        &["-C", &root, "--stale", "cat", "notes.md"],
        &[SEAM],
        w.path(),
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(
        !text(&out.stdout).contains("Changed."),
        "nothing was ingested under the held lock: {}",
        text(&out.stdout)
    );

    // The one-shot `sync` is the same sweep, explicit: it contends too.
    let out = run(&["-C", &root, "sync"], &[SEAM], w.path());
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains(&lock_error),
        "{}",
        text(&out.stderr)
    );
    let out = run(&["-C", &root, "--json", "sync"], &[SEAM], w.path());
    assert_eq!(out.status.code(), Some(1));
    let obj: serde_json::Value = serde_json::from_str(text(&out.stderr).trim()).unwrap();
    assert_eq!(obj["error"], "repo_not_found");
    assert_eq!(
        lock_file(&w).as_deref(),
        Some(record.as_str()),
        "the live holder's lock survives every contender"
    );

    // Released: a write verb over the changed file sweeps (locked), releases,
    // then locks again for its own write — sequentially, within the seam's
    // wait (a nested acquire would time out here).
    fs::remove_file(&lock_path).unwrap();
    let out = run(
        &["-C", &root, "meta", "notes.md", "--set", "status=done"],
        &[SEAM],
        w.path(),
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(!lock_path.exists(), "released after the verb");
    let out = run(
        &["-C", &root, "--stale", "cat", "notes.md"],
        &[SEAM],
        w.path(),
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    let cat = text(&out.stdout);
    assert!(
        cat.contains("Changed.") && cat.contains("status: done"),
        "the sweep ingested the change and the verb wrote: {cat}"
    );
    let out = run(&["-C", &root, "--json", "sync"], &[SEAM], w.path());
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(!lock_path.exists(), "the one-shot sync released its lock");
}

#[test]
fn the_timeout_seam_rejects_a_non_number() {
    let w = TempDir::new("writer-lock", "seam");
    workspace(&w);
    let out = run(
        &["-C", &w.path_str(), "ls"],
        &[("OMGBASE_WRITER_LOCK_TIMEOUT_MS", "soon")],
        w.path(),
    );
    assert_eq!(out.status.code(), Some(2), "{}", text(&out.stderr));
    assert!(
        text(&out.stderr).starts_with(
            "usage: OMGBASE_WRITER_LOCK_TIMEOUT_MS=\"soon\": not a number of milliseconds"
        ),
        "{}",
        text(&out.stderr)
    );
}

// ---- `--server` -----------------------------------------------------------------------

/// The CLI run against a remote engine locks nothing locally: with the
/// *local* workspace's lock held (and the short wait), a write verb aimed at
/// a server over another workspace succeeds, and the server took that
/// workspace's lock for its write (released afterwards).
#[test]
fn server_mode_does_not_lock_the_local_workspace() {
    let served = TempDir::new("writer-lock", "served");
    workspace(&served);
    let local = TempDir::new("writer-lock", "local-held");
    workspace(&local);
    let record = hold_lock(&local);

    let server = format!("{OMGBASE} mcp -C {} --no-watch", served.path_str());
    let out = run(
        &[
            "-C",
            &local.path_str(),
            "--server",
            &server,
            "meta",
            "notes.md",
            "--set",
            "status=done",
        ],
        &[SEAM],
        local.path(),
    );
    assert!(
        out.status.success(),
        "meta --server with the local lock held: {}",
        text(&out.stderr)
    );
    assert!(
        note_on_disk(&served).contains("status: done"),
        "the served workspace took the write"
    );
    assert!(
        note_on_disk(&local).contains("status: active"),
        "the local workspace was not touched"
    );
    assert_eq!(
        lock_file(&local).as_deref(),
        Some(record.as_str()),
        "the local lock was never contended"
    );
    assert!(
        !WriterLock::path_in(&omgbase_dir(&served)).exists(),
        "the server released its own lock"
    );

    // And the server's lock boundary is the one that bites remotely: hold the
    // served workspace's lock and the same remote write fails with the
    // engine's timeout error, rendered like any remote tool error.
    hold_lock(&served);
    let out = run(
        &[
            "-C",
            &local.path_str(),
            "--server",
            &server,
            "meta",
            "notes.md",
            "--set",
            "status=later",
        ],
        &[SEAM],
        local.path(),
    );
    assert_eq!(out.status.code(), Some(1), "{}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains("error[repo_not_found]: could not acquire writer lock"),
        "{}",
        text(&out.stderr)
    );
    assert!(note_on_disk(&served).contains("status: done"));
}
