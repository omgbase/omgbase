// Tool-result shapes (surface 5.0, spec/surface §3–§4): a row's identity is
// `_id`/`_path`, its bytes `_raw`, its hash `_hash`; a `docs_history` version
// is a `revisions` row under the row's names (`_rev _seq _commit _ts _origin
// _actor _hash _is_current`). A 3.x/4.x server spells them bare (`id`, `path`,
// `raw`, `hash`; a version `{ rev, seq, commit, updated_at, origin, actor,
// hash, isCurrent }`). The readers here take EITHER spelling and coerce the
// wire objects into the typed shapes lib/feed.ts and the page use (a missing or
// mistyped key reads as "" / 0 / false / null), so nothing else in the demo
// reads a wire key — the typed shapes keep the demo's own field names.
//
//   changes_since revisions  { _id, _path, _hash }
//   docs_history docs[]      { _id, _path, deleted, currentRev, versions: [{ _rev, _seq, _commit, _ts, _origin, _actor, _hash, _is_current, _archived }] }
//   docs_diff_unified        { _id, _path, from, to, diff }
//   docs_read_at             { _id, _path, rev, _raw, … }

import type { ChangesSince, Digest, DocVersion, DocVersions, Revision } from "./feed.ts";

type Wire = Record<string, unknown>;
/** The first value among the keys (the 5.0 spelling first, then the 4.x one). */
const pick = (w: Wire, ...keys: string[]): unknown => { for (const k of keys) if (w[k] !== undefined) return w[k]; return undefined; };
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** A change-feed revision. */
export function revisionOf(r: Wire): Revision {
  return { id: str(pick(r, "_id", "id")), path: str(pick(r, "_path", "path")), hash: str(pick(r, "_hash", "hash")) };
}

/** A digest with its revisions. */
export function digestOf(d: Wire): Digest {
  const revisions = Array.isArray(d.revisions) ? (d.revisions as Wire[]).map(revisionOf) : [];
  return { commit: str(d.commit), seq: num(d.seq), ts: str(d.ts), origin: str(d.origin), actor: strOrNull(d.actor), summary: str(d.summary), revisions };
}

/** A `changes_since` page. */
export function changesOf(page: Wire): ChangesSince {
  const digests = Array.isArray(page.digests) ? (page.digests as Wire[]).map(digestOf) : [];
  return { digests, cursor: num(page.cursor), truncated: page.truncated === true, head: num(page.head) };
}

/** One `docs_history` version (a `revisions` row: `_rev _seq _commit _ts
 * _origin _actor _hash _is_current`; the 4.x `rev seq commit updated_at origin
 * actor hash isCurrent`). */
export function versionOf(v: Wire): DocVersion {
  return {
    rev: str(pick(v, "_rev", "rev")), seq: num(pick(v, "_seq", "seq")), commit: str(pick(v, "_commit", "commit")),
    updated_at: str(pick(v, "_ts", "updated_at")),
    origin: str(pick(v, "_origin", "origin")), actor: strOrNull(pick(v, "_actor", "actor")),
    hash: str(pick(v, "_hash", "hash")),
    isCurrent: pick(v, "_is_current", "isCurrent") === true,
  };
}

/** One `docs_history` document with its versions. */
export function docVersionsOf(d: Wire): DocVersions {
  return {
    id: str(pick(d, "_id", "id")), path: str(pick(d, "_path", "path")),
    deleted: d.deleted === true, currentRev: strOrNull(d.currentRev),
    versions: Array.isArray(d.versions) ? (d.versions as Wire[]).map(versionOf) : [],
  };
}

export interface UnifiedDiff { id: string; path: string; from: string; to: string; diff: string }

/** A `docs_diff_unified` result. */
export function unifiedOf(r: Wire): UnifiedDiff {
  return { id: str(pick(r, "_id", "id")), path: str(pick(r, "_path", "path")), from: str(r.from), to: str(r.to), diff: str(r.diff) };
}

export interface ReadAt { id: string; path: string; rev: string; raw: string }

/** A `docs_read_at` result: the document's bytes as of `rev`. */
export function readAtOf(r: Wire): ReadAt {
  return { id: str(pick(r, "_id", "id")), path: str(pick(r, "_path", "path")), rev: str(r.rev), raw: str(pick(r, "_raw", "raw")) };
}
