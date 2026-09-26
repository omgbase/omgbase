//! The filesystem seam (`spec/sync/README.md` §4.2): the walk over `.md`
//! files — each directory's entries in **bytewise order of their names**,
//! depth-first (§9: Node's `readdir` sorts through libuv, so a port whose
//! listing is unsorted sorts) — `(mtime_ns, size)` stats and reads, behind a
//! trait so the sweep's I/O stays out of the fixtures. A real implementation
//! over `std::fs` and an in-memory one over a flat path map that walks the
//! same way.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{Error, Result};

/// The directory names the walk skips.
pub const IGNORED_DIRS: [&str; 3] = [".omgbase", ".git", "node_modules"];

/// Whether a directory entry name is one the walk skips.
#[must_use]
pub fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.contains(&name)
}

/// A file's cheap change token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FileStat {
    pub mtime_ns: i64,
    pub size: i64,
}

impl FileStat {
    /// The fs adapter's `revision` (`spec/sync` §5): `"<mtime_ns>:<size>"`.
    #[must_use]
    pub fn revision(&self) -> String {
        format!("{}:{}", self.mtime_ns, self.size)
    }
}

/// Where the fast path's bytes come from. Paths are repo-relative with `/`
/// separators; every method takes the repo root.
pub trait FileSystem {
    /// §4.2: every regular file named `*.md` at any depth under `root`,
    /// skipping [`IGNORED_DIRS`], depth-first with each directory's entries
    /// in bytewise name order.
    fn walk_markdown(&self, root: &Path) -> Result<Vec<String>>;
    /// `(mtime_ns, size)` of `path` under `root`; `None` when absent.
    fn stat(&self, root: &Path, path: &str) -> Result<Option<FileStat>>;
    /// The bytes at `path` as text; `None` when absent.
    fn read(&self, root: &Path, path: &str) -> Result<Option<String>>;
    /// Whether `path` exists under `root`.
    fn exists(&self, root: &Path, path: &str) -> Result<bool> {
        Ok(self.stat(root, path)?.is_some())
    }
}

/// The operating system's filesystem.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RealFileSystem;

fn mtime_ns(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| match t.duration_since(UNIX_EPOCH) {
            Ok(d) => i64::try_from(d.as_nanos()).ok(),
            Err(e) => i64::try_from(e.duration().as_nanos()).ok().map(|n| -n),
        })
        .unwrap_or(0)
}

fn walk_real(dir: &Path, root: &Path, out: &mut Vec<String>) -> Result<()> {
    let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(dir)
        .map_err(|e| Error::io("cannot read directory", dir, e))?
        .collect::<std::io::Result<_>>()
        .map_err(|e| Error::io("cannot read directory entry in", dir, e))?;
    // Bytewise by name, as libuv's `scandir` (`strcmp`) hands Node its listing.
    entries.sort_by(|a, b| {
        a.file_name()
            .as_encoded_bytes()
            .cmp(b.file_name().as_encoded_bytes())
    });
    for entry in entries {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if is_ignored_dir(&name_str) {
            continue;
        }
        let full = entry.path();
        // `statSync(full).isDirectory()`: follows symlinks, like `metadata`.
        let meta = std::fs::metadata(&full).map_err(|e| Error::io("cannot stat", &full, e))?;
        if meta.is_dir() {
            walk_real(&full, root, out)?;
        } else if name_str.ends_with(".md") {
            let rel = full.strip_prefix(root).unwrap_or(&full);
            let parts: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            out.push(parts.join("/"));
        }
    }
    Ok(())
}

impl FileSystem for RealFileSystem {
    fn walk_markdown(&self, root: &Path) -> Result<Vec<String>> {
        let mut out = Vec::new();
        walk_real(root, root, &mut out)?;
        Ok(out)
    }

