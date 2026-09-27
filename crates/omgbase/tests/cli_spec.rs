//! The CLI spec conformance runner (`spec/cli/README.md` §8): every case
//! under `spec/cli/cases` is run against the Rust `omgbase` binary — spawned
//! with the case's argv, stdin and environment in a scratch workspace under
//! the two conformance seams — and its exit code, stdout and (when pinned)
//! stderr compared to the committed `expect`, byte for byte after the
//! `<workspace>` rewrite.
//!
//! Gated by the allowlist `tests/cli-spec-passing.txt` (one `<suite>::<name>`
//! per line): a listed case that fails fails the test; an unlisted case is
//! reported as "not yet" without failing; an unlisted case that passes is
//! reported so it can be promoted. `CLI_SPEC_UPDATE=1` rewrites the allowlist
//! from the currently passing set.
//!
//! The workspace of §8 is built with this engine's library, equivalently to
//! the reference's `init --yes --no-embedder` + `source add vault --repo
//! fixture -y`: `Workspace::open_with_minter` (the fixture minter),
//! `ensure_repo("fixture", <tmp>/vault)`, one `freshness_sweep` at the spec
//! clock, `rebuild_file_stats`. The two engines write the same rows and mint
//! the same ids (`spec/sync` pins the bootstrap; `spec/store` the minter), so
//! `d_0` is `index.md` and `cp_0` is the bootstrap sweep in both.
//!
//! The binary under test is `$OMGBASE_RUST_BIN` when set, else the one cargo
//! built for this test (`target/debug/omgbase`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use omgbase_store::{Config, SequentialMinter};
use omgbase_sync::{RealFileSystem, Workspace, ensure_repo, freshness_sweep, rebuild_file_stats};
use serde_json::Value as Json;

mod common;
use common::TempDir;

const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/cli/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cli-spec-passing.txt");
const ALCHEMY_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/core/corpus/oqx/fixtures/alchemy"
);
/// §8: the clock every case runs under.
const SPEC_CLOCK: &str = "2026-09-27T00:00:00.000Z";
/// §8: the alchemy workspace's repo slug.
const FIXTURE_SLUG: &str = "fixture";
/// §8: the placeholder for `<tmp>` in inputs and outputs.
const WORKSPACE_TOKEN: &str = "<workspace>";
const VERSION_TOKEN: &str = "<version>";
/// A wedged child fails loudly instead of hanging the test.
const SPAWN_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_REPORT_LINES: usize = 400;

// ---- the fixture shape (README §8) ---------------------------------------------------

#[derive(Clone, Debug)]
struct Expect {
    exit: i64,
    stdout: String,
    stderr: Option<String>,
}

#[derive(Clone, Debug)]
struct Step {
    argv: Vec<String>,
    stdin: Option<String>,
    env: BTreeMap<String, String>,
    files: Vec<(String, Option<String>)>,
    expect: Expect,
}

#[derive(Clone, Debug)]
struct Case {
    id: String,
    workspace: String,
    env: BTreeMap<String, String>,
    files: Vec<(String, Option<String>)>,
    steps: Vec<Step>,
}

fn str_map(v: Option<&Json>) -> BTreeMap<String, String> {
    v.and_then(Json::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn files_of(v: Option<&Json>) -> Vec<(String, Option<String>)> {
    v.and_then(Json::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned)))
                .collect()
        })
        .unwrap_or_default()
}

fn expect_of(v: &Json, at: &str) -> Result<Expect, String> {
    let e = v.get("expect").ok_or_else(|| {
        format!("{at}: missing `expect` (run CLI_SPEC_UPDATE=1 on the reference)")
    })?;
    Ok(Expect {
        exit: e
            .get("exit")
            .and_then(Json::as_i64)
            .ok_or_else(|| format!("{at}: expect.exit must be a number"))?,
        stdout: e
            .get("stdout")
            .and_then(Json::as_str)
            .ok_or_else(|| format!("{at}: expect.stdout must be a string"))?
            .to_owned(),
        stderr: e.get("stderr").and_then(Json::as_str).map(str::to_owned),
    })
}

fn step_of(v: &Json, at: &str) -> Result<Step, String> {
    let argv = v
        .get("argv")
        .and_then(Json::as_array)
        .ok_or_else(|| format!("{at}: missing argv"))?
        .iter()
        .map(|a| {
            a.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{at}: argv must be strings"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Step {
        argv,
        stdin: v.get("stdin").and_then(Json::as_str).map(str::to_owned),
        env: str_map(v.get("env")),
        files: files_of(v.get("files")),
        expect: expect_of(v, at)?,
    })
}

