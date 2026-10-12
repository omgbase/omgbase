// Tool-result shapes (surface 3.0, spec/surface §3–§4): a row's identity is
// `id`/`path`, its bytes `raw`, its hash `hash`, its time `updated_at`. The
// readers here coerce the wire objects into the typed shapes lib/feed.ts and
// the page use (a missing or mistyped key reads as "" / 0 / false / null), so
// nothing else in the demo reads a wire key.
//
//   changes_since revisions  { id, path, hash }
//   docs_history docs[]      { id, path, deleted, currentRev, versions: [{ rev, seq, commit, updated_at, origin, actor, hash, isCurrent }] }
//   docs_diff_unified        { id, path, from, to, diff }
//   docs_read_at             { id, path, rev, raw, … }

import type { ChangesSince, Digest, DocVersion, DocVersions, Revision } from "./feed.ts";

type Wire = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** A change-feed revision. */
export function revisionOf(r: Wire): Revision {
  return { id: str(r.id), path: str(r.path), hash: str(r.hash) };
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

/** One `docs_history` version. */
export function versionOf(v: Wire): DocVersion {
  return {
    rev: str(v.rev), seq: num(v.seq), commit: str(v.commit),
    updated_at: str(v.updated_at),
    origin: str(v.origin), actor: strOrNull(v.actor),
    hash: str(v.hash),
    isCurrent: v.isCurrent === true,
  };
}

/** One `docs_history` document with its versions. */
export function docVersionsOf(d: Wire): DocVersions {
  return {
    id: str(d.id), path: str(d.path),
    deleted: d.deleted === true, currentRev: strOrNull(d.currentRev),
    versions: Array.isArray(d.versions) ? (d.versions as Wire[]).map(versionOf) : [],
  };
}

export interface UnifiedDiff { id: string; path: string; from: string; to: string; diff: string }

/** A `docs_diff_unified` result. */
export function unifiedOf(r: Wire): UnifiedDiff {
  return { id: str(r.id), path: str(r.path), from: str(r.from), to: str(r.to), diff: str(r.diff) };
}

export interface ReadAt { id: string; path: string; rev: string; raw: string }

/** A `docs_read_at` result: the document's bytes as of `rev`. */
export function readAtOf(r: Wire): ReadAt {
  return { id: str(r.id), path: str(r.path), rev: str(r.rev), raw: str(r.raw) };
}
