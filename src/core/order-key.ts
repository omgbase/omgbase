// Fractional order keys (02 §5.3). Base-62; key_between(a,b) returns a key
// strictly between its arguments. Keys sort lexicographically among siblings
// and are never exposed via the API (ordinals are).
//
// v1 scope: ingest appends sequentially, so keyBetween(last, null) is the hot
// path. A midpoint algorithm covers arbitrary insertion for the mutation stage.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length; // 62

function digitVal(c: string): number {
  const v = DIGITS.indexOf(c);
  if (v < 0) throw new Error(`invalid order-key digit: ${c}`);
  return v;
}

/**
 * Return a key strictly between a and b (exclusive). null bounds mean
 * open-ended (a=null → before b; b=null → after a). Amortized O(1) growth for
 * sequential appends.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`keyBetween: a must be < b (got ${a}, ${b})`);
  }

  if (a === null && b === null) return DIGITS[Math.floor(BASE / 2)]!; // midpoint digit

  if (b === null) {
    // append after a: increment the last digit, or extend.
    const last = a!.charCodeAt(a!.length - 1);
    const lastDigit = digitVal(a![a!.length - 1]!);
    if (lastDigit + 1 < BASE) {
      return a!.slice(0, -1) + DIGITS[lastDigit + 1];
    }
    void last;
    return a! + DIGITS[Math.floor(BASE / 2)]; // extend deeper
  }

  if (a === null) {
    // before b: midpoint between "" and b.
    const firstDigit = digitVal(b[0]!);
    if (firstDigit > 0) return DIGITS[Math.floor(firstDigit / 2)]!;
    return "0" + keyBetween(null, b.slice(1) || null);
  }

  // both present: find midpoint digit-by-digit.
  let i = 0;
  let prefix = "";
  for (;;) {
    const da = i < a.length ? digitVal(a[i]!) : 0;
    const db = i < b.length ? digitVal(b[i]!) : BASE;
    if (da === db) {
      prefix += DIGITS[da];
      i++;
      continue;
    }
    if (db - da > 1) {
      return prefix + DIGITS[da + Math.floor((db - da) / 2)];
    }
    // adjacent digits: take a's digit and recurse deeper on the fractional part.
    prefix += DIGITS[da];
    return prefix + keyBetween(a.slice(i + 1) || null, null);
  }
}

/** Generate n sequential append keys starting from scratch. */
export function sequentialKeys(n: number): string[] {
  const keys: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    prev = keyBetween(prev, null);
    keys.push(prev);
  }
  return keys;
}
