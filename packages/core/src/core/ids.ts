import { randomInt } from "node:crypto";

// Minted, opaque, repo-scoped IDs (01 §3.1, 02 §1): prefix + 7 chars lowercase
// Crockford base32 from a CSPRNG, collision-checked at mint by the caller.

export type IdPrefix = "d" | "b" | "c" | "r" | "x" | "col" | "cp" | "e" | "rp" | "v" | "src";

// Crockford base32 alphabet, lowercased (no i, l, o, u).
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_LEN = 7;

export function randomSuffix(len = ID_LEN): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** Mint an ID with the given prefix. Collision checking is the store's job. */
export function mintId(prefix: IdPrefix): string {
  return `${prefix}_${randomSuffix()}`;
}

const ID_RE = new RegExp(`^([a-z]+)_([${ALPHABET}]{${ID_LEN}})$`);

export function isValidId(id: string, prefix?: IdPrefix): boolean {
  const m = ID_RE.exec(id);
  if (!m) return false;
  return prefix === undefined || m[1] === prefix;
}

export function prefixOf(id: string): string | null {
  const m = ID_RE.exec(id);
  return m ? m[1]! : null;
}
