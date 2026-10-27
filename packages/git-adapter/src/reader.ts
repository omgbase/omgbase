import type { Store, HistoryReader, RevisionQueryRow, DocsReadAtResult, DocHistoryResult, DocVersion, NodeChange, DiffEntry, DocDiffUnified } from "@omgbase/core";
import { CapabilityUnavailable, EngineError, RevisionNotFound, TargetMissingRevision, inCoverage, listHistoryDocs, readCapability, referencePath, sha256, unifiedDiff, unretainedHeadVersion } from "@omgbase/core";
import { SHA_RE, type GitRepo } from "./git.js";
import { parseMessage, subjectOf, type CommitTrailers, type DocTrailer } from "./trailers.js";
import { tipPosition } from "./worker.js";
import type { GitHistoryConfig } from "./config.js";

// The read half over the bare repository (spec/surface §3 "The git provider",
// 6.4; modular-core Phase 6a). A VERSION of a document is a commit whose
// trailers name it (`omgbase-doc: <doc_id> <path> <head>`), found with `git log
// --grep` on that fixed string, and rendered under the native shape so the wire
// is one shape: `_rev` the head token the trailer recorded, `_seq` the feed seq
// of the trailer, `_commit` the GIT SHA (what `docs_read { at }` takes back),
// `_ts` the `omgbase-ts` trailer, `_origin`/`_actor` the trailers, `_hash` the
// sha256 of the blob's bytes (never git's sha1), `_archived` false, `retained`
// true; the current head is listed unretained (resolution 11) while no commit
// names it — the worker has not run since. Tokens of the provider's own form —
// a 40-hex sha — are decided HERE (spec/surface §3's table for `provider:
// git`): an object git does not have → `pruned`; a commit whose `omgbase-ts`
// falls outside the coverage → `outside_coverage`; a commit not naming the
// document → `target_missing`; a head token the commits do not name → null,
// and the core's claim-based table settles it; anything else → null too (an
// unknown token is nobody's). Block lineage does not exist here: `blocks_history`
// and `docs_diff` are `unsupported`.

interface GitVersion {
  sha: string;
  trailers: CommitTrailers;
  doc: DocTrailer;
  subject: string;
}

export class GitHistoryReader implements HistoryReader {
  constructor(
    private readonly store: Store,
    private readonly repoId: string,
    private readonly git: GitRepo,
    private readonly config: GitHistoryConfig,
  ) {}

  // ---- versions ----

  private parse(records: { sha: string; message: string }[], docId: string | null): GitVersion[] {
    const out: GitVersion[] = [];
    for (const r of records) {
      const t = parseMessage(r.message);
      if (!t) continue;
      for (const d of t.docs) {
        if (docId !== null && d.docId !== docId) continue;
        if (d.head === null) continue; // a deletion mints no version
        out.push({ sha: r.sha, trailers: t, doc: d, subject: subjectOf(r.message) });
      }
    }
    return out;
  }

  /** Every version of one document, oldest first, with the blob's sha256 (versions whose path is not in the commit's tree — superseded within a pending span — are dropped). */
  private versionsOf(docId: string): (GitVersion & { hash: string })[] {
    if (!this.git.exists()) return [];
    const versions = this.parse(this.git.log(this.config.branch, { grep: `omgbase-doc: ${docId} ` }), docId);
    return this.withHashes(versions);
  }

  private withHashes(versions: GitVersion[]): (GitVersion & { hash: string })[] {
    const blobs = this.git.blobsAt(versions.map((v) => `${v.sha}:${v.doc.path}`));
    const out: (GitVersion & { hash: string })[] = [];
    versions.forEach((v, i) => {
      const b = blobs[i];
      if (b) out.push({ ...v, hash: sha256(b).toString("hex") });
    });
    return out;
  }

