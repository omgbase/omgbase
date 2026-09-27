//! The transport-free core of the `omgbase-fs-adapter` binary — a Rust
//! implementation of the `fs` sync adapter (`spec/sync/README.md` §5, the
//! reference is `packages/fs-adapter/src/index.ts`): enumerate / fetch /
//! write / remove over a root directory, and a watch that delivers debounced
//! batches of repo-relative changed paths. `main.rs` wraps it in the NDJSON
//! protocol.
//!
//! What must agree with the reference: the walk (§4.2 — every directory's
//! entries in bytewise name order, depth-first, the three ignored directory
//! names, the extension filter), `revision = "<mtime_ns>:<size>"`, `fetch`
//! reading UTF-8 (`null` when absent), `write` creating parent directories,
//! `remove` tolerating an absent file, and the batching of the watch feed:
//! every event adds the changed paths (those matching an extension, outside
//! the ignored directories) to a set and restarts a timer; the set is
//! flushed as one batch after `debounce_ms` of quiet; `stop` discards what
//! is pending.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// The directory names the walk and the watch skip at any depth.
pub const IGNORED_DIRS: [&str; 3] = [".omgbase", ".git", "node_modules"];

/// The suffix the adapter's own temp files carry (never matches an
/// extension a caller would watch; `write` cleans them up).
const TMP_SUFFIX: &str = ".omgbase-tmp";

/// The capabilities line's `capabilities` object, in the reference's key
/// order.
#[must_use]
pub fn capabilities() -> serde_json::Value {
    serde_json::json!({ "identity": "inferred", "writeThrough": true, "watch": true })
}

/// An `enumerate` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsEntry {
    pub path: String,
    pub revision: String,
}

/// A `fetch` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsItem {
    pub path: String,
    pub revision: String,
    pub content: String,
}

/// The adapter's configuration (`--root`, `--ext`, `--debounce-ms`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    pub root: PathBuf,
    /// The file name suffixes to include (default `[".md"]`).
    pub ext: Vec<String>,
    /// Quiet time before a watch batch is flushed (default 750 ms).
    pub debounce: Duration,
}

impl Options {
    /// Parse the binary's argv (without the program name): `--root <dir>`
    /// (required), `--ext <suffix>` (repeatable), `--debounce-ms <n>`; each
    /// also as `--flag=value`. Unknown flags and positionals are errors, as
    /// with Node's strict `parseArgs`.
    pub fn parse<I, S>(args: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut root: Option<PathBuf> = None;
        let mut ext: Vec<String> = Vec::new();
        let mut debounce: Option<Duration> = None;
        let mut it = args.into_iter();
        while let Some(arg) = it.next() {
            let arg = arg.as_ref();
            let (flag, inline) = match arg.split_once('=') {
                Some((f, v)) if f.starts_with("--") => (f.to_owned(), Some(v.to_owned())),
                _ => (arg.to_owned(), None),
            };
            let mut value = |name: &str| -> Result<String, String> {
                match inline.clone() {
                    Some(v) => Ok(v),
                    None => it
                        .next()
                        .map(|s| s.as_ref().to_owned())
                        .ok_or_else(|| format!("option '{name} <value>' argument missing")),
                }
            };
            match flag.as_str() {
                "--root" => root = Some(PathBuf::from(value("--root")?)),
                "--ext" => ext.push(value("--ext")?),
                "--debounce-ms" => {
                    let raw = value("--debounce-ms")?;
                    let ms: u64 = raw
                        .trim()
                        .parse()
                        .map_err(|_| format!("--debounce-ms: not a number: {raw}"))?;
                    debounce = Some(Duration::from_millis(ms));
                }
                other => return Err(format!("unknown option '{other}'")),
            }
        }
        let root = root.ok_or_else(|| "--root <path> is required".to_owned())?;
        Ok(Self {
            root,
            ext: if ext.is_empty() {
                vec![".md".to_owned()]
            } else {
                ext
            },
            debounce: debounce.unwrap_or(Duration::from_millis(750)),
        })
    }
}

