import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { serve } from "./serve.js";
import type { EmbeddingProvider } from "./index.js";

// Drain semantics of the stdio loop, with a stubbed provider whose embed() we
// resolve by hand — the real model is never loaded.

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function stub(embed: EmbeddingProvider["embed"]): EmbeddingProvider {
  return { model: "stub", dim: 2, embed };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("serve (omgbase-embedder stdio loop)", () => {
  it("answers a request received before EOF even when the (lazy) model load outlives stdin", async () => {
    const load = deferred<void>(); // stands in for the slow first pipeline() load
    const provider = stub(async (texts) => {
      await load.promise;
      return texts.map(() => [1, 0]);
    });
    const out: unknown[] = [];
    const input = new PassThrough();
    const done = serve(input, provider, { write: (o) => out.push(o) });

    // `echo '{…}' | omgbase-embedder`: one request, then immediate EOF.
    input.end(JSON.stringify({ id: 7, texts: ["hello"] }) + "\n");
    await tick();
    let settled = false;
    void done.then(() => (settled = true));
    await tick();
    expect(out).toEqual([]); // nothing answered yet — model still "loading"
    expect(settled).toBe(false); // …and serve has NOT given up on it

    load.resolve();
    await done;
    expect(out).toEqual([{ id: 7, vectors: [[1, 0]] }]);
  });

  it("drains several queued requests in order, then resolves", async () => {
    const provider = stub(async (texts) => texts.map((t) => [t.length, 0]));
    const out: { id?: number }[] = [];
    const input = new PassThrough();
    const done = serve(input, provider, { write: (o) => out.push(o as { id?: number }) });
    input.write(JSON.stringify({ id: 1, texts: ["a"] }) + "\n");
    input.write("\n"); // blank lines are ignored
    input.write(JSON.stringify({ id: 2, texts: ["bb", "c"] }) + "\n");
    input.end(JSON.stringify({ id: 3, texts: [] }) + "\n");
    await done;
    expect(out.map((o) => o.id)).toEqual([1, 2, 3]);
    expect(out[1]).toEqual({ id: 2, vectors: [[2, 0], [1, 0]] });
  });

  it("reports a malformed line or a failing embed as an error reply and keeps going", async () => {
    const provider = stub(async (texts) => {
      if (texts[0] === "boom") throw new Error("kaput");
      return texts.map(() => [0, 1]);
    });
    const out: unknown[] = [];
    const input = new PassThrough();
    const done = serve(input, provider, { write: (o) => out.push(o) });
    input.write("not json\n");
    input.write(JSON.stringify({ id: 2, texts: ["boom"] }) + "\n");
    input.end(JSON.stringify({ id: 3, texts: ["fine"] }) + "\n");
    await done;
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ id: undefined, error: expect.stringMatching(/JSON/) as string });
    expect(out[1]).toEqual({ id: 2, error: "kaput" });
    expect(out[2]).toEqual({ id: 3, vectors: [[0, 1]] });
  });

  it("resolves immediately on EOF with no requests", async () => {
    const input = new PassThrough();
    const done = serve(input, stub(async () => []), { write: () => {} });
    input.end();
    await done;
  });
});