  private toVersion(v: GitVersion & { hash: string }, head: string | null): DocVersion {
    return {
      _rev: v.doc.head!,
      _seq: v.trailers.to,
      _commit: v.sha,
      _ts: v.trailers.ts,
      _origin: v.trailers.origin,
      _actor: v.trailers.actor,
      _hash: v.hash,
      _is_current: v.doc.head === head,
      _archived: false,
      retained: true,
    };
  }

  private toRow(v: GitVersion & { hash: string }, head: string | null): RevisionQueryRow {
    return {
      rev_id: v.doc.head!,
      doc_id: v.doc.docId,
      seq: v.trailers.to,
      rendered_hash: Buffer.from(v.hash, "hex"),
      path: v.doc.path,
      commit_id: v.sha,
      ts: v.trailers.ts,
      origin: v.trailers.origin ?? "observed",
      actor: v.trailers.actor,
      reason: v.subject,
      is_current: v.doc.head === head ? 1 : 0,
      archived: 0,
    };
  }

  private headOf(docId: string): string | null {
    return (this.store.db.prepare("SELECT head FROM docs WHERE doc_id = ?").get(docId) as { head: string | null } | undefined)?.head ?? null;
  }

  // ---- resolving a token (spec/surface §3, the git rows of the decision table) ----

  /** The bytes of `docId` at `rev`, or null when `rev` is a head token (or an unknown form) the commits do not name; throws the table's answer for a sha. */
  private bytesAt(docId: string, rev: string, fix: string | undefined): { path: string; bytes: Buffer; sha: string } | null {
    if (SHA_RE.test(rev)) {
      if (!this.git.exists() || this.git.objectType(rev) === null) throw CapabilityUnavailable.historyPruned(rev, fix);
      if (this.git.objectType(rev) !== "commit") throw new TargetMissingRevision(rev, docId);
      const t = parseMessage(this.git.message(rev));
      if (!t) throw new TargetMissingRevision(rev, docId);
      const coverage = readCapability(this.store.db, this.repoId, "history")?.coverage ?? [];
      if (coverage.length > 0 && !inCoverage(coverage, t.ts)) throw CapabilityUnavailable.historyOutsideCoverage(rev, coverage[0]!.from, fix);
      const d = t.docs.find((x) => x.docId === docId && x.head !== null);
      if (!d) throw new TargetMissingRevision(rev, docId);
      const bytes = this.git.blobsAt([`${rev}:${d.path}`])[0];
      if (!bytes) throw CapabilityUnavailable.historyPruned(rev, fix);
      return { path: d.path, bytes, sha: rev };
    }
    if (/^r_/.test(rev)) {
      const v = this.versionsOf(docId).find((x) => x.doc.head === rev);
      if (!v) return null;
      const bytes = this.git.blobsAt([`${v.sha}:${v.doc.path}`])[0];
      if (!bytes) return null;
      return { path: v.doc.path, bytes, sha: v.sha };
    }
    return null;
  }

  // ---- HistoryReader ----

  readAtRevision(docId: string, revId: string): DocsReadAtResult | null {
    const at = this.bytesAt(docId, revId, `docs_read ${JSON.stringify({ _id: docId })}`);
    if (!at) return null;
    return { _id: docId, _path: referencePath(at.path), rev: revId, _raw: at.bytes.toString("utf8"), renderedHashMatch: true };
  }

  blocksHistory(_blockId: string, _opts?: { limit?: number }): NodeChange[] {
    throw CapabilityUnavailable.historyUnsupported("git", "blocks_history", "docs_history");
  }

  diffBlocks(_docId: string, _fromRev: string, _toRev: string): DiffEntry[] {
    throw CapabilityUnavailable.historyUnsupported("git", "docs_diff", "docs_diff_unified");
  }

  diffUnified(docId: string, fromRev: string, toRev: string): string {
    const text = (rev: string): string => {
      const at = this.bytesAt(docId, rev, undefined);
      if (!at) throw new RevisionNotFound(docId, rev);
      return at.bytes.toString("utf8");
    };
    return unifiedDiff(text(fromRev), text(toRev));
  }