/// `true` when `path` (any spelling, `/` or the OS separator) has a component
/// named like one of [`IGNORED_DIRS`] — the reference's `isIgnored` regex.
#[must_use]
pub fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        IGNORED_DIRS.contains(&s.as_ref())
    })
}

/// The cheap change token of a file: `"<mtime_ns>:<size>"` (a stat, no
/// read).
pub fn revision_of(abs: &Path) -> io::Result<String> {
    let meta = std::fs::metadata(abs)?;
    Ok(format!("{}:{}", mtime_ns(&meta), meta.len()))
}

/// Nanoseconds since the epoch of the metadata's mtime (negative before it),
/// as Node's `BigInt` `mtimeNs`.
fn mtime_ns(meta: &std::fs::Metadata) -> i128 {
    match meta.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => i128::try_from(d.as_nanos()).unwrap_or(0),
            Err(e) => -i128::try_from(e.duration().as_nanos()).unwrap_or(0),
        },
        Err(_) => 0,
    }
}

/// A path relative to `root` as the protocol spells it: components joined
/// with `/`.
fn relative_key(root: &Path, full: &Path) -> String {
    let rel = full.strip_prefix(root).unwrap_or(full);
    rel.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// The adapter over one root.
#[derive(Debug, Clone)]
pub struct FsAdapter {
    root: PathBuf,
    /// The root with symlinks resolved (macOS reports FSEvents under
    /// `/private/var/…` for a root spelled `/var/…`); `None` when it equals
    /// `root` or cannot be resolved.
    root_canon: Option<PathBuf>,
    ext: Vec<String>,
    debounce: Duration,
}

impl FsAdapter {
    #[must_use]
    pub fn new(opts: Options) -> Self {
        let root_canon = std::fs::canonicalize(&opts.root)
            .ok()
            .filter(|c| c != &opts.root);
        Self {
            root: opts.root,
            root_canon,
            ext: opts.ext,
            debounce: opts.debounce,
        }
    }

    /// The root this adapter serves.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Whether a file name (or path) ends with one of the configured suffixes.
    #[must_use]
    pub fn matches(&self, name: &str) -> bool {
        self.ext.iter().any(|e| name.ends_with(e.as_str()))
    }

    fn abs(&self, path: &str) -> PathBuf {
        self.root.join(path)
    }

    /// The walk of §4.2 under `dir` (absolute), keys relative to the root.
    fn walk_into(&self, dir: &Path, out: &mut Vec<String>) -> io::Result<()> {
        let mut entries: Vec<std::fs::DirEntry> =
            std::fs::read_dir(dir)?.collect::<io::Result<_>>()?;
        // Bytewise by name, as libuv's `scandir` hands Node its listing.
        entries.sort_by(|a, b| {
            a.file_name()
                .as_encoded_bytes()
                .cmp(b.file_name().as_encoded_bytes())
        });
        for entry in entries {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if IGNORED_DIRS.contains(&name.as_ref()) {
                continue;
            }
            let full = entry.path();
            // `statSync(full).isDirectory()` follows symlinks, like `metadata`.
            if std::fs::metadata(&full)?.is_dir() {
                self.walk_into(&full, out)?;
            } else if self.matches(&name) {
                out.push(self.key_of(&full));
            }
        }
        Ok(())
    }

    /// The repo-relative key of an absolute path under either spelling of
    /// the root.
    fn key_of(&self, full: &Path) -> String {
        if full.starts_with(&self.root) {
            return relative_key(&self.root, full);
        }
        match &self.root_canon {
            Some(c) if full.starts_with(c) => relative_key(c, full),
            _ => relative_key(&self.root, full),
        }
    }

    /// Every matching file under the root, in walk order.
    pub fn walk(&self) -> io::Result<Vec<String>> {
        let mut out = Vec::new();
        self.walk_into(&self.root, &mut out)?;
        Ok(out)
    }

    /// `enumerate`: the walk with stat revisions.
    pub fn enumerate(&self) -> io::Result<Vec<FsEntry>> {
        self.walk()?
            .into_iter()
            .map(|path| {
                let revision = revision_of(&self.abs(&path))?;
                Ok(FsEntry { path, revision })
            })
            .collect()
    }

    /// `fetch`: the file's content as UTF-8 (invalid sequences become
    /// U+FFFD, as Node's `"utf8"` decoding), `None` when the path does not
    /// exist.
    pub fn fetch(&self, path: &str) -> io::Result<Option<FsItem>> {
        let abs = self.abs(path);
        if !abs.exists() {
            return Ok(None);
        }
        let revision = revision_of(&abs)?;
        let bytes = std::fs::read(&abs)?;
        let content = match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
        };
        Ok(Some(FsItem {
            path: path.to_owned(),
            revision,
            content,
        }))
    }

    /// `write`: parent directories created, then an atomic temp file +
    /// rename onto the target.
    pub fn write(&self, path: &str, content: &str) -> io::Result<()> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let abs = self.abs(path);
        let parent = abs.parent().unwrap_or(&self.root);
        std::fs::create_dir_all(parent)?;
        let name = abs
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let tmp = parent.join(format!(
            ".{name}.{}.{}{TMP_SUFFIX}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let written = std::fs::write(&tmp, content).and_then(|()| std::fs::rename(&tmp, &abs));
        if written.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        written
    }

    /// `remove`: unlink if present (`rmSync` with `force`).
    pub fn remove(&self, path: &str) -> io::Result<()> {
        let abs = self.abs(path);
        match std::fs::remove_file(&abs) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Watch the tree; `on_batch` receives the debounced batches of
    /// repo-relative changed paths (in first-seen order, deduplicated). The
    /// watcher is established when this returns — every change from then on
    /// is reported — so the caller may announce readiness at once.
    pub fn watch<F>(&self, on_batch: F) -> notify::Result<WatchHandle>
    where
        F: FnMut(Vec<String>) + Send + 'static,
    {
        let (tx, rx) = channel::<Msg>();
        let events = tx.clone();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    // Reads (inotify reports opens) and rescans carry no change.
                    if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
                        return;
                    }
                    let _ = events.send(Msg::Paths(event.paths));
                }
            })?;
        watcher.watch(&self.root, RecursiveMode::Recursive)?;
        let adapter = Arc::new(self.clone());
        let known: HashSet<String> = adapter.walk().unwrap_or_default().into_iter().collect();
        let debounce = self.debounce;
        let thread = std::thread::Builder::new()
            .name("omgbase-fs-adapter-debounce".to_owned())
            .spawn(move || debounce_loop(&adapter, &rx, known, debounce, on_batch))
            .map_err(notify::Error::io)?;
        Ok(WatchHandle {
            watcher: Some(watcher),
            tx,
            thread: Some(thread),
        })
    }
}

