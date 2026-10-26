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

use omgbase_store::{Composition, Config, SequentialMinter};
use omgbase_sync::{
    RealFileSystem, Workspace, ensure_repo_at, freshness_sweep, rebuild_file_stats,
};
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
    /// §8 (store 17.0): SQL run verbatim on `<tmp>/.omgbase/omgbase.db`
    /// before the step (after `files`), one transaction — the device that
    /// puts rows a verb never writes into the workspace (a stale pending row).
    sql: Vec<String>,
    expect: Expect,
}

#[derive(Clone, Debug)]
struct Case {
    id: String,
    workspace: String,
    env: BTreeMap<String, String>,
    files: Vec<(String, Option<String>)>,
    sql: Vec<String>,
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

fn sql_of(v: Option<&Json>) -> Vec<String> {
    v.and_then(Json::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
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

/// A step's shape (`sql` read only for a step of a sequence: a single
/// invocation's `sql` is the case's, run once before it).
fn step_of(v: &Json, at: &str, with_sql: bool) -> Result<Step, String> {
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
        sql: if with_sql {
            sql_of(v.get("sql"))
        } else {
            Vec::new()
        },
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
                    .map(|(j, s)| step_of(s, &format!("{at}.steps[{j}]"), true))
                    .collect::<Result<Vec<_>, _>>()?,
                None => vec![step_of(c, &at, false)?],
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
                sql: sql_of(c.get("sql")),
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

/// §8 (store 17.0): run a case's or a step's `sql` on the workspace database
/// in one transaction (`<workspace>` substituted), through the library.
fn run_sql(tmp: &Path, sql: &[String]) -> Result<(), String> {
    if sql.is_empty() {
        return Ok(());
    }
    let ws = Workspace::open(tmp).map_err(|e| format!("open workspace: {e}"))?;
    let tmp_str = tmp.to_string_lossy();
    {
        let conn = ws.store().conn();
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("sql: {e}"))?;
        for statement in sql {
            tx.execute(&statement.replace(WORKSPACE_TOKEN, &tmp_str), [])
                .map_err(|e| format!("sql `{statement}`: {e}"))?;
        }
        tx.commit().map_err(|e| format!("sql: {e}"))?;
    }
    ws.close().map_err(|e| format!("close workspace: {e}"))
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
            // At the spec clock, as the reference's `source add` runs under
            // `OMGBASE_SPEC_CLOCK`: the repository's birth — its claims and
            // its manifest's coverage start (store 17.0, 3e-ii) — is the clock.
            let repo = ensure_repo_at(ws.store_mut(), FIXTURE_SLUG, Some(&root), SPEC_CLOCK)
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
    // spec/cli §8 "The four compositions" (modular-core Phase 5a): the runner's
    // own `OMGBASE_CAPABILITIES` reaches every spawned binary, so the SAME
    // cases run against the composition named; a case's own `env` still wins.
    if let Some(v) = std::env::var_os(omgbase_store::CAPABILITIES_ENV) {
        cmd.env(omgbase_store::CAPABILITIES_ENV, v);
    }
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
    Ok(normalize_size_output(
        argv,
        normalize_version_output(
            argv,
            Outcome {
                exit: status.code().map_or(-1, i64::from),
                stdout: rewrite(stdout),
                stderr: rewrite(stderr),
            },
        ),
    ))
}

// ---- §8: the `version` verb's outputs are recorded by shape --------------------------
//
// `omg version` prints release-specific values (the engine, its versions, the
// runtime, the build), so the fixture pins the shape: every leaf becomes its
// type name — `<string>`, `<number>`, `<null>`, `<boolean>`. Both runners apply
// the same rule (spec/cli §6 `version`, spec/surface §6): in JSON, objects keep
// their keys with values normalized recursively and arrays their length, except
// `components` (recorded as `"<object>"`) and the optional `mcp.sdk` (dropped),
// and `commit`/`built` — null or not by build environment (a git checkout or
// not) — are one token either way, `"<string|null>"`; in human output each
// `key  value` line keeps its key cell and spacing and the value cell becomes
// the type name of the tool's leaf, decided by the key (a type read off the
// text would misfire on an all-digit commit sha): `<null>` when it prints `—`,
// `<string|null>` for `commit`/`built`, `<number>` for `schema`, else
// `<string>`; the indented `components` lines collapse into one `  <object>`.
// Applied only to a successful `version` invocation (exit 0, not its card).

#[derive(Clone, Copy, PartialEq, Eq)]
enum VersionMode {
    Human,
    Json,
}

/// What an argv invokes: the verb, its first subcommand word, whether a
/// machine mode is on, and its flags.
struct Scan<'a> {
    command: Option<&'a str>,
    sub: Option<&'a str>,
    json: bool,
    flags: Vec<&'a str>,
}

/// The verb an argv invokes (and its first subcommand word), whether a
/// machine mode is on, and its flags; `None` when it asks for help.
fn scan_argv(argv: &[String]) -> Option<Scan<'_>> {
    const TAKES_VALUE: [&str; 9] = [
        "-C",
        "--directory",
        "--repo",
        "--server",
        "-H",
        "--header",
        "--dest",
        "--policy",
        "--before",
    ];
    let mut command: Option<&str> = None;
    let mut sub: Option<&str> = None;
    let mut json = false;
    let mut flags = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        i += 1;
        if a == "--" {
            break;
        }
        if TAKES_VALUE.contains(&a) {
            i += 1;
            continue;
        }
        if a == "--help" || a == "-h" {
            return None;
        }
        if a == "--json" || a == "--jsonl" || a == "--ids" {
            json = true;
            continue;
        }
        if a.starts_with('-') {
            flags.push(a);
            continue;
        }
        if command.is_none() {
            command = Some(a);
        } else if sub.is_none() {
            sub = Some(a);
        }
    }
    Some(Scan {
        command,
        sub,
        json,
        flags,
    })
}

