//! The two conformance seams of `spec/surface` §7.1 / `spec/cli` §2.6, read
//! from the environment at the entry point — before any workspace opens, any
//! id is minted or the clock is read — and the store plumbing they govern:
//! the process-wide id minter and the connection opener every thread uses.
//!
//! `OMGBASE_SPEC_MINTER=sequential` installs the fixture minter (`d_0, d_1,
//! …`, counters fresh at process start and shared by every thread);
//! `OMGBASE_SPEC_CLOCK=<RFC 3339>` makes that instant "now" for every commit
//! a verb stamps and every relative time it renders. Any other value is a
//! usage error (exit 2), validated before even an unknown command is
//! reported. `--version` is answered before the seams are looked at.
//!
//! A third seam is this engine's own, not the spec's:
//! `OMGBASE_WRITER_LOCK_TIMEOUT_MS=<n>` shortens how long a write waits for
//! the workspace writer lock (`spec/sync` §7: 5 s by default) — for a test
//! that proves a held lock fails a write without sitting out the full
//! wait. Read the same way (empty = unset, a non-integer is a usage error)
//! and honored by every lock this process takes: a verb's write tool
//! ([`super::context::Cli::call`]) and `mcp`'s tool boundary.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use omgbase_store::{Capabilities, IdMinter, RandomMinter, SequentialMinter, Store};
use omgbase_sync::WriterLockOptions;

use super::output::{CliError, js_string};

/// `spec/surface` §7.1: `sequential` installs the fixture minter.
pub const SPEC_MINTER_ENV: &str = "OMGBASE_SPEC_MINTER";
/// `spec/surface` §7.1: an RFC 3339 instant that is "now" for the process.
pub const SPEC_CLOCK_ENV: &str = "OMGBASE_SPEC_CLOCK";
/// This engine's test seam: the writer lock's wait in milliseconds
/// (`spec/sync` §7's 5 s when unset).
pub const WRITER_LOCK_TIMEOUT_ENV: &str = "OMGBASE_WRITER_LOCK_TIMEOUT_MS";

/// How long a connection waits on a busy database before failing (the
/// writer lock keeps writers apart; this covers a read overlapping a
/// commit and the drainer's short vector transactions).
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The §7.1 seams as read from the environment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Seams {
    pub sequential_minter: bool,
    /// The pinned clock, canonical `YYYY-MM-DDTHH:MM:SS.fffZ`.
    pub clock: Option<String>,
    /// The writer lock's wait when overridden ([`WRITER_LOCK_TIMEOUT_ENV`]).
    pub writer_lock_timeout_ms: Option<u64>,
}

impl Seams {
    /// How every lock this process takes waits: `spec/sync` §7's defaults,
    /// the timeout overridden by the seam (the poll never exceeds it).
    pub fn lock_options(&self) -> WriterLockOptions {
        let defaults = WriterLockOptions::default();
        match self.writer_lock_timeout_ms {
            None => defaults,
            Some(ms) => {
                let timeout = Duration::from_millis(ms);
                WriterLockOptions {
                    timeout,
                    poll: defaults.poll.min(timeout),
                }
            }
        }
    }
}

/// Read the seams from the process environment (§2.6).
pub fn read_env_seams() -> Result<Seams, CliError> {
    read_seams(
        std::env::var(SPEC_MINTER_ENV).ok().as_deref(),
        std::env::var(SPEC_CLOCK_ENV).ok().as_deref(),
        std::env::var(WRITER_LOCK_TIMEOUT_ENV).ok().as_deref(),
    )
}

