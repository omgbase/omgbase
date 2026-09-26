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

/** A replacement id generator (spec/store §2.2): given a prefix, return the whole id. */
export type IdMinter = (prefix: IdPrefix) => string;

// The installed minter, or null for production (CSPRNG). spec/store §2.2: the
// store's tree hashes contain block ids, so a fixture runner installs a
// deterministic per-prefix counter here to make ids comparable across
// implementations. Every mint in the engine — documents, blocks (including
// the reconcile module's phase 7 mints), commits, revisions, repos, sources —
// goes through `mintId`, so one seam covers them all.
let installed: IdMinter | null = null;

/** Install a replacement minter (null restores the CSPRNG default). */
export function setIdMinter(minter: IdMinter | null): void {
  installed = minter;
}

/** Run `body` with `minter` installed, restoring the previous minter afterwards (also on throw). */
export function withIdMinter<T>(minter: IdMinter, body: () => T): T {
  const previous = installed;
  installed = minter;
  try {
    return body();
  } finally {
    installed = previous;
  }
}

/**
 * The fixture minter (spec/store §2.2): a sequential per-prefix counter —
 * `d_0, d_1, …`, `b_0, …`, each prefix counting from 0 independently. A fresh
 * instance per case resets every counter.
 */
export function sequentialMinter(): IdMinter {
  const counters = new Map<string, number>();
  return (prefix) => {
    const n = counters.get(prefix) ?? 0;
    counters.set(prefix, n + 1);
    return `${prefix}_${n}`;
  };
}

/** Mint an ID with the given prefix. Collision checking is the store's job. */
export function mintId(prefix: IdPrefix): string {
  if (installed) return installed(prefix);
  return `${prefix}_${randomSuffix()}`;
}

// Production ids carry exactly ID_LEN suffix characters; the fixture minter
// (spec/store §2.2) mints `d_0`, `b_12`, … — one to seven alphabet characters.
// The id-or-path dispatch (`findDocByRef`, `insert.doc`, history) must treat
// both as ids: nothing else in the system is spelled `<prefix>_<alnum>` (paths
// carry an extension), so accepting the shorter suffix loses no path.
const ID_RE = new RegExp(`^([a-z]+)_([${ALPHABET}]{1,${ID_LEN}})$`);

export function isValidId(id: string, prefix?: IdPrefix): boolean {
  const m = ID_RE.exec(id);
  if (!m) return false;
  return prefix === undefined || m[1] === prefix;
}

export function prefixOf(id: string): string | null {
  const m = ID_RE.exec(id);
  return m ? m[1]! : null;
}
