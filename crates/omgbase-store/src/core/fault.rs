//! Fault injection outside the fixture runners (modular-core Phase 5a; the
//! plan's §8 acceptance matrix — "recovery", "optional history", "retention"
//! rows exercised with a fault at a named site, not a mocked recorder;
//! `spec/store` §9.7). The twin of the reference's `core/fault.ts`.
//!
//! ```text
//! OMGBASE_FAULT=<site>[:<nth>]
//! ```
//!
//! A TEST-ONLY hook, read from the environment on every pass through a site
//! (so a test can set and clear it between writes). The engine passes a site
//! when it is about to do the thing the site names; the `nth` pass — the
//! first when no count is given — raises [`Error::InjectedFault`], carrying
//! the site and the pass, caught by nothing the engine owns except where a
//! site sits inside a [`capture`](crate::core::manifest::capture) (there it
//! becomes [`Error::CaptureFailed`], as any recorder failure does). Every
//! other pass is a no-op. The sites are spelled identically by both engines:
//!
//! | site | where | outcome |
//! | --- | --- | --- |
//! | `recorder.capture` | inside the recorder's capture wrapper, before the recorder runs | the member is rolled back, `capture_failed` raised |
//! | `feed.append` | inside the commit transaction, before the feed row is inserted | the whole transaction rolls back, nothing minted |
//! | `commit.after-commit` | after the api path's transaction committed, before any file is written | the rows are durable, the pending rows owe the files; `recover_repo` replays them |
//! | `materialize.before-write` | inside the materializer, before a file is written | the pending row stays; the next replay writes it |
//! | `materialize.after-write` | inside the materializer, after the file was written, before its row is deleted | the next replay finds the bytes and clears the row |
//! | `git.commit` | (17.5, Phase 6a) inside the git history provider's checkpoint worker, after the blobs, the tree and the commit object are written and before `update-ref` moves the branch | the tip is unchanged, the objects dangle; the next run resumes from the tip's `omgbase-seq` trailer and writes the same commit byte for byte |
//!
//! Counting is per site and per process: `OMGBASE_FAULT=feed.append:2`
//! raises on the second feed row this process appends. [`reset_faults`]
//! restarts the counts (tests).

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::error::{Error, Result};

/// The environment variable that arms a site.
pub const FAULT_ENV: &str = "OMGBASE_FAULT";

/// The six sites, in the reference's order (`git.commit` since 17.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FaultSite {
    RecorderCapture,
    FeedAppend,
    CommitAfterCommit,
    MaterializeBeforeWrite,
    MaterializeAfterWrite,
    GitCommit,
}

/// Every site, in the reference's order (`FAULT_SITES`).
pub const FAULT_SITES: [FaultSite; 6] = [
    FaultSite::RecorderCapture,
    FaultSite::FeedAppend,
    FaultSite::CommitAfterCommit,
    FaultSite::MaterializeBeforeWrite,
    FaultSite::MaterializeAfterWrite,
    FaultSite::GitCommit,
];

impl FaultSite {
    /// The site's name on the wire (`OMGBASE_FAULT`, the error message).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            FaultSite::RecorderCapture => "recorder.capture",
            FaultSite::FeedAppend => "feed.append",
            FaultSite::CommitAfterCommit => "commit.after-commit",
            FaultSite::MaterializeBeforeWrite => "materialize.before-write",
            FaultSite::MaterializeAfterWrite => "materialize.after-write",
            FaultSite::GitCommit => "git.commit",
        }
    }

    /// The site a name denotes, if any.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        FAULT_SITES.into_iter().find(|site| site.as_str() == s)
    }

    const fn index(self) -> usize {
        match self {
            FaultSite::RecorderCapture => 0,
            FaultSite::FeedAppend => 1,
            FaultSite::CommitAfterCommit => 2,
            FaultSite::MaterializeBeforeWrite => 3,
            FaultSite::MaterializeAfterWrite => 4,
            FaultSite::GitCommit => 5,
        }
    }
}

impl std::fmt::Display for FaultSite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The message an armed site raises with on its nth pass — pinned:
/// `injected fault at <site> (pass <n>)`.
#[must_use]
pub fn injected_fault_message(site: FaultSite, pass: usize) -> String {
    format!("injected fault at {site} (pass {pass})")
}

/// What `OMGBASE_FAULT` arms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArmedFault {
    pub site: FaultSite,
    pub nth: usize,
}

