// The process clock seam (spec/surface §7.1). Every commit the engine stamps
// reads "now" through `new Date()` / `Date.now()` (`ingest`, `apply`, the doc
// ops, `observe*`, checkpoints — none caches a `Date`), so pinning the global
// `Date` pins every timestamp a tool call produces. Two users: the surface
// fixtures (`corpus/surface/fixture.ts`, per `read` step) and `omg mcp` under
// `OMGBASE_SPEC_CLOCK` (for the whole process). Never used in production paths.

/**
 * Pin the wall clock to `ts` (RFC 3339): `new Date()` and `Date.now()` return
 * that instant until the returned restore function runs. Explicit-argument
 * constructions (`new Date(ms)`, `new Date(iso)`) and the static parsers are
 * untouched. Throws `RangeError` when `ts` does not parse.
 */
export function pinClock(ts: string): () => void {
  const RealDate = Date;
  const fixed = RealDate.parse(ts);
  if (Number.isNaN(fixed)) throw new RangeError(`pinClock: not an RFC 3339 instant: ${JSON.stringify(ts)}`);
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [number]));
    }
    static override now(): number {
      return fixed;
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

/** Run `body` under `pinClock(ts)` (a no-op when `ts` is undefined), restoring the clock afterwards. */
export async function withClock<T>(ts: string | undefined, body: () => Promise<T>): Promise<T> {
  if (ts === undefined) return body();
  const restore = pinClock(ts);
  try {
    return await body();
  } finally {
    restore();
  }
}
