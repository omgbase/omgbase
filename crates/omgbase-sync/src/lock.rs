//! Locks (`spec/sync/README.md` §7): advisory `O_EXCL` lock files under
//! `.omgbase/` holding `{"pid": <holder>, "ts": <ms>}`; a lock whose holder
//! is dead (or whose body is unparsable — §9) is stolen. The writer lock
//! polls; the watch lease is try-only.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};

/// `writer.lock`.
pub const WRITER_LOCK: &str = "writer.lock";
/// `watch.lock`.
pub const WATCH_LEASE: &str = "watch.lock";

/// Whether `pid` is alive: `kill(pid, 0)` succeeds, or fails with `EPERM`
/// (alive but not ours).
#[must_use]
#[allow(unsafe_code)]
pub fn pid_alive(pid: i64) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: `kill` with signal 0 performs no action beyond the permission
    // and existence checks; it takes plain integers and touches no memory.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Send `SIGTERM` to `pid` (a no-op for a non-positive pid).
#[allow(unsafe_code)]
pub(crate) fn send_sigterm(pid: i64) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    if pid <= 0 {
        return;
    }
    // SAFETY: `kill` takes plain integers and touches no memory.
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// The holder pid recorded in a lock file, or `None` when the file is
/// missing, unreadable or not `{"pid": n}`.
#[must_use]
pub fn read_holder_pid(path: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("pid")?.as_i64()
}

/// One attempt: exclusive create with our record; on `EEXIST` steal a dead
/// or unparsable holder's file (unlink, retry once); `false` when a live
/// holder keeps it.
fn try_create(path: &Path) -> Result<bool> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut f) => {
            let record = serde_json::json!({ "pid": std::process::id(), "ts": now_ms() });
            f.write_all(record.to_string().as_bytes())
                .map_err(|e| Error::io("cannot write lock", path, e))?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let holder = read_holder_pid(path);
            let stale = holder.is_none_or(|pid| !pid_alive(pid));
            if !stale {
                return Ok(false);
            }
            if std::fs::remove_file(path).is_err() {
                // Someone else stole it first; the caller retries.
                return Ok(false);
            }
            match OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(mut f) => {
                    let record = serde_json::json!({ "pid": std::process::id(), "ts": now_ms() });
                    f.write_all(record.to_string().as_bytes())
                        .map_err(|e| Error::io("cannot write lock", path, e))?;
                    Ok(true)
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(e) => Err(Error::io("cannot create lock", path, e)),
            }
        }
        Err(e) => Err(Error::io("cannot create lock", path, e)),
    }
}

fn ensure_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).map_err(|e| Error::io("cannot create", dir, e))
}

/// How long a writer waits, and how often it polls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriterLockOptions {
    pub timeout: Duration,
    pub poll: Duration,
}

impl Default for WriterLockOptions {
    /// 5 s, polling every 25 ms (§7).
    fn default() -> Self {
        Self {
            timeout: Duration::from_millis(5000),
            poll: Duration::from_millis(25),
        }
    }
}

/// The workspace writer lock (`writer.lock`), released on drop.
#[derive(Debug)]
pub struct WriterLock {
    path: PathBuf,
    held: bool,
}

impl WriterLock {
    /// The lock file's path under `omgbase_dir`.
    #[must_use]
    pub fn path_in(omgbase_dir: &Path) -> PathBuf {
        omgbase_dir.join(WRITER_LOCK)
    }

    /// Take the lock without waiting; `None` when a live writer holds it.
    pub fn try_acquire(omgbase_dir: &Path) -> Result<Option<Self>> {
        ensure_dir(omgbase_dir)?;
        let path = Self::path_in(omgbase_dir);
        Ok(try_create(&path)?.then(|| Self { path, held: true }))
    }

    /// Take the lock, polling until free or the timeout elapses
    /// ([`Error::WriterLockTimeout`] naming the holder).
    pub fn acquire(omgbase_dir: &Path, opts: WriterLockOptions) -> Result<Self> {
        ensure_dir(omgbase_dir)?;
        let path = Self::path_in(omgbase_dir);
        let deadline = Instant::now() + opts.timeout;
        loop {
            if try_create(&path)? {
                return Ok(Self { path, held: true });
            }
            if Instant::now() >= deadline {
                return Err(Error::WriterLockTimeout {
                    holder_pid: read_holder_pid(&path),
                    lock_path: path,
                });
            }
            std::thread::sleep(opts.poll);
        }
    }

    /// Whether no live writer holds the lock (a probe; acquires nothing).
    #[must_use]
    pub fn is_free(omgbase_dir: &Path) -> bool {
        let path = Self::path_in(omgbase_dir);
        if !path.exists() {
            return true;
        }
        read_holder_pid(&path).is_none_or(|pid| !pid_alive(pid))
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Unlink the lock file (best effort; idempotent).
    pub fn release(&mut self) {
        if !self.held {
            return;
        }
        self.held = false;
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        self.release();
    }
}

/// Run `f` holding the writer lock; released even when `f` fails.
pub fn with_writer_lock<T>(
    omgbase_dir: &Path,
    opts: WriterLockOptions,
    f: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let mut lock = WriterLock::acquire(omgbase_dir, opts)?;
    let out = f();
    lock.release();
    out
}

/// The watch lease (`watch.lock`): held by a live watcher for its lifetime.
#[derive(Debug)]
pub struct WatchLease {
    path: PathBuf,
    held: bool,
}

impl WatchLease {
    /// The lease file's path under `omgbase_dir`.
    #[must_use]
    pub fn path_in(omgbase_dir: &Path) -> PathBuf {
        omgbase_dir.join(WATCH_LEASE)
    }