    fn stat(&self, root: &Path, path: &str) -> Result<Option<FileStat>> {
        let abs = root.join(path);
        match std::fs::metadata(&abs) {
            Ok(meta) => Ok(Some(FileStat {
                mtime_ns: mtime_ns(&meta),
                size: i64::try_from(meta.len()).unwrap_or(i64::MAX),
            })),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::io("cannot stat", abs, e)),
        }
    }

    fn read(&self, root: &Path, path: &str) -> Result<Option<String>> {
        let abs = root.join(path);
        match std::fs::read(&abs) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::io("cannot read", abs, e)),
        }
    }
}

/// One in-memory file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemFile {
    pub content: String,
    pub mtime_ns: i64,
}

/// An in-memory filesystem (the fixture runner's): files keyed by
/// repo-relative path; the walk treats the `/`-separated paths as a directory
/// tree and visits each directory's entries in bytewise name order,
/// depth-first, exactly as [`RealFileSystem`] does (§4.2). The root argument
/// is ignored.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MemFileSystem {
    files: Vec<(String, MemFile)>,
}

impl MemFileSystem {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set `path` to `content` with `mtime_ns` (`size` is the UTF-8 length).
    pub fn set(&mut self, path: &str, content: &str, mtime_ns: i64) {
        let file = MemFile {
            content: content.to_owned(),
            mtime_ns,
        };
        match self.files.iter_mut().find(|(p, _)| p == path) {
            Some((_, f)) => *f = file,
            None => self.files.push((path.to_owned(), file)),
        }
    }

    /// Remove `path` (a no-op when absent).
    pub fn remove(&mut self, path: &str) {
        self.files.retain(|(p, _)| p != path);
    }

    /// The file at `path`.
    #[must_use]
    pub fn get(&self, path: &str) -> Option<&MemFile> {
        self.files.iter().find(|(p, _)| p == path).map(|(_, f)| f)
    }

    /// Every file, in the order they were set.
    #[must_use]
    pub fn files(&self) -> &[(String, MemFile)] {
        &self.files
    }
}

/// One directory of a path tree: entries by name, bytewise.
#[derive(Default)]
struct DirNode {
    files: std::collections::BTreeSet<Vec<u8>>,
    dirs: std::collections::BTreeMap<Vec<u8>, DirNode>,
}

impl DirNode {
    fn insert(&mut self, parts: &[&str]) {
        match parts {
            [] => {}
            [file] => {
                self.files.insert(file.as_bytes().to_vec());
            }
            [dir, rest @ ..] => self
                .dirs
                .entry(dir.as_bytes().to_vec())
                .or_default()
                .insert(rest),
        }
    }

    /// Depth-first, entries (files and directories together) by name.
    fn walk(&self, prefix: &str, out: &mut Vec<String>) {
        let mut names: Vec<(&[u8], bool)> = self
            .files
            .iter()
            .map(|f| (f.as_slice(), false))
            .chain(self.dirs.keys().map(|d| (d.as_slice(), true)))
            .collect();
        names.sort();
        for (name, is_dir) in names {
            let name = String::from_utf8_lossy(name);
            if is_dir {
                if is_ignored_dir(&name) {
                    continue;
                }
                self.dirs[name.as_bytes()].walk(&format!("{prefix}{name}/"), out);
            } else if name.ends_with(".md") {
                out.push(format!("{prefix}{name}"));
            }
        }
    }
}

impl FileSystem for MemFileSystem {
    fn walk_markdown(&self, _root: &Path) -> Result<Vec<String>> {
        let mut root = DirNode::default();
        for (p, _) in &self.files {
            let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
            root.insert(&parts);
        }
        let mut out = Vec::new();
        root.walk("", &mut out);
        Ok(out)
    }

    fn stat(&self, _root: &Path, path: &str) -> Result<Option<FileStat>> {
        Ok(self.get(path).map(|f| FileStat {
            mtime_ns: f.mtime_ns,
            size: i64::try_from(f.content.len()).unwrap_or(i64::MAX),
        }))
    }

    fn read(&self, _root: &Path, path: &str) -> Result<Option<String>> {
        Ok(self.get(path).map(|f| f.content.clone()))
    }
}

