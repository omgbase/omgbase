// UTF-16 code-unit index ⇄ UTF-8 byte offset (spec/format §1 inv. 5, spec/graph
// §2.3). JavaScript strings index code units; every language-neutral offset the
// store persists is a byte offset into the UTF-8 encoding of the same text, so
// the reference converts at the store boundary: node spans are converted to
// bytes before `nodes` rows are written, and back to code units before an
// editor slices a block's raw. Both directions are exact for well-formed text;
// a lone surrogate counts as the 3 bytes `Buffer.from(s, "utf8")` emits for
// U+FFFD, so the table always agrees with the bytes actually stored.

/**
 * Byte offset of every code-unit index of `s` (length + 1 entries, so the
 * end-of-string index resolves too). One pass over the string; a surrogate
 * pair contributes 4 bytes at the index after the pair, and the index between
 * its two halves maps to the pair's start (no span ever lands there).
 */
export function byteOffsetTable(s: string): Uint32Array {
  const table = new Uint32Array(s.length + 1);
  let bytes = 0;
  let i = 0;
  while (i < s.length) {
    table[i] = bytes;
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
      i += 1;
    } else if (c < 0x800) {
      bytes += 2;
      i += 1;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        table[i + 1] = bytes;
        bytes += 4;
        i += 2;
      } else {
        bytes += 3; // lone high surrogate → U+FFFD
        i += 1;
      }
    } else {
      bytes += 3; // BMP ≥ U+0800, or a lone surrogate → U+FFFD
      i += 1;
    }
  }
  table[s.length] = bytes;
  return table;
}

/** The UTF-8 byte offset of code-unit index `index` of `s` (clamped to the string). */
export function byteOffsetOf(s: string, index: number): number {
  return byteOffsetTable(s)[Math.max(0, Math.min(index, s.length))]!;
}

/**
 * Convert a `[start, end)` code-unit span of `s` to a byte span. Both ends are
 * clamped to the string; `start <= end` is preserved.
 */
export function codeUnitSpanToBytes(s: string, start: number, end: number): { start: number; end: number } {
  const table = byteOffsetTable(s);
  const clamp = (i: number): number => Math.max(0, Math.min(i, s.length));
  return { start: table[clamp(start)]!, end: table[clamp(Math.max(start, end))]! };
}

/**
 * The code-unit index whose byte offset is `byte` in `s`. A byte offset that
 * falls inside a multi-byte sequence (never produced by this module, but a
 * foreign writer could) rounds down to the start of that character; an offset
 * past the end clamps to `s.length`.
 */
export function codeUnitIndexOf(s: string, byte: number): number {
  const table = byteOffsetTable(s);
  // `table` is non-decreasing; find the greatest index whose offset ≤ byte.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (table[mid]! <= byte) lo = mid;
    else hi = mid - 1;
  }
  // The index between the halves of a surrogate pair shares the pair's start
  // offset; step back to the high surrogate so a slice never splits the pair.
  if (lo > 0 && lo < s.length) {
    const c = s.charCodeAt(lo);
    if (c >= 0xdc00 && c <= 0xdfff && table[lo] === table[lo - 1]) lo -= 1;
  }
  return lo;
}

/** Convert a `[start, end)` byte span of `s` back to a code-unit span (inverse of `codeUnitSpanToBytes`). */
export function byteSpanToCodeUnits(s: string, start: number, end: number): { start: number; end: number } {
  const a = codeUnitIndexOf(s, start);
  const b = codeUnitIndexOf(s, Math.max(start, end));
  return { start: a, end: Math.max(a, b) };
}
