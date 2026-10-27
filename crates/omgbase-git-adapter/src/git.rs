//! The git plumbing wrapper (`spec/store` §5.12, modular-core Phase 6a):
//! every call spawns `git` with `GIT_DIR` set to the bare repository and an
//! environment that reads NO user configuration — `GIT_CONFIG_NOSYSTEM=1`,
//! `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, no `HOME` — so the
//! bytes of every object are a function of the engine's inputs alone (the
//! fixtures pin commit shas). Author and committer identities and dates are
//! per call: the committer is the engine's identity, the author's name the
//! commit's actor, the dates the feed row's `ts` in git's raw form `@<unix
//! seconds> +0000` (git keeps seconds; the exact `ts` rides in the
//! `omgbase-ts` trailer). The reference (`packages/git-adapter/src/git.ts`)
//! spawns the same argv under the same environment.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use omgbase_store::time::parse_ms;
use omgbase_store::{Error, ProviderAvailability, Result};

/// A name and an email.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

impl GitIdentity {
    #[must_use]
    pub fn new(name: &str, email: &str) -> Self {
        Self {
            name: name.to_owned(),
            email: email.to_owned(),
        }
    }
}

/// The git executable: `git` on PATH, or what `OMGBASE_GIT_BIN` names (a host
/// pinning one git; the tests pointing at a missing one). The reference
/// honours the same variable.
pub const GIT_BIN_ENV: &str = "OMGBASE_GIT_BIN";

/// The executable this process spawns.
#[must_use]
pub fn git_bin() -> String {
    match std::env::var(GIT_BIN_ENV) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_owned(),
        _ => "git".to_owned(),
    }
}

/// The null sha (`update-ref`'s "the ref must not exist").
pub const ZERO_SHA: &str = "0000000000000000000000000000000000000000";
/// The empty tree's sha (git's well-known constant for the SHA-1 object format).
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Is `s` a 40-hex git object name?
#[must_use]
pub fn is_sha(s: &str) -> bool {
    s.len() == 40
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `ts` (RFC 3339) as git's raw date `@<seconds> +0000`.
pub fn git_date(ts: &str) -> Result<String> {
    let ms = parse_ms(ts).map_err(|_| Error::Other(format!("not an RFC 3339 instant: {ts}")))?;
    Ok(format!("@{} +0000", ms.div_euclid(1000)))
}

/// The `errno` name of a spawn failure, as Node spells it.
fn errno_name(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "ENOENT".to_owned(),
        std::io::ErrorKind::PermissionDenied => "EACCES".to_owned(),
        _ => e.to_string(),
    }
}

static PROBE: Mutex<Option<ProviderAvailability>> = Mutex::new(None);

