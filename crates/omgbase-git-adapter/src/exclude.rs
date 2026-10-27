//! The user's own repository is never touched — except for ONE line in its
//! `.git/info/exclude` (never `.gitignore`, a tracked file): `.omgbase/`, so
//! the engine's bare repository and database are not offered to the user's
//! `git add`. A worktree's `.git` is a FILE (`gitdir: <path>`); the exclude
//! file then lives under the pointed-to directory (a worktree's `info/` is
//! the common dir's; `git rev-parse --git-path info/exclude` would say the
//! same, but no git is spawned on the user's repository).

use std::fs;
use std::path::{Path, PathBuf};

/// The line ensured in the exclude file.
pub const EXCLUDE_LINE: &str = ".omgbase/";

/// What [`ensure_excluded`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Excluded {
    /// No `.git` at the root: nothing to exclude from.
    Absent,
    /// The line was already there.
    Present,
    /// The line was appended.
    Added,
}

/// Node's `path.resolve(base, p)` for the gitdir pointer.
fn resolve(base: &Path, p: &str) -> PathBuf {
    let joined = if p.starts_with('/') {
        PathBuf::from(p)
    } else {
        base.join(p)
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The `.git/info/exclude` path of a repository rooted at `root`, or `None`
/// when `root/.git` does not exist (or is a pointer file that names nothing).
#[must_use]
pub fn exclude_file_for(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    let meta = fs::metadata(&dot_git).ok()?;
    let mut git_dir = dot_git.clone();
    if meta.is_file() {
        let text = fs::read_to_string(&dot_git).ok()?;
        let pointer = text
            .lines()
            .find_map(|l| l.strip_prefix("gitdir:"))
            .map(str::trim)?;
        git_dir = resolve(root, pointer);
        // A linked worktree's gitdir is `<common>/worktrees/<name>`; `info/` is the common dir's.
        let common = git_dir.join("commondir");
        if let Ok(rel) = fs::read_to_string(&common) {
            git_dir = resolve(&git_dir, rel.trim());
        }
    }
    Some(git_dir.join("info").join("exclude"))
}

/// Ensure `.omgbase/` is listed in the user's `.git/info/exclude`; returns what was done.
pub fn ensure_excluded(root: &Path) -> std::io::Result<Excluded> {
    let Some(file) = exclude_file_for(root) else {
        return Ok(Excluded::Absent);
    };
    let existing = fs::read_to_string(&file).unwrap_or_default();
    if existing
        .split('\n')
        .any(|l| l.trim() == EXCLUDE_LINE || l.trim() == ".omgbase")
    {
        return Ok(Excluded::Present);
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(EXCLUDE_LINE);
    text.push('\n');
    fs::write(&file, text)?;
    Ok(Excluded::Added)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omgbase-git-adapter-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn adds_the_line_once_finds_a_worktrees_common_dir_and_leaves_a_workspace_without_git_alone() {
        let root = temp("exclude");
        assert_eq!(exclude_file_for(&root), None);
        assert_eq!(ensure_excluded(&root).unwrap(), Excluded::Absent);
        // A plain repository: `.git/` is a directory.
        fs::create_dir_all(root.join(".git").join("info")).unwrap();
        fs::write(root.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        assert_eq!(ensure_excluded(&root).unwrap(), Excluded::Added);
        assert_eq!(
            fs::read_to_string(root.join(".git/info/exclude")).unwrap(),
            ".omgbase/\n"
        );
        assert_eq!(ensure_excluded(&root).unwrap(), Excluded::Present);
        // A worktree: `.git` is a file pointing at `<common>/worktrees/<name>`.
        let wt = temp("exclude-wt");
        fs::create_dir_all(root.join(".git/worktrees/wt")).unwrap();
        fs::write(root.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", root.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        assert_eq!(
            exclude_file_for(&wt),
            Some(root.join(".git").join("info").join("exclude"))
        );
        assert_eq!(ensure_excluded(&wt).unwrap(), Excluded::Present);
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&wt);
    }
}