enum Msg {
    Paths(Vec<PathBuf>),
    Stop,
}

/// A live watch; `stop` (or drop) ends the feed, discarding what is pending.
pub struct WatchHandle {
    watcher: Option<RecommendedWatcher>,
    tx: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
}

impl WatchHandle {
    /// Stop the watcher, then the debounce thread (pending paths are
    /// dropped, as the reference's `stop` clears its timer).
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        // The OS watcher first, so no event follows the stop.
        drop(self.watcher.take());
        let _ = self.tx.send(Msg::Stop);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.shutdown();
        }
    }
}

/// The reference's debounce-to-quiescence: collect keys into an
/// insertion-ordered set, restart the timer on every event, flush when
/// `debounce` passes with nothing new; end on `Stop` or a closed channel.
fn debounce_loop<F>(
    adapter: &FsAdapter,
    rx: &Receiver<Msg>,
    mut known: HashSet<String>,
    debounce: Duration,
    mut on_batch: F,
) where
    F: FnMut(Vec<String>),
{
    let mut pending: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut deadline: Option<Instant> = None;
    loop {
        let msg = match deadline {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())),
        };
        match msg {
            Ok(Msg::Paths(paths)) => {
                let before = pending.len();
                for p in paths {
                    adapter.changed(&p, &mut known, &mut |key| {
                        if seen.insert(key.clone()) {
                            pending.push(key);
                        }
                    });
                }
                if pending.len() > before || deadline.is_some() {
                    deadline = Some(Instant::now() + debounce);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                deadline = None;
                if !pending.is_empty() {
                    seen.clear();
                    on_batch(std::mem::take(&mut pending));
                }
            }
            Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

impl FsAdapter {
    /// One event path → the keys it means for the feed. A matching file
    /// (present or gone) is itself. A path outside the extensions is a
    /// directory candidate: one that exists is walked for matching files not
    /// yet known (a folder moved into the tree — the OS reports the folder,
    /// not its files), one that is gone takes every known file under it
    /// with it (a folder moved out or deleted). Anything under an ignored
    /// directory, or outside the root, is dropped.
    fn changed(&self, abs: &Path, known: &mut HashSet<String>, emit: &mut dyn FnMut(String)) {
        let under_root = abs.starts_with(&self.root)
            || self.root_canon.as_ref().is_some_and(|c| abs.starts_with(c));
        if !under_root {
            return;
        }
        let key = self.key_of(abs);
        if key.is_empty() || is_ignored(Path::new(&key)) {
            return;
        }
        if self.matches(&key) {
            if abs.exists() {
                known.insert(key.clone());
            } else {
                known.remove(&key);
            }
            emit(key);
            return;
        }
        match std::fs::metadata(abs) {
            Ok(meta) if meta.is_dir() => {
                let mut found = Vec::new();
                if self.walk_into(abs, &mut found).is_ok() {
                    for k in found {
                        if known.insert(k.clone()) {
                            emit(k);
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(_) => {
                let prefix = format!("{key}/");
                let gone: Vec<String> = known
                    .iter()
                    .filter(|k| k.starts_with(&prefix))
                    .cloned()
                    .collect();
                for k in gone {
                    known.remove(&k);
                    emit(k);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir();
            let base = std::fs::canonicalize(&base).unwrap_or(base);
            let dir = base.join(format!(
                "omgbase-fsadapter-{}-{tag}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
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

    fn setup(tag: &str) -> TempDir {
        let t = TempDir::new(tag);
        let d = t.path();
        std::fs::write(d.join("a.md"), "# A\n\nalpha\n").unwrap();
        std::fs::create_dir(d.join("sub")).unwrap();
        std::fs::write(d.join("sub/b.md"), "# B\n\nbeta\n").unwrap();
        std::fs::write(d.join("ignore.txt"), "not markdown\n").unwrap();
        t
    }

    fn adapter(root: &Path, debounce_ms: u64) -> FsAdapter {
        FsAdapter::new(Options {
            root: root.to_path_buf(),
            ext: vec![".md".into()],
            debounce: Duration::from_millis(debounce_ms),
        })
    }

    #[test]
    fn parses_argv_like_the_reference() {
        let o = Options::parse(["--root", "/vault"]).unwrap();
        assert_eq!(o.root, PathBuf::from("/vault"));
        assert_eq!(o.ext, [".md"]);
        assert_eq!(o.debounce, Duration::from_millis(750));
        let o = Options::parse([
            "--ext",
            ".md",
            "--root=/v",
            "--ext",
            ".markdown",
            "--debounce-ms",
            "100",
        ])
        .unwrap();
        assert_eq!(o.root, PathBuf::from("/v"));
        assert_eq!(o.ext, [".md", ".markdown"]);
        assert_eq!(o.debounce, Duration::from_millis(100));
        assert_eq!(
            Options::parse(Vec::<String>::new()).unwrap_err(),
            "--root <path> is required"
        );
        assert!(Options::parse(["--root", "/v", "--nope"]).is_err());
        assert!(Options::parse(["--root", "/v", "--debounce-ms", "x"]).is_err());
        assert!(Options::parse(["--root"]).is_err());
    }

    #[test]
    fn walk_is_bytewise_per_directory_depth_first_and_filtered() {
        let t = TempDir::new("walk");
        let d = t.path();
        for f in [
            "a.md", "B.md", "z.md", "a/x.md", "a/1.md", "b.txt", "a-1.md",
        ] {
            let p = d.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "x\n").unwrap();
        }
        for ignored in IGNORED_DIRS {
            std::fs::create_dir_all(d.join(ignored)).unwrap();
            std::fs::write(d.join(ignored).join("hidden.md"), "no\n").unwrap();
        }
        let a = adapter(d, 10);
        // Bytewise: `B.md` < `a` < `a-1.md` < `a.md` < `z.md`; `a` is
        // descended in place, its own listing sorted (`1.md` < `x.md`).
        assert_eq!(
            a.walk().unwrap(),
            ["B.md", "a/1.md", "a/x.md", "a-1.md", "a.md", "z.md"]
        );
    }

    #[test]
    fn the_extension_filter_is_a_suffix_test_over_every_configured_suffix() {
        let t = TempDir::new("ext");
        let d = t.path();
        for f in ["a.md", "b.markdown", "c.txt", "d.MD"] {
            std::fs::write(d.join(f), "x\n").unwrap();
        }
        let a = FsAdapter::new(Options {
            root: d.to_path_buf(),
            ext: vec![".md".into(), ".markdown".into()],
            debounce: Duration::from_millis(10),
        });
        assert_eq!(a.walk().unwrap(), ["a.md", "b.markdown"]);
        assert!(a.matches("sub/x.md") && !a.matches("x.md.bak"));
    }

    #[test]
    fn enumerate_carries_mtime_ns_and_size_revisions() {
        let t = setup("enum");
        let a = adapter(t.path(), 10);
        let entries = a.enumerate().unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["a.md", "sub/b.md"]);
        let (ns, size) = entries[0].revision.split_once(':').unwrap();
        assert!(ns.parse::<u128>().is_ok() && ns.len() >= 19, "{ns}");
        assert_eq!(size, "# A\n\nalpha\n".len().to_string());
        // A different mtime or size is a different revision.
        let f = std::fs::File::options()
            .write(true)
            .open(t.path().join("a.md"))
            .unwrap();
        f.set_modified(std::time::SystemTime::now() + Duration::from_secs(5))
            .unwrap();
        drop(f);
        assert_ne!(
            a.fetch("a.md").unwrap().unwrap().revision,
            entries[0].revision
        );
    }

    #[test]
    fn fetch_reads_utf8_and_is_none_when_absent() {
        let t = setup("fetch");
        let a = adapter(t.path(), 10);
        let item = a.fetch("a.md").unwrap().unwrap();
        assert_eq!(item.path, "a.md");
        assert_eq!(item.content, "# A\n\nalpha\n");
        assert!(a.fetch("nope.md").unwrap().is_none());
        std::fs::write(t.path().join("bad.md"), b"ok \xff\xfe end\n").unwrap();
        assert_eq!(
            a.fetch("bad.md").unwrap().unwrap().content,
            "ok \u{FFFD}\u{FFFD} end\n"
        );
    }

    #[test]
    fn write_is_atomic_creates_parents_and_leaves_no_temp_file() {
        let t = setup("write");
        let a = adapter(t.path(), 10);
        a.write("new/deep/c.md", "# C\n").unwrap();
        assert_eq!(a.fetch("new/deep/c.md").unwrap().unwrap().content, "# C\n");
        a.write("new/deep/c.md", "# C2\n").unwrap();
        assert_eq!(a.fetch("new/deep/c.md").unwrap().unwrap().content, "# C2\n");
        let leftovers: Vec<_> = std::fs::read_dir(t.path().join("new/deep"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, ["c.md"]);
        a.remove("new/deep/c.md").unwrap();
        assert!(a.fetch("new/deep/c.md").unwrap().is_none());
        a.remove("new/deep/c.md").unwrap();
        // The temp file never matches the watched extension.
        assert!(!a.matches(&format!(".c.md.1.2{TMP_SUFFIX}")));
    }

    #[test]
    fn ignored_paths_are_any_component() {
        assert!(is_ignored(Path::new(".git/HEAD")));
        assert!(is_ignored(Path::new("a/node_modules/x/y.md")));
        assert!(is_ignored(Path::new("a/.omgbase")));
        assert!(!is_ignored(Path::new("a/.gitignore.md")));
        assert!(!is_ignored(Path::new("a/nodes/x.md")));
    }

    fn collect(a: &FsAdapter) -> (WatchHandle, Arc<Mutex<Vec<Vec<String>>>>) {
        let batches = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&batches);
        let w = a
            .watch(move |paths| sink.lock().unwrap().push(paths))
            .unwrap();
        // Let the OS stream settle; discard anything spurious at startup.
        std::thread::sleep(Duration::from_millis(300));
        batches.lock().unwrap().clear();
        (w, batches)
    }

    fn wait_batches(
        batches: &Arc<Mutex<Vec<Vec<String>>>>,
        want: usize,
        timeout: Duration,
    ) -> Vec<Vec<String>> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if batches.lock().unwrap().len() >= want {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // Any straggler batch that follows within the debounce window.
        std::thread::sleep(Duration::from_millis(300));
        batches.lock().unwrap().clone()
    }

    #[test]
    fn watch_coalesces_changes_into_one_debounced_batch() {
        let t = setup("watch");
        let a = adapter(t.path(), 200);
        let (w, batches) = collect(&a);
        std::fs::write(t.path().join("c.md"), "# C\n").unwrap();
        std::fs::write(t.path().join("a.md"), "# A\n\nchanged\n").unwrap();
        std::fs::write(t.path().join("ignore.txt"), "still not markdown\n").unwrap();
        std::fs::create_dir_all(t.path().join(".git")).unwrap();
        std::fs::write(t.path().join(".git/x.md"), "hidden\n").unwrap();
        let got = wait_batches(&batches, 1, Duration::from_secs(5));
        w.stop();
        assert_eq!(got.len(), 1, "coalesced: {got:?}");
        let mut paths = got[0].clone();
        paths.sort();
        assert_eq!(paths, ["a.md", "c.md"]);
    }

    #[test]
    fn watch_reports_removals_and_the_adapters_own_writes() {
        let t = setup("watch-rm");
        let a = adapter(t.path(), 150);
        let (w, batches) = collect(&a);
        a.remove("sub/b.md").unwrap();
        let got = wait_batches(&batches, 1, Duration::from_secs(5));
        assert_eq!(got.concat(), ["sub/b.md"]);
        batches.lock().unwrap().clear();
        a.write("sub/d.md", "# D\n").unwrap();
        let got = wait_batches(&batches, 1, Duration::from_secs(5));
        w.stop();
        let all = got.concat();
        assert_eq!(all, ["sub/d.md"], "the temp file is not reported: {got:?}");
    }

    #[test]
    fn a_directory_moved_in_or_out_is_expanded_to_its_files() {
        let t = setup("watch-dir");
        let staging = TempDir::new("staging");
        std::fs::create_dir_all(staging.path().join("pack")).unwrap();
        std::fs::write(staging.path().join("pack/p1.md"), "1\n").unwrap();
        std::fs::write(staging.path().join("pack/p2.md"), "2\n").unwrap();
        std::fs::write(staging.path().join("pack/p.txt"), "no\n").unwrap();
        let a = adapter(t.path(), 150);
        let (w, batches) = collect(&a);
        std::fs::rename(staging.path().join("pack"), t.path().join("pack")).unwrap();
        let got = wait_batches(&batches, 1, Duration::from_secs(5));
        let mut all = got.concat();
        all.sort();
        all.dedup();
        assert_eq!(all, ["pack/p1.md", "pack/p2.md"], "{got:?}");
        batches.lock().unwrap().clear();
        std::fs::rename(t.path().join("pack"), staging.path().join("pack")).unwrap();
        let got = wait_batches(&batches, 1, Duration::from_secs(5));
        w.stop();
        let mut all = got.concat();
        all.sort();
        all.dedup();
        assert_eq!(all, ["pack/p1.md", "pack/p2.md"], "{got:?}");
    }

    #[test]
    fn stop_discards_what_is_pending() {
        let t = setup("watch-stop");
        let a = adapter(t.path(), 2_000);
        let (w, batches) = collect(&a);
        std::fs::write(t.path().join("late.md"), "# late\n").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        w.stop();
        std::thread::sleep(Duration::from_millis(300));
        assert!(batches.lock().unwrap().is_empty());
    }
}
