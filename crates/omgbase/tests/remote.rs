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
use std::io::{BufRead, BufReader, Read, Write};
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

// ---- the local/remote pair -----------------------------------------------------------------

/// The `spec/surface` §7.1 seams both binaries honor: ids mint `d_0, d_1, …`
/// per process (an id already in use is skipped, so a fresh process over an
/// existing store continues the sequence) and every commit is stamped with
/// one instant. Two workspaces seeded from the same files under them are
/// identical byte for byte — which is what lets a verb run locally on one
/// and remotely on the other compare equal, ids and all.
const SEAMS: &[(&str, &str)] = &[
    ("OMGBASE_SPEC_MINTER", "sequential"),
    ("OMGBASE_SPEC_CLOCK", "2026-09-27T00:00:00.000Z"),
];

/// The corpus every pair starts from: a link from `index.md` to `notes/b.md`
/// (so `mv --no-retarget` dangles and `retarget` has a hit), a document with a heading
/// section, tasks and a paragraph to split, and one with frontmatter.
const SEED: &[(&str, &str)] = &[
    (
        "index.md",
        "# Index\n\nSee [B](notes/b.md) and [A](notes/a.md).\n",
    ),
    (
        "notes/a.md",
        "# A\n\nIntro paragraph.\n\n## Tasks\n\n- [ ] task one\n- [ ] task two\n\n## Notes\n\nAlpha beta.\n",
    ),
    ("notes/b.md", "---\ntitle: B\n---\n\n# B\n\nBody of b.\n"),
];
/// `notes/a.md`'s second revision (so `diff`, `hist` and `log` have history).
const SEED_REVISED_A: &str = "# A\n\nIntro paragraph, revised.\n\n## Tasks\n\n- [ ] task one\n- [ ] task two\n\n## Notes\n\nAlpha beta.\n";

/// A workspace seeded with [`SEED`] under the seams, `notes/a.md` revised once.
fn seed_workspace(tag: &str) -> TempDir {
    let w = TempDir::new("remote", tag);
    for (p, c) in SEED {
        let f = w.path().join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, c).unwrap();
    }
    let mut ws = Workspace::open(w.path()).expect("open workspace");
    omgbase_sync::ensure_repo(ws.store_mut(), "notes", Some(&w.path_str())).expect("ensure_repo");
    ws.close().expect("close");
    let sync = |w: &TempDir| {
        let out = run(OMGBASE, &["-C", &w.path_str(), "sync"], SEAMS, w.path());
        assert!(out.status.success(), "seed sync: {}", text(&out.stderr));
    };
    sync(&w);
    fs::write(w.path().join("notes/a.md"), SEED_REVISED_A).unwrap();
    sync(&w);
    w
}

/// Two identical workspaces: `local` for the verb run locally, `remote` for
/// the engine the `--server` run reaches; the remote run's cwd is `elsewhere`,
/// a directory with no workspace at all.
struct Pair {
    local: TempDir,
    remote: TempDir,
    elsewhere: TempDir,
}

impl Pair {
    fn seed(tag: &str) -> Self {
        Self {
            local: seed_workspace(&format!("{tag}-local")),
            remote: seed_workspace(&format!("{tag}-remote")),
            elsewhere: TempDir::new("remote", &format!("{tag}-cwd")),
        }
    }

    /// `omgbase -C <local> args…` under the seams.
    fn local(&self, args: &[&str], stdin: Option<&str>) -> Output {
        let lp = self.local.path_str();
        let mut argv: Vec<&str> = vec!["-C", &lp];
        argv.extend(args);
        run_in(OMGBASE, &argv, SEAMS, self.local.path(), stdin)
    }

    /// `omgbase --server <server> args…` from `elsewhere`, under the seams
    /// (which the spawned engine inherits).
    fn remote(&self, server: &str, args: &[&str], stdin: Option<&str>) -> Output {
        let mut argv: Vec<&str> = vec!["--server", server];
        argv.extend(args);
        run_in(OMGBASE, &argv, SEAMS, self.elsewhere.path(), stdin)
    }

