//! The built binary over a temp directory, driven through the stdio
//! protocol of `spec/sync` §5 exactly as an engine would: handshake,
//! `enumerate`, `fetch` present and absent, `write` + `fetch`, `remove`,
//! `watch` → `ready` → a touched file → a batch naming it → `unwatch`, an
//! unknown method, a non-JSON line, then stdin EOF → exit 0.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const HANDSHAKE: &str =
    r#"{"protocol":1,"capabilities":{"identity":"inferred","writeThrough":true,"watch":true}}"#;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir();
        let base = std::fs::canonicalize(&base).unwrap_or(base);
        let dir = base.join(format!(
            "omgbase-fsadapter-proto-{}-{tag}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Adapter {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    next_id: u64,
}

impl Adapter {
    fn spawn(root: &Path, extra: &[&str]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_omgbase-fs-adapter"))
            .arg("--root")
            .arg(root)
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn omgbase-fs-adapter");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(l) = line else { break };
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin: Some(stdin),
            lines,
            next_id: 0,
        }
    }

    fn line(&self, timeout: Duration) -> String {
        self.lines
            .recv_timeout(timeout)
            .unwrap_or_else(|e| panic!("no line from the adapter within {timeout:?}: {e}"))
    }

    fn send_raw(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    /// One request; the raw response line (an event line arriving first is
    /// returned to the caller by `line`, so callers sequence explicitly).
    fn call(&mut self, method: &str, params: Value) -> (u64, String) {
        self.next_id += 1;
        let id = self.next_id;
        self.send_raw(&json!({ "id": id, "method": method, "params": params }).to_string());
        (id, self.line(Duration::from_secs(10)))
    }

    fn close(mut self) -> i32 {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match self.child.try_wait().unwrap() {
                Some(status) => return status.code().unwrap_or(-1),
                None if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                None => {
                    let _ = self.child.kill();
                    panic!("the adapter did not exit on stdin EOF");
                }
            }
        }
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn revision_ok(v: &Value) -> bool {
    v.as_str()
        .and_then(|s| s.split_once(':'))
        .is_some_and(|(a, b)| a.parse::<u128>().is_ok() && b.parse::<u64>().is_ok())
}

#[test]
fn the_protocol_end_to_end() {
    let t = TempDir::new("e2e");
    let root = t.path();
    std::fs::write(root.join("a.md"), "# A\n\nalpha\n").unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(root.join("sub/b.md"), "# B\n").unwrap();
    std::fs::write(root.join("notes.txt"), "no\n").unwrap();
    std::fs::create_dir_all(root.join(".omgbase")).unwrap();
    std::fs::write(root.join(".omgbase/x.md"), "no\n").unwrap();

    let mut a = Adapter::spawn(root, &["--debounce-ms", "100"]);
    assert_eq!(a.line(Duration::from_secs(10)), HANDSHAKE);

    // enumerate: the walk with stat revisions, in order, wire shape exact.
    let (id, resp) = a.call("enumerate", json!({}));
    let v: Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(v["id"], id);
    let entries = v["result"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["path"], "a.md");
    assert_eq!(entries[1]["path"], "sub/b.md");
    assert!(revision_ok(&entries[0]["revision"]), "{resp}");
    assert!(
        resp.starts_with(&format!(
            r#"{{"id":{id},"result":{{"entries":[{{"path":"a.md","revision":""#
        )),
        "key order as the reference: {resp}"
    );

    // fetch present / absent.
    let (id, resp) = a.call("fetch", json!({ "path": "a.md" }));
    let v: Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(v["id"], id);
    assert_eq!(v["result"]["item"]["path"], "a.md");
    assert_eq!(v["result"]["item"]["content"], "# A\n\nalpha\n");
    assert!(revision_ok(&v["result"]["item"]["revision"]));
    assert!(
        resp.contains(r#""item":{"path":"a.md","revision":""#),
        "{resp}"
    );
    let (id, resp) = a.call("fetch", json!({ "path": "nope.md" }));
    assert_eq!(resp, format!(r#"{{"id":{id},"result":{{"item":null}}}}"#));

    // write + fetch, then remove.
    let (id, resp) = a.call(
        "write",
        json!({ "path": "new/deep/c.md", "content": "# C\n" }),
    );
    assert_eq!(resp, format!(r#"{{"id":{id},"result":{{"ok":true}}}}"#));
    assert_eq!(
        std::fs::read_to_string(root.join("new/deep/c.md")).unwrap(),
        "# C\n"
    );
    let (_, resp) = a.call("fetch", json!({ "path": "new/deep/c.md" }));
    let v: Value = serde_json::from_str(&resp).unwrap();
    assert_eq!(v["result"]["item"]["content"], "# C\n");
    let (id, resp) = a.call("remove", json!({ "path": "new/deep/c.md" }));
    assert_eq!(resp, format!(r#"{{"id":{id},"result":{{"ok":true}}}}"#));
    assert!(!root.join("new/deep/c.md").exists());
    let (id, resp) = a.call("remove", json!({ "path": "new/deep/c.md" }));
    assert_eq!(
        resp,
        format!(r#"{{"id":{id},"result":{{"ok":true}}}}"#),
        "absent is fine"
    );

    // Unknown method, and a line that is not JSON (no id).
    let (id, resp) = a.call("frobnicate", json!({}));
    assert_eq!(
        resp,
        format!(r#"{{"id":{id},"error":"unknown method: frobnicate"}}"#)
    );
    a.send_raw("this is not json");
    assert_eq!(
        a.line(Duration::from_secs(10)),
        r#"{"error":"invalid request JSON: this is not json"}"#
    );

    // watch → ack → ready.
    let (id, resp) = a.call("watch", json!({}));
    assert_eq!(resp, format!(r#"{{"id":{id},"result":{{"ok":true}}}}"#));
    assert_eq!(a.line(Duration::from_secs(10)), r#"{"event":"ready"}"#);
    // Let the OS stream settle (macOS FSEvents can replay a recent write).
    std::thread::sleep(Duration::from_millis(400));
    while a.lines.try_recv().is_ok() {}

    // A touched file arrives in one batch; a non-matching one does not.
    std::fs::write(root.join("sub/b.md"), "# B\n\nedited\n").unwrap();
    std::fs::write(root.join("notes.txt"), "still no\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut seen: Vec<String> = Vec::new();
    while Instant::now() < deadline && !seen.iter().any(|p| p == "sub/b.md") {
        if let Ok(line) = a.lines.recv_timeout(Duration::from_millis(200)) {
            let v: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(v["event"], "batch", "{line}");
            seen.extend(
                v["paths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p.as_str().unwrap().to_owned()),
            );
        }
    }
    assert!(seen.iter().any(|p| p == "sub/b.md"), "{seen:?}");
    assert!(!seen.iter().any(|p| p == "notes.txt"), "{seen:?}");

    // unwatch → ack, and the feed is silent afterwards.
    let (id, resp) = a.call("unwatch", json!({}));
    assert_eq!(resp, format!(r#"{{"id":{id},"result":{{"ok":true}}}}"#));
    std::fs::write(root.join("after.md"), "# after\n").unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(a.lines.try_recv().is_err(), "no batch after unwatch");

    // stdin EOF → exit 0.
    assert_eq!(a.close(), 0);
}

#[test]
fn eof_while_watching_exits_zero() {
    let t = TempDir::new("eof");
    std::fs::write(t.path().join("a.md"), "# A\n").unwrap();
    let mut a = Adapter::spawn(t.path(), &["--debounce-ms", "100"]);
    assert_eq!(a.line(Duration::from_secs(10)), HANDSHAKE);
    let (_, resp) = a.call("watch", json!({}));
    assert!(resp.contains(r#""result":{"ok":true}"#));
    assert_eq!(a.line(Duration::from_secs(10)), r#"{"event":"ready"}"#);
    assert_eq!(a.close(), 0);
}

#[test]
fn a_missing_root_flag_is_a_usage_error() {
    let out = Command::new(env!("CARGO_BIN_EXE_omgbase-fs-adapter"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("--root <path> is required"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
