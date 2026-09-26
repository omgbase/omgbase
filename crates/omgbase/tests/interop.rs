//! The cross-engine interop harness of `spec/surface` §7: every case of
//! `spec/surface/cases/interop.json` runs for every `(writer, reader)` in
//! `{typescript, rust}²`, both engines as **separate processes** speaking MCP
//! over stdio (newline-delimited JSON-RPC 2.0 — the reference server uses
//! the official SDK's `StdioServerTransport`, which frames the same way).
//!
//! Per case and pair (§7.2): a fresh temporary directory `W` gets the suite's
//! corpus as files; this harness bootstraps `W/.omgbase/omgbase.db` with the
//! Rust engine under the fixture minter (`ensure_repo("fixture", W)`, no
//! documents); the writer is spawned under the §7.1 seams, `observe_many`s
//! the corpus in bytewise path order, runs the case's `writes`, is closed;
//! the reader is spawned the same way and runs `reads`. Outcomes are recorded
//! as `reads.json` records them plus the `<workspace>` rewrite (§7.3) and
//! compared to `expect` within 1e-9.
//!
//! One `#[test]` per pair, each iterating every case and collecting a
//! report, so a failure names the pair, the case, the step, the tool and its
//! arguments, and shows the first differing path with both outcomes. The
//! `rust → rust` pair always runs; a pair involving the reference needs the
//! TypeScript peer (§7.4): `$OMGBASE_TS_MCP` (a command line the harness
//! extends with `mcp -C W --no-watch`) or `node <repo>/packages/cli/dist/src/main.js`.
//! Both engines run without a watcher (`--no-watch`): the seed must be the
//! harness's `observe_many`, not a priming sweep.
//! A missing peer fails those pairs with the build command unless
//! `OMGBASE_INTEROP=skip`.
//!
//! Harness-only knobs (not part of the spec): `OMGBASE_INTEROP_CASES=<file>`
//! runs a different suite file (developing a case before it is committed);
//! `OMGBASE_INTEROP_DUMP=<dir>` writes every pair's recorded outcomes as
//! `<case>.<writer>-<reader>.json` for side-by-side divergence analysis.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use omgbase_store::SequentialMinter;
use omgbase_sync::Workspace;
use serde_json::{Map as JsonMap, Value as Json, json};

mod common;
use common::TempDir;

const REPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
const SUITE_FILE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/surface/cases/interop.json"
);
const TS_PEER_DEFAULT: &str = "packages/cli/dist/src/main.js";
/// §7.2: the writer's clock when a case pins no `ts`.
const DEFAULT_TS: &str = "2026-09-27T00:00:00.000Z";
/// §7.2: the repo slug the harness bootstraps.
const FIXTURE_SLUG: &str = "fixture";
const EPS: f64 = 1e-9;
/// Reads over stdio wait this long for one reply (the TypeScript peer's
/// first call includes its startup).
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// After stdin EOF a peer gets this long to exit before it is killed.
const EXIT_GRACE: Duration = Duration::from_secs(15);
const MAX_REPORT_LINES: usize = 200;
const CLIP: usize = 1600;

// ---- engines and peers ------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Engine {
    TypeScript,
    Rust,
}

impl Engine {
    fn name(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript",
            Self::Rust => "rust",
        }
    }
}

/// §7.4: the command line that starts an engine's MCP server, before the
/// `mcp …` arguments the harness appends.
fn peer_command(engine: Engine) -> Result<Vec<String>, String> {
    match engine {
        Engine::Rust => Ok(vec![env!("CARGO_BIN_EXE_omgbase").to_owned()]),
        Engine::TypeScript => {
            if let Some(cmd) = std::env::var_os("OMGBASE_TS_MCP") {
                let argv: Vec<String> = cmd
                    .to_string_lossy()
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect();
                if !argv.is_empty() {
                    return Ok(argv);
                }
            }
            let main = Path::new(REPO_ROOT).join(TS_PEER_DEFAULT);
            if main.is_file() {
                Ok(vec!["node".to_owned(), main.to_string_lossy().into_owned()])
            } else {
                Err(format!(
                    "TypeScript peer missing: {} not found — build it with `pnpm build` at the repository root (or point $OMGBASE_TS_MCP at an `omg` command line)",
                    main.display()
                ))
            }
        }
    }
}

