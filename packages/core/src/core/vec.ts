// Float32 BLOB encoding (spec/search §3): embedding vectors are stored and
// bound as little-endian Float32 BLOBs. These two helpers are the ENCODING only
// — the core needs them to carry a query vector through `SemanticVec` — the
// similarity math is the semantic bundle's (`semantic/vec.ts`).

/** Reinterpret a stored/bound BLOB as a Float32 vector (a zero-copy view). */
export function blobToFloat32(buf: Uint8Array): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/** A Buffer view over a Float32 vector's bytes, for binding as a SQL BLOB. */
export function float32ToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
