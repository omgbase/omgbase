import { blobToFloat32 } from "../core/vec.js";

// Vector math of the semantic bundle (spec/search §3): cosine over Float32
// vectors and over their BLOB encodings — the brute-force search
// (`vector.ts`), the `semantic()` scorer (`SemanticProviderImpl`) and the
// `cosine` SQLite UDF the provider registers all share it. The encoding
// helpers themselves are the core's (`core/vec.ts`).

export { blobToFloat32, float32ToBlob } from "../core/vec.js";

/** Cosine similarity of two equal-length embedding vectors. 0 when either is a
 * zero vector (undefined direction) — the neutral, non-matching score. */
export function cosineFloat32(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Cosine over two BLOBs (the `cosine` UDF body). NULL-safe: a missing operand
 * (no embedding row) yields NULL so the score is absent, not a spurious 0. */
export function cosineBytes(a: Uint8Array | null, b: Uint8Array | null): number | null {
  if (!a || !b) return null;
  return cosineFloat32(blobToFloat32(a), blobToFloat32(b));
}