/// Validate the values; an empty string is "unset", as the reference reads
/// them. An invalid value is the usage error the fixtures pin.
pub fn read_seams(
    minter: Option<&str>,
    clock: Option<&str>,
    lock_timeout: Option<&str>,
) -> Result<Seams, CliError> {
    let sequential_minter = match minter.filter(|v| !v.is_empty()) {
        None => false,
        Some("sequential") => true,
        Some(other) => {
            return Err(CliError::usage_hint(
                format!(
                    "{SPEC_MINTER_ENV}={}: the only value is \"sequential\" (spec/surface §7.1)",
                    js_string(other)
                ),
                format!("unset it, or set {SPEC_MINTER_ENV}=sequential for a conformance run"),
            ));
        }
    };
    let clock = match clock.filter(|v| !v.is_empty()) {
        None => None,
        Some(v) => Some(canonical_instant(v).ok_or_else(|| {
            CliError::usage_hint(
                format!(
                    "{SPEC_CLOCK_ENV}={}: not an RFC 3339 instant (spec/surface §7.1)",
                    js_string(v)
                ),
                format!("e.g. {SPEC_CLOCK_ENV}=2026-09-27T00:00:00.000Z"),
            )
        })?),
    };
    let writer_lock_timeout_ms = match lock_timeout.filter(|v| !v.is_empty()) {
        None => None,
        Some(v) => Some(v.trim().parse::<u64>().map_err(|_| {
            CliError::usage_hint(
                format!(
                    "{WRITER_LOCK_TIMEOUT_ENV}={}: not a number of milliseconds",
                    js_string(v)
                ),
                format!("unset it, or e.g. {WRITER_LOCK_TIMEOUT_ENV}=200 for a test run"),
            )
        })?),
    };
    Ok(Seams {
        sequential_minter,
        clock,
        writer_lock_timeout_ms,
    })
}