/// The sites' names joined for the configuration error.
fn site_names() -> String {
    FAULT_SITES
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Parse the variable's value: `Some(ArmedFault)`, or `None` when empty; an
/// unknown site or a bad count is a configuration error (the reference's
/// `armedFault`, the messages alike).
pub fn parse_fault(raw: &str) -> Result<Option<ArmedFault>> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let (site_text, nth_text) = match raw.split_once(':') {
        Some((s, n)) => (s, Some(n)),
        None => (raw, None),
    };
    let Some(site) = FaultSite::parse(site_text) else {
        return Err(Error::Other(format!(
            "{FAULT_ENV}={raw:?}: unknown fault site {site_text:?}; the sites are {}",
            site_names()
        )));
    };
    let nth = match nth_text {
        None => 1,
        Some(n) => match n.parse::<usize>() {
            Ok(n) if n >= 1 => n,
            _ => {
                return Err(Error::Other(format!(
                    "{FAULT_ENV}={raw:?}: the count after ':' must be a positive integer"
                )));
            }
        },
    };
    Ok(Some(ArmedFault { site, nth }))
}

/// The in-process twin of the variable (a test seam): a fixture runner whose
/// threads read the environment concurrently cannot set it safely, so it arms
/// the site here instead — consulted before `OMGBASE_FAULT`.
static OVERRIDE: Mutex<Option<ArmedFault>> = Mutex::new(None);

/// Arm (or disarm, with `None`) a site for this process without touching the
/// environment; wins over `OMGBASE_FAULT` while set. The pass counts are the
/// caller's to restart ([`reset_faults`]).
pub fn set_armed_fault(fault: Option<ArmedFault>) {
    *OVERRIDE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = fault;
}

/// The fault the environment (or [`set_armed_fault`]) arms: `None` when
/// `OMGBASE_FAULT` is unset or empty and nothing was armed in-process.
pub fn armed_fault() -> Result<Option<ArmedFault>> {
    if let Some(f) = *OVERRIDE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
    {
        return Ok(Some(f));
    }
    match std::env::var(FAULT_ENV) {
        Ok(v) => parse_fault(&v),
        Err(_) => Ok(None),
    }
}

static PASSES: [AtomicUsize; 6] = [
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
    AtomicUsize::new(0),
];

/// The engine's call at a site: counts the pass and raises
/// [`Error::InjectedFault`] when the environment arms this site for this
/// pass. Free when `OMGBASE_FAULT` is unset (one environment read).
pub fn fault_point(site: FaultSite) -> Result<()> {
    let Some(armed) = armed_fault()? else {
        return Ok(());
    };
    if armed.site != site {
        return Ok(());
    }
    let n = PASSES[site.index()].fetch_add(1, Ordering::SeqCst) + 1;
    if n == armed.nth {
        return Err(Error::InjectedFault { site, pass: n });
    }
    Ok(())
}

/// Restart every site's pass count (tests).
pub fn reset_faults() {
    for p in &PASSES {
        p.store(0, Ordering::SeqCst);
    }
}

/// The site's pass count so far (tests).
#[must_use]
pub fn fault_passes(site: FaultSite) -> usize {
    PASSES[site.index()].load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_site_and_count_and_refuses_the_rest() {
        assert_eq!(parse_fault("").unwrap(), None);
        assert_eq!(parse_fault("  ").unwrap(), None);
        assert_eq!(
            parse_fault("feed.append").unwrap(),
            Some(ArmedFault {
                site: FaultSite::FeedAppend,
                nth: 1
            })
        );
        assert_eq!(
            parse_fault("materialize.after-write:3").unwrap(),
            Some(ArmedFault {
                site: FaultSite::MaterializeAfterWrite,
                nth: 3
            })
        );
        let e = parse_fault("recorder").unwrap_err().to_string();
        assert_eq!(
            e,
            "OMGBASE_FAULT=\"recorder\": unknown fault site \"recorder\"; the sites are recorder.capture, feed.append, commit.after-commit, materialize.before-write, materialize.after-write, git.commit"
        );
        let e = parse_fault("feed.append:0").unwrap_err().to_string();
        assert_eq!(
            e,
            "OMGBASE_FAULT=\"feed.append:0\": the count after ':' must be a positive integer"
        );
        assert!(parse_fault("feed.append:x").is_err());
        assert_eq!(FAULT_SITES.len(), 6);
        for s in FAULT_SITES {
            assert_eq!(FaultSite::parse(s.as_str()), Some(s));
        }
    }

    #[test]
    fn the_message_is_pinned() {
        assert_eq!(
            Error::InjectedFault {
                site: FaultSite::FeedAppend,
                pass: 2
            }
            .to_string(),
            "injected fault at feed.append (pass 2)"
        );
        assert_eq!(
            injected_fault_message(FaultSite::RecorderCapture, 1),
            "injected fault at recorder.capture (pass 1)"
        );
    }
}
