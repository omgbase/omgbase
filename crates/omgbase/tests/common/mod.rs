//! Helpers shared by the integration tests of the `omgbase` binary.

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

/// A scratch directory removed on drop (the surface runner's).
pub struct TempDir(pub PathBuf);

impl TempDir {
    /// `<tmp>/omgbase-<prefix>-<pid>-<tag>-<nanos>`, canonicalized (macOS's
    /// temp dir is a symlink) so a peer that reports either spelling of the
    /// workspace path is still recognized.
    pub fn new(prefix: &str, tag: &str) -> Self {
        let unique = format!(
            "omgbase-{prefix}-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        );
        let base = std::env::temp_dir();
        let base = fs::canonicalize(&base).unwrap_or(base);
        let dir = base.join(unique);
        fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn path_str(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