/// The `mcp` arguments for `engine` on workspace `w` (§7.2 step 2).
fn mcp_args(engine: Engine, w: &str) -> Vec<String> {
    match engine {
        Engine::Rust => vec![
            "mcp".into(),
            "--workspace".into(),
            w.to_owned(),
            "--no-watch".into(),
        ],
        Engine::TypeScript => vec!["mcp".into(), "-C".into(), w.to_owned(), "--no-watch".into()],
    }
}

// ---- a scratch workspace -------------------------------------------------------------

/// §7.2 step 1: the corpus as files and the database bootstrapped by this
/// engine under the fixture minter — repo `rp_0` (`fixture`) attached to the
/// `fs` source `fixture-fs` (`src_0`) rooted at `W`, no documents.
fn prepare_workspace(w: &TempDir, corpus: &BTreeMap<String, String>) -> Result<(), String> {
    for (path, source) in corpus {
        let file = w.0.join(path);
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        fs::write(&file, source).map_err(|e| format!("write {}: {e}", file.display()))?;
    }
    let mut ws = Workspace::open_with_minter(&w.0, Box::new(SequentialMinter::new()))
        .map_err(|e| format!("open workspace: {e}"))?;
    let root = w.path_str();
    let repo = omgbase_sync::ensure_repo(ws.store_mut(), FIXTURE_SLUG, Some(&root))
        .map_err(|e| format!("ensure_repo: {e}"))?;
    if repo != "rp_0" {
        return Err(format!("bootstrap minted repo {repo}, expected rp_0"));
    }
    ws.close().map_err(|e| format!("close workspace: {e}"))
}

// ---- the MCP client over a child process ---------------------------------------------

struct Peer {
    engine: Engine,
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Arc<Mutex<String>>,
    stderr_done: Option<thread::JoinHandle<()>>,
    next_id: i64,
}

