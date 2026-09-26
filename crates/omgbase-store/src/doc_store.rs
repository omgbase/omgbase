//! The doc store seam (`spec/mutate/README.md` §4 step 5, ADR-014): the
//! write target of a mutation, keyed by repo-relative path. A filesystem
//! store writes atomically (temp file + rename); an in-memory store backs the
//! fixture runner (file-CAS and the written bytes stay checkable); a headless
//! store does nothing.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Where a mutation's rendered bytes go and where file-CAS reads from. Paths
/// are repo-relative and canonical (`docs.path`).
pub trait DocStore {
    /// Whether a file exists at `path`.
    fn exists(&self, path: &str) -> bool;
    /// The bytes at `path`, or `None` when absent.
    fn read(&self, path: &str) -> Result<Option<String>>;
    /// Write `bytes` to `path` atomically, creating parent directories.
    fn write(&mut self, path: &str, bytes: &str) -> Result<()>;
    /// Rename `from` to `to`, creating the destination's parents.
    fn rename(&mut self, from: &str, to: &str) -> Result<()>;
    /// Remove `path` if present.
    fn remove(&mut self, path: &str) -> Result<()>;
}

/// An in-memory doc store: path → bytes (the fixture runner's, §9).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MemDocStore {
    files: BTreeMap<String, String>,
}

impl MemDocStore {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every file, sorted by path (the `files` projection).
    #[must_use]
    pub fn files(&self) -> &BTreeMap<String, String> {
        &self.files
    }
}

impl DocStore for MemDocStore {
    fn exists(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }

    fn read(&self, path: &str) -> Result<Option<String>> {
        Ok(self.files.get(path).cloned())
    }

    fn write(&mut self, path: &str, bytes: &str) -> Result<()> {
        self.files.insert(path.to_owned(), bytes.to_owned());
        Ok(())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        let bytes = self
            .files
            .remove(from)
            .ok_or_else(|| Error::Other(format!("rename: no file at {from}")))?;
        self.files.insert(to.to_owned(), bytes);
        Ok(())
    }

    fn remove(&mut self, path: &str) -> Result<()> {
        self.files.remove(path);
        Ok(())
    }
}

/// A filesystem doc store rooted at a working tree. Writes go to
/// `<path>.omgtmp` and are renamed into place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FsDocStore {
    root: PathBuf,
}

impl FsDocStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The working-tree root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn abs(&self, path: &str) -> PathBuf {
        self.root.join(path)
    }
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> Error {
    Error::Other(format!("{what} {}: {e}", path.display()))
}

fn ensure_parent(abs: &Path) -> Result<()> {
    if let Some(dir) = abs.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir).map_err(|e| io_err("cannot create", dir, e))?;
    }
    Ok(())
}

impl DocStore for FsDocStore {
    fn exists(&self, path: &str) -> bool {
        self.abs(path).exists()
    }

    fn read(&self, path: &str) -> Result<Option<String>> {
        let abs = self.abs(path);
        if !abs.exists() {
            return Ok(None);
        }
        let bytes = fs::read(&abs).map_err(|e| io_err("cannot read", &abs, e))?;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    fn write(&mut self, path: &str, bytes: &str) -> Result<()> {
        let abs = self.abs(path);
        ensure_parent(&abs)?;
        let mut tmp = abs.clone().into_os_string();
        tmp.push(".omgtmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, bytes).map_err(|e| io_err("cannot write", &tmp, e))?;
        fs::rename(&tmp, &abs).map_err(|e| io_err("cannot rename into", &abs, e))
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        let to_abs = self.abs(to);
        ensure_parent(&to_abs)?;
        fs::rename(self.abs(from), &to_abs).map_err(|e| io_err("cannot rename to", &to_abs, e))
    }

    fn remove(&mut self, path: &str) -> Result<()> {
        let abs = self.abs(path);
        if abs.exists() {
            fs::remove_file(&abs).map_err(|e| io_err("cannot remove", &abs, e))?;
        }
        Ok(())
    }
}

/// A headless doc store: no working tree, every operation a no-op, nothing
/// to CAS against.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NullDocStore;

impl DocStore for NullDocStore {
    fn exists(&self, _path: &str) -> bool {
        false
    }

    fn read(&self, _path: &str) -> Result<Option<String>> {
        Ok(None)
    }

    fn write(&mut self, _path: &str, _bytes: &str) -> Result<()> {
        Ok(())
    }

    fn rename(&mut self, _from: &str, _to: &str) -> Result<()> {
        Ok(())
    }

    fn remove(&mut self, _path: &str) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mem_store_round_trips_and_renames() {
        let mut m = MemDocStore::new();
        assert!(!m.exists("a.md"));
        m.write("a.md", "x\n").unwrap();
        assert_eq!(m.read("a.md").unwrap().as_deref(), Some("x\n"));
        m.rename("a.md", "dir/b.md").unwrap();
        assert!(!m.exists("a.md") && m.exists("dir/b.md"));
        assert!(m.rename("nope", "x").is_err());
        m.remove("dir/b.md").unwrap();
        m.remove("dir/b.md").unwrap();
        assert!(m.files().is_empty());
    }

    #[test]
    fn fs_store_writes_atomically_into_nested_dirs() {
        let dir = std::env::temp_dir().join(format!(
            "omgbase-fs-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let mut s = FsDocStore::new(&dir);
        assert_eq!(s.root(), dir.as_path());
        s.write("a/b/c.md", "hello\n").unwrap();
        assert!(s.exists("a/b/c.md"));
        assert!(!dir.join("a/b/c.md.omgtmp").exists());
        assert_eq!(s.read("a/b/c.md").unwrap().as_deref(), Some("hello\n"));
        s.rename("a/b/c.md", "d/e.md").unwrap();
        assert!(!s.exists("a/b/c.md"));
        assert_eq!(s.read("d/e.md").unwrap().as_deref(), Some("hello\n"));
        s.remove("d/e.md").unwrap();
        assert_eq!(s.read("d/e.md").unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn null_store_does_nothing() {
        let mut n = NullDocStore;
        n.write("a.md", "x").unwrap();
        assert!(!n.exists("a.md"));
        assert_eq!(n.read("a.md").unwrap(), None);
        n.rename("a.md", "b.md").unwrap();
        n.remove("b.md").unwrap();
    }
}