fn mode_of(json: bool) -> VersionMode {
    if json {
        VersionMode::Json
    } else {
        VersionMode::Human
    }
}

/// Does this argv invoke the `version` verb (not `--version`, not its card)?
fn version_verb_mode(argv: &[String]) -> Option<VersionMode> {
    let scan = scan_argv(argv)?;
    (scan.command == Some("version")).then(|| mode_of(scan.json))
}

/// JSON: leaves → type names; keys kept; `components` → `"<object>"`; `mcp.sdk` dropped.
fn type_shape(v: &Json, path: &[String]) -> Json {
    let child = |k: &str| {
        let mut p = path.to_vec();
        p.push(k.to_owned());
        p
    };
    match v {
        Json::Null => Json::from("<null>"),
        Json::Bool(_) => Json::from("<boolean>"),
        Json::Number(_) => Json::from("<number>"),
        Json::String(_) => Json::from("<string>"),
        Json::Array(items) => Json::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, x)| type_shape(x, &child(&i.to_string())))
                .collect(),
        ),
        Json::Object(_) if path == ["components"] => Json::from("<object>"),
        Json::Object(m) => Json::Object(
            m.iter()
                .filter(|(k, _)| !(path == ["mcp"] && *k == "sdk"))
                .map(|(k, x)| {
                    let shape = if path.is_empty() && (k == "commit" || k == "built") {
                        Json::from("<string|null>")
                    } else {
                        type_shape(x, &child(k))
                    };
                    (k.clone(), shape)
                })
                .collect(),
        ),
    }
}

/// The reference's `^(\S+)(\s{2,})(.*)$`: the key, its padding of two or
/// more blanks, and the value cell.
fn split_key_value(line: &str) -> Option<(&str, &str, &str)> {
    let key_end = line.find(char::is_whitespace)?;
    if key_end == 0 {
        return None;
    }
    let pad = line[key_end..].len() - line[key_end..].trim_start().len();
    if pad < 2 {
        return None;
    }
    let (key, rest) = line.split_at(key_end);
    let (gap, value) = rest.split_at(pad);
    Some((key, gap, value))
}