fn load_suites() -> Result<Vec<(String, Vec<Case>)>, String> {
    let mut files: Vec<PathBuf> = fs::read_dir(CASES_DIR)
        .map_err(|e| format!("read {CASES_DIR}: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let mut out = Vec::new();
    for file in files {
        let text =
            fs::read_to_string(&file).map_err(|e| format!("read {}: {e}", file.display()))?;
        let doc: Json =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
        let suite = doc
            .get("suite")
            .and_then(Json::as_str)
            .ok_or_else(|| format!("{}: missing `suite`", file.display()))?
            .to_owned();
        let mut cases = Vec::new();
        for (i, c) in doc
            .get("cases")
            .and_then(Json::as_array)
            .ok_or_else(|| format!("{}: missing `cases`", file.display()))?
            .iter()
            .enumerate()
        {
            let name = c
                .get("name")
                .and_then(Json::as_str)
                .ok_or_else(|| format!("{}[{i}]: missing name", file.display()))?;
            let at = format!("{suite}::{name}");
            let steps = match c.get("steps").and_then(Json::as_array) {
                Some(steps) => steps
                    .iter()
                    .enumerate()
                    .map(|(j, s)| step_of(s, &format!("{at}.steps[{j}]")))
                    .collect::<Result<Vec<_>, _>>()?,
                None => vec![step_of(c, &at)?],
            };
            cases.push(Case {
                id: at,
                workspace: c
                    .get("workspace")
                    .and_then(Json::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                env: str_map(c.get("env")),
                files: files_of(c.get("files")),
                steps,
            });
        }
        out.push((suite, cases));
    }
    Ok(out)
}

// ---- the workspace (README §8) ------------------------------------------------------

/// The binary under test.
fn binary() -> PathBuf {
    std::env::var_os("OMGBASE_RUST_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_omgbase")))
}

/// §2.4: the CLI quotes itself as `basename(argv[0])`, and the fixtures were
/// recorded through the reference's `omg` bin, so the binary is spawned
/// through a symlink named `omg` (a copy on a platform without symlinks).
fn omg_link(bin: &Path, dir: &Path) -> PathBuf {
    let link = dir.join("omg");
    #[cfg(unix)]
    {
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(bin, &link).expect("symlink the binary as omg");
    }
    #[cfg(not(unix))]
    {
        fs::copy(bin, &link).expect("copy the binary as omg");
    }
    link
}

/// Every `*.md` under the alchemy corpus as `(relative posix path, bytes)`, bytewise order.
fn read_corpus() -> Result<Vec<(String, String)>, String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out)?;
            } else if path.extension().is_some_and(|x| x == "md") {
                let rel = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                let bytes = fs::read_to_string(&path)
                    .map_err(|e| format!("read {}: {e}", path.display()))?;
                out.push((rel, bytes));
            }
        }
        Ok(())
    }
    let root = Path::new(ALCHEMY_DIR);
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Ok(out)
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("mkdir {}: {e}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|e| format!("read {}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("copy {}: {e}", src.display()))?;
        }
    }
    Ok(())
}

fn empty_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| format!("clear {}: {e}", dir.display()))?;
    }
    fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    Ok(())
}

fn write_files(tmp: &Path, files: &[(String, Option<String>)]) -> Result<(), String> {
    for (rel, content) in files {
        let abs = tmp.join(rel);
        match content {
            None => {
                if abs.exists() {
                    fs::remove_file(&abs).map_err(|e| format!("rm {}: {e}", abs.display()))?;
                }
            }
            Some(text) => {
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
                }
                let tmp_str = tmp.to_string_lossy();
                fs::write(&abs, text.replace(WORKSPACE_TOKEN, &tmp_str))
                    .map_err(|e| format!("write {}: {e}", abs.display()))?;
                #[cfg(unix)]
                if rel.ends_with(".sh") {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&abs, fs::Permissions::from_mode(0o755))
                        .map_err(|e| format!("chmod {}: {e}", abs.display()))?;
                }
            }
        }
    }
    Ok(())
}