/// A temporary directory for tests, removed on drop.
#[doc(hidden)]
pub struct TempDir(pub PathBuf);

impl TempDir {
    /// A fresh, unique directory under the system temp dir.
    #[must_use]
    pub fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("omgbase-sync-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mem_fs_walks_bytewise_per_directory_and_filters() {
        let mut m = MemFileSystem::new();
        m.set("b.md", "b", 2);
        m.set("a.md", "a", 1);
        m.set("dir/c.md", "c", 3);
        m.set("notes.txt", "t", 4);
        m.set(".git/x.md", "x", 5);
        m.set("node_modules/p/y.md", "y", 6);
        m.set("sub/.omgbase/z.md", "z", 7);
        m.set("node_modules.md", "ok", 8);
        m.set("a/x.md", "x", 9);
        let root = Path::new("/ignored");
        assert_eq!(
            m.walk_markdown(root).unwrap(),
            ["a/x.md", "a.md", "b.md", "dir/c.md", "node_modules.md"],
            "bytewise per directory, depth-first: the directory `a` sorts before `a.md`"
        );
        m.set("b.md", "bb", 9);
        assert_eq!(
            m.stat(root, "b.md").unwrap(),
            Some(FileStat {
                mtime_ns: 9,
                size: 2
            })
        );
        assert_eq!(m.stat(root, "b.md").unwrap().unwrap().revision(), "9:2");
        m.remove("b.md");
        m.set("b.md", "b", 10);
        assert_eq!(
            m.walk_markdown(root).unwrap()[2],
            "b.md",
            "insertion order is irrelevant"
        );
        assert_eq!(m.read(root, "a.md").unwrap().as_deref(), Some("a"));
        assert_eq!(m.read(root, "nope.md").unwrap(), None);
        assert!(m.exists(root, "a.md").unwrap());
        assert!(!m.exists(root, "nope.md").unwrap());
        m.remove("nope.md");
        assert_eq!(m.stat(root, "é.md").unwrap(), None);
        m.set("é.md", "é", 1);
        assert_eq!(
            m.stat(root, "é.md").unwrap().unwrap().size,
            2,
            "UTF-8 bytes"
        );
    }

    #[test]
    fn real_fs_walks_skipping_ignored_dirs() {
        let tmp = TempDir::new("fs");
        let root = tmp.path();
        std::fs::create_dir_all(root.join("sub/deep")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(root.join(".omgbase")).unwrap();
        std::fs::write(root.join("a.md"), "# A\n").unwrap();
        std::fs::write(root.join("sub/deep/b.md"), "# B\n").unwrap();
        std::fs::write(root.join("sub/c.txt"), "no").unwrap();
        std::fs::write(root.join(".git/d.md"), "no").unwrap();
        std::fs::write(root.join("node_modules/x/e.md"), "no").unwrap();
        std::fs::write(root.join(".omgbase/f.md"), "no").unwrap();
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a/z.md"), "# Z\n").unwrap();
        std::fs::write(root.join("Z.md"), "# Z\n").unwrap();
        let fs = RealFileSystem;
        assert_eq!(
            fs.walk_markdown(root).unwrap(),
            ["Z.md", "a/z.md", "a.md", "sub/deep/b.md"],
            "bytewise per directory (uppercase first, `a/` before `a.md`), depth-first"
        );
        let st = fs.stat(root, "a.md").unwrap().unwrap();
        assert_eq!(st.size, 4);
        assert!(
            st.mtime_ns > 1_000_000_000_000_000_000,
            "nanoseconds since the epoch"
        );
        assert_eq!(fs.stat(root, "zzz.md").unwrap(), None);
        assert_eq!(fs.read(root, "a.md").unwrap().as_deref(), Some("# A\n"));
        assert_eq!(fs.read(root, "zzz.md").unwrap(), None);
        assert!(fs.exists(root, "sub/deep/b.md").unwrap());
        assert!(fs.walk_markdown(&root.join("missing")).is_err());
    }
}
