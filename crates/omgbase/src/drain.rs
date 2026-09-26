//! The background embed drainer (`spec/search` §2.6; the reference's
//! `EmbedDrainer`). Mutations only ever *queue* embeddable blocks; a
//! long-lived host closes the gap by scheduling a drain after every write
//! and every watcher checkpoint. `schedule()` is a channel send — cheap,
//! never blocking the tool's response path. One thread owns the work: it
//! debounces a burst of schedules into one drain (500 ms), is single-flight
//! by construction, re-runs once more when a schedule arrived mid-drain (so
//! the last edit is never left unembedded), and swallows drain errors onto
//! stderr (a provider hiccup must not take the host down; the next schedule
//! retries). `flush` runs a final drain synchronously (shutdown).
//!
//! The thread builds its own store connection (a `Store` is not `Send`) but
//! shares the process's **one** embedding provider with the query path, as
//! the reference shares one `embedding.worker` between `semantic()` and its
//! `EmbedDrainer`: a [`SharedProvider`] is a cloneable handle over the
//! provider, locked only around each `embed` batch — a `semantic()` query
//! that lands mid-drain waits for one batch at most, never for the drain.

use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use omgbase_search::EmbeddingProvider;

/// One embedding provider process, shared by every thread that embeds: the
/// surface (`semantic()`, `resolve`) and the drain thread each hold a clone.
/// The identity (`model`/`dim`/`max_input_tokens`) is read once at
/// construction so it is served without the lock; `embed` takes the lock
/// for the duration of one batch and releases it — the granularity a
/// waiting query pays for. The provider (and its child process) drops with
/// the last clone.
#[derive(Clone)]
pub struct SharedProvider {
    model: String,
    dim: usize,
    max_input_tokens: Option<u32>,
    inner: Arc<Mutex<Box<dyn EmbeddingProvider + Send>>>,
}

impl SharedProvider {
    /// Wrap a provider (built once) for sharing.
    pub fn new(provider: Box<dyn EmbeddingProvider + Send>) -> Self {
        Self {
            model: provider.model().to_owned(),
            dim: provider.dim(),
            max_input_tokens: provider.max_input_tokens(),
            inner: Arc::new(Mutex::new(provider)),
        }
    }

    /// How many handles share the provider (tests, diagnostics).
    #[must_use]
    pub fn handles(&self) -> usize {
        Arc::strong_count(&self.inner)
    }
}

impl std::fmt::Debug for SharedProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedProvider")
            .field("model", &self.model)
            .field("dim", &self.dim)
            .field("handles", &self.handles())
            .finish_non_exhaustive()
    }
}

impl EmbeddingProvider for SharedProvider {
    fn model(&self) -> &str {
        &self.model
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn max_input_tokens(&self) -> Option<u32> {
        self.max_input_tokens
    }

    /// One batch under the lock. A poisoned lock (a provider panicked
    /// mid-batch on another thread) is taken anyway: the provider's own
    /// state decides whether the next request works.
    fn embed(&self, texts: &[String]) -> omgbase_search::Result<Vec<Vec<f32>>> {
        let guard = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        guard.embed(texts)
    }
}

/// The debounce the reference uses.
pub const DEBOUNCE: Duration = Duration::from_millis(500);

/// What one drain did (the reference's `onDrain` payload).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DrainReport {
    /// Block vectors plus whole-document vectors computed.
    pub embedded: usize,
    /// Document vectors pooled from cached block vectors (no provider call).
    pub pooled: usize,
}

impl DrainReport {
    /// Whether the drain produced anything worth logging.
    #[must_use]
    pub fn did_work(&self) -> bool {
        self.embedded > 0 || self.pooled > 0
    }
}

/// The messages a drainer thread receives.
pub enum Msg {
    /// Mark dirty and (re)arm the debounce.
    Schedule,
    /// Drain now (dirty or not — the reference's `flush` always marks
    /// dirty), then acknowledge.
    Flush(Sender<()>),
    /// Stop after the current drain, if any.
    Close,
}

/// A cheap, cloneable scheduling handle.
#[derive(Clone)]
pub struct DrainHandle(Sender<Msg>);