/// An RFC 3339 date-time (`Z` or a `±HH:MM` offset) as the store writes
/// instants (`spec/store` §2.4: UTC, millisecond precision).
pub fn canonical_instant(v: &str) -> Option<String> {
    use omgbase_store::time::{format_ms, parse_ms};
    if let Ok(ms) = parse_ms(v) {
        return Some(format_ms(ms));
    }
    // `<date-time>±HH:MM`: parse the body as UTC, then remove the offset.
    let idx = v.len().checked_sub(6)?;
    let (body, off) = v.split_at(idx);
    let sign = match off.as_bytes().first()? {
        b'+' => 1i64,
        b'-' => -1i64,
        _ => return None,
    };
    let (h, m) = off[1..].split_once(':')?;
    let (h, m): (i64, i64) = (h.parse().ok()?, m.parse().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    let ms = parse_ms(&format!("{body}Z")).ok()?;
    Some(format_ms(ms - sign * (h * 60 + m) * 60_000))
}

/// "Now" as a commit stamps it: the pinned clock, else the wall clock.
pub fn stamp(pinned: Option<&String>) -> String {
    pinned.cloned().unwrap_or_else(omgbase_sync::now_ts)
}

/// Where every thread's store gets its minter: the production CSPRNG
/// minter, or — under the §7.1 seam — one sequential minter shared by the
/// whole process (its counters are process-wide in the reference too), so a
/// watcher checkpoint and a tool call never mint the same id.
#[derive(Clone)]
pub enum MinterSource {
    Random,
    Sequential(Arc<Mutex<SequentialMinter>>),
}

impl MinterSource {
    pub fn from_seams(seams: &Seams) -> Self {
        if seams.sequential_minter {
            Self::Sequential(Arc::new(Mutex::new(SequentialMinter::new())))
        } else {
            Self::Random
        }
    }

    /// A minter for one store.
    pub fn minter(&self) -> Box<dyn IdMinter> {
        match self {
            Self::Random => Box::new(RandomMinter),
            Self::Sequential(shared) => {
                let shared = Arc::clone(shared);
                Box::new(move |prefix: &str| {
                    shared
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .mint(prefix)
                })
            }
        }
    }
}

/// Open a store connection over `db` with the busy timeout every connection
/// of this process carries. The composition point of the modular core
/// (`docs/modular-core/README.md`, Phase 1): the binary assembles the
/// store's capabilities — the history recorder, the semantic provider, the
/// identity-claims oracle — and hands them down; the core only ever sees
/// the traits.
pub fn open_store(db: &Path, minters: &MinterSource) -> Result<Store, String> {
    let store = Store::open_with(db, minters.minter(), Capabilities::standard())
        .map_err(|e| e.to_string())?;
    store
        .conn()
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| format!("busy_timeout: {e}"))?;
    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seams_parse_and_reject() {
        assert_eq!(read_seams(None, None, None).unwrap(), Seams::default());
        let s = read_seams(Some("sequential"), Some("2026-09-27T00:00:00Z"), None).unwrap();
        assert!(s.sequential_minter);
        assert_eq!(s.clock.as_deref(), Some("2026-09-27T00:00:00.000Z"));
        assert_eq!(s.writer_lock_timeout_ms, None);
        assert_eq!(s.lock_options(), WriterLockOptions::default());
        let err = read_seams(Some("random"), None, None).unwrap_err();
        assert_eq!(
            err.message(),
            "OMGBASE_SPEC_MINTER=\"random\": the only value is \"sequential\" (spec/surface §7.1)"
        );
        let err = read_seams(None, Some("yesterday"), None).unwrap_err();
        assert_eq!(
            err.message(),
            "OMGBASE_SPEC_CLOCK=\"yesterday\": not an RFC 3339 instant (spec/surface §7.1)"
        );
        assert!(
            !read_seams(Some(""), Some(""), Some(""))
                .unwrap()
                .sequential_minter
        );
    }

    #[test]
    fn writer_lock_timeout_seam() {
        let s = read_seams(None, None, Some("150")).unwrap();
        assert_eq!(s.writer_lock_timeout_ms, Some(150));
        assert_eq!(
            s.lock_options(),
            WriterLockOptions {
                timeout: Duration::from_millis(150),
                poll: Duration::from_millis(25),
            }
        );
        // The poll never outlasts the wait.
        let s = read_seams(None, None, Some("10")).unwrap();
        assert_eq!(s.lock_options().poll, Duration::from_millis(10));
        assert_eq!(read_seams(None, None, Some("")).unwrap(), Seams::default());
        let err = read_seams(None, None, Some("soon")).unwrap_err();
        assert_eq!(
            err.message(),
            "OMGBASE_WRITER_LOCK_TIMEOUT_MS=\"soon\": not a number of milliseconds"
        );
        assert!(read_seams(None, None, Some("-1")).is_err());
    }

    #[test]
    fn canonical_instant_accepts_offsets() {
        assert_eq!(
            canonical_instant("2026-09-27T02:30:00.5+02:30").as_deref(),
            Some("2026-09-27T00:00:00.500Z")
        );
        assert_eq!(
            canonical_instant("2026-09-26T23:00:00-01:00").as_deref(),
            Some("2026-09-27T00:00:00.000Z")
        );
        assert_eq!(canonical_instant("2026-09-27"), None);
        assert_eq!(canonical_instant("2026-09-27T00:00:00+25:00"), None);
    }

    #[test]
    fn the_sequential_minter_is_shared_across_stores() {
        let minters = MinterSource::from_seams(&Seams {
            sequential_minter: true,
            clock: None,
            writer_lock_timeout_ms: None,
        });
        let mut a = minters.minter();
        let mut b = minters.minter();
        assert_eq!(a.mint("d"), "d_0");
        assert_eq!(b.mint("d"), "d_1");
        assert_eq!(a.mint("b"), "b_0");
        let mut r = MinterSource::Random.minter();
        assert!(r.mint("d").starts_with("d_"));
        assert_eq!(
            stamp(Some(&"2026-09-27T00:00:00.000Z".to_owned())),
            "2026-09-27T00:00:00.000Z"
        );
        assert!(stamp(None).ends_with('Z'));
    }
}