    /// The same verb locally and remotely.
    fn both(&self, server: &str, args: &[&str], stdin: Option<&str>) -> (Output, Output) {
        (self.local(args, stdin), self.remote(server, args, stdin))
    }

    /// The ids `--ids query <q>` lists on the local workspace (the remote
    /// one, seeded identically, holds the same).
    fn ids(&self, q: &str) -> Vec<String> {
        let out = self.local(&["--ids", "query", q], None);
        assert!(out.status.success(), "query {q}: {}", text(&out.stderr));
        text(&out.stdout)
            .lines()
            .map(str::to_owned)
            .filter(|l| !l.is_empty())
            .collect()
    }

    fn id(&self, q: &str) -> String {
        let ids = self.ids(q);
        assert_eq!(ids.len(), 1, "one id for {q}: {ids:?}");
        ids.into_iter().next().unwrap()
    }

    /// The remote engine's own view of a document (a local read on the
    /// remote workspace), for comparing what a remote write landed.
    fn remote_local_cat(&self, path: &str) -> String {
        let rp = self.remote.path_str();
        let out = run(
            OMGBASE,
            &["-C", &rp, "cat", path],
            SEAMS,
            self.remote.path(),
        );
        assert!(out.status.success(), "cat {path}: {}", text(&out.stderr));
        text(&out.stdout)
    }
}

/// The spawned engine's stderr passes through to the client's: the
/// reference's `[mcp] …` banner lines are not the verb's rendering.
fn sans_mcp(stderr: &str) -> String {
    stderr
        .split_inclusive('\n')
        .filter(|l| !l.starts_with("[mcp]"))
        .collect()
}

/// The remote run rendered exactly like the local one: exit code, stdout
/// and stderr (relative times blanked, the engine's banner dropped).
fn assert_same(what: &str, local: &Output, remote: &Output) {
    assert_eq!(
        remote.status.code(),
        local.status.code(),
        "{what}: exit — remote stderr:\n{}\nlocal stderr:\n{}",
        text(&remote.stderr),
        text(&local.stderr)
    );
    assert_eq!(
        blank_ago(&text(&remote.stdout)),
        blank_ago(&text(&local.stdout)),
        "{what}: stdout — remote (left) vs local (right)"
    );
    assert_eq!(
        blank_ago(&sans_mcp(&text(&remote.stderr))),
        blank_ago(&text(&local.stderr)),
        "{what}: stderr — remote (left) vs local (right)"
    );
}

/// A run that succeeded and printed the ids/lines on stdout.
fn ok_lines(what: &str, out: &Output) -> Vec<String> {
    assert!(out.status.success(), "{what}: {}", text(&out.stderr));
    text(&out.stdout).lines().map(str::to_owned).collect()
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
    run_in(program, args, env, cwd, None)
}