/// Is `git` on PATH? The version line, or the reason it is not. Probed once
/// per process.
#[must_use]
pub fn git_available() -> ProviderAvailability {
    let mut probed = PROBE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(p) = probed.as_ref() {
        return p.clone();
    }
    let bin = git_bin();
    let mut cmd = Command::new(&bin);
    cmd.arg("--version");
    apply_env(&mut cmd, None, &[]);
    let answer = match cmd.output() {
        Err(e) => ProviderAvailability::Unavailable {
            reason: format!("{bin} is not on PATH ({})", errno_name(&e)),
        },
        Ok(out) if !out.status.success() => ProviderAvailability::Unavailable {
            reason: format!(
                "git --version exited {}: {}",
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        },
        Ok(out) => ProviderAvailability::Available {
            detail: String::from_utf8_lossy(&out.stdout).trim().to_owned(),
        },
    };
    *probed = Some(answer.clone());
    answer
}

/// Tests: forget the probe's answer.
pub fn reset_git_probe() {
    *PROBE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// The environment every spawn runs under: PATH, no user configuration,
/// `LC_ALL=C`, `TZ=UTC`, `GIT_DIR` when given, then the call's own variables.
fn apply_env(cmd: &mut Command, git_dir: Option<&Path>, extra: &[(&str, OsString)]) {
    cmd.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    cmd.env("GIT_CONFIG_NOSYSTEM", "1");
    cmd.env("GIT_CONFIG_GLOBAL", "/dev/null");
    cmd.env("GIT_ATTR_NOSYSTEM", "1");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("LC_ALL", "C");
    cmd.env("TZ", "UTC");
    if let Some(dir) = git_dir {
        cmd.env("GIT_DIR", dir);
    }
    for (k, v) in extra {
        cmd.env(k, v);
    }
}

/// One spawn's result.
#[derive(Clone, Debug)]
pub struct GitRunResult {
    pub status: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// What `git push` came back with (17.6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PushStatus {
    Ok,
    /// The remote refused a non-fast-forward; git's stderr.
    Rejected(String),
    /// Anything else (no network, no such remote); git's stderr.
    Failed(String),
}

/// One commit of the branch log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogRecord {
    pub sha: String,
    pub committer_unix: i64,
    pub message: String,
}

/// A bare repository at `git_dir`, driven through the plumbing.
#[derive(Clone, Debug)]
pub struct GitRepo {
    git_dir: PathBuf,
}

impl GitRepo {
    #[must_use]
    pub fn new(git_dir: PathBuf) -> Self {
        Self { git_dir }
    }

    /// The bare repository's directory.
    #[must_use]
    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    /// Does the bare repository exist (its `HEAD` file)?
    #[must_use]
    pub fn exists(&self) -> bool {
        self.git_dir.join("HEAD").is_file()
    }

    /// `git init --bare --initial-branch <branch>` (idempotent: an existing
    /// repository is left as it is). `--initial-branch` so no
    /// `init.defaultBranch` setting (which we never read) decides the name.
    pub fn init(&self, branch: &str) -> Result<()> {
        if self.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.git_dir)
            .map_err(|e| Error::Other(format!("cannot create {}: {e}", self.git_dir.display())))?;
        let dir = self.git_dir.to_string_lossy().into_owned();
        self.run_with(
            &[
                "init",
                "--quiet",
                "--bare",
                "--initial-branch",
                branch,
                &dir,
            ],
            None,
            &[],
            false,
            true,
        )?;
        Ok(())
    }

    /// Delete the bare repository; whether it existed.
    pub fn remove(&self) -> Result<bool> {
        if !self.git_dir.exists() {
            return Ok(false);
        }
        std::fs::remove_dir_all(&self.git_dir)
            .map_err(|e| Error::Other(format!("cannot remove {}: {e}", self.git_dir.display())))?;
        Ok(true)
    }

    /// Spawn `git <args>`: `input` on stdin, `env` the call's own variables,
    /// `allow_failure` returns a non-zero exit instead of failing,
    /// `no_git_dir` leaves `GIT_DIR` unset (`init`).
    fn run_with(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        env: &[(&str, OsString)],
        allow_failure: bool,
        no_git_dir: bool,
    ) -> Result<GitRunResult> {
        let bin = git_bin();
        let mut cmd = Command::new(&bin);
        cmd.args(args);
        apply_env(
            &mut cmd,
            if no_git_dir {
                None
            } else {
                Some(&self.git_dir)
            },
            env,
        );
        cmd.stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| Error::Other(format!("spawn {bin}: {}", errno_name(&e))))?;
        if let Some(bytes) = input {
            let mut stdin = child.stdin.take().expect("piped stdin");
            // A closed pipe (git read what it needed) is fine; EOF is what matters.
            let _ = stdin.write_all(bytes);
            drop(stdin);
        }
        let out = child
            .wait_with_output()
            .map_err(|e| Error::Other(format!("git {}: {e}", args.join(" "))))?;
        let status = out.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        if status != 0 && !allow_failure {
            return Err(Error::Other(format!(
                "git {} exited {status}: {}",
                args.join(" "),
                stderr.trim()
            )));
        }
        Ok(GitRunResult {
            status,
            stdout: out.stdout,
            stderr,
        })
    }

    /// `git <args>` with optional stdin; a non-zero exit fails.
    pub fn run(&self, args: &[&str], input: Option<&[u8]>) -> Result<GitRunResult> {
        self.run_with(args, input, &[], false, false)
    }

    /// `git <args>`'s stdout as text.
    pub fn text(&self, args: &[&str]) -> Result<String> {
        Ok(String::from_utf8_lossy(&self.run(args, None)?.stdout).into_owned())
    }

    /// The branch tip, or `None` when the ref does not exist.
    pub fn tip(&self, branch: &str) -> Result<Option<String>> {
        let r = self.run_with(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
            None,
            &[],
            true,
            false,
        )?;
        if r.status != 0 {
            return Ok(None);
        }
        let sha = String::from_utf8_lossy(&r.stdout).trim().to_owned();
        Ok(is_sha(&sha).then_some(sha))
    }

    /// `git hash-object -w --stdin`: the blob's sha.
    pub fn write_blob(&self, bytes: &[u8]) -> Result<String> {
        let r = self.run(&["hash-object", "-w", "--stdin"], Some(bytes))?;
        Ok(String::from_utf8_lossy(&r.stdout).trim().to_owned())
    }

    /// Build a tree: the parent commit's tree (or empty) read into a temporary
    /// index, `update-index --index-info` with the adds (`100644 blob
    /// <sha>\t<path>`) and removes (`0 <zeros>\t<path>`), `write-tree`. Returns
    /// the tree sha. The index file lives inside the bare repository and is
    /// removed afterwards.
    pub fn build_tree(
        &self,
        base_tree: Option<&str>,
        adds: &[(String, String)],
        removes: &[String],
    ) -> Result<String> {
        let index = self
            .git_dir
            .join(format!("omgbase-index-{}.tmp", std::process::id()));
        let env = [("GIT_INDEX_FILE", OsString::from(index.as_os_str()))];
        let result = (|| -> Result<String> {
            match base_tree {
                None => self.run_with(&["read-tree", "--empty"], None, &env, false, false)?,
                Some(base) => self.run_with(&["read-tree", base], None, &env, false, false)?,
            };
            let mut lines: Vec<String> = Vec::new();
            for p in removes {
                lines.push(format!("0 {ZERO_SHA}\t{p}"));
            }
            for (path, blob) in adds {
                lines.push(format!("100644 blob {blob}\t{path}"));
            }
            if !lines.is_empty() {
                let input = format!("{}\n", lines.join("\n"));
                self.run_with(
                    &["update-index", "--index-info"],
                    Some(input.as_bytes()),
                    &env,
                    false,
                    false,
                )?;
            }
            let r = self.run_with(&["write-tree"], None, &env, false, false)?;
            Ok(String::from_utf8_lossy(&r.stdout).trim().to_owned())
        })();
        let _ = std::fs::remove_file(&index);
        result
    }

    /// The tree a commit points at.
    pub fn tree_of(&self, commit: &str) -> Result<String> {
        Ok(self
            .text(&["rev-parse", &format!("{commit}^{{tree}}")])?
            .trim()
            .to_owned())
    }

    /// `git commit-tree` with the message on stdin and the identities/dates in
    /// the environment; the commit sha. The author's name is the actor's, the
    /// email the committer's; both dates `ts` in the raw form.
    pub fn commit_tree(
        &self,
        tree: &str,
        parent: Option<&str>,
        message: &str,
        author: &GitIdentity,
        committer: &GitIdentity,
        ts: &str,
    ) -> Result<String> {
        let parents: Vec<&str> = parent.into_iter().collect();
        self.commit_tree_parents(tree, &parents, message, author, committer, ts)
    }

    /// [`GitRepo::commit_tree`] over several parents (a merge commit, 17.6):
    /// one `-p` per parent, in order.
    pub fn commit_tree_parents(
        &self,
        tree: &str,
        parents: &[&str],
        message: &str,
        author: &GitIdentity,
        committer: &GitIdentity,
        ts: &str,
    ) -> Result<String> {
        let date = git_date(ts)?;
        let env = [
            ("GIT_AUTHOR_NAME", OsString::from(&author.name)),
            ("GIT_AUTHOR_EMAIL", OsString::from(&author.email)),
            ("GIT_AUTHOR_DATE", OsString::from(&date)),
            ("GIT_COMMITTER_NAME", OsString::from(&committer.name)),
            ("GIT_COMMITTER_EMAIL", OsString::from(&committer.email)),
            ("GIT_COMMITTER_DATE", OsString::from(&date)),
        ];
        let mut args = vec!["commit-tree", tree];
        for p in parents {
            args.push("-p");
            args.push(p);
        }
        args.push("-F");
        args.push("-");
        let r = self.run_with(&args, Some(message.as_bytes()), &env, false, false)?;
        Ok(String::from_utf8_lossy(&r.stdout).trim().to_owned())
    }

    /// `git update-ref` with the old value as the compare-and-swap
    /// (`ZERO_SHA` = the ref must not exist).
    pub fn update_ref(&self, branch: &str, new_sha: &str, old_sha: Option<&str>) -> Result<()> {
        self.update_ref_raw(&format!("refs/heads/{branch}"), new_sha, old_sha)
    }

    // ---- refs, ancestry and trees (17.6, the remote half) ----

    /// `git update-ref <ref> <new> <old>` on any full ref name (the ids ref,
    /// the remote-tracking and bookkeeping refs).
    pub fn update_ref_raw(&self, r: &str, new_sha: &str, old_sha: Option<&str>) -> Result<()> {
        self.run(
            &["update-ref", r, new_sha, old_sha.unwrap_or(ZERO_SHA)],
            None,
        )?;
        Ok(())
    }

    /// `git update-ref <ref> <new>` without a compare-and-swap (a tracking or
    /// bookkeeping ref that mirrors something else).
    pub fn set_ref(&self, r: &str, sha: &str) -> Result<()> {
        self.run(&["update-ref", r, sha], None)?;
        Ok(())
    }

    /// `git update-ref -d <ref>`; a missing ref is fine.
    pub fn delete_ref(&self, r: &str) -> Result<()> {
        self.run_with(&["update-ref", "-d", r], None, &[], true, false)?;
        Ok(())
    }

    /// The sha a full ref name points at, or `None` when it does not exist.
    pub fn ref_sha(&self, r: &str) -> Result<Option<String>> {
        let out = self.run_with(
            &["rev-parse", "--verify", "--quiet", r],
            None,
            &[],
            true,
            false,
        )?;
        if out.status != 0 {
            return Ok(None);
        }
        let sha = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        Ok(is_sha(&sha).then_some(sha))
    }

    /// The author of a commit: `%an` and `%ae`.
    pub fn author_of(&self, commit: &str) -> Result<GitIdentity> {
        let text = self.text(&["log", "-1", "--format=%an%x1f%ae", commit])?;
        let mut parts = text.trim().splitn(2, '\u{1f}');
        Ok(GitIdentity {
            name: parts.next().unwrap_or("").to_owned(),
            email: parts.next().unwrap_or("").to_owned(),
        })
    }

    /// Is `ancestor` an ancestor of (or equal to) `descendant`?
    /// (`git merge-base --is-ancestor`.)
    pub fn is_ancestor(&self, ancestor: &str, descendant: &str) -> Result<bool> {
        Ok(self
            .run_with(
                &["merge-base", "--is-ancestor", ancestor, descendant],
                None,
                &[],
                true,
                false,
            )?
            .status
            == 0)
    }

    /// `git merge-base a b`, or `None` when the histories are unrelated.
    pub fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>> {
        let r = self.run_with(&["merge-base", a, b], None, &[], true, false)?;
        if r.status != 0 {
            return Ok(None);
        }
        let sha = String::from_utf8_lossy(&r.stdout).trim().to_owned();
        Ok(is_sha(&sha).then_some(sha))
    }

    /// The commits reachable from `to` and not from `from`, oldest first
    /// (`git rev-list --reverse from..to`; `from` `None` = all of `to`).
    pub fn rev_list(&self, from: Option<&str>, to: &str) -> Result<Vec<String>> {
        let range = match from {
            Some(f) => format!("{f}..{to}"),
            None => to.to_owned(),
        };
        Ok(self
            .text(&["rev-list", "--reverse", &range])?
            .lines()
            .map(str::trim)
            .filter(|l| is_sha(l))
            .map(str::to_owned)
            .collect())
    }

    /// The parents of a commit.
    pub fn parents_of(&self, commit: &str) -> Result<Vec<String>> {
        Ok(self
            .text(&["rev-list", "--parents", "-n", "1", commit])?
            .split_whitespace()
            .skip(1)
            .filter(|p| is_sha(p))
            .map(str::to_owned)
            .collect())
    }

    /// A tree-ish's blobs: `path → blob sha` (`git ls-tree -r -z`; only blobs —
    /// the content branch holds nothing else), bytewise by path.
    pub fn tree_entries(&self, treeish: &str) -> Result<BTreeMap<String, String>> {
        let mut out = BTreeMap::new();
        if treeish == EMPTY_TREE {
            return Ok(out);
        }
        let bytes = self.run(&["ls-tree", "-r", "-z", treeish], None)?.stdout;
        for record in bytes.split(|&b| b == 0) {
            if record.is_empty() {
                continue;
            }
            let line = String::from_utf8_lossy(record);
            // `<mode> <type> <sha>\t<path>`
            let Some((meta, path)) = line.split_once('\t') else {
                continue;
            };
            let fields: Vec<&str> = meta.split(' ').collect();
            if let [_mode, "blob", sha] = fields.as_slice()
                && is_sha(sha)
            {
                out.insert(path.to_owned(), (*sha).to_owned());
            }
        }
        Ok(out)
    }

    /// The paths whose blob differs between two tree-ishes: `(path, the blob
    /// in b)` (`None` = gone in b), in `git diff-tree -r` output order.
    pub fn diff_trees(&self, a: &str, b: &str) -> Result<Vec<(String, Option<String>)>> {
        let mut out = Vec::new();
        let bytes = self
            .run(&["diff-tree", "-r", "-z", "--no-renames", a, b], None)?
            .stdout;
        // The -z form interleaves `:<mode a> <mode b> <sha a> <sha b> <status>`
        // and `<path>` records; parse pairwise.
        let records: Vec<&[u8]> = bytes.split(|&b| b == 0).collect();
        let mut i = 0;
        while i + 1 < records.len() {
            let meta = String::from_utf8_lossy(records[i]);
            let path = String::from_utf8_lossy(records[i + 1]).into_owned();
            i += 2;
            let Some(meta) = meta.strip_prefix(':') else {
                continue;
            };
            let fields: Vec<&str> = meta.split(' ').collect();
            let [_ma, _mb, _sa, sb, status] = fields.as_slice() else {
                continue;
            };
            if !is_sha(sb) || !matches!(status.chars().next(), Some('A' | 'D' | 'M' | 'T')) {
                continue;
            }
            out.push((path, (!status.starts_with('D')).then(|| (*sb).to_owned())));
        }
        Ok(out)
    }

    /// A blob's bytes.
    pub fn blob(&self, sha: &str) -> Result<Vec<u8>> {
        Ok(self.run(&["cat-file", "blob", sha], None)?.stdout)
    }

    /// The configured remotes (`git remote`).
    pub fn remotes(&self) -> Result<Vec<String>> {
        Ok(self
            .text(&["remote"])?
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// `git remote add` or `set-url` so that `name` points at `url`;
    /// `remote.<name>.fetch` left as git sets it (the tracking refs under
    /// `refs/remotes/<name>/`).
    pub fn set_remote(&self, name: &str, url: &str) -> Result<()> {
        if self.remotes()?.iter().any(|r| r == name) {
            self.run(&["remote", "set-url", name, url], None)?;
        } else {
            self.run(&["remote", "add", name, url], None)?;
        }
        Ok(())
    }

    /// `git remote remove`; a missing remote is fine.
    pub fn remove_remote(&self, name: &str) -> Result<()> {
        self.run_with(&["remote", "remove", name], None, &[], true, false)?;
        Ok(())
    }

    /// `git push <remote> <refspec>…` — NEVER `--force`. [`PushStatus::Ok`], or
    /// [`PushStatus::Rejected`] when the remote refused a non-fast-forward
    /// (git's `[rejected]` / `non-fast-forward` / `fetch first` / `stale info`
    /// lines), or [`PushStatus::Failed`] with git's stderr for anything else
    /// (no network, no such remote).
    pub fn push(&self, remote: &str, refspecs: &[&str]) -> Result<PushStatus> {
        let mut args = vec!["push", "--porcelain", "--quiet", remote];
        args.extend_from_slice(refspecs);
        let r = self.run_with(&args, None, &[], true, false)?;
        if r.status == 0 {
            return Ok(PushStatus::Ok);
        }
        let text = format!("{}\n{}", String::from_utf8_lossy(&r.stdout), r.stderr);
        let rejected = text.contains("[rejected]")
            || text.contains("non-fast-forward")
            || text.contains("fetch first")
            || text.contains("stale info")
            || text.contains("\n!\t");
        Ok(if rejected {
            PushStatus::Rejected(r.stderr.trim().to_owned())
        } else {
            PushStatus::Failed(r.stderr.trim().to_owned())
        })
    }

    /// `git fetch <remote> <refspec>…` (the refspecs may carry `+`: a tracking
    /// ref follows the remote wherever it went). `None` on success, git's
    /// stderr on failure.
    pub fn fetch(&self, remote: &str, refspecs: &[&str]) -> Result<Option<String>> {
        let mut args = vec!["fetch", "--quiet", "--no-tags", remote];
        args.extend_from_slice(refspecs);
        let r = self.run_with(&args, None, &[], true, false)?;
        Ok((r.status != 0).then(|| r.stderr.trim().to_owned()))
    }

    /// `git ls-remote <remote> <ref>`: the sha the remote holds for `ref`,
    /// `None` when it has none; fails when the remote cannot be reached.
    pub fn ls_remote(&self, remote: &str, r: &str) -> Result<Option<String>> {
        let out = self.text(&["ls-remote", remote, r])?;
        let first = out.split('\n').next().unwrap_or("");
        Ok(first
            .split_once('\t')
            .map(|(sha, _)| sha)
            .filter(|sha| is_sha(sha))
            .map(str::to_owned))
    }

    /// The type of an object (`commit`, `blob`, `tree`, `tag`), or `None`
    /// when the object is missing.
    pub fn object_type(&self, sha: &str) -> Result<Option<String>> {
        let r = self.run_with(&["cat-file", "-t", sha], None, &[], true, false)?;
        Ok((r.status == 0).then(|| String::from_utf8_lossy(&r.stdout).trim().to_owned()))
    }

    /// A commit's raw message (`%B`).
    pub fn message(&self, commit: &str) -> Result<String> {
        self.text(&["log", "-1", "--format=%B", commit])
    }

    /// The commits of `branch`, oldest first; `grep` (a fixed string) or
    /// `regex` (extended) narrows to the commits whose message matches.
    pub fn log(
        &self,
        branch: &str,
        grep: Option<&str>,
        regex: Option<&str>,
    ) -> Result<Vec<LogRecord>> {
        if self.tip(branch)?.is_none() {
            return Ok(Vec::new());
        }
        let mut args: Vec<String> = vec![
            "log".into(),
            "--reverse".into(),
            "--format=%H%x1f%ct%x1f%B%x1e".into(),
        ];
        if let Some(g) = grep {
            args.push("--fixed-strings".into());
            args.push(format!("--grep={g}"));
        } else if let Some(r) = regex {
            args.push("--extended-regexp".into());
            args.push(format!("--grep={r}"));
        }
        args.push(format!("refs/heads/{branch}"));
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = self.text(&refs)?;
        Ok(out
            .split('\u{1e}')
            .map(|r| r.strip_prefix('\n').unwrap_or(r))
            .filter(|r| !r.trim().is_empty())
            .map(|r| {
                let mut parts = r.splitn(3, '\u{1f}');
                let sha = parts.next().unwrap_or("").trim().to_owned();
                let unix = parts.next().unwrap_or("0").trim().parse().unwrap_or(0);
                let message = parts.next().unwrap_or("").to_owned();
                LogRecord {
                    sha,
                    committer_unix: unix,
                    message,
                }
            })
            .collect())
    }

    /// `git cat-file --batch` over `<commit>:<path>` specs: the bytes of each,
    /// or `None` when the object is missing (a path not in that tree). One spawn.
    pub fn blobs_at(&self, specs: &[String]) -> Result<Vec<Option<Vec<u8>>>> {
        if specs.is_empty() {
            return Ok(Vec::new());
        }
        let input = format!("{}\n", specs.join("\n"));
        let out = self
            .run(&["cat-file", "--batch"], Some(input.as_bytes()))?
            .stdout;
        let mut result = Vec::with_capacity(specs.len());
        let mut pos = 0usize;
        for _ in specs {
            let Some(nl) = out[pos..].iter().position(|&b| b == b'\n') else {
                result.push(None);
                continue;
            };
            let header = String::from_utf8_lossy(&out[pos..pos + nl]).into_owned();
            pos += nl + 1;
            // `<sha> <type> <size>`; `<spec> missing` / `ambiguous` otherwise.
            let fields: Vec<&str> = header.split(' ').collect();
            let size = match fields.as_slice() {
                [sha, kind, size]
                    if is_sha(sha)
                        && kind.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                        && !size.is_empty()
                        && size.bytes().all(|b| b.is_ascii_digit()) =>
                {
                    size.parse::<usize>().unwrap_or(0)
                }
                _ => {
                    result.push(None);
                    continue;
                }
            };
            let end = (pos + size).min(out.len());
            result.push(Some(out[pos..end].to_vec()));
            pos = end + 1; // the trailing newline after the content
        }
        Ok(result)
    }

    /// `git ls-tree -r <ref>` as text (the fixtures' projection).
    pub fn ls_tree(&self, r: &str) -> Result<String> {
        self.text(&["ls-tree", "-r", r])
    }

    /// `git count-objects -v` as `(key, value)` pairs (`size`/`size-pack` in KiB).
    pub fn count_objects(&self) -> Result<Vec<(String, u64)>> {
        Ok(self
            .text(&["count-objects", "-v"])?
            .lines()
            .filter_map(|l| {
                let (k, v) = l.trim().split_once(": ")?;
                Some((k.to_owned(), v.parse().ok()?))
            })
            .collect())
    }

    /// `git gc --quiet`.
    pub fn gc(&self) -> Result<()> {
        self.run(&["gc", "--quiet"], None)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_date_renders_the_raw_form() {
        assert_eq!(
            git_date("2026-10-20T10:00:00.000Z").unwrap(),
            "@1792490400 +0000"
        );
        assert!(
            git_date("nope")
                .unwrap_err()
                .to_string()
                .contains("RFC 3339")
        );
        assert!(is_sha(ZERO_SHA));
        assert!(!is_sha("r_0"));
        assert!(!is_sha("ABCDEF0123456789ABCDEF0123456789ABCDEF01"));
    }
}
