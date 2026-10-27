// Fault injection outside the fixture runners (modular-core Phase 5a; the
// plan's §8 acceptance matrix — "recovery", "optional history", "retention"
// rows exercised with a fault at a named site, not a mocked recorder).
//
//   OMGBASE_FAULT=<site>[:<nth>]
//
// A TEST-ONLY hook, read from the environment on every pass through a site
// (so a test can set and clear it between writes). The engine passes a site
// when it is about to do the thing the site names; the `nth` pass (default 1)
// throws `InjectedFault` — a plain error carrying the site, caught by nothing
// the engine owns except where a site sits inside a `capture()` (there it
// becomes `CaptureFailed`, as any recorder throw does). Every other pass is a
// no-op. The sites are spelled identically by both engines (spec/store §9.7;
// `docs/modular-core/fault-injection.md`):
//
//   recorder.capture            inside the recorder's capture wrapper, before the recorder runs → the member is rolled back, `capture_failed` raised
//   feed.append                 inside the commit transaction, before the feed row is inserted → the whole transaction rolls back, nothing minted
//   commit.after-commit         after the api path's transaction committed, before any file is written → the rows are durable, the pending rows owe the files; `recoverRepo` replays them
//   materialize.before-write    inside the materializer, before a file is written → the pending row stays; the next replay writes it
//   materialize.after-write     inside the materializer, after the file was written, before its row is deleted → the next replay finds the bytes and clears the row
//   git.commit                  (Phase 6a, spec/store §5.12) inside the git history provider's checkpoint worker, after the blobs, the tree and the commit object are written and before `update-ref` moves the branch → the branch tip is unchanged, the objects dangle; the next run resumes from the tip's `omgbase-seq` trailer and writes the SAME commit (deterministic bytes), closing the gap
//
// Counting is per site and per process: `OMGBASE_FAULT=feed.append:2` throws on
// the second feed row this process appends. `resetFaults()` restarts the counts
// (tests).

export const FAULT_ENV = "OMGBASE_FAULT";

export const FAULT_SITES = ["recorder.capture", "feed.append", "commit.after-commit", "materialize.before-write", "materialize.after-write", "git.commit"] as const;
export type FaultSite = (typeof FAULT_SITES)[number];

/** The error an armed site throws on its nth pass. `message` is pinned: `injected fault at <site> (pass <n>)`. */
export class InjectedFault extends Error {
  constructor(readonly site: FaultSite, readonly pass: number) {
    super(`injected fault at ${site} (pass ${pass})`);
    this.name = "InjectedFault";
  }
}

const passes = new Map<FaultSite, number>();

/** Parse `OMGBASE_FAULT`: `{ site, nth }` or null when unset/empty; an unknown site or a bad count is a configuration error. */
export function armedFault(env: NodeJS.ProcessEnv = process.env): { site: FaultSite; nth: number } | null {
  const raw = (env[FAULT_ENV] ?? "").trim();
  if (raw === "") return null;
  const [site, nthText] = raw.split(":", 2);
  if (!(FAULT_SITES as readonly string[]).includes(site!)) {
    throw new Error(`${FAULT_ENV}=${JSON.stringify(raw)}: unknown fault site ${JSON.stringify(site)}; the sites are ${FAULT_SITES.join(", ")}`);
  }
  const nth = nthText === undefined ? 1 : Number(nthText);
  if (!Number.isInteger(nth) || nth < 1) throw new Error(`${FAULT_ENV}=${JSON.stringify(raw)}: the count after ':' must be a positive integer`);
  return { site: site as FaultSite, nth };
}

/**
 * The engine's call at a site: counts the pass and throws `InjectedFault` when
 * the environment arms this site for this pass. Free when `OMGBASE_FAULT` is
 * unset (one environment read).
 */
export function faultPoint(site: FaultSite): void {
  const armed = armedFault();
  if (!armed || armed.site !== site) return;
  const n = (passes.get(site) ?? 0) + 1;
  passes.set(site, n);
  if (n === armed.nth) throw new InjectedFault(site, n);
}

/** Restart every site's pass count (tests). */
export function resetFaults(): void {
  passes.clear();
}

/** The site's pass count so far (tests). */
export function faultPasses(site: FaultSite): number {
  return passes.get(site) ?? 0;
}