/// §8: re-record `file_stats` after a copy (a copy loses nanosecond mtimes; the call mints nothing).
fn rewarm_stat_cache(tmp: &Path) -> Result<(), String> {
    let ws = Workspace::open(tmp).map_err(|e| format!("open workspace: {e}"))?;
    let repos = ws.repos().map_err(|e| format!("repos: {e}"))?;
    for repo in repos {
        if let Some(root) = repo.root_path.as_deref() {
            rebuild_file_stats(ws.store(), &repo.repo_id, &RealFileSystem, Path::new(root))
                .map_err(|e| format!("rebuild_file_stats: {e}"))?;
        }
    }
    ws.close().map_err(|e| format!("close workspace: {e}"))
}

/// The run's scratch area: one fixed `<tmp>` every case runs in, and the
/// `alchemy` / `empty` templates built once and copied in per case.
struct Workspaces {
    root: TempDir,
    tmp: PathBuf,
    templates: BTreeMap<String, PathBuf>,
}

impl Workspaces {
    fn new() -> Self {
        let root = TempDir::new("cli-spec", "run");
        let tmp = root.path().join("ws");
        fs::create_dir_all(&tmp).expect("scratch dir");
        Self {
            root,
            tmp,
            templates: BTreeMap::new(),
        }
    }

    fn scaffold(&self) -> Result<(), String> {
        empty_dir(&self.tmp)?;
        fs::create_dir_all(self.tmp.join("home")).map_err(|e| e.to_string())?;
        fs::create_dir_all(self.tmp.join("tmp")).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Build the template for `kind` in place (at `<tmp>`), snapshot it.
    fn template(&mut self, kind: &str) -> Result<Option<PathBuf>, String> {
        if kind == "none" {
            return Ok(None);
        }
        if let Some(t) = self.templates.get(kind) {
            return Ok(Some(t.clone()));
        }
        self.scaffold()?;
        let vault = self.tmp.join("vault");
        if kind == "alchemy" {
            for (rel, bytes) in read_corpus()? {
                let abs = vault.join(&rel);
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&abs, bytes).map_err(|e| format!("write {}: {e}", abs.display()))?;
            }
        }
        // `init --yes --no-embedder`: the workspace and its database.
        let mut ws = Workspace::open_with_minter(&self.tmp, Box::new(SequentialMinter::new()))
            .map_err(|e| format!("open workspace: {e}"))?;
        if kind == "alchemy" {
            // `source add vault --repo fixture -y`: repo + fs source, the initial sweep, the stat cache.
            let root = vault.to_string_lossy().into_owned();
            let repo = ensure_repo(ws.store_mut(), FIXTURE_SLUG, Some(&root))
                .map_err(|e| format!("ensure_repo: {e}"))?;
            if repo != "rp_0" {
                return Err(format!("bootstrap minted repo {repo}, expected rp_0"));
            }
            freshness_sweep(
                ws.store_mut(),
                &repo,
                &RealFileSystem,
                &vault,
                SPEC_CLOCK,
                None,
                &Config::default(),
            )
            .map_err(|e| format!("freshness_sweep: {e}"))?;
            rebuild_file_stats(ws.store(), &repo, &RealFileSystem, &vault)
                .map_err(|e| format!("rebuild_file_stats: {e}"))?;
        }
        ws.close().map_err(|e| format!("close workspace: {e}"))?;
        let snapshot = self.root.path().join(format!("template-{kind}"));
        copy_tree(&self.tmp, &snapshot)?;
        self.templates.insert(kind.to_owned(), snapshot.clone());
        Ok(Some(snapshot))
    }

    /// Reset `<tmp>` to a fresh workspace of `kind`.
    fn prepare(&mut self, kind: &str) -> Result<PathBuf, String> {
        let tpl = self.template(kind)?;
        empty_dir(&self.tmp)?;
        match tpl {
            Some(tpl) => {
                copy_tree(&tpl, &self.tmp)?;
                if kind == "alchemy" {
                    rewarm_stat_cache(&self.tmp)?;
                }
            }
            None => self.scaffold()?,
        }
        Ok(self.tmp.clone())
    }
}

// ---- spawning ------------------------------------------------------------------------

struct Outcome {
    exit: i64,
    stdout: String,
    stderr: String,
}

