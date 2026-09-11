// Vector math shared by the brute-force semantic search (search/vector.ts) and
// the `cosine` SQLite UDF (store.ts) that OQX's `semantic()` scalar compiles to.
// Embedding vectors are stored/bound as little-endian Float32 BLOBs.

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

/** Reinterpret a stored/bound BLOB as a Float32 vector (a zero-copy view). */
export function blobToFloat32(buf: Uint8Array): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/** A Buffer view over a Float32 vector's bytes, for binding as a SQL BLOB. */
export function float32ToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Cosine over two BLOBs (the `cosine` UDF body). NULL-safe: a missing operand
 * (no embedding row) yields NULL so the score is absent, not a spurious 0. */
export function cosineBytes(a: Uint8Array | null, b: Uint8Array | null): number | null {
  if (!a || !b) return null;
  return cosineFloat32(blobToFloat32(a), blobToFloat32(b));
}