impl DrainHandle {
    /// Mark the repo dirty; the thread drains after the debounce. Never
    /// blocks, never fails (a closed drainer ignores it).
    pub fn schedule(&self) {
        let _ = self.0.send(Msg::Schedule);
    }
}

/// One drain: `Ok(report)`, or the error to log.
pub type DrainFn = Box<dyn FnMut() -> Result<DrainReport, String>>;

/// The thread and its channel.
pub struct Drainer {
    tx: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
}

impl Drainer {
    /// Start the thread. `init` runs *on the thread* and builds the drain
    /// closure (opening the store connection there; the provider handle it
    /// captures is the host's shared one); when it fails the thread logs
    /// once and idles, acknowledging flushes, so a broken store is never
    /// fatal.
    pub fn spawn<I>(debounce: Duration, init: I) -> Self
    where
        I: FnOnce() -> Result<DrainFn, String> + Send + 'static,
    {
        let (tx, rx) = channel();
        let thread = std::thread::Builder::new()
            .name("omgbase-embed-drain".to_owned())
            .spawn(move || {
                let mut log = |line: String| eprintln!("{line}");
                match init() {
                    Ok(mut drain) => run_loop(&rx, debounce, &mut *drain, &mut log),
                    Err(e) => {
                        log(format!("[mcp] embed drain disabled: {e}"));
                        idle(&rx);
                    }
                }
            })
            .expect("spawn the embed drain thread");
        Self {
            tx,
            thread: Some(thread),
        }
    }

    #[must_use]
    pub fn handle(&self) -> DrainHandle {
        DrainHandle(self.tx.clone())
    }

    /// Drain now and wait for it (and for any re-run a mid-drain schedule
    /// triggered) to finish.
    pub fn flush(&self) {
        let (ack_tx, ack_rx) = channel();
        if self.tx.send(Msg::Flush(ack_tx)).is_ok() {
            let _ = ack_rx.recv();
        }
    }

    /// Stop the thread (no drains start after this) and join it.
    pub fn close(mut self) {
        let _ = self.tx.send(Msg::Close);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Drainer {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Close);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// A disabled drainer's thread: acknowledge flushes until closed.
fn idle(rx: &Receiver<Msg>) {
    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Schedule => {}
            Msg::Flush(ack) => {
                let _ = ack.send(());
            }
            Msg::Close => return,
        }
    }
}

/// The debounce / single-flight loop, separated from the thread for tests:
/// runs until `Close` or the channel closes.
pub fn run_loop(
    rx: &Receiver<Msg>,
    debounce: Duration,
    drain: &mut dyn FnMut() -> Result<DrainReport, String>,
    log: &mut dyn FnMut(String),
) {
    let mut dirty = false;
    let mut deadline: Option<Instant> = None;
    loop {
        let msg = match deadline {
            Some(dl) => match rx.recv_timeout(dl.saturating_duration_since(Instant::now())) {
                Ok(m) => Some(m),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            },
        };
        match msg {
            Some(Msg::Schedule) => {
                dirty = true;
                deadline = Some(Instant::now() + debounce);
            }
            Some(Msg::Flush(ack)) => {
                deadline = None;
                dirty = true;
                let closed = run_until_clean(rx, &mut dirty, drain, log, vec![ack]);
                if closed {
                    return;
                }
            }
            Some(Msg::Close) => return,
            None => {
                // The debounce elapsed.
                deadline = None;
                if run_until_clean(rx, &mut dirty, drain, log, Vec::new()) {
                    return;
                }
            }
        }
    }
}

