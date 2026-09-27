//! `--server` and the live modes of `sync` as processes (`spec/cli` §2.3,
//! §6 `sync`; both unpinned by the fixtures because they need a second
//! process): the Rust binary reaching the **reference** `omg mcp` over
//! stdio as its `--server` engine, and the reference `omg --server` reaching
//! `omgbase mcp` — each remote rendering compared with the same verb run
//! locally on the same workspace. Plus `sync --server` (the coordinator over
//! the MCP client, the `fs` adapter as source) mirroring a directory into
//! the reference engine, `sync --server --watch` and the local
//! `sync --watch`, each ended by `SIGTERM`.
//!
//! The reference peer is `$OMGBASE_TS_MCP` (an `omg` command line) or
//! `node <repo>/packages/cli/dist/src/main.js`; the tests that need it skip
//! with a message when neither exists (build it with `pnpm build`). The
//! live tests also need the `fs` adapter: `$OMGBASE_FS_ADAPTER`, else
//! `node <repo>/packages/fs-adapter/dist/src/bin.js`.

use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use omgbase_sync::Workspace;

mod common;
use common::TempDir;

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const TS_MAIN: &str = "packages/cli/dist/src/main.js";
const ADAPTER_BIN: &str = "packages/fs-adapter/dist/src/bin.js";
const OMGBASE: &str = env!("CARGO_BIN_EXE_omgbase");
/// One process run (a node peer starts inside it) must finish within this.
const RUN_TIMEOUT: Duration = Duration::from_secs(90);
/// A live process must print the line a step waits for within this.
const LIVE_TIMEOUT: Duration = Duration::from_secs(45);
const EXIT_GRACE: Duration = Duration::from_secs(20);

// ---- peers and fixtures ----------------------------------------------------------------

/// The reference `omg` command line, when it is built.
fn ts_omg() -> Option<Vec<String>> {
    if let Some(cmd) = std::env::var("OMGBASE_TS_MCP")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        return Some(cmd.split_whitespace().map(str::to_owned).collect());
    }
    let main = Path::new(REPO_ROOT).join(TS_MAIN);
    main.is_file()
        .then(|| vec!["node".to_owned(), main.to_string_lossy().into_owned()])
}

/// The `fs` adapter command line, when one is available.
fn fs_adapter() -> Option<String> {
    if let Some(cmd) = std::env::var("OMGBASE_FS_ADAPTER")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        return Some(cmd);
    }
    let bin = Path::new(REPO_ROOT).join(ADAPTER_BIN);
    bin.is_file().then(|| format!("node {}", bin.display()))
}

fn skip(what: &str) {
    eprintln!("skipping: {what}");
}

/// A workspace whose repo `notes` is rooted at the directory itself, with
/// `files` written and ingested (one local `sync`).
fn workspace(w: &TempDir, files: &[(&str, &str)]) {
    for (p, c) in files {
        let f = w.path().join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, c).unwrap();
    }
    let mut ws = Workspace::open(w.path()).expect("open workspace");
    omgbase_sync::ensure_repo(ws.store_mut(), "notes", Some(&w.path_str())).expect("ensure_repo");
    ws.close().expect("close");
    let out = run(OMGBASE, &["-C", &w.path_str(), "sync"], &[], w.path());
    assert!(
        out.status.success(),
        "bootstrap sync: {}",
        text(&out.stderr)
    );
}

/// The `--server` value that spawns the reference over `w`.
fn ts_server(omg: &[String], w: &TempDir) -> String {
    format!("{} mcp -C {} --no-watch", omg.join(" "), w.path_str())
}

// ---- running processes -------------------------------------------------------------------

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// The human `ls` row ends in a relative time (`3s ago`); two runs a second
/// apart must still compare equal, so its digits are blanked.
fn blank_ago(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for line in s.split_inclusive('\n') {
        match line.rfind(" ago") {
            Some(end) => {
                let head = &line[..end];
                let start = head
                    .rfind(|c: char| !c.is_ascii_digit() && !matches!(c, 's' | 'm' | 'h' | 'd'))
                    .map_or(0, |i| i + 1);
                out.push_str(&head[..start]);
                out.push('N');
                out.push_str(&line[end..]);
            }
            None => out.push_str(line),
        }
    }
    out
}