fn spawn_omg(
    bin: &Path,
    tmp: &Path,
    argv: &[String],
    stdin: Option<&str>,
    env: &BTreeMap<String, String>,
) -> Result<Outcome, String> {
    let tmp_str = tmp.to_string_lossy().into_owned();
    let subst = |s: &str| s.replace(WORKSPACE_TOKEN, &tmp_str);
    let mut cmd = Command::new(bin);
    cmd.arg("--no-color");
    for a in argv {
        cmd.arg(subst(a));
    }
    // §8: a minimal explicit environment — PATH, the seams, no color, a HOME that
    // never prefixes <tmp>, a TMPDIR inside it — then the case's own variables.
    cmd.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    cmd.env("NO_COLOR", "1");
    cmd.env("HOME", tmp.join("home"));
    cmd.env("TMPDIR", tmp.join("tmp"));
    cmd.env("OMGBASE_SPEC_MINTER", "sequential");
    cmd.env("OMGBASE_SPEC_CLOCK", SPEC_CLOCK);
    for (k, v) in env {
        cmd.env(k, subst(v));
    }
    cmd.current_dir(tmp);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", bin.display()))?;
    let input = stdin.map(subst).unwrap_or_default();
    {
        let mut si = child.stdin.take().expect("piped stdin");
        // A closed pipe (the child never reads) is fine; EOF is what matters.
        let _ = si.write_all(input.as_bytes());
        drop(si);
    }
    let mut so = child.stdout.take().expect("piped stdout");
    let mut se = child.stderr.take().expect("piped stderr");
    let out_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = so.read_to_end(&mut buf);
        buf
    });
    let err_thread = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = se.read_to_end(&mut buf);
        buf
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > SPAWN_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "omg {} did not exit within {SPAWN_TIMEOUT:?} (killed)",
                argv.join(" ")
            ));
        }
        thread::sleep(Duration::from_millis(5));
    };
    let stdout = String::from_utf8_lossy(&out_thread.join().expect("stdout thread")).into_owned();
    let stderr = String::from_utf8_lossy(&err_thread.join().expect("stderr thread")).into_owned();
    // §8: `<tmp>` → `<workspace>`, and the binary's own version → `<version>`.
    let rewrite = |s: String| {
        s.replace(&tmp_str, WORKSPACE_TOKEN)
            .replace(env!("CARGO_PKG_VERSION"), VERSION_TOKEN)
    };
    Ok(Outcome {
        exit: status.code().map_or(-1, i64::from),
        stdout: rewrite(stdout),
        stderr: rewrite(stderr),
    })
}

// ---- comparing -----------------------------------------------------------------------

fn first_diff(actual: &str, expect: &str) -> String {
    let a: Vec<&str> = actual.split('\n').collect();
    let e: Vec<&str> = expect.split('\n').collect();
    for i in 0..a.len().max(e.len()) {
        if a.get(i) != e.get(i) {
            return format!(
                "line {}\n      actual:   {:?}\n      expected: {:?}",
                i + 1,
                a.get(i).copied().unwrap_or("<end>"),
                e.get(i).copied().unwrap_or("<end>")
            );
        }
    }
    "(identical lines)".to_owned()
}

fn compare(got: &Outcome, want: &Expect) -> Option<String> {
    if got.exit != want.exit {
        return Some(format!("exit {}, expected {}", got.exit, want.exit));
    }
    if got.stdout != want.stdout {
        return Some(format!(
            "stdout differs: {}",
            first_diff(&got.stdout, &want.stdout)
        ));
    }
    if let Some(stderr) = &want.stderr {
        if got.stderr != *stderr {
            return Some(format!(
                "stderr differs: {}",
                first_diff(&got.stderr, stderr)
            ));
        }
    }
    None
}

/// Run one case; `Ok(None)` = every step matched, `Ok(Some(why))` = the first mismatch.
fn run_case(ws: &mut Workspaces, bin: &Path, c: &Case) -> Result<Option<String>, String> {
    let tmp = ws.prepare(&c.workspace)?;
    write_files(&tmp, &c.files)?;
    for (i, s) in c.steps.iter().enumerate() {
        write_files(&tmp, &s.files)?;
        let mut env = c.env.clone();
        env.extend(s.env.iter().map(|(k, v)| (k.clone(), v.clone())));
        let got = spawn_omg(bin, &tmp, &s.argv, s.stdin.as_deref(), &env)?;
        if let Some(why) = compare(&got, &s.expect) {
            let step = if c.steps.len() > 1 {
                format!(" step {}", i + 1)
            } else {
                String::new()
            };
            let context = if s.expect.stderr.is_none() && !got.stderr.is_empty() {
                format!(
                    "\n      --- stderr ---\n      {}",
                    got.stderr.trim_end().replace('\n', "\n      ")
                )
            } else {
                String::new()
            };
            return Ok(Some(format!("{step}: {why}{context}")));
        }
    }
    Ok(None)
}