/// Drain while dirty: each pass clears the flag, drains, then absorbs the
/// messages that arrived meanwhile (a `Schedule` re-dirties; a `Flush` is
/// acknowledged once the loop settles; a `Close` ends the thread after
/// this pass). On a drain error the pass stops — the dirt that arrived
/// during it stays queued for the next debounce (the reference swallows
/// and waits for the next `schedule()`). Returns whether `Close` arrived.
fn run_until_clean(
    rx: &Receiver<Msg>,
    dirty: &mut bool,
    drain: &mut dyn FnMut() -> Result<DrainReport, String>,
    log: &mut dyn FnMut(String),
    mut acks: Vec<Sender<()>>,
) -> bool {
    let mut closed = false;
    while *dirty && !closed {
        *dirty = false;
        match drain() {
            Ok(report) => {
                if report.did_work() {
                    log(format!("[mcp] embedded {} block(s)", report.embedded));
                }
            }
            Err(e) => {
                log(format!("[mcp] embed drain failed: {e}"));
                break;
            }
        }
        loop {
            match rx.try_recv() {
                Ok(Msg::Schedule) => *dirty = true,
                Ok(Msg::Flush(ack)) => {
                    *dirty = true;
                    acks.push(ack);
                }
                Ok(Msg::Close) => closed = true,
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            }
        }
    }
    for ack in acks {
        let _ = ack.send(());
    }
    closed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const FAST: Duration = Duration::from_millis(40);

    /// A fake provider that counts how often it is "spawned" and how many
    /// `embed` calls overlap (the shared handle must keep that at one).
    #[derive(Default)]
    struct Counting {
        spawned: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
        in_flight: Arc<AtomicUsize>,
        max_in_flight: Arc<AtomicUsize>,
    }

    impl Counting {
        fn spawn(&self) -> Box<dyn EmbeddingProvider + Send> {
            self.spawned.fetch_add(1, Ordering::SeqCst);
            Box::new(Counting {
                spawned: Arc::clone(&self.spawned),
                calls: Arc::clone(&self.calls),
                in_flight: Arc::clone(&self.in_flight),
                max_in_flight: Arc::clone(&self.max_in_flight),
            })
        }
    }

    impl EmbeddingProvider for Counting {
        fn model(&self) -> &str {
            "counting-2"
        }

        fn dim(&self) -> usize {
            2
        }

        fn max_input_tokens(&self) -> Option<u32> {
            Some(16)
        }

        fn embed(&self, texts: &[String]) -> omgbase_search::Result<Vec<Vec<f32>>> {
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(now, Ordering::SeqCst);
            // Long enough for the other thread's call to arrive meanwhile.
            std::thread::sleep(Duration::from_millis(2));
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        }
    }

    #[test]
    fn two_handles_share_one_provider_and_serialize_its_calls() {
        let counting = Counting::default();
        let shared = SharedProvider::new(counting.spawn());
        assert_eq!(
            (shared.model(), shared.dim(), shared.max_input_tokens()),
            ("counting-2", 2, Some(16)),
            "the identity is the provider's, served without the lock"
        );
        // The surface's handle and the drain thread's handle.
        let query_path = shared.clone();
        let drain_path = shared.clone();
        assert_eq!(shared.handles(), 3);
        let drain = std::thread::spawn(move || {
            for _ in 0..20 {
                let batch = vec!["a".to_owned(), "b".to_owned()];
                assert_eq!(drain_path.embed(&batch).unwrap().len(), 2);
            }
        });
        for _ in 0..20 {
            assert_eq!(query_path.embed_query("q").unwrap(), vec![1.0, 0.0]);
        }
        drain.join().unwrap();
        assert_eq!(counting.spawned.load(Ordering::SeqCst), 1, "one provider");
        assert_eq!(counting.calls.load(Ordering::SeqCst), 40);
        assert_eq!(
            counting.max_in_flight.load(Ordering::SeqCst),
            1,
            "calls from the two handles never overlap"
        );
        drop(query_path);
        assert_eq!(
            shared.handles(),
            1,
            "the drain thread's clone went with its thread, the query path's with the surface"
        );
    }

    struct Harness {
        tx: Sender<Msg>,
        calls: Arc<AtomicUsize>,
        log: Arc<Mutex<Vec<String>>>,
        thread: Option<JoinHandle<()>>,
    }

    impl Harness {
        /// A loop over a fake drain: `on_call(n)` decides the nth call's
        /// outcome and may schedule mid-drain through the cloned sender.
        fn start<F>(on_call: F) -> Self
        where
            F: Fn(usize, &Sender<Msg>) -> Result<DrainReport, String> + Send + 'static,
        {
            let (tx, rx) = channel();
            let calls = Arc::new(AtomicUsize::new(0));
            let log = Arc::new(Mutex::new(Vec::new()));
            let (c, l, t) = (Arc::clone(&calls), Arc::clone(&log), tx.clone());
            let thread = std::thread::spawn(move || {
                let mut drain = move || {
                    let n = c.fetch_add(1, Ordering::SeqCst);
                    // Simulate provider latency so a mid-drain schedule can land.
                    std::thread::sleep(Duration::from_millis(15));
                    on_call(n, &t)
                };
                let mut log = move |line: String| l.lock().unwrap().push(line);
                run_loop(&rx, FAST, &mut drain, &mut log);
            });
            Self {
                tx,
                calls,
                log,
                thread: Some(thread),
            }
        }

        fn schedule(&self) {
            self.tx.send(Msg::Schedule).unwrap();
        }

        fn flush(&self) {
            let (ack, rx) = channel();
            self.tx.send(Msg::Flush(ack)).unwrap();
            rx.recv().unwrap();
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn close(mut self) -> Vec<String> {
            self.tx.send(Msg::Close).unwrap();
            self.thread.take().unwrap().join().unwrap();
            self.log.lock().unwrap().clone()
        }
    }

    fn ok(embedded: usize) -> Result<DrainReport, String> {
        Ok(DrainReport {
            embedded,
            pooled: 0,
        })
    }

    #[test]
    fn a_burst_of_schedules_is_one_debounced_drain() {
        let h = Harness::start(|_, _| ok(3));
        for _ in 0..5 {
            h.schedule();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(h.calls(), 0, "nothing runs before the debounce elapses");
        std::thread::sleep(FAST * 3);
        assert_eq!(h.calls(), 1);
        let log = h.close();
        assert_eq!(log, ["[mcp] embedded 3 block(s)"]);
    }

    #[test]
    fn a_schedule_during_a_drain_reruns_once_without_debounce() {
        let h = Harness::start(|n, tx| {
            if n == 0 {
                // A mutation lands while the first drain is in flight.
                tx.send(Msg::Schedule).unwrap();
            }
            ok(if n == 0 { 1 } else { 0 })
        });
        h.schedule();
        std::thread::sleep(FAST + Duration::from_millis(60));
        assert_eq!(h.calls(), 2, "one re-run, then clean");
        std::thread::sleep(FAST * 2);
        assert_eq!(h.calls(), 2, "no third pass without a new schedule");
        let log = h.close();
        assert_eq!(
            log,
            ["[mcp] embedded 1 block(s)"],
            "a clean pass logs nothing"
        );
    }

    #[test]
    fn flush_drains_now_and_waits() {
        let h = Harness::start(|_, _| ok(0));
        h.flush();
        assert_eq!(h.calls(), 1, "flush always drains, dirty or not");
        h.schedule();
        h.flush();
        assert_eq!(
            h.calls(),
            2,
            "the pending debounce collapses into the flush"
        );
        std::thread::sleep(FAST * 2);
        assert_eq!(h.calls(), 2);
        assert!(h.close().is_empty());
    }

    #[test]
    fn a_failing_drain_is_logged_and_retried_on_the_next_schedule() {
        let h = Harness::start(|n, _| {
            if n == 0 {
                Err("provider down".into())
            } else {
                ok(2)
            }
        });
        h.schedule();
        std::thread::sleep(FAST * 3);
        assert_eq!(h.calls(), 1);
        h.schedule();
        std::thread::sleep(FAST * 3);
        assert_eq!(h.calls(), 2);
        let log = h.close();
        assert_eq!(
            log,
            [
                "[mcp] embed drain failed: provider down",
                "[mcp] embedded 2 block(s)"
            ]
        );
    }

    #[test]
    fn close_stops_before_a_pending_debounce_fires() {
        let h = Harness::start(|_, _| ok(1));
        h.schedule();
        let log = h.close();
        assert!(log.is_empty());
    }

    #[test]
    fn drainer_spawn_runs_init_on_the_thread_and_disables_on_failure() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&calls);
        let d = Drainer::spawn(FAST, move || {
            let c = Arc::clone(&c);
            Ok(Box::new(move || {
                c.fetch_add(1, Ordering::SeqCst);
                ok(0)
            }) as DrainFn)
        });
        let handle = d.handle();
        handle.schedule();
        d.flush();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        d.close();
        handle.schedule(); // ignored: the thread is gone

        let broken = Drainer::spawn(FAST, || Err("no embedder".to_owned()));
        broken.handle().schedule();
        broken.flush(); // acknowledged even though nothing drains
        broken.close();
    }
}