/// Human: value cells → the leaf's type name, by key; the indented component
/// lines → one `  <object>` line.
fn type_shape_human(stdout: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_components = false;
    for line in stdout.split('\n') {
        if line.starts_with("  ") {
            if !in_components {
                out.push("  <object>".to_owned());
            }
            in_components = true;
            continue;
        }
        in_components = false;
        match split_key_value(line) {
            Some((key, gap, value)) => {
                let cell = if key == "commit" || key == "built" {
                    "<string|null>"
                } else if value == "\u{2014}" {
                    "<null>"
                } else if key == "schema" {
                    "<number>"
                } else {
                    "<string>"
                };
                out.push(format!("{key}{gap}{cell}"));
            }
            None => out.push(line.to_owned()),
        }
    }
    out.join("\n")
}

/// The §8 rewrite of a successful `version` step's stdout; anything else as is.
fn normalize_version_output(argv: &[String], o: Outcome) -> Outcome {
    if o.exit != 0 {
        return o;
    }
    match version_verb_mode(argv) {
        None => o,
        Some(VersionMode::Json) => {
            let stdout = o
                .stdout
                .split('\n')
                .map(|l| {
                    if l.is_empty() {
                        return String::new();
                    }
                    serde_json::from_str::<Json>(l)
                        .map_or_else(|_| l.to_owned(), |v| type_shape(&v, &[]).to_string())
                })
                .collect::<Vec<_>>()
                .join("\n");
            Outcome { stdout, ..o }
        }
        Some(VersionMode::Human) => Outcome {
            stdout: type_shape_human(&o.stdout),
            ..o
        },
    }
}

// ---- §8: `doctor --size`, `gc --vacuum` and the sized `history` verbs are recorded by shape
//
// Byte counts depend on the SQLite build and its page allocation, not on the
// engine's behavior, so a case pins everything but the bytes (the reference's
// `fixture.ts` applies the same rule): in JSON every number under the keys
// `bytes`, `wal_bytes`, `page_size`, `page_count`, `freelist_count`,
// `reclaimable`, `share` and `indexes` becomes `"<number>"` (a `null` stays
// `null`; `rows`, every name, the path and the advice are kept); in text a
// table row's bytes cell (right-aligned in 9 columns) becomes `<bytes>` and
// its share cell (6 columns) `<share>`, the name column's padding and the
// two-blank gutters kept; on every other line each humanized size becomes
// `<bytes>`, each one-decimal percentage `<share>`, and the `pages` line's
// three counts `<number>`. Row counts are never touched. Applied to stdout
// and stderr of a successful `doctor --size`, `gc --vacuum`, `history export`
// (not its `--dry-run`, which is the plan over logical bytes and is exact),
// `history list` or `history attach` (cli 4.6: a segment file's size is a
// page layout too).

const SIZE_KEYS: [&str; 8] = [
    "bytes",
    "wal_bytes",
    "page_size",
    "page_count",
    "freelist_count",
    "reclaimable",
    "share",
    "indexes",
];
const BYTES_CELL: usize = 9;
const SHARE_CELL: usize = 6;

/// Is this a successful `doctor --size`, `gc --vacuum`, `history export`,
/// `history list` or `history attach` (cli 4.6) whose outputs are recorded by shape?
fn size_report_mode(argv: &[String]) -> Option<VersionMode> {
    let scan = scan_argv(argv)?;
    let sized = (scan.command == Some("doctor") && scan.flags.contains(&"--size"))
        || (scan.command == Some("gc") && scan.flags.contains(&"--vacuum"))
        || (scan.command == Some("history")
            && ((scan.sub == Some("export") && !scan.flags.contains(&"--dry-run"))
                || scan.sub == Some("list")
                || scan.sub == Some("attach")));
    sized.then(|| mode_of(scan.json))
}