// ---- allowlist -----------------------------------------------------------------------

fn read_allowlist(path: &Path) -> BTreeSet<String> {
    fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn write_allowlist(path: &Path, ids: &BTreeSet<String>) {
    let mut text = String::from(
        "# spec/cli cases the Rust `omgbase` binary passes, one `<suite>::<name>` per\n\
         # line (README §8). A listed case that fails fails `cargo test -p omgbase\n\
         # --test cli_spec`; an unlisted case is reported as \"not yet\" without failing.\n\
         # Regenerate from the currently passing set with\n\
         #\n\
         #     CLI_SPEC_UPDATE=1 cargo test -p omgbase --test cli_spec\n\
         #\n",
    );
    if ids.is_empty() {
        text.push_str(
            "# Empty at 1.0: the binary renders `mcp` only (its `--help`/`--version` are its\n\
             # own, not the reference's), so no case passes yet.\n",
        );
    }
    for id in ids {
        text.push_str(id);
        text.push('\n');
    }
    fs::write(path, text).expect("write allowlist");
}

fn update_requested() -> bool {
    std::env::var("CLI_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
}

fn report(title: &str, lines: &[String]) {
    if lines.is_empty() {
        return;
    }
    eprintln!("{title} ({}):", lines.len());
    for l in lines.iter().take(MAX_REPORT_LINES) {
        eprintln!("  {l}");
    }
    if lines.len() > MAX_REPORT_LINES {
        eprintln!("  … {} more", lines.len() - MAX_REPORT_LINES);
    }
}

// ---- the test --------------------------------------------------------------------------

#[test]
fn cli_spec() {
    let suites = load_suites().unwrap_or_else(|e| panic!("spec/cli/cases: {e}"));
    let bin = binary();
    assert!(
        bin.is_file(),
        "binary under test missing: {} (cargo build -p omgbase, or set $OMGBASE_RUST_BIN)",
        bin.display()
    );
    let mut ws = Workspaces::new();
    let bin = omg_link(&bin, ws.root.path());

    let mut all_ids = BTreeSet::new();
    let mut passing = BTreeSet::new();
    let mut failing: Vec<(String, String)> = Vec::new();
    for (_suite, cases) in &suites {
        for c in cases {
            all_ids.insert(c.id.clone());
            match run_case(&mut ws, &bin, c) {
                Ok(None) => {
                    passing.insert(c.id.clone());
                }
                Ok(Some(why)) => failing.push((c.id.clone(), why)),
                Err(e) => failing.push((c.id.clone(), format!("harness: {e}"))),
            }
        }
    }
    let total = all_ids.len();
    eprintln!("spec/cli: {} of {total} cases pass", passing.len());

    let passing_path = PathBuf::from(PASSING_FILE);
    let listed = read_allowlist(&passing_path);

    if update_requested() {
        let before = listed.clone();
        write_allowlist(&passing_path, &passing);
        eprintln!(
            "spec/cli: allowlist rewritten at {} ({} listed; {} added, {} dropped)",
            passing_path.display(),
            passing.len(),
            passing.difference(&before).count(),
            before.difference(&passing).count()
        );
        return;
    }

    let regressions: Vec<String> = failing
        .iter()
        .filter(|(id, _)| listed.contains(id))
        .map(|(id, why)| format!("{id}{why}"))
        .collect();
    let not_yet: Vec<String> = failing
        .iter()
        .filter(|(id, _)| !listed.contains(id))
        .map(|(id, why)| format!("{id}{why}"))
        .collect();
    let unlisted_passing: Vec<String> = passing.difference(&listed).cloned().collect();
    let stale: Vec<String> = listed.difference(&all_ids).cloned().collect();

    report(
        "not yet (unlisted, failing — expected while the port grows)",
        &not_yet,
    );
    report(
        "passing but not listed — promote with `CLI_SPEC_UPDATE=1 cargo test -p omgbase --test cli_spec`",
        &unlisted_passing,
    );
    report("stale allowlist entries (no such case)", &stale);
    report(
        "REGRESSIONS (listed in cli-spec-passing.txt, now failing)",
        &regressions,
    );
    assert!(
        regressions.is_empty() && stale.is_empty(),
        "spec/cli: {} regression(s), {} stale allowlist entr(ies) — see the report above (stderr)",
        regressions.len(),
        stale.len()
    );
}