  docDiffUnified(docId: string, opts: { fromRev?: string; toRev?: string; label?: string } = {}): DocDiffUnified {
    const versions = this.versionsOf(docId);
    const to = opts.toRev ?? versions[versions.length - 1]?.sha;
    const from = opts.fromRev ?? versions[versions.length - 2]?.sha ?? versions[versions.length - 1]?.sha;
    if (!to || !from) throw new EngineError("target_missing", `no revisions to diff for ${opts.label ?? docId}`);
    const path = (this.store.db.prepare("SELECT path FROM docs WHERE doc_id = ?").get(docId) as { path: string } | undefined)?.path;
    return { _id: docId, _path: path === undefined ? "" : referencePath(path), from, to, diff: this.diffUnified(docId, from, to) };
  }

  docsHistory(repoId: string, opts: { pathGlob?: string; doc?: string; includeDeleted?: boolean; limit?: number } = {}): DocHistoryResult {
    const { page, truncated } = listHistoryDocs(this.store, repoId, opts);
    const docs = page.map((d) => {
      const versions = this.versionsOf(d.doc_id).map((v) => this.toVersion(v, d.head));
      if (d.head !== null && !versions.some((v) => v._rev === d.head)) versions.push(unretainedHeadVersion(this.store, d.doc_id, d.head));
      return { _id: d.doc_id, _path: referencePath(d.path), deleted: d.deleted_at !== null, currentRev: d.head, versions };
    });
    return { docs, truncated, coverage: readCapability(this.store.db, repoId, "history")?.coverage ?? [] };
  }

  dispositionCounts(_commitId: string): { kind: string; n: number }[] | null {
    return null;
  }

  revisionRows(repoId: string): RevisionQueryRow[] {
    if (!this.git.exists()) return [];
    const heads = new Map((this.store.db.prepare("SELECT doc_id, head FROM docs WHERE repo_id = ?").all(repoId) as { doc_id: string; head: string | null }[]).map((r) => [r.doc_id, r.head] as const));
    const versions = this.withHashes(this.parse(this.git.log(this.config.branch), null).filter((v) => heads.has(v.doc.docId)));
    return versions.map((v) => this.toRow(v, heads.get(v.doc.docId) ?? null)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.rev_id < b.rev_id ? -1 : a.rev_id > b.rev_id ? 1 : 0));
  }

  docRevisionRows(docId: string): RevisionQueryRow[] {
    const head = this.headOf(docId);
    return this.versionsOf(docId).map((v) => this.toRow(v, head));
  }

  hasRevision(revId: string): boolean {
    if (!this.git.exists()) return false;
    if (SHA_RE.test(revId)) return this.git.objectType(revId) === "commit" && parseMessage(this.git.message(revId)) !== null;
    if (/^r_[A-Za-z0-9_]+$/.test(revId)) return this.git.log(this.config.branch, { regex: `^omgbase-doc: .* ${revId}$` }).length > 0;
    return false;
  }

  uncapturedHeads(repoId: string, since: string): number {
    const position = this.git.exists() ? tipPosition(this.git, this.config.branch) : null;
    const db = this.store.db;
    if (!position) return (db.prepare("SELECT count(*) c FROM docs WHERE repo_id = ? AND deleted_at IS NULL AND head IS NOT NULL AND updated_at >= ?").get(repoId, since) as { c: number }).c;
    return (db
      .prepare("SELECT count(*) c FROM docs d WHERE d.repo_id = ? AND d.deleted_at IS NULL AND d.head IS NOT NULL AND d.updated_at >= ? AND EXISTS (SELECT 1 FROM feed_entries e WHERE e.repo_id = d.repo_id AND e.head = d.head AND e.seq > ?)")
      .get(repoId, since, position.seq) as { c: number }).c;
  }
}
