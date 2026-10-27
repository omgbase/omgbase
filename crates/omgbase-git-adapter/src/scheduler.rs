//! The debounce timer and the mutation hook (`spec/store` §5.12 "Cadence",
//! 17.6 — modular-core Phase 6b). The MCP host's mutation hook fires after
//! every successful write tool; the host hands it to a scheduler built here:
//! under cadence `every` the checkpoint runs SYNCHRONOUSLY inside the hook
//! (one commit per write — the git history is complete without `omg sync`);
//! under `{ debounce_ms }` the hook (re)arms one timer so the checkpoint runs
//! `debounce_ms` after the LAST mutation, coalescing a burst into one commit.
//! [`CheckpointScheduler::flush`] runs a pending debounced checkpoint now
//! (the host's shutdown); [`CheckpointScheduler::close`] cancels it. Errors
//! go to `on_error` and never reach the hook's caller. Port of
//! `packages/git-adapter/src/scheduler.ts` — the timer is a thread that
//! sleeps and checks it is still the latest arming (the reference's
//! `clearTimeout`/`setTimeout` pair). One shape of this engine's own: the
//! reference's writer lock is re-entrant and the hook fires inside a locked
//! tool call, this engine's is not — so [`CheckpointScheduler::notify`] says
//! whether the caller HOLDS the workspace writer lock, and the run function
//! receives that flag (`true`: run on a connection of its own without taking
//! the lock; `false` — the timer, `flush`, the watcher's hook: take it).

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::config::Cadence;

/// The worker, once, over a connection of its own (the timer thread owns
/// nothing of the host's); the argument says whether the caller already
/// holds the workspace writer lock (`true` inside a locked tool call).
pub type RunFn = dyn Fn(bool) -> Result<(), String> + Send + Sync + 'static;
/// Where a failed run is reported.
pub type ErrorFn = dyn Fn(&str) + Send + Sync + 'static;

#[derive(Default)]
struct State {
    /// Incremented by every arming, flush and close: a timer that wakes to
    /// find another generation stands down.
    generation: u64,
    pending: bool,
}

/// The scheduler the MCP host notifies after every write.
#[derive(Clone)]
pub struct CheckpointScheduler {
    cadence: Cadence,
    run: Arc<RunFn>,
    on_error: Option<Arc<ErrorFn>>,
    state: Arc<Mutex<State>>,
}

impl std::fmt::Debug for CheckpointScheduler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CheckpointScheduler")
            .field("cadence", &self.cadence)
            .field("pending", &self.pending())
            .finish_non_exhaustive()
    }
}

impl CheckpointScheduler {
    /// A scheduler running `run` under `cadence`; `on_error` receives a
    /// failed run's message.
    #[must_use]
    pub fn new(cadence: Cadence, run: Arc<RunFn>, on_error: Option<Arc<ErrorFn>>) -> Self {
        Self {
            cadence,
            run,
            on_error,
            state: Arc::new(Mutex::new(State::default())),
        }
    }

    fn run_now(&self, under_lock: bool) {
        if let Err(e) = (self.run)(under_lock)
            && let Some(report) = &self.on_error
        {
            report(&e);
        }
    }

    /// The mutation hook: `every` runs the worker now (`under_lock`: the
    /// caller holds the writer lock); a debounce (re)arms the timer.
    pub fn notify(&self, under_lock: bool) {
        let Cadence::Debounce { debounce_ms } = self.cadence else {
            self.run_now(under_lock);
            return;
        };
        let generation = {
            let mut s = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            s.generation += 1;
            s.pending = true;
            s.generation
        };
        let me = self.clone();
        let _ = thread::Builder::new()
            .name("omgbase-git-debounce".to_owned())
            .spawn(move || {
                thread::sleep(Duration::from_millis(debounce_ms));
                let fire = {
                    let mut s = me
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if s.pending && s.generation == generation {
                        s.pending = false;
                        true
                    } else {
                        false
                    }
                };
                if fire {
                    me.run_now(false);
                }
            });
    }

    /// Run a pending debounced checkpoint now.
    pub fn flush(&self) {
        let fire = {
            let mut s = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if s.pending {
                s.pending = false;
                s.generation += 1;
                true
            } else {
                false
            }
        };
        if fire {
            self.run_now(false);
        }
    }

    /// Cancel a pending timer.
    pub fn close(&self) {
        let mut s = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        s.pending = false;
        s.generation += 1;
    }

    /// Is a debounced run pending?
    #[must_use]
    pub fn pending(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counting() -> (Arc<AtomicUsize>, Arc<RunFn>) {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = Arc::clone(&n);
        (
            n,
            Arc::new(move |_under_lock: bool| {
                n2.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )
    }

    #[test]
    fn every_runs_synchronously_in_the_hook() {
        let (n, run) = counting();
        let s = CheckpointScheduler::new(Cadence::Every, run, None);
        s.notify(true);
        s.notify(false);
        assert_eq!(n.load(Ordering::SeqCst), 2);
        assert!(!s.pending());
        s.flush();
        assert_eq!(n.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_debounce_coalesces_a_burst_flushes_on_demand_and_cancels_on_close() {
        let (n, run) = counting();
        let s = CheckpointScheduler::new(Cadence::Debounce { debounce_ms: 60 }, run, None);
        s.notify(true);
        thread::sleep(Duration::from_millis(20));
        s.notify(true);
        thread::sleep(Duration::from_millis(20));
        s.notify(true);
        assert!(s.pending());
        assert_eq!(
            n.load(Ordering::SeqCst),
            0,
            "nothing before the last timer fires"
        );
        thread::sleep(Duration::from_millis(150));
        assert_eq!(n.load(Ordering::SeqCst), 1, "a burst folds into one run");
        assert!(!s.pending());
        // flush runs a pending one now …
        s.notify(true);
        s.flush();
        assert_eq!(n.load(Ordering::SeqCst), 2);
        thread::sleep(Duration::from_millis(100));
        assert_eq!(n.load(Ordering::SeqCst), 2, "the stale timer stands down");
        // … and close cancels it.
        s.notify(true);
        s.close();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(n.load(Ordering::SeqCst), 2);
        assert!(!s.pending());
    }

    #[test]
    fn errors_reach_on_error_never_the_caller() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen2 = Arc::clone(&seen);
        let s = CheckpointScheduler::new(
            Cadence::Every,
            Arc::new(|_: bool| Err("boom".to_owned())),
            Some(Arc::new(move |e: &str| {
                seen2.lock().unwrap().push(e.to_owned())
            })),
        );
        s.notify(true);
        assert_eq!(*seen.lock().unwrap(), vec!["boom".to_owned()]);
    }
}
