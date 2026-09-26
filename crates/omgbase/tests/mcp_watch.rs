//! `omgbase mcp` as a process: the `--no-watch` flag, the degradation when
//! the `fs` adapter cannot be started, the watched run (a file written under
//! the workspace is readable through the server within seconds — needs
//! `node` and `packages/fs-adapter/dist`, built by `pnpm build`; skipped
//! with a message otherwise), and a clean `SIGTERM` shutdown.
//!
//! Each test bootstraps a workspace with the Rust engine (`ensure_repo` with
//! an `fs` root — the same rows the interop harness writes) and drives the
//! binary over MCP stdio.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use omgbase_sync::{WatchLease, Workspace};
use serde_json::{Map, Value as Json, json};

mod common;
use common::TempDir;

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const ADAPTER_BIN: &str = "packages/fs-adapter/dist/src/bin.js";
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const EXIT_GRACE: Duration = Duration::from_secs(15);
/// The adapter debounces 750 ms; a checkpoint follows within a second or two.
const WATCH_TIMEOUT: Duration = Duration::from_secs(12);

/// A workspace with repo `notes` rooted at the directory itself; with
/// `embedder`, the repo's `embedding.provider` names that command.
fn bootstrap_with(w: &TempDir, embedder: Option<&str>) -> String {
    let mut ws = Workspace::open(w.path()).expect("open workspace");
    let root = w.path_str();
    let repo =
        omgbase_sync::ensure_repo(ws.store_mut(), "notes", Some(&root)).expect("ensure_repo");
    if let Some(cmd) = embedder {
        let mut settings = Map::new();
        settings.insert(
            "embedding".to_owned(),
            json!({ "provider": cmd, "model": "fake-4", "dim": 4 }),
        );
        omgbase_sync::write_repo_settings(ws.store(), &repo, &settings).expect("settings");
    }
    ws.close().expect("close");
    repo
}

fn bootstrap(w: &TempDir) -> String {
    bootstrap_with(w, None)
}

/// A stdio embedding provider (`spec/search` §5) in a few lines of node:
/// the handshake, then one deterministic 4-vector per text. Every start
/// appends its pid to [`EMBEDDER_SPAWNS`] (one line per child process).
/// `None` when `node` is unavailable.
fn fake_embedder(w: &TempDir) -> Option<String> {
    if !node_available() {
        return None;
    }
    let script = w.path().join(".omgbase").join("fake-embedder.mjs");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::write(
        &script,
        r#"import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
appendFileSync(new URL("./fake-embedder.spawns", import.meta.url), `${process.pid}\n`);
process.stdout.write(JSON.stringify({ model: "fake-4", dim: 4 }) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const vectors = req.texts.map((t) => {
    let h = 0;
    for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 1000;
    return [h / 1000, 0.5, 0.25, 0.125];
  });
  process.stdout.write(JSON.stringify({ id: req.id, vectors }) + "\n");
});
rl.on("close", () => process.exit(0));
"#,
    )
    .unwrap();
    Some(format!("node {}", script.display()))
}

/// Where the fake embedder logs its starts, relative to the workspace.
const EMBEDDER_SPAWNS: &str = ".omgbase/fake-embedder.spawns";

/// How many fake embedder processes a run started.
fn embedder_spawns(w: &TempDir) -> usize {
    std::fs::read_to_string(w.path().join(EMBEDDER_SPAWNS))
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0)
}

/// Twenty-six words: past `MIN_EMBED_TOKENS`, so the paragraph embeds.
const LONG_PARAGRAPH: &str = "Hello from disk, a paragraph long enough for the embedder to consider it worth a vector, with words to spare and then a few more for good measure.";

fn count(db: &Path, table: &str) -> i64 {
    let store = omgbase_store::Store::open(db).expect("open store");
    store
        .conn()
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .expect("count")
}

/// The `omgbase mcp` child and an MCP client over its stdio.
struct Server {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Arc<Mutex<String>>,
    next_id: i64,
}