/// JSON: the numbers under the size keys → `"<number>"`.
fn size_shape(v: &Json, key: Option<&str>) -> Json {
    match v {
        Json::Number(_) if key.is_some_and(|k| SIZE_KEYS.contains(&k)) => Json::from("<number>"),
        Json::Array(items) => Json::Array(items.iter().map(|x| size_shape(x, None)).collect()),
        Json::Object(m) => Json::Object(
            m.iter()
                .map(|(k, x)| (k.clone(), size_shape(x, Some(k))))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The length of a humanized size at the start of `s` (`4.0 KB`, `0 B`, `13.1 MB`), if one.
fn size_token(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    if i + 1 < b.len() && b[i] == b'.' && b[i + 1].is_ascii_digit() {
        i += 2;
    }
    if b.get(i) != Some(&b' ') {
        return None;
    }
    i += 1;
    if matches!(b.get(i), Some(b'K' | b'M' | b'G' | b'T')) {
        i += 1;
    }
    if b.get(i) != Some(&b'B') {
        return None;
    }
    i += 1;
    (!b.get(i).is_some_and(u8::is_ascii_alphanumeric)).then_some(i)
}

/// The length of a one-decimal percentage at the start of `s` (`48.2%`), if one.
fn share_token(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 || b.get(i) != Some(&b'.') || !b.get(i + 1).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    i += 2;
    (b.get(i) == Some(&b'%')).then_some(i + 1)
}

fn spaces(s: &str) -> usize {
    s.len() - s.trim_start_matches(' ').len()
}

/// A size-table row — `<indent><name><pad><bytes cell><gutter><share cell>
/// <gutter><rows>` — with its two cells tokenized in place, or `None`.
fn size_row_shape(line: &str) -> Option<String> {
    let indent = spaces(line);
    if indent < 2 {
        return None;
    }
    let name_len = line[indent..].find(' ')?;
    let head_end = indent + name_len;
    let pad = spaces(&line[head_end..]);
    if pad == 0 {
        return None;
    }
    let bytes_at = head_end + pad;
    let bytes_len = size_token(&line[bytes_at..])?;
    let gap = spaces(&line[bytes_at + bytes_len..]);
    if gap == 0 {
        return None;
    }
    let share_at = bytes_at + bytes_len + gap;
    let share_len = share_token(&line[share_at..])?;
    let rest = &line[share_at + share_len..];
    let rest_gap = spaces(rest);
    if rest_gap == 0
        || rest[rest_gap..].is_empty()
        || !rest[rest_gap..].bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    // The cells are right-aligned in fixed widths: strip exactly their leading blanks.
    let head = &line[..bytes_at - (BYTES_CELL.checked_sub(bytes_len)?)];
    let gap_kept = &line[bytes_at + bytes_len..share_at - (SHARE_CELL.checked_sub(share_len)?)];
    Some(format!("{head}<bytes>{gap_kept}<share>{rest}"))
}

/// The `pages` line: `  pages  <n> x <n> bytes, <n> free` → its counts tokenized.
fn pages_line_shape(line: &str) -> Option<String> {
    let indent = spaces(line);
    let rest = line[indent..].strip_prefix("pages")?;
    let gap = spaces(rest);
    if indent == 0 || gap == 0 {
        return None;
    }
    let body = &rest[gap..];
    let (count, body) = body.split_once(" x ")?;
    let (size, body) = body.split_once(" bytes, ")?;
    let free = body.strip_suffix(" free")?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (digits(count) && digits(size) && digits(free)).then(|| {
        format!(
            "{}{}<number> x <number> bytes, <number> free",
            &line[..indent + "pages".len()],
            &rest[..gap]
        )
    })
}

/// Every humanized size and percentage in a line (at word boundaries) → tokens.
fn inline_size_shape(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let boundary = i == 0 || !b[i - 1].is_ascii_alphanumeric();
        if boundary && b[i].is_ascii_digit() {
            if let Some(n) = size_token(&line[i..]) {
                out.push_str("<bytes>");
                i += n;
                continue;
            }
            if let Some(n) = share_token(&line[i..]) {
                out.push_str("<share>");
                i += n;
                continue;
            }
        }
        // Advance one char (the line is UTF-8; copy the whole scalar).
        let ch = line[i..].chars().next().expect("in bounds");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn size_shape_text(s: &str) -> String {
    s.split('\n')
        .map(|line| {
            size_row_shape(line)
                .or_else(|| pages_line_shape(line))
                .unwrap_or_else(|| inline_size_shape(line))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The §8 rewrite of a successful sized step (`doctor --size`, `gc --vacuum`,
/// `history export|list|attach`); anything else as is.
fn normalize_size_output(argv: &[String], o: Outcome) -> Outcome {
    if o.exit != 0 {
        return o;
    }
    match size_report_mode(argv) {
        None => o,
        Some(VersionMode::Json) => {
            let stdout = o
                .stdout
                .split('\n')
                .map(|l| {
                    if l.is_empty() {
                        return String::new();
                    }
                    serde_json::from_str::<Json>(l).map_or_else(
                        |_| l.to_owned(),
                        |v| size_shape_text(&size_shape(&v, None).to_string()),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Outcome {
                stdout,
                stderr: size_shape_text(&o.stderr),
                ..o
            }
        }
        Some(VersionMode::Human) => Outcome {
            stdout: size_shape_text(&o.stdout),
            stderr: size_shape_text(&o.stderr),
            ..o
        },
    }
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
    if let Some(stderr) = &want.stderr
        && got.stderr != *stderr
    {
        return Some(format!(
            "stderr differs: {}",
            first_diff(&got.stderr, stderr)
        ));
    }
    None
}

/// Run one case; `Ok(None)` = every step matched, `Ok(Some(why))` = the first mismatch.
fn run_case(ws: &mut Workspaces, bin: &Path, c: &Case) -> Result<Option<String>, String> {
    let tmp = ws.prepare(&c.workspace)?;
    write_files(&tmp, &c.files)?;
    run_sql(&tmp, &c.sql)?;
    for (i, s) in c.steps.iter().enumerate() {
        write_files(&tmp, &s.files)?;
        run_sql(&tmp, &s.sql)?;
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

// ---- the four compositions (spec/cli §8 "The four compositions"; modular-core Phase 5a) ----
//
// `OMGBASE_CAPABILITIES=core|history|semantic|full` reaches every spawned
// binary (`spawn_omg`), so the SAME cases run against the composition named.
// The fixtures are the full composition's record; under a reduced one a case
// whose inputs or recorded outputs carry an OBSERVABLE of the absent module is
// skipped and counted (a verb of the module, or a word of its wire — the
// recorder's table names and disposition summary, the embed queue and the
// vector tables, the capability states), and every other case must pass
// UNCHANGED. The classifier is deliberately textual and conservative: it reads
// the case, never the run — word for word the reference's
// (`packages/cli/corpus/cli/spec.test.ts`), with JavaScript's ASCII `\b` and
// `\d`.

/// The verbs that reach the history module (the capture verbs, the log/history readers, `show --history`, `cat --at`).
const HISTORY_VERBS: [&str; 4] = ["log", "hist", "diff", "history"];
const HISTORY_FLAGS: [&str; 2] = ["--history", "--at"];
/// The verbs that reach the semantic module.
const SEMANTIC_VERBS: [&str; 2] = ["embed", "find"];
/// Words of the history module's wire: its tables in a size report, the recorder's disposition summary, its capability state and the doctor's capture check.
const HISTORY_TEXT: &str = r#"(?-u:\b)(commits|revisions|dispositions|block_changes|tree_nodes|blobs|edge_transitions|archives)(?-u:\b)|"history":\{"state":"enabled|history\s+enabled|"coverage_from":"([0-9]|<string>)|"writer_requires":true|capture complete| — [0-9]+ (inserted|edited|deleted|moved|resurrected|same|split|merged)|history unavailable|writer_refused|capability_unavailable|revision"#;
/// Words of the semantic module's wire: the embed queue, the vector tables, its capability state, the provider.
const SEMANTIC_TEXT: &str = r#"(?-u:\b)queued(?-u:\b)|"embedQueue":[1-9]|(?-u:\b)doc_embeddings(?-u:\b)|(?-u:\b)embeddings(?-u:\b)|"semantic":\{"state":"enabled|embedding|provider_unavailable|capability_unavailable|semantic\("#;

/// The case's argv (every step's) and its text: each step's stdin and recorded
/// stdout/stderr, then the case's `files` contents and its `sql` (the reference's `caseText`).
fn case_text(c: &Case) -> (Vec<&str>, String) {
    let argv: Vec<&str> = c
        .steps
        .iter()
        .flat_map(|s| s.argv.iter().map(String::as_str))
        .collect();
    let mut text = c
        .steps
        .iter()
        .map(|s| {
            format!(
                "{}\n{}\n{}",
                s.stdin.as_deref().unwrap_or(""),
                s.expect.stdout,
                s.expect.stderr.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut values: Vec<String> = c
        .files
        .iter()
        .map(|(_, content)| content.clone().unwrap_or_default())
        .collect();
    values.push(c.sql.join("\n"));
    text.push_str(&values.join("\n"));
    (argv, text)
}

/// Why the case is skipped under this composition, or `None` when it must pass as recorded.
fn skip_reason(c: &Case, composition: Composition) -> Option<&'static str> {
    let (argv, text) = case_text(c);
    if !composition.has_history() {
        let history_text = regex::Regex::new(HISTORY_TEXT).expect("history wire regex");
        if argv
            .iter()
            .any(|a| HISTORY_VERBS.contains(a) || HISTORY_FLAGS.contains(a))
            || history_text.is_match(&text)
        {
            return Some("needs the history module");
        }
    }
    if !composition.has_semantic() {
        let semantic_text = regex::Regex::new(SEMANTIC_TEXT).expect("semantic wire regex");
        if argv.iter().any(|a| SEMANTIC_VERBS.contains(a)) || semantic_text.is_match(&text) {
            return Some("needs the semantic module");
        }
    }
    None
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

    // spec/cli §8 "The four compositions": the composition the binary runs
    // with; a case carrying an observable of the absent module is skipped and
    // counted, every other case must pass unchanged; the ledger line is what
    // `pnpm conformance` reads; `CLI_SPEC_UPDATE` is refused under a reduced one.
    let composition = Composition::from_env().expect("OMGBASE_CAPABILITIES");
    assert!(
        !(update_requested() && composition != Composition::Full),
        "CLI_SPEC_UPDATE under OMGBASE_CAPABILITIES={composition} would record that composition's answers; run it on the full one"
    );
    let mut compared: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    let mut all_ids = BTreeSet::new();
    let mut passing = BTreeSet::new();
    let mut failing: Vec<(String, String)> = Vec::new();
    for (_suite, cases) in &suites {
        for c in cases {
            all_ids.insert(c.id.clone());
            if let Some(reason) = skip_reason(c, composition) {
                // A skipped case counts as passing for the allowlist's
                // bookkeeping, as the reference's skipped test does.
                skipped.push(format!("{} — {reason}", c.id));
                passing.insert(c.id.clone());
                continue;
            }
            compared.push(c.id.clone());
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
    let mut ledger = format!(
        "[cli spec] composition={composition}: compared={} mapped=0 skipped={}\n",
        compared.len(),
        skipped.len()
    );
    if composition != Composition::Full {
        for s in &skipped {
            ledger.push_str(&format!("  skip {s}\n"));
        }
    }
    eprint!("{ledger}");

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
