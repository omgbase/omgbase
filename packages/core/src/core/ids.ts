import { randomInt } from "node:crypto";

// Minted, opaque, repo-scoped IDs (spec/store §2.1): prefix + 7 chars lowercase
// Crockford base32 from a CSPRNG. Since store 13.5 a mint is collision-checked
// here, at the seam: `mintId` never returns an id that is in use — one this
// process has already issued, or one a registered oracle (the open stores)
// reports as naming a row of the prefix's table.

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

/**
 * An in-use oracle (spec/store §2.1): does `id` name a row of the prefix's
 * table(s)? A `Store` registers one when it opens and unregisters it on close.
 * `col`/`v` have no table; an oracle answers false for them.
 */
export type IdOracle = (prefix: IdPrefix, id: string) => boolean;

/**
 * Consecutive rejections after which a mint gives up. The CSPRNG cannot hit
 * this (32⁷ candidates against at most millions in use); only a minter that
 * can never produce a fresh id — a broken fixture minter — does, and it must
 * fail loudly rather than spin forever.
 */
export const MINT_GIVE_UP_AFTER = 1_000;

// The installed minter, or null for production (CSPRNG). spec/store §2.2: the
// store's tree hashes contain block ids, so a fixture runner installs a
// deterministic per-prefix counter here to make ids comparable across
// implementations. Every mint in the engine — documents, blocks (including
// the reconcile module's phase 7 mints), commits, revisions, repos, sources —
// goes through `mintId`, so one seam covers them all.
let installed: IdMinter | null = null;

// Ids issued by the production minter in this process: a candidate already
// here is redrawn without asking any oracle. Bounded by the number of ids the
// process mints (a 360k-block ingest is a few tens of MB at most).
const productionIssued = new Set<string>();

// Ids issued while a replacement minter is installed. A *fresh* set per
// install: a fixture case runs on a fresh database, so what the previous case
// minted must not reject this one's `d_0` — sequential ids stay byte-identical
// across cases. The repeating minter's second offering of an id is caught
// here (the row may not be written yet, so the oracle alone would miss it).
let installedIssued = new Set<string>();

const oracles = new Set<IdOracle>();

/** Install a replacement minter (null restores the CSPRNG default). Starts a fresh issued set. */
export function setIdMinter(minter: IdMinter | null): void {
  installed = minter;
  installedIssued = new Set();
}

/** Run `body` with `minter` installed, restoring the previous minter (and its issued set) afterwards (also on throw). */
export function withIdMinter<T>(minter: IdMinter, body: () => T): T {
  const previous = installed;
  const previousIssued = installedIssued;
  installed = minter;
  installedIssued = new Set();
  try {
    return body();
  } finally {
    installed = previous;
    installedIssued = previousIssued;
  }
}

/**
 * Register an in-use oracle (spec/store §2.1); returns the unregister handle.
 * Every open `Store` holds one, so a mint is checked against every database
 * this process has open — a false "in use" from another store costs one redraw.
 */
export function registerIdOracle(oracle: IdOracle): () => void {
  oracles.add(oracle);
  return () => {
    oracles.delete(oracle);
  };
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

/**
 * The repeating fixture minter (spec/store §9.4, `"minter": "repeat"`): the
 * sequential counter whose every id is offered twice — `rp_0, rp_0, b_0, b_0,
 * b_1, b_1, …`. The store rejects the second offering as in use and asks
 * again, so a case run under it projects exactly as under `sequentialMinter`.
 */
export function repeatingMinter(): IdMinter {
  const next = sequentialMinter();
  const pending = new Map<string, string>();
  return (prefix) => {
    const again = pending.get(prefix);
    if (again !== undefined) {
      pending.delete(prefix);
      return again;
    }
    const id = next(prefix);
    pending.set(prefix, id);
    return id;
  };
}

function inUse(prefix: IdPrefix, id: string, issued: Set<string>): boolean {
  if (issued.has(id)) return true;
  for (const oracle of oracles) if (oracle(prefix, id)) return true;
  return false;
}

/**
 * Mint an id with the given prefix (spec/store §2.1 "Uniqueness at mint"):
 * draw a candidate — from the installed minter, else the CSPRNG — and redraw
 * while it is in use (issued in this process, or present in a registered
 * store). Gives up after `MINT_GIVE_UP_AFTER` consecutive rejections.
 */
export function mintId(prefix: IdPrefix): string {
  const minter = installed;
  const issued = minter ? installedIssued : productionIssued;
  for (let rejected = 0; rejected < MINT_GIVE_UP_AFTER; rejected++) {
    const candidate = minter ? minter(prefix) : `${prefix}_${randomSuffix()}`;
    if (inUse(prefix, candidate, issued)) continue;
    issued.add(candidate);
    return candidate;
  }
  throw new Error(
    `mintId(${prefix}): ${MINT_GIVE_UP_AFTER} consecutive candidates were already in use — the ${minter ? "installed" : "production"} minter cannot produce a fresh id`,
  );
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