/// Run `program args…` to completion (killed past [`RUN_TIMEOUT`]), with
/// the seams and adapter variables cleared unless `env` sets them.
fn run(program: &str, args: &[&str], env: &[(&str, &str)], cwd: &Path) -> Output {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_remove("OMGBASE_WORKSPACE")
        .env_remove("OMGBASE_FS_ADAPTER")
        .env_remove("OMGBASE_SPEC_MINTER")
        .env_remove("OMGBASE_SPEC_CLOCK")
        .env("NO_COLOR", "1")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn");
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
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            None => {
                let _ = child.kill();
                let s = child.wait().expect("wait");
                eprintln!("{program} {args:?} did not finish within {RUN_TIMEOUT:?}; killed");
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

/// A long-running `omgbase`/`omg` whose stderr is followed line by line.
struct Live {
    child: Child,
    lines: Receiver<String>,
    seen: Vec<String>,
}

impl Live {
    fn spawn(program: &str, args: &[&str], env: &[(&str, &str)], cwd: &Path) -> Self {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .env_remove("OMGBASE_WORKSPACE")
            .env_remove("OMGBASE_FS_ADAPTER")
            .env_remove("OMGBASE_SPEC_MINTER")
            .env_remove("OMGBASE_SPEC_CLOCK")
            .env("NO_COLOR", "1")
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn");
        let stderr = child.stderr.take().unwrap();
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(l) = line else { break };
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            lines,
            seen: Vec::new(),
        }
    }

    /// Wait for a stderr line containing `needle`; the lines so far on failure.
    fn expect_line(&mut self, needle: &str) {
        let deadline = Instant::now() + LIVE_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(remaining) {
                Ok(l) => {
                    let hit = l.contains(needle);
                    self.seen.push(l);
                    if hit {
                        return;
                    }
                }
                Err(_) => panic!(
                    "no stderr line containing {needle:?} within {LIVE_TIMEOUT:?}; stderr so far:\n{}",
                    self.seen.join("\n")
                ),
            }
        }
    }

    /// `SIGTERM`, then the exit status and the whole stderr.
    fn terminate(mut self) -> (ExitStatus, String) {
        let ok = Command::new("kill")
            .arg("-TERM")
            .arg(self.child.id().to_string())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "kill -TERM");
        let deadline = Instant::now() + EXIT_GRACE;
        let status = loop {
            match self.child.try_wait().expect("wait") {
                Some(s) => break s,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                None => {
                    let _ = self.child.kill();
                    let s = self.child.wait().expect("wait");
                    self.seen.push(format!(
                        "<test> did not exit within {EXIT_GRACE:?} after SIGTERM; killed"
                    ));
                    break s;
                }
            }
        };
        while let Ok(l) = self.lines.try_recv() {
            self.seen.push(l);
        }
        (status, self.seen.join("\n"))
    }
}

// ---- --server on the verbs ---------------------------------------------------------------

#[test]
fn server_flag_is_checked_before_anything_is_spawned() {
    let w = TempDir::new("remote", "gate");
    // Not REMOTE_OK: a usage error, exit 2, no engine contacted.
    let out = run(
        OMGBASE,
        &["--server", "definitely-not-a-server-xyz", "status"],
        &[],
        w.path(),
    );
    assert_eq!(out.status.code(), Some(2));
    assert!(
        text(&out.stderr).contains("usage: --server is not supported for 'status'"),
        "{}",
        text(&out.stderr)
    );
    // -H needs an http(s) url.
    let out = run(
        OMGBASE,
        &["--server", "omg mcp", "-H", "X: y", "ls"],
        &[],
        w.path(),
    );
    assert_eq!(out.status.code(), Some(2));
    assert!(
        text(&out.stderr).contains("usage: -H/--header only applies to an http(s) --server url"),
        "{}",
        text(&out.stderr)
    );
    // A command that cannot be spawned: `remote_unavailable`, exit 1, and
    // no local workspace was needed to get there (the cwd has none).
    let out = run(
        OMGBASE,
        &["--server", "definitely-not-a-server-xyz --flag", "ls"],
        &[],
        w.path(),
    );
    assert_eq!(out.status.code(), Some(1));
    let err = text(&out.stderr);
    assert!(err.contains("error[remote_unavailable]"), "{err}");
    assert!(err.contains("definitely-not-a-server-xyz --flag"), "{err}");
    assert!(
        !w.path().join(".omgbase").exists(),
        "nothing was created locally"
    );
    // `--json`: the machine-mode envelope.
    let out = run(
        OMGBASE,
        &["--json", "--server", "definitely-not-a-server-xyz", "ls"],
        &[],
        w.path(),
    );
    let err: serde_json::Value =
        serde_json::from_str(text(&out.stderr).trim()).expect("json error");
    assert_eq!(err["error"], "remote_unavailable");
}