impl Peer {
    /// Spawn `engine` on `w` under the §7.1 seams and run the MCP handshake.
    fn spawn(engine: Engine, w: &str, clock: &str) -> Result<Self, String> {
        let argv = peer_command(engine)?;
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..])
            .args(mcp_args(engine, w))
            .env("OMGBASE_SPEC_MINTER", "sequential")
            .env("OMGBASE_SPEC_CLOCK", clock)
            .env_remove("OMGBASE_WORKSPACE")
            .current_dir(REPO_ROOT)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn {} peer `{}`: {e}", engine.name(), argv.join(" ")))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr_pipe = child.stderr.take().expect("piped stderr");
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
        let stderr_done = thread::spawn(move || {
            let mut buf = String::new();
            let mut reader = BufReader::new(stderr_pipe);
            let _ = reader.read_to_string(&mut buf);
            *sink.lock().expect("stderr lock") = buf;
        });
        let mut peer = Self {
            engine,
            child,
            stdin: Some(stdin),
            lines,
            stderr,
            stderr_done: Some(stderr_done),
            next_id: 0,
        };
        peer.request(
            "initialize",
            json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "omgbase-interop", "version": env!("CARGO_PKG_VERSION") },
            }),
        )?;
        peer.notify("notifications/initialized")?;
        Ok(peer)
    }

    /// The peer's stderr so far; when the process has exited, the whole of
    /// it (the drain thread is given a moment to reach EOF).
    fn stderr_text(&self) -> String {
        if let Some(h) = &self.stderr_done {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !h.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
        }
        self.stderr.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn fail(&self, what: &str) -> String {
        let err = self.stderr_text();
        let err = err.trim();
        if err.is_empty() {
            format!("{} peer: {what}", self.engine.name())
        } else {
            format!(
                "{} peer: {what}\n  stderr: {}",
                self.engine.name(),
                clip(err, CLIP)
            )
        }
    }

    fn send(&mut self, msg: &Json) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| "peer stdin already closed".to_owned())?;
        writeln!(stdin, "{msg}")
            .and_then(|()| stdin.flush())
            .map_err(|e| self.fail(&format!("write: {e}")))
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method }))
    }

    /// One JSON-RPC request; the matching `result`, or the peer's error.
    fn request(&mut self, method: &str, params: Json) -> Result<Json, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let deadline = Instant::now() + CALL_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let line = self.lines.recv_timeout(remaining).map_err(|e| match e {
                mpsc::RecvTimeoutError::Timeout => {
                    self.fail(&format!("no reply to {method} within {CALL_TIMEOUT:?}"))
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    self.fail(&format!("stdout closed while waiting for {method}"))
                }
            })?;
            if line.trim().is_empty() {
                continue;
            }
            let msg: Json = match serde_json::from_str(&line) {
                Ok(m) => m,
                Err(_) => {
                    return Err(
                        self.fail(&format!("non-JSON line on stdout: {}", clip(&line, 300)))
                    );
                }
            };
            if msg.get("id") != Some(&json!(id)) {
                // A notification, or a server-initiated request: not ours.
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(self.fail(&format!("{method} failed: {err}")));
            }
            return msg
                .get("result")
                .cloned()
                .ok_or_else(|| self.fail(&format!("{method}: reply without result")));
        }
    }

    /// `tools/call`: the raw MCP result (`content`, `isError?`).
    fn call_tool(&mut self, name: &str, args: &Json) -> Result<Json, String> {
        self.request("tools/call", json!({ "name": name, "arguments": args }))
    }

    /// §7.2: stdin EOF, then wait for the exit (kill after a grace period).
    fn close(mut self) -> Result<(), String> {
        drop(self.stdin.take());
        let deadline = Instant::now() + EXIT_GRACE;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    if status.success() {
                        return Ok(());
                    }
                    return Err(self.fail(&format!("exited with {status}")));
                }
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
                Ok(None) => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    return Err(self.fail(&format!(
                        "did not exit within {EXIT_GRACE:?} after stdin EOF; killed"
                    )));
                }
                Err(e) => return Err(self.fail(&format!("wait: {e}"))),
            }
        }
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        // A peer dropped on an error path must not outlive the test.
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

// ---- recording (§7.3) ----------------------------------------------------------------------

/// The MCP result as the fixture records it: the parsed JSON of the single
/// text content item; an error result as `{ error, retriable, data? }`
/// (`message` dropped, `data` dropped for `filter_invalid`); `changes_since`
/// digests without `summary`; then the `<workspace>` rewrite.
fn record(tool: &str, result: &Json, w: &str) -> Result<Json, String> {
    let content = result
        .get("content")
        .and_then(Json::as_array)
        .ok_or_else(|| {
            format!(
                "{tool}: result without content: {}",
                clip(&result.to_string(), 300)
            )
        })?;
    if content.len() != 1 {
        return Err(format!(
            "{tool}: {} content items, expected one",
            content.len()
        ));
    }
    let text = content[0]
        .get("text")
        .and_then(Json::as_str)
        .ok_or_else(|| format!("{tool}: content item is not text"))?;
    let is_error = result
        .get("isError")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let mut body: Json = match serde_json::from_str(text) {
        Ok(v) => v,
        // The reference reports an argument-shape failure as plain text
        // ("MCP error -32602: …"); unpinned (§9), recorded verbatim so the
        // comparison shows it.
        Err(_) if is_error => return Ok(Json::String(rewrite_workspace_str(text, w))),
        Err(e) => {
            return Err(format!(
                "{tool}: result text is not JSON ({e}): {}",
                clip(text, 300)
            ));
        }
    };
    if is_error {
        if let Some(o) = body.as_object_mut() {
            o.remove("message");
            if o.get("error").and_then(Json::as_str) == Some("filter_invalid") {
                o.remove("data");
            }
        }
    } else if tool == "changes_since" {
        if let Some(digests) = body.get_mut("digests").and_then(Json::as_array_mut) {
            for d in digests {
                if let Some(o) = d.as_object_mut() {
                    o.remove("summary");
                }
            }
        }
    }
    Ok(rewrite_workspace(body, w))
}