impl Server {
    fn spawn(w: &TempDir, extra: &[&str], env: &[(&str, &str)]) -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_omgbase"));
        cmd.arg("mcp")
            .arg("--workspace")
            .arg(w.path())
            .args(extra)
            .env_remove("OMGBASE_WORKSPACE")
            .env_remove("OMGBASE_FS_ADAPTER")
            .env_remove("OMGBASE_SPEC_MINTER")
            .env_remove("OMGBASE_SPEC_CLOCK")
            .current_dir(REPO_ROOT)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn omgbase mcp");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr_pipe = child.stderr.take().expect("stderr");
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&stderr);
        thread::spawn(move || {
            for line in BufReader::new(stderr_pipe).lines() {
                let Ok(l) = line else { break };
                let mut s = sink.lock().unwrap();
                s.push_str(&l);
                s.push('\n');
            }
        });
        let mut server = Self {
            child,
            stdin: Some(stdin),
            lines,
            stderr,
            next_id: 0,
        };
        server.request(
            "initialize",
            json!({ "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "omgbase-mcp-watch-test", "version": "0" } }),
        );
        server.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        server
    }

    fn stderr(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    /// Wait until stderr contains `needle`.
    fn wait_stderr(&self, needle: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.stderr().contains(needle) {
                return true;
            }
            thread::sleep(Duration::from_millis(25));
        }
        false
    }

    fn send(&mut self, msg: &Json) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{msg}").expect("write");
        stdin.flush().expect("flush");
    }

    fn request(&mut self, method: &str, params: Json) -> Json {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let deadline = Instant::now() + CALL_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let line = self.lines.recv_timeout(remaining).unwrap_or_else(|e| {
                panic!("no reply to {method}: {e}\nstderr:\n{}", self.stderr())
            });
            let msg: Json = serde_json::from_str(&line).expect("json line");
            if msg.get("id") == Some(&json!(id)) {
                return msg;
            }
        }
    }

    /// A tool call: `(parsed result, is_error)`.
    fn call(&mut self, name: &str, args: Json) -> (Json, bool) {
        let reply = self.request("tools/call", json!({ "name": name, "arguments": args }));
        let result = &reply["result"];
        let text = result["content"][0]["text"].as_str().expect("text content");
        (
            serde_json::from_str(text).expect("tool json"),
            result.get("isError") == Some(&Json::Bool(true)),
        )
    }

    fn wait_exit(mut self) -> (ExitStatus, String) {
        let deadline = Instant::now() + EXIT_GRACE;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    // Let the stderr thread reach EOF.
                    thread::sleep(Duration::from_millis(50));
                    return (status, self.stderr());
                }
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Ok(None) => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    panic!("omgbase mcp did not exit; stderr:\n{}", self.stderr());
                }
                Err(e) => panic!("wait: {e}"),
            }
        }
    }

    /// stdin EOF, then the exit status and the whole stderr.
    fn close(mut self) -> (ExitStatus, String) {
        drop(self.stdin.take());
        self.wait_exit()
    }

    /// `SIGTERM`, then the exit status and the whole stderr.
    fn terminate(self) -> (ExitStatus, String) {
        let status = Command::new("kill")
            .arg("-TERM")
            .arg(self.child.id().to_string())
            .status()
            .expect("kill");
        assert!(status.success(), "kill -TERM");
        self.wait_exit()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn node_available() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// `node <repo>/packages/fs-adapter/dist/src/bin.js`, when both exist.
fn adapter_command() -> Option<String> {
    let bin: PathBuf = Path::new(REPO_ROOT).join(ADAPTER_BIN);
    if !bin.is_file() {
        return None;
    }
    node_available().then(|| format!("node {}", bin.display()))
}

fn omgbase_dir(w: &TempDir) -> PathBuf {
    w.path().join(".omgbase")
}

#[test]
fn no_watch_serves_without_priming_or_a_lease() {
    let w = TempDir::new("mcp", "nowatch");
    bootstrap(&w);
    std::fs::write(w.path().join("hello.md"), "# Hello\n").unwrap();
    let mut s = Server::spawn(&w, &["--no-watch"], &[]);
    let (list, err) = s.call("docs_list", json!({}));
    assert!(!err, "{list}");
    assert_eq!(list["items"], json!([]), "no priming sweep ran");
    let (_, err) = s.call("docs_read", json!({ "path": "hello.md" }));
    assert!(err, "the file on disk is not in the store");
    assert!(!WatchLease::path_in(&omgbase_dir(&w)).exists());
    let (status, stderr) = s.close();
    assert!(status.success(), "{stderr}");
    assert!(
        stderr.contains("serving notes on stdio · watcher off (--no-watch)"),
        "{stderr}"
    );
    assert!(!stderr.contains("[watch]"), "{stderr}");
}

#[test]
fn a_missing_adapter_primes_then_serves_without_a_watcher() {
    let w = TempDir::new("mcp", "noadapter");
    bootstrap(&w);
    std::fs::write(w.path().join("hello.md"), "# Hello\n\nOne.\n").unwrap();
    let mut s = Server::spawn(
        &w,
        &[],
        &[(
            "OMGBASE_FS_ADAPTER",
            "definitely-not-an-omgbase-adapter-xyz",
        )],
    );
    // The priming sweep ran before the adapter was tried: the file is in.
    let (doc, err) = s.call("docs_read", json!({ "path": "hello.md" }));
    assert!(!err, "{doc}");
    assert_eq!(doc["content"], "# Hello\n\nOne.\n");
    assert!(
        !WatchLease::live(&omgbase_dir(&w)),
        "the lease was released when the adapter failed"
    );
    let (status, stderr) = s.close();
    assert!(status.success(), "{stderr}");
    assert!(stderr.contains("[watch] primed: +1 -0"), "{stderr}");
    assert!(
        stderr.contains("[mcp] watcher unavailable: cannot start the `fs` adapter as `definitely-not-an-omgbase-adapter-xyz --root"),
        "{stderr}"
    );
    assert!(stderr.contains("OMGBASE_FS_ADAPTER"), "{stderr}");
    assert!(
        stderr.contains("serving notes on stdio · no watch (adapter unavailable)"),
        "{stderr}"
    );
}

#[test]
fn a_second_live_watcher_yields_the_lease() {
    let w = TempDir::new("mcp", "lease");
    bootstrap(&w);
    let held = WatchLease::try_acquire(&omgbase_dir(&w)).unwrap().unwrap();
    let s = Server::spawn(&w, &[], &[]);
    let (status, stderr) = s.close();
    assert!(status.success(), "{stderr}");
    assert!(
        stderr.contains("serving notes on stdio · watcher elsewhere"),
        "{stderr}"
    );
    assert!(WatchLease::live(&omgbase_dir(&w)), "ours is untouched");
    drop(held);
}

#[test]
fn sigterm_shuts_down_cleanly() {
    let w = TempDir::new("mcp", "sigterm");
    bootstrap(&w);
    let mut s = Server::spawn(&w, &["--no-watch"], &[]);
    let (_, err) = s.call("docs_list", json!({}));
    assert!(!err);
    let (status, stderr) = s.terminate();
    assert!(status.success(), "exit 0 after SIGTERM; stderr:\n{stderr}");
    assert!(stderr.contains("[mcp] signal: shutting down"), "{stderr}");
}

/// Poll `docs_read` until the document reads with `content`.
fn wait_for_content(s: &mut Server, path: &str, content: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let (doc, err) = s.call("docs_read", json!({ "path": path }));
        if !err && doc["content"] == content {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

#[test]
fn a_watched_run_ingests_files_written_under_the_workspace() {
    let Some(adapter) = adapter_command() else {
        eprintln!(
            "skipping: the fs adapter is unavailable (needs `node` on PATH and {ADAPTER_BIN} — `pnpm build`)"
        );
        return;
    };
    let w = TempDir::new("mcp", "watched");
    let embedder = fake_embedder(&w).expect("node is available when the adapter is");
    bootstrap_with(&w, Some(&embedder));
    std::fs::write(w.path().join("seed.md"), "# Seed\n").unwrap();
    let mut s = Server::spawn(&w, &[], &[("OMGBASE_FS_ADAPTER", adapter.as_str())]);
    assert!(
        s.wait_stderr("watcher live", Duration::from_secs(20)),
        "stderr:\n{}",
        s.stderr()
    );
    assert!(
        WatchLease::live(&omgbase_dir(&w)),
        "this process holds the lease"
    );
    // The priming sweep brought the seed in before the adapter started.
    let (doc, err) = s.call("docs_read", json!({ "path": "seed.md" }));
    assert!(!err, "{doc}");

    // chokidar ignores the initial scan and has no readiness signal on the
    // wire: give it a moment, and rewrite once if the first change was missed.
    thread::sleep(Duration::from_millis(1000));
    let note = w.path().join("note.md");
    let first = format!("# Note\n\n{LONG_PARAGRAPH}\n");
    let first = first.as_str();
    std::fs::write(&note, first).unwrap();
    let mut seen = wait_for_content(&mut s, "note.md", first, WATCH_TIMEOUT);
    if !seen {
        std::fs::write(&note, first).unwrap();
        seen = wait_for_content(&mut s, "note.md", first, WATCH_TIMEOUT);
    }
    assert!(
        seen,
        "the written file never arrived; stderr:\n{}",
        s.stderr()
    );
    assert!(
        s.wait_stderr("[watch] checkpoint: +1 -0", Duration::from_secs(5)),
        "{}",
        s.stderr()
    );
    // The checkpoint scheduled a drain: the paragraph and the document embed.
    assert!(
        s.wait_stderr("[mcp] embedded ", Duration::from_secs(10)),
        "the watcher's checkpoint did not trigger a drain; stderr:\n{}",
        s.stderr()
    );

    // An edit follows the same path.
    let second = "# Note\n\nHello again.\n";
    std::fs::write(&note, second).unwrap();
    assert!(
        wait_for_content(&mut s, "note.md", second, WATCH_TIMEOUT),
        "the edit never arrived; stderr:\n{}",
        s.stderr()
    );

    // A write through the server is echo-suppressed when it comes back.
    let (res, err) = s.call(
        "docs_create",
        json!({ "path": "made.md", "markdown": "# Made\n\nBy the tool.\n" }),
    );
    assert!(!err, "{res}");
    thread::sleep(Duration::from_millis(1500));
    let (doc, err) = s.call("docs_read", json!({ "path": "made.md" }));
    assert!(!err, "{doc}");
    assert_eq!(doc["content"], "# Made\n\nBy the tool.\n");

    let (status, stderr) = s.close();
    assert!(status.success(), "{stderr}");
    assert!(
        stderr.contains("serving notes on stdio · watcher live"),
        "{stderr}"
    );
    assert!(
        !WatchLease::path_in(&omgbase_dir(&w)).exists(),
        "the lease is released at shutdown"
    );
    assert!(!stderr.contains("[watch] error"), "{stderr}");
    assert!(
        stderr.contains("auto-embed on mutation enabled"),
        "{stderr}"
    );
    assert!(count(&w.path().join(".omgbase/omgbase.db"), "embeddings") >= 1);
}

#[test]
fn a_write_schedules_a_drain_and_shutdown_flushes_it() {
    let w = TempDir::new("mcp", "drain");
    let Some(embedder) = fake_embedder(&w) else {
        eprintln!("skipping: `node` is not on PATH (the fake embedder needs it)");
        return;
    };
    bootstrap_with(&w, Some(&embedder));
    let db = w.path().join(".omgbase/omgbase.db");
    let mut s = Server::spawn(&w, &["--no-watch"], &[]);
    assert!(
        s.wait_stderr("auto-embed on mutation enabled", Duration::from_secs(10)),
        "{}",
        s.stderr()
    );
    let (res, err) = s.call(
        "docs_create",
        json!({ "path": "made.md", "markdown": format!("# Made\n\n{LONG_PARAGRAPH}\n") }),
    );
    assert!(!err, "{res}");
    // Close right away: the 500 ms debounce has not fired; shutdown flushes.
    let (status, stderr) = s.close();
    assert!(status.success(), "{stderr}");
    assert!(
        stderr.contains("semantic query enabled via fake-4"),
        "{stderr}"
    );
    assert!(stderr.contains("[mcp] embedded "), "{stderr}");
    assert!(!stderr.contains("embed drain failed"), "{stderr}");
    assert!(
        count(&db, "embeddings") >= 1,
        "the paragraph's vector is cached"
    );
    assert!(
        count(&db, "doc_embeddings") >= 1,
        "the document's vector too"
    );
    assert_eq!(
        embedder_spawns(&w),
        1,
        "the query path and the drain share one provider process"
    );
}
