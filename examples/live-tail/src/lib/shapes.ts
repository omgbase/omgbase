// Tool-result shapes across surface versions. Surface 3.0 (spec/surface §1.2,
// §3–§4) made one rule of every result the page reads: a row's identity is
// `id`/`path`, its bytes `raw`, its hash `hash`, its time `updated_at`; before
// 3.0 each tool had its own spelling. The server a user points this page at
// may be either (Brendan's remote may lag the local build), so every reader
// here is keyed on the connected server's surface and normalises to the one
// internal shape lib/feed.ts and the page use. An unknown version (`null`, or
// a server without the `version` tool) reads as 2.x.
//
//   changes_since revisions  3.0 { id, path, hash }                         2.x { doc, path, contentHash }
//   docs_history docs[]      3.0 { id, path, deleted, currentRev, versions }   2.x { docId, path, … }
//   …versions[]              3.0 { rev, seq, commit, updated_at, origin, actor, hash, isCurrent }
//                            2.x { rev, seq, commit, ts, origin, actor, contentHash, isCurrent }
//   diff_unified             3.0 { id, path, from, to, diff }                2.x { doc, path, from, to, diff }
//   docs_read_at             3.0 { id, path, rev, raw, … }                   2.x { path, docId, rev, content, … }

import type { ChangesSince, Digest, DocVersion, DocVersions, Revision } from "./feed.ts";
import { surfaceMajor } from "./paths.ts";

/** Does the server spell rows the 3.0 way? An unknown version is taken as 2.x. */
export function surface3(surface: string | null): boolean {
  return (surfaceMajor(surface) ?? 1) >= 3;
}

type Wire = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/** A change-feed revision as the page keeps it (`{ doc, path, contentHash }`). */
export function revisionOf(surface: string | null, r: Wire): Revision {
  const v3 = surface3(surface);
  return { doc: str(v3 ? r.id : r.doc), path: str(r.path), contentHash: str(v3 ? r.hash : r.contentHash) };
}

/** A digest with its revisions read for the server's generation; the digest's
 * own keys (`commit`, `seq`, `ts`, `origin`, `actor`, `summary`) did not change. */
export function digestOf(surface: string | null, d: Wire): Digest {
  const revisions = Array.isArray(d.revisions) ? (d.revisions as Wire[]).map((r) => revisionOf(surface, r)) : [];
  return { commit: str(d.commit), seq: num(d.seq), ts: str(d.ts), origin: str(d.origin), actor: strOrNull(d.actor), summary: str(d.summary), revisions };
}

/** A `changes_since` page (`cursor`/`truncated`/`head` are unchanged). */
export function changesOf(surface: string | null, page: Wire): ChangesSince {
  const digests = Array.isArray(page.digests) ? (page.digests as Wire[]).map((d) => digestOf(surface, d)) : [];
  return { digests, cursor: num(page.cursor), truncated: page.truncated === true, head: num(page.head) };
}

/** One `docs_history` version. */
export function versionOf(surface: string | null, v: Wire): DocVersion {
  const v3 = surface3(surface);
  return {
    rev: str(v.rev), seq: num(v.seq), commit: str(v.commit),
    ts: str(v3 ? v.updated_at : v.ts),
    origin: str(v.origin), actor: strOrNull(v.actor),
    contentHash: str(v3 ? v.hash : v.contentHash),
    isCurrent: v.isCurrent === true,
  };
}

/** One `docs_history` document with its versions. */
export function docVersionsOf(surface: string | null, d: Wire): DocVersions {
  const v3 = surface3(surface);
  return {
    docId: str(v3 ? d.id : d.docId), path: str(d.path),
    deleted: d.deleted === true, currentRev: strOrNull(d.currentRev),
    versions: Array.isArray(d.versions) ? (d.versions as Wire[]).map((v) => versionOf(surface, v)) : [],
  };
}

export interface UnifiedDiff { doc: string; path: string; from: string; to: string; diff: string }

/** A `diff_unified` result. */
export function unifiedOf(surface: string | null, r: Wire): UnifiedDiff {
  return { doc: str(surface3(surface) ? r.id : r.doc), path: str(r.path), from: str(r.from), to: str(r.to), diff: str(r.diff) };
}

export interface ReadAt { doc: string; path: string; rev: string; content: string }

/** A `docs_read_at` result: the document's bytes as of `rev` (`raw` on 3.0, `content` before). */
export function readAtOf(surface: string | null, r: Wire): ReadAt {
  const v3 = surface3(surface);
  return { doc: str(v3 ? r.id : r.docId), path: str(r.path), rev: str(r.rev), content: str(v3 ? r.raw : r.content) };
}
