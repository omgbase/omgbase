import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { EmbeddingProvider } from "./index.js";

// The stdio request loop behind `omgbase-embedder` (bin.ts), factored out so the
// drain behavior is unit-testable with a stubbed provider and an in-memory
// stream. Protocol (05 §6): each input line is {"id": <n>, "texts": [...]} and
// is answered with {"id": <n>, "vectors": [[...]...]} or {"id", "error"}.
//
// Requests are serialized through one promise chain (ordering is preserved and
// the lazy first model load is shared). The promise `serve` returns settles
// only when the input has ENDED *and* every request already received has been
// answered — so a caller that pipes one request and closes stdin
// (`echo '{…}' | omgbase-embedder`) still gets its answer, even though the
// model load it triggered outlives the EOF. Previously the bin exited on EOF
// immediately and such a request produced nothing.

export interface ServeOptions {
  /** Where protocol lines go (stdout in the bin). */
  write: (obj: unknown) => void;
}

/** Answer newline-delimited embed requests from `input` until it ends, then
 *  resolve once every received request has been answered. Never rejects: a
 *  malformed line or a failing embed is reported as an `error` reply. */
export function serve(input: Readable, provider: EmbeddingProvider, opts: ServeOptions): Promise<void> {
  const { write } = opts;
  const rl = createInterface({ input });
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain.then(async () => {
      let id: number | undefined;
      try {
        const req = JSON.parse(trimmed) as { id?: number; texts?: string[] };
        id = req.id;
        const vectors = await provider.embed(req.texts ?? []);
        write({ id, vectors });
      } catch (err) {
        write({ id, error: (err as Error).message });
      }
    });
  });
  return new Promise<void>((resolve) => {
    // readline emits every buffered `line` before `close`, so `chain` here is
    // the tail of all requests received; draining it is what makes EOF safe.
    rl.on("close", () => void chain.then(resolve));
  });
}
