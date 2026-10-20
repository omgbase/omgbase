import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { SCHEMA_VERSION } from "./schema.js";
import { ensureRepo } from "../attach.js";
import { observeBatch } from "../../sync/observe.js";
import { sequentialMinter, setIdMinter } from "../ids.js";
import { readDocumentAtRevision } from "../read/document.js";
import { diffBlocks } from "../../graph/history.js";
import { rebuildIndex } from "./rebuild.js";
import { runGc } from "./gc.js";
import { sizeReport } from "./size.js";
import { mergeRetentionPolicy, DEFAULT_RETENTION } from "./retention.js";
import {
  ARCHIVE_DDL, RevisionArchived, NotASegment, attachArchive, detachArchive, exportHistory, listArchives, parseSegmentFileName, readManifest, segmentFileName,
} from "./archive.js";

// Archive segments (spec/store §7 "Retention", 15.0): the two-phase export,
// the segment's contents, reads through an attached segment, the registry, the
// crash rule, and what the squash leaves for GC and rebuild. The fixtures pin
// the projections; this suite checks the file itself and the error paths.

let store: Store;
let repoId: string;
let dest: string;
const POLICY = mergeRetentionPolicy(DEFAULT_RETENTION, { keep_days: 0, per_doc_max: 0, ladder: [{ after_days: 0, keep: "one per day" }] });
const NOW = "2026-01-10T00:00:00.000Z";

beforeEach(() => {
  setIdMinter(sequentialMinter());
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", null);
  dest = mkdtempSync(join(tmpdir(), "omgbase-archive-"));
});
afterEach(() => {
  store.close();
  setIdMinter(null);
  rmSync(dest, { recursive: true, force: true });
});

function observe(path: string, source: string, ts: string): void {
  observeBatch(store, repoId, [{ path, content: source }], ts);
}
function threeRevisions(): void {
  observe("a.md", "# A\n\nOne.\n", "2026-01-01T10:00:00.000Z");
  observe("a.md", "# A\n\nTwo.\n", "2026-01-01T12:00:00.000Z");
  observe("a.md", "# A\n\nThree.\n", "2026-01-02T10:00:00.000Z");
}
function count(table: string, prefix = ""): number {
  return (store.db.prepare(`SELECT count(*) AS c FROM ${prefix}${table}`).get() as { c: number }).c;
}