#[test]
fn ls_over_the_reference_server_renders_like_local() {
    let Some(omg) = ts_omg() else {
        return skip(&format!(
            "the reference CLI is not built ({TS_MAIN} — `pnpm build`)"
        ));
    };
    let w = TempDir::new("remote", "ls");
    workspace(
        &w,
        &[
            ("index.md", "# Index\n\nHello.\n"),
            ("notes/a.md", "# A\n\n- one\n- two\n"),
            ("notes/b.md", "---\ntitle: B\n---\n\n# B\n"),
        ],
    );
    // The remote run happens somewhere with no workspace at all.
    let elsewhere = TempDir::new("remote", "ls-cwd");
    let server = ts_server(&omg, &w);
    let wp = w.path_str();
    for mode in [&[][..], &["--json"][..], &["--ids"][..]] {
        let mut local: Vec<&str> = vec!["-C", &wp];
        local.extend(mode);
        local.push("ls");
        let l = run(OMGBASE, &local, &[], w.path());
        let mut remote: Vec<&str> = vec!["--server", &server];
        remote.extend(mode);
        remote.push("ls");
        let r = run(OMGBASE, &remote, &[], elsewhere.path());
        assert!(l.status.success(), "local ls {mode:?}: {}", text(&l.stderr));
        assert!(
            r.status.success(),
            "remote ls {mode:?}: {}",
            text(&r.stderr)
        );
        assert_eq!(
            blank_ago(&text(&r.stdout)),
            blank_ago(&text(&l.stdout)),
            "ls {mode:?}: remote (left) vs local (right)"
        );
        assert!(
            text(&l.stdout).contains("notes/a.md"),
            "{}",
            text(&l.stdout)
        );
    }
    // A glob narrows both the same way.
    let l = run(
        OMGBASE,
        &["-C", &w.path_str(), "ls", "notes/*"],
        &[],
        w.path(),
    );
    let r = run(
        OMGBASE,
        &["--server", &server, "ls", "notes/*"],
        &[],
        elsewhere.path(),
    );
    assert_eq!(blank_ago(&text(&r.stdout)), blank_ago(&text(&l.stdout)));
    assert!(!text(&r.stdout).contains("index.md"));
    assert!(
        !elsewhere.path().join(".omgbase").exists(),
        "remote mode opened no local workspace"
    );
}

#[test]
fn the_reference_omg_reaches_omgbase_mcp_as_its_server() {
    let Some(omg) = ts_omg() else {
        return skip(&format!(
            "the reference CLI is not built ({TS_MAIN} — `pnpm build`)"
        ));
    };
    if OMGBASE.chars().any(char::is_whitespace) {
        return skip(
            "the omgbase binary path has whitespace; a --server command line is whitespace-split",
        );
    }
    let w = TempDir::new("remote", "reverse");
    workspace(
        &w,
        &[("index.md", "# Index\n"), ("notes/a.md", "# A\n\nText.\n")],
    );
    let elsewhere = TempDir::new("remote", "reverse-cwd");
    let server = format!("{OMGBASE} mcp -C {} --no-watch", w.path_str());
    let (program, prefix) = (&omg[0], &omg[1..]);
    let prefix: Vec<&str> = prefix.iter().map(String::as_str).collect();
    let wp = w.path_str();
    for mode in [&[][..], &["--json"][..]] {
        let mut local: Vec<&str> = prefix.clone();
        local.extend(["-C", &wp]);
        local.extend(mode);
        local.push("ls");
        let l = run(program, &local, &[], w.path());
        let mut remote: Vec<&str> = prefix.clone();
        remote.extend(["--server", &server]);
        remote.extend(mode);
        remote.push("ls");
        let r = run(program, &remote, &[], elsewhere.path());
        assert!(l.status.success(), "omg ls {mode:?}: {}", text(&l.stderr));
        assert!(
            r.status.success(),
            "omg --server(omgbase mcp) ls {mode:?}: {}",
            text(&r.stderr)
        );
        assert_eq!(
            blank_ago(&text(&r.stdout)),
            blank_ago(&text(&l.stdout)),
            "omg ls {mode:?}: remote over omgbase mcp (left) vs local (right)"
        );
        assert!(text(&l.stdout).contains("notes/a.md"));
    }
}