/// [`run`] with `stdin` fed to the process (closed at its end), else no stdin.
fn run_in(
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
    cwd: &Path,
    stdin: Option<&str>,
) -> Output {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_remove("OMGBASE_WORKSPACE")
        .env_remove("OMGBASE_FS_ADAPTER")
        .env_remove("OMGBASE_SPEC_MINTER")
        .env_remove("OMGBASE_SPEC_CLOCK")
        .env("NO_COLOR", "1")
        .current_dir(cwd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn");
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().unwrap();
        let bytes = input.as_bytes().to_vec();
        thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
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

/// Every REMOTE_OK read (`spec/cli` §2.3) over the reference engine renders
/// byte for byte as the same verb run locally: `query` in each consumer
/// shape, `outline`, `hist`, `cat` (a document, blocks, a resolution),
/// `diff` (unified, `--blocks`, `--json`), `find`, `log` and the modes —
/// plus the two places the reference's own remote branch differs from its
/// local one, pinned as they are: `outline <d_id>` heads with the ref as
/// typed, `cat --json <block>` is the `read_ref` result with its `kind`.
#[test]
fn every_read_over_the_reference_server_renders_like_local() {
    let Some(omg) = ts_omg() else {
        return skip(&format!(
            "the reference CLI is not built ({TS_MAIN} — `pnpm build`)"
        ));
    };
    let p = Pair::seed("reads");
    let server = ts_server(&omg, &p.remote);
    let intro =
        p.id(r#"from blocks where $path == "notes/a.md" && text == "Intro paragraph, revised.""#);
    let alpha = p.id(r#"from blocks where $path == "notes/a.md" && text == "Alpha beta.""#);
    let tasks =
        p.id(r#"from blocks where $path == "notes/a.md" && type == "heading" && text == "Tasks""#);
    let a_doc = {
        let out = p.local(&["--json", "cat", "notes/a.md"], None);
        let v: serde_json::Value = serde_json::from_str(text(&out.stdout).trim()).unwrap();
        v["docId"].as_str().unwrap().to_owned()
    };
    let cases: Vec<(&str, Vec<&str>)> = vec![
        ("query", vec!["query", "from docs"]),
        (
            "query --json",
            vec![
                "--json",
                "query",
                r#"select type, text from blocks where $path == "notes/a.md""#,
            ],
        ),
        ("query --jsonl", vec!["--jsonl", "query", "from docs"]),
        (
            "query --ids -n",
            vec!["--ids", "query", "from docs", "-n", "2"],
        ),
        ("query count", vec!["query", "$repo.docs count { }"]),
        (
            "query values",
            vec!["query", "select $path values from docs"],
        ),
        ("outline", vec!["outline", "notes/a.md"]),
        (
            "outline --json --depth",
            vec!["--json", "outline", "notes/a.md", "--depth", "1"],
        ),
        ("ol --skeleton", vec!["ol", "notes/a.md", "--skeleton"]),
        ("hist", vec!["hist", &intro]),
        ("hist --json -n", vec!["--json", "hist", &intro, "-n", "1"]),
        ("hist --ids", vec!["--ids", "hist", &alpha]),
        ("cat doc", vec!["cat", "notes/a.md"]),
        ("cat doc --json", vec!["--json", "cat", "notes/a.md"]),
        (
            "cat doc --resolution",
            vec!["cat", "notes/b.md", "--resolution", "text"],
        ),
        ("cat blocks", vec!["cat", &alpha, &tasks]),
        (
            "cat block --resolution",
            vec!["cat", &tasks, "--resolution", "text"],
        ),
        ("cat doc + block", vec!["cat", "index.md", &alpha]),
        ("diff", vec!["diff", "notes/a.md"]),
        ("diff --blocks", vec!["diff", "notes/a.md", "--blocks"]),
        (
            "diff --blocks --ids",
            vec!["--ids", "diff", "notes/a.md", "--blocks"],
        ),
        ("diff --json", vec!["--json", "diff", "notes/a.md"]),
        ("diff by id", vec!["diff", &a_doc]),
        ("find", vec!["find", "task"]),
        ("find --json -n", vec!["--json", "find", "Alpha", "-n", "2"]),
        ("find -1", vec!["find", "Alpha", "-1"]),
        ("find -v", vec!["find", "beta", "-v"]),
        ("find --no-semantic", vec!["find", "task", "--no-semantic"]),
        ("log", vec!["log"]),
        ("log --ids -n", vec!["--ids", "log", "-n", "1"]),
        (
            "log --cursor --origin",
            vec!["log", "--cursor", "1", "--origin", "observed"],
        ),
        ("log --jsonl", vec!["--jsonl", "log"]),
        ("ls glob --ids", vec!["--ids", "ls", "notes/*"]),
    ];
    for (what, args) in &cases {
        let (l, r) = p.both(&server, args, None);
        assert!(l.status.success(), "local {what}: {}", text(&l.stderr));
        assert_same(what, &l, &r);
    }
    // `cat -`: refs from stdin, in both directions.
    let refs = format!("{alpha}\nnotes/b.md\n");
    let (l, r) = p.both(&server, &["cat", "-"], Some(&refs));
    assert_same("cat -", &l, &r);
    assert!(text(&l.stdout).contains("Body of b."));

    // The reference's remote `outline` heads with the ref as typed (no local
    // path lookup): a `d_` id shows as the id, where the local run shows the path.
    let (l, r) = p.both(&server, &["outline", &a_doc], None);
    let (lo, ro) = (text(&l.stdout), text(&r.stdout));
    assert!(lo.starts_with("  omgbase  >  notes/a.md\n"), "{lo}");
    assert!(ro.starts_with(&format!("  omgbase  >  {a_doc}\n")), "{ro}");
    assert_eq!(
        lo.lines().skip(1).collect::<Vec<_>>(),
        ro.lines().skip(1).collect::<Vec<_>>()
    );

    // The reference's remote `cat --json <block>` is the `read_ref` result,
    // `kind` included; the local run prints the bare `nodes_get` object.
    let (l, r) = p.both(&server, &["--json", "cat", &alpha], None);
    let lv: serde_json::Value = serde_json::from_str(text(&l.stdout).trim()).unwrap();
    let mut rv: serde_json::Value = serde_json::from_str(text(&r.stdout).trim()).unwrap();
    assert_eq!(rv["kind"], "block");
    rv.as_object_mut().unwrap().remove("kind");
    assert_eq!(rv, lv);

    // `--since` needs the local commits table: refused remotely, as the reference does.
    let r = p.remote(&server, &["log", "--since", "1h"], None);
    assert_eq!(r.status.code(), Some(2));
    assert_eq!(
        text(&r.stderr),
        "usage: --since is not supported with --server; use --cursor <seq>\n"
    );
    // An unknown ref is the engine's error, rendered like a local one.
    let r = p.remote(&server, &["--json", "cat", "nope.md"], None);
    assert_eq!(r.status.code(), Some(1));
    let err: serde_json::Value = serde_json::from_str(sans_mcp(&text(&r.stderr)).trim()).unwrap();
    assert_eq!(err["error"], "doc_missing");

    // `shell --server`: every line of a piped script runs against the engine
    // — the same script locally renders the same, frame hints included.
    let script =
        "ls\nquery \"from docs\"\n@2\ncat @2\noutline notes/a.md\nfind task -1\nhist @_\nbogus\n";
    let (l, r) = p.both(&server, &["shell"], Some(script));
    assert_same("shell", &l, &r);
    let out = text(&l.stdout);
    assert!(out.contains("Intro paragraph, revised."), "{out}");
    assert!(text(&l.stderr).contains("3 rows — address with @1..@3"));
    assert_eq!(l.status.code(), Some(2), "the last non-zero code (`bogus`)");
    assert!(
        !p.elsewhere.path().join(".omgbase").exists(),
        "remote mode opened no local workspace"
    );
}

/// Every REMOTE_OK write over the reference engine: the same verb run
/// locally on one workspace and remotely on its twin renders the same
/// confirmation (ids included, under the minter seam) and lands the same
/// bytes — `cat` through both afterwards agrees, and the remote engine's
/// own files equal the local workspace's. The three places the reference's
/// remote branch renders differently are pinned as they are: `update <b_>`
/// has no CAS notice remotely, `--json` on the block sugar carries the
/// tool's `id`/`ids`, and `retarget --apply` prints `retargeted N block(s)`
/// (with the tool's whole result in `--json`). `node props` is refused.
#[test]
fn every_write_over_the_reference_server_lands_like_local() {
    let Some(omg) = ts_omg() else {
        return skip(&format!(
            "the reference CLI is not built ({TS_MAIN} — `pnpm build`)"
        ));
    };
    let p = Pair::seed("writes");
    let server = ts_server(&omg, &p.remote);
    let list = p.id(r#"from blocks where $path == "notes/a.md" && type == "list""#);
    let tasks =
        p.id(r#"from blocks where $path == "notes/a.md" && type == "heading" && text == "Tasks""#);
    let task_one = p.id(r#"from blocks where $path == "notes/a.md" && text == "task one""#);
    let task_two = p.id(r#"from blocks where $path == "notes/a.md" && text == "task two""#);
    let alpha = p.id(r#"from blocks where $path == "notes/a.md" && text == "Alpha beta.""#);
    let intro =
        p.id(r#"from blocks where $path == "notes/a.md" && text == "Intro paragraph, revised.""#);

    let same = |what: &str, args: &[&str]| -> Vec<String> {
        let (l, r) = p.both(&server, args, None);
        assert_same(what, &l, &r);
        ok_lines(what, &l)
    };
    // The lockstep: each step on both workspaces, compared, then the next.
    let created = same("new", &["new", "notes/c.md", "-m", "# C\n\nHello.\n"]);
    assert_eq!(created.len(), 1, "the doc id");
    same(
        "new --dry-run",
        &["--dry-run", "new", "notes/d.md", "-m", "# D\n"],
    );
    let inserted = same("insert", &["insert", &list, "-m", "- [ ] task three"]);
    assert_eq!(inserted.len(), 1, "the minted id");
    same(
        "insert --json --dry-run --at",
        &[
            "--json",
            "--dry-run",
            "insert",
            &list,
            "-m",
            "- [ ] nope",
            "--at",
            "start",
        ],
    );
    same("append", &["append", &tasks, "-m", "Appended para."]);
    same("done", &["done", &task_one]);
    same(
        "done --undo --dry-run",
        &["--dry-run", "done", &task_one, "--undo"],
    );

    // `update <b_>`: the CAS notice is the local path's; the reference's
    // remote branch pins CAS server-side and says nothing.
    let (l, r) = p.both(
        &server,
        &["update", &task_two, "-m", "- [ ] task two (edited)"],
        None,
    );
    assert_eq!(text(&r.stdout), text(&l.stdout), "update <b_>: the id");
    assert_eq!(
        text(&l.stderr),
        format!(
            "  updating {task_two} (CAS pinned from current bytes)\n  ok committed · 1 document touched\n"
        )
    );
    assert_eq!(
        sans_mcp(&text(&r.stderr)),
        "  ok committed · 1 document touched\n"
    );
    // `--json` on the block sugar: the reference's remote branch prints the
    // tool's decorated result (`id`/`ids`), the local path the bare `ApplyResult`.
    let (l, r) = p.both(
        &server,
        &[
            "--json",
            "update",
            &task_two,
            "-m",
            "- [ ] task two (edited twice)",
        ],
        None,
    );
    let lv: serde_json::Value = serde_json::from_str(text(&l.stdout).trim()).unwrap();
    let mut rv: serde_json::Value = serde_json::from_str(text(&r.stdout).trim()).unwrap();
    assert_eq!(rv["id"], task_two);
    assert_eq!(rv["ids"], serde_json::json!([task_two]));
    let rm = rv.as_object_mut().unwrap();
    rm.remove("id");
    rm.remove("ids");
    assert_eq!(rv, lv, "the ApplyResult underneath");

    same(
        "update <doc>",
        &[
            "update",
            "notes/c.md",
            "-m",
            "# C\n\nHello again.\n\nNew para.\n",
        ],
    );
    same(
        "update <doc> --plan",
        &[
            "update",
            "notes/c.md",
            "--plan",
            "-m",
            "# C\n\nHello again.\n",
        ],
    );
    let split = same("split", &["split", &alpha, "--at", "6"]);
    assert_eq!(split.len(), 2, "the two halves: {split:?}");
    same(
        "merge --sep",
        &["merge", &split[0], &split[1], "--sep", " "],
    );
    same(
        "move --to --at",
        &["move", &task_two, "--to", &list, "--at", "start"],
    );
    let node = p.id(r#"from nodes where kind == "md:task" && value == "task three""#);
    same("node set", &["node", "set", &node, "checked", "true"]);
    let r = p.remote(&server, &["node", "props", &node], None);
    assert_eq!(r.status.code(), Some(2));
    assert_eq!(
        text(&r.stderr),
        "usage: node props is local-only; run it against a local workspace\n"
    );
    // `--no-retarget` keeps the inbound link dangling so `retarget` below has
    // a hit (a bare `mv` rewrites it, spec/mutate 1.3).
    let moved = same(
        "mv",
        &["mv", "notes/b.md", "notes/moved.md", "--no-retarget"],
    );
    assert_eq!(moved.len(), 1);
    let (l, _) = p.both(&server, &["ls", "notes/moved.md"], None);
    assert!(text(&l.stdout).contains("notes/moved.md"));
    same(
        "retarget (plan)",
        &["retarget", "/notes/b.md", "/notes/moved.md"],
    );
    same(
        "retarget --scope --json",
        &[
            "--json",
            "retarget",
            "/notes/b.md",
            "/notes/moved.md",
            "--scope",
            "notes/*",
        ],
    );
    // `retarget --apply`: the reference's remote branch renders the tool's
    // result its own way — `ok retargeted N block(s)`, no ids on stdout.
    let (l, r) = p.both(
        &server,
        &["retarget", "/notes/b.md", "/notes/moved.md", "--apply"],
        None,
    );
    assert!(
        l.status.success() && r.status.success(),
        "{}\n{}",
        text(&l.stderr),
        text(&r.stderr)
    );
    assert_eq!(text(&l.stderr), "  ok committed · 1 document touched\n");
    assert_eq!(
        ok_lines("retarget --apply local", &l).len(),
        1,
        "the block id"
    );
    assert_eq!(sans_mcp(&text(&r.stderr)), "  ok retargeted 1 block(s)\n");
    assert_eq!(text(&r.stdout), "");
    let (l, r) = p.both(
        &server,
        &[
            "--json",
            "retarget",
            "/notes/moved.md",
            "/notes/b.md",
            "--apply",
        ],
        None,
    );
    let lv: serde_json::Value = serde_json::from_str(text(&l.stdout).trim()).unwrap();
    let rv: serde_json::Value = serde_json::from_str(text(&r.stdout).trim()).unwrap();
    assert_eq!(rv["applied"], true);
    assert_eq!(rv["hits"].as_array().map(Vec::len), Some(1));
    assert_eq!(rv["results"], lv["results"]);
    assert_eq!(rv["revisions"], lv["revisions"]);
    // Back where the plan wants it, for the final state below (the two
    // renderings differ as above; both commit).
    let (l, r) = p.both(
        &server,
        &["retarget", "/notes/b.md", "/notes/moved.md", "--apply"],
        None,
    );
    assert!(
        l.status.success() && r.status.success(),
        "{}\n{}",
        text(&l.stderr),
        text(&r.stderr)
    );
    same(
        "meta --set --set-json --unset",
        &[
            "meta",
            "notes/moved.md",
            "--set",
            "title=B2",
            "--set",
            "n=3",
            "--set-json",
            "tags=[\"x\"]",
            "--unset",
            "n",
        ],
    );
    let changeset = format!(
        r#"{{"ops":[{{"op":"insert","to":{{"parent":"{list}","at":"end"}},"markdown":"- [ ] via apply"}}]}}"#
    );
    let (l, r) = p.both(
        &server,
        &["apply", "-f", "-", "--reason", "probe"],
        Some(&changeset),
    );
    assert_same("apply -f -", &l, &r);
    assert_eq!(ok_lines("apply", &l).len(), 1);
    same("rm", &["rm", &intro]);
    same("rm --doc", &["rm", "--doc", "notes/c.md"]);
    same(
        "rm --doc --dry-run",
        &["--dry-run", "rm", "--doc", "notes/moved.md"],
    );
    // Errors from the engine render like local ones (the code; the remote
    // resolver's payload names the ref, the local one does not).
    let (l, r) = p.both(&server, &["--json", "rm", "b_nope"], None);
    assert_eq!(r.status.code(), l.status.code());
    let le: serde_json::Value = serde_json::from_str(text(&l.stderr).trim()).unwrap();
    let re: serde_json::Value = serde_json::from_str(sans_mcp(&text(&r.stderr)).trim()).unwrap();
    assert_eq!(re["error"], le["error"]);
    assert_eq!(re["message"], le["message"]);

    // The final state, read through both and through the remote engine's own files.
    for path in ["index.md", "notes/a.md", "notes/moved.md"] {
        let (l, r) = p.both(&server, &["cat", path], None);
        assert_same(&format!("cat {path}"), &l, &r);
        assert_eq!(p.remote_local_cat(path), text(&l.stdout), "{path} on disk");
    }
    same("outline (final)", &["outline", "notes/a.md"]);
    same("ls (final)", &["ls"]);
    same("log --ids (final)", &["--ids", "log"]);
    let a = p.remote_local_cat("notes/a.md");
    assert!(a.contains("- [x] task one"), "{a}");
    assert!(a.contains("- [x] task three"), "{a}");
    assert!(a.contains("- [ ] via apply"), "{a}");
    assert!(a.contains("Alpha  beta."), "{a}");
    assert!(!a.contains("Intro paragraph"), "{a}");
    assert!(
        !p.elsewhere.path().join(".omgbase").exists(),
        "remote mode opened no local workspace"
    );
}

/// The reverse direction: the reference `omg --server "<omgbase> mcp …"`
/// reaches the Rust engine for its reads and a write, each rendering as the
/// reference does locally on the twin workspace.
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
    let p = Pair::seed("reverse");
    let server = format!("{OMGBASE} mcp -C {} --no-watch", p.remote.path_str());
    let (program, prefix) = (&omg[0], &omg[1..]);
    let prefix: Vec<&str> = prefix.iter().map(String::as_str).collect();
    let lp = p.local.path_str();
    let both = |args: &[&str]| -> (Output, Output) {
        let mut local: Vec<&str> = prefix.clone();
        local.extend(["-C", &lp]);
        local.extend(args);
        let l = run(program, &local, SEAMS, p.local.path());
        let mut remote: Vec<&str> = prefix.clone();
        remote.extend(["--server", &server]);
        remote.extend(args);
        let r = run(program, &remote, SEAMS, p.elsewhere.path());
        (l, r)
    };
    let intro =
        p.id(r#"from blocks where $path == "notes/a.md" && text == "Intro paragraph, revised.""#);
    let list = p.id(r#"from blocks where $path == "notes/a.md" && type == "list""#);
    let cases: Vec<(&str, Vec<&str>)> = vec![
        ("ls", vec!["ls"]),
        ("ls --json", vec!["--json", "ls"]),
        ("cat", vec!["cat", "notes/a.md"]),
        ("cat block", vec!["cat", &intro]),
        ("outline", vec!["outline", "notes/a.md"]),
        ("query --ids", vec!["--ids", "query", "from docs"]),
        (
            "query --json",
            vec![
                "--json",
                "query",
                r#"select type from blocks where $path == "index.md""#,
            ],
        ),
        ("find", vec!["find", "task"]),
        ("hist", vec!["hist", &intro]),
        ("log", vec!["log"]),
        ("diff", vec!["diff", "notes/a.md"]),
        ("diff --blocks", vec!["diff", "notes/a.md", "--blocks"]),
    ];
    for (what, args) in &cases {
        let (l, r) = both(args);
        assert!(l.status.success(), "omg {what}: {}", text(&l.stderr));
        assert_same(&format!("omg {what} over omgbase mcp"), &l, &r);
    }
    assert!(text(&both(&["ls"]).0.stdout).contains("notes/a.md"));
    // A write: the same confirmation and the same bytes landed on both. The
    // minted id differs: the reference client spawns its stdio engine with
    // the MCP SDK's default (safelisted) environment, so the minter seam
    // never reaches `omgbase mcp` and the id is a production one.
    let (l, r) = both(&["insert", &list, "-m", "- [ ] from the reference"]);
    assert_eq!(r.status.code(), l.status.code(), "{}", text(&r.stderr));
    assert_eq!(sans_mcp(&text(&r.stderr)), text(&l.stderr));
    let (lid, rid) = (
        ok_lines("omg insert", &l),
        ok_lines("omg --server insert", &r),
    );
    assert_eq!(lid.len(), 1, "{lid:?}");
    assert_eq!(rid.len(), 1, "{rid:?}");
    assert!(
        lid[0].starts_with("b_") && rid[0].starts_with("b_"),
        "{lid:?} {rid:?}"
    );
    let (l, r) = both(&["cat", "notes/a.md"]);
    assert_same("omg cat after insert", &l, &r);
    assert!(text(&l.stdout).contains("- [ ] from the reference"));
    assert_eq!(p.remote_local_cat("notes/a.md"), text(&l.stdout));
    assert!(!p.elsewhere.path().join(".omgbase").exists());
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