describe("segment files", () => {
  it("names and parses segment files", () => {
    const name = segmentFileName("rp_0", 1, 4, "s_0");
    expect(name).toBe("rp_0-1-4-s_0.omgarchive.db");
    expect(parseSegmentFileName(name)).toEqual({ repoId: "rp_0", seqLo: 1, seqHi: 4, segmentId: "s_0" });
    expect(parseSegmentFileName("notes.db")).toBeNull();
  });

  it("writes a self-contained, read-only segment with the spec's DDL and a manifest, then squashes", () => {
    threeRevisions();
    const before = count("blobs");
    const r = exportHistory(store, repoId, { dest, now: NOW, policy: POLICY, prune: true });
    expect(r.segment).not.toBeNull();
    const seg = r.segment!;
    expect(seg.id).toBe("s_0");
    expect(seg.previous_segment).toBeNull();
    expect(existsSync(seg.path)).toBe(true);
    expect(readdirSync(dest)).toEqual(["rp_0-1-1-s_0.omgarchive.db"]);
    // Read-only on disk; the DDL subset; the manifest.
    expect(statSync(seg.path).mode & 0o222).toBe(0);
    const m = readManifest(seg.path);
    expect(m).toMatchObject({ segment_id: "s_0", repo_id: repoId, created_at: NOW, seq_lo: 1, seq_hi: 1, revision_count: 1, previous_segment: null, schema_user_version: SCHEMA_VERSION });
    expect(m.policy).toEqual(POLICY);
    const db = new Database(seg.path, { readonly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
      expect(tables).toEqual(["blobs", "block_changes", "commits", "dispositions", "manifest", "revisions", "tree_nodes"]);
      // Self-contained: every blob the archived revision's tree names is in the file (shared ones included).
      expect((db.prepare("SELECT count(*) AS c FROM revisions").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT count(*) AS c FROM blobs").get() as { c: number }).c).toBeGreaterThanOrEqual(3);
      expect((db.prepare("SELECT count(*) AS c FROM dispositions").get() as { c: number }).c).toBe(2);
    } finally {
      db.close();
    }
    // The squash: bodies gone, pointer set, GC reclaimed the exclusive blobs, the segment recorded.
    const rev = store.db.prepare("SELECT root_tree, frontmatter_blob, archive FROM revisions WHERE rev_id = 'r_0'").get() as { root_tree: Buffer | null; frontmatter_blob: Buffer | null; archive: string | null };
    expect(rev).toEqual({ root_tree: null, frontmatter_blob: null, archive: "s_0" });
    // 16.0: r_1 was a delta over r_0 and is re-written in checkpoint form
    // (`checkpointed: 1`); the sweep reclaims r_0's root and r_1's old delta root.
    expect(r.squashed).toEqual({ revisions: 1, commits: 1, dispositions: 2, block_changes: 0, checkpointed: 1 });
    expect(r.gc).toEqual({ blobs: 1, tree_nodes: 2 });
    expect(count("blobs")).toBe(before - 1);
    const r1 = store.db.prepare("SELECT t.entries FROM revisions r JOIN tree_nodes t ON t.hash = r.root_tree WHERE r.rev_id = 'r_1'").get() as { entries: string };
    expect(r1.entries.startsWith("[")).toBe(true);
    expect(listArchives(store, repoId, { dest })).toMatchObject([{ segment_id: "s_0", state: "attached", revision_count: 1 }]);
    // The repo remembers its last segment.
    const settings = JSON.parse((store.db.prepare("SELECT settings FROM repos WHERE repo_id = ?").get(repoId) as { settings: string }).settings) as { history: { last_segment: string } };
    expect(settings.history.last_segment).toBe("s_0");
  });

  it("ARCHIVE_DDL is idempotent and executes on a fresh database", () => {
    const db = new Database(":memory:");
    db.exec(ARCHIVE_DDL);
    db.exec(ARCHIVE_DDL);
    expect((db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'").get() as { c: number }).c).toBe(7);
    db.close();
  });
});

describe("reading through a segment", () => {
  it("reconstructs an archived revision through the attached segment, and refuses when detached or missing", () => {
    threeRevisions();
    const r = exportHistory(store, repoId, { dest, now: NOW, policy: POLICY, prune: true });
    const at = readDocumentAtRevision(store, "d_0", "r_0")!;
    expect(at._raw).toBe("# A\n\nOne.\n");
    expect(at.renderedHashMatch).toBe(true);
    expect(diffBlocks(store, "d_0", "r_0", "r_2").map((e) => e.kind)).toEqual(["removed", "added"]);
    // Detached: the pointer stays, the read says so without a path.
    expect(detachArchive(store, repoId, "s_0")).toBe("s_0");
    expect(detachArchive(store, repoId, "s_0")).toBeNull();
    let err: unknown;
    try { readDocumentAtRevision(store, "d_0", "r_0"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RevisionArchived);
    expect(err as RevisionArchived).toMatchObject({ rev: "r_0", archive: "s_0", path: null });
    // Attached again by path: works. Then the file disappears: the error names the recorded path.
    expect(attachArchive(store, repoId, r.segment!.path).attached.map((a) => a.segment_id)).toEqual(["s_0"]);
    expect(readDocumentAtRevision(store, "d_0", "r_0")!._raw).toBe("# A\n\nOne.\n");
    detachArchive(store, repoId, r.segment!.path);
    attachArchive(store, repoId, dest); // by directory
    unlinkSync(r.segment!.path);
    try { readDocumentAtRevision(store, "d_0", "r_0"); } catch (e) { err = e; }
    expect(err as RevisionArchived).toMatchObject({ rev: "r_0", archive: "s_0", path: r.segment!.path });
    expect(listArchives(store, repoId, { dest })[0]!.state).toBe("missing");
  });

  it("attach refuses a non-segment file and another repository's segment", () => {
    threeRevisions();
    exportHistory(store, repoId, { dest, now: NOW, policy: POLICY, prune: true });
    expect(() => attachArchive(store, repoId, join(dest, "nope.db"))).toThrow(NotASegment);
    const other = ensureRepo(store, "other", null);
    expect(() => attachArchive(store, other, readdirSync(dest).map((n) => join(dest, n))[0]!)).toThrow(/a segment of repository rp_0/);
    expect(attachArchive(store, other, dest)).toEqual({ attached: [], skipped: 1 });
  });
});

describe("the crash rule, gc and rebuild after a squash", () => {
  it("finishes an unrecorded pending segment instead of writing a new one; leaves a detached one alone", () => {
    threeRevisions();
    const first = exportHistory(store, repoId, { dest, now: NOW, policy: POLICY, prune: false });
    expect(first.segment!.id).toBe("s_0");
    expect(first.squashed).toBeNull();
    expect(listArchives(store, repoId, { dest })).toMatchObject([{ segment_id: "s_0", state: "pending" }]);
    const second = exportHistory(store, repoId, { dest, now: NOW, policy: POLICY, prune: true });
    expect(second.reused).toBe(true);
    expect(second.segment!.id).toBe("s_0");
    expect(readdirSync(dest)).toHaveLength(1);
    detachArchive(store, repoId, "s_0");
    expect(listArchives(store, repoId, { dest })).toMatchObject([{ segment_id: "s_0", state: "detached" }]);
    const third = exportHistory(store, repoId, { dest, now: NOW, policy: POLICY, prune: true });
    expect(third.segment).toBeNull();
  });

  it("gc after the squash has nothing to collect; rebuild keeps the archived commits' mint rows", () => {
    threeRevisions();
    exportHistory(store, repoId, { dest, now: NOW, policy: POLICY, prune: true });
    expect(runGc(store, { enabled: true })).toEqual({ blobsSwept: 0, treeNodesSwept: 0, sameDispositionsSwept: 0 });
    const before = store.db.prepare("SELECT block_id, commit_id, kind FROM block_changes ORDER BY 1, 2, 3").all();
    rebuildIndex(store, "block_changes");
    expect(store.db.prepare("SELECT block_id, commit_id, kind FROM block_changes ORDER BY 1, 2, 3").all()).toEqual(before);
    // The size report sees the archived history.
    const report = sizeReport(store, { now: NOW });
    expect(report.archived).toMatchObject({ revisions: 1, segments: 1 });
    expect(report.archived.bytes).toBeGreaterThan(0);
  });

  it("the size report advises an export when the policy would archive more than a tenth of history", () => {
    // Bodies big enough that two archived revisions outweigh a tenth of the history pages.
    const big = (n: number): string => `# A\n\n${`Paragraph ${n} `.repeat(600)}\n`;
    observe("a.md", big(1), "2026-01-01T10:00:00.000Z");
    observe("a.md", big(2), "2026-01-01T12:00:00.000Z");
    observe("a.md", big(3), "2026-01-02T10:00:00.000Z");
    const quiet = sizeReport(store, { now: NOW });
    expect(quiet.advice.some((a) => a.includes("history export"))).toBe(false);
    store.db.prepare("UPDATE repos SET settings = ? WHERE repo_id = ?").run(JSON.stringify({ history: { retention: { keep_days: 0, per_doc_max: 0, ladder: [{ after_days: 0, keep: "one per year" }] } } }), repoId);
    const loud = sizeReport(store, { now: NOW });
    expect(loud.advice.some((a) => /^2 revisions older than the policy would archive .*omg history export --prune/.test(a))).toBe(true);
  });
});