// ---- sync --server ------------------------------------------------------------------------

#[test]
fn sync_server_mirrors_a_directory_into_the_reference_engine() {
    let Some(omg) = ts_omg() else {
        return skip(&format!(
            "the reference CLI is not built ({TS_MAIN} — `pnpm build`)"
        ));
    };
    let Some(adapter) = fs_adapter() else {
        return skip(&format!(
            "the fs adapter is unavailable ({ADAPTER_BIN} — `pnpm build`, or $OMGBASE_FS_ADAPTER)"
        ));
    };
    // The engine's workspace (its repo rooted at itself, empty) and the
    // directory to mirror, elsewhere.
    let w = TempDir::new("remote", "mirror-ws");
    workspace(&w, &[]);
    let d = TempDir::new("remote", "mirror-dir");
    fs::write(d.path().join("x.md"), "# X\n\nFrom disk.\n").unwrap();
    fs::create_dir_all(d.path().join("sub")).unwrap();
    fs::write(d.path().join("sub/y.md"), "# Y\n").unwrap();
    fs::write(d.path().join("z.txt"), "not a document\n").unwrap();
    let server = ts_server(&omg, &w);
    let out = run(
        OMGBASE,
        &[
            "--server",
            &server,
            "sync",
            "--root",
            &d.path_str(),
            "--out",
        ],
        &[("OMGBASE_FS_ADAPTER", &adapter)],
        d.path(),
    );
    let err = text(&out.stderr);
    assert!(out.status.success(), "{err}");
    assert!(
        err.contains("in: +2 ingested, =0 unchanged, !0 conflicted, -0 deleted"),
        "{err}"
    );
    assert!(err.contains("out: →0 written, ✗0 removed"), "{err}");
    // The engine holds the mirrored documents (read without a sweep: the
    // engine's own root is empty, a sweep would tombstone them).
    let ls = run(
        OMGBASE,
        &["--stale", "-C", &w.path_str(), "--json", "ls"],
        &[],
        w.path(),
    );
    // `--json ls` is the row array.
    let rows: serde_json::Value = serde_json::from_str(text(&ls.stdout).trim()).expect("ls json");
    let paths: Vec<&str> = rows
        .as_array()
        .expect("an array of rows")
        .iter()
        .filter_map(|i| i["path"].as_str())
        .collect();
    assert_eq!(paths, ["sub/y.md", "x.md"]);
    // Again: everything echoes.
    let out = run(
        OMGBASE,
        &["--server", &server, "sync", "--root", &d.path_str()],
        &[("OMGBASE_FS_ADAPTER", &adapter)],
        d.path(),
    );
    assert!(
        text(&out.stderr).contains("in: +0 ingested, =2 unchanged, !0 conflicted, -0 deleted"),
        "{}",
        text(&out.stderr)
    );
    // `--root` defaults to the cwd.
    fs::remove_file(d.path().join("x.md")).unwrap();
    let out = run(
        OMGBASE,
        &["--server", &server, "sync"],
        &[("OMGBASE_FS_ADAPTER", &adapter)],
        d.path(),
    );
    let err = text(&out.stderr);
    assert!(out.status.success(), "{err}");
    assert!(err.contains("in: +0 ingested, =1 unchanged"), "{err}");
}