/// §7.3: every string equal to `W`, or beginning with `W/`, has that prefix
/// replaced by `<workspace>`.
fn rewrite_workspace_str(s: &str, w: &str) -> String {
    if s == w {
        "<workspace>".to_owned()
    } else if let Some(rest) = s.strip_prefix(w).filter(|r| r.starts_with('/')) {
        format!("<workspace>{rest}")
    } else {
        s.to_owned()
    }
}

fn rewrite_workspace(v: Json, w: &str) -> Json {
    match v {
        Json::String(s) => Json::String(rewrite_workspace_str(&s, w)),
        Json::Array(items) => {
            Json::Array(items.into_iter().map(|i| rewrite_workspace(i, w)).collect())
        }
        Json::Object(map) => Json::Object(
            map.into_iter()
                .map(|(k, v)| (k, rewrite_workspace(v, w)))
                .collect(),
        ),
        other => other,
    }
}

// ---- the suite -------------------------------------------------------------------------------

struct Step {
    tool: String,
    args: Json,
}

struct Case {
    name: String,
    ts: String,
    writes: Vec<Step>,
    reads: Vec<Step>,
    expect: Json,
}

struct Suite {
    corpus: BTreeMap<String, String>,
    cases: Vec<Case>,
}

fn suite_path() -> PathBuf {
    std::env::var_os("OMGBASE_INTEROP_CASES")
        .map_or_else(|| PathBuf::from(SUITE_FILE), PathBuf::from)
}

fn steps_of(v: Option<&Json>, what: &str, case: &str) -> Result<Vec<Step>, String> {
    let Some(v) = v else {
        return Ok(Vec::new());
    };
    v.as_array()
        .ok_or_else(|| format!("{case}: `{what}` must be an array"))?
        .iter()
        .enumerate()
        .map(|(i, s)| {
            Ok(Step {
                tool: s
                    .get("tool")
                    .and_then(Json::as_str)
                    .ok_or_else(|| format!("{case}: {what}[{i}].tool missing"))?
                    .to_owned(),
                args: s.get("args").cloned().unwrap_or_else(|| json!({})),
            })
        })
        .collect()
}