    /// Take the lease; `None` when a live watcher holds it (a dead holder's
    /// lease is stolen).
    pub fn try_acquire(omgbase_dir: &Path) -> Result<Option<Self>> {
        ensure_dir(omgbase_dir)?;
        let path = Self::path_in(omgbase_dir);
        Ok(try_create(&path)?.then(|| Self { path, held: true }))
    }

    /// Whether a live watcher holds the lease (the one-shot commands' probe).
    #[must_use]
    pub fn live(omgbase_dir: &Path) -> bool {
        let path = Self::path_in(omgbase_dir);
        if !path.exists() {
            return false;
        }
        read_holder_pid(&path).is_some_and(pid_alive)
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn release(&mut self) {
        if !self.held {
            return;
        }
        self.held = false;
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for WatchLease {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::TempDir;

    /// A pid that is certainly dead: a reaped child's.
    fn dead_pid() -> i64 {
        let mut child = std::process::Command::new("true")
            .spawn()
            .expect("spawn true");
        let pid = i64::from(child.id());
        child.wait().unwrap();
        pid
    }

    #[test]
    fn liveness_probe() {
        assert!(pid_alive(i64::from(std::process::id())));
        assert!(pid_alive(1), "pid 1 is alive (EPERM counts as alive)");
        assert!(!pid_alive(dead_pid()));
        assert!(!pid_alive(0));
        assert!(!pid_alive(-5));
        assert!(!pid_alive(i64::MAX));
    }

    #[test]
    fn writer_lock_round_trip_and_timeout() {
        let tmp = TempDir::new("writer");
        let dir = tmp.path().join(".omgbase");
        assert!(WriterLock::is_free(&dir));
        let fast = WriterLockOptions {
            timeout: Duration::from_millis(80),
            poll: Duration::from_millis(10),
        };
        {
            let lock = WriterLock::acquire(&dir, fast).unwrap();
            assert!(lock.path().is_file());
            let body: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(lock.path()).unwrap()).unwrap();
            assert_eq!(body["pid"], std::process::id());
            assert!(body["ts"].is_number());
            assert!(!WriterLock::is_free(&dir));
            assert!(WriterLock::try_acquire(&dir).unwrap().is_none());
            let err = WriterLock::acquire(&dir, fast).unwrap_err();
            match err {
                Error::WriterLockTimeout {
                    holder_pid,
                    lock_path,
                } => {
                    assert_eq!(holder_pid, Some(i64::from(std::process::id())));
                    assert_eq!(lock_path, lock.path());
                }
                other => panic!("{other}"),
            }
            assert!(err_string_names_pid(
                &WriterLock::acquire(&dir, fast).unwrap_err()
            ));
        }
        assert!(WriterLock::is_free(&dir), "released on drop");
        assert!(!WriterLock::path_in(&dir).exists());

        // with_writer_lock releases even on failure.
        let r: Result<()> = with_writer_lock(&dir, fast, || Err(Error::Other("boom".into())));
        assert!(r.is_err());
        assert!(WriterLock::is_free(&dir));
        assert_eq!(with_writer_lock(&dir, fast, || Ok(7)).unwrap(), 7);

        // A dead holder is stolen; so is an unparsable record.
        std::fs::write(
            WriterLock::path_in(&dir),
            format!("{{\"pid\":{}}}", dead_pid()),
        )
        .unwrap();
        assert!(WriterLock::is_free(&dir));
        let l = WriterLock::try_acquire(&dir).unwrap().expect("stolen");
        drop(l);
        std::fs::write(WriterLock::path_in(&dir), "garbage").unwrap();
        assert!(WriterLock::is_free(&dir));
        assert!(WriterLock::try_acquire(&dir).unwrap().is_some());
        assert!(WriterLock::is_free(&dir));
        // Releasing twice is fine.
        let mut l = WriterLock::try_acquire(&dir).unwrap().unwrap();
        l.release();
        l.release();
    }

    fn err_string_names_pid(e: &Error) -> bool {
        e.to_string()
            .contains(&format!("held by pid {}", std::process::id()))
    }

    #[test]
    fn watch_lease_is_try_only_and_probeable() {
        let tmp = TempDir::new("lease");
        let dir = tmp.path().join(".omgbase");
        assert!(!WatchLease::live(&dir));
        let lease = WatchLease::try_acquire(&dir).unwrap().expect("free");
        assert!(WatchLease::live(&dir));
        assert!(WatchLease::try_acquire(&dir).unwrap().is_none());
        assert_eq!(
            read_holder_pid(lease.path()),
            Some(i64::from(std::process::id()))
        );
        drop(lease);
        assert!(!WatchLease::live(&dir));
        std::fs::write(
            WatchLease::path_in(&dir),
            format!("{{\"pid\":{},\"ts\":0}}", dead_pid()),
        )
        .unwrap();
        assert!(!WatchLease::live(&dir), "a dead holder is not live");
        let mut l = WatchLease::try_acquire(&dir)
            .unwrap()
            .expect("stolen from the dead");
        assert!(WatchLease::live(&dir));
        l.release();
        assert!(!WatchLease::path_in(&dir).exists());
        std::fs::write(WatchLease::path_in(&dir), "{}").unwrap();
        assert!(!WatchLease::live(&dir));
        assert!(WatchLease::try_acquire(&dir).unwrap().is_some());
        // The two locks are independent files.
        let _w = WriterLock::try_acquire(&dir).unwrap().unwrap();
        assert!(!WatchLease::live(&dir));
    }
}