#[test]
fn sync_server_watch_stays_live_until_a_signal() {
    let Some(omg) = ts_omg() else {
        return skip(&format!(
            "the reference CLI is not built ({TS_MAIN} — `pnpm build`)"
        ));
    };
    let Some(adapter) = fs_adapter() else {
        return skip(&format!(
            "the fs adapter is unavailable ({ADAPTER_BIN} — `pnpm build`, or $OMGBASE_FS_ADAPTER)"
        ));
    };
    let w = TempDir::new("remote", "mirror-watch-ws");
    workspace(&w, &[]);
    let d = TempDir::new("remote", "mirror-watch-dir");
    fs::write(d.path().join("a.md"), "# A\n").unwrap();
    let server = ts_server(&omg, &w);
    let mut live = Live::spawn(
        OMGBASE,
        &[
            "--server",
            &server,
            "sync",
            "--root",
            &d.path_str(),
            "--watch",
        ],
        &[("OMGBASE_FS_ADAPTER", &adapter)],
        d.path(),
    );
    live.expect_line("in: +1 ingested");
    live.expect_line("watching — Ctrl-C to stop");
    fs::write(d.path().join("b.md"), "# B\n\nLanded live.\n").unwrap();
    live.expect_line("watch: +1 =0 !0 -0");
    let (status, err) = live.terminate();
    assert!(status.success(), "exit 0 after SIGTERM; stderr:\n{err}");
    let ls = run(
        OMGBASE,
        &["--stale", "-C", &w.path_str(), "--ids", "ls"],
        &[],
        w.path(),
    );
    let ids = text(&ls.stdout);
    assert_eq!(
        ids.lines().count(),
        2,
        "a.md and b.md reached the engine: {ids}"
    );
}

// ---- sync --watch (local) -----------------------------------------------------------------

#[test]
fn local_sync_watch_reports_checkpoints_and_exits_on_sigterm() {
    let Some(adapter) = fs_adapter() else {
        return skip(&format!(
            "the fs adapter is unavailable ({ADAPTER_BIN} — `pnpm build`, or $OMGBASE_FS_ADAPTER)"
        ));
    };
    let w = TempDir::new("remote", "local-watch");
    workspace(&w, &[("a.md", "# A\n")]);
    let mut live = Live::spawn(
        OMGBASE,
        &["-C", &w.path_str(), "sync", "--watch"],
        &[("OMGBASE_FS_ADAPTER", &adapter)],
        w.path(),
    );
    live.expect_line("watching notes — Ctrl-C to stop");
    assert!(
        omgbase_sync::WatchLease::live(&w.path().join(".omgbase")),
        "the watcher holds the lease"
    );
    // A second watcher is refused while the lease is held.
    let second = run(
        OMGBASE,
        &["-C", &w.path_str(), "sync", "--watch"],
        &[("OMGBASE_FS_ADAPTER", &adapter)],
        w.path(),
    );
    assert_eq!(second.status.code(), Some(1));
    assert!(
        text(&second.stderr)
            .contains("error[target_missing]: another watcher already holds the lease"),
        "{}",
        text(&second.stderr)
    );
    fs::write(w.path().join("b.md"), "# B\n\nLanded live.\n").unwrap();
    live.expect_line("+1 -0");
    fs::remove_file(w.path().join("a.md")).unwrap();
    live.expect_line("+0 -1");
    let (status, err) = live.terminate();
    assert!(status.success(), "exit 0 after SIGTERM; stderr:\n{err}");
    assert!(
        !omgbase_sync::WatchLease::live(&w.path().join(".omgbase")),
        "the lease is released"
    );
    let ls = run(
        OMGBASE,
        &["--stale", "-C", &w.path_str(), "--ids", "ls"],
        &[],
        w.path(),
    );
    let ids = text(&ls.stdout);
    assert_eq!(ids.lines().count(), 1, "only b.md is live: {ids}");
}

#[test]
fn local_sync_watch_on_a_sourceless_repo_has_nothing_to_watch() {
    let w = TempDir::new("remote", "sourceless-watch");
    let mut ws = Workspace::open(w.path()).expect("open workspace");
    omgbase_sync::ensure_repo(ws.store_mut(), "notes", None).expect("ensure_repo");
    ws.close().expect("close");
    let out = run(
        OMGBASE,
        &["-C", &w.path_str(), "sync", "--watch"],
        &[],
        w.path(),
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    assert!(
        text(&out.stderr).contains("notes has no filesystem source — nothing to watch"),
        "{}",
        text(&out.stderr)
    );
}