fn load_suite() -> Result<Suite, String> {
    let path = suite_path();
    let text = fs::read_to_string(&path).map_err(|e| {
        format!(
            "cannot read the interop suite {} ({e}); it is generated by the reference (`SURFACE_SPEC_UPDATE=1` on packages/core/corpus/surface/spec.test.ts)",
            path.display()
        )
    })?;
    let doc: Json = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let corpus = doc
        .get("corpus")
        .and_then(Json::as_object)
        .ok_or("suite without a `corpus` object")?
        .iter()
        .map(|(k, v)| {
            v.as_str()
                .map(|s| (k.clone(), s.to_owned()))
                .ok_or_else(|| format!("corpus[{k}] is not a string"))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    if corpus.is_empty() {
        return Err("suite with an empty corpus".to_owned());
    }
    let cases = doc
        .get("cases")
        .and_then(Json::as_array)
        .ok_or("suite without a `cases` array")?
        .iter()
        .map(|c| {
            let name = c
                .get("name")
                .and_then(Json::as_str)
                .ok_or("case without a name")?
                .to_owned();
            Ok(Case {
                ts: c
                    .get("ts")
                    .and_then(Json::as_str)
                    .unwrap_or(DEFAULT_TS)
                    .to_owned(),
                writes: steps_of(c.get("writes"), "writes", &name)?,
                reads: steps_of(c.get("reads"), "reads", &name)?,
                expect: c
                    .get("expect")
                    .cloned()
                    .ok_or_else(|| format!("{name}: no expect"))?,
                name,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    if cases.is_empty() {
        return Err("suite without cases".to_owned());
    }
    let mut seen = BTreeSet::new();
    for c in &cases {
        if !seen.insert(c.name.as_str()) {
            return Err(format!("duplicate case name {}", c.name));
        }
    }
    Ok(Suite { corpus, cases })
}

// ---- running a case for one pair (§7.2) --------------------------------------------------------

struct Recorded {
    /// One entry per `writes` step (the seeding `observe_many` is checked,
    /// not recorded — the reference harness does the same).
    writes: Vec<Json>,
    reads: Vec<Json>,
}

/// The seeding `observe_many` must have observed every corpus file in order,
/// minting `d_0, d_1, …` (§6/§7.2: `d_0` is `index.md`), none an echo — the
/// proof that the writer's minter seam is active.
fn check_seed(outcome: &Json, paths: &[&String], writer: Engine) -> Result<(), String> {
    let bad = |why: String| {
        format!(
            "{} writer: the seeding observe_many {why}\n    {}",
            writer.name(),
            clip(&outcome.to_string(), 2000)
        )
    };
    let items = outcome
        .as_array()
        .ok_or_else(|| bad("did not return an array".into()))?;
    if items.len() != paths.len() {
        return Err(bad(format!(
            "returned {} outcomes for {} files",
            items.len(),
            paths.len()
        )));
    }
    for (i, (o, path)) in items.iter().zip(paths).enumerate() {
        if o.get("path").and_then(Json::as_str) != Some(path.as_str()) {
            return Err(bad(format!(
                "outcome {i} is for {}, expected {path}",
                o["path"]
            )));
        }
        let want = format!("d_{i}");
        if o.get("docId").and_then(Json::as_str) != Some(want.as_str()) {
            return Err(bad(format!(
                "outcome {i} minted {}, expected {want} (is the minter seam active?)",
                o["docId"]
            )));
        }
        if o.get("echo") != Some(&Json::Bool(false)) {
            return Err(bad(format!("outcome {i} has echo {}", o["echo"])));
        }
    }
    Ok(())
}

fn run_pair(
    suite: &Suite,
    case: &Case,
    writer: Engine,
    reader: Engine,
) -> Result<Recorded, String> {
    let w = TempDir::new(
        "interop",
        &case.name.replace(|c: char| !c.is_ascii_alphanumeric(), "-"),
    );
    let w_str = w.path_str();
    prepare_workspace(&w, &suite.corpus)?;

    let mut writes = Vec::with_capacity(case.writes.len());
    let mut peer = Peer::spawn(writer, &w_str, &case.ts)?;
    let files: Vec<Json> = suite
        .corpus
        .iter()
        .map(|(path, content)| json!({ "path": path, "content": content }))
        .collect();
    let seed = peer.call_tool("observe_many", &json!({ "files": files }))?;
    let paths: Vec<&String> = suite.corpus.keys().collect();
    check_seed(&record("observe_many", &seed, &w_str)?, &paths, writer)?;
    for step in &case.writes {
        let out = peer.call_tool(&step.tool, &step.args)?;
        writes.push(record(&step.tool, &out, &w_str)?);
    }
    peer.close()?;

    let mut reads = Vec::with_capacity(case.reads.len());
    let mut peer = Peer::spawn(reader, &w_str, &case.ts)?;
    for step in &case.reads {
        let out = peer.call_tool(&step.tool, &step.args)?;
        reads.push(record(&step.tool, &out, &w_str)?);
    }
    peer.close()?;
    Ok(Recorded { writes, reads })
}

// ---- comparison ------------------------------------------------------------------------------------

/// Deep-compare two JSON values, object key order ignored, numbers within
/// `eps`. `None` when equal, else the path and values of the first difference.
fn deep_eq_tol(a: &Json, b: &Json, path: &str, eps: f64) -> Option<String> {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            if (x - y).abs() <= eps || (x.is_nan() && y.is_nan()) {
                None
            } else {
                Some(format!("{path}: {x} vs {y}"))
            }
        }
        (Json::Array(x), Json::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{path}: length {} vs {}", x.len(), y.len()));
            }
            x.iter()
                .zip(y)
                .enumerate()
                .find_map(|(i, (p, q))| deep_eq_tol(p, q, &format!("{path}[{i}]"), eps))
        }
        (Json::Object(x), Json::Object(y)) => {
            let ka: BTreeSet<&String> = x.keys().collect();
            let kb: BTreeSet<&String> = y.keys().collect();
            if ka != kb {
                let only_a: Vec<&str> = ka.difference(&kb).map(|k| k.as_str()).collect();
                let only_b: Vec<&str> = kb.difference(&ka).map(|k| k.as_str()).collect();
                return Some(format!(
                    "{path}: keys differ (actual only: {{{}}}, expected only: {{{}}})",
                    only_a.join(","),
                    only_b.join(",")
                ));
            }
            ka.into_iter()
                .find_map(|k| deep_eq_tol(&x[k], &y[k], &format!("{path}.{k}"), eps))
        }
        (Json::Array(_), _) | (_, Json::Array(_)) => Some(format!("{path}: array vs non-array")),
        (Json::Object(_), _) | (_, Json::Object(_)) => {
            Some(format!("{path}: object vs non-object"))
        }
        _ => (a != b).then(|| format!("{path}: {a} vs {b}")),
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_owned()
    } else {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}… [{} more bytes]", &s[..end], s.len() - end)
    }
}

/// One step's mismatch report — the step label, the tool and its arguments,
/// the first differing path, both outcomes — or `None` when equal.
fn compare_step(
    label: &str,
    tool: &str,
    args: &Json,
    actual: &Json,
    expect: &Json,
) -> Option<String> {
    if tool == "query_syntax" {
        return None; // §7.3: unpinned text.
    }
    deep_eq_tol(actual, expect, "", EPS).map(|diff| {
        format!(
            "  {label} {tool} {}\n    diff{diff}\n    actual:   {}\n    expected: {}",
            clip(&args.to_string(), 400),
            clip(&actual.to_string(), CLIP),
            clip(&expect.to_string(), CLIP)
        )
    })
}

/// Every mismatch of one recorded run against the case's `expect`.
fn mismatches(case: &Case, rec: &Recorded) -> Vec<String> {
    let mut out = Vec::new();
    let exp_writes = case
        .expect
        .get("writes")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    if exp_writes.len() != case.writes.len() {
        out.push(format!(
            "  {}: expect.writes has {} entries for {} writes",
            case.name,
            exp_writes.len(),
            case.writes.len()
        ));
    } else {
        for (i, step) in case.writes.iter().enumerate() {
            out.extend(compare_step(
                &format!("writes[{i}]"),
                &step.tool,
                &step.args,
                &rec.writes[i],
                &exp_writes[i],
            ));
        }
    }
    let exp_reads = case
        .expect
        .get("reads")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    if exp_reads.len() != case.reads.len() {
        out.push(format!(
            "  {}: expect.reads has {} entries for {} reads",
            case.name,
            exp_reads.len(),
            case.reads.len()
        ));
    } else {
        for (i, step) in case.reads.iter().enumerate() {
            out.extend(compare_step(
                &format!("reads[{i}]"),
                &step.tool,
                &step.args,
                &rec.reads[i],
                &exp_reads[i],
            ));
        }
    }
    out
}

fn dump(case: &Case, writer: Engine, reader: Engine, rec: &Recorded) {
    let Some(dir) = std::env::var_os("OMGBASE_INTEROP_DUMP") else {
        return;
    };
    let dir = PathBuf::from(dir);
    let _ = fs::create_dir_all(&dir);
    let file = dir.join(format!(
        "{}.{}-{}.json",
        case.name,
        writer.name(),
        reader.name()
    ));
    let mut o = JsonMap::new();
    o.insert("writes".into(), Json::Array(rec.writes.clone()));
    o.insert("reads".into(), Json::Array(rec.reads.clone()));
    let _ = fs::write(
        &file,
        serde_json::to_string_pretty(&Json::Object(o)).unwrap_or_default(),
    );
}

// ---- driving --------------------------------------------------------------------------------------------

/// Run every case for `(writer, reader)`; panic with the collected report on
/// any failure.
fn run_pairing(writer: Engine, reader: Engine) {
    let pair = format!("{} → {}", writer.name(), reader.name());
    for engine in [writer, reader] {
        if let Err(missing) = peer_command(engine) {
            if std::env::var("OMGBASE_INTEROP").is_ok_and(|v| v == "skip") {
                eprintln!("interop [{pair}] SKIPPED (OMGBASE_INTEROP=skip): {missing}");
                return;
            }
            panic!("interop [{pair}]: {missing}");
        }
    }
    let suite = load_suite().unwrap_or_else(|e| panic!("interop [{pair}]: {e}"));
    let mut report: Vec<String> = Vec::new();
    let mut failed = 0usize;
    for case in &suite.cases {
        match run_pair(&suite, case, writer, reader) {
            Err(e) => {
                failed += 1;
                report.push(format!("[{pair}] {}: {e}", case.name));
            }
            Ok(rec) => {
                dump(case, writer, reader, &rec);
                let bad = mismatches(case, &rec);
                if !bad.is_empty() {
                    failed += 1;
                    report.push(format!(
                        "[{pair}] {}: {} mismatch(es)",
                        case.name,
                        bad.len()
                    ));
                    report.extend(bad);
                }
            }
        }
    }
    let total = suite.cases.len();
    eprintln!(
        "interop [{pair}]: {} of {total} case(s) passed",
        total - failed
    );
    if failed > 0 {
        let mut lines: Vec<String> = report
            .iter()
            .flat_map(|r| r.lines().map(str::to_owned))
            .collect();
        if lines.len() > MAX_REPORT_LINES {
            let more = lines.len() - MAX_REPORT_LINES;
            lines.truncate(MAX_REPORT_LINES);
            lines.push(format!("… {more} more line(s)"));
        }
        panic!(
            "interop [{pair}]: {failed} of {total} case(s) failed\n{}",
            lines.join("\n")
        );
    }
}

#[test]
fn rust_writes_rust_reads() {
    run_pairing(Engine::Rust, Engine::Rust);
}

#[test]
fn typescript_writes_typescript_reads() {
    run_pairing(Engine::TypeScript, Engine::TypeScript);
}

#[test]
fn typescript_writes_rust_reads() {
    run_pairing(Engine::TypeScript, Engine::Rust);
}

#[test]
fn rust_writes_typescript_reads() {
    run_pairing(Engine::Rust, Engine::TypeScript);
}

#[test]
fn workspace_rewrite_replaces_the_prefix_only() {
    let w = "/tmp/omgbase-interop-x";
    let v = json!({
        "a": w,
        "b": format!("{w}/notes/a.md"),
        "c": format!("{w}-other/a.md"),
        "d": [w, 1, null],
        "e": { "root": format!("{w}/") },
    });
    assert_eq!(
        rewrite_workspace(v, w),
        json!({
            "a": "<workspace>",
            "b": "<workspace>/notes/a.md",
            "c": format!("{w}-other/a.md"),
            "d": ["<workspace>", 1, null],
            "e": { "root": "<workspace>/" },
        })
    );
}

#[test]
fn record_normalizes_like_reads_json() {
    let ok = json!({ "content": [{ "type": "text", "text": "{\"digests\":[{\"summary\":\"x\",\"seq\":1}]}" }] });
    assert_eq!(
        record("changes_since", &ok, "/w").unwrap(),
        json!({ "digests": [{ "seq": 1 }] })
    );
    let err = json!({
        "isError": true,
        "content": [{ "type": "text", "text": "{\"error\":\"filter_invalid\",\"message\":\"m\",\"data\":{\"reason\":\"r\"},\"retriable\":false}" }],
    });
    assert_eq!(
        record("query", &err, "/w").unwrap(),
        json!({ "error": "filter_invalid", "retriable": false })
    );
    let err2 = json!({
        "isError": true,
        "content": [{ "type": "text", "text": "{\"error\":\"doc_missing\",\"message\":\"m\",\"data\":{\"doc\":\"x\"},\"retriable\":false}" }],
    });
    assert_eq!(
        record("docs_read", &err2, "/w").unwrap(),
        json!({ "error": "doc_missing", "data": { "doc": "x" }, "retriable": false })
    );
}
