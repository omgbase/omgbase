import { describe, it, expect } from "vitest";
import { createProvider } from "./index.js";

// Fast, offline shape checks. The actual model download + inference is exercised
// only when OMGBASE_EMBEDDER_E2E=1 (kept out of CI so no ~90MB weights fetch).

describe("createProvider", () => {
  it("returns an EmbeddingProvider with model + dim, without loading weights", () => {
    const p = createProvider();
    expect(p.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(p.dim).toBe(384);
    expect(typeof p.embed).toBe("function");
  });

  it("honors custom model + dim", () => {
    const p = createProvider({ model: "Xenova/bge-small-en-v1.5", dim: 384 });
    expect(p.model).toBe("Xenova/bge-small-en-v1.5");
    expect(p.dim).toBe(384);
  });

  it("embed([]) is an empty result and never loads the model", async () => {
    const p = createProvider();
    expect(await p.embed([])).toEqual([]);
  });
});

const e2e = process.env.OMGBASE_EMBEDDER_E2E === "1" ? describe : describe.skip;

e2e("transformers.js E2E (downloads weights on first run)", () => {
  it("embeds text into normalized 384-d vectors; similar texts score higher", async () => {
    const p = createProvider();
    const [a, b, c] = await p.embed([
      "the cat sat on the mat",
      "a feline rested on the rug",
      "quarterly financial projections for the fiscal year",
    ]);
    expect(a).toHaveLength(384);
    // L2-normalized ⇒ unit length.
    const norm = Math.sqrt(a!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 1);

    const cos = (x: number[], y: number[]): number => x.reduce((s, xi, i) => s + xi * y[i]!, 0);
    // The two cat/feline sentences should be more similar to each other than to
    // the finance sentence.
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!));
  });
});
