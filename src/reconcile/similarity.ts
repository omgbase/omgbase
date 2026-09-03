// Text similarity (03 §5): token 3-gram shingle Dice coefficient over
// normalized text. Deterministic; no clock/RNG.

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

/** Token 3-gram shingles (padded so short texts still produce shingles). */
export function shingles(text: string, n = 3): Set<string> {
  const tokens = tokenize(text);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < n) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + n <= tokens.length; i++) {
    out.add(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

/** Dice coefficient over two shingle sets: 2|A∩B| / (|A|+|B|). */
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return (2 * inter) / (a.size + b.size);
}

export function textSim(a: string, b: string): number {
  if (a === b) return 1;
  return dice(shingles(a), shingles(b));
}

export function tokenCount(text: string): number {
  return tokenize(text).length;
}
